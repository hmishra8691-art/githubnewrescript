# Signing in to two applications with one account

Rescript Studio and Rescript Interviews are one product to whoever is signed
in. They are two deployments on two origins, and that is the whole difficulty.

## The problem, precisely

`apps/studio/lib/authServer.ts` sets the session cookie with **no `domain`**:

```ts
res.cookies.set(SESSION_COOKIE, sessionId, {
  httpOnly: true, sameSite: "lax", secure: …, path: "/", maxAge: …,
});
```

A cookie with no `domain` is **host-only**. The browser sends it to the exact
host that set it and to nothing else. While there was one application that was
not merely correct but the safest available default.

Interviews is on a different host, so it never receives the cookie. Before the
handoff existed, its sign-in card linked to the Studio's `/login` and said
*"signing in there signs you in here"* — which was false. The person signed in
on the Studio's origin, came back, and was still signed out. Nothing crashed;
no request returned an error. The product simply could not be used.

### Why a shared cookie domain is not the answer

The obvious repair is `domain: ".vercel.app"` so both hosts share the cookie.
That door is closed, and deliberately: **`vercel.app` is on the [Public Suffix
List](https://publicsuffix.org/)**. Vercel put it there so that one customer's
deployment cannot set cookies readable by another's. Every browser rejects a
cookie scoped to a public suffix. No configuration reaches it.

This is worth understanding rather than working around, because the same rule
applies to `github.io`, `pages.dev`, `herokuapp.com` and every other shared
deployment domain.

On a domain you own, a shared cookie **is** the right answer — see *The end
state* below.

## The mechanism

```
  interviews.example/                     (signed out)
        │  Sign in
        ▼
  studio.example/api/auth/handoff?origin=https://interviews.example&next=/
        │  ├─ not signed in → /login?next=<back here>  ─┐
        │  │                                            │
        │  ◀────────────────────────────────────────────┘
        │  mints a random code, stores only its SHA-256
        ▼  303
  interviews.example/api/auth/callback?code=…&next=/
        │  redeems the code server-side, in ONE statement
        ▼  303 + Set-Cookie: rescript_session=…
  interviews.example/
```

The code is in a URL, which is the worst place to put a secret: URLs land in
history, in `Referer` headers, and in every proxy log on the path. Four
properties together make this one survivable, and **all four are enforced in
SQL** (`supabase/migrations/0032_auth_handoff.sql`) rather than in either
application, because a check that lives in one of two apps is a check the other
app can forget:

| Property | How |
|---|---|
| **Single use** | Redemption is one `UPDATE … WHERE used_at IS NULL … RETURNING`. The row is locked for the statement, so of two racing redemptions exactly one matches. |
| **Sixty seconds** | The TTL is *clamped* to [10, 120] in the function, so a caller cannot widen it. |
| **One destination** | The origin is stored at mint and must match at redeem. An intercepted code cannot be replayed at another app. |
| **Never stored in the clear** | The primary key is the SHA-256. A database backup contains nothing redeemable. |

The route layer adds two more:

- **An allowlist.** `AUTH_HANDOFF_ORIGINS` names the exact origins permitted to
  receive a session. No wildcards, deliberately — `https://*.vercel.app` reads
  like a convenience for preview deployments and means *every Vercel deployment
  owned by anyone*.
- **No caller-supplied return URL.** The caller names an **origin**; the path is
  a constant the code owns. A `return` parameter would be an open redirect on
  the one endpoint in the system that mints credentials.

### It hands over the existing session, not a new one

The code carries the id of the session the person already has. `user_sessions`
stays the single record of who is signed in, so **revoking a session still ends
it everywhere on the next request**. A per-application session row would have
meant a revoke that worked in one app and not the other, which is worse than
the problem being solved.

It also means the one-active-session-per-account rule is unchanged: opening
Interviews is not a second sign-in.

## Configuration

On the **Studio** project:

```
AUTH_HANDOFF_ORIGINS=https://interviews-lemon.vercel.app
```

Comma-separated if there is ever more than one. **Unset means no application
may receive a session** — the correct default for a feature nobody configured.

On the **Interviews** project:

```
INTERVIEWS_PUBLIC_URL=https://interviews-lemon.vercel.app
NEXT_PUBLIC_STUDIO_URL=https://rescriptstudio.vercel.app
```

`INTERVIEWS_PUBLIC_URL` must be the *same string* the Studio allowlists, because
the code is bound to it at both ends. It is read from configuration rather than
from the incoming request on purpose: a preview deployment reaching the Studio
under its own hostname would mint a code it could never spend.

Both are baked in at build time. **Changing either does nothing until you
redeploy.**

### Preview deployments

They cannot sign in, and adding a wildcard to make them would hand sessions to
the internet. Test on localhost and on production.

For local work, allowlist the dev port on the Studio:

```
AUTH_HANDOFF_ORIGINS=https://interviews-lemon.vercel.app,http://localhost:3002
```

## What breaks, and what it looks like

| Symptom | Cause |
|---|---|
| Sign in button missing, "unavailable until `INTERVIEWS_PUBLIC_URL` is set" | that variable is unset on Interviews |
| `403 … not permitted to receive a session: <origin>` | the origin is not in `AUTH_HANDOFF_ORIGINS`, or differs by scheme, port or a trailing character |
| Returns to `/?signin=expired` every time | the code is being redeemed more than once — usually a client that follows the redirect twice — or the two ends disagree about the origin |
| Returns to `/?signin=unavailable` | the database was unreachable. Not a bad code; retrying is reasonable |
| Signed in, then signed out again on the next page | the session itself ended. The handoff is working; the session is not |

## Tests

```bash
# the four guarantees, against a real PostgreSQL
psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f scripts/auth-handoff-sql-test.sql

# the URL and origin rules
node --test packages/access/dist/handoff.test.js

# both applications, production-built, driving the whole handshake over HTTP
node scripts/auth-handoff-test.mjs
```

The last one is the important one. It stands up the Studio and Interviews
together against a stub PostgREST and asserts on what crosses the wire —
status codes, `Location`, `Set-Cookie`. Restoring the original `/login` link
makes it fail, which is the only real evidence that a regression test works.

## The end state

When there is a domain you own, this mechanism becomes optional. Put both apps
on subdomains of it — `studio.yourdomain.com`, `interviews.yourdomain.com` —
add `domain: ".yourdomain.com"` to `setSessionCookie`, and the cookie simply
spans them. That is fewer moving parts and less code that can be wrong.

Keep the handoff for anything that is *not* a subdomain of the same registrable
domain. It is also what a genuinely separate product would use.

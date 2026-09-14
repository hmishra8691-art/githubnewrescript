# "Cannot verify your session right now"

## What actually happened

On 14 September the Studio showed every signed-in user:

> Cannot verify your session right now. Please try again.. Check SUPABASE_URL
> and SUPABASE_SERVICE_ROLE_KEY in THIS Vercel project's environment
> variables, then redeploy.

**The environment variables were correct.** So was the deployment, the service
key, and the database.

What the Supabase logs show for that hour:

| | |
|---|---|
| `GET /rest/v1/user_sessions` | 274 × 200, 6 × 502, 4 × 504, 4 × 500 |
| `GET /rest/v1/profiles` | 292 × 200, 7 × 502, 5 × 500, 4 × 504 |
| Postgres error log | **empty** — no ERROR, no FATAL, nothing |
| Slowest statement of the day | 2.8 s; the session lookup itself averages 0.6 ms |
| Origin times on the failures | 3 s – 16 s |

Supabase's API gateway was unwell in front of a perfectly healthy database,
between 13:20 and 13:39 UTC. It cleared on its own.

So the incident was somebody else's, and lasted twenty minutes. The **defects
were ours**, and there were three.

## Defect 1 — the page blamed the environment for everything

`app/page.tsx` appended that Vercel sentence to *every* failure it could
produce — a 403 about a role, a timeout, a gateway blip, all of it.

The server had never been confused about this. `requireUser` answers **503
`session_unavailable`** for "could not ask" and keeps the session cookie,
specifically so that a database wobble does not sign out every open tab; it
answers 401 and clears the cookie only for "asked, and the session is gone".
The dashboard threw that distinction away at the last step and told the user
to go and edit production configuration.

Now the page reads what it was told:

- **transient** (502/503/504, `session_unavailable`, a timeout, a refused
  connection) → says it is temporary, retries itself, and mentions the
  environment only after several attempts have failed, as "if it keeps
  happening";
- **not JSON, or a message naming `SUPABASE_*`** → the environment hint,
  immediately and first. This is the case it was written for;
- **anything else** → what the server said, unadorned.

The message is read **before** the status, because `/api/surveys` answers 503
for both "gateway dropped it" and "SUPABASE_URL is not set" — the status alone
cannot separate them, and reading it first would retry an unset key three
times and then call a permanent misconfiguration temporary.

Plus a **Try again** button, so the answer to a blip is a click.

## Defect 2 — one dropped read was reported as a failure

`lib/supabaseFetch.ts` (copied to `apps/runtime/lib/`) replaces the three
identical `uncachedFetch` definitions. It still turns Next's Data Cache off —
that was a security fix and is unchanged — and it now asks again when a read
comes back 500/502/504 or throws: three attempts, 150 ms then 450 ms.

**Only GET and HEAD.** A PostgREST RPC is a POST and some of ours write —
`rescript_save_draft`, `rescript_acquire_lock`, the audit insert. A 504 means
"no reply", not "did not happen", so repeating a write could double it. 429 is
excluded too: a rate limit is the one failure that asking again makes worse.

This does not survive a twenty-minute outage and does not try. It removes the
*single* dropped request, which is the shape of an ordinary day — isolated
504s at 06:05, 07:45, 09:00, 09:45, 10:20, each one somebody's dashboard going
red for a reason they could do nothing about.

## Defect 3 — a failed first `/api/auth/me` hung the app forever

`useSession` correctly refused to treat 503 as a sign-out — but it kept the
previous state, and on a fresh page load there is no previous state. One
dropped request left the chrome on `loading` with nothing to click. It now
makes up to three attempts before giving up.

## One more, found while fixing it

`load()` had no run token. A mount and a Try again could overlap, each sitting
in its own retry loop, and the older one finishing late would replace the
newer one's success with a stale error. Only the newest load may write now.

## Verified

- `scripts/supabase-fetch-test.mjs` — 14 checks, no server: recovery from each
  transient status and from a thrown network error, the budget being finite,
  a 4xx never repeated, **a POST never repeated** however it failed, caching
  off on every request, the caller's headers and signal preserved, and the two
  app copies proven identical below their headers
- `scripts/dashboard-outage-test.mjs` — 7 checks in a browser: a one-off 502
  healing invisibly, a 503 called temporary, the environment hint deferred to
  last, the Try again button, a missing key still named at once, an HTML error
  page, and a 403 that says nothing about Vercel
- `scripts/p0-cookie-test.mjs` 21/21, `p0-session-test.mjs` 41/41,
  `dashboard-test.mjs`, `auth-guard-audit.mjs` 0 problems, all package tests,
  both apps typecheck and the runtime builds

### One trap worth remembering

`await res.body.cancel()` on a discarded response **deadlocks inside Next's
patched fetch**. It hung `p0-cookie-test` for ever on the one check that makes
the database fail on purpose. Releasing the body is a courtesy to the
connection pool; the retry is the job — so it is now fired and forgotten.

## Still open

- **`auth-guard-audit` now exempts `cron/media-delivery`** with its reason: the
  scheduler has no session and is authenticated by `CRON_SECRET` through
  `timingSafeEqual`, and the route refuses everything when that is unset. It
  was reported as an unguarded handler before; an audit that always fails is
  an audit people stop reading.
- The Supabase project's **leaked-password protection is still off**.
- `requireUser` makes three sequential round trips per request (session,
  profile, policies). Folding the first two into one PostgREST embed would
  halve the exposure, but `user_sessions.user_id` references `auth.users`, not
  `profiles`, so there is no FK to embed through. It would need a new
  constraint or an RPC — worth doing, not worth doing in an incident fix.

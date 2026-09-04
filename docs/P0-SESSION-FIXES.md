# P0 fixes: project visibility, cross-device sessions, saving, locks

Eight production-critical bugs, and what turned out to be behind them. Read the
first section before the others: **three of the eight had a cause unrelated to
what the symptom looked like**, and one of them was not a bug in the data at
all.

Migration: `supabase/migrations/0009_session_persistence_fixes.sql`.

---

## The short version

| # | Reported as | Actually was |
|---|---|---|
| P0-1 | Cross-device login makes saved project data disappear | An access rule change. Nothing was deleted. |
| P0-2 | Cannot save after signing in from another system | Single-session policy refused the second device; and a lost lock was misreported as a version conflict, which permanently blocked autosave. |
| P0-3 | Session expiry causes an infinite refresh/redirect loop | The edge middleware trusted the *presence* of a cookie, and nothing ever deleted a dead one. |
| P0-4 | An expired user cannot reach the login page | Same cause as P0-3. |
| P0-5 | Session invalidation affects project persistence | Same cause as P0-1. Session state and project data were never connected. |
| P0-6 | Locking does not reliably prevent simultaneous editing | The lock itself held. Colleagues could not *see* each other's projects (P0-1), which reads identically from outside. |
| P0-7 | Read-only users can send unauthorized save requests | Already refused server-side. Now also statically enforced so a future route cannot forget. |
| P0-8 | Stale locks block other authorized users | A lock was judged live by its heartbeat alone, so a signed-out holder still appeared to be editing. |

And one bug that was not on the list, found while testing the fix for P0-3,
which was **more serious than most of them**: see
[Every database read was cacheable](#every-database-read-was-cacheable).

---

## P0-1 and P0-5 — "my saved projects disappeared"

Nothing was deleted. The production check that settled it: **16 surveys, every
one with an owner, zero orphans.** Two separate changes had moved the access
rule out from under the users.

### 1. Access meant "own it, or be added to it" — and nothing else

`rescript_project_role` recognised exactly two sources of a role: the
`surveys.owner_id` column, or a row in `project_members`. In production
`project_members` was **empty**.

Before accounts existed, the Studio listed projects by workspace, so everyone in
an organisation saw the organisation's work. Overnight the rule became "explicit
share or nothing", and the guard answers **404** for a role of `null` — by
design, because on a platform where several agencies share an installation, the
mere existence of a study can be confidential. Three programmers sharing one MIU
workspace each woke up able to see only the one or two projects they personally
owned, and a 404 is a very convincing impression of deleted data.

**The fix: workspace membership grants a baseline role.** Precedence, stated
once in `resolveProjectRole` and once in `rescript_project_access`:

```
owner  >  explicit project_members row  >  workspace baseline
```

The middle term wins over the last one **in both directions**. An owner who
deliberately shares a project as `viewer` with a colleague in their own
workspace has made a decision, and a baseline that quietly promoted them back to
`editor` would make the share dialog a lie.

The baseline is configurable per workspace, in the same `access_settings.policy`
document as every other threshold:

```json
{ "workspace": { "defaultRole": "editor" } }
```

- absent → `editor`, the closest honest reconstruction of what these users had
  before this layer existed (already a reduction: `project.transfer`,
  `project.delete`, `project.manage_members` and `lock.force_release` stay with
  the owner)
- `null` or `"none"` → off, restoring strict explicit-share-only access
- `"owner"` or an unrecognised value → **off**; a bad setting closes the door
  rather than opening it
- it never crosses an organisation: both `customer_id`s must be present and
  equal

The dashboard grew a third bucket to match — **My projects / Shared with me /
My team's projects** — because "shared with me" now means somebody deliberately
added you, and merging the two would make that list useless the moment a team
has more than a handful of projects.

### 2. The signup trigger gave one person everyone else's work

`rescript_on_auth_user_created` contained, for the first account only:

```sql
update public.surveys set owner_id = new.id where owner_id is null;
```

The intent was reasonable — projects predating accounts should not be orphaned.
The effect was that the first person to register became the owner of everything
anyone had ever built. On this installation that is **twelve** surveys, including
ones titled `suraj`, `suraj_new`, `Oweas`, `Oweas_test2`, `Oweas_test3`,
`Prince` and `Neha`, now owned by `USR-10000` and invisible to the people who
built them. That is P0-1 in its most literal form.

The line is gone. Migration `0008` already does the safe half at migration
time — `owner_id = created_by where created_by is not null` — because
attributing a project to the person who made it is *evidence*, whereas
attributing it to whoever registered first is a *guess*. Owner-less surveys now
stay owner-less, which is safe: the workspace baseline keeps them visible to
their whole workspace.

> **This does not undo the claim that already happened.** Ownership there is now
> indistinguishable from a legitimate one, and quietly moving projects between
> accounts on the strength of a title is exactly the kind of guess this section
> is about. See [Recovering misattributed ownership](#recovering-misattributed-ownership).

### Result in production

| user | before | after | owns | shared | via workspace |
|---|---|---|---|---|---|
| USR-10000 | 12 | 12 | 12 | 0 | 0 |
| USR-10001 | 2 | 5 | 2 | 1 | 2 |
| USR-10002 | 1 | 4 | 1 | 0 | 3 |
| USR-10003 | 1 | 4 | 1 | 0 | 3 |

Cross-organisation isolation is unchanged: `USR-10000` (workspace *reslens*) and
the three MIU users still cannot see each other's projects except through the one
explicit share that exists.

---

## P0-2 — cross-device login, and the save that would not work afterwards

### The policy reversal (§12)

`DEFAULT_SESSION_POLICY.allowForceTakeover` was `false`, so `rescript_login`
answered `blocked` and the second device was refused outright. The original
requirement said "do not silently invalidate the first session", and the literal
reading produced this P0: a researcher moving from a desk to a laptop was told to
go and sign out on the machine they had walked away from, or wait out a
15-minute stale timer.

The production login log shows users working around it — six `logged_out`
sessions followed by three fresh logins within twenty seconds of each other.

**§12 now governs:** the newest sign-in wins. Exclusivity is still real — still
exactly one active session per account, still enforced by a unique partial index
rather than by application logic — but the session that loses is the *old* one,
not the person at the keyboard.

Nothing about it is silent:

- the displaced session is ended with `ended_reason = 'taken_over'`
- its edit locks are released, so an abandoned browser cannot hold a project
  hostage
- the event is audited as `session.taken_over`, not as an ordinary sign-in
- the old browser is told **what actually happened** on its next heartbeat —
  "You signed in on another device", not "your session expired after a period of
  inactivity", which reads as a bug and generates a support ticket

A workspace that wants confirmation sets `allowForceTakeover: false`, and even
then the login **does not dead-end**: the 409 carries `canConfirmTakeover`, and
the screen offers *"Sign in here and end the other session"*. §12 requires the
new session to work; the person, not the policy, does the invalidating.

### The save that stayed broken

Two completely different events both arrive as **HTTP 409**:

| body | meaning |
|---|---|
| `conflict: true` | this editor is behind the server — a lost update is possible |
| `code: "lock_not_held"` etc. | this session does not hold the edit lock |

`store.tsx` discriminated on the **status**, so a momentarily-lost lock — which
is exactly what a takeover produces — was reported as *"this survey was changed
somewhere else"*, which was false, **and set `blocked.current = true`, which
stops autosave permanently until the page is reloaded.** That is the reported
"I signed in on my laptop and then could not save at all".

It now discriminates on the body. A lock refusal:

- does **not** block autosave (the lock usually returns within one poll, and a
  save that then succeeds with no user action is the outcome they want)
- names the holder instead of inventing a conflict
- says the changes are still there, and offers **Download my copy**

### Also fixed: the login box rejected people's names

Two production failures for the identifier `"Athank"` — someone typing their own
first name into a box labelled "User ID or email" and being told their
credentials did not match. True, and useless. It now says so specifically. That
is not an account-enumeration oracle: no account can have that shape, so the
reply reveals nothing about who exists, and it still counts as a failed attempt.

---

## P0-3 and P0-4 — the redirect loop

Reproduced exactly from the code:

```
/  →  page loads  →  /api/auth/me 401  →  /login  →  middleware  →  /  →  …
```

`middleware.ts` sent any cookie-**holder** away from `/login` to `/`, on the
reasonable-sounding grounds that a signed-in user does not need a sign-in form.
But middleware runs at the edge with no database, so it could only see that a
cookie *existed* — not whether the session behind it was alive. Meanwhile
`useSession`'s expiry path navigated to `/login` **without clearing the dead
cookie**. Typing `/login` by hand did not escape it either, which is P0-4.

The platform admin's session (`USR-10000`) was sitting in `expired/stale` when
this was investigated. That is the account hitting it.

**Two changes, and the first is the root fix.**

1. **Whoever discovers a session is dead deletes the cookie.** `failAndSignOut`
   in `lib/guard.ts` clears it on every "this session is finished" refusal, and
   `/api/auth/heartbeat` does the same. A stale cookie now stops existing the
   first time anything is asked of it — so the cookie's presence means something
   again, for *every* entry point at once rather than for the one screen
   somebody remembered to patch.

2. **The "already signed in" bounce moved to the login page**, which is a server
   component and can actually read the database. A live session goes home; a
   dead one falls through to the form.

The rule this leaves behind: **middleware may redirect on the ABSENCE of a
cookie, never on its presence.** Absence is a fact it can verify.

The distinction that keeps the fix from becoming its own outage: *"checked, and
the session is gone"* clears the cookie; *"I could not check"* answers **503**
and leaves it alone. Otherwise one database blip signs out every open tab in the
company at the same moment.

---

## P0-6 and P0-7 — simultaneous editing, and unauthorized saves

The lock itself was sound, and `scripts/lock-concurrency-test.mjs` now proves it
under real simultaneity: eight separate connections in eight simultaneous
transactions, and exactly one winner. That is a *structural* guarantee, not a
checked one:

- `project_edit_locks` has `survey_id` as its **primary key**, so a second lock
  row for one project cannot exist whatever any caller does
- `rescript_acquire_lock` does `insert … on conflict … do update … where
  <takeable>`, and that `WHERE` is evaluated **inside the row lock Postgres
  already took** to perform the update — so a loser cannot observe a stale
  "it's free" and write anyway

The realistic long-term failure of an authorization layer is not that the gate
is wrong; it is that somebody adds a route in six months and forgets to call it,
and nothing fails, because an ungated route works perfectly — for everybody. So
`scripts/auth-guard-audit.mjs` gained a second rule:

> any non-GET handler that asks for `survey.edit` or `survey.save_version` must
> go through `requireEditRight` — capability alone answers only a third of the
> condition

66 handlers, 0 problems. The audit also now *prints* the write surface, so the
shape is visible rather than assumed:

- **11 write handlers guarded by role alone, by design.** `responses.manage` and
  `deploy.manage` deliberately do not require the edit lock. The lock exists to
  stop two people overwriting one *document* — the survey definition. Requiring
  it everywhere would mean a deployment manager could not publish while a
  programmer had the questions open, which is precisely the separation of duties
  §11 asks for.
- **2 exempt with a stated reason.** `quality_profiles` is a workspace-level
  library of reusable settings keyed by `(customer_id, name)`; it borrows
  `survey.edit` as a proxy for "may configure quality", which correctly refuses
  a viewer, but the row it writes belongs to no survey's definition.

**No manual "enter edit mode" step any more.** Projects used to open read-only
and wait for a button to be found — the reported "the project became read-only
unexpectedly" and, for anyone who started typing first, "my changes did not
persist". The collaboration poll now asks for the lock as soon as an editing tab
is open. Three things make that safe rather than a land-grab:

- it only runs for a client whose **intent** is editing — a reviewer reading the
  project polls with `editing=0` and can never take editing from anyone by
  opening it
- `requireProject` has already established the user may edit
- the acquisition is still the atomic claim, so asking automatically cannot
  produce two editors; a client that asks while somebody else holds it is
  refused and goes read-only *naming them*

---

## P0-8 — stale locks

A lock was judged live by the age of its heartbeat alone. A lock whose holder
had **signed out thirty seconds ago** therefore still blocked the whole team
until a three-minute timer ran out — and the dashboard still showed them as
"Editing".

Liveness now asks two questions:

```
is the heartbeat recent?   AND   is the session that owns this lock still active?
```

`LockStatus` gained **`orphaned`**: takeable like `stale`, but for a reason the
banner can state honestly — *"Sarah is no longer signed in"* rather than
accusing her of wandering off. The rule is applied in one place per layer:

- **`lockStatus`** (`packages/access`) — the pure decision. An *unchecked*
  holder session (`holderSessionLive: undefined`) is assumed **live**, so a
  caller that cannot answer the question degrades to the old behaviour rather
  than releasing locks it knows nothing about.
- **`loadLock`** (`lib/guard.ts`) — the single lock read for every route. There
  used to be three private copies; three copies is three chances for one of
  them to keep judging by heartbeat alone, and the one that forgot would be the
  one blocking somebody's afternoon.
- **`rescript_acquire_lock`** — a fifth takeable condition, needing no clock.
- **`rescript_expire_locks`** — runs on every collaboration poll, so a lock left
  behind by a sign-out is gone within one polling interval instead of one stale
  timeout. No scheduler to fail silently at 3am.
- **`rescript_my_projects`** — "who is editing this" agrees with the same rule,
  so a card cannot show a signed-out colleague as the editor.

> **Correction to an earlier reading of production.** Two of the five lock rows
> were initially described as *held* by dead sessions. They were already
> `released`. The three `held` locks all belonged to live, heartbeating
> sessions. The code gap is real, but the *reported* symptom of P0-8 is most
> likely another face of P0-1 — a colleague who cannot see a project cannot take
> its lock either, and "I can't edit this" is what that feels like from outside.

---

## Every database read was cacheable

**Not on the P0 list, found while testing the fix for P0-3, and more serious
than most of them.**

The cookie test asserts that four different endpoints each refuse a dead session
and clear the cookie. It passed — but the stub database had been asked only
**twice** for five requests, and the "database is unreachable" check that
followed **never reached the stub at all**. It was answered from the first
result.

Next's App Router patches the global `fetch` and, in this version, caches GET
requests in its Data Cache by default, **with no expiry**. `supabase-js` uses
that same global `fetch`. So `requireUser`'s session lookup was being served
from a cache, which means:

- an administrator's **revoke session** (§9) would not take effect, though the
  screen would say it had
- an **expired session would keep authorizing requests** indefinitely
- a role or membership change would not apply either

`export const dynamic = "force-dynamic"` on the route handlers did **not**
prevent it: that governs the route's own caching, and the fetch underneath kept
its default.

The whole point of re-reading the session row on every single request is that a
revoke takes effect immediately rather than at the next login — and a cached
read quietly gave back exactly the property that re-reading was there to
provide.

**Fixed at the client**, once, rather than at fifty call sites where one would
eventually be missed — `lib/authServer.ts` (both clients) and `lib/admin.ts` in
both apps:

```ts
const uncachedFetch: typeof fetch = (input, init) =>
  fetch(input as never, { ...(init ?? {}), cache: "no-store" });
```

The data clients matter as much as the auth one: quota counters, List Fill
allocation counts, response totals and the survey draft itself are all read with
`.select()`. **A live quota that reads a cached count over-fills.** RPCs happen
to be POSTs and were never at risk, but relying on that is relying on an
implementation detail of a library.

`scripts/p0-cookie-test.mjs` asserts this as a **count** of database reads,
because that is the only thing that reveals a cache — every other check in that
file passes just as happily against a cached read.

---

## Never discarding unsaved work (§24)

The spec is explicit: a failed save must not reset the editor, replace the work
with stale server data, redirect, reload, or show a generic unexplained error.

Every refusal from the gate now carries `keepChanges: true` and `recoverable`,
and the editor has a distinct, honest state for each:

| state | what the user sees |
|---|---|
| `lock_lost` | who is editing, that the changes are still here, **Try again**, **Download my copy**. Autosave keeps running. |
| `signed_out` | what ended the session, **"Your changes are still on this screen"**, a sign-in link that opens a **new tab** — navigating this one away is what would destroy the draft |
| `conflict` | nothing was overwritten; **Download my copy** first, and the destructive option is named *"Discard mine and reload"* with a confirmation |
| 423 | the owner froze the project — not a conflict, and their work is intact |

**The conflict path used to offer a single "Reload" button.** Reloading fetches
the newer server draft and paints it over everything in the editor; for someone
twenty minutes into a change that is precisely the data loss this whole round is
about.

`downloadDraft` is the escape hatch behind all of them: the same JSON the JSON
tab shows and the importer accepts, so it is never a dead end.

---

## Diagnostics (§27)

`GET /api/surveys/<id>/diagnostics`, surfaced under the **Activity** tab.

Every P0 here was diagnosed by hand against the production database by somebody
who could write SQL, and three of the diagnoses contradicted what the symptom
looked like. This is that investigation, run by whoever is actually having the
problem.

It leads with the only question anybody asks — **can I save right now, and if
not, which of the three conditions is false** — then shows the session, where
the access came from, the lock (including `holderSessionLive`), the server
revision beside the editor's revision, and every recent session on the account
so a `taken_over` row explains "I signed in on my laptop and my desktop stopped
saving".

Availability: any project reader in development; in production it additionally
requires a platform administrator **or** `RESCRIPT_DIAGNOSTICS=1` on the
deployment — so a customer can turn it on for an afternoon while a problem is
chased, and off again without a code change.

**No secrets**, per §27: no tokens (there are none to leak — Supabase's are
discarded at login), no service key, no password material, no IP addresses or
their hashes, no other user's email, no survey content. It is safe to
screenshot for support.

---

## Recovering misattributed ownership

For the surveys the old trigger handed to `USR-10000`. This is deliberately
manual, because only a person knows who actually built `suraj_new`:

1. Sign in as the platform administrator and open the project.
2. **Collaborators → Share** with the real author. Cross-organisation sharing is
   permitted and flagged as such (`differentOrganization`), so this works even
   though those surveys sit in the *reslens* workspace and the authors are in
   *MIU*.
3. **Make owner.** The outgoing owner is kept as an Editor — handing a project
   over is not the same as walking away from it — and the transfer is audited as
   `project.ownership_transferred`.

If the intent is instead to move a project into another workspace wholesale,
change `surveys.customer_id`; the workspace baseline then makes it visible to
that whole team without any share at all.

---

## What is tested, and where

| file | proves |
|---|---|
| `packages/access/src/access.test.ts` | 57 unit tests — role precedence, the workspace baseline and its off switch, orphaned locks, §12's takeover decision, refusals that keep work |
| `scripts/access-sql-test.sql` | 44 assertions against real Postgres — role resolution, the setting, lock liveness, the dashboard, sign-out releasing locks |
| `scripts/lock-concurrency-test.mjs` | 26 assertions under **real simultaneity** — 8 connections, 8 transactions, one winner; orphaned takeover; the schema-level guarantees |
| `scripts/p0-session-test.mjs` | 41 browser assertions — no redirect loop, `/login` reachable with a stale cookie, every save-refusal path keeping the work, read-only enforcement, auto-acquire, diagnostics |
| `scripts/p0-cookie-test.mjs` | 21 wire-level assertions — the cookie really is cleared, on every endpoint; 503 vs 401; **and that no read is served from a cache** |
| `scripts/auth-guard-audit.mjs` | 66 handlers, 0 unguarded, and the edit-lock rule for write handlers |
| `scripts/auth-collaboration-test.mjs` | 116 SQL-level assertions across the whole auth layer |

Regression: all 543 package unit tests pass, and every existing browser suite —
List Fill, quality, response data, flow/export, dashboard, studio authoring,
save integrity, test-survey sync, persistence, QA fixes, collaboration — passes
unchanged.

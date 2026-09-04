# Accounts, Sessions, Sharing & Collaborative Editing

A multi-user layer added *beside* the survey programming platform, not into
it. Nothing about how a survey is programmed changed; what changed is who may
do it, and when.

The requirement is emphatic that four questions must stay separate, and that
none of them may collapse into a boolean. They are four layers here, and each
one has a file you can point at:

| Layer | Question | Where |
| --- | --- | --- |
| **Authentication** | who is this user? | Supabase Auth + `profiles`; `apps/studio/lib/authServer.ts` |
| **Session management** | are they logged in — once? | `user_sessions`; `packages/access/src/sessions.ts` |
| **Project authorization** | what may they touch? | `project_members`; `packages/access/src/roles.ts` |
| **Editing control** | may they change it *now*? | `project_edit_locks`; `packages/access/src/locks.ts` |

---

## The two guarantees are structural, not checked

"One active session per user" and "one editor per project" are the same shape
of problem: two people acting at the same instant, each reading "nobody has
it" before either writes. A `select` followed by an `update` cannot promise
either one. So neither is enforced by a query.

```sql
-- one active session per user: an INDEX, not a check
create unique index user_sessions_one_active_key
  on user_sessions (user_id) where status = 'active';

-- one editor per project: survey_id IS the primary key.
-- There is nowhere to put a second lock.
create table project_edit_locks (survey_id uuid primary key, …);
```

A second concurrent login does not fail a validation — it fails an index,
inside its transaction, and `rescript_login` catches the unique violation and
reports *who holds the account* instead of throwing a 500. Lock acquisition is
one `insert … on conflict … do update … where` whose `where` runs inside the
row lock, so it sees the current holder as of that instant rather than as of
the caller's earlier read. (The same argument, and the same technique, as List
Fill's atomic slot claim.)

Two sessions or two editors are therefore not "prevented". They are
unrepresentable.

**Proven, not asserted.** `scripts/auth-collaboration-test.mjs` — 111 checks
against real Postgres, including **60 simultaneous logins for one account**
and **60 people clicking Edit on one project at the same moment**, each on its
own connection in its own transaction. Every run: exactly one winner, and
every loser told why.

## Policy lives in TypeScript, not in SQL

Every threshold — idle, stale, absolute lifetime, lock expiry, presence
window — is decided by `@rescript/access` and passed into SQL as a parameter.
The database performs the atomic claim and nothing else. There is no second
copy of the state machine to drift out of step with the one the UI and the
tests use, and §7's "configurable rather than hardcoded" reaches all the way
to the browser: the client polls at the interval the server tells it to.

Defaults, all overridable per workspace in `access_settings`:

| | Default | Why |
| --- | --- | --- |
| Session heartbeat | 30 s | |
| Idle after | 5 min | still blocks a second login — the user is reading |
| Stale after | 15 min | account released; a crashed browser cannot lock anyone out |
| Absolute lifetime | 12 h | a ceiling however active the session is |
| Lock heartbeat | 20 s | |
| Lock stale after | 3 min | long enough to think, short enough that a crash frees the project |
| Force takeover | **off** | §4 is explicit: do not silently invalidate the first session |

**Idle blocks a login; stale does not.** That one distinction is what makes
the feature usable rather than infuriating, and `sessionAuthorizes` and
`sessionBlocksLogin` are deliberately the *same* predicate — a unit test walks
the whole timeline minute by minute asserting they never diverge, because if
they ever did the result is either an account locked out of itself or two live
sessions.

---

## Authentication

Supabase Auth verifies the password — it owns the hashing, the reset emails
and the account record. Hand-rolling password storage was the one shortcut
here that could not be undone later.

But the browser never receives a Supabase token. `verifyPassword` requests
one, uses it to prove the password was right, and discards it. What the
browser gets is an httpOnly cookie holding an opaque id for a row in
`user_sessions`, and that row is the only authority on "logged in".

That split is what makes single-session enforceable. Supabase Auth will
happily mint a refresh token per device by design; if the browser held one,
the platform would have two disagreeing ideas of "logged in" and the
requirement could not be met.

**The User ID.** `USR-10482`, from a sequence starting at 10000, issued by a
trigger on `auth.users` in the same transaction as the profile. Sequential
rather than random because it is meant to be read aloud and typed by a
colleague sharing a project; never derived from the name or email, because it
is an identifier, not a fact about the person. One login field accepts either
it or an email — `parseIdentifier` sniffs the shape, and accepts `USR-10482`,
`usr10482`, `usr 10482` and `10482` as the same person.

**The first account** becomes the platform administrator, adopts the existing
workspace, and takes ownership of the 12 projects that predate accounts — so
nothing was orphaned by turning authentication on.

Login order is the security design, not an implementation detail: throttle →
password → account status → session. Checking the password of a locked-out
account would let timing distinguish a real account from a fake one; "no such
account" and "wrong password" answer identically for the same reason.

---

## Authorization

Seven roles (§11), and code asks `can(role, "survey.edit")` — never
`role === "editor" || role === "owner"`, because the second form has to be
found and corrected in twenty places every time a role is added, and one of
them always gets missed. Adding a role is adding a row to a table.

The separations that matter:

- a **programmer** edits the survey but has no `deploy.manage` — shipping is
  the **deployment manager**'s job, and they in turn cannot edit the
  programming. That split is the whole reason both roles exist.
- a **reviewer** reads everything and comments but cannot change anything.
- a **viewer** cannot even comment.
- the **owner** is one person, is a column on the survey rather than a
  membership row, and is *transferred*, never granted — the share dialog
  cannot mint a second owner.
- a **platform admin** can unstick a lock and manage accounts and sessions,
  but has no `survey.edit`. Rewriting someone's survey is not an operational
  duty; an admin who needs to edit adds themselves as a collaborator, and that
  share is audited like any other.

`rescript_project_role(user, survey)` is asked by both the API routes and
every RLS policy, so a policy and a route cannot disagree about who is a
member.

**Not a member answers 404, not 403.** Telling an outsider "that project
exists but you may not see it" is itself a disclosure — on an installation
shared by research agencies, the existence of a study can be confidential. A
user who *is* a member but lacks the capability gets 403 naming their role,
because that is actionable.

### Every handler is behind the gate

`scripts/auth-guard-audit.mjs` walks every exported HTTP handler and asserts
that a guard call is its **first statement** and that its refusal is returned.
**65 handlers checked, 0 unguarded**, with five deliberately public (sign in,
sign up, sign out, heartbeat, password reset — each with its reason recorded
in the script).

This is a lint, not a behavioural test, and that is exactly why it earns its
place: the realistic long-term failure of an authorization layer is not that
the gate is wrong, it is that someone adds a route in six months and forgets
to call it — and nothing fails, because an ungated route works perfectly. It
just works for everybody.

Writing it found two real problems in my own code: the collaboration poll hid
its guard inside a shared helper (correct, but you had to read a second
function to know the route was authorized), and the lock route parsed an
unauthenticated request body before authorizing — it needed the `action` to
know which capability to require, which is now solved by establishing identity
first and checking the project once the action is known.

---

## Collaborative editing

```
Sarah opens the project
        ↓
GET /collab  →  { readOnly: true, lock: { heldBy: "John Smith" } }
        ↓
read-only: the banner names John; the panes' controls are inert;
Save version is disabled; [ Request edit access ]
        ↓
John clicks Leave edit mode
        ↓
Sarah's next poll (≤ a few seconds, no refresh)
        ↓
{ readOnly: true, lock: { status: "free" } }  →  [ Enter edit mode ]
```

**Read-only is the default and comes from the server on every tick.** The
client never decides it may edit. So losing the lock — to a stale timeout, an
owner's takeover, or a role downgrade — drops that editor into read-only
within one interval instead of leaving them typing into a form whose next save
will be refused.

Three things enforce it, and the order matters:

1. **the backend** refuses the write (`requireEditRight` → 409 with the
   holder's name). This is the one that counts; §17 is explicit that a
   manipulated frontend must still be refused.
2. **the store** refuses `update()`/`replace()` and stops the autosave, so a
   client bug cannot queue a write that is going to be rejected anyway.
3. **the CSS** makes the controls inert on editing panels, so a reviewer sees
   why rather than discovering it by typing.

A lock belongs to a **session**, not to a user (§35). That is not pedantry:
the same person logging in elsewhere must not inherit an edit lock their
previous browser is holding, because that browser may still have unsaved state
and would happily write it over the new one. `decideEdit` tells "your other
session holds this" apart from "a colleague holds this", because the two need
different advice.

**Nothing creates a permanent lock.** Ending a session releases its lock;
logging out releases it; a takeover releases the displaced session's lock; a
missed heartbeat makes it takeable; deleting a response, changing a role below
edit rights, or removing access all release it. `rescript_expire_locks` runs
opportunistically on presence reads, so a stale lock is cleaned up by the next
person who looks at the project — no scheduler required.

**Force release** (§30) is for owners and platform admins, is confirmed, warns
that the other person's unsaved work stays unsaved, and is audited as a
force-release rather than as an ordinary release — so the log can never
confuse "John finished" with "Sarah took it from John". Everyone else gets
**Request edit access**, which notifies the holder rather than seizing.

**Section-level locking** (§18) is not implemented — project-level exclusivity
is, as the requirement permits — but `project_edit_locks.section` is stored
and reported from the beginning, so adding it is a change to the conflict
test rather than to the schema, the API and every caller.

---

## Presence and the poll

One endpoint, `/api/surveys/<id>/collab`, both **reports** the caller's
presence and **returns** everything that can have changed: who is here, who is
editing, whether this client's lock survived, what its role permits, and how
many notes are open. The same round trip refreshes the lock heartbeat.

Five separate polls would be five times the requests, five chances to render a
half-updated screen, and five places for the intervals to drift apart. It is
also the seam where Supabase Realtime would replace the transport later — the
shape the client consumes would not move, only how often it arrives.

**"Editing" is derived from the lock, never self-reported**, so a manipulated
browser cannot make itself appear as a second editor on everyone else's
screen.

The heartbeat is a **separate** endpoint from authorization on purpose. If
every authorization check refreshed the session, a background poll would keep
an abandoned browser "active" forever and the idle timeout — the thing that
makes a crashed machine release the account — would be defeated by the very
mechanism meant to detect it.

---

## Isolation

Every user belongs to one organization. You see only projects your
organization owns or that were **explicitly shared** with you, and that
explicit share is the authorized exception that can cross organizations —
which is §24's "unless explicitly authorized by the platform's access model",
and what makes agency/client work possible. The share dialog says when it is
about to cross that boundary, rather than letting the owner discover it later.

RLS policies exist on every table and ask the same `rescript_project_role`
function the routes ask. The Studio holds the service role and bypasses them,
so **nothing there is load-bearing for the current app and nothing there can
break it** — they are the second line, for the day any query runs as the
signed-in user (a browser client, a realtime subscription, a reporting tool).

`login_attempts` deliberately carries no policy: it is throttle bookkeeping
that reveals which accounts are being guessed at, and only the server has any
business reading it.

---

## Audit

`audit_logs` was extended with `survey_id` rather than a second table beside
it — two audit trails means every report has to read both and reconcile their
vocabularies. Events are a closed list in `packages/access/src/audit.ts`, and
`describeEvent` turns a stored row into the sentence a human reads, so the log
is worded identically in the activity panel and the notification list.

A log written as ad-hoc strings becomes unfilterable within a month —
`survey.save` in one route and `saved_survey` in another, and no report can
count either.

**The autosave records one marker per editing session, not one per
keystroke.** "John started editing at 10:32" (the lock) plus "John modified
the survey" plus "John released the lock at 10:52" is the story a researcher
needs; eleven hundred identical rows in between would bury every other event.

---

## Internal notes

Their own table, their own routes, and no code path from them into the survey
definition or the runtime — the runtime never reads that table and has no
reason to. §26's guarantee that notes never reach respondents is therefore
structural rather than a promise to be careful.

Notes anchor to whatever the programmer was looking at, so "check the routing
after Q18" opens next to Q18. Threads are one level deep, which is what a
routing discussion actually looks like. Mentions resolve to project members
only — a mention that reached someone with no access would either notify a
stranger or dangle.

---

## Verification

| | |
| --- | --- |
| `packages/access` unit tests | **40** — the capability matrix (asserting the *negatives*), both state machines, the throttle, identifier parsing, the audit vocabulary |
| `scripts/auth-collaboration-test.mjs` | **111** against real Postgres — signup, single session under 60-way contention, single editor under 60-way contention, stale recovery, invitations, isolation, admin |
| `scripts/auth-guard-audit.mjs` | **65 handlers, 0 unguarded** |
| `scripts/collaboration-test.mjs` | **57** browser checks — the login conflict screen, signup and the User ID, read-only mode, presence, lock takeover, sharing by User ID and email, roles, notes, activity |
| existing suites | engine 416, quality 36, exporters 22, designs 12; browser: studio, browser, e2e-smoke, option-logic, listfill, response-data, save-integrity, flow-export, logic-builder, masking, pagebreak, dashboard, persistence, blocks |

### Bugs this work found in the existing platform

1. **`quality_profiles` could be deleted across workspaces.** The DELETE
   matched on id alone; now that accounts exist, anyone with edit rights on any
   project could have deleted another company's saved profile by guessing an
   id. Now scoped to the caller's workspace.
2. **The survey list returned every survey in the database** to anyone who
   could reach the Studio. Correct when there were no accounts; a
   cross-project leak once there are. Now scoped to the caller's memberships.
3. **The Studio's client-side sign-out redirect discarded unsaved work** — a
   heartbeat that came back 401 navigated away from the editor. It now shows a
   banner and leaves the page intact, which is what §28 actually asks for.

### What is deliberately not done

- **The respondent runtime is untouched.** A respondent must never be asked to
  sign in to answer a survey, so `apps/runtime` gained no auth. Test links
  stay open — noted as a follow-up, not an oversight.
- **Password reset delivery** relies on Supabase Auth's email, which needs
  SMTP configured on the project. The endpoint answers identically either way
  (an operator sees the failure in the log; a visitor must not be told an
  internal configuration problem).
- **Invitation emails** are not sent for the same reason; the invite link is
  returned to the sharer instead of being silently dropped.
- **`middleware.ts` is a redirect, not a boundary.** It checks only that a
  cookie is *present*, because middleware runs at the edge with no database.
  Forging it gets a visitor a page shell and a 401 from every endpoint — which
  is exactly right, and why authorization lives in the route handlers.
- **Data operations do not require the edit lock.** The lock guards the
  definition — the thing two programmers would clobber. Response data is
  guarded by role plus its own optimistic concurrency (`expectedRevision`,
  from the response-data work), so a data manager can clean rows while someone
  programs. They never write the same bytes.

# Project Collaborators & Advanced Access Management — 2026-10-17

Implements the user's document of 16/10/2026 ("Project Collaborators & Advanced Access Management").
Engineer: ACCESS. Scope: `packages/access`, the collaborators panel and its two new entry points, the
members / share routes, the guard, migration `0062`.

## 1. What existed

| Piece | Where | State before today |
|---|---|---|
| Role model | `packages/access/src/roles.ts` | 7 roles (owner, editor, programmer, reviewer, viewer, test_user, deployment_manager); one capability table (`GRANTS`); `can(role, cap)` |
| Guard | `apps/studio/lib/guard.ts` `requireProjectFor` | `rescript_project_access` → role + source → `decideAccess(user, role, cap)`; 404 for non-members, 403 for a role without the capability |
| SQL | `0008` → `0009` → `0034` `rescript_project_access` | owner > explicit row (live / **revoked**) > workspace baseline (`editor` by default) |
| Panel | `components/studio/CollaboratorsPanel.tsx` | reachable only from the Studio's Collaborators tab; lookup-first share; role select; remove; make owner; revoke invite |
| Routes | `api/surveys/[id]/members` (GET/PATCH/DELETE), `share` (GET lookup / POST / DELETE), `transfer` | role-only grants; invitations with hashed single-use tokens (0017) |
| Audit | `packages/access/src/audit.ts` → `audit_logs` | `project.shared / permission_changed / access_removed / invitation_*` already recorded |

Nothing stored per-module permissions or an end date; the Workspace card menu and the Overview had no door to the panel.

## 2. Role mapping (the document's access levels → stored roles)

Every existing role keeps its row and its meaning; five roles are **appended** (never inserted) to `PROJECT_ROLES`.

| Document level | Stored role | Notes |
|---|---|---|
| Owner | `owner` (column `surveys.owner_id`) | not grantable; transfer stays the separate owner-only action (`project.transfer`) |
| Project Admin | **`project_admin`** (new) | editor + `project.manage_members`, `project.lock_settings`, `lock.force_release`; **not** transfer, delete, `billing.transfer`, `billing.set_budget` |
| Full Access | `editor` | edits, deploys, manages data, analytics, invites — no administration of others' access |
| Edit Access | `programmer` | edits the survey and saves versions; reads/exports data; cannot deploy or change data |
| View Only | `viewer` | unchanged: reads survey, in-Studio response data, analytics; no export |
| View Only with Data | **`viewer_data`** (new) | viewer + dataset export + respondent contact details |
| Vendor Access | **`vendor`** (new) | `project.read` + `fieldwork.read` only — no responses, people or team list |
| Interview Only | **`interviewer`** (new) | `project.read` + `fieldwork.read` + `comment.create` (the Studio has no CATI console; see §8) |
| Custom | **`custom`** (new) | capabilities come from `project_members.permissions`; a custom row without readable permissions can open the project and nothing else (fails closed) |
| No Access | remove membership | the existing revoke (0034), which outranks the workspace baseline |
| (kept) Reviewer, Test user, Deployment manager | unchanged | offered under "More roles" |

Deviation from the brief's example ("Edit Access = editor"): `editor` already holds deployment and data
management, which is Full Access; `programmer` is the edit-only role. Labels in the UI: `accessLabel(role)`
("Full Access" for `editor`); `ROLE_LABEL` is unchanged for every old role.

Two **new capabilities** split `responses.read`: `responses.read_pii` (respondent list: names, emails,
external ids) and `fieldwork.read` (fieldwork curve, live quota counts). **Every role that held
`responses.read` holds both**, so no existing member loses anything; the split only bites for the new roles
and custom access. Backward compatibility is pinned by a snapshot taken before any change
(`collaborators.test.ts`: every old role × every old capability is identical; the only additions are the two
split capabilities, to exactly the roles that held `responses.read`).

## 3. Module / permission model

One level per module (`none / view / edit / manage`, radio-like); each level is a named bundle of rows from
the **same** capability table — `customCapabilities()` in `roles.ts`, used by `can()`. There is no second copy
of the rules (not in SQL, not in the UI).

| Module (real) | Covers (Overview grid / document) | Levels → capabilities (cumulative) | Advanced (tick one by one) |
|---|---|---|---|
| Survey Programming | Programming, Quotas (definitions), Translation, Survey Settings, Theme | view: `project.read`, `lock.request` · edit: `survey.edit`, `lock.acquire` · manage: `survey.save_version`, `project.clone` — **no None** | edit survey, save versions, clone |
| Versions & Deploy | Versions & Deploy | view (seeing versions/links is reading) · manage: `deploy.manage` | publish/deploy/send |
| Fieldwork | Fieldwork, live quota counts | none · view: `fieldwork.read` | — |
| Data | Data, Response Summary, data quality | view: `responses.read` · edit: `responses.manage` · manage: `responses.export`, `responses.read_pii` | manage responses, export, contact details |
| Data Analytics & Reports | Data Analytics, Reporting/Crosstabs, Research Dashboard | view: `analytics.read` · edit: `analytics.edit` · manage: `analytics.publish`, `analytics.export` | edit, publish/share links, report downloads |
| Notes & Activity | document's "Other" | view: `project.read_activity` · edit: `comment.create`, `comment.resolve` | each |
| Usage & Wallet | Usage & Wallet | view: `billing.read` · edit: `billing.request_credits` | request credits |
| Project Administration | Project, Collaborators | view: `project.read_members` — **no Manage** | invite (`project.share`), change access (`project.manage_members`), settings & freeze (`project.lock_settings`), release locks (`lock.force_release`) |

Rules (all tested): **Manage never implies** inviting, changing access, settings, lock release, transfer or
deletion — those are explicit admin ticks; `project.transfer`, `project.delete`, `billing.transfer`,
`billing.set_budget` are **owner-only** and can never be ticked. **Reports never grant raw data, PII or the
dataset** (no non-Data module carries a `responses.*` capability; the analytics routes return computed
results only). `lock.acquire` follows `survey.edit`; a version needs the lock, so `survey.save_version`
needs `survey.edit`. Unknown modules/levels/capabilities in stored or submitted JSON are dropped, never
passed through. Programming has no None because every other module is labelled by the questionnaire.

Stored shape: `{"v":1,"modules":{"data":"view",…},"add":[cap],"remove":[cap]}`.

**Document modules that do not exist in Rescript**, left out: *Campaign Manager* (no campaign tool;
respondent sends live under Versions & Deploy → `deploy.manage`), *Offline Surveys* (no offline app).
Mapped: Response Summary → Data view; Reporting/Crosstabs and Research Dashboard → Data Analytics; Theme
Editor → Programming (survey theme; report themes are Analytics edit); Translation and Quotas → Programming;
Other → Notes & Activity.

**Advanced permissions the platform cannot enforce separately**, so not offered: edit questions vs modify
logic vs manage embedded data vs edit flow vs quota definitions vs delete questions — the survey is one
document saved through one guarded route (`survey.edit`); splitting it needs a server-side definition diff in
the save routes (owned by FLOW/LOGIC's area). Preview is available to everyone who can open the project.
Archive/status changes are survey edits (`PATCH /api/surveys/[id]`, `survey.edit` + lock).

UI helpers (`packages/access/src/permissions.ts`, derived from the table): `ACCESS_OPTIONS`, `ACCESS_PRESETS`
(Survey Programmer, Data Analyst [no PII], External Vendor, Client / Stakeholder — stored as `custom`, so a
preset changing later changes nobody), `previewAccess` (Allowed / Restricted in words, from `capabilitySet`),
`searchPermissions` ("Export" finds `responses.export` + `analytics.export`), `copyAccess` (role + permissions,
**not** expiry), `escalation` (nobody grants what they do not hold), `resolveExpiry` / `validateExpiry`
(1 / 7 / 30 days, custom date, none; future and ≤ 3 years), `describeExpiry`, `diffAccess`.

## 4. Enforcement points

| Point | Change |
|---|---|
| `can(subject, cap, now?)` | accepts a bare role (every existing caller, unchanged) **or** a membership `{role, permissions, expiresAt}`; custom → stored permissions; expired → nothing |
| `decideAccess` | same subject; new refusal reason `access_expired` |
| `lib/guard.ts` `requireProjectFor` | for a member (and an `expired` source) reads `project_members.permissions, expires_at` (soft: a pre-0062 database answers as before) and decides via `lib/projectAccess.ts decideProjectGate`; `ProjectContext.grant` / `.expiresAt` carry the membership; `requireEditRightFor` asks `can(ctx.grant, …)` |
| Results | Data: None → **403** `insufficient_role` from every `responses.*` route (data, export, xlsx, quality, respondents…); Programming: View → **403** on lock acquire and survey save; expired → **403** `access_expired` (by SQL source or by the clock in code); non-member → 404 as before |
| Routes re-gated (behaviour unchanged for old roles) | `respondents` GET → `responses.read_pii`; `respondents/links` additionally requires `responses.read_pii`; `fieldwork` GET and `quotas` GET → `fieldwork.read` |
| Role-name lists replaced by `can(ctx.grant, …)` | `collab` (me.capabilities/canEdit/canShare/…), `config` (`can.edit`, `can.lockSettings`), `comments` (`canResolve`), `billing` (`canRequest`) — identical answers for every old role |
| Grant routes | `members` PATCH (role/permissions/expiry; refuses escalation, self-change; releases a held lock when editing is lost), `share` POST (same fields; editor still invites as before, cannot mint a Project Admin; changing an existing member's access still needs `project.manage_members`), `share` PATCH `{action:"resend"}` (fresh token — the old link dies — new mail, `project.invitation_resent`) |
| SQL | `rescript_project_access` answers no role with source `expired` → `rescript_project_role` (every RLS policy), `rescript_my_projects` (the card disappears) |
| UI | Overview disables modules / Data button the caller lacks and states their expiry; CollabBar shows the access label and expiry; the panel disables roles the signed-in person may not grant |

Audit: new events `project.invitation_resent` and `project.access_expired` (the latter is **derived** from
`expires_at` in the history — nothing runs at the instant access ends); `project.permission_changed` now
carries `changes` ("Data: View → None", "Expiry: none → 2026-11-01"); `project.shared` carries `expiresAt`.
History: `GET /members?include=activity`.

## 5. Entry points (one panel)

`CollaboratorsPanel.tsx` now exports `CollaboratorsManager` (the panel), `CollaboratorsPanel` (Studio tab
wrapper, unchanged call site), `CollaboratorsDialog` and `CollaboratorsButton`. Workspace card ⋯ →
**Collaborators…** (first PROJECT item) and Overview **avatar button (4 faces + "+N") + "+ Invite"** beside
Open programming both open `CollaboratorsDialog` → the same `CollaboratorsManager`. Access editor:
`AccessEditor.tsx` (presets, copy-from, expandable module cards with segmented control + advanced ticks,
search, expiry picker, preview). Styles: `components/studio/collaborators.css` (Studio tokens only).
Existing test ids (`share-identifier`, `share-role`, `share-submit`, `member-role`, `member-remove`, …) kept.

## 6. Migration and deploy order

`supabase/migrations/0062_project_access_permissions.sql` — additive, re-runnable: `project_members.permissions jsonb`,
`expires_at timestamptz` (+ object check, partial index); role check widened; `project_invitations.permissions`,
`access_expires_at`, `resent_at`, `resend_count` (checks `NOT VALID`); `rescript_project_access` (expiry);
`rescript_accept_invitation` and `rescript_claim_invitations` copy permissions + access expiry and re-grant a
revoked **or expired** row (fixes a pre-existing bug: the token path left a revoked person revoked).

**Order: apply 0062, then deploy the code.** Old code on the new schema is unaffected. New code before 0062:
reads fail soft (role-only decisions, as today); granting custom / expiry / a new role returns the database's
error until 0062 is applied. `/api/platform` lists 0062 in its readiness checks. Undo is in the file header.

## 7. How verified

- `packages/access`: `pnpm build && node --test dist/*.test.js` — **123/123** (99 existing + 24 new in
  `collaborators.test.ts`: snapshot back-compat, every role pinned, baseline list = SQL list, custom, Data None,
  View-only programming, manage ≠ admin, reports ≠ data/PII, normalisation, round-trip fixed→custom, presets,
  expiry, copy, escalation, preview, search, history). One existing assertion updated: the writers list now
  includes `project_admin`.
- Studio: `npx tsc --noEmit -p .` clean; `node --experimental-strip-types --test "lib/**/*.test.ts"` —
  **600/600** on the final run (9 new in `lib/projectAccess.test.ts`: the guard's status codes for old roles, Data None 403,
  View-only save 403, expired 403 by SQL or clock, request parsing incl. old clients, escalation, lock release,
  member view, history). `meterRun.cache.test.ts` failed once in an earlier full run under load and passes alone (not touched).
- `apps/runtime` and `apps/interviews` tsc clean; `node scripts/dependency-boundaries.mjs` 0 violations;
  `node scripts/auth-guard-audit.mjs` 190 handlers, 0 problems.
- SQL on Postgres 16 (scratch cluster + Supabase shim): all 61 migrations + 0062 **twice**;
  `scripts/collaborators-access-sql-test.sql` 7 groups pass (fails without 0062); existing
  `access-sql-test`, `audit-fixes-sql-test`, `invitation-token-sql-test`, `auth-handoff-sql-test`,
  `project-list-counts-sql-test` pass. `rls-audit-test.sql` fails **before and after** 0062 (5 unrelated tables
  with RLS and no policy).
- Browser: `scripts/collaborators-access-test.mjs` written (not run here — no dev server). Fake API in the real
  routes' shapes using the built `@rescript/access`.

**Orchestrator must run:** `pnpm --filter @rescript/access build`, then with Studio on :3000:
`node scripts/collaborators-access-test.mjs`, `node scripts/collaboration-test.mjs` (old panel contract),
`node scripts/dashboard-overview-test.mjs` (Overview/Workspace unchanged); and against a database with all
migrations: `psql -v ON_ERROR_STOP=1 -f scripts/collaborators-access-sql-test.sql`.

## 8. Not done, and why

- **Per-part programming permissions** (questions vs logic vs embedded data vs flow vs quotas vs delete):
  not enforceable — one document, one save route; needs a definition diff in the save routes.
- **Campaign Manager, Offline Surveys**: the product has neither.
- **Interview Only** as a data-entry console: the Studio has no CATI mode; the role reads the survey and
  fieldwork. Qualitative interview projects have their own roles (`interview_project_members`, 0030).
- **PII in response rows**: gated where contact details are a field of their own (respondent list and link
  export). Embedded data inside response rows/exports (e.g. an email captured as a variable) is still covered by
  `responses.read` / `responses.export`, because which variables are personal is not modelled.
- **Expired members' own view**: an expired project simply leaves their list (as a revoked one does); opening
  its URL says "expired on …" (403). A card reading "expired" would need a new `rescript_my_projects` column.
- **RLS role lists** (0008 surveys update, comments insert) were not widened: new roles get less through a
  direct authenticated connection, never more; nothing connects that way (0026).
- **Notifications** to members whose access has expired are not filtered (`rescript_project_members` lists them so the panel can show them).
- Workspace card badge now shows the access name ("Full Access"); the stored role is in its tooltip.

# Respondent Intelligence Engine — Phase 1 status (20 November 2026)

Phase 1 is the foundation: a respondent's identity, a signed-in portal, and the researcher's controls. The
audit and the plan for all six phases are in `RESPONDENT-INTELLIGENCE-AUDIT-2026-11-20.md`. Where that
document and this one differ, this one is right: it was written after the decisions below.

## Decisions applied

| Question | Decision | How it is built |
| --- | --- | --- |
| One identity per workspace, or shared? | Shared across workspaces, but a workspace only sees a person it enrolled | One global account (`portal_accounts`, platform data). Each survey's `respondents` row links to it by `account_id`. A workspace reads and changes only its own enrolments; it never lists another workspace's. The portal lives at `/portal`, not `/portal/<workspace>`. |
| Who can sign up? | Invitation only; Respondent ID or email, with a password | No self-registration route exists. Sign-in takes `RSP-XXXXXXXX` or the email. |
| Smallest group for a comparison | 10 or more | Recorded; used from Phase 3 (benchmarks). Nothing in Phase 1 compares people. |
| Report format | On-screen, printable, with a PDF option | The assessment page has a print layout and a "Print or save as PDF" button (the browser makes the PDF). A server-made PDF file is Phase 2. |
| Patient portal | Build with the safeguards, no label yet | The safeguards are in (below). Nothing in the product says "patient", "clinical" or "HIPAA". |
| HIPAA | Aim for it; hosting agreements and the rest come later | See "HIPAA" below. |

## What was built

**Identity and rules** (`packages/access/src/respondent.ts`, `packages/engine/src/portalPolicy.ts`,
`packages/schema/src/portal.ts`): the respondent id, scrypt password hashing, one-time tokens stored only as
SHA-256, lockout after 5 wrong passwords for 15 minutes, sessions that end after 30 idle minutes or 12 hours,
when an enrolment may be started or resumed, and when an answer may still be changed.

**Database** (`supabase/migrations/0103_respondent_portal.sql`): `portal_accounts`, `portal_credentials`,
`portal_sessions`, `portal_events` (row-level security on, no policies: server only); seven new columns on
`respondents`; the function `rescript_portal_edit_response`, which writes an edit only if the answer has not
moved on and keeps the earlier value in the response's history.

**The portal** (survey app, `/portal`): sign in, accept an invitation, reset a password, the list of
assessments with their state, one assessment with its attempts and the person's own answers, changing an
answer where the researcher allows it, the account page (name, password, signed-in devices, sign out
everywhere).

**The researcher's side** (Studio, Distribution tab, "Respondent portal"): the survey's settings, and a live
list to create accounts, send invitations, pause or restore a person, lock or unlock their answers, reopen
them until a time, set an access window and a number of attempts, sign a person out, and remove the survey
from their portal. Every action is in the audit log as `portal.access_changed`.

## Safeguards in place

- Passwords and tokens are never stored or logged readable. The session cookie is httpOnly, SameSite=Lax,
  Secure in production. Changes need a custom header and the same origin.
- Invitation and reset tokens travel in the URL fragment, so they do not reach server logs or referrers.
- Sign-in answers the same way, in the same time, for "no such account" and "wrong password".
- A researcher never sees a link or password for a person who has an email address: it is emailed. This
  matters because the account is shared: otherwise one workspace could open what another workspace collected.
  A link or first password is shown, once, only for a person with no email whose account that workspace created.
- A respondent's edit is replayed through the survey's own checks; it is refused only when it introduces a
  new hard problem. A scored test is never editable. Hidden and calculated questions are never shown.
- Email addresses appear in the Studio list only for a member who may read personal data.
- Rate limits: 20 a minute on sign-in, invitation and reset; 240 a minute on the rest.

## What was tested

| What | How | Result |
| --- | --- | --- |
| Identity, lockout, sessions, enrolment access | unit tests, `packages/access` | 135 pass |
| Edit rules, answer lines | unit tests, `packages/engine` | 2,929 pass |
| Portal service: invitation, sign-in, lockout, sessions, reset, overview, edits, conflicts | 13 tests against the in-memory store; survey app suite | 141 pass |
| Migration 0103 and the edit function | `scripts/portal-sql-test.sql` on a local PostgreSQL 16 built from every migration | passes |
| Portal pages | `scripts/respondent-portal-test.mjs`, 11 checks in a real browser against the sandbox | 11 pass |
| Studio planning, credential routing, mail texts | `portalAdminCore.test.ts`; Studio suite | 1,305 pass |
| Guards, tenancy, row-level security, dependency boundaries | `pnpm audit:code` | 0 problems |

## What was NOT tested

- **Nothing ran against the hosted database.** Migration 0103 is not applied. `supabaseStore.ts` and
  `portalAdmin.ts` are type-checked only; their queries have not met a real PostgREST.
- **The Studio route and screen were not opened in a browser.** The Studio dev server does not stay up in the
  build environment. The pure logic behind them is unit-tested; the screen is not.
- **No real email was sent.** Invitation and reset mails were checked as text only.
- **The portal browser test used seeded sandbox accounts**, not accounts created from the Studio. The path
  Studio → invitation → portal has not been walked end to end.
- No load test, no penetration test, no accessibility audit with a screen reader.

After 0103 is applied, the first thing to do is that end-to-end walk on a test survey.

## Known gaps in Phase 1

1. No new permissions were added. The list uses `responses.read` (emails need `responses.read_pii`); actions
   use `deploy.manage`. A dedicated "manage respondent accounts" permission may be wanted.
2. The PDF is the browser's print-to-PDF, not a generated file.
3. Answers can be changed in the portal for single choice, multiple choice, text and number. Grids, rankings,
   uploads and recordings are shown but not editable there.
4. Quota counts are not re-counted when a respondent changes an answer that a quota depends on.
5. A workspace cannot close a shared account, only remove its own survey from it. Closing an account, and
   export or deletion of a person's data on request, belong to Phase 5 (consent and privacy requests).
6. No two-factor sign-in.
7. With tenancy routing off, everything is on one database. When a customer gets its own database, the portal
   reads each enrolment from that customer's database; that path is written but has not been exercised.

## HIPAA

The software side has the usual technical safeguards: unique user identification, automatic logoff, hashed
credentials, access control per enrolment, an audit trail of sign-ins and researcher actions, encryption in
transit. That does not make the product HIPAA compliant. Still required, and outside the code: business
associate agreements with the database, hosting and email providers (and plans that offer them); encryption
at rest confirmed with each; a risk analysis; breach procedures; staff policies; and legal review. Until
those exist, the portal should not hold protected health information.

## Next

Phase 2 is the scoring and personal report engine (the 20 templates as configuration over one engine, the
generated PDF). It starts when asked.

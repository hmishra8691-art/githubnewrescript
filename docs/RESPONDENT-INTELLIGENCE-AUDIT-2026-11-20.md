# Respondent Intelligence Engine: architecture audit and implementation plan (2026-11-20)

**Status:** audit and plan only. No product code was changed. Nothing here is built yet.

**Recommendation:** build the engine as an extension of what exists, in the six phases of the brief. Phase 1 needs
five decisions from the owner first (section 5). Most of the scoring, editing, mail, erasure and export machinery is
already in the platform and is reused; the genuinely new parts are a respondent account, a signed-in portal, and the
benchmark and longitudinal services.

## 1. What exists today (the twelve areas the brief asked to inspect)

| # | Area | What exists | Where |
|---|---|---|---|
| 1 | Link generation | One link directory: `/s/<client>/<study>` (live), `/t/…` (test), `/r/…` (panel entry). Four access modes: `open`, `password`, `unique_links`, `invitation`. Personal links are a token per respondent row. | `deployments`, `DeploymentConfig.access`, runtime `lib/deployment.ts` |
| 2 | Respondent identification | `respondents`: one row **per survey** (token, email, name, external id, list, embedded data, status, TEST/LIVE). Uploaded in two stages with duplicate detection. `responses.respondent_id` links the answer row. `respondent_code` is a per-survey display code. | migrations 0001, 0013; Studio `respondents` routes |
| 3 | Authentication | Staff only: `profiles`, `user_sessions`, password + TOTP, lockout (`login_attempts`), single sign-on hand-off. **Respondents have no account, no password, no session.** | `lib/authServer.ts`, `lib/guard.ts`, 0099 |
| 4 | Response storage | `responses` (answers, calculated, embedded, status, revision, save sequence, navigation trail, soft delete), `assessment_results` (one per session: score, max, percentage, pass, full result), `response_edits` (every change: from → to, who, when, revision). | 0001, 0006, 0076–0078 |
| 5 | Permissions | Project roles and per-module permissions with expiry; capabilities checked on the server in every route (`requireProject`). | `@rescript/access`, `lib/guard.ts` |
| 6 | Programming and logic | One engine for browser and server; the server replays a submission. | `@rescript/engine` |
| 7 | Embedded variables | `respondents.embedded` is seeded into the interview; URL parameters; calculated variables. | runtime `lib/session.ts` |
| 8 | Completion workflow | `session/start` → `session/save` (final save scores, runs quality checks, counts quotas, releases holds) with retries and sequence numbers. Resume is by a session id kept **in the browser** only. | runtime `api/session/*` |
| 9 | Analytics and reporting | Crosstabs, significance, models, story reports, decks (PPTX), DOCX, XLSX, artifacts with fingerprints; assessment item analysis; a wave tracker for **uploaded aggregate waves**. | `@rescript/analytics`, `@rescript/exporters` |
| 10 | API and backend | Next.js route handlers in three apps; a public REST API with scoped keys; background jobs by cron. | `apps/*`, `api/v1` |
| 11 | Security and isolation | Row-level security on every table (service role only); guard audits in CI; erasure by email / code / panel id / session; tenancy routing just wired (client database per workspace, not yet switched on). | `scripts/*-audit.mjs`, `lib/erasureCore.ts`, `docs/TENANCY-2026-11-13.md` |
| 12 | Frontend | Studio (researchers), runtime (respondents: the survey page only), interviews app. | `apps/studio`, `apps/runtime` |

## 2. What can be reused, and what is missing

| Brief section | Reuse | New |
|---|---|---|
| 3. Identity and login | `respondents` rows stay as the per-survey enrolment. Password hashing (`scrypt`, already used for share links), lockout pattern, hashed-token pattern (interviews app), mail with de-duplication. | A **respondent account** (the person), credentials, sessions, password reset. |
| 4. Portal dashboard | Runtime app, its themes, localisation, the survey runner, `AssessmentReport`. | The signed-in portal pages. |
| 5. Editing and locking | `response_edits` + `responses.revision` already version every change; `rescript_update_response` writes them atomically. `allowRetake` exists. | A lock policy per survey (deadline, section, question), respondent-initiated edits, attempts limit, researcher reopen. |
| 6. Benchmarking | `assessment_results` scores; `assessmentAnalytics`; calculated variables; validated scale scoring and bands. | Percentile and cohort service with a minimum cohort size; a scorecard definition; snapshots. |
| 7. Longitudinal | Version fingerprints (`key_fingerprint`), frozen versions, wave-tracker statistics (`comparePoints`, variable matching with a `comparable` flag). | A **series** linking surveys / periods, per-person history, comparability rules, schedules. |
| 8. Templates | `@rescript/templates` (survey templates, validated scales). | 20 portal presets: configuration only, one engine. |
| 9–10. AI and trends | AI client, metering, per-project AI policy, prompt fencing, evaluation harness. | Insight generation limited to permitted data; trend and change detection. |
| 13. Researcher dashboard | Distribution panel, Response Manager, access panel. | Respondents workspace view, visibility controls. |
| 14. Privacy | Erasure with audit fingerprint; retention sweeps (interviews). | Consent records and versions, access / export / correction requests, retention for accounts. |
| 15. Roles | Capability model with custom members. | New capabilities (below); a clinician is a member with individual-results access to named respondents. |
| 16. Reports | DOCX / PPTX / XLSX exporters, artifacts. | Personal report templates; PDF (the platform has no PDF writer today). |

## 3. Findings the plan has to respect

1. **A respondent is per-survey today.** The same person invited to two surveys is two unrelated rows. The account must
   sit above `respondents`, not replace it, or every existing link and list breaks.
2. **Do not reuse the Respondent Trust ID as the login identity.** It is a pseudonymous fraud signal, shared across
   clients and probabilistic. A portal identity is deterministic, consented and per workspace.
3. **Personal-link tokens are stored readable** (`respondents.token`), and the shared survey password is stored as text
   in the survey definition and compared directly. Both keep working unchanged; portal credentials will be hashed
   from the start. Hashing the old tokens is a separate hardening item.
4. **Two kinds of score exist**: knowledge tests (`assessment`: marks, topics, pass mark) and scale scores computed as
   calculated variables. Benchmarking and trends need one "scorecard" that can point at either.
5. **Only knowledge tests store a result row.** Scale scores live inside `responses.calculated`. A scorecard result
   has to be stored per attempt so percentiles do not rescan every response.
6. **The wave tracker compares uploaded aggregate datasets**, not the same person over time. Its statistics are
   reusable; its storage is not the longitudinal record.
7. **Resume is browser-local.** A respondent who changes device starts again. The portal makes resume server-side.
8. **Tenancy.** New tables are client data and must be classified and routed (`ctx.db`); a login finds the workspace by
   its slug in the platform database, then the account in the client's database.
9. **Health data.** The code can enforce consent, minimum cohort sizes, audit and "no diagnosis" wording. It cannot by
   itself make the service compliant with HIPAA or similar: that needs agreements with the hosting providers and a
   legal review. The patient portal should not be offered for regulated clinical use before that.
10. **There is no PDF writer.** Respondent reports would be DOCX first, or a print-ready page; PDF needs a renderer.

## 4. Proposed design

### One engine, four services

| Service | Package | Responsibility |
|---|---|---|
| Identity | `@rescript/access` (new `./respondent` entry) | Respondent ids, credential hashing, session tokens, lockout, access-window rules. Pure, unit-tested. |
| Portal policy | `@rescript/engine` | What a respondent may see and do: visibility, edit / lock decisions, attempts. One function per decision, used by the portal and the Studio. |
| Scorecard and benchmark | `@rescript/analytics` | Scorecard from a response; percentile, cohort statistics, minimum cohort size, snapshots. |
| Longitudinal | `@rescript/analytics` | Series, per-person history, comparability, change and trend. |

### Data model (new tables; all client data, row-level security on, service role only)

| Table | Purpose | Maps to the brief's entity |
|---|---|---|
| `portal_accounts` | The person in one workspace: respondent id (`RSP-…`), email (optional), name, status, identity model (`persistent` / `assessment`), expiry. | Respondent, RespondentIdentity, RespondentProfile |
| `portal_credentials` | Hashed password, must-change flag, reset token hash and expiry, failed-attempt counter. | RespondentCredential |
| `portal_sessions` | Hashed session token, device label, expiry, revoked at. | RespondentSession |
| `respondents.account_id` (new column) | Links the existing per-survey row to the account. | RespondentProject, RespondentAssessment |
| `portal_scorecards` | One row per completed attempt: overall and per-dimension scores, scoring fingerprint. | Scorecard, AssessmentAttempt |
| `portal_benchmarks` | Cached cohort statistics per survey, dimension and cohort. | BenchmarkSnapshot |
| `portal_series`, `portal_series_members` | Which surveys / periods form one longitudinal series. | AssessmentSchedule, LongitudinalRecord |
| `portal_consents` | Consent text version, given at, withdrawn at. | RespondentConsent |
| `portal_requests` | Access, export, correction and deletion requests and their outcome. | (privacy workflows) |

Reused as they are: `responses` (AssessmentResponse), `survey_versions` (AssessmentVersion), `assessment_results`,
`response_edits` and `audit_logs` (AuditLog), `mail_deliveries` and notifications, artifacts (RespondentReport).
Rewards and AI insights get their tables in the phases that build them.

Survey-level settings live in the definition, as every other setting does: a new optional `portal` block
(identity model, visibility, edit and lock policy, attempts, scorecard, benchmark cohorts, template id). Absent on
every existing survey, so nothing changes for them.

### Where the portal lives

In the respondent app (`apps/runtime`), under `/portal/<workspace>`: it is already the public, respondent-facing app,
with the runner, themes and languages. Its cookie is separate from the Studio's; a respondent session can never
open a Studio route, and the reverse. Researcher screens go in the Studio (a Respondents view per project and per
workspace).

### New capabilities (server-enforced)

`respondents.manage` (accounts, credentials, suspend), `respondents.individual.read` (one person's results and
history: this is what a clinician is granted, per project), `portal.configure`. Respondents get no project role at
all: their access is the account plus its linked enrolments.

## 5. Decisions needed before Phase 1

| # | Decision | Recommendation |
|---|---|---|
| 1 | Is a persistent identity per **workspace**, or shared across workspaces? | Per workspace. Cross-client identity is a privacy and consent problem, and the tenancy design keeps client data apart. |
| 2 | How do respondents sign in? | Respondent id **or** email, plus a password; first sign-in through an invitation link that forces a new password. No self-registration in Phase 1: researchers create or import accounts. |
| 3 | Minimum cohort size for any comparison shown to a respondent. | 20, configurable upward only; never below 10. |
| 4 | Report format for respondents. | DOCX and an on-screen printable report first; PDF as its own item. |
| 5 | Regulated health use. | Build the patient template with the safeguards, but label it "not for regulated clinical use" until the legal and hosting agreements exist. |

## 6. Phases, mapped to the brief

| Phase | Scope | Rough size |
|---|---|---|
| 1. Core infrastructure | Accounts, credentials, sessions, reset; portal sign-in, Overview, My Assessments (start / resume / view), history; edit and lock policy with audit; researcher Respondents view (create, import, reset, suspend, link); migrations; tests for edge cases 1–13, 18, 20–21. | Large |
| 2. Assessment intelligence | Scorecard definition and storage; personal results; percentiles, cohort filters, minimum sizes; charts; visibility controls. | Large |
| 3. Longitudinal | Series, schedules, per-person history, comparability rules, year-on-year, population trends, clinician view. | Large |
| 4. Templates | The 20 presets over the same engine; six industry portals first. | Medium |
| 5. AI and prediction | Summaries and explanations on permitted data, assistant, change detection, forecasts with uncertainty. Depends on the AI budget decision already open. | Large |
| 6. Engagement | Rewards, diary and media, notifications and messaging, community, accessibility review. | Large |

Each phase ends with its own status note saying what was tested and what was not, as the earlier phases did.

## 7. Not regressing what exists

- No existing table or column changes meaning; `respondents.account_id` is nullable and unused by current code.
- Existing links (`/s`, `/t`, `/r`, personal links, panel entry) are untouched; the portal is an additional way in.
- The `portal` block is optional in the definition; a survey without it behaves exactly as today.
- Each phase runs the existing suites (engine, analytics, Studio, runtime) and the code audit, plus new tests.

# Phase 6 (Enterprise readiness and scale): status, 2026-11-18

Patches 0186–0190, plus this note and its fixes (0191). Two migrations are **written but not applied**: 0099
(user_mfa) and 0100 (api_keys). Until they are, the features that need them are visibly off, and nothing is locked.

| Item | Patch | Outcome |
| --- | --- | --- |
| P1-13 Observability | 0186 | Every reported failure is a structured `[rescript:error]` line with an incident id. With `ERROR_WEBHOOK_URL` set, it is also an alert (Slack-compatible, one per distinct failure per minute). Emails, tokens and query values are scrubbed. The runtime session start/save and the Studio draft save and response export are wrapped, so a crash there becomes a reported 500 the user can quote. `/api/health` on all three apps. A synthetic check runs every 15 minutes (inert until the URLs are set as secrets). |
| P1-07 SSO / MFA / SCIM | 0187 | **Two-step sign-in is built.** It uses TOTP authenticator apps and is required for platform administrators; a workspace can require it of everyone. It is set up inside the sign-in (QR code, then ten recovery codes shown once). An administrator can reset it for someone who lost their phone. The secret is stored sealed. **SSO and SCIM are not built.** They need the identity-provider decision; the options and a recommendation are in docs/SSO-SCIM-PLAN-2026-11-18.md. |
| P1-11 Erasure end to end | 0188 | Data → Erase a person, by email, respondent code, panel id or session id. A dry run shows what will be erased, and the erasure must confirm those counts. It removes recordings, the rows no cascade reaches (quota holds, balance claims, list-fill slots, ledger), the responses, the invitation, the mail log and the vendor mapping. It then re-checks every table. The record keeps no personal data (a keyed fingerprint), and it lists earlier exports, whose downloaded copies the client must handle. |
| P2-13 Public API | 0189 | Personal API keys (Security → API keys) with scopes and an optional expiry, stored as a hash. `GET /api/v1/surveys` and `GET /api/v1/surveys/{id}/responses` (paged by cursor, read through each response's version). A key never exceeds its owner's project role, which is checked on every request. 120 requests a minute per key. Documented in the developer docs (HTTP API). |
| P2-14 Job worker | 0190 | HB, latent-class and SEM runs now finish with no page open: a 2-minute scheduled job continues any run whose lease has lapsed. It uses the same lease as the page, so the two never fight. Qualitative coding, story renders and analysis plans already had their own scheduled jobs. |
| P2-15 Live media | 0190 | The runtime health check reports the TURN relay (Cloudflare credentials are minted for real) and the SFU, saying what is missing and what that means. Passing behind a strict firewall still needs a manual test with a real provider. |
| P1-12 Restore drill | 0190 | Quarterly runbook (docs/RESTORE-DRILL.md) and a read-only measurement script that reports RTO, RPO, row counts, newest rows, migrations and staging health. **No drill has been run.** It needs a staging project. The script was exercised on two local Postgres databases, and it correctly failed on a migration missing from the "restore". |
| P2-12 Tenancy routing | — | **Not done.** 376 direct database call sites remain (Studio 272, runtime 35, Interviews 69). New code in this phase uses `platformDb` / `customerDb` (16 sites now routed), and the audit stops the count from growing. Moving the rest needs a per-site decision and an integration test per area. It is the XL item of this phase. |

## Gates

- **"SSO and MFA live"**: MFA yes, once migration 0099 is applied and `INTEGRATIONS_SECRET_KEY` is set. SSO no: it
  waits on the provider decision.
- **"Staging passes 10,000 concurrent respondents"**: not attempted. It needs staging, the compute upgrade and the
  edge rate-limit / WAF decision (still open from phase 1).

## Testing done

- Studio: 1,300 unit tests pass. New: MFA sign-in decisions (enrol, challenge, replay, recovery, pass, setup missing), erasure (two people in one project, a leaky delete caught), API keys (format, scopes, rate limit, cursor).
- Access package: 128 tests pass, including the RFC 6238 vectors. Storage: 111 tests pass, including a planted error alerting over real HTTP. Runtime: 128 tests pass.
- `audit:code` reports 0 problems: guards (new public, cron and API-key routes declared or gated), tenancy (2 new platform tables), RLS on every table, env vars documented, and the synthetic-check test (a planted 503 and a hung app raise one alert).
- Smoke-tested on the dev servers: Studio and runtime `/api/health` answer; `/api/v1` without a key → 401; key management and erasure without a session → 401; the cron without its secret → 401; a thrown error in the runtime's session start → a reported 500 with an incident id.

## Not tested

- **Sign-in with two-step codes against a real database.** Migration 0099 is not applied, so the login route was not run end to end. The decision logic is unit-tested with an in-memory table.
- **Erasure against a real database.** Same reason: it writes, and the live database is read-only for me.
- **The public API returning real response data.** Migration 0100 is not applied.

## Decisions needed

1. Apply migrations 0099 and 0100 (and the earlier 0097 and 0098).
2. Set `INTEGRATIONS_SECRET_KEY` (two-step sign-in secrets are sealed with it), `ERROR_WEBHOOK_URL`, and the synthetic-check secrets.
3. Choose the identity provider for SSO / SCIM.
4. Create a staging project, for the restore drill and the load test.

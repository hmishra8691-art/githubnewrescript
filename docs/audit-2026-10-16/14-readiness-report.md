# 14 · Final readiness report — remaining blockers and evidence required before production release

Commit audited: `b0dbe08` (`main`). Date: 2026-10-16.

## Verdict
**Not ready for a research-grade production release** for professional market/brand/healthcare/political studies. Ready for controlled pilots with hand-built surveys where the programmer reviews validation and the dataset scope, once the Batch-1 items below ship. The platform's core — engine, renderer pipeline, analytics computation, cleaning engine, exports — is substantially correct and tested; the blockers are integrity gaps at the edges and three capability gaps the brief makes mandatory.

## Blockers (must ship before release)
| # | Blocker | Register | Evidence of fix required |
|---|---|---|---|
| B1 | Server trusts respondent client for answers/status (P0 — **fixed 2026-10-16, ships in `log` posture; enforce after review**) and mints sessions on password/closed surveys (RUNTIME-02 still open) | RUNTIME-01, RUNTIME-02 | DB-backed `runtime-trust-test` green; one release of log-only enforcement showing zero false rejections |
| B2 | AI-generated questions lose intrinsic validation; no semantic validation; non-numbers pass numeric bounds | QT-01/AI-01, QT-02, QT-03 | age-validation boundary table 10/10 for integer-age; browser e2e refuses `25.5`; registry tests for email/phone/postal/url/percent/currency |
| B3 | Hand-edited option/row codes break logic silently; calcs null-out renamed codes | LOGIC-01, LOGIC-03 | ref-integrity and calc-eq scripts pass; codes-sync suite extended |
| B4 | MaxDiff collection and analysis defects | METHOD-01/02/03 | engine + analytics tests; browser methodology suite |
| B5 | SPSS export destroys non-ASCII; viewers can export datasets | DOC-06, DOC-07 | haven/pyreadstat round trip; access-policy test |
| B6 | Two of four research documents missing (SAP, cleaning plan); research plan incomplete | DOC-02/03/04 | documents download from the UI with the brief's sections, generated from the definition |
| B7 | Geographic validation / dependent dropdowns absent | QT-11 | country→admin1 demo filters correctly; invalid combinations impossible; no invented cities |
| B8 | Quality off by default; soft-deleted rows as peers; duplicate pairs both dropped | CLEAN-03/06/09 | quality tests; synthetic run shows one of a duplicate pair surviving |
| B9 | Base captions do not state scope; mixed bases on one screen | OR-03, ANALYTICS-02/03/13 | caption component in every surface; controlled dataset 84/84 |

## Should-fix before claiming "research-grade" (not release blockers)
Quota capping and server-side quota check (SCHEMA-01/RUNTIME-03); `def.scripts` and `custom_component` sandboxing (RUNTIME-04/QT-13); List Fill inert settings and reconcile job (METHOD-10/11/12); ACBC/menu analysis or explicit "unsupported" (METHOD-06); AI design/script ops (METHOD-08/LOGIC-13); matrix mobile affordance (OR-02); matrix editor cosmetics (OR-04/05/06); analysis-plan resolution by code (ANALYTICS-05); AI error wording and memory persistence (AI-04/05); unknown-type refusal (OR-01); token hashing (SCHEMA-04).

## Evidence still required (could not be produced in this environment)
| Item | Why not here | How to produce |
|---|---|---|
| Postgres-bound behaviour: List Fill atomic claim/release, lock concurrency, version-scoped export, auth collaboration, 22 SQL tests | no DB credentials in the sandbox | CI job against a Supabase branch seeded from `supabase/migrations` |
| RUNTIME-01/02/05 curl-level reproductions | same | `runtime-trust-test.mjs` (plan §B) |
| Quota overshoot under concurrency | same | `quota-concurrency-test.mjs` |
| Analytics draft-vs-version read (ANALYTICS-12) | same | before/after draft option-code edit on a survey with live rows |
| "Base of 20" original screen | not reproducible from stored data (no run/cache carries n=20) | capture the analysis header "n = … · X of Y in scope" and the dataset spec when it next appears; the scope mechanisms are documented in `08-analytics-audit.md` |
| AI-04 live card wording | needs an expired Studio session | `copilot-errors-test.mjs` |
| Live provider behaviour on 429/timeouts | fake provider only (keyless by policy) | provider client tests cover the paths; a staging run with a real key for one plan-first generation |
| Screen-reader pass on matrix (RUNTIME-09) | no AT in sandbox | manual NVDA/VoiceOver pass |

## What was verified in this audit (and need not be re-proved)
Typecheck; 3,929 unit tests; browser corpus 142/148 (6 known); controlled analytics dataset 83/84; CBC/MaxDiff design balance and prohibition honouring; aggregate logit utility recovery; List Fill in-engine semantics; cleaning engine on synthetic data; questionnaire .docx structure and Unicode; RLS on all 92 tables with service-role-only access; version immutability and revision CAS; double-submit protection; the unified script pipeline (13-check suite); matrix editor M1 fix (browser); mobile layouts at 360/390/768 have no page overflow.

## Constraints honoured
No source files modified; no database writes (read-only SQL on the active project for the base-of-20 investigation only); no production data touched; audit artefacts confined to `docs/audit-2026-10-16/`.

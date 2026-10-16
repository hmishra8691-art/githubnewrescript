# 13 · Regression test plan

Existing baseline to preserve: typecheck clean; package unit suites (engine 1,855; analytics 465; interviews 177; media 162; storage 104; exporters 102; access 99; templates 98; quality 51; import 49; designs 45; billing 44; mail 33; schema 11; ai 111) and Studio `lib` 517 — all green at `b0dbe08`; browser corpus 148 suites, 142 pass, 6 known pre-existing failures (analysis-framework, billing, dashboard-outage, picker-taxonomy, qa-fixes, quality) — run serially with dev-server restarts every 8 suites because the sandbox OOM-kills a long-lived `next dev`. Four suites and 22 SQL tests need Postgres.

## A. Unit tests to add (engine / packages)
| Test | Proves | Register |
|---|---|---|
| `surveyActions.test`: `create_question type:"integer"` + min/max keeps `integer`; `type:"email"` + `max_length` keeps `email`; `set_validation` merges; `message` kept; bounds mirrored to `settings` | QT-01, AI-01, AI-02, QT-09 | batch 1.1 |
| `validate.test`: numeric boundary table (1, 100, 0, −1, 25.5, 101, "", "abc", " 42 ", "1e2") for `numeric`, `integer`, `numeric+integer rule`; `slider`/`nps` reject non-numbers | QT-02, QT-03 | 1.2 |
| `semanticValidation.test`: each registry tag → rules; email cases (`a@b.co`, `first.last+tag@sub.example.museum`, `x@y`, `no-at`, `a..b@c.com`, `ü@example.com`); phone/postal (US 90210, GB SW1A 1AA, CA K1A 0B1, DE 10115, IN 110001, unlisted country → explicit "format unknown" warning); URL rejects `mailto:` | QT-02/05/06/07 | 2.1 |
| `references.test`: raw option-code and row-code recode retargets display logic, quota cells, masks, punches; unresolved reported | LOGIC-01 | 1.3 |
| `calc.test`: code ≠ variableName resolves; unknown name is a lint error | LOGIC-03 | 1.4 |
| `validate.test` maxdiff: all tasks required, best≠worst, codes ⊂ set | METHOD-01 | 1.5 |
| `stats/choice.test`: 4-version MaxDiff recovers planted order; best==worst task skipped with warning count | METHOD-02/03 | 1.5 |
| `listFill.test`: empty source runs and applies `whenUnused` | METHOD-09 | 2.5 |
| `quality/server.test`: peers exclude `deleted_at`; duplicate pair keeps the earlier row | CLEAN-06/09 | 1.9, 2.6 |
| `analytics basics/business.test`: table `base.n` equals answered n; segment n = answered; crosstab layered `validN` | ANALYTICS-02/03/13 | 1.9, 2.3 |
| `planBridge.test`: plan item by code resolves or errors with code | ANALYTICS-05 | 2.4 |
| `spss.test`: UTF-8 round trip for Devanagari/CJK/Arabic/Cyrillic labels and cells | DOC-06 | 2.2 |
| `schema.test`: unknown question type refused (or lint error) | OR-01 | 2.9 |
| `access-policy.test`: viewer lacks `responses.export`; export route refuses | DOC-07 | 1.6 |
| `uxDom.test`: `hidden`/`disabled` on `[data-testid=rs-next]` refused | RUNTIME-08 | quick win |
| `registryCompleteness.test`: every design kind present in validate/flatten/variables/lint/analysis/AI tables | METHOD-13 | 3.3 |

## B. Browser suites (Playwright, `scripts/*-test.mjs`)
| Suite (new or extended) | Scenario | Register |
|---|---|---|
| `age-validation-e2e-test.mjs` (from `docs/audit-2026-10-16/repro/browser/age-e2e.mjs`) | Intelligent Mode (fake provider) creates `integer` and `numeric` age → Apply → preview → `25.5`, `abc`, `1e2` refused with messages; `42` advances | QT-01/02/03 |
| `matrix-logic-editor-test.mjs` (from `matrix-selector.mjs`) | rating matrix: "is" shows column, "≥" shows value without `1: 1` duplication; composite operators filtered by column type; source picker groups SYSTEM_* | OR-04/05/06, LOGIC-16 |
| `methodologies-test.mjs` (from `maxdiff-listfill.mjs`) | MaxDiff best==worst and partial refused; List Fill empty source hides destination | METHOD-01/09 |
| `runtime-trust-test.mjs` (**needs DB**) | crafted `session/save` payloads refused; `session/start` on password/closed survey refused; same token on second context resumes | RUNTIME-01/02/05 |
| `mobile-matrix-test.mjs` (from `runtime-misc.mjs`) | at 360/390 px every scale point reachable or a scroll hint visible; no page overflow | OR-02, RUNTIME-10 |
| `codes-sync-test.mjs` (extend) | hand-edit option code → dependent display logic still true | LOGIC-01 |
| `copilot-errors-test.mjs` | expired session → plain-language card with retry (no "tell your administrator") | AI-04 |
| `research-documents-test.mjs` | four documents download from the UI; stamps include revision/time | DOC-02/03/04/11/13 |
| `quota-concurrency-test.mjs` (**needs DB**) | two contexts complete into the last slot; count never exceeds limit | SCHEMA-01/RUNTIME-03 |
| existing `ux-script-dom`, `wave1`, `codes-sync`, `option-logic`, `intelligent-mode`, `analytics-*` | must stay green after every batch | all |

## C. Integration (Postgres) — currently declared and not run
`auth-collaboration-test`, `listfill-allocation-test`, `lock-concurrency-test`, `version-scoped-export-test` + 22 SQL tests. Recommendation: run them in CI against a Supabase branch (`create_branch`) seeded from `supabase/migrations`; add the two new DB suites above.

## D. Negative, boundary, empty-state, malformed, recovery scenarios (brief §12)
- Empty option list, empty List Fill, zero-response analytics (n=0 caption), survey with only hidden questions.
- Malformed JSON import (unknown type, missing variable names, duplicate codes) → refused with lint, never a blank runtime.
- Provider 401/403/429/timeout/malformed JSON during plan-first generation → checkpoint kept, card explains, retry works (fake provider can simulate each).
- Resume after reload, Back + reload, cleared storage (open vs unique-link).
- Concurrency: two editors (edit lock), two respondents on last quota slot, double submit.

## E. Reproduction scripts from this audit (to keep)
`docs/audit-2026-10-16/repro/qt/age-validation.mjs`, `docs/audit-2026-10-16/repro/browser/age-e2e.mjs`, `matrix-selector.mjs`, `maxdiff-listfill.mjs`, `runtime-misc.mjs`, `matrix-scroll.mjs`, `docs/audit-2026-10-16/repro/logic/{ref-integrity,calc-eq,flow-nav}.mjs`, `docs/audit-2026-10-16/repro/method/0[1-8]-*.mjs`, `docs/audit-2026-10-16/repro/analytics/controlled.mjs`, `docs/audit-2026-10-16/repro/clean/run-rules.mjs`, `docs/audit-2026-10-16/repro/doc/sav-unicode.mjs`, `docs/audit-2026-10-16/repro/ai/{brand-tracker,validation-loss}.mjs`. They are kept in the repo under `docs/audit-2026-10-16/repro/`; the ones named in A/B above should be moved into `scripts/` or package tests in batch 1.

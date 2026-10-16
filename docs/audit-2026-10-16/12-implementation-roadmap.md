# 12 · Implementation roadmap — ordered fixes, dependencies, effort, acceptance

Principle (brief §17): small, logically grouped changes, each with regression tests and explicit acceptance; nothing destructive; existing data and working functionality preserved. Effort: XS ≤ 2 h · S ≤ 1 day · M 2–5 days · L > 1 week. Risk = chance of regressing something that works today.

## Batch 1 — integrity and the P1 set (≈ 1 week, code-only, no migration)
| Order | Items | Why first | Depends on | Effort / risk | Acceptance (from register) |
|---|---|---|---|---|---|
| 1.1 | **QT-01 / AI-01 / AI-02 / QT-09** — merge instead of replace in `shapeQuestion` + `set_validation`; keep `message`; mirror bounds to `settings` | one engine change closes the age defect's first cause and three related findings | — | S / low | age-validation.mjs cases C/D: 0 mismatches except `1e2`; browser e2e stays on page for `25.5` |
| 1.2 | **QT-03** — numeric "is a number" check (rejects `abc`, `1e2`, accepts ` 42 `) | completes the boundary table | — | XS / low | all 10 boundary inputs match for case D |
| 1.3 | **LOGIC-01** — Studio option/row code edits go through `update_option` recode; toast `unresolved`; error-level lint | silent logic breakage on hand edits | — | S–M / low | ref-integrity.mjs §1/§3 show `visible=true`; codes-sync suite extended |
| 1.4 | **LOGIC-03** — calc resolver falls back to code lookup; unknown names lint | silent nulls | — | S / low | calc-eq.mjs `Q7 > 3` → true |
| 1.5 | **METHOD-01 → 03 → 02** — MaxDiff required validation; skip best==worst in analysis with warning; per-respondent version | collection + analysis correctness | 01 before 03 | S each / low | browser repro refuses; poisoned dataset computes; 4-version recovery test |
| 1.6 | **DOC-07** — export gated on `responses.export` | access control | — | XS / none | viewer 403 on download |
| 1.7 | **RUNTIME-02** — password/closed enforced in `session/start` | access | — | S / low | start refused (curl acceptance, needs DB) |
| 1.8 | **RUNTIME-01 (P0)** — server-side validation + status/flow reachability in `session/save`, **behind a flag, log-only first** | integrity; the only item with real regression risk | 1.1–1.2 (so server and client agree) | M / medium | crafted payloads refused when enforced; corpus green in log-only and enforced modes; zero false rejections in a week of logs |
| 1.9 | **CLEAN-06**, **ANALYTICS-02**, **LOGIC-10**, **LOGIC-11**, **ARCH-09/10/11/12** | ≤ 2 h each, zero risk | — | XS | per register |

## Batch 2 — validation semantics, documents, bases (≈ 2–3 weeks, code-only)
| Order | Items | Depends on | Effort | Acceptance |
|---|---|---|---|---|
| 2.1 | **QT-02** semantic validation registry (`semantic` tag → rules + input mode; prompt tells the model to set it; Properties "Treat as") | 1.1 | M | fake-provider "age 18–100" → integer rule; email/phone/postal/url/percent/currency tags produce the registry rules; QT-05/06/07 fixed in the same module |
| 2.2 | **DOC-06** SPSS UTF-8 writer | — | M | multilingual round-trip via haven/pyreadstat |
| 2.3 | **OR-03 / ANALYTICS-03 / ANALYTICS-13** one base-caption component + scope recorded in runs | — | S | every base caption names status/env/quality/version |
| 2.4 | **ANALYTICS-05/06/07** plan validation resolves codes; blocked items filtered; per-item weighting | — | S | plan item error visible |
| 2.5 | **METHOD-09** List Fill empty-source run; **METHOD-04** anchor export; **METHOD-05** persist diagnostics | — | S each | browser repro hides destination |
| 2.6 | **CLEAN-03** quality on by default (new surveys); **CLEAN-09** duplicate arrival order; **CLEAN-07** paged recompute; **DOC-08** status columns in stat formats | — | XS–S | per register |
| 2.7 | **DOC-04** Data-Cleaning Plan generator; **DOC-03** SAP: plan schema JSON fields (alpha, correction, weighting, missing-data, roles) + generator; **DOC-02** proposal sections; **DOC-11** buttons | 2.6 for cleaning plan | S + M + M | the four documents download from the Research/Analysis UI with the brief's sections |
| 2.8 | **AI-03/04/05/06** hypothesis relabel, error message map, memory persistence, CSS gate | — | S / S / M / S | per register |
| 2.9 | **OR-01** unknown-type refinement/lint; **OR-02** matrix mobile stacking or scroll hint; **OR-04/05/06** matrix editor cosmetics; **LOGIC-04** Back stack; **LOGIC-02** code-rename action | — | S each | browser checks |

## Batch 3 — capability gaps and hardening (≈ 4–6 weeks, up to 3 additive migrations)
| Order | Items | Depends on | Effort | Migration |
|---|---|---|---|---|
| 3.1 | **QT-11** dependent dropdown variant + geo region reference table + loader (country→admin1; city via reference service, never invented) | 2.1 (semantic tag) | L | `geo_regions` (additive) |
| 3.2 | **METHOD-08 / LOGIC-13** `create_design`, `create_listfill`, `create_script` ops through existing gates; **QT-10** friendly names | — | M | none |
| 3.3 | **METHOD capability registry** + registry-completeness test; wire ACBC through all touch points (METHOD-13); refuse ACBC/menu analysis until an estimator exists (METHOD-06) | — | M | none |
| 3.4 | **RUNTIME-04 / QT-13 / LOGIC-14** sandbox `def.scripts` and `custom_component` through the proven UX sandbox | script pipeline (done) | M | none |
| 3.5 | **SCHEMA-01 / RUNTIME-03 / SCHEMA-07** quota capping in RPC + server-side completion check + decrement on delete | 1.8 | M | RPC replacement (re-apply grants) |
| 3.6 | **METHOD-10 / RUNTIME-07 / SCHEMA-09** sweeps: abandoned sessions, List Fill reconcile, cache/retention | — | S–M | none (cron routes) |
| 3.7 | **SCHEMA-04** token hashing; **SCHEMA-05** profile column revoke; **ANALYTICS-12** version-definition reads; **RUNTIME-05/06/11** | — | M | `respondents.token_hash` (additive) |
| 3.8 | **CLEAN-01** rule families (item non-response, demographic consistency, geo validity, media integrity) | 2.1, 3.1 | M | none |
| 3.9 | **ARCH-01/02/05** renderer component tests, route-handler tests, auth audit across apps; **ARCH-03** import-boundary lint; **ARCH-04/07/08** consolidation | — | L (background) | none |
| 3.10 | **METHOD-07** HB / individual utilities, interactive simulator; ratings-based conjoint | — | L | none |

## Quick wins (≤ 2 h each, zero risk, can ship today)
CLEAN-06, DOC-07, ANALYTICS-02, QT-03, LOGIC-10, LOGIC-11, AI-02, AI-08, QT-07, SCHEMA-02, SCHEMA-05, OR-04, OR-06, RUNTIME-08 (refuse `hidden/disabled` on the nav button in `attrAllowed`), ARCH-09/10/11/12, DOC-10, DOC-13.

## Shared-root-cause fixes that close several items at once
1. `shapeQuestion` merge → QT-01, AI-01, AI-02, QT-09.
2. Hand editors through the action layer → LOGIC-01, LOGIC-02, and future parity.
3. Server-side validation layer → RUNTIME-01, QT-04, RUNTIME-02 (same route family), groundwork for 3.5.
4. Base-caption component → OR-03, ANALYTICS-02/03/13.
5. `semantic` tag → QT-02, QT-05/06/07 (one validator module), QT-11 wiring, CLEAN-01, DOC-03 variable coding.
6. Methodology capability registry → METHOD-02/06/13, QT-14 (clear "unsupported" instead of silent misrouting).

## Not to do (brief constraints)
No broad refactor first; no new tables for configuration the JSON can hold; no rewriting stored versions or responses; no second validation engine (the semantic registry feeds the existing `validateQuestion`); no removal of working UI (custom-design form gets its missing editor, not deleted).

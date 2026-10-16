# 03 · Feature inventory — supported, partial, missing, broken, unverified

Classification rule: IMPLEMENTED only when an executed test or reproduction proves it; a UI control or doc claim is not evidence. Per-type detail (42 base types × builder/runtime/validation/export/analytics/AI) is in `raw/question-types-validation.md` §1.2; logic features with the proving test file in `raw/logic-engine.md` §Feature classification; methodology stages in `05-methodology-matrix.md`.

## Survey programming
| Feature | Status | Notes / finding |
|---|---|---|
| Single/multi select, dropdown, multi-dropdown (22 variants) | IMPLEMENTED | all layers; `multi_dropdown` lacks an AI friendly name (QT-10) |
| Numeric (open/integer/currency/percentage/quantity) | PARTIAL | bounds ok; integer rule lost via AI (QT-01); no "is a number" check (QT-03); no semantic inference (QT-02) |
| Open text: email/phone/url/zip/regex | PARTIAL | validators exist; two email regexes disagree (QT-05); unlisted countries degrade silently (QT-06); `mailto:` accepted (QT-07) |
| Long text, text lists (name/address/contact/date range), numeric lists | IMPLEMENTED | AI friendly names missing for lists (QT-10) |
| Date, time | PARTIAL | min/max ok; no scalar "is a date/time" format check; no datetime or duration scalar (QT-12) |
| Ranking (click/drag/tournament/buckets), slider, NPS, allocation/constant sum | IMPLEMENTED | no duplicate-rank check (minor) |
| Matrix single/multi/numeric/text, likert, rating, swipe, buckets (17 variants); composite grids (dropdown/mixed/constant-sum/editable table) | IMPLEMENTED | mobile: ≥4-column scale clipped at ≤390 px with no scroll hint (OR-02); a11y gaps (RUNTIME-09) |
| Cascading / dependent dropdowns, country→state→city dataset | MISSING | QT-11 |
| Image select/ranking, hotspot, annotation, media timeline | IMPLEMENTED (runtime/export) | no analytics for hotspot/annotation/timeline (QT-14) |
| Upload (file/photo/signature/audio), video interview | IMPLEMENTED | — |
| Geo (pin/address/radius) | IMPLEMENTED | no map analysis (QT-14) |
| Repeating group, experiment (A/B) | IMPLEMENTED | AI cannot create them (QT-10) |
| Hidden, calculated, embedded data | IMPLEMENTED | calc code resolution defect (LOGIC-03) |
| Custom component | PARTIAL | no Studio variant, no plugin registry, unsandboxed (QT-13) |
| Unknown question type in JSON | BROKEN | accepted by schema, no lint, renders as text box (OR-01) |
| Required/optional, default values, min/max, input types | IMPLEMENTED | AI bounds not mirrored to `settings` (QT-09) |
| Display logic, skip logic, branching, nested AND/OR/NOT, 16 operators | IMPLEMENTED | 1,855 engine tests |
| Matrix references `Q1.R1`, `Q1.R1.C1`, label forms | PARTIAL | grammar works (verified); SEG3 label resolution and `C` digits-only (LOGIC-08), composite column-only refs not typeable (LOGIC-07), per_row+columns edge (LOGIC-09) |
| Matrix logic editor | PARTIAL | M1 fix verified in browser; cosmetic duplication `1: 1` (OR-04), unfiltered operators on composite (OR-05), SYSTEM_* noise (OR-06) |
| Masking, carry-forward, piping, dynamic text | IMPLEMENTED | — |
| Embedded data (URL/static/API) | IMPLEMENTED | — |
| Quotas + termination | PARTIAL | evaluation ok; increment uncapped, "full" decided client-side (SCHEMA-01/RUNTIME-03); counts not decremented on delete (SCHEMA-07) |
| Randomisation, rotation, option groups | IMPLEMENTED | — |
| Loops, repeated groups | IMPLEMENTED | — |
| Calculations | BROKEN (renamed codes) | LOGIC-03 |
| Auto-punch, list logic | IMPLEMENTED | — |
| Page breaks, blocks, back navigation, answer persistence | PARTIAL | Back ignores skip logic (LOGIC-04); Back not persisted (RUNTIME-06) |
| Validation ordering, error messages | PARTIAL | `on_submit` runs before blocking check (LOGIC-11); AI message dropped (AI-02) |
| Termination, screening, redirects, completion | IMPLEMENTED | backward skip targets fall through (LOGIC-05) |
| Reference integrity on rename/delete | PARTIAL | delete prunes (LOGIC-06, ok); hand-edited option/row codes do not retarget (LOGIC-01); question code rename partial (LOGIC-02) |
| Validation scripts (`def.scripts` on_validate/on_complete) | PARTIAL | work; unsandboxed (RUNTIME-04); AI cannot create (LOGIC-13) |
| UX styles/animations/scripts (unified pipeline) | IMPLEMENTED | 13-check browser suite (2026-10-15); a script can hide Next for good (RUNTIME-08) |
| Custom design generator | UI-ONLY | form cannot set `columnsSpec` (LOGIC-12) |

## Intelligent Mode
| Feature | Status |
|---|---|
| Brief → objectives/hypotheses/KPIs → questionnaire → logic → quotas → plan (structured, 70 ops, re-parsed) | IMPLEMENTED |
| Semantic validation from question meaning | MISSING (QT-02) |
| Intrinsic type rules survive AI validation | BROKEN (QT-01/AI-01) |
| Error recovery: bounded retries, checkpoints, no double-build | IMPLEMENTED |
| Researcher-readable error for 401/400 | BROKEN (AI-04) |
| Conversation memory persistence | PARTIAL (AI-05) |
| Hypothesis renumbering consistency | BROKEN (AI-03) |
| Custom CSS gate | BROKEN (AI-06) |
| Create designs (conjoint/maxdiff), create validation scripts | MISSING (METHOD-08, LOGIC-13) |
| Cross-mode parity (same store path, same migrations) | IMPLEMENTED |

## Collection and runtime
| Feature | Status |
|---|---|
| Server-side answer/status validation | MISSING (RUNTIME-01, P0) |
| Password / closed-survey enforcement on API | BROKEN (RUNTIME-02) |
| Resume by localStorage pointer, double-submit CAS, pending replay | IMPLEMENTED |
| Same-token second device | PARTIAL (RUNTIME-05) |
| Mobile rendering (360/390/768 — no page overflow, verified) | PARTIAL (OR-02, RUNTIME-10) |
| Accessibility | PARTIAL (RUNTIME-09) |

## Cleaning, analytics, exports
| Feature | Status |
|---|---|
| 70-rule quality engine, override, audit trail, soft delete, reproducibility | IMPLEMENTED |
| Quality on by default | PARTIAL (off, CLEAN-03) |
| Peers exclude soft-deleted | BROKEN (CLEAN-06) |
| Duplicate pair handling | PARTIAL (CLEAN-09) |
| Rule families: item non-response, demographic consistency, geo validity, media integrity | MISSING (CLEAN-01) |
| Bases (answered), frequencies, means, crosstabs, filters, weights, stat tests | IMPLEMENTED (83/84 controlled checks) |
| One base per screen | BROKEN (ANALYTICS-02) |
| Analysis plan → run → display → export | PARTIAL (ANALYTICS-05/06/07) |
| Conjoint/MaxDiff estimation | PARTIAL (aggregate logit only; MaxDiff version bug METHOD-02; crash METHOD-03) |
| ACBC/menu analytics | MISSING (METHOD-06) |
| Excel, SPSS, SAS, Stata, CSV, JSON data exports | IMPLEMENTED (SPSS non-ASCII loss DOC-06; status columns missing in stat formats DOC-08) |
| Questionnaire/programming spec .docx | IMPLEMENTED |
| Research plan .docx | PARTIAL (DOC-02) |
| Analysis framework / SAP .docx | PARTIAL→MISSING as a document (DOC-03) |
| Data-cleaning plan | MISSING (DOC-04) |
| Export access control | BROKEN (DOC-07) |

## Unverified here (needs DB or live provider)
List Fill atomic claim/release (4 declared Postgres suites); quota overshoot under concurrency; `RUNTIME-01/02` curl-level acceptance; analytics draft-vs-version read (ANALYTICS-12); AI-04 live card wording; 22 SQL-level tests. Each has a defined verification in `13-regression-test-plan.md`.

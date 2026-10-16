# 11 · Prioritized bug register — Rescript Studio audit, 2026-10-16

Repo at commit `b0dbe08` (branch `main`, after the script-pipeline unification). Every entry below was produced by inspecting the current code and, where marked **repro**, by executing a script or a browser run in this session. Scripts and their outputs live under `docs/audit-2026-10-16/repro/<area>/` (kept in the repo). Full per-area evidence — file:line, command output, controlled-dataset numbers — is in `raw/<area>.md`; this register is the index and the decision record.

**Status vocabulary.** IMPLEMENTED = verified by an executed test or repro · PARTIAL = exists but incomplete · UI-ONLY = control exists, no effect · BROKEN = reproduced defect · MISSING = absent · UNVERIFIED = could not be exercised here (reason given).

**Priority.** P0 critical (data loss, security exposure, major runtime failure, severe integrity) · P1 core programming / validation / collection / methodology / analytics materially broken · P2 important missing functionality, workflow failure, incomplete integration, significant usability · P3 enhancement, minor UX, optimisation.

**Counts.** P0: 1 · P1: 11 · P2: 49 rows · P3: 59 rows — 120 register rows covering 124 distinct finding IDs (117 from the eight area audits, 7 orchestrator findings `OR-01…07`; four rows pair two IDs that share one defect, and QT-04/AI-01 are explicit duplicates of RUNTIME-01/QT-01). Reproduced/code-verified defects (BROKEN or PARTIAL with repro): 61. UNVERIFIED (needs DB/live provider): 9. Missing-feature or enhancement rows: 50.

---

## A. P0 — critical

### RUNTIME-01 · Respondent API stores whatever the client posts — no server-side validation, status or flow check
- **Fix status (2026-10-16):** FIXED behind `RUNTIME_SERVER_VALIDATION` (default `log`, switch to `enforce` after a log-only period) — engine `checkSubmission` replays the interview server-side; see `docs/RUNTIME-SERVER-VALIDATION-2026-10-16.md`. Tests: engine `serverValidation.test.ts` (7), templates `serverCheck.test.ts` (no false refusals on every template + master-demo test paths).
- **Module / feature:** `apps/runtime/app/api/session/save/route.ts` · response collection.
- **Category:** data integrity / security.
- **Status:** BROKEN (code-verified by orchestrator; no DB here, so not exercised against Postgres).
- **Repro:** read `save/route.ts:47–69`: `answers ?? {}`, `calculated`, `embedded`, `flags`, `step_index`, `status` are written verbatim. `grep -rn "validatePage\|validateQuestion\|checkQuotas" apps/runtime/app apps/runtime/lib` → 0 hits. Runtime-level: `curl -X POST /api/session/save -d '{"sessionId":…,"answers":{"q_age":"999"},"status":"complete"}'` on any in-progress session (needs DB — documented as the acceptance test).
- **Expected:** the server re-runs page validation against the deployed version's definition, refuses out-of-range/wrong-type answers and status transitions the flow does not allow.
- **Actual:** any payload is stored and becomes `complete`; it then feeds analytics, exports and quotas.
- **Root cause:** validation (`validatePage` in `Runner.tsx`) is client-only by design; the save route only loads the definition for telemetry/quality config.
- **Related:** QT-04 (same gap, seen from validation), RUNTIME-02 (session can be minted on closed/password surveys), SCHEMA-01/RUNTIME-03 (quota over-fill), CLEAN-13.
- **Fix:** in `save/route.ts`, load the run definition (already done at :54), rebuild `ResponseState` from the row + posted deltas, run `validatePage` for the pages the client claims to have passed and `advance`/`resumeStep` to check `step_index`/`status` reachability; reject with 422 and the engine messages; keep the pending-answer replay the client already has. Run quota checks server-side on completion.
- **Schema / migration:** none.
- **Regression tests:** new `scripts/session-save-trust-test.mjs` (needs DB) — out-of-range numeric, wrong type, `status:complete` from page 1, answers for a question hidden by display logic; engine unit test for a `validateSubmission(def, row, delta)` helper.
- **Acceptance:** all four crafted payloads refused with engine messages; honest clients unchanged (corpus green); `wave1`, `loading-deadlock`, `resume` suites green.
- **Effort / risk:** M (2–3 days) / medium — must not reject legitimate resumes; feature-flag the enforcement for one release and log would-be rejections first.

---

## B. P1 — core functionality materially broken

### QT-01 · `create_question` with any `validation[]` replaces the variant's intrinsic rules (integer, email, phone, url, zip)
- **Fix status:** FIXED 2026-10-16 (commit 8854589): `mergeValidation` keeps intrinsic kinds; messages kept (AI-02); bounds mirrored (QT-09); numeric is-a-number check (QT-03).
- **Module:** `packages/engine/src/surveyActions.ts:1127` (`shapeQuestion`), `:553`, `:701` (`set_validation`); Intelligent Mode.
- **Category:** validation. **Status:** BROKEN (repro).
- **Repro:** `docs/audit-2026-10-16/repro/qt/age-validation.mjs` case C: `create_question type:"integer" validation:[min 1,max 100]` → stored kinds `[min_value,max_value]`, `25.5` ACCEPTED. Browser e2e `docs/audit-2026-10-16/repro/browser/age-e2e.mjs`: Intelligent Mode → Apply → runtime preview → type `25.5` → page advances (both `numeric` and `integer` variants).
- **Expected:** an integer/email question always carries its intrinsic rule; AI-supplied bounds add to it.
- **Actual:** intrinsic rule dropped; `AI-01` is the same defect seen from the Intelligent Mode side.
- **Root cause:** `q.validation = a.validation.map(...)` overwrites what `createQuestionFromVariant` seeded (`questionCreate.ts:44`, `variants.ts:832–835, 937–941`).
- **Fix:** merge — `q.validation = [...q.validation.filter(r => INTRINSIC.has(r.kind) && !supplied.has(r.kind)), ...supplied]`; same in `set_validation`. Add tests: integer+bounds keeps `integer`; email+max_length keeps `email`.
- **Schema:** none. **Tests:** `surveyActions.test.ts` (+2), `ux-script-dom`-style browser check "AI age rejects 25.5". **Acceptance:** age-validation script shows 0 mismatches for cases C/D; browser e2e stays on page with "Please enter a whole number". **Effort:** S (½ day) / low.

### QT-02 · AI-generated "age" is `numeric` with min/max only — nothing infers whole numbers; no semantic validation registry
- **Fix status:** FIXED 2026-10-16 (commit 0833024): `packages/engine/src/semanticValidation.ts` registry (`settings.semantic`), applied from the action, the variant, the wording, and the Studio "Treat the answer as" control; prompt documents the field. Browser: AI age refuses 25.5/abc/1e2.
- **Module:** `apps/studio/lib/copilot/prompt.ts` (numeric example), `packages/engine/src/surveyActions.ts`; Intelligent Mode.
- **Category:** validation / missing feature. **Status:** PARTIAL (repro).
- **Repro:** age-validation.mjs cases A/B: `25.5`, `abc`, `1e2` accepted. Browser e2e: advances on `25.5`.
- **Expected (brief §4B):** Integer, min 1, max 100, 0 decimals, from the question's semantics; email/phone/postal/URL/percentage/currency likewise.
- **Actual:** the only type→rule mapping is the variant preset (and QT-01 loses it); there is no `inferValidation(question)` and the prompt does not say "age → integer".
- **Fix:** add `packages/engine/src/semanticValidation.ts`: a registry keyed by `semantic` tag (`age`, `email`, `phone`, `postal`, `url`, `percent`, `currency`, `year`, `count`) → rule set + input mode; populate the tag from the variant (`text.email` → email) and from an action field `semantic` the prompt is told to set; apply in `shapeQuestion` and expose in the Studio Properties ("Treat as: age"). Keep bounds explicit (never hard-code 1–100).
- **Schema:** optional `question.settings.semantic` string (JSON only, no column). **Tests:** engine table test over the brief's boundary list; prompt test asserting the type table mentions `semantic`. **Acceptance:** "add an age question 18–100" via the fake provider yields integer rule + inputmode numeric; the 10 boundary inputs match the expected column. **Effort:** M (2 days) / low.

### AI-01 · Same defect as QT-01
- **Fix status:** FIXED with QT-01., seen from Intelligent Mode (every `set_validation` also replaces) — tracked together with QT-01.
- Evidence: `docs/audit-2026-10-16/repro/ai/validation-loss.mjs` ("not-an-email" accepted on an AI email question with a `required` rule). Fix and acceptance as QT-01.

### LOGIC-01 · Editing an option code (or row code) in the Studio Options editor does not retarget any logic
- **Fix status:** FIXED 2026-10-16 (commit f2dca5a): `recodeOptionCode`/`recodeRowCode` on blur/Enter, toast with count, unresolved toasted, lint at error level.
- **Module:** `apps/studio/components/studio/QuestionsPanel.tsx:426–428`; `store.tsx:275–287`. **Category:** logic / data integrity. **Status:** BROKEN (repro, orchestrator re-ran).
- **Repro:** `docs/audit-2026-10-16/repro/logic/ref-integrity.mjs` §1: Q2 display logic `Q1 = 2`; recode Blue 2→20 through the raw patch; answer 20 → Q2 hidden; quota cell `when:"2"` and calc `Q1 == 2` keep the old code; only a warning lint fires and `canonicalizeSurveyConditions.unresolved` is never toasted. §3: row code `svc`→`service` breaks `QM.svc.C2` the same way.
- **Expected:** conditions, quota cells, masks, punch codes, randomisation groups follow the code — as the Intelligent-Mode path already does (§2: `update_option` → "2 conditions updated").
- **Root cause:** the hand editor bypasses `recodeConditions`/`recodeOwnLists` (`optionActions.ts:303–327`).
- **Fix:** route the code input through `applyOptionAction({op:"update_option", code})` (or call the two recode helpers from `set`), extend them to row codes, surface `unresolved` as a toast, and lint at error level when a referenced code no longer exists.
- **Schema:** none. **Tests:** engine test "raw recode retargets display/quota/mask/punch"; browser `codes-sync-test` extension. **Acceptance:** after recoding in the UI, the ref-integrity script's §1 and §3 show `visible=true`, no unresolved. **Effort:** S–M (1 day) / low.

### LOGIC-03 · Calculations resolve question codes to `null` when code ≠ variableName, silently
- **Fix status:** FIXED 2026-10-16 (commit f2dca5a): `questionCodeAlias` resolver fallback; unknown names lint at error level.
- **Module:** `packages/engine/src/calcContext.ts:100–122`, `calc.ts:339–347`, `dependencies.ts:645`. **Category:** logic. **Status:** BROKEN (repro, re-run by orchestrator).
- **Repro:** `docs/audit-2026-10-16/repro/logic/calc-eq.mjs`: `code:"Q7", variableName:"N"`, answer 5 → `Q7 > 3` = false, `COLOR == 2` = true; `calc-eq2.mjs`: `Q7 + 1` = 1 while `N + 1` = 6; no calc error, no lint (outputs kept as `calc-eq2.out`).
- **Expected:** the calc DSL resolves codes like every other surface (the condition expression editor rewrites codes to names on save, so it is the Calculations tab and `create_calculation` that bite); unknown names are a lint error.
- **Fix:** `calcOptionsFor.resolver` falls back to `getQuestionByCodeOrVar(def, n)`; `lintCalculations` compares `referencedNames` against known names and reports unknowns; placeholder text updated.
- **Tests:** engine calc test with renamed variable; lint test. **Acceptance:** calc-eq script prints `true` for `Q7 > 3`; unknown name produces an error-level lint. **Effort:** S (½ day) / low.

### METHOD-01 · A required MaxDiff task accepts best==worst, untouched tasks and out-of-set codes
- **Fix status:** FIXED 2026-10-16 (commit 1356eb4).
- **Module:** `packages/engine/src/validate.ts:706` (the block covers `conjoint_task` only); renderer `QuestionRenderer.tsx:1795–1870`. **Category:** validation / methodology. **Status:** BROKEN (browser repro).
- **Repro:** `docs/audit-2026-10-16/repro/browser/maxdiff-listfill.mjs`: same item as best and worst in both tasks → no error, advances; only 1 of 2 tasks answered → advances.
- **Expected:** required = every task has a best and a worst, distinct, both in the task's item set.
- **Fix:** extend the `validate.ts:706` block to `maxdiff_task` (all tasks present, best≠worst, codes ⊂ task set); renderer disables the matching worst/best radio.
- **Tests:** engine validate test; browser check in `methodologies` suite. **Acceptance:** the two browser cases stay on the page with messages. **Effort:** S / low.

### METHOD-02 · MaxDiff analysis uses version-1 design rows for every respondent
- **Fix status:** FIXED 2026-10-16 (commit 1356eb4).
- **Module:** `packages/analytics/src/analyses/choice.ts:203` (no `c.vars[VAR_VERSION]` fallback that the conjoint runner has). **Status:** BROKEN (repro `docs/audit-2026-10-16/repro/method/02-estimation.v4.out.txt`: 4 versions → 27% of choices dropped, rest matched to wrong sets).
- **Fix:** resolve the respondent's version as conjoint does; add a 4-version synthetic test asserting item order recovery. **Acceptance:** planted-utility recovery within ±0.05 on 4 versions. **Effort:** S / low.

### METHOD-03 · One best==worst answer makes the whole MaxDiff analysis "not computable"
- **Fix status:** FIXED 2026-10-16 (commit 1356eb4): skipped and counted, warning on the result.
- **Module:** `packages/analytics/src/stats/choice.ts:53–54` (`chosen: -1` → TypeError). **Status:** BROKEN (repro `05-maxdiff-bestworst-same.out.txt`). **Fix:** skip the invalid task with a warning count ("3 tasks ignored: best = worst"). Depends on METHOD-01 for prevention. **Acceptance:** poisoned dataset returns utilities + warning. **Effort:** S / low.

### DOC-06 · SPSS `.sav` export replaces every non-ASCII character with a space
- **Fix status:** FIXED 2026-10-16 (commit f57062b): UTF-8 writer with 7/3 (65001) and 7/20 records; pyreadstat round trip. Strings > 255 bytes still cut (pre-existing).
- **Module:** `packages/exporters/src/spss.ts:72–78` (`ascii()` applied to labels, value labels, file label and string cells). **Category:** data loss. **Status:** BROKEN (repro `docs/audit-2026-10-16/repro/doc/sav-unicode.mjs`: Hindi/Chinese/Arabic/Cyrillic cells all `0x20`).
- **Fix:** write the `.sav` in UTF-8 (record type 7 subtype 20 encoding, or switch to a UTF-8-capable writer); keep ASCII transliteration only for the 8-byte short names. **Tests:** round-trip through `pyreadstat`/R `haven` in CI. **Acceptance:** multilingual labels survive. **Effort:** M / medium.

### DOC-07 · Response-data download is gated on `responses.read`; a `viewer` can export the full dataset
- **Fix status:** FIXED 2026-10-16 (commit a5153c3).
- **Module:** `apps/studio/app/api/surveys/[id]/responses/route.ts:29` vs `packages/access/src/roles.ts:181–185`. **Category:** security/access control. **Status:** BROKEN (code-verified by orchestrator). **Fix:** gate the download branch (`format=csv|xlsx|sav|xpt|dta|json`) on `responses.export`. **Tests:** `access-policy-test` case. **Acceptance:** viewer gets 403 on download, 200 on the table. **Effort:** XS / none.

### RUNTIME-02 · `POST /api/session/start` ignores `password` access mode and paused/closed status
- **Fix status:** FIXED 2026-10-16 (commit a5153c3).
- **Module:** `apps/runtime/app/api/session/start/route.ts:35–50` vs `app/s/[client]/[study]/page.tsx:22–43`. **Category:** security. **Status:** BROKEN (code-verified; curl-level acceptance needs DB). **Fix:** re-check `access.mode==='password'` (body `pw`) and `BLOCKING_STATUSES` in the route; refuse `save` on closed surveys. **Effort:** S / low.

---

## C. P2 — important gaps and workflow failures

| ID | Module · title | Cat. | Status | Evidence (raw doc) | Fix (summary) | Acceptance | Effort |
|---|---|---|---|---|---|---|---|
| OR-01 | Schema accepts unknown question types; no lint; runtime renders them as a text box | validation / integrity | BROKEN (repro: `constant_sum` parsed, rendered as `TextInput`) | orchestrator §runtime-misc; `QuestionRenderer.tsx:2798 default`, `questionTypes.ts` registry | schema `type` refinement against the registry (plugins register first) **or** error-level lint "unknown type" + renderer placeholder "unsupported question" | JSON import with a bad type is refused/lint-errored; preview shows a visible notice | S |
| OR-02 | Matrix on ≤390 px: scale columns beyond the 3rd are clipped inside `.rs-table-wrap`; no scroll affordance | mobile UX / data quality | PARTIAL (browser repro, screenshot `mobile-390.png`: "Good/Great" off-screen, wrapper `overflow-x:auto`, no indicator) | orchestrator; RUNTIME-10 | stack rows on ≤480 px (the renderer already has per-variant stacking) or add a fade/“scroll →” hint and sticky row label | at 390 px every scale point is reachable without horizontal scroll, or a visible hint exists | S |
| OR-03 (= ANALYTICS-04) | Analysis base of 20 — not reproducible from stored data; scope mechanisms documented | analytics | UNVERIFIED (DB read-only: no run/cache with n=20; T&L tracker scopes give 0/2/17/24/31) | ANALYTICS-04 + orchestrator SQL | make the scope line mandatory in every base caption ("completes · LIVE · clean"), show "not asked" separately (ANALYTICS-01), and record scope in `analytics_runs` | a base caption always names status/env/quality/version | S |
| QT-03 | `numeric`/`slider`/`nps` never check "is a number"; `"abc"`, `"1e2"` pass — **FIXED (8854589)** | validation | FIXED | qt §2 | add `kind:"number"` implicit check in `validateQuestion` for numeric types | boundary table matches | XS |
| QT-04 | No server-side re-validation | validation | MISSING | = RUNTIME-01 | see RUNTIME-01 | — | — |
| QT-11 | No cascading/dependent dropdown; no geographic hierarchy dataset | missing feature | MISSING | qt §1.3 | `dependent_dropdown` variant: child options filtered by parent answer; ship ISO country→admin1 dataset as a design file; city via external reference service, never invented | country→state→city demo survey renders and filters; invalid combos impossible | L |
| QT-13 | `custom_component`: no Studio variant, no plugin registry, unsandboxed `new Function` + raw `customHtml` | security / completeness | PARTIAL | qt; LOGIC-14 | sandbox like UX scripts (mirror DOM) or run in the same frame with an `api` bridge; sanitise `customHtml` | script escape test fails | M |
| AI-02 | Validation `message` dropped on `create_question` — **FIXED (8854589)** | validation | FIXED | ai | keep `message` in `shapeQuestion` | message survives | XS |
| AI-03 | `set_research` renumbers hypotheses but not question tags / plan items | research integrity | BROKEN (repro) | ai | relabel as `remove_hypothesis` does | tags point to the right H | S |
| AI-04 | 401/400 without `failure` object shown as "THE AI SERVICE COULD NOT PROCESS THIS REQUEST… tell your administrator"; client catch-all shows raw JS | UX / recovery | BROKEN (repro) | ai; BROWSER-REPRO pending (needs expired session) | map route refusals to plain messages ("You're signed out — sign in and send again") | each refusal has a researcher-readable sentence and a retry | S |
| AI-05 | Conversation memory lives in a module-level Map; lost on reload | recovery | PARTIAL | ai | persist turns/memory in the operations store | reload keeps the thread | M |
| AI-06 | `set_custom_code.css` stored raw and injected unscoped (`body{display:none}` accepted) | security / UX | BROKEN (repro) | ai | run through the CSS gate + scope to the card like `create_style` | repro refused | S |
| LOGIC-02 | Question code rename is a raw patch; stored rules survive (id-based) but text expressions/pipes/calcs that use the code do not | logic | PARTIAL | logic | rename through an action that rewrites expressions/pipes | rename test | S |
| LOGIC-04 | Back navigation ignores skip logic (goes to previous visible page in compiled order) | navigation | BROKEN (repro `flow-nav.mjs`) | logic | keep a visited-page stack in state; Back pops it | skip-then-back returns to origin | S |
| LOGIC-12 | Custom design generator cannot be configured from the Studio form (`columnsSpec` list field unsupported) | UI-only | UI-ONLY | logic | add list editor or JSON textarea | custom design created from UI | S |
| LOGIC-13 | No Intelligent-Mode action creates `def.scripts` (on_validate/on_complete) | AI parity | MISSING | logic | `create_script` op through the existing script gate | copilot creates a validation script | S |
| METHOD-04 | Anchored MaxDiff anchor answers never exported | export | PARTIAL | method | fill `VAR_ANCHOR` per task | export has anchor columns | S |
| METHOD-05 | Design diagnostics computed then discarded; no D-efficiency / two-way balance | methodology | PARTIAL | method | persist `summary.diagnostics`; add two-way balance metric and warn | diagnostics visible | M |
| METHOD-06 | No analysis for ACBC / menu conjoint; plan silently routes to `conjoint_utilities` | analytics | MISSING | method | refuse with message until an estimator exists | plan validation error | S (gate) / L (estimator) |
| METHOD-07 | Aggregate MNL only; no HB/individual utilities; simulator is a JSON textarea | methodology | PARTIAL | method | document limits in UI; roadmap HB | — | L |
| METHOD-08 | Intelligent Mode creates task shells but cannot create/attach a design | AI parity | PARTIAL | method | `create_design` op calling the plugin registry | AI conjoint renders tasks | M |
| METHOD-09 | List Fill with empty source never runs; `whenUnused:hide` destinations stay visible with unresolved piping | logic | BROKEN (browser repro: "How do you rate ?") | method + orchestrator | run the fill with zero items and apply `whenUnused` | destination hidden | S |
| METHOD-10 | No reconcile/release of List Fill claims held by abandoned sessions (doc claims one) | integrity | MISSING | method; RUNTIME-07 | scheduled job releasing claims for sessions idle > N h | claims released | M |
| METHOD-11 | `afterMaximum`, `fallback`, `fillToCount`, `allowDuplicates`, `weighted` inert; SQL fills to `p_count` regardless | UI-only | UI-ONLY | method | implement or hide | each flag has a test | M |
| METHOD-12 | List Fill `count: expression`, `source: script`, `method: custom` schema-only | UI-only | UI-ONLY | method | implement or remove from schema/UI | — | M |
| DOC-03 | No standalone Analysis Framework / SAP; plan schema lacks alpha/correction/weighting/missing-data fields | missing doc | PARTIAL | doc | extend `analysisPlan` schema (JSON) + SAP .docx generator from it | SAP downloads with the brief's sections | M |
| DOC-04 | Data-Cleaning Plan document missing (inputs exist deterministically) | missing doc | MISSING | doc | generator from `resolveConfig(def)` × `RULES` | downloads | S |
| DOC-08 / CLEAN-08 | `.sav/.xpt/.dta` never carry RESPONSE_STATUS / QUALITY / ENVIRONMENT; `dataset=all` mixes test and REMOVED rows unmarked (the `inDataset` contract itself is IMPLEMENTED) | export integrity | PARTIAL | doc | pass `extra` columns to the stat writers | columns present | S |
| DOC-02 | Research proposal lacks timeline, quota/sampling design, screening, ethics; prints engine-built plan when none saved | doc | PARTIAL | doc | add sections; label synthesized plan | — | M |
| CLEAN-01 | Missing rule families: item non-response, demographic consistency, geo validity, media integrity | cleaning | PARTIAL | clean | add rules to the catalogue | rules fire on synthetic data | M |
| CLEAN-03 | Quality off by default on every survey | cleaning | PARTIAL | clean | default `enabled:true` with "standard" strictness for new surveys (migration-free: default in schema) | new survey assesses | XS |
| CLEAN-06 | Soft-deleted responses remain quality peers and are re-assessed | cleaning | BROKEN (repro) | clean | `deleted_at is null` in `loadPeers`/`recomputeSurvey` | repro passes | XS |
| CLEAN-07 | Survey-wide recompute capped at `maxPeers` (3,000) — older rows keep stale settings silently | cleaning | PARTIAL | clean | page the recompute; report count | all rows recomputed | S |
| CLEAN-09 | Duplicate detection symmetric — both original and copy drop from the clean dataset | cleaning | PARTIAL | clean | arrival-order convention: flag the later one, mark the first REVIEW | one of a pair survives | S |
| ANALYTICS-02 | Topbox/CSAT/ranking/allocation tables carry `base.n = all cases` while the header shows answered n | analytics | BROKEN (repro) | analytics | use the answered base in `basics.ts:169/202/225`, `business.ts:157` | one base per screen/xlsx | XS |
| ANALYTICS-05 | Plan item naming a question by code passes validation but runs as "not in dictionary", base 0, no error code | analytics | BROKEN (repro) | analytics | resolve codes→variables at validation; set `error` | plan item errors visibly | S |
| ANALYTICS-12 | Analytics reads the DRAFT definition for rows on `current_version_id`; unsaved option-code edits can shrink live bases | analytics | UNVERIFIED (needs DB) | analytics | read the version's definition for versioned rows | before/after draft edit unchanged | M |
| SCHEMA-01 / RUNTIME-03 | Quota increment uncapped; "full" decided client-side from stale counts | integrity | PARTIAL | schema | `increment_quota_counts` returns rows still under limit and refuses overflow; server-side check on completion | two concurrent completions never exceed limit | M |
| SCHEMA-04 | `respondents.token` plaintext bearer, returned by Studio list route | security | PARTIAL | schema | hash at rest as interview tokens are (0030) | — | M (backfill) |
| SCHEMA-05 | `authenticated` can update any own-profile column incl. `role`, `customer_id` (latent: no PostgREST-with-user-JWT path exists today) | security (latent) | PARTIAL | schema | column-level revoke + trigger | self-update of role refused | XS |
| SCHEMA-06 | Studio response edit/import validate against the autosaved draft, not the collected version | integrity | PARTIAL | schema | validate against `version_id`'s definition | — | S |
| RUNTIME-04 | `def.scripts` run unsandboxed on the main thread; `while(true)` hangs Next; `fetch`/`localStorage` reachable | security / stability | PARTIAL | runtime | route through the UX sandbox + loop guard (now proven) | escape test fails | M |
| RUNTIME-05 | Same invitation token on a second device creates a duplicate partial | collection | PARTIAL | runtime; needs DB | treat `started` as resumable or refuse | one row per token | S |
| ARCH-01 | `@rescript/renderer` has zero tests (14.7k LOC) | quality | PARTIAL | arch | component tests for the 10 most-used question types | ≥ 40 tests | M |
| ARCH-02 | `apps/runtime` and `apps/interviews` have zero unit tests; 127 Studio route handlers untested in-process | quality | PARTIAL | arch | route-handler tests with a mocked storage layer | — | L |
| ARCH-05 / SCHEMA-10 | Static auth audit covers Studio only; 12 interviews routes have no `require*` | security hygiene | PARTIAL | arch | extend `auth-guard-audit.mjs` to runtime + interviews | audit green on all apps | S |
| DOC-12 | .docx exports print the base language only although per-language text is stored | export | PARTIAL | doc | `language` option on both generators + export dialog | translated spec downloads | S |
| ARCH-04 | Copied infrastructure across apps (`lib/admin.ts` ×3, `supabaseFetch.ts`, `mediaRoute.ts`) already diverged | architecture | PARTIAL | arch | one shared package | diff = 0 | M |
| ARCH-10 | 105 browser scripts import Playwright from an absolute machine path | test infra | PARTIAL | arch | devDependency + relative import | corpus runs on any machine | XS |

## D. P3 — minor, enhancements, hygiene

(ARCH-* statuses are the orchestrator's classification; the raw architecture table records evidence without a status column.)

| ID | Title | Status | Fix | Effort |
|---|---|---|---|---|
| OR-04 | Rating-matrix value picker reads `1: 1 · 2: 2 …` (code and label identical) — the "duplicate information" complaint | PARTIAL (browser repro) | print label only when code == label | XS |
| OR-05 | Composite column gets all ~40 operators (dates, rank, regex) regardless of column `responseType` | PARTIAL (browser repro) | filter `operatorsForQuestion` by column type | S |
| OR-06 | Condition source picker lists ~45 `SYSTEM_*` quality variables inline with questions | PARTIAL (browser repro) | group under "Quality scores" | XS |
| OR-07 | Reference chip repeats row/column already visible in the two selects | by design | collapse when both selects shown | XS |
| QT-05 | Two email regexes disagree on `a@b.c`; both accept `a..b@c.com` | PARTIAL | one validator (WHATWG-style) | XS |
| QT-06 | Phone/postal for a country without a format silently degrades to loose check | PARTIAL | say so in the Properties panel | XS |
| QT-07 | `checkUrl` accepts `mailto:` | PARTIAL | reject non-http(s) schemes | XS |
| QT-08 | `otherSpecifyFormat`, `pattern`, `custom_script`, `condition` rule kinds: engine ok, Studio/AI surface unverified | UNVERIFIED | browser check | S |
| QT-09 | AI bounds land in `validation[]` only, never `settings.minValue/maxValue` → builder Range fields empty — **FIXED (8854589)** | FIXED | — | — |
| QT-10 | AI `create_question` lacks friendly names for 12 types (geo, composite, repeating_group, …) | MISSING | extend `ACTION_TYPES` | S |
| QT-12 | No scalar duration / combined date-time; `validate.ts:596` references nonexistent `"datetime"` | MISSING | add variants | M |
| QT-14 | No analysis for acbc/geo/hotspot/annotation/media_timeline/repeating_group/upload (exported; excluded from the picker as `complex`) | PARTIAL | roadmap | L |
| AI-07 | Single-reply generation loses work on truncation (plan-first keeps checkpoints) | by design | keep plan-first default | — |
| AI-08 | Repair call omits reply schema | PARTIAL | pass schema | XS |
| AI-09 | Plan accepts a 4-row matrix as scalar t-test outcome | UNVERIFIED | `reviewAnalysisPlan` warning | S |
| AI-10 | Unhelpful hint for unquoted labels | PARTIAL | better hint | XS |
| LOGIC-05 | Backward/missing skip targets fall through silently | PARTIAL | lint error | S |
| LOGIC-07 | Column-only composite references cannot be typed/round-tripped | PARTIAL | grammar + formatter | S |
| LOGIC-08 | SEG3 label resolution missing; `C` prefix digits-only | PARTIAL | resolve labels | S |
| LOGIC-09 | per_row grid with `columns` mis-resolves `C<n>` | BROKEN (edge) | normalise shape | S |
| LOGIC-10 | Lint false positive for question-to-question comparisons — **FIXED (f2dca5a)** | FIXED | — | — |
| LOGIC-11 | `on_submit` scripts run before blocking errors are checked | PARTIAL | reorder | XS |
| LOGIC-14 | `custom_component` unsandboxed (see QT-13) | PARTIAL | — | — |
| LOGIC-15 | Display-rule target kinds for per_row grids: scale under "Option" | PARTIAL | label | XS |
| LOGIC-16 | `conditionSummary` narrates legacy double-spelled grid rules confusingly | PARTIAL | normalise first | XS |
| METHOD-13 | `acbc_task` missing from lint/logic graph/simulate/import/copilot review | PARTIAL | registry completeness test | S |
| METHOD-14 | MaxDiff `position` not what respondents saw | PARTIAL | export shown order | S |
| METHOD-15 | Menu currency never stored | PARTIAL | store | XS |
| DOC-09 | `SystemVars` claimed exported, are not | PARTIAL | export or fix comment | S |
| DOC-10 | CSV without BOM → Excel-on-Windows mojibake | PARTIAL | BOM option | XS |
| DOC-11 | Proposal/findings docs reachable only through a copilot sentence | UI gap | buttons | S |

| DOC-13 | Stamps lack time/revision/definition hash | PARTIAL | add | XS |
| CLEAN-12 | `timing.pattern_match` fires when page times are rounded to whole seconds (seen on the first synthetic fixture) | UNVERIFIED (fixture artefact vs real risk) | tolerance in ms, min variance | S |
| ANALYTICS-03 | Segment n = cases in segment, not answered base | PARTIAL | use answered | XS |
| ANALYTICS-06 | Manual plan run executes blocked items | PARTIAL | filter | XS |
| ANALYTICS-07 | Plan run takes weighting from `items[0]` only | PARTIAL | per-item | S |
| ANALYTICS-09 | Conjoint/MaxDiff aggregate only (documented) | IMPLEMENTED | — | — |
| ANALYTICS-11 | Cache invalidation correct; minor gaps (unbounded `stampCache`, per-env stamp) | IMPLEMENTED (gaps) | bound | XS |
| ANALYTICS-13 | Crosstab answered-base with layers falls back to "any of" | PARTIAL | compute `validN` | S |
| SCHEMA-02 | 0027 not re-runnable (no `drop trigger if exists`) | PARTIAL | add | XS |
| SCHEMA-03 | No down migrations | UNVERIFIED | per-migration undo notes | S |
| SCHEMA-07 | `quota_counts` not decremented on soft delete | PARTIAL | trigger like List Fill | S |
| SCHEMA-08 | `design_files` dead schema | PARTIAL | drop in a later migration | XS |
| SCHEMA-09 | No retention for result cache / login_attempts / share access | MISSING | scheduled sweep | S |
| SCHEMA-11 | Three RLS dialects coexist | PARTIAL | consolidate | M |
| RUNTIME-06 | Back not persisted; reload resumes further along | PARTIAL | persist step | XS |
| RUNTIME-07 | Abandoned partials never expire | MISSING | sweep | S |
| RUNTIME-08 | A UX script can hide/disable Next for good (browser repro: `hidden:true, disabled:true`, respondent stuck) | PARTIAL (repro) | refuse `hidden/disabled` on `[data-testid=rs-next]`/`.rs-nav` in `attrAllowed`; keep classes/styles | script cannot strand a respondent | XS |
| RUNTIME-09 | Matrix radios lack accessible names; `th` lacks `scope`; no arrow-key group nav on role=radio | PARTIAL | aria | S |
| RUNTIME-10 | Eight mobile breakpoints (no overflow at 360/390/768 — verified) | PARTIAL | 3 tokens | S |
| RUNTIME-11 | `/api/runtime-definition/[versionId]` serves any version by UUID, immutable cache | PARTIAL | active-deployment check | S |
| ARCH-03 | Dependency rules are prose; one env leak in engine | PARTIAL | eslint boundaries | S |

| ARCH-06 | Test fixture compiled into analytics dist (imports devDependency) | PARTIAL | move | XS |
| ARCH-07 | Files > 2,800 LOC (QuestionsPanel, nlIntent, variants, QuestionRenderer) | PARTIAL | split | L |
| ARCH-08 | Duplicated concepts in TS and SQL (question count; two quota loops) | PARTIAL | single source | S |
| ARCH-09 | 15 GB of stale `.next-*` build dirs inside `tsconfig.include` | PARTIAL | delete + ignore | XS |

| ARCH-11 | `pnpm test` tests `dist` without building | PARTIAL | `pretest: build` | XS |
| ARCH-12 | One dead dependency, one undeclared import | PARTIAL | fix package.json | XS |
| ARCH-13 | Version cut not atomic (insert then `rescript_finalize_version`, compensating delete on a lost race) | PARTIAL | single RPC | S |

## E. Verified as implemented (not defects — recorded so nobody re-audits them)
Proven by an executed test or reproduction in this audit:
- ANALYTICS-01 base = answered — `repro/analytics/controlled.mjs` (83/84, output `controlled.out`).
- CLEAN-02/04/05/10/14 configurable rules, override + `response_reviews` trail, soft delete only, deterministic assess — `pnpm --filter @rescript/quality test` 51 pass; `repro/clean/run-rules.mjs` (`run-rules.out`), `deleted-peers.mjs`; CLEAN-11 synthetic run; CLEAN-13 (AI vs manual parity, by design, code-verified).
- DOC-01 questionnaire .docx, DOC-05 data exports, DOC-13 Unicode in .docx — exporters 102 tests + `repro/doc/*`.
- LOGIC-06 delete prunes references — `repro/logic/ref-integrity.mjs` §5 (`ref-integrity.out`).
- METHOD generators (CBC balance + prohibitions, MaxDiff exposure, version assignment, aggregate logit recovery) — `repro/method/01-…08-*.out.txt`.
- Engine logic features — 1,855 engine tests executed (`raw/logic-engine.md` §Test run).
- Unit suites, typecheck, auth-guard audit — commands and outputs quoted in `raw/architecture.md` §0 (3,929 tests).
- The unified UX script pipeline — `scripts/ux-script-dom-test.mjs` (13 checks) executed on 2026-10-15 against this commit (`docs/SCRIPT-PIPELINE-2026-10-15.md`), not re-run today.
- Matrix editor M1 fix, mobile no-overflow at 360/390/768 — orchestrator browser runs (`repro/browser/`).

Code-verified only (no executed proof in this audit; treat as "consistent with code reading"): ANALYTICS-08 statistics catalogue (covered by the analytics package tests in general, not by a targeted check here), ANALYTICS-10 single `compute()` path, DOC-14 org/project scoping via `requireProject`, DOC-15 story reports, RUNTIME-12 double-submit CAS (engine `resumeStep` 34 tests executed; route not exercised), SCHEMA-12 SQL invariants (22 SQL tests could not be run — no DB), RUNTIME-13 (declared suites need the runtime server; the Playwright corpus itself ran on 2026-10-15).

## F. Shared root causes (one fix, several findings)
1. **Replace-instead-of-merge in `shapeQuestion`/`set_validation`** → QT-01, AI-01, AI-02, QT-09. One engine change.
2. **Studio hand-editors bypass the engine action layer** → LOGIC-01, LOGIC-02, (and the asymmetry behind cross-mode drift). Route code/row/question renames through `applyOptionAction`/`applySurveyActions`.
3. **Client-trusting runtime API** → RUNTIME-01, RUNTIME-02, RUNTIME-03/SCHEMA-01, QT-04. One server-side validation layer.
4. **Methodology wiring is hand-threaded through ~12 touch points** → METHOD-02/06/13, QT-14, ANALYTICS plan routing. A per-method capability object + registry-completeness test.
5. **Dataset scope not stated** → OR-03, ANALYTICS-02/03/13. A single base-caption component.
6. **No semantic layer on questions** → QT-02, QT-11, CLEAN-01 (demographic/geo rules need it), DOC-03 (variable coding). One `semantic` tag drives validation, geo hierarchy, cleaning rules and SAP variable tables.

---

## P2 batch — fix status (2026-10-16)

Fixed in commits `cee520c` (analytics), `3a89be8` (methods), `6627cf6` (cleaning + data exports), `bdd5ec8` (research documents), `71ae05a` (Intelligent Mode), `5b9f1ce` (runtime + editor), `2d8b154` (hygiene + SQL). Each ships with tests; unit totals after the batch: engine 1,911 · analytics 490 · exporters 127 · quality 58 · designs 55 · templates 107 · access 99 · Studio lib 525; Studio and runtime typecheck clean.

| ID | Status | What changed |
|---|---|---|
| ANALYTICS-02/03 | FIXED | answered base in topbox/ranking/allocation/CSAT tables and in segment n; controlled dataset 83/84 → 84/84 |
| ANALYTICS-05/06 | FIXED | plan codes resolve to variables; unresolvable or blocked items are not run and carry an `unknown_variable` error shown in the run caveat |
| ANALYTICS-07 | FIXED | weighting per plan item (one dataset per distinct weighting) |
| ANALYTICS-13 | FIXED | crosstab with layers computes `validN` |
| OR-03 / ANALYTICS-04 | FIXED (surface) | base caption on every result surface; run scope recorded in `analytics_runs.dataset.scope`. The original "base of 20" screen itself remains unreproducible from stored data |
| METHOD-09 | FIXED | empty List Fill source records count 0 and applies `whenUnused`; live route settles sources server-side. Not covered: a source on a branch the respondent never takes |
| METHOD-04/14 | FIXED | `VAR_T<n>_ANCHOR` and `VAR_T<n>_ORDER` columns |
| METHOD-05 | PARTIAL | two-way balance + persisted `summary.diagnostics`/`warnings`; D-efficiency not implemented |
| METHOD-15 | FIXED | menu currency stored and used |
| CLEAN-03 | FIXED | quality on by default (`QualityConfig.enabled` defaults true); explicit `enabled:false` stays off |
| CLEAN-06/07 | FIXED | deleted rows excluded; recompute paged by keyset, count reported |
| CLEAN-09 | FIXED (deviation) | later arrival carries the exclusion flag; the first arrival stays CLEAN with the pair as evidence (marking it REVIEW would have removed both from the clean dataset) |
| DOC-08 / CLEAN-08 | FIXED | status/quality/environment columns in `.sav/.xpt/.dta/SAS` |
| DOC-10 | FIXED | `bom=1` on CSV export |
| DOC-13 | FIXED | stamp has time, revision (when known) and a definition hash (browser-safe SHA-256) |
| DOC-04 | FIXED | cleaning-plan .docx + `GET /quality/plan` |
| DOC-02 | FIXED | sampling design, screening, timeline, ethics; derived plan labelled |
| DOC-03 | PARTIAL | SAP .docx + additive plan fields (alpha, correction, weighting, missing data, sample size, software). `alpha`/`weighting`/`missingData` are recorded but not yet executed by `runPlan` |
| DOC-11 | FIXED | Documents panel with six buttons |
| AI-03/05/08 | FIXED | relabel on `set_research`; memory persisted with operations; repair carries the schema |
| AI-04 | FIXED | refusals mapped to researcher sentences; browser proof by interception in `copilot-errors-test.mjs` (a real expired session is still unverified) |
| AI-06 | FIXED (AI path) | `set_custom_code.css` goes through the scoping gate; the manual Properties field still stores raw CSS |
| OR-01/02/04/05/06 | FIXED | unknown-type error lint + `rs-unsupported` card; matrix stacks ≤480 px (≤7 columns) else sticky label + scroll hint; picker/operator/group fixes |
| LOGIC-02 | FIXED | `renameQuestionCode` (rewrites pipes, `{{expr:}}`, calcs, named expressions; scripts reported); a code that is also the variable name is left alone because it still resolves |
| LOGIC-04/11 | FIXED | visited-page stack for Back; `on_submit` runs only after validation passes |
| RUNTIME-08 | FIXED | scripts cannot hide/disable Next/Back |
| QT-05/06/07 | FIXED | one email validator, "no format known" notice, URL scheme check |
| ARCH-09/10/11/12 | FIXED | see commit `2d8b154` |
| SCHEMA-02/05 | FIXED (unverified on Postgres) | migration files only; no Postgres in the sandbox to execute them |

# METHOD — research methodologies (Phase 4)

Audit date: 2026-10-16. Scope: Conjoint (CBC, Menu/MBC, ACBC), MaxDiff (standard, anchored, express), List Fill, extension points, Intelligent Mode. No Postgres in the sandbox: every DB-backed claim is UNVERIFIED and marked so.

Scratch scripts (all run against `packages/*/dist`, outputs saved beside them):

| Script | What it checks |
| --- | --- |
| `docs/audit-2026-10-16/repro/method/01-designs.mjs` | CBC 3-attribute design: determinism, one-way balance, prohibitions (pair + combination), duplicate concepts, holdouts, version assignment, alternative shuffling; MaxDiff exposure / pair balance / express coverage; ACBC prohibitions and near-concept generation |
| `docs/audit-2026-10-16/repro/method/02-estimation.mjs` | Synthetic respondents with known utilities through `buildDataset` + `runAnalysis` for CBC and MaxDiff, with `N` design versions (arg: 1 or 4) |
| `docs/audit-2026-10-16/repro/method/03-listfill.mjs` | List Fill engine: priority/cap sequence, randomisation, dedup, empty source, selection settings, count kinds, variables/dictionary, destinations, simulator, quota |
| `docs/audit-2026-10-16/repro/method/04-validation.mjs` | MaxDiff answer validation |
| `docs/audit-2026-10-16/repro/method/05-maxdiff-bestworst-same.mjs` | Effect of one best==worst answer on the MaxDiff model |
| `docs/audit-2026-10-16/repro/method/06-anchor-export.mjs` | Anchored MaxDiff: does the anchor reach the flat export |
| `docs/audit-2026-10-16/repro/method/07-intelligent-mode.mjs` | `create_question` with maxdiff / conjoint types through `coerceSurveyActions` + `applySurveyActions` |
| `docs/audit-2026-10-16/repro/method/08-acbc-menu-analysis.mjs` | Whether ACBC and Menu answers have any analysis path |

Existing suites run: `packages/designs` 45/45 pass; `packages/engine` acbc/tasks/designVersion/listFill 58/58 pass; `packages/analytics` analyses + maxdiffAnchored 31/31 pass.

## 1. What exists (inventory)

| Layer | File | Methodologies |
| --- | --- | --- |
| Design generators | `packages/designs/src/{conjoint,maxdiff,menu,acbc,custom}.ts`, registered via `designGeneratorRegistry` (`packages/schema/src/registry.ts:38-63`, `packages/designs/src/index.ts`) | CBC, MaxDiff (+anchored, +express), Menu-based conjoint / pricing configurator, ACBC (stage plan only), Custom columns |
| Question types | `packages/schema/src/question.ts:50-71`; variants `packages/schema/src/variants.ts:1416-1421, 2146-2178` | `conjoint_task` (CBC, menu via `renderer: "menutasks"`), `maxdiff_task`, `acbc_task` |
| Runtime | `packages/renderer/src/QuestionRenderer.tsx:1776-1930` (`DesignTasks`), `variants/conjoint.tsx` (menu), `variants/acbc.tsx`; `packages/engine/src/designVersion.ts` (version per respondent, alt shuffle); `packages/engine/src/acbc.ts` (ACBC state machine) | |
| Validation | `packages/engine/src/validate.ts:478-495, 706-741` | CBC every task; Menu min/max; ACBC complete; MaxDiff anchor-only |
| Export | `packages/engine/src/variables.ts:383-448` (dictionary), `packages/engine/src/flatten.ts:76-85, 166-201, 335-347` | `VAR_VERSION`, `VAR_T<n>`, `VAR_T<n>_BEST/_WORST`, menu `VAR_T<n>_<item>/_NONE/_TOTAL`, ACBC `_BYO_*`, `_WINNER_*`, `_JSON` |
| Analytics | `packages/analytics/src/analyses/choice.ts` (`conjoint`, `maxdiff`), `packages/analytics/src/stats/choice.ts` (aggregate conditional logit, Newton–Raphson, ridge 1e-3) | CBC part-worths/importance/holdout hit rate/share simulator/WTP; MaxDiff counts + logit utilities + anchored coding |
| List Fill | `packages/schema/src/listFill.ts`, `packages/engine/src/listFill.ts`, `supabase/migrations/0007_list_fill.sql`, `apps/runtime/app/api/session/listfill/route.ts`, `apps/runtime/components/Runner.tsx:306-363`, `apps/studio/components/studio/ListFillPanel.tsx` | allocation of list items across the sample with caps |
| Other | `packages/analytics/src/analyses/business.ts:256` TURF (from multi-select), `:361` pricing (Van Westendorp / Gabor-Granger from ordinary questions) | not design-driven, out of scope beyond noting they exist |

**Definition of List Fill in this codebase** (from `docs/LIST-FILL.md` and `listFill.ts` header): given a per-respondent candidate list (usually the options they selected), decide which 1..N items *this* respondent gets, subject to sample-level priorities, targets, caps and quotas, then claim the slot(s) atomically in Postgres and expose the result as `LISTFILL_<name>_*` variables and destination-question answers. It is sample-level allocation ("150 Apple, then 75 Beta…"), not carry-forward.

## 2. Methodology gap matrix

Status key: IMPL = verified by test/repro, PART = partial, UI = UI-only, BROKEN = repro'd, MISS = missing, UNV = unverified.

| Stage | CBC | Menu / configurator | ACBC | MaxDiff | List Fill |
| --- | --- | --- | --- | --- | --- |
| Config schema / editor | IMPL — attributes, prohibitions (pair + `also`/`when` combination), tasks, alts, none, holdouts, versions (`conjoint.ts:82-96, 187-231`; editor `DesignsPanel.tsx:54-140`) | IMPL — items/price levels, required, min/max, none, currency (`menu.ts:46-66`) | IMPL — attributes, pair prohibitions only, stage sizes (`designs/acbc.ts:25-36`) | IMPL — items, per task, tasks, versions, anchored + prompt, itemsPerVersion (`maxdiff.ts:38-59`) | IMPL schema (`schema/listFill.ts`); UI PART — count only fixed/all (`ListFillPanel.tsx:306-311`), no expression/question count, no script source |
| Design algorithm | IMPL — one-way frequency balancing + seeded tie-break, bounded redraws, legal-space fallback (`conjoint.ts:312-448`). Not D-efficient; two-way balance not controlled (repro: Brand×Price cells 9..23 with one-way all exactly equal) | IMPL — per-item price balancing, no repeated price vector per version | n/a — adaptive at interview time (`engine/acbc.ts:115-157` near-concepts, `162-187` rules, `190-213` tournament) | IMPL — greedy BIBD-style: one-way + pairwise co-occurrence (`maxdiff.ts:198-296`) | n/a |
| Prohibitions / restrictions | IMPL — honoured (0 violations in 224-row design; combination prohibition 0 violations); infeasible sets refused with level-reachability check (`conjoint.ts:287-307`) | MISS — no restrictions on price combinations | IMPL — pair prohibitions honoured (800 near-concepts, 0 violations); unacceptable/must-have rules honoured | n/a | eligibility: IMPL (`eligible`, `eligibleWhen`, `runWhen`) |
| Balance diagnostics | PART — `summary.levelFrequencies/balanceScores/spaceRemaining` computed but **dropped on attach** (`DesignsPanel.tsx:233-244` stores only columns/rows; `DesignReference.file` has no summary field `survey.ts:486-494`); shown once in the preview `<pre>` only. No D-efficiency, no two-way table | PART — same | PART — stage plan only | PART — `itemShowCounts`, `pairCooccurrence`, `neverShown` — same drop-on-attach | IMPL — dashboard `listFillStatus`, simulator (`listFill.ts:1019, 1078`) |
| Per-respondent assignment | IMPL — version = hash(seed, question) (`designVersion.ts:54-64`; 4000 seeds → 1000/1000/1000/1000); alternatives shuffled per respondent per task, None last (`:98-120`); stable across resumes (test `designVersion.test.ts:131`) | IMPL — same `designRowsFor` | IMPL — all randomness from respondent seed (`acbc.ts:118`) | IMPL — same version hash; alternatives re-shuffled per respondent (design `position` column therefore not what is shown) | IMPL — seeded RNG per list; D/E spread 258/242 over 500 seeds |
| Rendering | IMPL (`QuestionRenderer.tsx:1816-1882`); all tasks on one page, no per-task paging | IMPL (`variants/conjoint.tsx`) | IMPL (`variants/acbc.tsx`) | PART — best/worst radios with no best≠worst guard (`:1848-1866`); all tasks one page | IMPL via destinations / piping |
| Response capture | IMPL `{task: alt}` | IMPL `{task: [items] \| ["none"]}` | IMPL full transcript (`AcbcAnswer`) | IMPL `{task: {best, worst, anchor?}}` | IMPL `LISTFILL_*` in `state.calculated` |
| Validation | IMPL every task when required (`validate.ts:706-718`, test `tasks.test.ts:112`) | IMPL incl. min/max (`:719-731`) | IMPL stage-aware (`:735-741`) | **BROKEN** — required accepts partial tasks and best==worst (METHOD-01) | IMPL — explained rejections |
| Export columns | IMPL `VAR_VERSION`, `VAR_T<n>` (`tasks.test.ts:40`) | IMPL item flags, NONE, TOTAL | IMPL BYO/WINNER/rules/JSON | PART — BEST/WORST exported; **anchor never exported** although declared (METHOD-04) | IMPL — dictionary declares all positions (`03-listfill` §7) |
| Estimation | IMPL — aggregate MNL, effects-coded, ridge; recovered planted utilities within ±0.02 on 600×8 tasks, 4 versions (`02-estimation.v4.out.txt`). No HB / individual utilities, no interactions, no latent class | **MISS** — conjoint runner expects `alt` rows; menu answers give "Only 0 choice tasks answered" (METHOD-06) | **MISS** — plan routes to `conjoint_utilities` (`analysisFramework.ts:122`) but runner silently falls back to *another* conjoint question or reports none (METHOD-06) | PART — count B−W and aggregate MNL (best + sign-reversed worst), anchored coding; order recovered. **Multi-version designs analysed against version 1 rows** (METHOD-02); **one best==worst answer crashes the whole analysis** (METHOD-03) | n/a |
| Utilities / importance / share | IMPL — part-worths with SE/p, importance = range share, logit shares, WTP via price slope (`choice.ts:96-129`) | MISS | MISS | IMPL — utilities, rescaled probability shares, "above anchor" | n/a |
| Simulator | PART — scenario profiles only as raw JSON textarea (`AnalysisBuilder.tsx:169`); no interactive market simulator, no none-share calibration | MISS | MISS | n/a | IMPL — `simulateListFill` + Studio panel |
| Diagnostics | IMPL — LL, null LL, McFadden R², hit rate, holdout hit rate, converged, none % | MISS | MISS | IMPL — R², hit rate, anchor counts | IMPL — trace per option |
| Segment cuts | MISS (no `by`) | MISS | MISS | PART — mean B−W count score by one segment variable (`choice.ts:269-276`); no segment-level logit | n/a |
| Intelligent Mode | PART — only exact variant key `conjoint.cbc`; no design op (METHOD-08) | MISS | MISS | PART — `type:"maxdiff"` creates a `maxdiff_task` with no design (METHOD-08) | MISS — no `create_listfill` op |
| Lint / quality check | IMPL — missing/unknown designRef (`lintLogic.ts:1318-1337`) | IMPL | **MISS** — `acbc_task` excluded from the design-ref lint (`lintLogic.ts:1321`) | IMPL; no kind-mismatch check (maxdiff question → conjoint design) | IMPL (`qualityCheck` category `listfill`) |

### List Fill lifecycle detail

| Stage | Status | Evidence |
| --- | --- | --- |
| Source list (question selected/displayed/all, static, calculation, embedded, chained listFill, script) | IMPL for question/static/calculation/embedded/listFill; script = PART (reads `state.calculated[scriptId]`; nothing runs the script in the engine — `listFill.ts:238-242`) | `03-listfill` §1, §10 |
| Dynamic population / hidden source | IMPL | `listFill.test.ts:72` |
| Eligibility / exclusion | IMPL (`eligible`, `eligibleWhen`, `runWhen`, quotas) | `03-listfill` §11; `listFill.test.ts:187-222, 358` |
| Dedup | IMPL at decision (`listFill.ts:374-375`); `listFillCandidates` itself returns duplicates | `03-listfill` §3 |
| Ordering / randomisation | IMPL, deterministic per seed | `03-listfill` §2 |
| Count | PART — `fixed`, `all`, `question`, `calculation` work; `expression` reads `state.calculated[<expression text>]` and nothing evaluates it (METHOD-12) | `03-listfill` §6 |
| Selection settings | PART — `afterMaximum` (`random_fallback`, `stop`), `fallback`, `fillToCount`, `allowDuplicates`, `weighted` are stored and echoed in the trace but have no effect (METHOD-11) | `03-listfill` §12 |
| Empty list handling | **BROKEN** — a list whose source is empty never runs, so `whenUnused` destinations are never hidden (METHOD-09) | `03-listfill` §4 |
| Interaction with loops | IMPL — `listFill` loop source reads the stored allocation (`loops.ts:227-238`) | code read; not executed |
| Interaction with quotas | IMPL — provisional-bind quota check, position-sensitive (`listFill.ts:291-317`) | `03-listfill` §11 |
| Persistence / audit | UNV — `listfill_allocations`, `listfill_counts`, idempotent re-read, advisory lock (`0007_list_fill.sql:139-204`); declared proof `scripts/listfill-allocation-test.mjs` (needs Postgres, not run) | |
| Atomic claim | UNV — `insert … on conflict … where count < p_max` (`0007_list_fill.sql:104-113`) | |
| Release on screen-out / delete / complete | UNV — `save/route.ts:146-149`, trigger `0007_list_fill.sql:301` | |
| Abandoned sessions | **MISS** — no reconcile job exists; `countOnCompleteOnly` is the only mitigation (METHOD-10) | grep over `apps/*/app/api/cron` |
| Export | IMPL — `LISTFILL_*` columns in dictionary and `state.calculated` → flatten | `03-listfill` §7 |
| Runtime failure mode | PART — a 503 from the allocator does not block navigation; destination pages render unfilled until the next submit retries (`Runner.tsx:338-346`) | code read |

## 3. Findings

| ID | Sev | Status | Finding |
| --- | --- | --- | --- |
| METHOD-01 | P1 | BROKEN | MaxDiff `required` accepts a task with only best, untouched tasks, best==worst, and item codes outside the task's set |
| METHOD-02 | P1 | BROKEN | MaxDiff analysis reads version 1 design rows for every respondent of a multi-version design |
| METHOD-03 | P1 | BROKEN | One respondent answering best==worst on one task makes the whole MaxDiff analysis "not computable" |
| METHOD-04 | P2 | PARTIAL | Anchored MaxDiff anchor answers never reach the flat export (declared `VAR_ANCHOR` is never filled; "one column per task" not implemented) |
| METHOD-05 | P2 | PARTIAL | Design balance diagnostics are computed and discarded on attach; no D-efficiency / two-way balance anywhere |
| METHOD-06 | P2 | MISSING | No analysis path for ACBC or Menu-based conjoint; plan routes both to `conjoint_utilities`, which silently analyses a different question or reports 0 tasks |
| METHOD-07 | P2 | PARTIAL | Estimation is aggregate MNL only — no HB / individual-level utilities, no latent class, no interactions; simulator is a JSON textarea |
| METHOD-08 | P2 | PARTIAL | Intelligent Mode can create `maxdiff_task` / `conjoint_task` shells but has no action to create or attach a design; the result renders "Design file not generated yet" |
| METHOD-09 | P2 | BROKEN | List Fill with an empty source never runs, so `whenUnused` destinations stay visible |
| METHOD-10 | P2 | MISSING | No reconcile/release of List Fill claims held by abandoned in-progress sessions (doc and schema comment say a reconcile job does this) |
| METHOD-11 | P2 | PARTIAL | List Fill selection settings `afterMaximum`, `fallback`, `fillToCount`, `allowDuplicates`, `weighted` have no effect; DB claim also fills to `p_count` regardless |
| METHOD-12 | P2 | PARTIAL | List Fill `count.kind = "expression"` and `source.kind = "script"` / `method = "custom"` are schema-only |
| METHOD-13 | P3 | PARTIAL | `acbc_task` is missing from the design-reference lint, logic graph, simulate, import map and copilot review — the extension-point risk realised |
| METHOD-14 | P3 | PARTIAL | MaxDiff design `position` column is not what respondents see (alternatives are re-shuffled per respondent); no position-effect data is exported |
| METHOD-15 | P3 | PARTIAL | Menu renderer reads `design.file.summary.currency`, which is never stored; total shows no currency unless `config.currency` is set |

### METHOD-01 — MaxDiff required validation is non-empty only (P1, BROKEN)

Evidence: `packages/engine/src/validate.ts:700-718` — the comment says "a best AND a worst (MaxDiff)" but the block is `if (q.type === "conjoint_task" && …)`; the only `maxdiff_task` branch (`:478-495`) checks the anchor. Renderer radios are independent groups with no best≠worst guard (`QuestionRenderer.tsx:1853-1864`).

Repro: `node docs/audit-2026-10-16/repro/method/04-validation.mjs`
```
task 1 best only: []
task 1 best+worst, task 2 untouched: []
task 1 best == worst (same item 2): []
best is an item NOT in task 1's set (item 9): []
flatten of best==worst: {"MD_VERSION":"1","MD_T1_BEST":2,"MD_T1_WORST":2}
```
Expected: errors for incomplete tasks, best==worst, and codes outside the set (the CBC branch already does the per-task check). Fix: extend the design-task block to `maxdiff_task` (every task needs `best` and `worst`, `best !== worst`, both in the task's `item_index` set); disable the matching radio in the renderer.

### METHOD-02 — MaxDiff analysis ignores the respondent's version (P1, BROKEN)

Evidence: `packages/analytics/src/analyses/choice.ts:203` `const version = String(c.answers[\`${qid}_version\`] ?? "1")`. No code writes `answers[<qid>_version]` (grep over packages/apps). The conjoint runner (`:74`) falls back to `c.vars[VAR_VERSION]`, which `flatten.ts:76-85` does write; the MaxDiff runner does not. `designIndex` then returns version 1's rows for the task, so respondents of versions 2..N are scored against items they did not see; a best/worst not in that set is dropped, one that happens to be in it is attributed to the wrong competitors.

Repro: `node docs/audit-2026-10-16/repro/method/02-estimation.mjs 4` vs `… 1` (600 respondents, 9 tasks):
```
4 versions: Choices modelled=7879   (expected 600*9*2 = 10800 → 27% silently dropped, rest mis-set)
1 version : Choices modelled=10800
```
The conjoint runner on the same 4-version data modelled all 4800 tasks. Fix: `const version = String(c.answers[…] ?? c.vars[\`${q?.variableName}_VERSION\`] ?? "1")` as in the conjoint runner; add a multi-version case to `analyses.test.ts`.

### METHOD-03 — best==worst crashes the MaxDiff model (P1, BROKEN)

Evidence: `choice.ts:218` builds the worst set as `rest = ids.filter(i => i !== b)` then `chosen: rest.indexOf(wo)` → `-1` when `wo === b`; `stats/choice.ts:56` reads `alts[s.chosen][i]` → TypeError, caught by `runAnalysisCore` → `error.not_computable`. Because METHOD-01 lets the answer through, one respondent can take the analysis down for the whole study.

Repro: `node docs/audit-2026-10-16/repro/method/05-maxdiff-bestworst-same.mjs`
```
poison=false: McFadden R²=0.237, 6 rows
poison=true : error {"code":"not_computable"} — TypeError: Cannot read properties of undefined (reading '0') at evaluate (stats/choice.js:56)
```
Fix: skip the worst observation (and the count) when `wo === b`, and report the number of such tasks as a warning; fix METHOD-01 upstream.

### METHOD-04 — anchor never exported (P2, PARTIAL)

Evidence: `variables.ts:438-447` declares `VAR_ANCHOR` ("one column per task at export"); `flatten.ts:182-185` writes only `_BEST`/`_WORST`. Repro `node docs/audit-2026-10-16/repro/method/06-anchor-export.mjs`:
```
dictionary MD_*: …,MD_T2_WORST,MD_ANCHOR
flattened MD_*: {"MD_VERSION":"1","MD_T1_BEST":2,"MD_T1_WORST":3,"MD_T2_BEST":3,"MD_T2_WORST":4}
```
The analysis reads raw answers so it is unaffected; the client's CSV/SPSS is missing a question that was asked. Fix: declare and fill `VAR_T<n>_ANCHOR` per task.

### METHOD-05 — diagnostics discarded; no efficiency measure (P2, PARTIAL)

`conjoint.generate` returns `summary.levelFrequencies/balanceScores/legalConcepts/spaceRemaining`, `maxdiff.generate` returns `itemShowCounts/pairCooccurrence/neverShown`; `DesignsPanel.tsx:233-244` persists `{columns, rows, generatedAt}` only and `DesignReference.file` (`survey.ts:486-494`) has no summary field. Repro `01-designs.out.txt`: one-way balance is exact (max/min = 1.000 on all three attributes) but two-way Brand×Price cells range 9..23 — no two-way or D-efficiency metric exists to show this. MaxDiff: exposure 15/15 across 5 versions, pairs 3..6 of 66, express 30 items / 4×12: 0 never shown.

### METHOD-06 — ACBC and Menu have no analysis (P2, MISSING)

`analysisFramework.ts:121-122` plans `conjoint_utilities` for `acbc_task` and for menu `conjoint_task`. `choice.ts:30-35 questionIdFor` falls back to *any* `conjoint_task` in the survey when the named question is not one. Repro `node docs/audit-2026-10-16/repro/method/08-acbc-menu-analysis.mjs` (60 complete ACBC transcripts + menu answers):
```
runAnalysis(conjoint, ACBC) → "Only 0 choice tasks answered — too few to estimate 14 parameters."   (ran against the MENU question)
runAnalysis(conjoint, MENU) → "Only 0 choice tasks answered …"   (menu rows have no `alt`)
runAnalysis(descriptive, ACBC_WINNER_Brand) → "has no descriptive summary — use the dedicated analysis for this question type."
runAnalysis(descriptive, MENU_T1_2) → same refusal
```
So exported ACBC/menu columns cannot even be tabulated. Fix: add runners (ACBC: screening + tournament choices as choice sets, BYO frequencies; Menu: per-item binary logit on own/cross price), map `acbc_task`/menu in `planBridge`, and let `descriptive` summarise their scalar columns.

### METHOD-07 — aggregate-only estimation (P2, PARTIAL)

`stats/choice.ts` is one pooled conditional logit (ridge 1e-3, effects coding). There is no hierarchical Bayes, latent class, individual utilities or interactions, so no respondent-level simulator, segment utilities or share-of-preference by segment. The MaxDiff "by segment" table is count-based. The CBC simulator takes scenarios as a JSON textarea (`AnalysisBuilder.tsx:169`). Recovery of planted aggregate utilities is good (`02-estimation.v4.out.txt`: $10 1.206/1.2, $30 −1.217/−1.2, Alpha 0.408/0.4, 2y 0.19/0.2; MaxDiff order fully recovered) — the gap is scope, not correctness.

### METHOD-08 — Intelligent Mode cannot configure a conjoint / MaxDiff (P2, PARTIAL)

`surveyActions.ts:147` maps `maxdiff` → `maxdiff.best_worst`; no alias for conjoint/cbc/acbc/menu (`variantForActionType("conjoint") === null`), and the prompt's type list (`apps/studio/lib/copilot/prompt.ts:46-47`) names neither. No `create_design` / `generate_design` / `create_listfill` op exists. Repro `node docs/audit-2026-10-16/repro/method/07-intelligent-mode.mjs`:
```
coerced ops: create_question ×3 | rejected: "unknown action create_design", "unknown action generate_design"
Q1 type=maxdiff_task designRef=(none) options=6   ← options stored but the renderer ignores them
Q2 type=conjoint_task (only via exact key "conjoint.cbc") designRef=(none)
designs after apply: 0
```
A MaxDiff asked for in chat renders "Design file not generated yet" until someone opens Design Generators by hand.

### METHOD-09 — empty List Fill source never runs; `whenUnused` is dead (P2, BROKEN)

`listFill.ts:923-931 pendingListFills` requires `listFillCandidates(...).length > 0`; `unusedListFillDestinations` (`:881-900`) returns nothing while `LISTFILL_<name>_COUNT` is unset. Repro `03-listfill.out.txt` §4: respondent selected nothing → `pendingListFills: (none)`, `listFillHiddenDestinations: []`, `visibleQuestions: q2,q3` with both destinations configured `whenUnused: "hide"` and piping `{{LISTFILL_Q1_1}}` unresolved. Contrast: a list that ran with 1 of 2 hides `q3`. Fix: run (and record an empty result for) a list whose source is empty once its source question has been passed, or treat "source answered but empty" as count 0.

### METHOD-10 — abandoned sessions keep their slots (P2, MISSING, UNV on DB)

`schema/listFill.ts:238-242` and `docs/LIST-FILL.md` say abandoned sessions "are released by the reconcile job". Release only happens on a terminal save (`apps/runtime/app/api/session/save/route.ts:146-149`) and on delete (trigger). No cron under `apps/studio/app/api/cron/*` or `apps/runtime/app/api/*` touches `listfill_*`; `rescript_recount_listfill` (`0007_list_fill.sql:265-281`) rebuilds from allocations that still stand, so it does not release them either. An option capped at 150 fills with drop-offs. Mitigation available: `countOnCompleteOnly`. Verify on a DB: allocate 150 sessions, finish none, observe `allocated_count=150` and the next respondent falling to B.

### METHOD-11 — inert List Fill selection settings; DB fills to count regardless (P2, PARTIAL, DB part UNV)

Engine never reads `afterMaximum` (only echoed into the trace `listFill.ts:355`), `weighted`, and `allowDuplicates` cannot matter because `order` holds each code once (`:460-491`). `fallback`/`fillToCount` (`:494`) are reached only after the main walk, which already walks *every* usable option in priority order, so the "random D/E" behaviour comes from the unprioritised band + `equalPriority`, not from `fallback`. Repro `03-listfill.out.txt` §12: `afterMaximum: "stop"` with A full → `B`; `random_fallback` → `B`; `fallback none + fillToCount false` identical to `random_eligible` on 300/300 seeds; `allowDuplicates` count 3 over {A,B} → `A,B`. Server side, `rescript_allocate_listfill` loops `p_count` slots over the whole preference (`0007_list_fill.sql:174-204`) and `allocationPayload` sends every usable option, so even a future engine that stopped short would be overruled by the claim. The Studio exposes `fallback` (`ListFillPanel.tsx:341`), so a programmer can set a rule that does nothing.

### METHOD-12 — schema-only List Fill features (P2, PARTIAL)

`count.kind = "expression"` reads `state.calculated[c.expression]` (`listFill.ts:268-274`) — i.e. a calculated variable literally named `min(2, Q1_COUNT)`; nothing evaluates it (repro §6 → 0). `source.kind = "script"` reads `state.calculated[scriptId]` and `method: "custom"` falls back to priority with a trace note (`:654-660`). The Studio only offers fixed/all counts, so these are unreachable from the UI and silently degrade if authored in JSON.

### METHOD-13 — `acbc_task` not wired through shared touch points (P3)

Files that handle `maxdiff_task` but not `acbc_task`: `packages/engine/src/lintLogic.ts:1321` (design-ref lint), `logicGraph.ts`, `packages/analytics/src/analyses/choice.ts`, `packages/templates/src/simulate.ts`, `packages/import/src/map.ts`, `apps/studio/lib/copilot/review.ts`, `apps/studio/lib/architect/structure.ts`. An ACBC question with no design passes lint and fails at render.

### METHOD-14 / METHOD-15 — minor

- MaxDiff `position` is generated and balanced (`maxdiff.ts:285-294`) but `DesignTasks` re-shuffles via `shuffleAlternatives` (`QuestionRenderer.tsx:1822-1826`), so neither the design's position nor the shown position is exported.
- `variants/conjoint.tsx:58` reads `design.file.summary?.currency`; the attach path never stores a summary (METHOD-05).

## 4. Adding a new methodology — extension points

The registry story (`schema/registry.ts:1-11`: "adding a plugin makes it available end-to-end without touching the core engine") holds for **design generation only**. To field and analyse a new method today, these are separately wired, with nothing enforcing that all are done (ACBC is the proof — METHOD-06, METHOD-13):

| Concern | Where | Mechanism |
| --- | --- | --- |
| Design | `packages/designs/src/index.ts` | `designGeneratorRegistry.register(plugin)`; config form limited to field types `number/text/boolean/select/list/attributes/prohibitions` (`registry.ts:52`) |
| Question type + variant | `schema/question.ts:50-71`, `schema/variants.ts` (`baseType`, `renderer`, `capabilities: ["design_ref"]`) | hand-edit the union and catalogue |
| Renderer | `renderer/src/QuestionRenderer.tsx:2778` switch, or `registerVariantRenderer` | per type |
| Version assignment / shuffle | `engine/designVersion.ts` | shared, reusable |
| Validation | `engine/validate.ts` | per-type `if` blocks |
| Dictionary + flatten | `engine/variables.ts`, `engine/flatten.ts` | per-type `case` |
| Lint / quality | `engine/lintLogic.ts:1321`, `qualityCheck.ts` | hard-coded type list |
| Analysis plan | `engine/analysisFramework.ts:119-123`, `schema/analysisPlan.ts:35` method enum, `analytics/planBridge.ts:33` | per-type mapping |
| Runner | `analytics/analyses/index.ts RUNNERS`, `analytics/types.ts` kind union, `analytics/dataset.ts:111 COMPLEX_TYPES` | per-kind |
| Studio | `DesignsPanel.tsx` (generic), `QuestionsPanel.tsx` design picker, `AnalysisBuilder.tsx` options | per-type |
| Simulated respondents | `templates/src/simulate.ts:114-135` | per-type |
| AI | `engine/surveyActions.ts:128-148 ACTION_TYPES`, `apps/studio/lib/copilot/prompt.ts` type and method lists | per-type |

Risk: a `QuestionTypePlugin` exists in the registry (`registry.ts:16-36`) but no design-driven type uses it, and there is no counterpart for validation/flatten/analysis. Recommendation: a per-method capability object (`{kind, validateAnswer, flatten, dictionary, analyse, simulate}`) registered once and consulted by `validate.ts`, `flatten.ts`, `variables.ts`, `lintLogic.ts`, `analysisFramework.ts` and `RUNNERS`, with a test that iterates `designGeneratorRegistry.all()` and asserts each kind has every hook.

## 5. Not verified / needs orchestrator

- All Postgres paths (atomic claim, idempotency, release triggers, recount): `scripts/listfill-allocation-test.mjs` and `scripts/listfill-test.mjs` are declared but need a DB.
- BROWSER-REPRO NEEDED (METHOD-01): open a MaxDiff task, pick the same item as best and worst, press Next → expected an error, actual advances.
- BROWSER-REPRO NEEDED (METHOD-09): survey with a List Fill on a multi-select, destinations `whenUnused: hide`; select nothing → next page still shows the destination questions with `{{LISTFILL_…}}` unresolved.

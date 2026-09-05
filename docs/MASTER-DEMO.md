# Master Demo — capability showcase survey

**"2026 Consumer Technology, Finance & Digital Lifestyle Study"** (`MASTER_DEMO_2026`) is a complete, intentionally programmed reference survey. A programmer, a client or a new team member can open it and see how every important capability of the platform is used — and every one of those capabilities is *connected*: the brands a respondent selects drive carry-forward, list operations, List Fill, four kinds of loop with loop-scoped reference tables, a nested loop, auto-punch, calculations, quotas, and finally the variable dictionary and the exports.

| | |
|---|---|
| Respondent-facing questions | **149** (160 incl. hidden/calculated/info) |
| Question types used | 35 built-in types — every type the runtime renders |
| Variables in the dictionary | 1,165 (questions, per-option flags, calculations, hidden, List Fill, loop iterations + references, Conjoint, MaxDiff) |
| Lint | 0 issues (`lintSurveyLogic` + `lintVariables`) |
| Tests | 26 engine-level acceptance tests, 15 browser checks, 8 documented test paths |

## Where it lives

* **Generator** — `packages/templates/src/masterDemo.ts` (`@rescript/templates`, `buildMasterDemoSurvey(id)`). Deterministic: the same id gives a byte-identical definition; design files use fixed seeds.
* **Studio** — Dashboard → *New survey* → **Start from: "Master Demo — capability showcase"**. The dialog posts the full definition to `POST /api/surveys`; the server re-stamps id/code/title. Optionally pick a theme at the same time.
* **JSON** — `docs/master-demo/MASTER_DEMO_2026_v1.0.json`. Any project → *JSON* tab → *import .json* → *validate & apply*. The same file is what *export .json* produces, so it is a round-trip fixture too.
* **Companion files** — `docs/master-demo/`: variable dictionary (`.xlsx` with Variables + Loops sheets, and `.csv`), the three generated design files (`designs/*.csv|json`), `OUTLINE.md` (every group → page → question with its `[DEMO]` note) and `TEST-PATHS.md` (the engine-predicted route for every test path). Regenerate with `node scripts/master-demo-export.mjs`.
* **Tests** — `packages/templates/src/masterDemo.test.ts` (`pnpm --filter @rescript/templates test`) and `scripts/master-demo-test.mjs` (browser; needs `pnpm dev:studio` + `pnpm dev:runtime`).

Programmer commentary is in each question's **notes** (`[DEMO: …]`), in the group titles (`06_List_Fill`, `08_Loop_Demo — LOOP_001 …`) and in List Fill / calculation notes. Group and block titles are hidden from respondents (`branding.layout.showBlockTitles = false`), so they can say exactly what the programmer needs.

## Structure

```
embedded_data   PANEL_ID, SOURCE (url) · WAVE (static) · SAMPLE_TYPE (expression)
01_Introduction       consent + confirmation (terminate), age 18–100, country → region (option-level visibility), city, email, contact → phone (conditional required + regex)
02_Screening          devices (12 + exclusive None → terminate), purchase role, use type (branch driver), attention check
03_Demographics       gender, employment (skip → household page), education, income, work profile (display logic), household (cross-question validation),
                      finance products (13), dates (custom JS validation), time · QUOTA CHECK (gender, age, gender×age) · quota-cell mirror (auto-punch)
04_Technology_Usage   slider, matrix (row randomization), multi-dropdown, image select, top-3 ranking, NPS, spend (3 cross-validations), allocation, %,
                      numeric list, logical validation, wearable/smart-home (skip pattern), investments (nested AND/OR) · BRANCH consumer / business / both
05_Brand_Selection    unaided (text list), aware (12, randomized), USED (masked to aware — THE LOOP SOURCE), trusted (2–5), favourite (piped multi-select),
                      why, 5 brand grids (matrix single/multi/numeric/dropdown/text with carried rows), detail gate (skip → 11)
06_List_Fill          LF_BRAND_EVAL (priority → cap → quota → random fallback, count = min(2, used)), LF_TOPIC (random), LF_TRUST (hidden script-built source,
                      balanced targets), piped evaluation questions · LOOP_LF over the allocated items with its own references (Tier, Segment)
07_List_Operations    difference, union+dedupe, intersect, remaining, ordered (a–z), randomized pick 3, nested mask (used ∪ consider) ∩ aware, prioritize
08_Loop_Demo          LOOP_001 FOR EACH selected brand (selection order, max = LOOP_CAP) with 7 reference columns → Block 2 (10 questions) + nested LOOP_002 (features,
                      ordered by Weight desc, max 3, own references)
09_Loop_Not_Selected  LOOP_003 FOR EACH NOT-selected brand (random, max 3) → Block 3; a whole question text from a reference (Reason_Prompt)
10_Loop_Invalid       LOOP_004 filter "invalid" (invalidIf: loop.Market_Status = 'exited') · LOOP_005 items defined by a script (years used > age) via a `variable` source
11_Loop_Count         LOOP_006 FOR i = 1 TO N_PRODUCTS (1–5)
12_Randomization      anchors, rotate, reverse_half, pick 5 of 12, conditional (under-35 only), grouped, experiment arms A/B, RANDOMIZER showing 2 of 3 blocks
13_Calculations       read-only expression cells, {{calc.X}} piping, conditional required, weighted score → text segment, 5 auto-punch patterns
14_Validation         exact 3, regex, count() logic, text length, composite date pair with custom JS validation
15_Conjoint           CBC (4 attributes, 3 alts + None, 8 tasks + holdout, 2 versions) shown to decision-makers; follow-ups
16_MaxDiff_and_Custom MaxDiff (12 items, 5/task, 9 tasks, 2 versions), ranking follow-up, LOOP_007 over a custom design (statements as references)
17_Specialised        §40 multi-column composite (single/multi/dropdown/text/numeric), constant-sum grid, repeating group, hotspot, annotation, image ranking,
                      upload, media timeline, adaptive question, swipe + stars variants
18_Open_Ends          piped / conditional / ranking-piped open ends
19_Final              survey satisfaction, recontact → email (conditional required), comments · END complete (piped) · END screened · END quota_full
```

## "This is how I …" index

| I want to see how to… | Look at |
|---|---|
| create a multi-select with 10+ options and an exclusive None | `q_aware` (BRANDS_AWARE), `q_devices`, `q_fin_products` |
| terminate / screen out | `q_consent`, `q_confirm`, `q_devices` skip rules → `end_screened` |
| skip to a page / a group | `q_employment` (→ `p_demo_household`), `q_detail_interest` (→ `sec_11_loop_count`) |
| write display logic (simple, AND, OR, nested) | `q_industry`, `q_company_size`, `q_smarthome_sat`, `q_invest` |
| branch on several variables | `br_use_type` (USE_TYPE × EMPLOYMENT) |
| pipe an answer, a multi-select, a ranking, a calculation | `q_fav_why`, `q_fav_brand` (`{{BRANDS_USED.labels|and}}`), `q_oe_rank_first`, `q_calc_confirm` |
| carry options forward (into options / rows) | `q_trusted`, `q_fav_brand`, `q_brand_agree` … |
| use list operations | `q_curious` (difference), `q_consider` (union + dedupe), `q_core_brand` (intersect), `q_never_seen` (remaining), `q_sorted_pick`, `q_random_three`, `q_masked` (nested mask), `q_prioritized` |
| configure a priority + cap + quota-aware List Fill | `listFills[lf_brand_eval]` — A p1 max 150, B p2 max 75, C p3 max 50, D/E fallback |
| pipe List Fill results and loop over them | `q_lf_sat_1/2`, `loop_lf` |
| repeat a block for each selected option | `loop_001` (source `q_used`, filter selected) → `blk_08_block2` |
| repeat for NOT-selected / invalid / count | `loop_003`, `loop_004` (+ `loop_005` script-defined), `loop_006` |
| pipe CURRENT_ITEM / CURRENT_ITEM_CODE / LOOP_INDEX / LOOP_COUNT | `q_l1_familiar`, `q_l1_freq`, `q_l6_type` |
| create reference columns inside a loop and use them | `loop_001.references` (7 columns); `q_l1_sat`, `q_l1_attrs`, `q_l1_smartphone` (display logic on `loop.Category`), `q_l1_category_auto` (auto-punch on a reference) |
| give two loops different reference structures | `loop_001` vs `loop_lf` vs `loop_003` vs `loop_004` — same brands, different tables |
| nest loops and address the outer one | `loop_002` inside `loop_001`; `q_l2_feature_rate` (`{{brand.label}}`, `{{feature.Feature_Group}}`) |
| combine question piping + loop piping + earlier answers (§41) | `q_l1_spend_rate` |
| randomize (options, rows, blocks, groups, conditionally, N of M) | `12_Randomization`, `q_activities`, `q_priority_rank`, `rnd_attitudes` |
| auto-punch (from an answer, a mapping, a calculation, a List Fill, loop references) | `q_auto_segment`, `q_auto_fav_mirror`, `q_auto_os_family`, `q_auto_calc_flag`, `q_auto_lf_mirror`, `q_l1_category_auto`, `q_quota_cell` |
| calculate (sum, avg, %, weighted, count, text segment) | `calculations[]` — `TOTAL_SPEND_12M`, `AVG_BRAND_RATING`, `PCT_SUBSCRIPTIONS`, `ENGAGEMENT_SCORE`, `TECH_SEGMENT`, `N_BRANDS_USED` |
| validate (range, integer, min/max/exact selections, email, regex, length, cross-question, conditional required, custom JS) | `q_age`, `q_hh_children`, `q_sub_spend`, `q_hw_spend`, `q_budget_next`, `q_exact_three`, `q_email`, `q_postcode`, `q_phone`, `q_calc_correct`, scripts `js_date_order`, `js_upgrade_window` |
| keep hidden / read-only / calculated fields | `h_*` questions (`AGE_GROUP`, `ELIGIBLE_FLAG`, `QUOTA_FLAG`, `HIDDEN_SCORE`, `LOOP_CAP`, `LF_SOURCE_LIST`, `LF_BRAND_1/2`, `LF_TOPIC`), `q_calc_summary` (expression cells), `settings.readOnly` questions |
| set quotas (percent, count, combined, soft) and enforce them | `quotas[]` + `qc_demographics` |
| write custom JavaScript (load, change, submit validation, hidden list source, loop inspection, flags) | `scripts[]` |
| configure Conjoint / MaxDiff / a custom design and its file | `designs[]` (config, seed, version, inline file); `q_conjoint`, `q_maxdiff`, `loop_007`; CSV/JSON in `docs/master-demo/designs/` |
| read the Survey Flow and Logic Flow | Studio *Survey Flow* tab (groups, blocks, loops, branch, randomizer, quota check, ends), *Logic* tab (derived decision text) and `logicFlow` in the JSON (19 nodes, 22 edges) |
| export | Studio *Variables* → *.xlsx*; *Export* → complete JSON; `docs/master-demo/` |

## Test paths (§53)

`docs/master-demo/TEST-PATHS.md` lists the answers and the route the engine predicts for each. In short:

| Path | Enter | What you should see |
|---|---|---|
| **A** | used = Apple, Google, Samsung | LOOP_001 ×3 in selection order (each with 3 feature iterations), LOOP_003 for the aware-but-unused brands, LOOP_004 for Huawei & LG, List Fill allocates 2 |
| **B** | used = Apple only | LOOP_001 ×1, List Fill count 1, second List Fill question hidden |
| **C** | 7 brands used, N_PRODUCTS = 5 | LOOP_001 capped at 6 by the hidden LOOP_CAP, LOOP_006 ×5, every list operation non-empty |
| **D** | consent = No | terminated as *screened* on page 1 |
| **E** | female, age 29, with the female / 25–34 cells full | `quota_check` ends the interview as *quota_full* |
| **F** | Apple used while Apple has 150 allocations | Apple rejected (`maximum_reached`), Samsung takes position 1 |
| **G** | 4 brands used, Samsung "40 years" at age 29 | LOOP_001 ×4, LOOP_005 ×1 (script-detected invalid entry), LOOP_006 ×3 |
| **H** | detailed evaluation = No | skip rule jumps from 05 straight to 11_Loop_Count |

In **Test Mode / preview** the 🐞 Debug panel shows the current page, section path, loop stack (loop, iteration, item, every reference value), calculated variables (incl. `LISTFILL_*`, `LOOP_*`), flags, List Fill results and quota state. `simulateRespondent()` in `@rescript/templates` is the headless equivalent used by the tests.

## Engine changes made while building it

The demo exercised paths no earlier survey had, and four things were fixed on the way (all covered by the existing 444 engine tests plus the new ones):

1. **Skip / start targets by node id** — `findStepIndexForTarget` and `findBlockStart` matched blocks and sections by *title* (`sectionPath`); a titled block could not be targeted by id. They now also match `nodePath` (ids).
2. **`advance()` finds the page being left by id** — submitting a page can insert steps before it (a List Fill decided on that submit gives a listFill-sourced loop its items). The Runner now passes `fromPageId`, so "next" cannot jump backwards.
3. **Seeded previews compute derived values** — `start({ startAt })` runs the on-submit calculations for the seeded answers, so `{{calc.X}}` and loop variables are populated when a block is previewed mid-survey.
4. **Linter accuracy** — a bare `{{NAME}}` that is a calculation, List Fill variable, loop variable or enclosing loopVar is valid at runtime and no longer reported as a missing question; an open-ended loop bounded by a literal `count.max` no longer warns about missing positional columns (the dictionary does declare them).

## Known limits worth knowing

* `filter: "invalid"` is programmer-defined (an `invalidIf` over the loop's own references, plus answer codes that match no option); it cannot read *this respondent's* selection dynamically. The demo therefore shows both the built-in filter (LOOP_004) and the script-defined pattern (LOOP_005) for respondent-specific invalidity.
* The Logic Flow is a derived, exportable view (Studio *Logic* tab) plus the `logicFlow` graph stored in the JSON; there is no graphical editor for it yet.
* `on_validate` / `on_complete` script events are not dispatched by the runtime — validation scripts use `on_submit` + `error()`.
* Conjoint / MaxDiff answers export as one JSON column (`CBC`, `MD`); the dictionary declares `CBC_TASKS` / `MD_TASKS` as the placeholder for per-task expansion.
* The media-timeline question points at a public-domain sample clip; replace `settings.mediaUrl` for a real study.

# MaxDiff audit and P1 fixes — 2026-10-17 (MD-P1)

Engineer M. Scope: the MaxDiff (best–worst scaling) path end to end — design generation
(`packages/designs/src/maxdiff.ts`), storage and version assignment
(`packages/engine/src/designVersion.ts`), the respondent task (`packages/renderer/src/QuestionRenderer.tsx`
`DesignTasks`), validation (`packages/engine/src/validate.ts`), the data dictionary and flatten
(`packages/engine/src/{variables,flatten}.ts`), exports (`packages/exporters`, the Studio responses
route), the analysis (`packages/analytics/src/analyses/choice.ts` `maxdiff`,
`packages/analytics/src/stats/choice.ts`) and the Studio design panel
(`apps/studio/components/studio/DesignsPanel.tsx`). Every number below was measured by running the code.

## 1. Current state before this work (with evidence)

**Architecture (sound, kept).** The configuration lives in the design's `config`; the design is generated
once by `@rescript/designs` (deterministic from `(config, seed)`), and the rows, seed and summary are
stored on the survey (`DesignReference.file`, `DesignsPanel.tsx` `attach`) — pinned, not regenerated per
render. The respondent's version is DERIVED from the response seed (`designVersionFor`:
`1 + hash(seed, questionId) mod versions`); the seed is persisted with the session
(`apps/runtime/lib/session.ts`, `api/session/start`), so the version is stable across pages, Back,
reload and resume. On-screen order is rolled per respondent per task from the same seed
(`shuffleAlternatives`), so Back does not reshuffle.

| Area | Status | Evidence |
|---|---|---|
| Item exposure balance | implemented | greedy least-shown construction; measured exact on 4 of 5 configs (table §4) |
| Pair (co-occurrence) balance | **incomplete** | greedy tie-break only; (8,4,6,1): 4 of 28 pairs never together, 0–2; (10,4,10,1): 3 never together, 0–3 |
| "Balanced" claim | **incorrect** | `maxdiff.ts:338` `balanced = warnings.length === 0`, and the pair warning only fired when expected per pair ≥ 2 (`:327`) — so (8,4,6,1) with 4 uncompared pairs and (10,4,10,1) with pairs 0–3 reported `balanced: true`; plugin description said it "balances … how often each pair co-occurs" |
| Pair/position diagnostics | incomplete | summary had pair min/max only; no sd, no per-version figures, no position balance |
| Position balance (file) | incomplete | (12,4,9,10) item×position 2–14 (ideal 7.5). Mitigated: the runtime re-randomises order per respondent and `_ORDER` records it |
| Reproducibility | implemented | identical rows for identical `(config, seed)` on all five configs |
| Within-task duplicates | implemented | 0 on all configs |
| Versions (generation) | implemented | global show/pair counts across versions; per-version item spread 0–1 |
| Version assignment | implemented, **not balanced** | hash of a random seed; 100 respondents / 10 versions: median max−min = 10 per version (expected 10 each), p95 = 14; 1,000 respondents: median spread 30 |
| Prohibited pairs | **missing** | no config, no enforcement |
| Target appearances per item | **missing** | tasks defaulted to ceil(3n/k); no target, no feasibility check |
| Infeasibility detection | **incomplete** | validated k ≥ 3, n ≥ k+1, unique items, express coverage; did NOT refuse e.g. 20 items × 3 tasks of 5 (5 items never shown) or non-integer sizes |
| Best-only / method choice | **missing** | always best + worst; anchored (dual-response) existed |
| Labels / instructions | **missing** | "Least"/"Most" hard-coded (`QuestionRenderer.tsx`), no instructions |
| Practice task | **missing** | — |
| best ≠ worst (renderer) | implemented, unclear | opposite radio was `disabled` — prevented silently, no message; changing your mind needed two steps |
| best ≠ worst (engine) | **incomplete** | `validate.ts:803` checked it only when `required`; an optional MaxDiff accepted best = worst |
| Data: version, per-task best/worst/anchor/order | implemented | `MD_VERSION`, `MD_T<n>_BEST/_WORST/_ANCHOR/_ORDER` (METHOD-04/14) |
| Data: XLSX export | **incorrect** | `responses/route.ts` built the XLSX rows' `state` without `seed`, so `designVersionFor(…, undefined)` returned "1" for every respondent and `_ORDER` was empty (repro: `designVersionFor(q, rows4, undefined) → "1"` always). CSV/SPSS/SAS/Stata/JSON carried the seed and were right |
| Data: long (choice) file for HB/logit tools | **missing** | only the wide layout |
| Data: item labels on BEST/WORST | missing | numeric codes without value labels |
| Estimator | implemented | aggregate conditional logit, sequential best–worst (best from the set; worst from the rest with negated features), Newton–Raphson, effects-coded (anchored: anchor as reference). Shown as "Logit utility", separately from "B−W score %" |
| Estimator validation | incomplete | tests checked recovered ORDER only, not magnitudes |
| Counts vs model labelling | incomplete | B−W % shown beside utilities with no note that it is a descriptive count; no statement that the model is pooled (no HB / individual utilities) |
| Studio controls | implemented for what existed | every `configFields` entry renders (DesignsPanel is generic); summary shown as raw JSON only |

## 2. Methodology inventory (after this work)

Configuration (`MaxDiffConfig`, all new keys optional and inert when absent):

| Option | Values | Notes |
|---|---|---|
| `items` | list | unique |
| `itemsPerTask` | int ≥ 3 | default 5 (4 when < 6 items); must leave n ≥ k + 1 |
| `tasks` | int ≥ 1 | per version; default from `appearancesPerItem`, else ceil(3n/k) |
| `appearancesPerItem` **new** | int ≥ 1 | target shows per item per version; sets tasks, or refuses tasks that cannot hold it |
| `versions` | int ≥ 1 | blocks; respondent gets one, derived from the seed |
| `balance` **new** | `greedy` \| `optimized` | absent = `greedy` (original, byte-identical); Studio default for NEW designs = `optimized` |
| `prohibitedPairs` **new** | `[a, b][]` or `{a, b}[]` | never in the same task; Studio pair-picker editor |
| `responseMode` **new** | `best_worst` \| `best_only` | |
| `anchored`, `anchorPrompt` | | dual-response follow-up (existing) |
| `bestLabel`, `worstLabel`, `instructions` **new** | text | default "Most" / "Least" |
| `practiceTask` **new** | boolean | task 0 per version, `practice` = 1; exported, not analysed, not counted |
| `itemsPerVersion` | int | express / sparse (existing) |

Algorithms: **greedy** — the original least-shown / least-paired greedy. **optimized** — the same greedy
ordering explored by depth-first search (so prohibited pairs never dead-end), then simulated-annealing
item swaps between tasks of a version (item counts unchanged by construction; objective = Σ squared pair
counts within the version and overall, plus a penalty for a never-together pair when the counts could
cover it; when prohibitions exist a "replace" move with a heavy item-count weight restores exact item
balance), then item × position assignment over all permutations (k ≤ 6). Neither is claimed optimal; no
D-efficiency is computed.

## 3. Root causes

1. The "balanced" flag was derived from the warnings list, and the pair warning had a threshold (expected
   ≥ 2 per pair) that small designs never reach — so the flag measured "nothing warned", not balance.
2. Pair balance was only a tie-break inside a one-pass greedy; nothing revisited earlier tasks.
3. The plugin interface had no way to express item pairs, so prohibitions could not be configured.
4. XLSX export rows were assembled separately from the CSV states and the `seed` field was left out;
   everything downstream derives the version from the seed and silently defaults to "1".
5. Validation of best ≠ worst was placed inside the `required` block.

## 4. Fixes and measured diagnostics (before → after)

Seed 12345; "after" = `balance: "optimized"`. Items/pairs = min–max over the whole design; per-version
pair max = the most any pair appears within one respondent's version.

| (items, per task, tasks, versions) | items before → after | pairs before (sd, never) | pairs after (sd, never) | per-version pair max | positions in file before → after | time after |
|---|---|---|---|---|---|---|
| (8, 4, 6, 1) | 3–3 → 3–3 | 0–2 (0.70, 4) | 1–3 (0.52, 0) | 2 → 3 | 0–2 → 0–1 | 9 ms |
| (12, 4, 9, 10) | 30–30 → 30–30 | 7–9 (0.63, 0) | 7–9 (0.52, 0) | 3 → 2 | 2–14 → 7–8 | 170 ms |
| (20, 5, 12, 50) | 150–150 → 150–150 | 30–33 (0.64, 0) | 30–33 (0.51, 0) | 3 → 2 | 19–39 → 29–31 | 400 ms |
| (5, 3, 4, 1) | 2–3 → 2–3 | 0–2 (0.60, 1) | 1–3 (0.60, 0) | 2 → 3 | 0–2 → 0–2 | 1 ms |
| (30, 5, 15, 300) | 750–750 → 750–750 | 102–105 (0.57, 0) | 102–105 (0.53, 0) | 3 → 2 | 122–176 → 149–151 | 1.2 s |
| (10, 4, 10, 1) | 4–4 → 4–4 | 0–3 (0.63, 3) | 1–2 (0.47, 0) **balanced** | 3 → 2 | — | 5 ms |
| (16, 4, 12, 4) | 12–12 → 12–12 | 1–4 (0.58, 0) | 2–3 (0.49, 0) **balanced** | 2 → 2 | — | 24 ms |
| (12, 4, 9, 3) + 5 prohibited pairs | — (no prohibitions) | — | 2–3, items exact 9–9, 0 violations | 2 | 1–3 | — |

For (8,4,6,1) and (5,3,4,1) a brute-force search confirms that covering every pair forces some pair to
appear 3 times (the minimum covering designs are {01,23,45,67}-structured), so 1–3 with no uncompared pair
is the better trade; the summary reports these as "near-balanced (not exact)", not balanced. Global pair
spread on large multi-version designs stays at 3 around a mean of ~32/~103 (1–3 % relative) — reported
as near-balanced.

What was fixed, in impact order:

1. **Honest diagnostics** — `measureMaxDiffDesign(rows, items, {prohibitedPairs})` measures any file
   (generated or imported): item min/max/ideal/sd, pair min/max/ideal/sd/never (prohibited pairs excluded),
   per-version spreads, item × position, prohibited-pair violations, duplicates, practice tasks, and
   sentence `lines`. Status per dimension: `exact` / `best_possible` (spread 1 with a fractional mean) /
   `near` / `uneven`. `balanced` is true only when item and pair status are exact or best_possible and
   nothing is violated. A pair-imbalance warning now fires whenever pairs are `uneven` and ≥ 1 is expected.
   Every summary says the design is not claimed optimal.
2. **Optimized algorithm** (above), default for new designs; stored configs regenerate unchanged.
3. **Prohibited pairs** — enforced in generation, verified on the rows, editable in the Studio.
4. **Infeasibility** — refused with numbers and the fix: tasks × k < items × target appearances; total
   places < items ("cannot show all 20 items even once. Use at least 4 tasks"); non-integer sizes;
   unknown/self pairs; no k-set avoiding the prohibitions (exact search); an item left with no possible
   task; an item prohibited with more than n − k others; unknown response method. A version too small to
   show every item is a warning.
5. **XLSX version bug** — the route now passes `seed`; `QualityExportRow.state.seed` is typed.
6. **best ≠ worst** — the renderer no longer disables radios: the new pick wins, the other side is
   cleared and the task shows "“X” can't be both Most and Least. It is now your Least choice — pick a
   different item for Most." The engine refuses best = worst on optional questions too.
7. **Method options** — best-only (renderer, validation "Please choose a best for task 3.", dictionary
   without `_WORST`, analysis on best choices), labels, instructions, practice task (task 0; "Practice task
   (not counted)"; "Task n of N" for the rest; skipped by the analysis).
8. **Data** — long choice file (`maxdiffChoiceRows` / `maxdiffChoiceCSV`, `format=maxdiff`, Studio Data →
   More formats → "MaxDiff choice file"); `_BEST/_WORST` carry item value labels.
9. **Analysis labelling** — notes now say B−W % is a descriptive count, not a model estimate, and that the
   logit is pooled (no HB / individual utilities). Estimator validated against planted utilities.
10. **Studio** — `DesignsPanel` shows the measured balance (verdict chip + lines + warnings) in the preview
    and under every attached MaxDiff design (measured on the fly for older/imported files); the
    item-pairs editor; mobile tap targets of 40 px for the radios.

Estimator check (`maxdiffRecovery.test.ts`; 8 items, planted utilities 1.6 … −1.2, 3 versions × 8 tasks
× 4): max |estimate − truth| = 0.10 at 300 respondents, 0.026 at 1,500; correlation > 0.995; best-only
2,500 respondents < 0.2. The raw B−W % for the same data (59, 38, 17, −3, −4, −23, −39, −46) is on a
different scale and compresses the middle — it is labelled as a count.

## 5. Data columns

Wide (CSV/XLSX/SPSS/SAS/Stata/JSON), per MaxDiff question `MD`:
`MD_VERSION`; per task `MD_T<n>_BEST`, `MD_T<n>_WORST` (absent for best-only), `MD_T<n>_ANCHOR` (anchored),
`MD_T<n>_ORDER` (item indices top to bottom = positions 1..k); practice task = `T0`. Respondent and
session are the system columns `RESP_ID`, `SESSION_ID`.

```
RESP_ID,SESSION_ID,…,MD_VERSION,MD_T1_BEST,MD_T1_WORST,MD_T1_ANCHOR,MD_T1_ORDER,MD_T2_BEST,…
R001,sess-1,…,2,2,1,some,2|4|1,2,3,some,2|5|3,…
```

Long choice file (`format=maxdiff`):

```
RESP_ID,SESSION_ID,QUESTION_ID,QUESTION,LOOP,VERSION,TASK,PRACTICE,POSITION,ITEM_INDEX,ITEM_LABEL,BEST,WORST,ANCHOR
R001,sess-1,q1,MD,,2,1,0,1,2,Camera,1,0,some
R001,sess-1,q1,MD,,2,1,0,2,4,Price,0,0,some
R001,sess-1,q1,MD,,2,1,0,3,1,Battery,0,1,some
```

## 6. Tests

- `packages/designs/src/maxdiffP1.test.ts` (23): balance bounds for the five configurations measured on
  the rows; optimized vs greedy on uncovered pairs; positions; balanced-only-when-earned; near-balanced
  wording; `measureMaxDiffDesign` on a bad imported file; reproducibility; greedy unchanged; per-version
  balance; prohibited pairs never co-occur (both algorithms, all versions); infeasibility and conflicting
  restrictions; small item sets; practice task; config surface.
- `packages/engine/src/maxdiffP1.test.ts` (8): best-only validation, unchanged wording, optional best =
  worst, practice naming; dictionary (no WORST, labels, practice); flatten per task (version, order,
  best, worst, anchor) across seeds; best-only/practice flatten.
- `packages/analytics/src/analyses/maxdiffRecovery.test.ts` (4): recovery within ±0.15; count-vs-model
  notes; best-only recovery; practice not modelled.
- `packages/exporters/src/maxdiffLong.test.ts` (5): long file vs screen order and flatten; practice /
  best-only / no-seed; CSV; wide best-only/practice/labels; XLSX version from the seed.
- `scripts/maxdiff-p1-test.mjs` (Playwright, runtime :3001): version items and order, "Task n of N",
  required, best = worst message, change selection, partial-answer message, Back, reload, flatten + long
  export from the stored state, mobile 390×844 (no page/table horizontal scroll, ≥ 36 px targets),
  completion, best-only + labels + instructions + practice. Also touching MaxDiff:
  `scripts/maxdiff-variants-test.mjs`, `scripts/demo-survey.mjs`.

## 7. Limitations

- **Version assignment is a hash of the seed** — stable and reproducible, but only balanced in
  expectation (100 respondents / 10 versions: typical spread 10). A least-filled counter needs an atomic
  server-side claim (as List Fill has) and is not done.
- No D-efficiency / statistical-efficiency figure; "balanced" means frequency balance only.
- Large multi-version designs end near-balanced on global pairs (spread 3 at ~100 per pair). Generation of
  (30,5,15,300) takes ~1.2 s, synchronously in the Studio.
- The estimator is aggregate (pooled) conditional logit; no HB / individual-level utilities. The long
  choice file is the hand-off for HB elsewhere.
- Per-respondent item exclusions (e.g. "only items the respondent uses") are not supported; exclusions
  are design-level (prohibited pairs, express subsets).
- The long file uses the current definition for every response (the wide exports honour per-response
  versions).
- The preview cannot exercise the live session resume; reload is checked through the preview's
  sessionStorage (the seed-derived version is the same mechanism).

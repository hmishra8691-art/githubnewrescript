# 05 · Research methodology matrix — Conjoint, MaxDiff, List Fill, custom setups

The stage × methodology matrix (16 stages × CBC / Menu / ACBC / MaxDiff / List Fill, each cell with status + file evidence + executed-repro reference) is in **`raw/methodologies.md` §2**, and the List Fill lifecycle table in §2.1. This page gives the per-methodology gap report the brief asks for and the extension-point analysis.

## Variants actually supported (claim only what is design + collection + analysis + tested)
| Variant | Design | Collection | Export | Estimation | Verdict |
|---|---|---|---|---|---|
| Choice-based conjoint (CBC) | balanced-overlap, seeded, prohibitions (pair + combination), holdouts, versions — verified 0 violations | all tasks on one page, per-respondent shuffle, None last | `VAR_VERSION`, `VAR_T<n>` | aggregate MNL (effects-coded, ridge) — recovered planted utilities ±0.02 on 600×8, 4 versions | **Supported (aggregate only)** |
| Menu-based / pricing configurator | per-item price balancing | menu renderer, min/max, none | item flags, NONE, TOTAL | **none** (runner expects `alt` rows) | **Collection only** |
| Adaptive CBC (ACBC) | BYO → screener → tournament state machine, prohibitions honoured | yes, full transcript | BYO/WINNER/rules/JSON | **none**; plan silently routes to `conjoint_utilities` | **Collection only**; excluded from lint/logic graph/simulate (METHOD-13) |
| Ratings-based conjoint | — | — | — | — | **Not implemented** (no variant) |
| MaxDiff (incl. express, anchored) | BIBD, exposure exactly balanced, all pairs covered — verified | best/worst radios, **no best≠worst guard** | BEST/WORST per task; **anchor never exported** | aggregate logit + count-based per-respondent B−W; **reads version-1 design for every respondent**; **crashes on best==worst** | **Supported with three P1 defects** |
| List Fill | n/a | destinations/piping | `LISTFILL_*` | n/a | **Supported in-engine**; DB atomicity unverified here; empty-source bug; five inert settings |
| TURF, pricing (Van Westendorp/Gabor-Granger), segmentation | — | — | — | — | not present (registry comment mentions TURF/pricing as future) |

## A. Conjoint gap report
- Design: no D-efficiency or two-way balance (Brand×Price cells 9–23 on a one-way-balanced design); diagnostics computed then **discarded on attach** (`DesignsPanel.tsx:233–244`, `DesignReference.file` has no `summary`) — METHOD-05.
- Restrictions: pair + combination prohibitions honoured; infeasible sets refused. Menu has no restrictions.
- Respondent burden: task count configurable; no per-task paging; no burden heuristic.
- Analysis: part-worths with SE/p, importance (range share), logit shares, WTP via price slope, holdout hit rate, McFadden R². No HB, no individual utilities, no interactions, no latent class, no segment cuts (METHOD-07). Simulator = raw JSON textarea.
- Intelligent Mode: `conjoint.cbc` shell only; no `create_design` (METHOD-08).
- Limitations are documented in table notes (good).

## B. MaxDiff gap report
- Required validation accepts best==worst, partial task sets, out-of-set codes — **browser-verified** (METHOD-01, P1).
- Analysis uses version 1 rows for all respondents — 27% of choices dropped on 4 versions (METHOD-02, P1).
- One best==worst answer → whole analysis "not computable" (METHOD-03, P1).
- Anchor answers never exported (METHOD-04); shown position not exported (METHOD-14); descriptive B−W score vs model-based logit are both present and labelled; no HB.
- Intelligent Mode: shell only.

## C. List Fill gap report (meaning preserved)
List Fill here = **sample-level allocation of list items (e.g. brands) to respondents under priority/caps/quotas**, with the allocation written into calculated `LISTFILL_*` variables, piped into destination questions, and claimed atomically in Postgres (`listfill_allocations`/`listfill_counts`, advisory lock). Verified in-engine: priority/cap sequence, determinism per seed, quota blocking, simulator, dictionary. Gaps: empty source never runs so `whenUnused:hide` is dead — **browser-verified** "How do you rate ?" (METHOD-09); no reconcile job for abandoned sessions although docs/schema say so (METHOD-10); `afterMaximum`, `fallback`, `fillToCount`, `allowDuplicates`, `weighted` are stored but inert and the SQL claim fills to `p_count` regardless (METHOD-11); `count: expression`, `source: script`, `method: custom` are schema-only (METHOD-12); DB claim/release paths UNVERIFIED (declared Postgres suite `scripts/listfill-allocation-test.mjs` not runnable here).

## D. Custom research setups — how a new methodology is added today
The registry (`packages/designs`) covers **design generation only**. A methodology needs ~12 hand-wired touch points: schema type union + variants, renderer, `validate.ts`, flatten/export, variable dictionary, lint (design-ref), `analysisFramework`, analytics `RUNNERS`/`COMPLEX_TYPES`, simulate, Studio panels, AI prompt `ACTION_TYPES`, copilot review. ACBC is the realised risk (present in 7 of 12). Recommendation: a per-method capability object (`{kind, schema, generate, render, validate, flatten, variables, analyse, lint, aiActions}`) registered once, plus a **registry-completeness test** that fails when a kind is missing from any touch point.

Per-methodology record (status / schema / builder / runtime / response shape / validation / AI / cleaning / analytics / export / tests / missing / effort) is tabulated in `raw/methodologies.md` §1–§3; effort: MaxDiff P1 fixes S (≤1 day each); design-op for AI M; ACBC/menu estimator L; HB L; geo/TURF out of scope.

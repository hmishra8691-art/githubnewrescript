# Conjoint audit — 2026-10-17

Scope: CBC, menu-based (MBC / pricing configurator) and ACBC, from configuration to analysis: design generation, runtime, validation, export and estimation. Engineer C. MaxDiff and List Fill belong to other workstreams and are mentioned only where they share code with conjoint.

Every number below comes from code that was run. The scripts are in `docs/conjoint-audit-2026-10-17/`:

| Script | What it measures |
|---|---|
| `measure-designs.mjs [balanced\|efficient]` | Level balance, overlap, duplicate concepts, prohibited concepts, D-efficiency (pooled and per version), two-way balance and reproducibility for 6 configurations. Output is in `measure-*.out.txt`. |
| `recovery.mjs` | 900 simulated respondents with known part-worths, run through the platform's own path (stored answers → `buildDataset` → `runAnalysis("conjoint")`), plus an example of the stacked export. Output is in `recovery.out.txt`. |

## 1. Methodology inventory

| Method | Configuration | How it runs | Status |
|---|---|---|---|
| **CBC** (`conjoint_task` with a `conjoint` design) | Attributes and levels; prohibitions (pairs, pair AND/OR further levels, `when` trees); tasks; alternatives; None option with its own text; holdout tasks; versions; **design method** (`balanced` or `efficient`, new) | The design is generated once and pinned in the definition (`designs[].file.rows`, with `summary`). The version comes from `hash(seed, question)`. Alternative order is rolled per respondent and task, with None last. The answer is `{task: design alt}`. | Implemented. Fixes are listed in §4. |
| **Menu-based** (`conjoint_task` with a `menu` design; the pricing configurator is a preset of it) | Items with price points; required (base) items; min and max selections; None; currency | Every task shows the whole menu at that task's prices. The answer is `{task: [items] \| ["none"]}`. | Generation, runtime and wide export are implemented. The analysis reports take-rate counts, labelled as counts (new). There is no choice model. |
| **ACBC** (`acbc_task` with an `acbc` design) | Attributes, prohibitions, screening and tournament sizes | It is genuinely adaptive: BYO → concepts near the BYO → unacceptable and must-have rules → tournament (engine `acbc.ts`). The full transcript is stored. | Runs reliably. Combination prohibitions are fixed (§4). There is no estimator, and the analysis now says so instead of analysing another question. |
| Rating- or ranking-based conjoint, alternative-specific (labelled) designs | — | — | Missing (§7) |

## 2. Audit table: current state with evidence

Status key: **impl** = implemented and verified; **incomplete**; **incorrect** = wrong result reproduced; **missing**. "→ fixed" means the defect is fixed in this change.

| # | Area | Status | Evidence |
|---|---|---|---|
| A1 | Prohibited concepts generated | impl | 0 in every run (`measure-*`, B). Pair and combination prohibitions, both methods, 12 seeds each: 0 (`designs/conjointP2.test.ts`). |
| A2 | Infeasible prohibitions reported | impl | `validateConfig` rejects a level that no legal concept can carry, and a legal space smaller than the alternatives per task (`conjoint.ts` validate; test "infeasible…"). |
| A3 | **Infeasible concept space with no prohibitions** | incorrect → fixed | With 2×2 levels and 5 alternatives, `validateConfig` returned `[]` and generate produced task 1 = `a1b2,a2b1,a1b1,a2b2,a2b1` (4 unique of 5) with no error. Now: "These attributes make only 4 different concepts…". Both validate and generate refuse it. |
| A4 | **Attribute named `task` / `version` / `alt` / …; duplicate or blank levels; 2.5 tasks** | incorrect → fixed | All four passed validation. An attribute called "task" overwrote the task number in every row (`{...profile}` after `task`). All four are now refused with a message. |
| A5 | One-way level balance | impl | Pooled 120..120 for every attribute, and 0 spread per version (A1). Mixed levels (E): 266..267. |
| A6 | Overlap / duplicate concepts in a task | impl, **mislabelled → fixed** | 0 duplicate concepts. Avoidable overlap is 0% when levels = alternatives (A1–D) and 13.6% with mixed levels and 4 alternatives (E; efficient: 0%), but the generator was *described* as "Balanced-overlap", a Sawtooth method that repeats levels on purpose. The description now says "level-balanced, minimal overlap". |
| A7 | **D-efficiency** | missing → fixed | Not computed anywhere. Now `summary.efficiency` reports main-effects MNL D-efficiency at β=0, relative to the Street–Burgess bound (`conjointEfficiency.ts`), pooled and per version. Sanity tests: an optimal foldover gives 1.000, and an attribute that never varies inside a task gives 0. |
| A8 | Per-version efficiency (what one respondent answers) | incomplete → fixed | Balanced: per-version mean **85.5%**, worst 76.8% (A1); 80.4% / 67.8% with a prohibition (B). The new `efficient` method (Huber–Zwerina level swapping, which keeps every level's count) gives **99.0% / 98.4%** and **95.2% / 94.1%**. |
| A9 | Version too short to identify the model | missing → fixed | 3 tasks × 3 alternatives give 6 degrees of freedom for 8 part-worths, so per-version D-efficiency is 0. The summary now carries a warning and the minimum task count. |
| A10 | Reproducibility | impl | Same (config, seed) gives identical rows; a different seed gives a different design (both methods). A config without `method` regenerates exactly as before (test). The efficient method's work is bounded by an evaluation count, not a clock. |
| A11 | Design stored / pinned | impl | The design is generated once in the Studio and stored in `designs[].file` with `summary`. It is not regenerated per render. |
| A12 | Diagnostics shown | incomplete → fixed | The summary appeared only as raw JSON in the preview `<pre>`. Now a "Design quality" card shows the preview, and a one-line summary on every attached CBC design shows D-efficiency, balance, overlap, what prohibitions cost, the optimisation, and warnings (`ConjointDesignQuality.tsx`). |
| B1 | Version assignment | impl, not controlled | `designVersionFor` = hash(seed, q). It is stable across Back, resume and export. Balance is only random: 10 versions × 300 respondents → 22..38 (expected 30); × 1000 → 84..114. |
| B2 | **Preview reload re-seeded** | incorrect → fixed | The preview snapshot (sessionStorage) restored answers but not the seed. A reload drew a new seed, so the restored `{task: alt}` landed on another version's concepts in another order. The seed is now stored and restored (`Runner.tsx`, `resume.ts`; test in `resume.test.ts`). Live and test sessions already used the DB seed. |
| B3 | Alternative identity under position randomisation | impl. Label **incorrect → fixed** | The stored value was already the design `alt`. The label printed the design number, so a shuffled task read "Option 3, Option 1, Option 2". It is now Option A/B/C by screen position, while the value stays the design alternative. Rows carry `data-alt`, `data-position` and `data-task`. |
| B4 | None option | impl | It is a design row with `none_option = 1` and `alt = m+1`, shown last. Its text now comes from `config.noneLabel`. It is recorded as `alt = m+1`, and the stacked export writes it as a row with `none = 1`. |
| B5 | **Validation of a stored CBC choice** | incomplete → fixed | Only "every task answered" was checked. Any value was accepted, including an alternative of another version, a forged code, or an answer to an optional question. Now a choice must be an `alt` of that task in the respondent's own version (`validate.ts`). |
| B6 | Mobile | incomplete → fixed | Alternatives were table rows with attribute columns inside a horizontal scroller. At 390px it is now one card per alternative (`rs-matrix-stack`), each level captioned with its attribute through CSS `::before` (the text stays clean), with a "Choose" tap target and None as a single line. |
| C1 | Wide export | impl, incomplete → fixed | `VAR_VERSION` and `VAR_T<n>` (design alt) were exported. The shown order was not exported for CBC; `VAR_T<n>_ORDER` is added (design alternatives top to bottom). |
| C2 | **Version without a seed** | incorrect → fixed | `flattenVariables` on a state with no seed hashed the question id alone, so every respondent got the same invented version. The XLSX route passed no seed: the route was fixed concurrently, and the flatten guard is added here. Now no seed means no version or order. A numeric-string seed (bigint from the DB) is accepted. |
| C3 | **Stacked (long) design + choice file** | missing → fixed | `stackedChoiceData` (engine), `choiceDataToCSV` (exporters), `GET …/responses?format=cbc`, and a Data → More formats button. One row per respondent × task × alternative shown: version, task, holdout, alt, concept_id, position, none, chosen, levels and level codes. A response without a seed is skipped and counted in the `x-rescript-cbc-skipped-no-seed` header. |
| D1 | Estimator | impl | Aggregate conditional logit, effects-coded, Newton–Raphson, with a None constant (`stats/choice.ts`). Recovery at n=900, 6 versions, 12 tasks (§5): every part-worth is within 0.05 of the planted value, the None constant is −0.791 vs −0.800, and it converged in 4 iterations. |
| D2 | Importances / simulator / WTP | impl | Importance = part-worth range share (Price 45.6% vs 44.7% planted). The simulator uses logit share of preference (best/worst/None, or JSON scenarios). WTP comes from the price-level slope. |
| D3 | Counts vs model | incomplete → fixed | No counts table existed. A "Counts — choice share of each level (raw, not a model)" table was added (it goes last, so the model's tables keep their indices). The part-worth table is titled "aggregate multinomial logit", and the fit table names the model. |
| D4 | **ACBC / menu analysis** | incorrect → fixed | A plan item naming the ACBC question fell back to *another* `conjoint_task` (`questionIdFor`). A menu question gave "Only 0 choice tasks answered". Now ACBC is refused in words (no estimator; the transcripts are in `_JSON`), and a menu question gets take rate by item × price, labelled as counts. |
| D5 | Level order in output | incorrect (cosmetic) → fixed | Levels appeared in first-appearance order ("$30, $10, $20"). They now follow the configured order. |
| D6 | HB / latent class / interactions | missing (out of scope) | Only an aggregate model exists. The UI says "not individual-level". |
| E1 | **ACBC combination prohibitions** | incorrect → fixed | The engine read only `a + b`, so "never Zen at $399 AND 20 h" forbade every Zen-at-$399 concept. A `when`-only rule crashed `acbcPlugin.validateConfig` on `p.a.attribute`. Both now use the CBC semantics (`acbcProhibited`; test). |

## 3. Root causes

1. **The generator validated only when prohibitions existed.** Every feasibility check lived behind `if (c.prohibitions.length)`, so with no prohibitions a too-small space and colliding column names went straight to generation (A3, A4).
2. **The design's quality was asserted, not measured.** The label said "balanced overlap", and no efficiency metric existed. The two-way balance added in P2 measures one confound, not information. Without D-efficiency there was no way to see that per-version efficiency was 85% while pooled was 99% (A6–A9).
3. **The respondent's seed is the key to the version and order, but it was optional at the edges.** Flatten guessed when it was missing (C2), and preview resume dropped it (B2). Everything else (renderer, validation, export) already derived from it correctly.
4. **The display and storage of an alternative used the same number.** The value is right (the design alternative). Printing it as the label made randomisation visible and confusing (B3).
5. **Analysis routing chose a question by type, not by name.** That is fine for one CBC per survey; it is wrong for ACBC and menu (D4).
6. **One prohibitions editor feeds two engines.** The ACBC engine had its own, older reading of the shape (E1).

## 4. Fixes, in impact order

1. **Feasibility and naming** (`designs/conjoint.ts`): validate always; refuse a concept space smaller than the alternatives per task, reserved column names, duplicate or blank levels, non-integer counts, and an unknown method. Generate never emits a duplicate concept. It throws, whether or not prohibitions exist.
2. **Stacked export and identity** (`engine/choiceData.ts`, `exporters/choiceExport.ts`, route `format=cbc`, DataPanel button). Also `VAR_T<n>_ORDER` for CBC (`flatten.ts`, `variables.ts`), and no invented version without a seed.
3. **Preview reload keeps the seed** (`Runner.tsx`, `resume.ts`).
4. **CBC answer validation** against the respondent's own version (`validate.ts`).
5. **Analysis honesty** (`analytics/analyses/choice.ts`): a named ACBC is refused in words, a menu gets take-rate counts, a counts table is added, the model is labelled, and levels follow the configured order.
6. **Efficient design method + D-efficiency** (`designs/conjointEfficiency.ts`): `method: "efficient"` is the default for new designs in the Studio form. A stored config without `method` stays `balanced` and regenerates identically. The summary reports `efficiency`, `optimisation` and the identifiability warning.
7. **Design quality in the Studio** (`ConjointDesignQuality.tsx`, two anchored lines in `DesignsPanel.tsx`). A `select` config field now shows its help.
8. **Runtime labels and mobile** (`QuestionRenderer.tsx` CBC branch, `styles/questions.css`): Option A/B/C by position, configurable None text, phone cards with captioned levels, data attributes for tests.
9. **ACBC combination prohibitions** (`engine/acbc.ts`, `designs/acbc.ts`).
10. Claims: README ("balanced overlap" → what it is) and Studio docs (`data-and-exports.md`: `_ORDER`, `format=cbc`).

## 5. Diagnostics before / after

These are the design-quality numbers from `measure-*.out.txt` and `recovery.out.txt`.

| Config (3 alternatives per task unless noted) | Method | Per-version D-eff (mean / worst) | Pooled D-eff | Avoidable overlap | Duplicates | Prohibited | Time |
|---|---|---|---|---|---|---|---|
| 4×3 levels, 12 tasks, 10 versions | balanced (before) | 85.5% / 76.8% | 98.6% | 0% | 0 | 0 | 52 ms |
| same | **efficient** | **99.0% / 98.4%** | 99.9% | 0% | 0 | 0 | 0.2–0.8 s |
| 4×3, 12 tasks, 300 versions | balanced | 86.0% / 74.2% | 100.0% | 0% | 0 | 0 | 0.4 s |
| same | efficient (budget-limited) | 96.3% / 92.0% | 98.6% | 4.1% | 0 | 0 | 1.6 s |
| + prohibition Gamma × 3 days, 10 versions | balanced | 80.4% / 67.8% | 92.7% | 4.6% | 0 | 0 | — |
| same | efficient | 95.2% / 94.1% | 96.2% | 0.4% | 0 | 0 | — |
| 3×4×2×5 levels, 4 alternatives, 10 tasks, 20 versions | balanced | 83.0% / 79.3% | 96.1% | 13.6% | 0 | 0 | — |
| same | efficient | 99.4% / 99.0% | 100% | 0% | 0 | 0 | 0.5–0.9 s |
| Reference: random legal design, 4×3, 12 tasks | — | 56.8% | — | — | — | — | — |

At 300 versions, the efficient method trades 1.4 points of pooled efficiency for 10 points per version, because each version stops at its share of the 200 000-evaluation budget. Both numbers are on the design summary. One-way level counts are identical under both methods (test).

**Estimator recovery** (`recovery.out.txt`): 900 respondents, 6-version efficient design, 12 tasks, None, Gumbel errors.

| Attribute | Level | Planted | Estimated |
|---|---|---|---|
| Brand | Alpha / Beta / Gamma | 0.50 / 0.00 / −0.50 | 0.508 / −0.051 / −0.457 |
| Screen | 5in / 6in / 7in | −0.30 / 0.10 / 0.20 | −0.289 / 0.115 / 0.174 |
| Battery | 1 / 2 / 3 days | −0.60 / 0.10 / 0.50 | −0.569 / 0.101 / 0.468 |
| Price | $199 / $299 / $399 | 1.00 / 0.10 / −1.10 | 0.989 / 0.085 / −1.074 |
| None constant | | −0.800 | −0.791 |
| Importance | Price / Battery / Brand / Screen | 44.7 / 23.4 / 21.3 / 10.6% | 45.6 / 22.9 / 21.3 / 10.2% |

Fit: McFadden R² 0.278, hit rate 60.4%, None chosen 9.1%, converged in 4 iterations. The unit test asserts every level within 0.10, importances within 3 points, the None constant within 0.12, and simulated shares within 3 points of the true logit shares.

## 6. Example stacked export

Respondent R0, version 1, first two tasks (`format=cbc`):

```
respondent,session_id,question,version,task,is_holdout,alt,concept_id,position,none,chosen,Brand,Screen,Battery,Price,Brand_code,Screen_code,Battery_code,Price_code
R0,s0,CBC,1,1,0,3,1-1-3,1,0,0,Alpha,7in,3 days,$399,1,3,3,3
R0,s0,CBC,1,1,0,2,1-1-2,2,0,0,Beta,6in,2 days,$299,2,2,2,2
R0,s0,CBC,1,1,0,1,1-1-1,3,0,1,Gamma,5in,1 day,$199,3,1,1,1
R0,s0,CBC,1,1,0,4,1-1-4,4,1,0,,,,,0,0,0,0
R0,s0,CBC,1,2,0,3,1-2-3,1,0,0,Beta,6in,2 days,$399,2,2,2,3
R0,s0,CBC,1,2,0,1,1-2-1,2,0,1,Alpha,5in,3 days,$299,1,1,3,2
R0,s0,CBC,1,2,0,2,1-2-2,3,0,0,Gamma,7in,1 day,$199,3,3,1,1
R0,s0,CBC,1,2,0,4,1-2-4,4,1,0,,,,,0,0,0,0
```

How to read it:
- `alt` is the design alternative, which is what the answer stores.
- `position` is where this respondent saw the alternative.
- In task 1 the chosen concept (`alt 1`) was shown third.

## 7. Limitations (not done, by decision or scope)

- **Version assignment is random, not controlled** (B1). Least-filled assignment needs an atomic server-side counter like List Fill's claim. It is a migration plus an RPC, outside this change.
- **No HB, latent class, interactions, or a menu or ACBC choice model.** Menu gets counts. ACBC is refused with a pointer to its transcripts.
- **Missing configuration features from the brief:**
  - level display labels, descriptions and images
  - alternative names, descriptions and images (labelled or alternative-specific designs)
  - numeric level types (price as a linear term)
  - profile constraints beyond prohibitions (for example "price rises with tier")
  - fixed or mandatory attributes
  - per-respondent attribute order randomisation
  - dual-response None
  - rating- and ranking-based conjoint
- **Holdout tasks** are generated per version, not fixed across respondents.
- **Simulator** scenarios are still a JSON option, not an interactive tool.
- **Efficient method:**
  - It optimises at β=0, a standard and prior-free choice. It does not use Bayesian priors.
  - Above about 40 versions it stops at a work budget. The summary reports `versionsStoppedAtBudget`.
- **Stacked export** covers plain (non-loop) CBC answers. Loop-suffixed CBC answers are not included.
- **Back-compat notes:**
  - The wide export gains `VAR_T<n>_ORDER` columns for CBC.
  - The CBC option label changes from the design number to a position letter.
  - Stored answers, existing designs and the regeneration of configs without `method` are unchanged.

## 8. Tests

| Suite | Added |
|---|---|
| `packages/designs/src/conjointP2.test.ts` | 11 tests: no prohibited concept; no duplicate in a task; balance bounds and counts preserved by swapping; efficient ≥ 97% per version; reproducibility; back-compat without `method`; versions, holdouts and None; infeasibility messages; D-efficiency sanity; editor fields; identifiability warning |
| `packages/engine/src/conjointP2.test.ts` | 5 tests: stacked rows by design alternative and position; unanswered tasks and no-seed responses; `_ORDER` and no invented version; validation against own version; ACBC combination prohibitions |
| `packages/engine/src/tasks.test.ts` | CBC dictionary expectation now includes `_ORDER` |
| `packages/analytics/src/analyses/conjointRecovery.test.ts` | 3 tests: MNL recovery, importances, None and shares; counts labelled; menu counts and ACBC refusal |
| `packages/exporters/src/choiceExport.test.ts` | 2 tests: stacked file (4 versions, None), agreeing with the wide `_ORDER`; no-seed skip |
| `apps/runtime/lib/resume.test.ts` | Preview snapshot carries the seed |
| `scripts/conjoint-p2-test.mjs` (browser) | Version, order and levels on screen; no prohibited concept; Option A/B/C; required; choose and None; stored value = design alternative; Back; reload keeps the seed and choices; stacked export matches the clicked levels; mobile 390×844 cards with no horizontal scroll; completes |

Run in a browser (runtime on :3001):
- `node scripts/conjoint-p2-test.mjs`
- and the existing `node scripts/wave4-test.mjs`, `scripts/menu-conjoint-test.mjs`, `scripts/acbc-test.mjs`, `scripts/chain-test.mjs`, `scripts/master-demo-test.mjs`, `scripts/remaining-items-test.mjs` (the Studio on :3000 where they need it)

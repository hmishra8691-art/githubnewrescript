# Conjoint suite — ACBC, menu-based, rating-based (CVA), dual-response None, brand-specific CBC, one simulator (2026-10-22)

Engineer F4. Weakness #9 of the platform audit: before this change CBC had an efficient design, an aggregate MNL and HB (as a job); menu-based conjoint was counts only; ACBC was a design with no estimator; there was no rating-based conjoint and no dual-response None. Every number below was produced by code that was run (tests in §9); the synthetic studies have known parameters and answer the platform's own designs, runtime state machine and storage format.

No migration: everything runs on the existing tables (designs and answers live in the survey definition and the response JSON; HB uses the 0066 job table). Number 0072 is unused.

## 1. What exists now

| Method | Design | Respondent task | Estimation | Simulator | Intelligent Mode |
|---|---|---|---|---|---|
| CBC | efficient / balanced (unchanged) | unchanged | aggregate MNL; HB (job) | **logit, first choice, randomized first choice; revenue / profit, WTP, demand, sensitivity, optimisation, segments** | create / update (unchanged) |
| CBC + **dual-response None** | `dualResponseNone` (forced-choice rows, no None row) | choice, then "Would you actually buy it?" (`<task>_buy`) | **three codings**: dual (Sawtooth default), single-task None, forced only — aggregate and HB | None from the estimated constant | `dualResponse: true` / `none: "dual"` |
| **Brand-specific / labelled CBC** | `brandAttribute`, `alternativeSpecific` ("5G: Alpha, Beta"), `labelled` | "—" where an attribute does not apply; labelled options named by brand | not-applicable cells coded as zeros; aggregate and HB | products may omit non-applicable attributes | `labelled`, `alternativeSpecific`, `brandAttribute` |
| **ACBC** | unchanged + optional **summed price** (base + per-level increments, ±variation) | unchanged; prices on concepts, BYO increments and running total | **BYO + screening vs threshold + implied rule screens + tournament in one MNL**; aggregate (quick look) + counts; **HB** (job) | threshold as None, linear price | `priceBase`, `priceIncrements` |
| **Menu-based** | unchanged + optional **exclusive sections** | sections behave as one-of | **buy-anything logit, item binary logits with own + selected cross prices, section MNL**; aggregate and **HB** | **take rates, revenue, what-if prices, price curves, bundles** | `exclusiveGroups`; `simulate_conjoint` (prices, bundles) |
| **Rating-based (CVA)** | **new generator** `cva`: D-optimal fractional factorial per version, single or paired, holdouts | **new renderer**: profile(s) + 0–10 (or 1–9 pairs) scale | **per-respondent OLS**, optional monotone ties, R², flat / poor-fit flags, holdout validation | first choice, BTL, logit | `method: "cva"` (rating, full-profile …) |

## 2. ACBC estimator (`packages/analytics/src/conjoint/acbc.ts`)

Coding (Sawtooth ACBC/HB): effects coding per attribute (levels in configured order, part-worths sum to zero), a **threshold** parameter (the "None" of screening), and — with a summed price — **one linear price term** `x = (price − reference) / unit` (reference = middle of the list-price range, unit = half of it; reported per currency unit too).

| Section | Choice sets |
|---|---|
| BYO | one per attribute: its levels, each with its price increment (so price trades off in the BYO) |
| Screening | each judged concept vs the threshold: "a possibility" = concept, "won't work" = threshold |
| Rules (option `acbcRules`, default on) | confirmed unacceptable level → the BYO with that level rejected vs the threshold; confirmed must-have → the BYO with each other level of that attribute rejected |
| Tournament | each round's concepts (with their varied prices) |

The same sets feed `conditionalLogit` (kind `conjoint`: part-worths, threshold, price, importance including price, **fit by stage**, a **counts** quick look) and HB-MNL (kind `hb`, chunked job): `hb_mean` with the threshold as None and the summed price at the two ends of the shown range, `acbc_price` (population and median per-unit slope, respondents with a positive slope), individual utilities, RLH, R̂/ESS/Geweke.

Summed price in the interview (`packages/engine/src/acbc.ts`): `priceBase`, `priceIncrements` ("Brand: 0, 50, 120"), `priceVariation` (±%, default 30), `priceRound`, `priceCurrency`. Concept prices come from their **own seeded stream**, so the concepts a respondent sees are exactly those of the same design without a price (tested); without a summed price no `price` key is ever written.

## 3. Menu-based model (`conjoint/menu.ts`)

Sawtooth MBC's two-stage specification, as one parameter vector:

- **Buy anything** (when "buy nothing" was offered and used): binary logit on a constant, each always-included item's price and the optional items' mean standardised price. (An item-by-item buy model left the individual-level HB unidentified — one yes/no per menu cannot carry a slope per item; measured R̂ 1.24 → 1.08.)
- **Each optional item**, given they buy: binary logit on a constant, its own price (linear or part-worth per price point, option `menuPriceCoding`) and **selected cross prices**. `crossEffects: "auto"` (default) fits every other item's price and keeps |z| > 2.576 (p < 0.01, strict because the candidates are many); a list names pairs; `"none"` drops them.
- **Each exclusive section**: a multinomial logit over its items and "none of the section", with constants and own-price slopes.

Prices are standardised per item (middle and half-range of the tested prices). The counts table stays first and unchanged; the model, the cross-effect tests, observed-vs-predicted fit, the **menu simulator** (take rate = P(buy) × P(item | buy), revenue per respondent), and **price curves** per item (take rate, item and whole-menu revenue, the revenue-maximising price within the tested range) follow it. **Bundles**: a bundle at one price is valued as the sum of its items' price-free utilities plus the bundle price on the items' price-weighted slope; each simulated respondent (seeded logistic errors, so à-la-carte choices match the logit) takes it when that beats à la carte. This is an **assumption**, said in the bundle table — no bundle-specific effect is measured. HB uses the same sets (a binary logit is a two-alternative MNL), and its simulator runs on individual posterior means.

## 4. Rating-based conjoint — CVA (`designs/src/cva.ts`, `conjoint/cva.ts`, renderer `cvatasks`)

Design: candidate set = the legal full factorial (≤ 20,000; else a seeded legal sample), a level-balanced start, then Fedorov-style exchange maximising det(XᵀX) of the main-effects linear model (√l-scaled orthonormal contrasts, so an orthogonal balanced design scores 100%, SAS %MktEx convention); pairs are coded as differences and scored against the most a difference can carry, 2l/(l−1). Budget is an evaluation count, so (config, seed) reproduces the design. Holdouts are identical in every version. Default profiles ≈ 1.5 × (parameters + intercept); the validator refuses fewer than the parameters.

Estimation per respondent: single profiles `rating = b0 + Σ u(level)`; pairs `rating − midpoint = Σ u(right) − u(left)`; OLS with a negligible ridge; **monotone** (option `monotone` / design `monotone` lines): the adjacent pair breaking the order most is tied and the model refitted until none breaks it (Sawtooth's tying). Flags: flat rater (no utilities), low variance, poor fit (R² < 0.3), too few ratings; `excludeFlagged` leaves flagged respondents out. Tables: importance (mean of individual), part-worths (mean, SD, normalised), fit (R² distribution, flags), holdout validation (correlation, MAE; pairs: side predicted), individual utilities, simulator (default first choice; BTL; logit). HB is refused in words for CVA — it is not a choice model and every respondent has their own regression.

Respondent task: a card per profile (or Left / Right), a radio scale with end labels (`minLabel` / `maxLabel`), answer `{ task: rating }`. Validation: a number on the scale for a task of the respondent's version; required = every task. Exports: `VAR_T<n>` (the rating; dictionary label says profile / pair and holdout), no `_ORDER`; not in the stacked choice file. Lint: a `conjoint.cva` question on a non-CVA design is an error.

## 5. Dual-response None (`designs/conjoint.ts`, `analyses/choice.ts`, renderer)

Design option `dualResponseNone` (refused together with `noneOption`); the rows are the forced-choice rows (byte-identical to the same design without a None). The renderer shows the follow-up under each task once a choice is made (`dualResponsePrompt`, default "Would you actually buy the option you chose?"); validation requires yes/no per task; exports `VAR_T<n>_BUY` (0/1, labelled) and a `buy` column in the stacked file (only when a dual design exists — every other stacked file is unchanged).

Codings (option `dualCoding`): **dual** (default; Sawtooth): the forced choice plus a binary set chosen-concept vs None; **single_none**: one set with None chosen when they would not buy; **forced**: the forced choice only, no None parameter. The simulator includes None from the estimated constant.

## 6. Brand-specific and labelled CBC (`designs/conjointAltSpecific.ts`)

`brandAttribute` (default: an attribute named Brand…, else the first), `alternativeSpecific` lines ("5G: Alpha, Beta" — the attribute applies only to those brands; elsewhere "" shown as "—" and coded zeros), `labelled` (each brand once per task in brand order; alternatives must equal the brand levels). Level balance counts only concepts an attribute applies to; prohibitions, None / dual, holdouts and versions as usual. The efficient method swaps only attributes both concepts carry and never the brand (`swapImprove` gained `fixed` and not-applicable handling — generic designs are unaffected, snapshot-tested). Brand-specific price ranges are separate attributes each applying to one brand.

## 7. One market simulator (`conjoint/simulator.ts`, `simulatorTables.ts`)

Reads a UtilityModel: one aggregate respondent, HB individual means, or CVA per-respondent fits. Products are attribute→level maps with optional `price` (piecewise-linear interpolation on a numeric price attribute, or the linear summed price) and `cost`.

- **Rules**: logit (scale), first choice, **randomized first choice** (product Gumbel error × `productScale` + attribute-level error shared by every product with that level, `attributeSd`; seeded draws), BTL (ratings).
- **Revenue / profit** per N people; **WTP** two ways: market WTP (the price rise that brings the improved product back to its share, competitors fixed; bisection, "beyond the tested range" said) and utility-ratio WTP (median Δu ÷ |price slope|; respondents with no price sensitivity counted, not used) — both caveated in the table.
- **Demand curve** with arc elasticities and the revenue-maximising tested price; **sensitivity** one attribute at a time; **optimisation** (share / revenue / profit; exhaustive ≤ 50,000 configurations, else seeded coordinate ascent with restarts; prohibitions and fixed attributes respected; price searched only for revenue / profit); **segments** by a variable or an explicit map (e.g. LCA classes).
- Options: `options.simulator` (`products`, `rule`, `scale`, `none`, `rfc`, `marketSize`, `segmentBy` / `segments`, `wtp`, `demand`, `sensitivity`, `optimize`) on the `conjoint` and `hb` analyses; scenarios saved on the design by Intelligent Mode (`config.simulations`) run by default. A CBC analysis without either is byte-identical to before.
- **Exports**: `buildSimulatorXlsx` / `buildSimulatorPptx` (`@rescript/analytics/export`) — one sheet / slide per simulator table, through the platform's own writers; the regular analysis export carries the same tables.

## 8. Intelligent Mode and the entry points for the analysis plan

Engine (`methodActions.ts`): `create_conjoint` / `update_conjoint` accept `method: "cva"` (aliases rating, ratings, full_profile, likelihood_to_buy …), `mode`, `profiles`, `scale`, `minLabel`/`maxLabel`, `monotone`; `dualResponse` (or `none: "dual"`; turning it on replaces the in-task None and says so); `labelled`, `brandAttribute`, `alternativeSpecific`; menu `exclusiveGroups`; ACBC `priceBase`, `priceIncrements`, `priceVariation`, `priceCurrency`. Method-only fields on another method are refused with the reason. New op **`simulate_conjoint`** `{ target, scenario: { name, products | prices + bundles, rule? }, remove? }`: checked against the design (items, levels, prices that parse, out-of-range prices warned), stored in `config.simulations` (never a generation key — the tasks never change), described with what Data Analytics will compute. Still refused: ranking-based conjoint, ACA / self-explicated, numeric attributes (except the ACBC summed price), level images, latent-class choice models. `nlIntent` hands "dual response", "menu simulator", "CVA" requests to the model. The methods guide (6,766 chars, cached prefix, sent only when a method is named; the system prompt is unchanged) teaches all of it with nine worked examples the engine applies in a test. Capability registry: CBC / menu / ACBC notes rewritten, new methodology **Rating-based conjoint (CVA)** (supported), `analysis:hb` now lists ACBC and menu; public pages regenerated and current.

**For F3 (plan items):**

| Entry point | Package | What it gives |
|---|---|---|
| `conjointMethodOf(def, q)` | `@rescript/engine` | method (`cbc` / `acbc` / `menu` / `cva`) and options (dual, brand-specific, sections, summed price, CVA scale) |
| `conjointPlanReadiness(def, q)` | `@rescript/engine` | definition-only readiness: estimators `{id, label, kind: "conjoint" \| "hb", options, available, reason}` — ids `cbc_aggregate`, `cbc_hb`, `cbc_forced`, `acbc_aggregate`, `acbc_hb`, `menu_aggregate`, `menu_hb`, `cva_ols`, `cva_hb` (unavailable, with the reason) |
| `conjointSuiteReadiness(ds, variable)` | `@rescript/analytics` | the same with the data: respondents, choices vs parameters, HB's 20-respondent minimum — `ready` + reason per estimator |
| `conjointAnalysisDefinitions(def, variable, { dataset?, simulator?, hbOptions? })` | `@rescript/analytics` | runnable `AnalysisDefinition[]` (kind `conjoint` first, then `hb`), each passing `analysisReadiness` |
| `planCheck` `hb` case | `@rescript/analytics` | now accepts `acbc_task` and menu questions |
| `simulateShares`, `demandCurve`, `willingnessToPay`, `optimiseProduct`, `sensitivity`, `simulateMenu`, `menuPriceCurve`, `simulatorTables` | `@rescript/analytics` | the simulator as functions, for narratives |

## 9. Validation (measured; seeded; the tests assert the thresholds in brackets)

| Estimator | Synthetic study | Measured | Asserted |
|---|---|---|---|
| CVA single | 200 resp., 4 versions × 16 profiles + 2 holdouts, het. 0.5, noise 0.8, rounded | max \|μ̂−μ\| **0.106**; r(individual) **0.943**; median R² 0.89; holdout r 0.76; 3 flat raters flagged | < 0.15; > 0.9 |
| CVA pairs | 200 resp., 1–9 scale | max \|μ̂−μ\| **0.176** | < 0.25 |
| Dual-response (dual coding) | 800 × 12, no het. | part-worths **0.025**; None **−0.394** (truth −0.4) | < 0.08; ±0.08 |
| Dual, other codings | same | forced: 0.022 (no None); single-task: **biased** 0.395 / None +0.74 (the truth is two-stage) | runs, labelled |
| Dual with heterogeneity 0.2 | aggregate | None −0.50: the forced choice selects concepts the respondent likes more than the pooled model knows → use HB | documented |
| Brand-specific CBC | 700 × 12, 5G for 2 of 3 brands | max error **0.025** | < 0.12 |
| ACBC aggregate | 300 resp., het. 0.2, real engine, summed price | max \|u−μ\| **0.153**; price −0.0099 vs −0.0123 | < 0.25; ±30% |
| ACBC HB | 300 resp., het. 0.8, 2 × (3,000 + 2,000) | max \|μ̂−μ\| **0.134**; r(individual) **0.796**; price **−0.01262** vs −0.01255; R̂ 1.07; RLH 0.62 (25 s) | < 0.25; > 0.7; ±15%; R̂ < 1.1 |
| Menu aggregate | 800 × 10, 4 items + section + buy model + 1 planted cross effect | worst parameter off by **0.074**; cross effect z = 14.9, the only one of 24 kept | < 0.2; exactly that one |
| Menu HB | 250 × 12, het. 0.8, 2 × (5,000 + 3,000) | all R̂ < 1.1; r(individual item constants) **0.775** (≈ 55 s) | R̂ < 1.1; > 0.5 |

Design efficiency (per version, mean / worst): CVA single 4 × 3 levels, 14 profiles **95.0% / 94.8%**; CVA pairs 12 pairs **98.0% / 97.6%**; brand-specific CBC (5G on 2 brands), 10 versions: balanced 81.3% / 76.6% → **efficient 95.4% / 94.9%**; labelled CBC: balanced 84.3% → **efficient 98.8% / 98.4%** (against the generic bound, which understates a brand-specific design).

Simulator checks: logit, first choice and None against hand arithmetic; interpolation and extrapolation flags; revenue / profit formulas; RFC with no attribute error within 0.015 of the logit; RFC loses less than half the logit's share to a near-duplicate (IIA relief); market WTP = Δu ÷ slope = 80 exactly; demand monotone with negative elasticities; exhaustive optimum = hand choice, prohibitions honoured, price held for share.

**Backward compatibility** (`conjoint/compat.test.ts` against `scripts/conjoint-suite/snapshots/`, written with the build before this change): 4 CBC configurations (balanced; efficient + None; holdouts + pair and combination prohibitions; mixed levels), MaxDiff, menu and ACBC designs regenerate byte-identically (rows and summaries); the CBC and MaxDiff analyses, the menu counts table and an HB run give identical tables; the wide export, the dictionary and the stacked CBC file are equal. Intended visible changes: a menu analysis appends model tables after the unchanged counts table and drops the "no choice model" warning; an ACBC analysis is estimated instead of refused; the methods guide and capability registry say what is supported.

## 10. Tests — what to run

- analytics: `cd packages/analytics && pnpm build && node --test dist/conjoint/*.test.js` (8 files, 24 tests; ACBC HB ≈ 25 s, menu HB ≈ 55 s); the full package `pnpm test` (now includes `dist/conjoint`): 615 existing + 24 new pass.
- designs: `node --test dist/*.test.js` — 107 pass (including the new `conjointSuite.test.ts`: 8).
- engine: `node --test dist/*.test.js` — 2,207 pass (including the new `conjointSuite.test.ts`: 7; `methodActions.test.ts` gate expectations updated: rating-based and dual-response are accepted now).
- exporters: 138 pass (including the new `conjointSuiteExport.test.ts`: CSV, SPSS value labels, stacked buy column).
- runtime UI (renderer rendered with React's server renderer): `node --experimental-strip-types --no-warnings --test apps/runtime/lib/conjointSuiteUi.test.ts` — 2 pass.
- Studio: `node --experimental-strip-types --no-warnings --test "lib/**/*.test.ts"` — 802 / 803; the one failure (`eval/cases.test.ts` "fixture spec needs the case's fixtureSpec") comes from another workstream's new eval cases, not this change.
- Eval harness (fake provider): four new `methods` cases — `method-cva`, `method-cva-clarify`, `method-dual-response`, `method-menu-simulator`: `pnpm eval:ai --filter method-`.
- Browser (not run here; Studio :3000 with `AI_API_URL=fake:`, runtime :3001): `node scripts/conjoint-suite-test.mjs` (sentence → design → preview tasks → synthetic data → estimation → simulator → Excel / PowerPoint), and the regressions `methods-intelligent-test.mjs` (step 8 now a ranking-based refusal), `conjoint-p2-test.mjs`, `menu-conjoint-test.mjs`, `acbc-test.mjs`, `maxdiff-p1-test.mjs`, `advanced-models-test.mjs`.
- `node scripts/conjoint-suite/make-snapshots.mjs` regenerates the compat snapshots — only deliberately, for an intended change.

## 11. Honest comparison (public material to mid-2026)

| Capability | Sawtooth (Lighthouse / Discover) | Conjointly | Rescript now |
|---|---|---|---|
| CBC + HB | yes, mature (CBC/HB, constraints, covariates) | yes | yes; HB without covariates or utility constraints |
| ACBC (BYO, screening, rules, tournament, HB, summed price) | yes; piecewise price, per-attribute price variation, many options | no | yes; **linear** summed price only, one variation for the whole concept, rules as implied screens (weight 1) |
| Menu-based (MBC) | yes; serial cross effects, volumetric variants, menu simulator | partial | yes; binary / section logits, auto cross effects, two-stage buy model, bundles by assumption; no volumetric |
| CVA / ratings | yes (OLS + HB option, monotone) | no (choice-based focus) | yes: OLS, monotone ties, flags; **no HB for CVA** |
| Dual-response None | yes | yes | yes, three codings |
| Brand-specific / labelled | alternative-specific designs | brand-specific conjoint | yes |
| Simulator | logit, RFC (tuned), first choice, WTP, sensitivity, optimiser, source of volume, calibration | preference share, revenue, WTP, elasticity, segment simulators, automatic report | logit, RFC (untuned defaults), first choice, BTL; revenue / profit, two WTPs, demand, sensitivity, optimiser, segments; **no calibration to market shares, no source-of-volume table, no interactive UI** (JSON options + saved scenarios) |
| Latent-class choice models | yes | yes | no (data are LC-ready) |
| Automatic reports / AI narratives | partial | yes | via the platform's report and narrative pipeline (F3 wires plan items) |

## 12. Not done (by decision or scope)

- ACBC: piecewise or per-attribute price; price variation per attribute; constructed-list / "near-neighbour" tuning; dual-response on the tournament (the screening threshold already measures "would not buy"); weights for implied rule screens. HB ESS for ACBC at 5,000 iterations is low (≈ 40) — the run warns; longer runs (the job handles them) are advised.
- Menu: cross effects in section MNLs; volumetric (quantity) menus; bundle-specific effects; bundles with section items or part-worth price coding; latent-class MBC.
- CVA: ranking-based conjoint; ACA / self-explicated; HB for ratings; general (non-chain) order constraints; position randomisation of pairs (pairs show design left / right, recorded as such); a dedicated design-quality card in the Studio (the summary shows as JSON).
- Simulator: calibration to known shares, external effects, source of volume, an interactive simulator UI (scenarios are JSON options or saved by Intelligent Mode); RFC parameters are defaults, not tuned to holdouts.
- Aggregate None with dual response is biased under heterogeneity (measured above) — HB is the remedy; the table says which coding ran.
- Version assignment is still a hash of the seed (unchanged from the conjoint audit).
- The browser suite was written, not run, in this sandbox (no dev servers); its estimation half was dry-run in node.

## 13. Files

New: `packages/designs/src/{cva,conjointAltSpecific,conjointSuite.test}.ts`; `packages/engine/src/{conjointSuite,conjointSuite.test}.ts`; `packages/analytics/src/conjoint/{index,simulator,simulatorTables,cva,acbc,menu,hbSuite,readiness,fixture}.ts` and `{cva,acbc,menu,cbcSuite,simulator,compat,export,readiness}.test.ts`; `packages/analytics/src/export/conjointSimulator.ts`; `packages/renderer/src/variants/conjointSuite.tsx`; `packages/exporters/src/conjointSuiteExport.test.ts`; `apps/runtime/lib/conjointSuiteUi.test.ts`; `scripts/conjoint-suite-test.mjs`; `scripts/conjoint-suite/{make-snapshots,snapshot-inputs}.mjs` + `snapshots/*.json`.

Changed (anchored edits): designs `conjoint.ts`, `conjointEfficiency.ts` (`swapImprove` `fixed` / not-applicable), `menu.ts`, `acbc.ts`, `index.ts`, `methodActions.test.ts`; engine `acbc.ts`, `validate.ts`, `flatten.ts`, `variables.ts`, `choiceData.ts`, `methodActions.ts`, `methodActions.test.ts`, `capabilities.ts`, `lintLogic.ts`, `nlIntent.ts`, `index.ts`; schema `variants.ts` (`conjoint.cva`); analytics `analyses/choice.ts`, `analyses/advanced.ts`, `analyses/conjointRecovery.test.ts`, `models/readiness.test.ts`, `planCheck.ts`, `types.ts`, `index.ts`, `export/index.ts`, `package.json` (test glob); renderer `QuestionRenderer.tsx`, `variants/{conjoint,acbc,index}`; Studio `lib/copilot/methodsGuide.ts` (+ test), `lib/eval/cases.ts`, `components/analytics/AnalysisBuilder.tsx`; `scripts/methods-intelligent-test.mjs`.

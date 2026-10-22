# Advanced models, from the plan and in Intelligent Mode — 2026-10-22

Engineer F3. Weakness #8 (vs quantilope / quinn, Displayr, Stats iQ): hierarchical Bayes, latent class, SEM / CFA,
bootstrapped mediation, McDonald's ω and Gabor–Granger could be run by hand in Data Analytics. They could not be
planned, Intelligent Mode could not propose them, applying a plan did not run them, nothing read their results
aloud, and nothing said when a result had gone stale.

All six can now be planned. The engine and Intelligent Mode propose them when the design calls for them. Applying
the plan runs them: HB as a chunked background job with progress, the others inline. Each result gets a reading in
plain language, and an AI interpretation only through the claim gate. The readings appear in the drafted report and
the Word export. A result is flagged stale when new completes arrive and is never replaced silently.

---

## 1. What a researcher can do now

| Say (Intelligent mode) or plan | What happens |
|---|---|
| "run HB on the conjoint" | `add_analysis_test {method:"hb", variables:["CBC"], options:{chains:2,burnIn:5000,draws:5000,seed:1}}`. This works for CBC, ACBC, menu-based and MaxDiff exercises. A rating question, a CVA design or an anchored MaxDiff is refused, and the refusal names the rule. |
| "segment respondents with latent class using Q5–Q12" | `latent_class` on the indicators with options `{minClasses, maxClasses, starts, seed}`. K is chosen by BIC. Covariates are refused in words. |
| "test H2 as a mediation through trust" | Mean-score derived variables for the three constructs, then a regression with `mediator` and `options.bootstrap = 5000` (seeded). The output has percentile and BCa intervals for the indirect effect. |
| "check reliability of trust with omega" | `reliability` with `options.omega = true`. McDonald's ω comes from a one-factor CFA, reported beside α. |
| "fit a structural equation model of the hypotheses" / "CFA of the constructs" | `sem`, with lavaan syntax written from the research design's constructs (each with ≥ 3 items) and its hypotheses. Each IV → DV hypothesis becomes a labelled path, and a mediation hypothesis becomes an `:=` indirect effect. `hypothesisPaths` ties each H to its path. |
| A ladder of purchase-intent questions at stated prices | `pricing {method:"gabor_granger", prices:[…]}`. Prices are read from the question texts when the plan item names the ladder. |
| "re-run advanced models after 100 new completes" (copilot) / the policy select in the plan | `set_analysis_plan {advancedRerun:{mode:"threshold", newResponses:100}}`. |

The plan generator (`buildAnalysisFramework`) adds these on its own, conservatively:

- HB beside every CBC, ACBC, menu or MaxDiff exercise the design can carry.
- Latent class when the objective is segmentation and indicators are tagged `modeling: latent_class`.
- SEM only when there are two or more latent constructs with three or more items each and the sample is at least max(200, 10 × free parameters), or when the design asks for SEM.
- A bootstrap on every mediation regression.
- ω on every reliability analysis with three or more items.
- Gabor–Granger when a price ladder is present.

## 2. One readiness rule, and suitability with reasons

**Readiness.** `packages/analytics/src/planCheck.ts` is the one rule used by the builder, the run route (422), the
plan editor (Save shows "not ready" with the reason), the apply (skips with the same reason) and the Ask panel. New
checks:

- HB reads exactly one exercise.
- Latent class needs indicators; covariates are refused.
- SEM needs its syntax. A `hypothesisPaths` entry that names no path is a warning.
- A bootstrap needs a mediator and 200–20,000 resamples.
- ω needs three or more items.
- Gabor–Granger from the plan needs one positive price per question.

No item is "applied, then skipped".

**Suitability** (`packages/engine/src/advancedMethods.ts`, `advancedSuitability`) is applied by the analysis actions
and the research validator. Blocking reasons refuse the change; warnings travel with it.

| Rule | Value |
|---|---|
| HB sample | ≥ 50 completes (warn < 200) |
| CBC tasks per respondent | ≥ 4 (warn < 8) |
| MaxDiff item shows per respondent | ≥ 1 (warn < 3) |
| Latent-class indicators | ≥ 2 (warn < 3), categorical, ≤ 15 categories |
| Latent-class sample | ≥ 100 (warn < 300) |
| SEM | ≥ 3 indicators per factor (2 is a warning, 1 refused); interval or ≥ 5-point items; sample ≥ 100 and ≥ 5 per free parameter (warn < 10, < 200) |
| Mediation | numeric or scale outcome; sample ≥ 50 (warn < 100) |
| Gabor–Granger | ≥ 2 price points (warn < 4), distinct prices |

ACBC and menu-based exercises are accepted for HB because F4's runner now estimates them (`conjoint/hbSuite.ts`).
CVA is refused with the reason (it is least squares per respondent).

## 3. Applying runs them; traceability only with a run

- `runPlan` reads HB from the result cache (`precomputed`). An HB item without a finished run is a `job_pending`
  result: never a finding, and never a verdict ("still running as a background job" comes before the low-base
  wording).
- The apply (`apps/studio/lib/analysisPlanCore.ts`) starts the job (first chunk 5 s) for each `job_pending` item.
  The item's status is `job_running` with its progress; a refused or failed job is "failed" with the reason.
  `ApplySummary.counts.jobs` and the outcome panel say so.
- The plan page's **Advanced models** card follows the job chunk by chunk (`models/:id/continue`). When it is done,
  it calls `advanced/rerun`, which runs the plan once more so the HB result joins the findings and verdicts.
- Hypothesis verdicts and research traceability show "tested" only from a run that holds the result.
- SEM paths become driver findings (`sem_path`) and indirect effects become mediation findings. The bootstrap gives
  a `bootstrap_indirect` finding: significant when the BCa interval excludes 0, with p = null.

## 4. The reading (quinn-like, gated)

- `advancedNarrative(def, result, ctx)` (analytics) is the engine's own reading, with numbers only from the result:
  - the facts per method;
  - diagnostics with ok / caution / fail: R-hat and ESS for HB, entropy and BIC for LCA, CFI / RMSEA / SRMR for SEM,
    the number of failed resamples for the bootstrap, loadings for ω, monotonicity for Gabor–Granger;
  - caveats;
  - the hypotheses it serves, with the run's verdict.
- An invalid model (did not converge, refused) gets no estimates in the reading.
- `semPathDiagramSvg` draws the path diagram as escaped SVG built from the result's nodes and links. Latent
  variables are placed in columns by depth; a path that skips a column is drawn as an arc.
- `POST analytics/advanced/narrative` returns the reading, the Markdown and the SVG. Asked for
  (`interpretation: true`, needs `analytics.edit`), it also returns the model's interpretation in the researcher's
  language through the claim gate:
  - the claims check covers these result shapes;
  - per-respondent tables (HB individual utilities, class membership) are never citable;
  - Unicode digits are normalised before checking.
- **Reports**
  - The drafted report has a section "Advanced models — what they show": a reading per model, its gated
    interpretation (up to 3 metered calls), and the key table (importances, class profiles, structural paths,
    the bootstrap table, ω, the GG curve).
  - Word (`buildFindingsDocx`) has an "Advanced models" chapter with the summary, a diagnostics table and caveats.
  - PowerPoint exports the report's blocks (text and tables) through the existing builder.

## 5. Live updating

- `GET analytics/advanced` gives each advanced item's state: `fresh`, `stale` (with the completes since, by
  environment), `never_run` or `running` (with the job's percentage). HB's clock is its finished job; the clock of
  the other models is the latest run.
- A stale result is shown with "the result shown is the earlier one". **Nothing is overwritten** until a re-run
  finishes. A new HB run has a new input hash, so the old cached result stays until the new one is done.
- **Re-run** (`POST analytics/advanced/rerun`, `analytics.edit`) restarts HB jobs for stale or missing results and
  runs the plan for the other models.
- **Policy**: `analysisPlan.advancedRerun = {mode:"manual"}` (the default: flag only) or
  `{mode:"threshold", newResponses:N}`. With the threshold policy, the hourly cron (`/api/cron/analysis-runs`):
  - re-runs what crossed the threshold;
  - advances running HB jobs within its time budget;
  - brings a finished job into a new run.

## 6. Copilot

- The analysis guide (`COPILOT_ANALYSIS_GUIDE`) now lists `hb`, `latent_class` and `sem` as plannable methods. It
  gives each one's options, the mediation bootstrap, ω, Gabor–Granger and the re-run policy, and says when to
  propose each.
- The old line "never plan them" is gone.
- The methods guide points an HB request at an `hb` plan item.
- The system prompt is unchanged (14,800-character cap).
- The capability registry:
  - `hb` → supported; `sem` → supported;
  - `gabor_granger` → supported;
  - `latent_class` stays **partial**: no covariates, no latent-class choice model;
  - the notes say "from the analysis plan".

## 7. Validation

| What | Reference | Result |
|---|---|---|
| Bootstrap indirect effect (percentile + BCa) | Python re-implementation of the same seeded RNG (`scripts/stats-reference/bootstrap_reference.py` → `fixtures/bootstrap.json`; n = 500, 2,000 draws, seed 7) | bit-exact (1e-15). Indirect 0.11729, BCa [0.076277, 0.162108]. scipy BCa with 9,999 draws gives [0.0761, 0.1642] |
| McDonald's ω | semTools `reliability()` on Holzinger–Swineford: ω .6253180 / .8851754 / .6877612; α .6261171 / .8827069 / .6884550 | ω matches to the CFA's precision; α matches exactly; also checked against the closed form by hand |
| Gabor–Granger | hand-computed demand and revenue curve on the fixture | within 0.03 (rounding) |
| SEM from the design | syntax and t-rule checked against the constructs and hypotheses; fit on the 3-factor mediation fixture | paths recovered with their signs |

## 8. Files

**Schema.** `packages/schema/src/analysisPlan.ts`:

- methods `hb`, `latent_class`, `sem`;
- `PlannedTest.options`;
- `AnalysisPlan.advancedRerun`.

**Analytics.**

- New:
  - `stats/bootstrap.ts`;
  - `models/omega.ts`;
  - `advancedNarrative.ts`;
  - `advancedStale.ts`.
- Changed:
  - `analyses/statistics.ts` (mediation bootstrap, reliability ω);
  - `planBridge.ts` (method kinds, `PLAN_OPTION_KEYS`);
  - `planCheck.ts`;
  - `findings.ts` (SEM findings, bootstrap finding, `precomputed`, `job_pending`, verdict order);
  - `claims.ts`;
  - `reportBuilder.ts`;
  - `export/docx.ts`;
  - `planWorkspace.ts`;
  - `types.ts`;
  - `models/fixture.ts` (`intelligentFixture`, `gaborGrangerFixture`);
  - the index files.

**Engine.**

- New:
  - `advancedMethods.ts` (suitability, SEM from the design, the generator's proposals, options);
  - `advancedIntent.ts` (the sentences).
- Changed:
  - `analysisFramework.ts`;
  - `analysisActions.ts` (options, refusals, `set_analysis_plan.advancedRerun`);
  - `surveyActions.ts`;
  - `planReads.ts`;
  - `nlIntent.ts`;
  - `researchValidation.ts`;
  - `capabilities.ts`;
  - `index.ts`.

**Studio.**

- New:
  - `lib/advancedModelsCore.ts`;
  - `lib/advancedModels.ts` (GET/POST `advanced`, narrative, rerun, `advancedTick`, report interpretations);
  - `components/analytics/AdvancedModels.tsx` (method options editor, reading panel, live card).
- Changed:
  - `lib/analytics.ts` (`modelInputKey`, HB from cache in `runPlanFor`);
  - `lib/modelJobs.ts` (`jobDepsFor`);
  - `lib/analysisPlanCore.ts` (jobs on apply);
  - `lib/analysisPlanService.ts`;
  - `app/api/surveys/[id]/analytics/[[...path]]/route.ts` (dispatch, report draft);
  - `app/api/cron/analysis-runs/route.ts`;
  - `components/analytics/api.ts`;
  - `components/analytics/PlanWorkspace.tsx`;
  - `lib/copilot/prompt.ts`;
  - `lib/copilot/methodsGuide.ts`;
  - `lib/eval/cases.ts`;
  - `lib/eval/baseline.json`.

**Migration.** None. State lives in the plan JSON, jobs in `analytics_model_jobs` (0066), and results in
`analytics_result_cache`. 0071 was not needed.

## 9. Tests

| Suite | Command | Result |
|---|---|---|
| Analytics (bootstrap, ω, advanced plan / narrative / docx …) | `cd packages/analytics && npm test` | 639 / 639 |
| Engine (`advancedMethods.test`: SEM from design, suitability incl. ACBC / menu / CVA, generator, options, re-run policy, sentences, validator, registry) | `cd packages/engine && node --test dist/*.test.js` | 2166 / 2168. The 2 list-fill files pass alone (41 / 41); they failed only while dist was being rebuilt concurrently |
| Studio (`advancedModelsCore`, `analysisPlanCore` apply-with-job, `advancedGuide`, eval cases …) | `cd apps/studio && node --experimental-strip-types --no-warnings --test "lib/**/*.test.ts"` | 803 / 803 |
| Eval harness, fake provider (5 new `advanced-*` cases: ω, LCA, bootstrapped mediation; HB on a rating and LCA covariates refused) | `pnpm eval:ai` | 55 / 55; baseline updated |
| Browser suite, backend only (the same flow through the fake API) | `node --experimental-strip-types --no-warnings scripts/advanced-models-intelligent-test.mjs --backend-only` | 7 / 7, about 60 s |
| Browser suite | `flock /tmp/p0/browser.lock node --experimental-strip-types --no-warnings scripts/advanced-models-intelligent-test.mjs` (Studio on 3000) | **18 / 18** on the shared dev server. The first orchestrator run died at §1 when the dev server was OOM-killed; a clock bug in the suite's §5 (new completes dated in the future) was fixed |
| Typecheck | `nice -n 10 npx tsc --noEmit -p apps/studio/tsconfig.json` | clean |

## 10. Honest comparison with quantilope (quinn)

**Where we now match.** In both products:

- Advanced methods come out of the study design and run without a statistician wiring them.
- Readings are in plain language.
- Results update during fieldwork.

**Where we go further.**

- Every number in an AI interpretation is checked against the result. A sentence with an invented number is withheld
  and counted.
- Refusals name the rule (sample, tasks, indicators, identification) instead of running a model the data cannot
  carry.
- Bootstrap and ω are validated against published or reference values.
- Seeds are fixed, so every run is reproducible.
- A stale result is flagged, never silently replaced.

**Where quantilope is still ahead / what is not done.**

- quinn is a conversational analyst over results. Ours reads one model at a time, and the Ask panel proposes
  analyses; there is no free chat over all results.
- The interpretation's quality with a **real** model is not measured: the eval cases use the fake provider. A
  recorded real-model run (`pnpm eval:ai --record`) is still needed.
- Latent class has no covariates (one-step or three-step) and no latent-class choice model (LC-MNL). Both are
  refused with the reason.
- The SEM path diagram is an SVG in the plan page only. Word and PowerPoint get the paths as a table, not the diagram.
- Auto re-run is "threshold, checked hourly". There is no separate wall-clock schedule (daily / weekly).
- HB in the Intelligent-mode sentence path uses 5,000 + 5,000 iterations by default, which can take several minutes
  per exercise. The job runs in 40-second chunks.
- The sentence routing is deterministic for the phrasings in §1. Other phrasings go to the model with the guides.
- quantilope's automated method library is wider (implicit association, a TURF-to-simulator flow, brand-tracking
  modules). This work did not add methods; it made the existing advanced ones plannable, automatic and narrated.

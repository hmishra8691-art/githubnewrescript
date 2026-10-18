# Advanced statistics — HB, latent class, SEM, and the §9 gap audit (2026-10-18)

Engineer E4. Scope: brief §8 (advanced models) and §9 (gap audit of statistical capabilities). Every number below was produced by code that was run: the TypeScript estimators in `packages/analytics/src/models/`, the Python reference scripts in `scripts/stats-reference/`, and the tests listed in §8. Python is used only to produce reference results. It is not used in production.

## 1. Summary

| Model | Before | Now | Validated against |
|---|---|---|---|
| Hierarchical Bayes (HB-MNL) for CBC and MaxDiff | Not supported. The aggregate logit was the only model. | **Implemented** as the Data Analytics kind `hb`. It runs as a chunked background job (migration 0066). | Synthetic recovery from known μ and Σ through a real efficient CBC design; the aggregate MNL on the same data. |
| Latent class analysis (categorical indicators) | Not supported | **Implemented** as kind `lca` | stepmix 3.0 and an independent numpy EM |
| SEM / CFA (ML) | Not supported | **Implemented** as kind `sem`, with lavaan-style syntax | semopy 2.3 and the published lavaan values: Holzinger–Swineford, Political Democracy, a simulated mediation model |
| Gap audit (§9) | — | Table in §6. Two small fixes: post-hoc pairs after ANOVA / Kruskal–Wallis, and a multiple-comparison choice in the builder. | Unit tests |

The validity rule is enforced in code rather than left to the reader. A result that is not valid is never presented as one:

- A model that did not converge, is not identified, or reached an improper solution returns its diagnostics and the reason.
- It returns no coefficients and no fit indices.
- It never falls back silently to a simpler model. HB shows the aggregate logit beside it, labelled "comparison only".

## 2. Architecture decision (§8 D)

**Decision.** The estimators run inside the existing TypeScript analytics engine (`@rescript/analytics`). They add no new dependency, are pure and seeded, and run in the Studio's serverless functions. HB, the one model that can exceed a request, runs as a resumable state machine. Its chain state is persisted between requests.

**Why not a separate Python/R service:**

- Every validation target is reachable in TypeScript to tight tolerance. SEM agrees with semopy to 3e-7 and LCA with stepmix to 6e-6.
- A service would add deployment, authentication, cold starts and data egress.
- It would also add a second code path for the dataset, the filters and the readiness rule.
- The case for a service returns only with estimators that are large to write and validate: WLSMV for ordinal SEM, FIML, multigroup invariance, mixture HB, and LCA with covariates. These are on the roadmap (§7).

**The stable interface** is `models/spec.ts`. Every model returns a `ModelRun<T>`, which contains:

- **Status:** `done | running | failed | refused | cancelled`.
- **Progress:** done, total and unit, for chunked runs.
- **Diagnostics:** each with a stable code (`not_identified`, `heywood`, `not_converged`, `rhat_high`, `local_maximum`, `empty_class`, `listwise`, …) and a severity.
- **Output:** `output` is null unless the run is valid.
- **Reproducibility metadata:** model, `MODELS_VERSION`, seed, an FNV-1a fingerprint of the exact numeric input, the resolved options and the elapsed time.

**Specifications are validated before anything runs.** `planCheck.ts` holds the one readiness rule, which the builder's Run button, the run route's 422, the plan editor and the job route all read. It checks:

- **HB:** exactly one CBC or MaxDiff question, and no more than 200,000 iterations.
- **LCA:** at least two indicators, 1 ≤ K ≤ 8, and identification computed from the code frames.
- **SEM:** the syntax is parsed and identified (a scale for every factor, the t-rule df ≥ 0, one- and two-indicator factors); the variables exist and are numeric or scale.

**Execution and persistence:**

- **LCA and SEM** take milliseconds to about 2 s, so they run synchronously through `POST run`.
- **HB starts** with `POST analytics/models`, which runs the first chunk of 40 s or less and stores the job.
- **HB continues** with `POST analytics/models/<id>/continue`. Each call takes an optimistic lease (the update matches the row's `updated_at`), advances the chains from the saved state, and stores the new state.
- **Other endpoints:** `GET` returns status, progress and, when finished, the result; `POST …/cancel` stops a run.
- **When a run finishes,** the result goes through the same post-processing as `runAnalysis` (`finalizeResult`: chart advice and provenance). It is written to `analytics_result_cache` under the input hash that `compute()` uses, so reports and exports of the saved analysis are served the finished run.
- **The synchronous `hb` runner** (used by the run route and by exports when the cache misses) finishes within `timeBudgetMs`, 25 s by default. Otherwise it refuses and says how long the run needs. It never returns a partial run.
- **Determinism:** the chain state includes the RNG state, so a run done in chunks produces bit-identical draws to an uninterrupted one (tested).
- **Data changes:** a continuation on changed data is refused because the fingerprint no longer matches.

Code:

- `packages/analytics/src/models/{spec,rng,linalg,hb,lca,sem,semSyntax}.ts`
- `analyses/advanced.ts` (runners)
- `analyses/modelJob.ts` (job step)
- `apps/studio/lib/{modelJobState,modelJobsCore,modelJobs}.ts`
- Two dispatch lines in the analytics route
- `supabase/migrations/0066_analytics_model_jobs.sql`: re-runnable, service-role only, with RLS on and no member policy

## 3. Hierarchical Bayes (`hb`)

**Model:** Allenby–Rossi, the CBC/HB form.

- **Upper level:** β_i ~ N(μ, Σ).
- **Lower level:** MNL.
- **Priors:** μ flat. Σ ~ inverse-Wishart with ν₀ = p + priorDf (default 5) and V₀ = ν₀ · priorVariance (default 1) · S. S is Sawtooth's effects-coding shape (I − J/k per attribute), which gives every level, including the reference level, the same prior variance.

**One iteration, for each chain:**

1. **β_i:** random-walk Metropolis–Hastings with proposal ρ·chol(Σ)·z. During burn-in ρ is adapted toward 30% acceptance (×1.1 / ×0.9); after burn-in it is fixed.
2. **Joint shift move:** β_i + δ for every respondent and μ + δ together. The prior ratio cancels, so the move is a valid MH step on the likelihood ratio. It removes most of the autocorrelation that the centred parameterisation has in μ: minimum ESS rose about 3× at the same cost.
3. **μ:** Gibbs draw from N(β̄, Σ/N).
4. **Σ:** Gibbs draw from IW(ν₀ + N, V₀ + Σ(β_i − μ)(β_i − μ)ᵀ), using the Bartlett decomposition.

**Coding:** effects coding with a None constant, shared with the aggregate MNL. `cbcCoding` was extracted from the conjoint runner with no behaviour change. MaxDiff uses the sequential best–worst coding (`maxdiffRespondentSets`).

**Sampler settings:**

- Starting values are ridge-penalised individual MNL estimates around a pooled MNL. Chains after the first are dispersed around them.
- Defaults: 2 chains × (5,000 burn-in + 5,000 draws), thinning 5, seed 1.

**Outputs:**

- Posterior mean, SD and 95% credible interval of μ for every level; the heterogeneity SD √(TΣTᵀ); R̂ and ESS per parameter.
- Individual posterior means and SDs.
- Individual and summarised importances.
- RLH and percent certainty, overall and per respondent.
- A trace table: mean log-likelihood by burn-in block and kept block, per chain.
- Acceptance and jump size per chain, and the largest Geweke |z| per chain.
- A simulator on individual utilities: the mean of each respondent's logit shares, shown beside the aggregate-logit shares.
- The HB means beside the aggregate MNL.
- **Verdict:** if R̂ > 1.1, the estimates are withheld and only the diagnostics are shown. ESS < 100, acceptance outside 10–60% and Geweke drift produce warnings.

**Validation** (`models/hb.test.ts`). Respondents are drawn from known μ and Σ, with heterogeneity SD 0.8 per level before centring. The design is a real 10-version efficient CBC from `@rescript/designs`, 4×3 levels plus None, 12 tasks. Errors are Gumbel.

| Check | Tolerance | Measured |
|---|---|---|
| Population means μ, CBC (300 × 12) | max \|μ̂ − μ\| < 0.20 | **0.140** |
| Heterogeneity SD (true 0.65 per centred level) | ±0.25 | 0.70–0.80 |
| Individual part-worths vs truth | r > 0.70 | **r = 0.837** |
| HB means vs aggregate MNL (same data) | r > 0.95; scale > 1.15 | same pattern, HB/aggregate scale **1.68**. The aggregate is attenuated by heterogeneity, as expected. |
| RLH (chance 0.25) | 0.45–0.90 | 0.578 |
| MaxDiff, 8 items, 300 respondents | max \|μ̂ − μ\| < 0.25; r(individual) > 0.70 | **0.135**; **r = 0.881** |
| Chunked + JSON round-trip vs uninterrupted | identical | identical (deep-equal) |
| Inverse-Wishart draw mean | ±0.01 | passes (8,000 draws) |
| R̂ / ESS / Geweke sanity | divergent chains R̂ > 1.5; iid draws ESS ≈ n; drift gives \|z\| > 3 | passes |

**Prior sensitivity is measured and documented, not hidden.** With few tasks and small true heterogeneity, the default prior (variance 1) pulls Σ up and slightly inflates the scale.

| Case | μ (truth 1.0) | Heterogeneity SD (truth 0.5) |
|---|---|---|
| p = 4, 15 tasks, N = 400, prior variance 1 | 1.10 | 0.61 |
| Same, prior variance 0.1 | 1.05 | 0.52 |
| Same, N = 1,600 | 1.03 | 0.54 |

At N = 1,200 on the CBC design, μ is recovered within 0.05. The prior is exposed in Options with this explanation.

## 4. Latent class analysis (`lca`)

**Method:** EM for local-independence multinomial indicators. Identical response patterns are collapsed for speed. Each K uses `starts` random starts (default 20, seeded); the best is kept, and the number of starts that replicated it (within 0.01) is reported.

**Model comparison:** K = min..max (1..4 by default, at most 8), with log-likelihood, number of parameters, residual df, AIC, BIC, sample-size-adjusted BIC, relative entropy, the smallest class, and replication.

**Per solution:** class sizes (estimated and modal), item-response probabilities, the mean posterior probability by assigned class (classification uncertainty), and a per-respondent posterior membership table.

**Warnings:** possible local maximum (fewer than 2 starts reached the best value), empty or near-empty class, boundary estimates, unidentified K (df < 0 or npar ≥ N), non-convergence, and listwise deletion with the count.

**Recommendation:** the lowest BIC among valid solutions only. A solution that is unidentified, did not converge or has an empty class is never recommended. The recommendation names AIC and SABIC where they disagree, flags entropy below 0.6 and a winner at the largest K tried, and says the choice is not automatic. Classes are numbered largest first, so labels are stable.

**Validation** (`models/lca.test.ts`, reference `lca_reference.py` → `fixtures/lca.json`). N = 1,200 from a known 3-class model with 6 indicators (4 binary, 2 three-category). stepmix (30 starts) and the numpy EM (50 starts) agree with each other to 1e-4.

| Check | Tolerance | Measured |
|---|---|---|
| Log-likelihood vs stepmix, K = 1..4 | < 0.01 | ≤ 6.1e-6 (ours is never lower) |
| Log-likelihood vs numpy EM | < 0.01 | ≤ 4.7e-8 |
| BIC vs stepmix's `bic()` | < 0.05 | identical to 3 decimals |
| Item probabilities vs stepmix, K = 3 (label-matched) | < 0.005 | 6.7e-6 |
| Item probabilities vs the planted model | < 0.08 | 0.072 |
| Class sizes vs planted | < 0.05 | passes |
| Recommended K | 3 | 3 (BIC 10425.13 vs 10767.49 at K = 2 and 10468.86 at K = 4) |
| Modal classification vs planted classes, survey path, N = 600 | > 75% | passes |

## 5. SEM / CFA (`sem`)

**Syntax:** a lavaan-like subset.

- **Supported:** `=~`, `~`, `~~` and `:=`. Labels (`a*x`) give equality constraints when shared; `1*x` fixes a loading and `NA*x` frees it; several left-hand names are allowed; `#` starts a comment.
- **Refused with the line number:** `~ 1`, `|`, `<~`, constraints with `==`, `<` or `>`, and `start()` modifiers.

**Representation:** RAM, with Σ(θ) = F(I − A)⁻¹S(I − A)⁻ᵀFᵀ.

**Defaults, as in lavaan `sem()`:**

- The first loading of each factor is fixed to 1. With scaling `unit_variance`, the latent (residual) variances are fixed to 1 and all loadings are free.
- Every residual variance and exogenous variance is free.
- Exogenous latent variables covary, and so do exogenous observed variables.
- Endogenous residuals are uncorrelated unless written with `~~`.

**Estimation:**

- Minimise F_ML = log|Σ| + tr(SΣ⁻¹) − log|S| − p.
- S is the ML covariance (divisor N) of listwise-complete cases.
- BFGS with an analytic gradient tr[(Σ⁻¹ − Σ⁻¹SΣ⁻¹)·∂Σ/∂θ]. The inverse Hessian is seeded with the expected information, and the solution is polished by Fisher scoring.
- SEs come from the expected information: (N · ½ tr(Σ⁻¹∂Σ_aΣ⁻¹∂Σ_b))⁻¹.

**Fit indices:**

- χ² = N·F_min, df, and p.
- The baseline model keeps the covariances among exogenous observed variables, as lavaan's fixed.x baseline does.
- CFI and TLI.
- RMSEA (with N) and its 90% CI by inverting the noncentral χ². The noncentral χ² CDF is implemented as a Poisson mixture.
- SRMR (Bentler), AIC and BIC from the full normal log-likelihood.

**Estimates:**

- Unstandardised estimates with SE, z, p and 95% CI.
- Standardised estimates (std.all). Residual covariances are standardised by the residual variances, as lavaan does; semopy uses total variances.
- R² for endogenous variables, and the largest standardised residuals.
- `:=` effects and automatic X → M → Y indirect effects, each with a full delta-method SE (numeric Jacobian × vcov).
- A simple path diagram: chart nodes and links, drawn by the existing network chart.

**Refusals:**

- **Before fitting:** no scale for a factor; the t-rule (df < 0); a single-indicator factor with a free residual; an isolated two-indicator factor; an unknown variable; a factor named like a data variable; an undefined label.
- **After fitting:** non-convergence; a Heywood case (negative variance, a standardised loading beyond ±1, a non-positive-definite latent covariance); a singular information matrix (empirical non-identification); a singular sample covariance.
- In every case the result has no coefficients and no fit indices.

**Validation** (`models/sem.test.ts`, reference `sem_reference.py` → `fixtures/sem.json`). semopy was run with `solver="trust-constr"`. Its default SLSQP stops about 1e-6 short of the optimum: χ² 85.30573 against the true minimum 85.30552.

| Model | Estimates vs semopy | SEs vs semopy | Fit vs semopy / lavaan |
|---|---|---|---|
| Holzinger–Swineford 3-factor CFA, N = 301 | 6.8e-8 (tolerance 1e-4) | 1.5e-8 (1e-4) | χ²(24) = 85.306, CFI .931, TLI .896, RMSEA .092 [.071, .114], SRMR .065, AIC 7517.490, BIC 7595.339. All equal lavaan's published output, and each loading and SE is within ±0.0006 of lavaan's printed values. |
| Political Democracy, N = 75: 3 factors, 2 paths, 6 residual covariances | 2.3e-7 | 4.4e-8 | χ²(35) = 38.125 (lavaan 38.125), CFI .995, RMSEA .035. Residual correlation y1~~y5 std.all = 0.296, as lavaan reports. |
| Simulated X → M → Y, N = 500 | 2.0e-8 | 1.6e-9 | χ²(24) = 23.10; a, b and c′ recovered within 0.1. Indirect a·b = 0.161, delta SE 0.0304 against Sobel's 0.0315 (within 5%). |
| Heywood (r₁₂ = r₁₃ = .8, r₂₃ = .5 gives λ₁² = 1.28) | — | — | `failed / improper_solution`: no estimates, no fit |
| `maxIter: 1` | — | — | `failed / not_converged` |

## 6. Performance

These timings were measured in the shared sandbox (Node 22, one core). The serverless function's `maxDuration` is 60 s.

| Run | Time |
|---|---|
| HB-CBC, 300 respondents × 12 tasks, defaults 2 × (5,000 + 5,000) | 23 s; R̂ 1.014, ESS 116. About 1.2 ms per chain-iteration at N = 300; the hot loop uses sparse effects-coded rows. |
| HB-CBC, 1,000 × 12, defaults | 78 s, more than one request: a job of 2–3 chunks |
| HB-MaxDiff, 300 / 1,000 respondents | 27 s / 89 s |
| LCA, N = 1,200, 6 indicators, K = 1..4 × 20 starts | 2.0 s |
| SEM, HS / PolDem / mediation | 96 / 43 / 41 ms (32–39 BFGS iterations) |

**Choice: chunked execution with persisted chain state** (job table 0066), rather than a background worker:

- No worker infrastructure is needed.
- Each chunk is at most 40 s.
- The builder polls with `continue` and shows "Hierarchical Bayes: n of N iterations per chain (x%) · about s left", with a Cancel button.
- The state for N = 300 is about 1.5 MB of JSON, dominated by per-respondent running sums. It is cleared when the run finishes.

## 7. Integration

- **Builder:** the analysis kinds `hb`, `lca` and `sem` sit in a new "Advanced models" group (`ANALYSIS_KINDS`, `RUNNERS`, `ROLE_FOR_KIND`, hints). The Options panels:
  - **HB:** chains, burn-in, draws, thinning, seed, prior variance and df, holdouts, scenario profiles.
  - **LCA:** the class range, starts, seed, and the solution to display.
  - **SEM:** a syntax editor with a variable-name chip list, and the scaling.
- **Results** render through the generic result view: tables, the path diagram for SEM, and a heatmap of profiles for LCA.
- **Export:** the existing analysis export path produces Excel (one sheet per table), tested.
- **Weights:** the models ignore weights and say so, through `UNWEIGHTED_KINDS`.
- **Capability registry** (`engine/capabilities.ts`): `analysis:hb`, `analysis:latent_class` and `analysis:sem` moved from not supported to **partial**. They run in Data Analytics, but they are not analysis-plan methods. Each entry has inputs, handler, validation, output schema, limitations, tests and version.
  - The notes on CBC, MaxDiff, segmentation, `conjoint_utilities`, `maxdiff_scores`, `cluster` and `factor` point to them.
  - The brief stays within its 2,200-character budget (2,000).
  - `capabilities.md` was regenerated.
  - Three engine test expectations were updated to the new status.
- **Copilot:** one sentence was appended to the method list in `prompt.ts`: hb, lca and sem run in Data Analytics and are never planned.
- **Aggregate notes:** the aggregate conjoint and MaxDiff notes now point to the HB analysis. The existing wording is kept and their tests still pass.

## 8. §9 Gap audit — statistical capabilities

| Area | Status | Evidence (tests) |
|---|---|---|
| Descriptives, CIs, weighted descriptives, effective n | Implemented and tested | `stats.test.ts` "describe: mean, sd, se, ci…", "proportions: z-test, Wilson CI"; `weightedInference.test.ts` |
| Inference: t (one-sample, Welch, pooled, paired), ANOVA one- and two-way (Type II), Mann–Whitney, Wilcoxon, Kruskal–Wallis, Friedman, chi-square, Fisher, trend in proportions | Implemented and tested | `stats.test.ts` "t-tests…", "ANOVA one-way / two-way, Kruskal…", "chi-square and Fisher on a 2×2"; `stats/phase7.test.ts` "S-9: Friedman… matches scipy" |
| Crosstab with significance letters and multiple-comparison adjustment | Implemented and tested. Holm by default, plus Bonferroni, BH and none; the vs-total ▲▼. **The choice is now exposed in the builder** (it was engine-only). | `crosstab.test.ts` (correction "none" vs Holm), "weighted: percentages, letters and the SD all follow the weights" |
| Post-hoc pairs after ANOVA / Kruskal–Wallis | Implemented and tested. The plan's findings had it; **Data Analytics now has it too** (Welch or Mann–Whitney pairs, Holm/Bonferroni/BH-adjusted, appended table). | `phase4.test.ts` "a significant ANOVA carries the pairs…"; **new** `analyses/gapAudit.test.ts` (2 tests) |
| Family-wise corrections across a plan or report | Implemented and tested | `phase4.test.ts` "p-values are adjusted as a family…"; `phase7b.test.ts` "I-3: … Holm across the whole report" |
| Regression: OLS, binary logistic, multinomial; separation guarded | Implemented and tested. **Missing:** Poisson / negative binomial, ordinal logistic, robust (sandwich) SEs. | `stats.test.ts` "logistic and multinomial regression…", `analyses/phase0.test.ts` "S-4: a perfectly separated logistic…" |
| Factor / PCA | EFA (PCA, principal axis, varimax) tested. **CFA: new** (SEM). **Missing:** oblique rotation (promax / oblimin). | `stats.test.ts` "PCA on two correlated blocks…", `stats/phase7.test.ts` "S-12: principal-component scores… match numpy"; `models/sem.test.ts` |
| Cluster | k-means and hierarchical (Ward, average) tested. **LCA: new.** | `stats.test.ts` "k-means separates two obvious clouds…", "F-3: … hierarchical clustering"; `models/lca.test.ts` |
| Reliability | Cronbach's α with item-total statistics, tested. **Missing:** McDonald's ω (derivable from a one-factor CFA, on the roadmap). | `stats.test.ts` "…alpha of a coherent scale is high" |
| Weighting / design-aware estimation | Rim weighting with efficiency and design effect; weighted percentages, letters and CIs using effective n; models state that they are unweighted. **Missing:** Taylor-linearised variance for stratified or clustered designs; weighted models. | `stats.test.ts` "rim weighting hits marginal targets…"; `weightedInference.test.ts`; `analyses/phase7.test.ts` "S-6: a weighted study's tests and models say they ignore the weights" |
| Mediation / moderation | Regression mediation (Sobel) and moderation (interaction) tested. **Latent mediation with delta-method indirect effects: new** (SEM). **Missing:** bootstrap CIs for indirect effects. | `stats.test.ts` "mediation: full mediation…"; `models/sem.test.ts` "simulated mediation…" |
| Longitudinal | Wave and period trends; paired and repeated tests (paired t, Wilcoxon, Friedman). **Missing:** mixed-effects / multilevel and panel models. | `phase4.test.ts` "beyond the plan: trends across waves…"; `stats.test.ts` |
| Choice models | Aggregate MNL (CBC, MaxDiff, anchored) tested. **HB: new.** **Missing:** latent-class MNL, menu choice models, ACBC estimation. | `conjointRecovery.test.ts`, `maxdiffRecovery.test.ts`; `models/hb.test.ts` |

**Fixed here** (small and clearly correct):

1. Adjusted pairwise comparisons after a 3+-group ANOVA or Kruskal–Wallis in Data Analytics (`statistics.ts`). The table is appended, so existing tables keep their order.
2. A multiple-comparison selector in the builder for crosstab letters and post-hoc pairs (`AnalysisBuilder.tsx`).

**Ranked for later (roadmap), by impact for survey research divided by effort:**

1. Bootstrap CIs for indirect effects (SEM and regression mediation): small.
2. McDonald's ω from a one-factor CFA, beside α: small.
3. Ordinal logistic and Poisson / negative-binomial regression: medium.
4. Oblique rotation (promax / oblimin) in EFA: medium.
5. FIML for SEM, and missing-at-random likelihood for LCA: medium. Validate against semopy and stepmix with NaNs.
6. Taylor-linearised design-based SEs (strata and PSU): medium–large.
7. Latent-class MNL for CBC: medium, since the HB machinery and the LCA EM can be reused.
8. Multigroup SEM and measurement invariance: large.
9. Mixed-effects / multilevel models: large.
10. Ordinal SEM (WLSMV): large. This is the candidate for a separate service.

## 9. Tests — what to run

Unit tests (CI needs no Python, because the fixtures are committed JSON):

- **analytics:** `cd packages/analytics && pnpm build && node --test dist/*.test.js dist/*/*.test.js`. The package `test` script now includes `dist/models`. New files:
  - `models/hb.test.ts` (7)
  - `models/lca.test.ts` (4)
  - `models/sem.test.ts` (8)
  - `models/readiness.test.ts` (5)
  - `analyses/gapAudit.test.ts` (2)
- **Studio:** `node --experimental-strip-types --no-warnings --test "lib/**/*.test.ts"`. New: `lib/modelJobs.test.ts` (3: chunked run over the in-memory Supabase with the real engine, lease, cancel, refusal, state rules).
- **engine:** `capabilities.test.ts`, `capabilitiesReadiness.test.ts` and `researchValidation.test.ts` were updated for the partial status.
- **Reference scripts:** `python3 scripts/stats-reference/lca_reference.py` and `python3 scripts/stats-reference/sem_reference.py` regenerate the fixtures. They need stepmix 3.0 and semopy 2.3 (`pip install --use-pep517 semopy`).

Browser suites (Studio on :3000):

- `node scripts/advanced-models-test.mjs`: LCA K = 1..4 with the BIC table, profiles, membership and Excel export; SEM fit indices, path diagram, and a non-identified model refused; HB as a chunked job with progress, then diagnostics and utilities; cancelling a running job.
- Regression suites: `analytics-test.mjs`, `analysis-apply-test.mjs`, `analysis-plan-test.mjs`, `conjoint-p2-test.mjs`, `maxdiff-p1-test.mjs`.

## 10. Limits (stated, not hidden)

- **HB:**
  - Normal heterogeneity only: no mixtures and no covariates in the upper level.
  - No ACBC, menu or anchored-MaxDiff HB. Each is refused in words.
  - Not selectable from the analysis plan.
  - Importances and simulation use posterior-mean individual utilities, not draws.
- **LCA:**
  - Categorical indicators only.
  - Listwise deletion.
  - No covariates or distal outcomes, and no bootstrap LRT.
- **SEM:**
  - Continuous normal-theory ML only: no WLSMV, FIML, multigroup, mean structure or bootstrap.
  - Automatic indirect effects cover two-step chains. Longer chains need `:=`.
- **All three:**
  - The models ignore weights and say so.
  - The SQL of migration 0066 is not applied here. The job service is tested over the in-memory Supabase.

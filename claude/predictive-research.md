# Predictive research: what it would take

*Assessment against `08d6581`. No code written — this is a feasibility read and a roadmap. Companion page: the published "Rescript Prediction Layer" artifact.*

## The verdict

Yes, and the expensive parts are already built. What is missing is narrow: somewhere to keep a fitted model, a training loop with honest metrics, and one new function in the expression language.

The genuine risks are not technical. They are the provenance of the outcome you train on, and the feedback loop you create the moment a prediction changes what a respondent is asked.

One framing worth fixing up front. The platform **already fits models to responses**: conjoint part-worths come out of a Newton–Raphson conditional logit (`stats/choice.ts:27`), MaxDiff utilities out of the same fitter, NPS driver analysis out of an OLS with standardised betas (`analyses/business.ts:59`). What it has never done is **keep** a fitted model, version it, and point it at a respondent who has not finished answering. That gap — persistence and inference, not estimation — is the project.

## What already exists

| | where |
|---|---|
| OLS, IRLS logistic, softmax-Newton multinomial | `stats/regression.ts:64, :114, :171` |
| Conditional logit with McFadden R² and hit rate | `stats/choice.ts:27` |
| k-means++, Ward/average hierarchical, silhouette | `stats/multivariate.ts:34` |
| PCA/factor, varimax, KMO, **per-case factor scores** | `stats/multivariate.ts:177` |
| Matrix inverse, symmetric eigen, normal/t/F/χ² | `stats/matrix.ts`, `stats/distributions.ts` |
| Respondent × variable feature matrix | `dataset.ts:256` `buildDataset()` |
| Automatic feature typing, 8 roles, real ordinal detection | `dataset.ts:90` `roleFor()` |
| Dummy encoding with reference levels | `analyses/statistics.ts:210` `predictorColumns()` |
| ~50 `SYSTEM_*` telemetry variables per respondent | `quality/engine.ts:181` |
| A human label sitting unused in the DB | `responses.review_status` — `0005:31` |
| Server-resolved calc function, end to end | `aiFunctions.ts:75`, `/api/session/ai` |
| The mid-interview slot a score must land in | `Runner.tsx:888` |
| Metering that degrades rather than blocks | `metering.ts:65` |
| One result shape every surface renders | `AnalysisResult` — `types.ts:149` |

`packages/analytics` pulls **zero** maths libraries; eleven of twelve packages have no non-workspace runtime dependencies at all. There is no WASM or native-binary precedent anywhere in the repo.

## What is missing

- **Model persistence.** Every fit is discarded when the request returns. Nearest precedent to copy: `analytics_report_versions.snapshot` (`0011:123`) — frozen numbers, provenance, immutable, versioned.
- **Train/validate splitting** beyond the conjoint holdout hit rate (`analyses/choice.ts:86`).
- **Classification metrics** — no ROC-AUC, confusion matrix, F1, log-loss, Brier, calibration or k-fold CV.
- **Tree ensembles** — no CART, forest or boosting.
- **Write-back to a respondent.** `rescript_update_response` has a `p_calculated` slot and every caller passes `null` (`data/[responseId]/route.ts:139`).
- **Background job execution.** No queue, worker, cron or Edge Function anywhere, and its absence is deliberate: *"No scheduler, so nothing to fail"* (`0009:340`).

## The two hard truths

**The label problem.** A model trained on "how likely are you to buy" predicts the answer to that question, not the purchase. Every use case splits in two: *in-survey outcomes* (NPS, screener result, quota cell, break-off, reviewer KEEP/REMOVE) train today with no new data; *external outcomes* (real churn, real purchase) need a join key and an outcome file. `respondents.external_id` and `rescript_import_responses` exist; the join does not. Say which kind a project is, in the UI, on the model card.

**The feedback loop.** The moment a prediction changes what a respondent is asked, the next model trains on data whose missingness the previous model caused — and the metrics keep looking excellent because they are measured on the same contaminated data. The fix is cheap designed in and near-impossible retrofitted: a **holdout stream**, a seeded ~10% who always get the unmodified flow, the only cohort used for training and for measuring lift. Seeded assignment (`random.ts:4`) and weighted arms (`adaptive.ts:83`) already exist; it needs to be a property of the deployment, not a checkbox a researcher can forget.

**A third, smaller one.** Coefficients are commercially sensitive, so the model cannot ship inside the pinned definition however tempting the zero latency is. Scoring stays server-side.

## Architecture

| layer | today | addition |
|---|---|---|
| Survey / runtime | client-side flow; server called per page only when something is due | `predict()` in the DSL; `/api/session/predict` in the existing slot; value onto a hidden question |
| Data / analytics | `buildDataset()` → typed cases | `buildTrainingMatrix()` — encode, impute, standardise, stratified split; outcome-file join |
| ML / training | fitters exist, results discarded | new `packages/predict`: penalties, trees, CV, metrics, calibration, contributions |
| Inference | — | one pure `score()` used by both the live route and batch, so they cannot diverge |
| Database | 25 migrations, `pgcrypto` only | `predictive_models`, `_model_versions`, `_deployments`, mirroring `analytics_*` RLS |
| Dashboard / reporting | `AnalysisResult` → blocks, widgets, PPTX, XLSX | **nothing** — add `predictive` to `RUNNERS` |

**The model-version record** must carry the artefact (coefficients or trees), the **feature schema** (encoded column list, reference levels, imputation values, standardisation constants — without it, scoring silently drifts the first time a question is edited), the provenance (survey version, revision, filter, environment, n, holdout definition), and metrics kept separately for training, CV and holdout. Immutable; retraining makes a new version; deployment points at a version.

## Live scoring

The slot is documented three times in the codebase: after the page's answers validate and **before** `advance()` — so a rule or quota on the next page sees the value rather than a blank. `runPredictions()` between `Runner.tsx:888` and `:896`.

Compute is negligible (a dot product); the cost is one HTTP round trip, and only on pages where a prediction is due — the AI hook already skips the call entirely when nothing on the page changed (`Runner.tsx:228`).

It must inherit the AI contract word for word: **a provider that is unconfigured, refused, slow or down changes nothing about the interview.** The value stays `null`, `null` fails every comparison, the rule is false, the respondent moves on.

The value should land on a **hidden question** rather than in `state.calculated`: it gets a question code, a dictionary entry and an export column for free, and `isServerResolvedExpression` already shields it from the on-change recompute (`flow.ts:327`).

## Real time vs asynchronous

Real time: feature assembly (free — `flattenVariables` runs anyway), model fetch (one indexed read, process-cached), scoring, and the write into `state`. On demand: training, cross-validation, batch re-scoring, outcome joins. Deferred: drift monitoring, which wants a scheduler there isn't one of.

**The compute envelope.** IRLS costs ≈ `n·p²/2` per iteration over 10–15 iterations. Keep `n·p²` under about 10⁸ and a cross-validated fit stays inside the 60-second route ceiling (`analytics/[[...path]]/route.ts:14`):

| n | encoded p | per iteration | fit | with 5-fold CV |
|---|---|---|---|---|
| 2,000 | 30 | 9 × 10⁵ | instant | < 1 s |
| 20,000 | 50 | 2.5 × 10⁷ | ~1–2 s | ~8 s |
| 50,000 | 60 | 9 × 10⁷ | ~5 s | ~30 s |
| 100,000 | 100 | 5 × 10⁸ | ~40 s | over budget |

Practically every market-research study fits comfortably. **Stay synchronous for phases 1–2**; introduce a job table only when a real customer's data exceeds the cap. That matches the codebase's own stated preference — *"it runs on demand rather than in a background … needs no scheduler"* (`0008:212`).

## Models

Penalised (ridge/elastic-net) logistic and linear first — battery items are collinear by construction, so an unpenalised fit gives unstable coefficients and a nonsensical driver story. Multinomial is already built and is the segment-assignment model. CART for the picture a client reads out loud; forest and histogram gradient boosting for accuracy. Hierarchical Bayes only at phase 4, for individual-level choice utilities — the one genuinely heavy model, and the only place out-of-process compute is justified.

**Not neural networks.** At n in the thousands with tabular features they lose to penalised GLMs and boosting, cost explainability, and buy nothing a client will believe.

**Class imbalance is a phase-1 requirement, not a refinement.** Fraud, churn and conversion are rare-event problems; a model predicting "no" every time scores 95% accuracy and is worthless. Class weighting, PR-AUC alongside ROC-AUC, and a threshold chosen against a cost matrix rather than left at 0.5.

## The no-code builder

`AnalysisBuilder` is already 80% of it — a six-step stepper with a role-filtered, grouped, searchable `VariablePicker` (`AnalysisBuilder.tsx:48`). The predictive version is the same component with different steps: **Outcome → Predictors → Training data → Model → Validate → Deploy**.

Two guardrails belong in the UI, because they are the mistakes researchers actually make:

- **Leakage** — refuse a predictor asked *after* the outcome, by name and with a reason. The dependency graph already knows flow order (`dependencies.ts:34`).
- **Too few positives** — below ~10 events per predictor the fit is noise. Say so at step 2, while the selection can still change.

New capabilities alongside the four existing analytics ones (`access/roles.ts:100`): `predict.train` (owner/editor/programmer) and `predict.deploy` (owner/editor) — deploying changes what respondents are asked, so it belongs with publishing.

## Explainability

Exact rather than approximated for the recommended models. For a GLM the contribution of feature *j* is `β_j·x_j` and the contributions sum to the logit — that *is* the model. Gain and permutation importance for trees; TreeSHAP (~200 lines, exact) if boosting lands. The researcher-facing form is a sentence, not a chart: *"scored 0.81 — driven by Q4 (visits fewer than twice a month) and Q11 (rated value 2 of 5)."*

## Roadmap

**Phase 0 — make what exists actionable (~1 week).** No new modelling. Write cluster assignments and factor scores back onto the respondent through the unused `p_calculated` slot; surface them in Data, exports and filters; add `analytics.analysis_run` to the audit list. Segmentation stops being a slide and becomes a column — and it proves the write-back path everything else depends on.

**Phase 1 — MVP (~3 weeks).** `packages/predict` (penalised GLMs, class weighting, stratified k-fold, the metric set, calibration, contributions); `buildTrainingMatrix()`; three tables; the six-step builder; evaluation as an `AnalysisResult`; `predict()` and its route, metered; the holdout stream on by default; a `fake:` scorer and `scripts/predict-test.mjs`. Unlocks the typing tool, the learned fraud model, break-off prediction and NPS prediction — none of which need data the platform does not already hold.

**Phase 2 — external outcomes and non-linear models (~4 weeks).** Outcome-file import with a match-rate preview; CART, forest, boosting; importance and TreeSHAP; batch scoring; cost-matrix thresholds; the model card. This is the phase that makes "predictive research platform" defensible.

**Phase 3 — adaptive research (~4 weeks).** Next-best-question by expected uncertainty reduction, bounded by a minimum question set; drift monitoring; lift against the holdout; a job runner *if* the caps have actually bitten.

**Phase 4 — individual-level choice modelling.** HB for conjoint and MaxDiff; an ACBC analysis runner (today the transcript is exported but never modelled); per-respondent elasticity and recommendations; cross-survey training once the consent model is settled.

## Use cases, rated

| use case | trained on | phase |
|---|---|---|
| Segmentation typing tool | cluster label from a prior wave | 1 — the strongest first product, ~90% built |
| Respondent quality / fraud | `review_status` (already in the DB) | 1 — label and features both exist today |
| Break-off prediction | `status ≠ complete` | 1 |
| NPS / promoter prediction | the NPS question | 1 |
| Sentiment / intent | — | ships already (`ai_sentiment`) |
| Product preference | conjoint / MaxDiff choices | 2–4 (needs individual-level utilities) |
| Lead / conversion propensity | external conversion record | 2 |
| Purchase propensity | external transactions | 2 |
| Customer churn | external churn flag | 2 |
| Next-best-question | prediction uncertainty | 3 |
| Price sensitivity | VW / Gabor-Granger | 4 (aggregate curves already ship) |
| Personalised recommendations | predicted preference | 4 |

**On combining survey + historical + behavioural data:** the join key and import path exist; cross-survey access to *answers* does not, deliberately — the one cross-survey read returns quality scores only, never answers, gated behind `config.privacy.longitudinal` (`quality/server.ts:111`). This is a governance decision before an engineering one. Settle consent, retention and pooling before writing the join.

## Build, buy, refuse

**Build in TypeScript with no dependencies** — not conservatism, but what the codebase proves. The same `score()` runs live and in batch so the two cannot disagree; it deploys on Vercel with no new infrastructure; introducing the first WASM or native binary in the repo for a logistic regression would be the most expensive part of the project.

**Buy only at phase 4** — a small Python sidecar (PyMC or a hand-rolled Gibbs sampler) for HB, training-only, returning coefficients. Inference stays in-process.

**Refuse** — managed AutoML (puts a vendor and a network hop between the researcher and a result the platform must version, explain and defend; and it cannot see the variable dictionary, where all the useful typing lives); deep-learning runtimes (megabytes for models that lose to penalised regression at these sample sizes); pgvector until there is an embedding use case; and shipping coefficients to the browser.

**What a new capability ships with**, by the pattern every provider capability follows: a deterministic in-process fake selected by an explicit env value and never as a silent fallback; a `scripts/*-test.mjs` suite (the corpus enrols by filename); co-located `node --test` unit tests; a metering call and a rate row; a `configured` flag on the platform page; an SQL test if it adds a migration.

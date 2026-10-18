# Research intelligence — planning, validation, traceability (2026-10-17)

Engineer D's part of the 17 October brief (sections 5–8 and 16, parts of 7): end-to-end research planning in Intelligent Mode, qualitative / quantitative / mixed support, the advanced methods, one **capability registry**, the **traceability matrix** and one **validation framework**. Mostly guide content and engine checks, not new pipelines. Everything is additive: no schema change, no new dependency, existing research designs and plans load and behave unchanged (the only behaviour change is the action ordering fix in §1).

## 1. What was there, and the gaps found

| Area | Existed | Gap closed |
|---|---|---|
| Research briefs | `set_research` (brief, objective, hypotheses, researchQuestions, constructs, KPIs, audience, sampleSize), plan-first generation, the coverage pass (`coverageReport`), structured hypotheses (`hypotheses.ts`), the plan review (`reviewAnalysisPlan`), `explainPlanItem`, `methodologyAdvice` | The model was never told the planning ORDER, how to pick a method for a pair of variables, what it may call applied or executed, how to build a qualitative guide or a phased mixed design, or which methods run only partly → `COPILOT_RESEARCH_GUIDE` / `COPILOT_QUAL_GUIDE` |
| **Bug** | `applySurveyActions` runs `set_research` after option actions | `set_hypothesis` (and `add_hypothesis`) beside `set_research` in one generation ran FIRST and was refused ("the research design has no hypotheses") — the system prompt asks for exactly that batch; an `add_hypothesis` before a `set_research` list was silently dropped. Hypothesis actions now run after `set_research` (rank 2.5), test in `researchValidation.test.ts` |
| Qualitative | open ends, AI probes (`question.probe`, runtime probe route, `lintProbes`), dictation on every prose field, `video_interview` (recorded + transcribed spoken answer), the AI conversational interviewer, `text_themes` | The copilot had **no action to probe a question**, so Intelligent Mode could not build a probed interview guide → `set_probe` (`researchActions.ts`) |
| Method selection | the analysis guide's rules; the plan review checks dead references, means of categories, 2-group t-tests, binary logistic outcomes | Not checked: a multi-select as the groups of a test, open text in a test, missing outcome/groups, multi-select predictors, method/type mismatches (text themes, ranking, allocation, NPS, TURF, Van Westendorp, funnel, cluster/factor/reliability), chi-square expected counts with no sample → `researchSuitability.ts` |
| Traceability | `hypothesisCoverage`, `questionRelevance`, analytics' `planTrace` (the workspace's result chain, needs plan item views) | No design-level matrix objective → hypothesis → construct → questions → variables → analysis → chart → interpretation → limitations, and no status words that keep an untested hypothesis from reading as a finding → `researchTraceability.ts` |
| Validation | `reviewSurvey` (critical / warning / suggestion), `researchBlockers` (enforced design) | No single research validator with blocking / warning / recommendation over alignment, method suitability, qualitative flow, mixed integration, document consistency and unsupported configurations → `researchValidation.ts` |
| Capabilities | scattered: question type registry, `ANALYSIS_METHODS`, `METHODS` cards, prose in guides | One registry → `capabilities.ts`, generated page `capabilities.md` |

## 2. The capability registry — `packages/engine/src/capabilities.ts`

`capabilityRegistry()` (derived on every call), `capabilityOf(id)`, `capabilitiesMentioned(text)` (for A's refusal / clarify logic: "HB", "focus groups", "sequential monadic" → the record with its status and alternative), `methodologiesNamed(methodology)`, `capabilityBrief()` (ends the research guide — the model is told what exists from the registry) and `capabilityMarkdown()` (the generated public page `apps/studio/content/docs/capabilities.md`, also checked by `gen-public-docs --check`).

It cannot drift: question types are read from `questionTypeRegistry` (a plugin registered later appears), analysis procedures from `ANALYSIS_METHODS`; tests assert every methodology's question types are registered, its actions are in `SURVEY_ACTION_OPS`, its methods in `ANALYSIS_METHODS`; every plan method maps to an `@rescript/analytics` analysis kind (`testDefinition`) and every chart id is in `CHART_CATALOG`; every export names a function that exists in `@rescript/exporters` / `@rescript/analytics` (`researchGuide.test.ts`); an unsupported procedure becoming a method fails the test.

### Methodologies

| Methodology | Status | Questions | Randomisation | Analysis | Chart | Notes |
|---|---|---|---|---|---|---|
| Quantitative survey (descriptive / explanatory) | supported | single_select, multi_select, matrix_single, numeric, nps | option order (set_option_randomization), block order (create_randomizer) | frequencies, crosstab, chi_square, t_test, anova, correlation, regression | bar_horizontal, bar_stacked_100, mean_ci |  |
| Monadic concept test | supported | single_select, matrix_single | a randomizer showing ONE of the concept blocks (show 1); each block sets an embedded arm variable | anova, t_test, chi_square, crosstab | mean_ci, bar_grouped |  |
| Sequential monadic concept test | partial | matrix_single, single_select | a randomizer over the concept blocks, all shown, in random order | mean, top_box, crosstab | bar_grouped, dot_plot | concepts are rotated by a randomizer showing every block; the ORDER a respondent saw is not recorded unless an embedded variable records it, and within-respondent tests (paired t, Wilcoxon, Friedman) run in the Analytics workspace, not from the analysis plan |
| A/B (split) test | supported | single_select | a randomizer showing one stimulus block (show 1) that records the cell | chi_square, t_test | bar_grouped, mean_ci |  |
| MaxDiff (best–worst scaling) | supported | maxdiff_task | a seeded balanced design, versions assigned per respondent, task order randomized | maxdiff_scores | maxdiff_utility | aggregate scores (counts and logit utilities); HB / individual utilities are not estimated — the MaxDiff choice file is the hand-off |
| Choice-based conjoint (CBC) | supported | conjoint_task | a seeded efficient design, versions per respondent, alternatives shuffled | conjoint_utilities | attribute_importance | aggregate logit part-worths, importances and share simulation; HB / latent class not estimated (the stacked CBC file is the hand-off) |
| Menu-based conjoint | supported | conjoint_task | a seeded design over the prices | conjoint_utilities | attribute_importance | aggregate analysis only |
| Adaptive CBC (ACBC) | supported | acbc_task | adaptive screening and tournament | conjoint_utilities | attribute_importance | aggregate analysis only |
| TURF (reach and frequency) | supported | multi_select, matrix_single | item order randomized | turf | bar_horizontal |  |
| Ranking / preference order | supported | ranking | item order randomized | ranking_scores | ranking_bar |  |
| Constant sum / allocation | supported | allocation | item order randomized | allocation_shares | bar_horizontal |  |
| Van Westendorp price sensitivity | supported | numeric | none (fixed order) | pricing | price_sensitivity | the four prices are planned as one pricing item over four numeric questions in the order too cheap, cheap, expensive, too expensive |
| Gabor–Granger demand | partial | single_select | none (ascending prices) | pricing | demand_curve | the questions are built here and the Analytics workspace runs Gabor–Granger (prices, accept codes), but a planned pricing item runs Van Westendorp — the plan cannot select Gabor–Granger yet |
| Segmentation (cluster) | partial | matrix_single | battery row order randomized | factor, cluster | segment_size | k-means / hierarchical clustering on a basis battery; latent-class and typing tools are not available |
| Brand funnel / equity | partial | multi_select, single_select | brand order randomized | brand_funnel | funnel_brand | the funnel (awareness → consideration → usage → preference) and conversion are run from stage questions over one brand list; composite brand-equity models are not |
| Key driver analysis | supported | matrix_single, single_select | battery row order randomized | regression, driver_analysis | coefficient_plot |  |
| Qualitative interview guide (self-completion, AI-probed) | supported | long_text, open_text | none (a guide flows) | text_themes | word_cloud | open-ended questions with AI follow-up probes, typed or dictated; themes are keyword-coded counts |
| Video / voice responses | partial | video_interview | none | text_themes | word_cloud | a video_interview question plays a stimulus and records a spoken answer, which is transcribed; dictation works on every open text field; video of the respondent is not recorded in surveys |
| Mixed methods (phased) | partial | long_text, single_select, matrix_single | per phase | text_themes, crosstab, chi_square, regression | word_cloud, bar_grouped | both phases are designed here (a qualitative guide, then the quantitative survey from its propositions) and recorded in the research design; nothing hands qualitative themes to the quantitative phase automatically |

### Analytical procedures

| Capability | Status | What works / the alternative |
|---|---|---|
| Frequencies | supported |  |
| Mean | supported |  |
| Median | supported |  |
| Top / bottom box | supported |  |
| NPS | supported |  |
| Crosstab / banner | supported |  |
| Chi-square test | supported |  |
| t-test (two groups) | supported |  |
| One-way ANOVA | supported |  |
| Mann–Whitney | supported |  |
| Kruskal–Wallis | supported |  |
| Correlation | supported |  |
| Linear regression (moderation, mediation) | supported |  |
| Logistic regression | supported |  |
| Factor analysis / PCA | partial | exploratory (PCA / rotation); no confirmatory model |
| Reliability (Cronbach's α) | supported |  |
| Cluster analysis | partial | k-means / hierarchical; no latent class |
| Conjoint utilities | partial | aggregate logit; no HB / latent class |
| MaxDiff scores | partial | counts and aggregate utilities; no HB |
| TURF | supported |  |
| Driver analysis | supported |  |
| Text themes / sentiment | partial | word / phrase counts, lexicon sentiment, keyword coding frame; no AI coding, no quotes |
| Ranking scores | supported |  |
| Allocation shares | supported |  |
| Pricing (Van Westendorp / Gabor–Granger) | partial | a planned item runs Van Westendorp; Gabor–Granger from the Analytics workspace |
| Brand funnel | partial | stages read in variable order (awareness → … → preference) |
| Hierarchical Bayes (individual utilities) | not supported | aggregate logit is run; export the MaxDiff choice file / stacked CBC file for HB elsewhere |
| Latent class analysis | not supported | k-means / hierarchical cluster instead |
| Structural equation modelling / CFA | not supported | regression (moderation, mediation), exploratory factor analysis and reliability instead |
| Multilevel / mixed-effects models | not supported | regression with a group control instead |
| Automatic AI coding of open text | not supported | text_themes: counts, sentiment, a keyword coding frame |
| Paired / repeated-measures tests in the analysis plan | partial | paired t, Wilcoxon and Friedman run in the Analytics workspace; the plan's methods are between-group |

### Qualitative support

| Capability | Status | What works / the alternative |
|---|---|---|
| Moderated live interviews / focus groups | not supported | Studio surveys are self-completion; write the guide as a self-completion interview with AI probes (the Interviews app records and transcribes hiring interviews, not research guides) |
| Selected quotes in reports | not supported | open answers are exported and themes counted; quotes are chosen by hand |
| Open-ended questions (short / essay) | supported |  |
| AI follow-up probes on open ends | supported | up to 5 per question, gated by conditions; fixed wording or written by the AI at run time |
| Spoken answers (dictation) on open text | supported | on by default on every prose field |
| Recorded audio answers with transcription | partial | video_interview questions only |
| AI conversational interviewer (voice) | supported | reads the programmed survey aloud and takes spoken answers; the survey stays the authority |
| Theme coding of open answers | partial | word / phrase counts, lexicon sentiment, keyword coding frame; no AI coding, no quotes |

Question types (all registered types, with the ones the copilot cannot create directly) and exports are in the generated page.

## 3. Traceability — `researchTraceability(def, results?)`

Built from the configuration (research design, question analysis tags, constructs, the analysis plan), never from the model's words. One row per hypothesis and per research question without one: objective, statement and reading, constructs (measured?), questions with variable and measurement level, the planned analyses (method, variables, missing ones, `compatible`, inferential or descriptive, chart from `METHOD_CHART`), visualisations, **status**, interpretation sentence, limitations (from `explainPlanItem`, the required base vs the expected sample, causal-reading and qualitative caveats). Plus the variable mapping (`questions[].serves`) and the gaps.

Status words: **Planned — not yet tested** (measured, an inferential analysis planned, nothing run); **Untested** (unmeasured, or nothing planned reads it); **Descriptive only**; and only when a run is handed in: **Tested — supported / not supported / mixed**, **inconclusive** (the family-corrected verdict is the one read). The researcher's own recorded status is shown as `researcherStatus`, never as a result; the validator warns when a hypothesis is recorded as supported with no run.

Gaps (`code`, `severity`): `hypothesis_unmeasured` (blocking — incl. a side the statement names that resolves to no construct and no tagged question), `hypothesis_no_analysis`, `construct_unmeasured`, `question_serves_nothing` (a guide's warm-up / wrap-up exempt), `analysis_missing_variable`, `analysis_incompatible` (the suitability rules), `kpi_no_variable`, `research_question_unexplored`, `no_objective`, `no_design`.

**For B (Word plan):** `researchTraceability(def, run?)` → `{ rows, gaps, questions, counts, summary, executed }`; `traceabilityTable(t)` → `string[][]` with the columns `TRACEABILITY_COLUMNS` (Objective / research question, Hypothesis, Constructs, Questions, Variables, Analysis, Visualisation, Interpretation, Limitations). `run` is `{ verdicts: [{label, verdict, reason?, corrected?}], at? }` — an analytics `StudyFindings` / stored run fits as it is.

## 4. Validation — `validateResearch(def, { review?, results? })`

One validator, three classes: **blocking** (cannot answer its question or cannot run), **warning** (runs, weaker or wrong evidence), **recommendation**. It takes the survey review whole (critical → blocking, warning → warning, suggestion → recommendation; logic, reachability, wording incl. leading / double-barrelled, options, scales, duplicates, length, the plan review, quotas, languages, the enforced design's blockers) and adds, without repeating what the review says:

- alignment — the traceability gaps;
- method suitability — `planItemSuitability` rules (`group_multi`, `text_in_test`, `no_outcome`, `predictor_multi`, `method_type`, `expected_counts` — said once for the whole plan, `mean_of_categories` left to the review);
- unsupported configurations — what the methodology / anticipated analyses name that the registry marks partial or not supported;
- document consistency — "supported" with no run; anticipated analyses with no plan;
- qualitative — probe coverage (with a `set_probe` fix the Review tab previews), probe lint, too few open questions, the guide opening on the core topic, no wrap-up, no research questions / topics, no text-themes plan, hypotheses in a qualitative study;
- quantitative — no sample, duplicate / non-portable variable names, optional analysis variables, unbounded numerics, long nominal lists with no Other / Don't know;
- mixed — a hypothesis tagged on text themes, one side (research questions or hypotheses) unrecorded, phases not connected in the methodology.

`studyKind(def)` reads quantitative / qualitative / mixed from the methodology's words, else the share of open questions.

**Where the researcher sees it** (existing UI, no parallel one): the Review tab (`runReview` / `showReview`) shows `cp-validation` (kind and the three counts), the research items merged into its Critical / Warning / Suggestion groups (`data-source="research"`, fixes previewable), and a `cp-trace` section with the matrix rows (`data-status`) and gaps (`data-code`). A generated study's card shows `cp-proposal-validation` (counts + traceability summary on the proposed survey).

## 5. Qualitative, quantitative, mixed

- **Qualitative — supported as a self-completion interview guide**: warm-up → one block per research question (2–4 open questions) → wrap-up; `set_probe` on each topic question (1–5 AI follow-ups, instruction or fixed wording, min words, conditions); topics recorded as research questions and descriptive constructs (the mapping the matrix reads); `text_themes` per topic. Spoken answers: dictation everywhere; `video_interview` records a transcribed spoken answer (added in the Studio editor). **Not supported**: moderated live interviews / focus groups (the Interviews app is a hiring-interview product with moderated recording, not research guides), video of the respondent, automatic AI coding, quotes inserted into reports (text analysis computes example answers but does not output them).
- **Quantitative**: selection rules explicit in the guide and enforced by the engine (above).
- **Mixed**: a phased plan — Phase 1 probed open questions → propositions → Phase 2 hypotheses; qualitative evidence never tagged as a hypothesis test; recorded in methodology / researchQuestions / hypotheses. Nothing hands themes to phase 2 automatically (partial in the registry).
- **Advanced methods** (guide + registry): MaxDiff, CBC, menu, ACBC (supported — aggregate estimation), monadic and A/B (randomizer show 1 + recorded arm), sequential monadic (partial — order not recorded; paired tests only in Analytics), TURF, ranking, allocation, Van Westendorp (supported — four numeric prices in order), Gabor–Granger (partial — the plan runs Van Westendorp), segmentation (partial — no latent class), brand funnel (partial — no equity model), drivers. Unsupported estimators (HB, latent class, SEM/CFA, multilevel): the guide tells the model to write the specification into assumptions and say it is not executable.

## 6. Files

Engine: `capabilities.ts`, `researchActions.ts` (`set_probe`), `researchSuitability.ts`, `researchTraceability.ts`, `researchValidation.ts`, `researchFixtures.ts` (tests only), tests `capabilities.test.ts`, `researchTraceability.test.ts`, `researchValidation.test.ts`; `surveyActions.ts` (set_probe wiring; hypothesis-action order); `index.ts` exports. Studio: `lib/copilot/researchGuide.ts` (+ test), hooks in `prompt.ts` (`researchPlan` / `qual`, default from the message and mode, inside the non-plan-stage guides) and `aiPromptCache.ts`; Review tab and card (`CopilotPanel.tsx`, `CopilotCard.tsx`, existing classes only); `lib/docs/pages.ts`; `scripts/lib/publicDocs.mjs` (capabilities page, qualitative actions block); tests touched: `aiPromptCache.test.ts`, `copilot.test.ts` (documented ops include the qualitative guide), `docs/markdown.test.ts`. Browser suite: `scripts/research-intelligence-test.mjs`.

## 7. Not done, and why

- The route's `context` does not report the research/qualitative guide flags (the route is A's); the lib tests cover selection.
- `add_analysis_test` still refuses a derived variable created in the same batch (by design in `analysisActions.ts`, "creation resolves questions only"); the guide plans tests on the questions.
- Quotes in reports, AI theme coding, Gabor–Granger from the plan, paired tests in the plan, recording the sequential-monadic order: real product gaps, recorded as partial / not supported rather than built here.
- No HB / latent class / SEM estimators — specification only.

import { ANALYSIS_METHODS, questionTypeRegistry, resolveVariant, type AnalysisMethod } from "@rescript/schema";
import { registerBuiltinQuestionTypes } from "./questionTypes.js";
import { ACTION_TYPES, SURVEY_ACTION_OPS } from "./surveyActions.js";

/**
 * THE CAPABILITY REGISTRY (Research intelligence, 2026-10-17) — what the
 * platform supports, partly supports and does not support, in ONE place:
 * methodologies, question types, analytical procedures, qualitative support
 * and exports. The research guide tells the model what exists from here, the
 * copilot's refusal / clarify logic can ask it (`capabilitiesMentioned`), the
 * validator flags an unsupported configuration with it, and the public page
 * `capabilities.md` is generated from it.
 *
 * It cannot drift silently: the question types are READ from the question
 * type registry, the analytical procedures from the plan's method vocabulary
 * (`ANALYSIS_METHODS`, every one of which `@rescript/analytics` runs — checked
 * by its own test), the actions a methodology names must be in
 * `SURVEY_ACTION_OPS`, its question types registered and its methods in
 * `ANALYSIS_METHODS` (`capabilities.test.ts`); the exports name the function
 * that makes them (checked in the Studio's tests, which see the exporters).
 *
 * Pure: no I/O, no model.
 */

/**
 * supported · partial (says what works) · requires_configuration (works once
 * an operator configures the service it needs — `capabilityReadiness` says
 * whether THIS installation has) · not_supported (names the alternative).
 */
export type CapabilityStatus = "supported" | "partial" | "requires_configuration" | "not_supported";
/** the category: "platform" = a platform service (the language model, translation, retrieval, voice), "reporting" = documents and report artefacts beyond the file exports */
export type CapabilityKind = "methodology" | "question_type" | "analysis" | "qualitative" | "export" | "reporting" | "platform";

/**
 * ONE CAPABILITY (§11, 2026-10-18: the full shape). Only `id`, `kind`, `name`
 * and `status` are required when an entry is WRITTEN; `capabilityRegistry()`
 * returns every entry with every field filled (`CapabilityRecord`), the
 * defaults derived from the kind. An entry that needs configuration names the
 * SERVICES it needs (keys of `SERVICES`); the environment variables come from
 * the service, so they are written once.
 *
 * Adding an entry (E2/E3/E4): append to `METHODOLOGIES`, `UNSUPPORTED_PROCEDURES`,
 * `EXPORTS`, `PLATFORM_CAPABILITIES` or `EXTRA_CAPABILITIES` below; a new
 * external dependency is a new `SERVICES` entry. `capabilities.test.ts` checks
 * the shape, the services and the env names.
 */
export interface Capability {
  /** stable id: "methodology:maxdiff", "question_type:ranking", "analysis:t_test", "export:spss" */
  id: string;
  /** the category */
  kind: CapabilityKind;
  /** display name */
  name: string;
  status: CapabilityStatus;
  /** partial: what works and what does not; not_supported: the supported alternative */
  note?: string;
  /** how it is built here — question types, actions, analysis methods */
  implementedAs?: { questionTypes?: string[]; actions?: string[]; analysis?: AnalysisMethod[] };
  /** words a request uses for it — `capabilitiesMentioned` matches them */
  aliases?: RegExp;
  /** the services it depends on (keys of SERVICES) — their env vars are its required configuration */
  services?: string[];
  /** what it accepts: "research brief", "a multi_select question", "audio (webm/mp4/wav)" */
  inputs?: string[];
  /** what runs it: "actions:create_maxdiff", "analysis:t_test", "route:POST /api/ai/transcribe", "export:@rescript/exporters#responsesToSav" */
  handler?: string;
  /** the checks applied before it runs / is accepted */
  validation?: string[];
  /** the shape of what it produces (a schema or type name) */
  outputSchema?: string;
  /** known limitations, beyond `note` */
  limitations?: string[];
  /** the suites that cover it (unit test files, browser suites) */
  tests?: string[];
  /** the version of this entry (a date, "2026-10-18") */
  version?: string;
}

/** a registry entry as `capabilityRegistry()` returns it: every field present */
export interface CapabilityRecord extends Capability {
  category: CapabilityKind;
  services: string[];
  /** the environment variables its services need (names only, never values) — "A | B" means either */
  configuration: string[];
  inputs: string[];
  handler: string;
  validation: string[];
  outputSchema: string;
  limitations: string[];
  tests: string[];
  version: string;
}

/** A methodology, from objective to chart — what the research guide teaches and the traceability reads. */
export interface MethodologySpec {
  id: string;
  name: string;
  status: CapabilityStatus;
  note?: string;
  /** what it answers */
  objective: string;
  /** what the researcher decides: items, attributes and levels, prices, arms */
  designParameters: string;
  questionTypes: string[];
  actions: string[];
  randomisation: string;
  dataCapture: string;
  analysis: AnalysisMethod[];
  /** the chart(s) the analytics recommends for it (`@rescript/analytics` chart ids) */
  charts: string[];
  aliases: RegExp;
  /** services it depends on (keys of SERVICES), when it needs configuration */
  services?: string[];
}

export const METHODOLOGIES: readonly MethodologySpec[] = [
  { id: "survey", name: "Quantitative survey (descriptive / explanatory)", status: "supported", objective: "levels, shares and relationships in a population", designParameters: "constructs and their measures, the sample and its quotas", questionTypes: ["single_select", "multi_select", "matrix_single", "numeric", "nps"], actions: ["create_question", "set_research", "set_question_analysis", "create_quota"], randomisation: "option order (set_option_randomization), block order (create_randomizer)", dataCapture: "one variable per question (grids: one per row)", analysis: ["frequencies", "crosstab", "chi_square", "t_test", "anova", "correlation", "regression"], charts: ["bar_horizontal", "bar_stacked_100", "mean_ci"], aliases: /\bsurvey\b|\bquestionnaire\b|\bquantitative\b|\bquant\b/i },
  { id: "monadic", name: "Monadic concept test", status: "supported", objective: "how each concept performs on its own, compared between cells", designParameters: "the concepts (one block each), the KPI battery asked after every concept, cells sized for the comparison", questionTypes: ["single_select", "matrix_single"], actions: ["create_randomizer", "create_embedded", "add_analysis_test"], randomisation: "a randomizer showing ONE of the concept blocks (show 1); each block sets an embedded arm variable", dataCapture: "the arm variable + the KPI battery", analysis: ["anova", "t_test", "chi_square", "crosstab"], charts: ["mean_ci", "bar_grouped"], aliases: /\bmonadic\b(?!\s*sequential)|\bconcept test/i },
  { id: "sequential_monadic", name: "Sequential monadic concept test", status: "partial", note: "concepts are rotated by a randomizer showing every block; the ORDER a respondent saw is not recorded unless an embedded variable records it, and within-respondent tests (paired t, Wilcoxon, Friedman) run in the Analytics workspace, not from the analysis plan", objective: "several concepts rated by each respondent", designParameters: "the concepts, the same battery per concept, rotation", questionTypes: ["matrix_single", "single_select"], actions: ["create_randomizer", "create_embedded"], randomisation: "a randomizer over the concept blocks, all shown, in random order", dataCapture: "one battery per concept", analysis: ["mean", "top_box", "crosstab"], charts: ["bar_grouped", "dot_plot"], aliases: /\bsequential[\s-]?monadic\b/i },
  { id: "ab_test", name: "A/B (split) test", status: "supported", objective: "one stimulus against another, between respondents", designParameters: "the cells, the outcome", questionTypes: ["single_select"], actions: ["create_randomizer", "create_embedded", "add_analysis_test"], randomisation: "a randomizer showing one stimulus block (show 1) that records the cell", dataCapture: "the cell variable + the outcome", analysis: ["chi_square", "t_test"], charts: ["bar_grouped", "mean_ci"], aliases: /\ba\/b\b|\bab test\b|\bsplit[\s-]test\b/i },
  { id: "maxdiff", name: "MaxDiff (best–worst scaling)", status: "supported", note: "aggregate scores (counts and logit utilities) and individual-level HB utilities, both from the plan (method hb runs as a background job); the MaxDiff choice file is the hand-off for other tools", objective: "relative importance of 8–30 items on one ratio scale", designParameters: "the items; items per task, tasks and versions are sized by the engine", questionTypes: ["maxdiff_task"], actions: ["create_maxdiff", "update_maxdiff"], randomisation: "a seeded balanced design, versions assigned per respondent, task order randomized", dataCapture: "best and worst per task, the version", analysis: ["maxdiff_scores", "hb"], charts: ["maxdiff_utility"], aliases: /\bmax[\s-]?diff\b|\bbest[\s-]?worst\b/i },
  { id: "cbc", name: "Choice-based conjoint (CBC)", status: "supported", note: "aggregate logit part-worths, importances and simulator (logit / first choice / randomized first choice, revenue, WTP, demand, optimisation, segments) from the plan; individual-level HB from the plan (method hb, a background job) or Data Analytics; dual-response None (both codings) and brand-specific / labelled designs; latent-class choice models not estimated", objective: "trade-offs between attribute levels, price included", designParameters: "attributes and their levels, prohibitions, None or dual-response None, brand-specific attributes or labelled alternatives; alternatives, tasks and versions sized by the engine", questionTypes: ["conjoint_task"], actions: ["create_conjoint", "update_conjoint"], randomisation: "a seeded efficient design, versions per respondent, alternatives shuffled", dataCapture: "the chosen alternative per task, the design row", analysis: ["conjoint_utilities", "hb"], charts: ["attribute_importance"], aliases: /\bconjoint\b|\bcbc\b|\bchoice[\s-]?based\b|\bdiscrete choice\b/i },
  { id: "menu_conjoint", name: "Menu-based conjoint", status: "supported", note: "take-rate counts; per-item binary logits with own and selected cross-price effects, a multinomial logit per exclusive section, aggregate and HB; menu simulator (take rates, revenue, price curves, bundles)", objective: "which priced add-ons are chosen together", designParameters: "the menu items and their prices, required items, exclusive sections, selections", questionTypes: ["conjoint_task"], actions: ["create_conjoint", "update_conjoint", "simulate_conjoint"], randomisation: "a seeded design over the prices", dataCapture: "the items chosen per task", analysis: ["conjoint_utilities"], charts: ["attribute_importance"], aliases: /\bmenu[\s-]?based\b|\bbuild[\s-]?your[\s-]?own\b/i },
  { id: "acbc", name: "Adaptive CBC (ACBC)", status: "supported", note: "BYO, screening (vs a threshold), unacceptable / must-have rules and the tournament coded into one model: aggregate logit + counts, and HB in Data Analytics; optional summed price (linear); simulator", objective: "trade-offs for many attributes, adapted to the respondent", designParameters: "attributes and levels, screening tasks, optional summed price", questionTypes: ["acbc_task"], actions: ["create_conjoint", "update_conjoint", "simulate_conjoint"], randomisation: "adaptive screening and tournament", dataCapture: "screening, must-haves, tournament choices", analysis: ["conjoint_utilities"], charts: ["attribute_importance"], aliases: /\bacbc\b|\badaptive (?:cbc|choice)\b/i },
  /* F4 2026-10-22: rating-based (CVA) conjoint */
  { id: "cva_conjoint", name: "Rating-based conjoint (CVA)", status: "supported", note: "per-respondent least squares (optional monotone ties), R² and flat-rater flags, importances, simulator (first choice / BTL / logit); no HB (not a choice model)", objective: "part-worths from ratings of full profiles or pairs", designParameters: "attributes and levels, prohibitions, single profiles or pairs, the rating scale; profiles and versions sized by the engine", questionTypes: ["conjoint_task"], actions: ["create_conjoint", "update_conjoint", "simulate_conjoint"], randomisation: "a D-optimal fractional factorial per version, task order shuffled", dataCapture: "a rating per profile or pair", analysis: ["conjoint_utilities"], charts: ["attribute_importance"], aliases: /\bcva\b|\brating[\s-]?based conjoint\b|\bratings?[\s-]based\b|\bfull[\s-]?profile\b/i },
  { id: "turf", name: "TURF (reach and frequency)", status: "supported", objective: "which combination of items reaches the most people", designParameters: "the items and the reach measure (would buy / consider)", questionTypes: ["multi_select", "matrix_single"], actions: ["create_question", "add_analysis_test"], randomisation: "item order randomized", dataCapture: "one 0/1 per item (a multi-select, or a grid recoded to top box)", analysis: ["turf"], charts: ["bar_horizontal"], aliases: /\bturf\b|\breach and frequency\b|\bline[\s-]?up optimi[sz]/i },
  { id: "ranking", name: "Ranking / preference order", status: "supported", objective: "a strict order of a short list", designParameters: "up to ~7 items", questionTypes: ["ranking"], actions: ["create_question"], randomisation: "item order randomized", dataCapture: "a rank per item", analysis: ["ranking_scores"], charts: ["ranking_bar"], aliases: /\brank(?:ing)?\b|\bpreference order\b/i },
  { id: "allocation", name: "Constant sum / allocation", status: "supported", objective: "share of preference or spend across items", designParameters: "the items and the total", questionTypes: ["allocation"], actions: ["create_question"], randomisation: "item order randomized", dataCapture: "an amount per item summing to the total", analysis: ["allocation_shares"], charts: ["bar_horizontal"], aliases: /\bconstant[\s-]?sum\b|\ballocat(?:e|ion)\b/i },
  { id: "van_westendorp", name: "Van Westendorp price sensitivity", status: "supported", note: "the four prices are planned as one pricing item over four numeric questions in the order too cheap, cheap, expensive, too expensive", objective: "the acceptable price range of one concept", designParameters: "the concept shown before the four price questions, the currency", questionTypes: ["numeric"], actions: ["create_question", "add_analysis_test"], randomisation: "none (fixed order)", dataCapture: "four prices per respondent", analysis: ["pricing"], charts: ["price_sensitivity"], aliases: /\bvan[\s-]?westendorp\b|\bpsm\b|\bprice sensitivity\b/i },
  { id: "gabor_granger", name: "Gabor–Granger demand", status: "supported", note: "a pricing item with method gabor_granger and one price per purchase-intent question, planned from the questions' own prices when they state them: demand curve, revenue index and the revenue-maximising price", objective: "demand and revenue at set price points", designParameters: "ascending price points, the purchase-intent scale and which answers count as buying", questionTypes: ["single_select"], actions: ["create_question"], randomisation: "none (ascending prices)", dataCapture: "purchase intent at each price", analysis: ["pricing"], charts: ["demand_curve"], aliases: /\bgabor[\s-]?granger\b|\bdemand curve\b/i },
  { id: "segmentation", name: "Segmentation (cluster / latent class)", status: "partial", note: "k-means / hierarchical clustering on a basis battery, and latent class analysis of categorical indicators (K compared by BIC), from the plan; no covariates in the latent class model; typing tools are not available", objective: "groups of respondents with different needs or behaviour", designParameters: "the basis battery (needs / attitudes), the number of segments", questionTypes: ["matrix_single"], actions: ["add_analysis_test"], randomisation: "battery row order randomized", dataCapture: "the battery ratings", analysis: ["factor", "cluster", "latent_class"], charts: ["segment_size"], aliases: /\bsegmentation\b|\bclusters?\b|\bpersonas?\b/i },
  { id: "brand_funnel", name: "Brand funnel / equity", status: "partial", note: "the funnel (awareness → consideration → usage → preference) and conversion are run from stage questions over one brand list; composite brand-equity models are not", objective: "conversion between brand stages, by brand", designParameters: "the brand list, the stages", questionTypes: ["multi_select", "single_select"], actions: ["create_question", "add_analysis_test"], randomisation: "brand order randomized", dataCapture: "one multi-select per stage over the same brand codes", analysis: ["brand_funnel"], charts: ["funnel_brand"], aliases: /\bbrand (?:funnel|equity|health)\b|\bawareness\b.*\bconsideration\b/i },
  { id: "driver_analysis", name: "Key driver analysis", status: "supported", objective: "which attributes move an outcome", designParameters: "the attribute battery and the outcome", questionTypes: ["matrix_single", "single_select"], actions: ["add_analysis_test"], randomisation: "battery row order randomized", dataCapture: "attribute ratings + the outcome", analysis: ["regression", "driver_analysis"], charts: ["coefficient_plot"], aliases: /\bkey drivers?\b|\bdriver analysis\b/i },
  { id: "qual_self_completion", name: "Qualitative interview guide (self-completion, AI-probed)", status: "supported", note: "open-ended questions with AI follow-up probes, typed or dictated; themes are keyword-coded counts", objective: "explore reasons, language and experiences in depth", designParameters: "the topics (one block per research question), probes per question", questionTypes: ["long_text", "open_text"], actions: ["create_question", "set_probe"], randomisation: "none (a guide flows)", dataCapture: "the answer and each probe's question and answer", analysis: ["text_themes"], charts: ["word_cloud"], aliases: /\bqualitative\b|\binterview guide\b|\bdiscussion guide\b|\bin[\s-]depth\b|\bopen[\s-]ended\b|\bprob(?:e|es|ing)\b/i },
  { id: "video_response", name: "Video / voice responses", status: "partial", note: "a video_interview question plays a stimulus and records a spoken answer, which is transcribed; dictation works on every open text field; video of the respondent is not recorded in surveys", objective: "spontaneous spoken reactions", designParameters: "the stimulus video, retakes", questionTypes: ["video_interview"], actions: [], randomisation: "none", dataCapture: "audio + transcript", analysis: ["text_themes"], charts: ["word_cloud"], aliases: /\bvideo (?:response|answer|interview)\b|\bvoice (?:response|answer)s?\b|\baudio answers?\b/i },
  { id: "mixed_methods", name: "Mixed methods (phased)", status: "partial", note: "both phases are designed here (a qualitative guide, then the quantitative survey from its propositions) and recorded in the research design; nothing hands qualitative themes to the quantitative phase automatically", objective: "explore first, then measure", designParameters: "phase 1 topics, phase 2 hypotheses derived from phase 1", questionTypes: ["long_text", "single_select", "matrix_single"], actions: ["set_research", "set_probe", "create_question"], randomisation: "per phase", dataCapture: "per phase", analysis: ["text_themes", "crosstab", "chi_square", "regression"], charts: ["word_cloud", "bar_grouped"], aliases: /\bmixed[\s-]?methods?\b|\bqual(?:itative)?\s*(?:then|→|->|followed by|and)\s*quant/i },
];

/** procedures researchers ask for that the platform does not run — each with the supported alternative */
export const UNSUPPORTED_PROCEDURES: readonly Capability[] = [
  /* E4 2026-10-18: HB, latent class and SEM run in Data Analytics (analysis kinds hb / lca / sem). F3 2026-10-22: they are plan methods too (ANALYSIS_METHODS hb / latent_class / sem) — capabilityRegistry() files these three records under their method (same ids), never twice */
  { id: "analysis:hb", kind: "analysis", name: "Hierarchical Bayes (individual utilities)", status: "supported", note: "from the analysis plan (a background job with progress, started by Apply) or Data Analytics; CBC (incl. dual-response None and brand-specific designs), ACBC (BYO + screening + tournament), menu-based (item logits) and standard MaxDiff: HB-MNL by MCMC with convergence diagnostics (R̂, ESS, Geweke, acceptance), individual utilities, importances and simulation; no anchored-MaxDiff or CVA HB", aliases: /\bhierarchical bayes\b|\bhb\b|\bindividual[\s-]level utilit/i, inputs: ["a conjoint_task (CBC or menu), acbc_task or maxdiff_task question", "chains, burn-in, draws, thinning, seed, prior variance / df"], handler: "analysis:hb (@rescript/analytics models/hb.ts; chunked jobs via POST analytics/models, migration 0066)", validation: ["planCheck: one CBC, ACBC, menu or MaxDiff question; ≤ 200,000 iterations", "runner: ≥ 20 respondents, ≥ 3 tasks per parameter", "R̂ > 1.1 → estimates withheld"], outputSchema: "AnalysisResult tables hb_diagnostics, hb_trace, hb_mean, hb_importance, hb_simulation, hb_fit, hb_vs_aggregate, hb_individual, hb_individual_sd", limitations: ["normal heterogeneity only (no mixture / covariates)", "with few tasks per respondent the default prior (variance 1) inflates scale slightly — documented", "a run longer than one request continues as a job (Data Analytics builder)"], tests: ["packages/analytics/src/models/hb.test.ts", "apps/studio/lib/modelJobs.test.ts", "scripts/advanced-models-test.mjs"], version: "2026-10-18" },
  { id: "analysis:latent_class", kind: "analysis", name: "Latent class analysis", status: "partial", note: "from the analysis plan or Data Analytics; categorical indicators: EM with seeded random starts, K = 1..8 compared by LL / AIC / BIC / SABIC / entropy, profiles and posterior membership; no covariates, distal outcomes or continuous indicators", aliases: /\blatent[\s-]class\b|\blca\b/i, inputs: ["two or more categorical indicators (≤ 15 categories each)", "class range, random starts, seed"], handler: "analysis:lca (@rescript/analytics models/lca.ts)", validation: ["planCheck: ≥ 2 indicators, 1 ≤ K ≤ 8, identification from the code frames", "runner: ≥ 30 complete cases; unidentified / non-converged / empty-class solutions never recommended"], outputSchema: "AnalysisResult tables lca_fit, lca_sizes, lca_profiles, lca_classification, lca_membership", limitations: ["listwise deletion (no FIML)", "no bootstrap LRT", "local-independence model only"], tests: ["packages/analytics/src/models/lca.test.ts", "scripts/stats-reference/lca_reference.py", "scripts/advanced-models-test.mjs"], version: "2026-10-18" },
  { id: "analysis:sem", kind: "analysis", name: "Structural equation modelling / CFA", status: "supported", note: "from the analysis plan (the model built from the research design's constructs and hypotheses, each hypothesis read from its own path) or Data Analytics; lavaan-style syntax (=~, ~, ~~, :=): ML on the covariance matrix, expected-information SEs, χ² / CFI / TLI / RMSEA (90% CI) / SRMR / AIC / BIC, standardised estimates, indirect effects (delta method); no FIML, ordinal (WLSMV), multi-group or bootstrap", aliases: /\bstructural equation\b|\bsem\b|\bconfirmatory factor\b|\bcfa\b|\bpath model/i, inputs: ["model syntax naming numeric / scale variables", "scaling: first loading or unit variance"], handler: "analysis:sem (@rescript/analytics models/sem.ts)", validation: ["planCheck: syntax parsed; scale per factor; t-rule (df ≥ 0); one- / two-indicator factors; variables exist and are numeric", "runner: non-convergence, Heywood cases and a singular information matrix → no estimates or fit indices"], outputSchema: "AnalysisResult tables sem_fit, sem_measurement, sem_structural, sem_covariances, sem_variances, sem_indirect, sem_r2, sem_residuals; chart nodes / links (path diagram)", limitations: ["listwise deletion", "continuous (normal-theory) indicators only", "no mean structure"], tests: ["packages/analytics/src/models/sem.test.ts", "scripts/stats-reference/sem_reference.py", "scripts/advanced-models-test.mjs"], version: "2026-10-18" },
  { id: "analysis:multilevel", kind: "analysis", name: "Multilevel / mixed-effects models", status: "not_supported", note: "regression with a group control instead", aliases: /\bmulti[\s-]?level\b|\bmixed[\s-]effects?\b|\bhierarchical linear\b/i },
  /* E3 2026-10-18: AI-assisted coding exists in Research Tools → Qualitative (needs a language model); the analysis plan's text_themes stays keyword coding */
  { id: "analysis:ai_coding", kind: "analysis", name: "AI-assisted coding of transcripts and open text", status: "requires_configuration", note: "in Research Tools → Qualitative, not the plan; AI-suggested codebook, codes and excerpts (inductive or deductive), redacted before sending, every quote checked verbatim, human review (the plan's text_themes is keyword coding)", aliases: /\bai[\s-]?cod(?:e|ing)\b|\bauto[\s-]?cod(?:e|ing)\b|\bthematic analysis\b|\bcodebook\b/i, services: ["ai_chat"], handler: "route:POST /api/surveys/[id]/qual/coding", inputs: ["transcript segments", "open-ended answers"], validation: ["PII redaction before the model", "quote must be an exact substring of its segment (locateQuote)", "codes need a definition", "bounded batches (12,000 chars / 80 segments, 10 a run)"], outputSchema: "QualState (@rescript/analytics qual)", limitations: ["one model call per batch; a run past 10 batches reports the rest as not sent", "AI codes are suggestions until a person reviews them"], tests: ["qual.test.ts", "qual-research-test"], version: "2026-10-18" },
  { id: "analysis:paired", kind: "analysis", name: "Paired / repeated-measures tests in the analysis plan", status: "partial", note: "paired t, Wilcoxon and Friedman run in the Analytics workspace; the plan's methods are between-group", aliases: /\bpaired t\b|\brepeated[\s-]measures?\b|\bwilcoxon\b|\bfriedman\b/i },
  /* E3 2026-10-18: planning and recording moderated studies is supported (qualitative:moderated_guide, sessions, recordings, transcripts); RUNNING the live session is not */
  /* F1 2026-10-22: AI-moderated 1:1 interviews now run here (qualitative:ai_interviews); a HUMAN-moderated live session and real-time multi-party video conferencing still do not */
  { id: "qualitative:moderated", kind: "qualitative", name: "Live human-moderated sessions / multi-party video conferencing", status: "not_supported", note: "no video conferencing and no real-time multi-party session: run human-moderated interviews and focus groups in your own conferencing or facility, then record the session, upload the recording and import or transcribe the transcript in Research Tools → Qualitative. One-to-one interviews can be run by the AI moderator instead (qualitative:ai_interviews: asynchronous, from a link, text / voice / voice + camera)", aliases: /\brun(?:ning)? (?:\w+ ){0,3}(?:(?<!\bai[\s-])moderated|focus groups?|live interviews?|depth interviews?|idis)\b|\blive (?:interviews?|moderation|sessions?|focus groups?)\b|\breal[\s-]time moderat\w*|\bvideo[\s-]?conferenc\w*|\bmoderate (?:the )?(?:session|group|interview)s? (?:live|in real time)\b/i },
  { id: "qualitative:quotes", kind: "qualitative", name: "Selected quotes in reports", status: "partial", note: "the qualitative report (Research Tools → Qualitative) carries reviewed verbatim excerpts with source, speaker and time; the survey findings deck and report do not", aliases: /\bquotes?\b|\bverbatims?\b/i },
];

/** how each plan method is run, where it is more limited than its name says */
const ANALYSIS_NOTES: Partial<Record<AnalysisMethod, { status: CapabilityStatus; note: string }>> = {
  text_themes: { status: "partial", note: "word / phrase counts, lexicon sentiment, keyword coding frame; AI-assisted coding with verbatim quotes is in Research Tools → Qualitative, not the plan" },
  conjoint_utilities: { status: "partial", note: "aggregate logit (CBC, ACBC, menu item logits) or per-respondent OLS (CVA) with a market simulator; individual-level HB in Data Analytics (Hierarchical Bayes); no latent-class choice model" },
  maxdiff_scores: { status: "partial", note: "counts and aggregate utilities; individual-level HB is the plan's hb method" },
  pricing: { status: "supported", note: "Van Westendorp (four price questions) or Gabor–Granger (method gabor_granger, one price per purchase-intent question) from the plan" },
  brand_funnel: { status: "partial", note: "stages read in variable order (awareness → … → preference)" },
  cluster: { status: "partial", note: "k-means / hierarchical; latent class analysis is the plan's latent_class method" },
  factor: { status: "partial", note: "exploratory (PCA / rotation); confirmatory models are the plan's sem method" },
};

/**
 * WHAT A PLAN METHOD ADDS TO ITS RECORD (2026-10-22): the design-level checks
 * (engine `advancedSuitability`) and the suites that cover planning it. Merged
 * into the method's record — for hb / latent_class / sem the record kept in
 * UNSUPPORTED_PROCEDURES under the same id.
 */
const PLAN_METHOD_EXTRA: Partial<Record<AnalysisMethod, { validation: string[]; tests: string[]; note?: string; version: string }>> = {
  hb: { validation: ["advancedSuitability: one CBC / MaxDiff question with a design; ≥ 4 CBC tasks per respondent (8+ advised) or each MaxDiff item shown ≥ 1 time (3+ advised); ≥ 50 expected completes (200 advised)"], tests: ["packages/engine/src/advancedMethods.test.ts", "scripts/advanced-models-intelligent-test.mjs"], version: "2026-10-22" },
  latent_class: { validation: ["advancedSuitability: ≥ 2 categorical indicators (3+ advised), ≤ 15 categories each, identification from the code frames, ≥ 100 expected completes (300 advised); covariates refused in words"], tests: ["packages/engine/src/advancedMethods.test.ts", "scripts/advanced-models-intelligent-test.mjs"], version: "2026-10-22" },
  sem: { validation: ["advancedSuitability: ≥ 2 indicators per factor (3 advised), numeric / scale indicators, ≥ 100 completes and ≥ 5 per free parameter (200 and 10 advised)", "planCheck: each hypothesis path is a path of the model"], tests: ["packages/engine/src/advancedMethods.test.ts", "scripts/advanced-models-intelligent-test.mjs"], version: "2026-10-22" },
  regression: { validation: ["advancedSuitability (bootstrap): a mediator named; numeric / scale outcome and mediator; 200–20,000 resamples"], tests: ["packages/analytics/src/stats/bootstrap.test.ts"], note: "a mediation's indirect effect is bootstrapped (seeded percentile and BCa intervals) when planned with bootstrap", version: "2026-10-22" },
  reliability: { validation: ["advancedSuitability (omega): ≥ 3 items"], tests: ["packages/analytics/src/models/omega.test.ts"], note: "McDonald's ω from a one-factor CFA beside α when planned with omega", version: "2026-10-22" },
  pricing: { validation: ["advancedSuitability (gabor_granger): ≥ 2 single-choice intent questions, one positive, distinct price each"], tests: ["packages/engine/src/advancedMethods.test.ts"], version: "2026-10-22" },
};

const METHOD_NAMES: Record<AnalysisMethod, string> = {
  frequencies: "Frequencies", mean: "Mean", median: "Median", top_box: "Top / bottom box", nps: "NPS", crosstab: "Crosstab / banner",
  chi_square: "Chi-square test", t_test: "t-test (two groups)", anova: "One-way ANOVA", mann_whitney: "Mann–Whitney", kruskal_wallis: "Kruskal–Wallis",
  correlation: "Correlation", regression: "Linear regression (moderation, mediation with bootstrapped indirect effects)", logistic_regression: "Logistic regression", factor: "Factor analysis / PCA", reliability: "Reliability (Cronbach's α, McDonald's ω)", cluster: "Cluster analysis",
  conjoint_utilities: "Conjoint utilities", maxdiff_scores: "MaxDiff scores", turf: "TURF", driver_analysis: "Driver analysis", text_themes: "Text themes / sentiment",
  ranking_scores: "Ranking scores", allocation_shares: "Allocation shares", pricing: "Pricing (Van Westendorp / Gabor–Granger)", brand_funnel: "Brand funnel",
  hb: "Hierarchical Bayes (individual utilities)", latent_class: "Latent class analysis", sem: "Structural equation modelling / CFA",
};

/** the chart each plan method is shown with (`@rescript/analytics` chart ids — checked against its catalogue) */
export const METHOD_CHART: Record<AnalysisMethod, string> = {
  frequencies: "bar_horizontal", mean: "mean_ci", median: "box_plot", top_box: "bar_stacked_100", nps: "gauge", crosstab: "bar_stacked_100",
  chi_square: "bar_grouped", t_test: "mean_ci", anova: "mean_ci", mann_whitney: "box_plot", kruskal_wallis: "box_plot",
  correlation: "scatter_trendline", regression: "coefficient_plot", logistic_regression: "coefficient_plot", factor: "heatmap", reliability: "bar_horizontal", cluster: "segment_size",
  conjoint_utilities: "attribute_importance", maxdiff_scores: "maxdiff_utility", turf: "bar_horizontal", driver_analysis: "coefficient_plot", text_themes: "word_cloud",
  ranking_scores: "ranking_bar", allocation_shares: "bar_horizontal", pricing: "price_sensitivity", brand_funnel: "funnel_brand",
  hb: "attribute_importance", latent_class: "segment_size", sem: "network",
};

/** exports and documents, each named by the function that makes it */
export const EXPORTS: readonly (Capability & { module: string; symbol: string })[] = [
  { id: "export:csv", kind: "export", name: "Responses — CSV", status: "supported", module: "@rescript/exporters", symbol: "responsesToCSV" },
  { id: "export:spss", kind: "export", name: "Responses — SPSS .sav (labels, missing values)", status: "supported", module: "@rescript/exporters", symbol: "responsesToSav" },
  { id: "export:sas", kind: "export", name: "Responses — SAS (XPT + syntax)", status: "supported", module: "@rescript/exporters", symbol: "responsesToXpt" },
  { id: "export:stata", kind: "export", name: "Responses — Stata .dta", status: "supported", module: "@rescript/exporters", symbol: "responsesToDta" },
  { id: "export:dictionary", kind: "export", name: "Variable dictionary — CSV", status: "supported", module: "@rescript/exporters", symbol: "variableDictionaryToCSV" },
  { id: "export:questionnaire_docx", kind: "export", name: "Questionnaire — Word", status: "supported", module: "@rescript/exporters", symbol: "exportSurveyDocx" },
  { id: "export:survey_json", kind: "export", name: "Survey definition — JSON", status: "supported", module: "@rescript/exporters", symbol: "exportSurveyJson" },
  { id: "export:maxdiff_choice", kind: "export", name: "MaxDiff choice file (for HB elsewhere)", status: "supported", module: "@rescript/exporters", symbol: "maxdiffChoiceCSV" },
  { id: "export:choice_data", kind: "export", name: "Conjoint stacked choice data", status: "supported", module: "@rescript/exporters", symbol: "choiceDataToCSV" },
  { id: "export:proposal_docx", kind: "export", name: "Research proposal / plan — Word", status: "supported", module: "@rescript/analytics", symbol: "buildProposalDocx" },
  { id: "export:sap_docx", kind: "export", name: "Statistical analysis plan — Word", status: "supported", module: "@rescript/analytics", symbol: "buildSapDocx" },
  { id: "export:findings_docx", kind: "export", name: "Findings report — Word", status: "supported", module: "@rescript/analytics", symbol: "buildFindingsDocx" },
  { id: "export:xlsx", kind: "export", name: "Tables — Excel", status: "supported", module: "@rescript/analytics", symbol: "buildXlsx" },
  { id: "export:pptx", kind: "export", name: "Report / deck — PowerPoint", status: "supported", module: "@rescript/analytics", symbol: "buildPptx" },
  /* E2 2026-10-18: the findings deck by sentence, report themes from words, documents kept once made (docs/ARTIFACTS-AND-REPORT-THEMES-2026-10-18.md) */
  { id: "export:findings_deck_pptx", kind: "export", name: "Findings deck — PowerPoint (from a run of the plan)", status: "supported", note: "kept once made: asking again downloads the stored version; a new version when the design, the data or the theme changed", module: "@rescript/analytics", symbol: "buildDeckPptx" },
  { id: "export:report_themes", kind: "export", name: "Report themes — named or described in words, for Word and PowerPoint", status: "partial", note: "colours by role, fonts, tables, spacing, header/footer and an uploaded logo (Word); five built-ins plus themes saved per organisation or person; section reordering only for the findings report; PDF only by converting the Word file (no PDF download in the Studio)", module: "@rescript/analytics", symbol: "interpretThemeRequest" },
  { id: "export:qual_guide_docx", kind: "export", name: "Interview / discussion guide — Word", status: "supported", module: "@rescript/analytics", symbol: "buildQualGuideDocx" },
  { id: "export:qual_report_docx", kind: "export", name: "Qualitative report — Word", status: "supported", module: "@rescript/analytics", symbol: "buildQualReportDocx" },
];

/* ------------------------------------------------ services and readiness (§11, 2026-10-18) */

/** an environment, as the server sees it — names to values; only presence is ever read out of it */
export type EnvLike = Record<string, string | undefined>;

/** whether a service is usable here, from the server environment — names, never values */
export interface ServiceReadiness { id: string; name: string; ready: boolean; missing: string[]; reason?: string }

/**
 * AN EXTERNAL SERVICE A CAPABILITY DEPENDS ON — and how to tell, from the
 * environment alone, whether this installation has it. `variables` is every
 * variable it reads (for the environment checklist); `readiness` reads
 * presence only and returns the NAMES of what is missing.
 */
export interface ServiceSpec {
  id: string;
  name: string;
  purpose: string;
  /** every env var it reads (required and optional) */
  variables: string[];
  /** the apps that read it */
  apps: ("studio" | "runtime" | "interviews")[];
  readiness(env: EnvLike): { ready: boolean; missing: string[]; reason?: string };
}

const set = (env: EnvLike, k: string) => !!(env[k] ?? "").trim();
const hostOf = (u: string) => { try { return new URL(u).hostname; } catch { return ""; } };
/** a chat endpoint with no audio API (Anthropic: chat only) */
const chatOnlyHost = (u: string) => /(^|\.)anthropic\.com$/i.test(hostOf(u.trim()));
const needAll = (env: EnvLike, names: string[]) => { const missing = names.filter((n) => !set(env, n)); return { ready: !missing.length, missing }; };

export const SERVICES: Record<string, ServiceSpec> = {
  ai_chat: {
    id: "ai_chat", name: "Language model", purpose: "Intelligent Mode, the copilot, probes, classification, document cards, rephrasing",
    variables: ["AI_API_URL", "AI_API_KEY", "AI_MODEL", "AI_MODEL_SMALL", "AI_API_HEADERS", "AI_WORKSPACE_ID", "AI_FALLBACK_API_URL", "AI_FALLBACK_API_KEY", "AI_FALLBACK_MODEL", "AI_FALLBACK_MODEL_SMALL", "AI_MAX_CONCURRENCY", "AI_MAX_OUTPUT_TOKENS", "AI_PROMPT_CACHE", "AI_ANTHROPIC_VERSION"],
    apps: ["studio", "runtime", "interviews"],
    readiness: (env) => needAll(env, ["AI_API_URL"]),
  },
  speech_to_text: {
    id: "speech_to_text", name: "Speech-to-text provider", purpose: "transcribing recorded answers, video interviews and spoken Intelligent-Mode requests",
    variables: ["AI_STT_API_URL", "AI_STT_API_KEY", "AI_STT_MODEL"], apps: ["studio", "runtime", "interviews"],
    readiness: (env) => {
      const own = (env.AI_STT_API_URL ?? "").trim();
      const base = own || (env.AI_API_URL ?? "").trim();
      if (!base) return { ready: false, missing: ["AI_STT_API_URL"] };
      if (!own && chatOnlyHost(base)) return { ready: false, missing: ["AI_STT_API_URL"], reason: "AI_API_URL is an Anthropic endpoint, which has no speech-to-text API" };
      return { ready: true, missing: [] };
    },
  },
  text_to_speech: {
    id: "text_to_speech", name: "Text-to-speech", purpose: "the voice interviewer reading questions aloud, report narration",
    variables: ["AI_TTS_MODEL"], apps: ["studio", "runtime"],
    readiness: (env) => {
      const base = (env.AI_API_URL ?? "").trim();
      if (!base) return { ready: false, missing: ["AI_API_URL"] };
      if (chatOnlyHost(base)) return { ready: false, missing: ["AI_API_URL"], reason: "AI_API_URL is an Anthropic endpoint, which has no text-to-speech API" };
      return { ready: true, missing: [] };
    },
  },
  translation: {
    id: "translation", name: "Translation provider", purpose: "machine translation of survey text (Google Cloud Translation, else the language model)",
    variables: ["TRANSLATION_PROVIDER", "GOOGLE_TRANSLATE_API_KEY", "GOOGLE_TRANSLATE_ENDPOINT"], apps: ["studio"],
    readiness: (env) => {
      const pin = (env.TRANSLATION_PROVIDER ?? "").trim().toLowerCase();
      const google = set(env, "GOOGLE_TRANSLATE_API_KEY");
      const llm = set(env, "AI_API_URL");
      if (pin === "google") return google ? { ready: true, missing: [] } : { ready: false, missing: ["GOOGLE_TRANSLATE_API_KEY"], reason: "TRANSLATION_PROVIDER=google without its key" };
      if (pin === "ai" || pin === "llm") return llm ? { ready: true, missing: [] } : { ready: false, missing: ["AI_API_URL"], reason: "TRANSLATION_PROVIDER=ai without a language model" };
      if (pin === "fake" || google || llm) return { ready: true, missing: [] };
      return { ready: false, missing: ["GOOGLE_TRANSLATE_API_KEY | AI_API_URL"] };
    },
  },
  embeddings: {
    id: "embeddings", name: "Embeddings model", purpose: "semantic retrieval over research documents (keyword retrieval without it)",
    variables: ["AI_EMBEDDINGS_MODEL"], apps: ["studio"],
    readiness: (env) => needAll(env, ["AI_EMBEDDINGS_MODEL", "AI_API_URL"]),
  },
  database: {
    id: "database", name: "Supabase database", purpose: "every stored record",
    variables: ["SUPABASE_URL", "SUPABASE_SERVICE_ROLE_KEY", "SUPABASE_ANON_KEY"], apps: ["studio", "runtime", "interviews"],
    readiness: (env) => needAll(env, ["SUPABASE_URL", "SUPABASE_SERVICE_ROLE_KEY"]),
  },
  media_storage: {
    id: "media_storage", name: "Media storage", purpose: "recordings, uploaded media and generated files (Cloudflare R2, else Supabase Storage)",
    variables: ["R2_ACCOUNT_ID", "R2_ENDPOINT", "R2_BUCKET", "R2_ACCESS_KEY_ID", "R2_SECRET_ACCESS_KEY", "R2_REGION", "R2_FORCE_PATH_STYLE", "MEDIA_STORAGE", "MEDIA_STORAGE_URL", "MEDIA_ALLOW_MEMORY_STORAGE"], apps: ["studio", "runtime", "interviews"],
    readiness: (env) => {
      const r2 = (set(env, "R2_ACCOUNT_ID") || set(env, "R2_ENDPOINT")) && set(env, "R2_BUCKET") && set(env, "R2_ACCESS_KEY_ID") && set(env, "R2_SECRET_ACCESS_KEY");
      if (r2 || (env.MEDIA_STORAGE ?? "") === "memory") return { ready: true, missing: [] };
      if (set(env, "SUPABASE_URL") && set(env, "SUPABASE_SERVICE_ROLE_KEY")) return { ready: true, missing: [], reason: "Supabase Storage (R2 not configured)" };
      return { ready: false, missing: ["R2_BUCKET | SUPABASE_URL"] };
    },
  },
  mail: {
    id: "mail", name: "Email delivery", purpose: "invitations, password resets, respondent invitations",
    variables: ["RESEND_API_KEY", "MAIL_FROM", "MAIL_FROM_INVITATIONS", "MAIL_REPLY_TO", "MAIL_DEV_REDIRECT"], apps: ["studio"],
    readiness: (env) => needAll(env, ["RESEND_API_KEY", "MAIL_FROM"]),
  },
  cron: {
    id: "cron", name: "Scheduled jobs", purpose: "media delivery and expiry, release of expired billing holds",
    variables: ["CRON_SECRET"], apps: ["studio", "interviews"],
    readiness: (env) => needAll(env, ["CRON_SECRET"]),
  },
  report_narration: {
    id: "report_narration", name: "Report narration switch", purpose: "narrated video reports (an organisation decision, off by default)",
    variables: ["REPORT_NARRATION_ENABLED"], apps: ["studio"],
    readiness: (env) => (/^(1|true|yes)$/i.test((env.REPORT_NARRATION_ENABLED ?? "").trim()) ? { ready: true, missing: [] } : { ready: false, missing: ["REPORT_NARRATION_ENABLED"] }),
  },
  geocoding: {
    id: "geocoding", name: "Address geocoding", purpose: "address search on location questions (respondent runtime)",
    variables: ["GEOCODE_API_URL", "GEOCODE_API_KEY", "GEOCODE_EMAIL"], apps: ["runtime"],
    readiness: (env) => needAll(env, ["GEOCODE_API_URL"]),
  },
};

/** each service's readiness from this environment (presence only; `override` marks a service ready that a user's own connection provides) */
export function serviceReadiness(env: EnvLike, override: Partial<Record<string, boolean>> = {}): Record<string, ServiceReadiness> {
  const out: Record<string, ServiceReadiness> = {};
  for (const s of Object.values(SERVICES)) {
    const r = override[s.id] ? { ready: true, missing: [] as string[] } : s.readiness(env);
    out[s.id] = { id: s.id, name: s.name, ready: r.ready, missing: r.ready ? [] : r.missing, ...(r.reason ? { reason: r.reason } : {}) };
  }
  return out;
}

/** the platform services Intelligent Mode can offer, each with the service it needs */
export const PLATFORM_CAPABILITIES: readonly Capability[] = [
  { id: "platform:intelligent_mode", kind: "platform", name: "Intelligent Mode model reasoning (plans, generation from a brief, descriptive edits)", status: "requires_configuration", services: ["ai_chat"], note: "without a language model, Intelligent Mode is engine-only: instructions that name their objects still work", handler: "route:POST /api/copilot/turn", inputs: ["a request in any language", "a research brief up to 60,000 characters", "the open survey definition"], outputSchema: "CopilotReply / ChangePlan (lib/copilot/prompt.ts, changePlan.ts)", validation: ["requestScope", "applySurveyActions on a clone", "coverageReport"], tests: ["copilot.test.ts", "engineReliability.test.ts", "copilot-test", "intelligent-engine-test"] },
  { id: "platform:voice_requests", kind: "platform", name: "Spoken requests in Intelligent Mode and Design with AI", status: "requires_configuration", services: ["speech_to_text"], aliases: /\bdictat(?:e|ion) (?:my|the) (?:request|prompt)\b|\bvoice (?:input|request|command)s?\b/i, handler: "route:POST /api/ai/transcribe", inputs: ["audio (webm / mp4 / wav, ≤ 45 s)"], outputSchema: "{ text }", tests: ["theme-voice-test"] },
  { id: "platform:machine_translation", kind: "platform", name: "Machine translation of the survey", status: "requires_configuration", services: ["translation"], note: "the Studio's translate button and batch translation; in Intelligent Mode the model writes translations itself (set_translations), so a copilot request needs no translation provider", handler: "route:POST /api/ai/translate", inputs: ["the survey's translatable elements", "target language(s)"], outputSchema: "Localization.translations", validation: ["pipes, HTML tags and glossary terms kept (lintLanguage)"], tests: ["translation.test.ts", "translation-copilot-test"] },
  { id: "platform:semantic_retrieval", kind: "platform", name: "Semantic retrieval over research documents", status: "requires_configuration", services: ["embeddings"], note: "without an embeddings model, passages are retrieved by keywords (BM25) — still cited by id", handler: "lib/copilot/research.ts researchPassages", inputs: ["uploaded research documents"], outputSchema: "passages with ids (d1#4)", tests: ["research-copilot-test"] },
  { id: "platform:recorded_transcription", kind: "platform", name: "Transcription of recorded answers", status: "requires_configuration", services: ["speech_to_text", "media_storage"], aliases: /\btranscri(?:be|ption)s?\b/i, handler: "media pipeline projectStt", inputs: ["audio / video recordings"], outputSchema: "media_objects transcript", tests: ["stt.test.ts"] },
  { id: "platform:report_narration", kind: "platform", name: "Narrated video reports", status: "requires_configuration", services: ["report_narration", "text_to_speech"], aliases: /\bnarrat(?:ed|ion|e)\b|\bvoice[\s-]?over\b/i, handler: "@rescript/reportvideo", inputs: ["a story report"], outputSchema: "MP4", limitations: ["narration is an organisation decision: off unless REPORT_NARRATION_ENABLED is set"], tests: ["story-report-test"] },
  { id: "platform:address_geocoding", kind: "platform", name: "Address search on location questions", status: "requires_configuration", services: ["geocoding"], note: "without it the typed address is kept and pins still work", handler: "runtime lib/geocode.ts", inputs: ["a typed address"], outputSchema: "{ lat, lng, label }" },
];

/** entries other areas add (E2 report artefacts and themes, E3 qualitative, E4 statistics): append here or in the lists above — normalised like every other */
export const EXTRA_CAPABILITIES: Capability[] = [
  /* E3 2026-10-18 — moderated interviews, focus groups and qualitative coding (docs/QUALITATIVE-RESEARCH-2026-10-18.md) */
  { id: "qualitative:moderated_guide", kind: "qualitative", name: "Interview / focus-group guide (moderated study plan)", status: "supported", note: "objectives, protocol, timed sections with scripts, questions, probes and conditional probes, moderator instructions, ground rules, exercises, concepts, screening, consent and recording disclosure, segments, session plan; created and patched in Intelligent Mode; exported to Word", implementedAs: { actions: ["create_qual_guide", "update_qual_guide"] }, aliases: /\bfocus groups?\b|\bdiscussion guide\b|\b(?:in[\s-])?depth interviews?\b|\bidis?\b|\bmoderated\b|\bmoderator guide\b/i, outputSchema: "SurveyDefinition.qualStudy (QualStudy)", validation: ["applySurveyActions (engine gate)", "lintQualStudy (timing, opening/closing, ground rules, recording disclosure, leading questions)"], tests: ["qualActions.test.ts", "qualStudyGuide.test.ts", "qual-research-test"], version: "2026-10-18" },
  { id: "qualitative:sessions", kind: "qualitative", name: "Session records (interviews / focus groups)", status: "supported", note: "date, moderator, participants and segments, consent captured, notes, observations, status — records of sessions run elsewhere", services: ["database"], handler: "route:/api/surveys/[id]/qual/sessions", outputSchema: "qual_sessions (0065)", tests: ["qualWorkspace.test.ts", "qual-research-sql-test"], version: "2026-10-18" },
  { id: "qualitative:recordings", kind: "qualitative", name: "Session recordings", status: "requires_configuration", note: "audio or video uploaded straight to private storage (resumable), played or downloaded through a 15-minute signed URL after an access check (Data view + contact details)", services: ["media_storage", "database"], handler: "route:/api/surveys/[id]/qual/recordings", limitations: ["500 MB ceiling, lower when the store's own limit is (Supabase Storage: 50 MB by default)"], tests: ["plan.test.ts (media)", "qualAccess.test.ts"], version: "2026-10-18" },
  { id: "qualitative:session_transcription", kind: "qualitative", name: "Session transcription", status: "requires_configuration", note: "through the configured speech-to-text provider, with timings and speaker separation where the provider offers it (recorded truthfully)", services: ["speech_to_text", "media_storage"], handler: "route:POST /api/surveys/[id]/qual/recordings/transcribe", limitations: ["at most 25 MB of audio per request; longer WAV / MP3 recordings are split without re-encoding (qualitative:long_audio), other formats: import a .vtt / .srt made elsewhere", "speaker separation only when the provider diarizes"], tests: ["qualWorkspace.test.ts"], version: "2026-10-18" },
  { id: "qualitative:transcript_import", kind: "qualitative", name: "Transcript import (.txt, .vtt, .srt, .docx, “Speaker: text”)", status: "supported", note: "speaker ids and timestamps preserved; moderator role and participant segment suggested and editable; open-ended survey answers can be added as a source", handler: "route:POST /api/surveys/[id]/qual/transcripts", inputs: ["plain text", "WebVTT", "SubRip", "Word .docx", "Speaker: text lines"], outputSchema: "qual_transcripts.segments (QualSegment[])", tests: ["qual.test.ts", "qualDocx.test.ts", "qualWorkspace.test.ts"], version: "2026-10-18" },
  { id: "qualitative:redaction", kind: "qualitative", name: "PII redaction of qualitative text", status: "supported", note: "e-mail addresses, phone numbers and a names list replaced before any AI call and for members without contact-details access; spans map back to the original", tests: ["qual.test.ts", "qualWorkspace.test.ts"], version: "2026-10-18" },
  { id: "qualitative:review", kind: "qualitative", name: "Human review of codes, themes and excerpts", status: "supported", note: "accept / reject / edit / merge / split codes, rename themes, reassign excerpts, add manual codes and excerpts (verbatim-checked), history of who did what when", handler: "route:POST /api/surveys/[id]/qual/coding (op)", tests: ["qual.test.ts"], version: "2026-10-18" },
  { id: "qualitative:intercoder", kind: "qualitative", name: "Inter-coder agreement (Cohen's kappa per code)", status: "supported", note: "two coders (the AI can be one) over the segments both coded; disagreements listed; undefined when a code has no variation", tests: ["qual.test.ts"], version: "2026-10-18" },
  { id: "qualitative:theme_analysis", kind: "qualitative", name: "Theme frequency, negative cases, representative quotes, evidence-based summaries", status: "supported", note: "frequency by group labelled as not importance or significance; every summary claim cites excerpt ids; sentiment only as a labelled lexicon reading", tests: ["qual.test.ts", "qualDocx.test.ts"], version: "2026-10-18" },
  /* F1 2026-10-22 — AI-moderated 1:1 interviews at scale (docs/AI-INTERVIEWS-2026-10-22.md) */
  { id: "qualitative:ai_interviews", kind: "qualitative", name: "AI-moderated 1:1 interviews (asynchronous, from a link)", status: "supported", note: "an interview guide run by an AI moderator with each participant: consent, screener and quotas, the guide's questions in order with probing per question (none / light / deep), conditional probes, stimuli, objective coverage, the time budget, in the participant's language; text chat; transcripts land in Research Tools → Qualitative for coding; the researcher watches interviews arrive, ends or excludes them; scripted fallback when the AI is unavailable", implementedAs: { actions: ["configure_ai_interviews"] }, aliases: /\bai[\s-]?(?:moderated|moderator|led|run|powered)\s+(?:\w+\s+){0,2}interviews?\b|\bai (?:voice |video |text |chat )?interview(?:s|ers?|ing)?\b|\bas ai (?:voice |video |text )?interviews?\b|\basync(?:hronous)? (?:ai )?interviews?\b|\bai[\s-]moderat\w*/i, services: ["ai_chat"], handler: "runtime:/i/[token] + /api/ai-interview/*; studio:/api/surveys/[id]/ai-interviews", outputSchema: "qualStudy.aiModeration; ai_interview_* (0069); qual_sessions + qual_transcripts (0065) on completion", validation: ["coerceAiInterviewAction / applyAiInterviewAction (engine gate)", "launchProblems (consent statement, recording disclosure, https URLs)", "moderatorReplyProblems (length, links, contact requests, instructions, topic, language)"], limitations: ["one participant per interview — no AI-moderated group session here", "the scripted fallback speaks English and Hindi; other languages fall back to the guide's words", "no real-time video call: voice is turn-based (speak, check the transcript, send)"], tests: ["aiModerator.test.ts", "aiInterviewActions.test.ts", "ai-interviews-sql-test", "ai-interview-test"], version: "2026-10-22" },
  { id: "qualitative:ai_interview_voice", kind: "qualitative", name: "AI interviews by voice / voice + camera", status: "requires_configuration", note: "turn-based: the participant speaks, checks the transcript, sends; the moderator's reply is streamed as text and spoken; with consent each answer's camera recording is stored privately", services: ["speech_to_text", "text_to_speech", "media_storage"], limitations: ["browsers without a microphone or MediaRecorder use text", "the spoken reply falls back to the browser's own voice when text-to-speech is not configured"], tests: ["ai-interview-test"], version: "2026-10-22" },
  /* F2 2026-10-22 — AI qualitative synthesis, blind double-coding, highlights, transcript correction, auto-coding, text group sessions (docs/QUAL-SYNTHESIS-AND-GROUPS-2026-10-22.md) */
  { id: "qualitative:ai_synthesis", kind: "qualitative", name: "AI qual synthesis (summaries, insights, Q&A)", status: "requires_configuration", note: "per theme: what people said, nuance, tensions, who said it by participant group, contradicting evidence; per study: key findings per objective and hypothesis ('not enough evidence' when that is the truth), surprises, recommendations labelled as interpretation, an executive summary, segment comparison, a journey / decision-driver framing only when the guide implies it and every stage is supported. Every sentence cites excerpt ids (checked); a sentence naming a group needs that group's evidence; numbers the evidence does not give are dropped; counts and coverage are computed by code. Versioned, editable (AI vs edited kept apart), stale when the coding changes. Questions asked of the data (route:POST /api/surveys/[id]/qual/ask) are answered from retrieved excerpts only, cited; nothing relevant = 'not enough evidence' without a model call. Recordings over 25 MB: see Session transcription (WAV / MP3 split without re-encoding)", services: ["ai_chat"], aliases: /\bsummari[sz]e (?:the |all |each )?(?:themes?|interviews?|transcripts?)\b|\btheme summar(?:y|ies)\b|\bkey (?:insights?|findings) (?:for|of) (?:objective|the (?:interviews?|study))\b|\bsynthesi[sz]e (?:the )?(?:interviews?|qual(?:itative)? data|transcripts?)\b/i, handler: "route:/api/surveys/[id]/qual/synthesis; Intelligent Mode qual cards (interpretQualRequest)", outputSchema: "qual_syntheses (0070): ThemeSynthesis / StudyInsights", validation: ["readThemeSynthesis / readInsights (citations, groups, numbers)", "themeSynthesisState (fingerprint)"], limitations: ["checked mechanically (citations, groups, numbers), not for meaning: a sentence can cite real excerpts and still over-read them", "number words ('one participant', 'most') are dropped as well as digits — conservative by design"], tests: ["synthesis.test.ts", "qualSynthesisExport.test.ts", "qual-synthesis-test"], version: "2026-10-22" },
  { id: "qualitative:auto_coding", kind: "qualitative", name: "Auto-coding of new sources", status: "requires_configuration", note: "per study, off by default: segment → redact → code deductively with the current codebook (or propose codes) → AI-suggested for review → summaries marked stale (or regenerated); a resumable, idempotent, leased job per source revision; batched, metered, capped", services: ["ai_chat", "database"], aliases: /\bauto(?:matic(?:ally)?)?[\s-]?cod(?:e|ing)\b|\bcode new (?:interviews?|transcripts?) automatically\b/i, handler: "route:/api/surveys/[id]/qual/jobs", outputSchema: "qual_jobs (0070)", limitations: ["no background worker: a job advances while someone with Analytics edit has the Qualitative workspace open (it polls) or presses Continue"], tests: ["synthesis.test.ts", "qual-synthesis-sql-test", "qual-synthesis-test"], version: "2026-10-22" },
  { id: "qualitative:double_coding", kind: "qualitative", name: "Blind double-coding (κ and Krippendorff's α, disagreement resolution)", status: "supported", note: "a seeded x % of each source's participant segments; two coders (people, or a person and the AI) blind to each other until both submit (RLS keeps the private sets unreadable); Cohen's κ and nominal Krippendorff's α per code, pooled and mean; each disagreement resolved apply / do not apply with a note and history; agreed and resolved codings merged as reviewed excerpts", aliases: /\bdouble[\s-]?cod(?:e|ing)\b|\bkrippendorff\b|\bblind (?:second )?cod(?:e|ing|er)\b/i, handler: "route:/api/surveys/[id]/qual/double-coding", outputSchema: "qual_coding_assignments, qual_assignment_codings (0070)", tests: ["doubleCoding.test.ts (α = .743 on Krippendorff's published example; hand-computed binary case)", "qual-synthesis-sql-test", "qual-synthesis-test"], version: "2026-10-22" },
  { id: "qualitative:highlights", kind: "qualitative", name: "Highlight reels (quotes across sessions, clip playback, Word / PowerPoint)", status: "supported", note: "ordered excerpts with notes and a snapshot of each quote (changed / removed since is shown); a clip plays the excerpt's turn from the recording through a 15-minute signed URL after the playback check; the list exports to Word and PowerPoint", aliases: /\bhighlight reels?\b|\bquote reels?\b|\bshowreel\b/i, handler: "route:/api/surveys/[id]/qual/highlights", outputSchema: "qual_highlights (0070)", limitations: ["clips are whole turns (no word-level timings)", "clips are not stitched into one video (no media processing in the Studio)"], tests: ["groups.test.ts (reels)", "qualSynthesisExport.test.ts", "qual-synthesis-test"], version: "2026-10-22" },
  { id: "qualitative:transcript_correction", kind: "qualitative", name: "Transcript correction with history (excerpts re-anchored)", status: "supported", note: "a segment's words corrected (STT errors); excerpts outside the edit shift, inside it are re-anchored to the corrected words and flagged for review, deleted ones invalidated — a quote is always the exact text; every correction is a revision with before / after", handler: "route:/api/surveys/[id]/qual/transcripts/edit", outputSchema: "qual_transcript_revisions, qual_transcripts.revision (0070)", tests: ["doubleCoding.test.ts (correction)", "qual-synthesis-test"], version: "2026-10-22" },
  { id: "qualitative:group_sessions", kind: "qualitative", name: "Text group sessions (Remesh-style live conversation with many participants)", status: "supported", note: "participants join by link in the respondent app, answer each prompt in text and rate a sample of others' answers; answers clustered (AI, or by shared words without a model) and votes read by code (consensus / polarising); AI follow-ups approved by the moderator or, in autonomous mode, asked within the guide's limit after passing the probe checks; the closed session becomes a focus-group source with speakers and timestamps", aliases: /\bgroup sessions?\b|\blive (?:text )?(?:discussion|conversation)s? with (?:many|\d+) (?:participants|people)\b|\bremesh\b/i, handler: "studio:/api/surveys/[id]/qual/groups; runtime:/g/[code] + /api/group", outputSchema: "qual_group_sessions, qual_group_participants, qual_group_answers, qual_group_votes (0070)", limitations: ["text only: no audio or video conferencing", "live updates by polling (2 s), not streaming", "the AI steps and the autonomous clock run while the moderator console or participants poll — there is no background worker"], tests: ["groups.test.ts", "qual-synthesis-sql-test", "group-session-test"], version: "2026-10-22" },
  { id: "qualitative:video_conferencing", kind: "qualitative", name: "Video group sessions", status: "not_supported", note: "group sessions are text only; run video groups in your own conferencing and import the transcript", aliases: /\bvideo (?:group|focus group|conference) sessions?\b/i, version: "2026-10-22" },
];

/** this registry's shape version; an entry without its own `version` carries it */
export const REGISTRY_VERSION = "2026-10-18";

const DEFAULTS: Record<CapabilityKind, Pick<CapabilityRecord, "inputs" | "validation" | "outputSchema" | "tests">> = {
  methodology: { inputs: ["research design (objective, hypotheses)", "design parameters"], validation: ["applySurveyActions (engine gate)", "researchValidation", "planItemSuitability"], outputSchema: "SurveyDefinition + AnalysisPlan", tests: ["capabilities.test.ts", "researchValidation.test.ts", "research-intelligence-test"] },
  question_type: { inputs: ["question definition"], validation: ["questionTypeRegistry", "validateSurvey"], outputSchema: "Question (@rescript/schema)", tests: ["capabilities.test.ts", "questionTypeRegistry.test.ts"] },
  analysis: { inputs: ["the plan's variables, per the method's readiness rule"], validation: ["planCheck (Studio Apply readiness)"], outputSchema: "AnalysisRun.findings (@rescript/analytics)", tests: ["capabilities.test.ts", "analysis-apply-test"] },
  qualitative: { inputs: ["open-ended questions"], validation: ["applySurveyActions (engine gate)"], outputSchema: "SurveyDefinition", tests: ["capabilities.test.ts", "research-intelligence-test"] },
  export: { inputs: ["survey definition and responses"], validation: ["checkDocx / file validation where offered"], outputSchema: "file", tests: ["researchGuide.test.ts", "data-export-test"] },
  reporting: { inputs: ["executed analyses"], validation: ["reporting guide (no invented numbers)"], outputSchema: "report", tests: ["reportingGuide.test.ts"] },
  platform: { inputs: [], validation: [], outputSchema: "", tests: [] },
};

/** the configuration a capability needs: the missing-capable variable names of its services ("A | B" = either) */
function configurationOf(services: string[]): string[] {
  const out: string[] = [];
  for (const id of services) {
    const s = SERVICES[id];
    if (!s) continue;
    for (const m of s.readiness({}).missing) if (!out.includes(m)) out.push(m);
  }
  return out;
}

/** an entry with every field filled — the shape `capabilityRegistry()` returns */
export function normalizeCapability(c: Capability): CapabilityRecord {
  const d = DEFAULTS[c.kind] ?? DEFAULTS.platform;
  const services = c.services ?? [];
  const impl = c.implementedAs;
  const handler = c.handler
    ?? (impl?.actions?.length ? `actions:${impl.actions.join(",")}` : impl?.analysis?.length ? `analysis:${impl.analysis.join(",")}` : c.kind === "question_type" ? `question_type:${c.id.replace(/^question_type:/, "")}` : c.status === "not_supported" ? "none" : c.id);
  return {
    ...c, category: c.kind, services, configuration: configurationOf(services),
    inputs: c.inputs ?? d.inputs, handler, validation: c.validation ?? d.validation, outputSchema: c.outputSchema ?? (c.status === "not_supported" ? "none" : d.outputSchema),
    limitations: c.limitations ?? (c.status !== "supported" && c.note ? [c.note] : []), tests: c.tests ?? d.tests, version: c.version ?? REGISTRY_VERSION,
  };
}

/** question types with a limit worth saying */
const QUESTION_TYPE_NOTES: Record<string, { status: CapabilityStatus; note: string }> = {
  video_interview: { status: "partial", note: "plays a stimulus and records a spoken answer (transcribed); no respondent video" },
  experiment: { status: "partial", note: "an arm marker; monadic designs use a randomizer and an embedded arm variable" },
  custom_component: { status: "partial", note: "the author's own component; analysis reads what it stores" },
};

/** the base question types the copilot can create directly (its friendly types and the design actions) */
export function copilotQuestionTypes(): Set<string> {
  const out = new Set<string>();
  for (const v of Object.values(ACTION_TYPES)) { const b = resolveVariant(v)?.baseType; if (b) out.add(b); }
  for (const t of ["maxdiff_task", "conjoint_task", "acbc_task"]) out.add(t);
  return out;
}

/**
 * Every capability, derived on every call (a plugin registered later is in it):
 * the methodologies, every registered question type, every
 * plan analysis method (and the procedures that are not run), the qualitative
 * support and the exports.
 */
export function capabilityRegistry(): CapabilityRecord[] {
  registerBuiltinQuestionTypes();
  const copilot = copilotQuestionTypes();
  const out: Capability[] = [];
  for (const m of METHODOLOGIES) out.push({ id: `methodology:${m.id}`, kind: "methodology", name: m.name, status: m.status, ...(m.note ? { note: m.note } : {}), implementedAs: { questionTypes: m.questionTypes, actions: m.actions, analysis: m.analysis }, aliases: m.aliases, ...(m.services ?? METHODOLOGY_SERVICES[m.id] ? { services: m.services ?? METHODOLOGY_SERVICES[m.id] } : {}) });
  for (const p of questionTypeRegistry.all()) {
    const n = QUESTION_TYPE_NOTES[p.type];
    const viaCopilot = copilot.has(p.type);
    const note = [n?.note, viaCopilot ? "" : "built in the Studio editor (no Intelligent-mode create)"].filter(Boolean).join("; ");
    out.push({ id: `question_type:${p.type}`, kind: "question_type", name: p.label, status: n?.status ?? "supported", ...(note ? { note } : {}) });
  }
  for (const m of ANALYSIS_METHODS) {
    const n = ANALYSIS_NOTES[m];
    const x = PLAN_METHOD_EXTRA[m];
    /* a procedure that became a plan method keeps its full record (and its id), now as the method's */
    const proc = UNSUPPORTED_PROCEDURES.find((u) => u.id === `analysis:${m}`);
    if (proc) { out.push({ ...proc, name: proc.name, validation: [...(proc.validation ?? []), ...(x?.validation ?? [])], tests: [...(proc.tests ?? []), ...(x?.tests ?? [])], ...(x ? { version: x.version } : {}), implementedAs: { analysis: [m] } }); continue; }
    const note = [n?.note, x?.note].filter(Boolean).join("; ");
    out.push({ id: `analysis:${m}`, kind: "analysis", name: METHOD_NAMES[m], status: n?.status ?? "supported", ...(note ? { note } : {}), ...(x ? { validation: [...DEFAULTS.analysis.validation, ...x.validation], tests: [...DEFAULTS.analysis.tests, ...x.tests], version: x.version } : {}), implementedAs: { analysis: [m] } });
  }
  out.push(...UNSUPPORTED_PROCEDURES.filter((u) => !(ANALYSIS_METHODS as readonly string[]).includes(u.id.replace(/^analysis:/, ""))));
  out.push(
    { id: "qualitative:open_ends", kind: "qualitative", name: "Open-ended questions (short / essay)", status: "supported", implementedAs: { questionTypes: ["open_text", "long_text"], actions: ["create_question"] } },
    { id: "qualitative:probes", kind: "qualitative", name: "AI follow-up probes on open ends", status: "supported", note: "up to 5 per question, gated by conditions; fixed wording or written by the AI at run time", implementedAs: { actions: ["set_probe"] }, aliases: /\bprob(?:e|es|ing)\b|\bfollow[\s-]?ups?\b/i, services: ["ai_chat"] },
    { id: "qualitative:dictation", kind: "qualitative", name: "Spoken answers (dictation) on open text", status: "supported", note: "on by default on every prose field", limitations: ["browser speech recognition only (no server fallback; Firefox has none)"] },
    { id: "qualitative:transcription", kind: "qualitative", name: "Recorded audio answers with transcription", status: "partial", note: "video_interview answers in surveys; moderated session recordings are transcribed in Research Tools → Qualitative (qualitative:session_transcription)", services: ["speech_to_text", "media_storage"] },
    { id: "qualitative:conversational", kind: "qualitative", name: "AI conversational interviewer (voice)", status: "supported", note: "reads the programmed survey aloud and takes spoken answers; the survey stays the authority", services: ["ai_chat", "text_to_speech"] },
    { id: "qualitative:themes", kind: "qualitative", name: "Theme coding of open answers", status: "partial", note: ANALYSIS_NOTES.text_themes!.note, implementedAs: { analysis: ["text_themes"] } },
  );
  out.push(...EXPORTS.map(({ module: m, symbol: s, ...c }) => ({ ...c, handler: c.handler ?? `export:${m}#${s}` })));
  out.push(...PLATFORM_CAPABILITIES, ...EXTRA_CAPABILITIES);
  // the action vocabulary is the source of truth for what a methodology can be built with
  for (const c of out) for (const a of c.implementedAs?.actions ?? []) if (!(SURVEY_ACTION_OPS as readonly string[]).includes(a)) throw new Error(`capability ${c.id} names an action the engine does not have: ${a}`);
  // a service is named once, in SERVICES: an entry cannot depend on one that does not exist
  for (const c of out) for (const s of c.services ?? []) if (!SERVICES[s]) throw new Error(`capability ${c.id} names a service the registry does not have: ${s}`);
  return out.map(normalizeCapability);
}

/** methodologies that depend on a configured service */
const METHODOLOGY_SERVICES: Record<string, string[]> = { video_response: ["speech_to_text", "media_storage"] };

/** a capability's readiness HERE: its status, and whether every service it needs is configured — names of what is missing, never values */
export interface CapabilityReadiness {
  id: string;
  name: string;
  kind: CapabilityKind;
  status: CapabilityStatus;
  /** usable on this installation now */
  ready: boolean;
  /** the missing environment variables ("A | B" = either) */
  missing: string[];
  /** the services that are not ready, by name */
  missingServices: string[];
  /** a sentence for an administrator */
  reason?: string;
  /** a researcher could ask Intelligent Mode for it (it has request words, or it is a methodology / analysis / qualitative feature) */
  requestable: boolean;
}

/**
 * THE READINESS CHECK (§11). Every capability, with whether this
 * installation can run it now — from the SERVER environment, presence only.
 * `not_supported` is never ready; anything else is ready when every service it
 * names is. `override` marks a service ready that the acting user's own
 * connection provides (their language model, their speech provider).
 */
export function capabilityReadiness(env: EnvLike, override: Partial<Record<string, boolean>> = {}): CapabilityReadiness[] {
  const svc = serviceReadiness(env, override);
  return capabilityRegistry().map((c) => {
    const requestable = !!c.aliases || c.kind === "methodology" || c.kind === "analysis" || c.kind === "qualitative";
    if (c.status === "not_supported") return { id: c.id, name: c.name, kind: c.kind, status: c.status, ready: false, missing: [], missingServices: [], requestable, ...(c.note ? { reason: `not supported: ${c.note}` } : {}) };
    const down = c.services.map((s) => svc[s]).filter((s) => s && !s.ready);
    const missing = [...new Set(down.flatMap((s) => s.missing))];
    return { id: c.id, name: c.name, kind: c.kind, status: c.status, ready: !down.length, missing, missingServices: down.map((s) => s.name), requestable, ...(down.length ? { reason: down.map((s) => `${s.name} is not configured (${s.missing.join(", ")}${s.reason ? `; ${s.reason}` : ""})`).join("; ") } : {}) };
  });
}

/** the capabilities that need configuration and are not ready — what an administrator must fix, and what Intelligent Mode must not offer */
export const unreadyCapabilities = (readiness: readonly CapabilityReadiness[]): CapabilityReadiness[] => readiness.filter((r) => !r.ready && r.status !== "not_supported" && r.missing.length > 0);

/**
 * WHAT A SHORT REQUEST ASKS FOR THAT THIS INSTALLATION CANNOT DO — the
 * refusal Intelligent Mode gives, naming the missing dependency, instead of
 * a silent substitution. Only capabilities that need configuration and lack
 * it; a long brief is never refused (its plan lists the gap instead).
 */
export function capabilityRefusal(text: string, readiness: readonly CapabilityReadiness[]): { capability: CapabilityReadiness; message: string } | null {
  if (!text || text.length > 600) return null;
  /* a question ABOUT the thing ("ask whether they transcribe interviews") is survey content, not a request to do it */
  if (/\b(?:question|ask|asking|item|option)s?\b[^.?!]{0,40}\b(?:about|whether|if|how|on)\b/i.test(text)) return null;
  const down = new Map(unreadyCapabilities(readiness).map((r) => [r.id, r]));
  if (!down.size) return null;
  const hit = capabilitiesMentioned(text).find((c) => down.has(c.id));
  if (!hit) return null;
  const r = down.get(hit.id)!;
  return { capability: r, message: `${r.name} is not available on this installation: ${r.missingServices.join(" and ")} ${r.missingServices.length === 1 ? "is" : "are"} not configured (an administrator sets ${r.missing.map((m) => m.replace(/ \| /g, " or ")).join(", ")}). Nothing was changed and nothing was charged.` };
}

/** the line the model is given when something it might offer is not available here (empty when everything is ready) */
export function availabilityNote(readiness: readonly CapabilityReadiness[]): string {
  /* only what a researcher could ask the model for (a methodology, a qualitative feature, a requestable service) — not plumbing like retrieval or geocoding */
  const down = unreadyCapabilities(readiness).filter((r) => r.requestable);
  if (!down.length) return "";
  return `NOT AVAILABLE ON THIS INSTALLATION (missing configuration — do not offer, plan or substitute these; if the researcher asks for one, say it needs an administrator to configure it): ${down.map((r) => `${r.name} (${r.missing.join(", ")})`).join("; ")}.`;
}

export const capabilityOf = (id: string): CapabilityRecord | undefined => capabilityRegistry().find((c) => c.id === id);
export const methodologyOf = (id: string): MethodologySpec | undefined => METHODOLOGIES.find((m) => m.id === id);

/** the methodologies and procedures a request names — for the copilot's refusal and clarify logic */
export function capabilitiesMentioned(text: string): Capability[] {
  const t = text.normalize("NFC");
  return capabilityRegistry().filter((c) => c.aliases?.test(t));
}

/** the methodologies a methodology text names (the research design's `methodology`), most specific first */
export function methodologiesNamed(text: string | undefined): MethodologySpec[] {
  if (!text) return [];
  const hit = METHODOLOGIES.filter((m) => m.aliases.test(text));
  // "survey" is the generic one: only when nothing more specific is named
  return hit.length > 1 ? hit.filter((m) => m.id !== "survey") : hit;
}

const STATUS_WORD: Record<CapabilityStatus, string> = { supported: "supported", partial: "partial", requires_configuration: "requires configuration", not_supported: "not supported" };

/**
 * The capabilities in a few lines, for the research guide: the methodologies
 * with their status, the procedures that are partial or not run. Generated —
 * the model is told what exists from the registry, not from prose.
 */
export function capabilityBrief(opts: { readiness?: readonly CapabilityReadiness[] } = {}): string {
  const reg = capabilityRegistry();
  /* with this installation's readiness: what needs configuration it lacks is not offered — it is named as unavailable instead */
  const down = new Map(unreadyCapabilities(opts.readiness ?? []).map((r) => [r.id, r]));
  const meth = METHODOLOGIES.filter((m) => !down.has(`methodology:${m.id}`)).map((m) => `${m.name}${m.status === "supported" ? "" : ` [${STATUS_WORD[m.status]}]`}`).join("; ");
  const short = (n?: string) => (n ? `: ${n.split(/;|, (?:export|the plan)/)[0].trim()}` : "");
  const limited = reg.filter((c) => c.kind === "analysis" && c.status !== "supported" && !down.has(c.id)).map((c) => `${c.name} [${STATUS_WORD[c.status]}${short(c.note)}]`).join("; ");
  const qual = reg.filter((c) => c.kind === "qualitative" && c.status !== "supported" && !down.has(c.id)).map((c) => `${c.name} [${STATUS_WORD[c.status]}]`).join("; ");
  const unavailable = down.size ? ` Not configured on this installation (do not offer): ${[...down.values()].map((r) => `${r.name} (${r.missing.join(", ")})`).join("; ")}.` : "";
  return `CAPABILITIES (from the registry). Methodologies: ${meth}. Analysis limits: ${limited}. Qualitative limits: ${qual}.${unavailable}`;
}

/** the registry as markdown tables — the public page `capabilities.md` and the research-intelligence doc */
export function capabilityMarkdown(): string {
  const reg = capabilityRegistry();
  const svc = (c: CapabilityRecord) => c.services.map((s) => SERVICES[s]?.name ?? s).join(", ");
  const configTable = (rows: CapabilityRecord[]) => ["| Capability | Status | Needs | Configuration (environment) | Notes |", "|---|---|---|---|---|", ...rows.map((c) => `| ${esc(c.name)} | ${STATUS_WORD[c.status]} | ${esc(svc(c))} | ${esc(c.configuration.join(", "))} | ${esc(c.note)} |`)].join("\n");
  const esc = (s: string | undefined) => (s ?? "").replace(/\|/g, "\\|");
  const table = (rows: Capability[]) => ["| Capability | Status | What works / the alternative |", "|---|---|---|", ...rows.map((c) => `| ${esc(c.name)} | ${STATUS_WORD[c.status]} | ${esc(c.note)} |`)].join("\n");
  const meth = ["| Methodology | Status | Questions | Randomisation | Analysis | Chart | Notes |", "|---|---|---|---|---|---|---|", ...METHODOLOGIES.map((m) => `| ${esc(m.name)} | ${STATUS_WORD[m.status]} | ${m.questionTypes.join(", ")} | ${esc(m.randomisation)} | ${m.analysis.join(", ")} | ${m.charts.join(", ")} | ${esc(m.note)} |`)].join("\n");
  return [
    "## Methodologies", "", meth, "",
    "## Analytical procedures", "", table(reg.filter((c) => c.kind === "analysis")), "",
    "## Qualitative support", "", table(reg.filter((c) => c.kind === "qualitative")), "",
    "## Question types", "", table(reg.filter((c) => c.kind === "question_type")), "",
    "## Exports and documents", "", table(reg.filter((c) => c.kind === "export")), "",
    ...(reg.some((c) => c.kind === "reporting") ? ["## Reporting", "", table(reg.filter((c) => c.kind === "reporting")), ""] : []),
    "## Platform services and their configuration", "", "Each of these works once an operator configures the service it needs; the platform page (`/platform`) shows whether this installation has it. Variable names only — values are never shown.", "", configTable(reg.filter((c) => c.kind === "platform" || c.services.length > 0)), "",
  ].join("\n");
}

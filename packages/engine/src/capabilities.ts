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

export type CapabilityStatus = "supported" | "partial" | "not_supported";
export type CapabilityKind = "methodology" | "question_type" | "analysis" | "qualitative" | "export";

export interface Capability {
  /** stable id: "methodology:maxdiff", "question_type:ranking", "analysis:t_test", "export:spss" */
  id: string;
  kind: CapabilityKind;
  name: string;
  status: CapabilityStatus;
  /** partial: what works and what does not; not_supported: the supported alternative */
  note?: string;
  /** how it is built here — question types, actions, analysis methods */
  implementedAs?: { questionTypes?: string[]; actions?: string[]; analysis?: AnalysisMethod[] };
  /** words a request uses for it — `capabilitiesMentioned` matches them */
  aliases?: RegExp;
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
}

export const METHODOLOGIES: readonly MethodologySpec[] = [
  { id: "survey", name: "Quantitative survey (descriptive / explanatory)", status: "supported", objective: "levels, shares and relationships in a population", designParameters: "constructs and their measures, the sample and its quotas", questionTypes: ["single_select", "multi_select", "matrix_single", "numeric", "nps"], actions: ["create_question", "set_research", "set_question_analysis", "create_quota"], randomisation: "option order (set_option_randomization), block order (create_randomizer)", dataCapture: "one variable per question (grids: one per row)", analysis: ["frequencies", "crosstab", "chi_square", "t_test", "anova", "correlation", "regression"], charts: ["bar_horizontal", "bar_stacked_100", "mean_ci"], aliases: /\bsurvey\b|\bquestionnaire\b|\bquantitative\b|\bquant\b/i },
  { id: "monadic", name: "Monadic concept test", status: "supported", objective: "how each concept performs on its own, compared between cells", designParameters: "the concepts (one block each), the KPI battery asked after every concept, cells sized for the comparison", questionTypes: ["single_select", "matrix_single"], actions: ["create_randomizer", "create_embedded", "add_analysis_test"], randomisation: "a randomizer showing ONE of the concept blocks (show 1); each block sets an embedded arm variable", dataCapture: "the arm variable + the KPI battery", analysis: ["anova", "t_test", "chi_square", "crosstab"], charts: ["mean_ci", "bar_grouped"], aliases: /\bmonadic\b(?!\s*sequential)|\bconcept test/i },
  { id: "sequential_monadic", name: "Sequential monadic concept test", status: "partial", note: "concepts are rotated by a randomizer showing every block; the ORDER a respondent saw is not recorded unless an embedded variable records it, and within-respondent tests (paired t, Wilcoxon, Friedman) run in the Analytics workspace, not from the analysis plan", objective: "several concepts rated by each respondent", designParameters: "the concepts, the same battery per concept, rotation", questionTypes: ["matrix_single", "single_select"], actions: ["create_randomizer", "create_embedded"], randomisation: "a randomizer over the concept blocks, all shown, in random order", dataCapture: "one battery per concept", analysis: ["mean", "top_box", "crosstab"], charts: ["bar_grouped", "dot_plot"], aliases: /\bsequential[\s-]?monadic\b/i },
  { id: "ab_test", name: "A/B (split) test", status: "supported", objective: "one stimulus against another, between respondents", designParameters: "the cells, the outcome", questionTypes: ["single_select"], actions: ["create_randomizer", "create_embedded", "add_analysis_test"], randomisation: "a randomizer showing one stimulus block (show 1) that records the cell", dataCapture: "the cell variable + the outcome", analysis: ["chi_square", "t_test"], charts: ["bar_grouped", "mean_ci"], aliases: /\ba\/b\b|\bab test\b|\bsplit[\s-]test\b/i },
  { id: "maxdiff", name: "MaxDiff (best–worst scaling)", status: "supported", note: "aggregate scores (counts and logit utilities); HB / individual utilities are not estimated — the MaxDiff choice file is the hand-off", objective: "relative importance of 8–30 items on one ratio scale", designParameters: "the items; items per task, tasks and versions are sized by the engine", questionTypes: ["maxdiff_task"], actions: ["create_maxdiff", "update_maxdiff"], randomisation: "a seeded balanced design, versions assigned per respondent, task order randomized", dataCapture: "best and worst per task, the version", analysis: ["maxdiff_scores"], charts: ["maxdiff_utility"], aliases: /\bmax[\s-]?diff\b|\bbest[\s-]?worst\b/i },
  { id: "cbc", name: "Choice-based conjoint (CBC)", status: "supported", note: "aggregate logit part-worths, importances and share simulation; HB / latent class not estimated (the stacked CBC file is the hand-off)", objective: "trade-offs between attribute levels, price included", designParameters: "attributes and their levels, prohibitions, None; alternatives, tasks and versions sized by the engine", questionTypes: ["conjoint_task"], actions: ["create_conjoint", "update_conjoint"], randomisation: "a seeded efficient design, versions per respondent, alternatives shuffled", dataCapture: "the chosen alternative per task, the design row", analysis: ["conjoint_utilities"], charts: ["attribute_importance"], aliases: /\bconjoint\b|\bcbc\b|\bchoice[\s-]?based\b|\bdiscrete choice\b/i },
  { id: "menu_conjoint", name: "Menu-based conjoint", status: "supported", note: "aggregate analysis only", objective: "which priced add-ons are chosen together", designParameters: "the menu items and their prices, required items, selections", questionTypes: ["conjoint_task"], actions: ["create_conjoint"], randomisation: "a seeded design over the prices", dataCapture: "the items chosen per task", analysis: ["conjoint_utilities"], charts: ["attribute_importance"], aliases: /\bmenu[\s-]?based\b|\bbuild[\s-]?your[\s-]?own\b/i },
  { id: "acbc", name: "Adaptive CBC (ACBC)", status: "supported", note: "aggregate analysis only", objective: "trade-offs for many attributes, adapted to the respondent", designParameters: "attributes and levels, screening tasks", questionTypes: ["acbc_task"], actions: ["create_conjoint"], randomisation: "adaptive screening and tournament", dataCapture: "screening, must-haves, tournament choices", analysis: ["conjoint_utilities"], charts: ["attribute_importance"], aliases: /\bacbc\b|\badaptive (?:cbc|choice)\b/i },
  { id: "turf", name: "TURF (reach and frequency)", status: "supported", objective: "which combination of items reaches the most people", designParameters: "the items and the reach measure (would buy / consider)", questionTypes: ["multi_select", "matrix_single"], actions: ["create_question", "add_analysis_test"], randomisation: "item order randomized", dataCapture: "one 0/1 per item (a multi-select, or a grid recoded to top box)", analysis: ["turf"], charts: ["bar_horizontal"], aliases: /\bturf\b|\breach and frequency\b|\bline[\s-]?up optimi[sz]/i },
  { id: "ranking", name: "Ranking / preference order", status: "supported", objective: "a strict order of a short list", designParameters: "up to ~7 items", questionTypes: ["ranking"], actions: ["create_question"], randomisation: "item order randomized", dataCapture: "a rank per item", analysis: ["ranking_scores"], charts: ["ranking_bar"], aliases: /\brank(?:ing)?\b|\bpreference order\b/i },
  { id: "allocation", name: "Constant sum / allocation", status: "supported", objective: "share of preference or spend across items", designParameters: "the items and the total", questionTypes: ["allocation"], actions: ["create_question"], randomisation: "item order randomized", dataCapture: "an amount per item summing to the total", analysis: ["allocation_shares"], charts: ["bar_horizontal"], aliases: /\bconstant[\s-]?sum\b|\ballocat(?:e|ion)\b/i },
  { id: "van_westendorp", name: "Van Westendorp price sensitivity", status: "supported", note: "the four prices are planned as one pricing item over four numeric questions in the order too cheap, cheap, expensive, too expensive", objective: "the acceptable price range of one concept", designParameters: "the concept shown before the four price questions, the currency", questionTypes: ["numeric"], actions: ["create_question", "add_analysis_test"], randomisation: "none (fixed order)", dataCapture: "four prices per respondent", analysis: ["pricing"], charts: ["price_sensitivity"], aliases: /\bvan[\s-]?westendorp\b|\bpsm\b|\bprice sensitivity\b/i },
  { id: "gabor_granger", name: "Gabor–Granger demand", status: "partial", note: "the questions are built here and the Analytics workspace runs Gabor–Granger (prices, accept codes), but a planned pricing item runs Van Westendorp — the plan cannot select Gabor–Granger yet", objective: "demand and revenue at set price points", designParameters: "ascending price points, the purchase-intent scale and which answers count as buying", questionTypes: ["single_select"], actions: ["create_question"], randomisation: "none (ascending prices)", dataCapture: "purchase intent at each price", analysis: ["pricing"], charts: ["demand_curve"], aliases: /\bgabor[\s-]?granger\b|\bdemand curve\b/i },
  { id: "segmentation", name: "Segmentation (cluster)", status: "partial", note: "k-means / hierarchical clustering on a basis battery; latent-class and typing tools are not available", objective: "groups of respondents with different needs or behaviour", designParameters: "the basis battery (needs / attitudes), the number of segments", questionTypes: ["matrix_single"], actions: ["add_analysis_test"], randomisation: "battery row order randomized", dataCapture: "the battery ratings", analysis: ["factor", "cluster"], charts: ["segment_size"], aliases: /\bsegmentation\b|\bclusters?\b|\bpersonas?\b/i },
  { id: "brand_funnel", name: "Brand funnel / equity", status: "partial", note: "the funnel (awareness → consideration → usage → preference) and conversion are run from stage questions over one brand list; composite brand-equity models are not", objective: "conversion between brand stages, by brand", designParameters: "the brand list, the stages", questionTypes: ["multi_select", "single_select"], actions: ["create_question", "add_analysis_test"], randomisation: "brand order randomized", dataCapture: "one multi-select per stage over the same brand codes", analysis: ["brand_funnel"], charts: ["funnel_brand"], aliases: /\bbrand (?:funnel|equity|health)\b|\bawareness\b.*\bconsideration\b/i },
  { id: "driver_analysis", name: "Key driver analysis", status: "supported", objective: "which attributes move an outcome", designParameters: "the attribute battery and the outcome", questionTypes: ["matrix_single", "single_select"], actions: ["add_analysis_test"], randomisation: "battery row order randomized", dataCapture: "attribute ratings + the outcome", analysis: ["regression", "driver_analysis"], charts: ["coefficient_plot"], aliases: /\bkey drivers?\b|\bdriver analysis\b/i },
  { id: "qual_self_completion", name: "Qualitative interview guide (self-completion, AI-probed)", status: "supported", note: "open-ended questions with AI follow-up probes, typed or dictated; themes are keyword-coded counts", objective: "explore reasons, language and experiences in depth", designParameters: "the topics (one block per research question), probes per question", questionTypes: ["long_text", "open_text"], actions: ["create_question", "set_probe"], randomisation: "none (a guide flows)", dataCapture: "the answer and each probe's question and answer", analysis: ["text_themes"], charts: ["word_cloud"], aliases: /\bqualitative\b|\binterview guide\b|\bdiscussion guide\b|\bin[\s-]depth\b|\bopen[\s-]ended\b|\bprob(?:e|es|ing)\b/i },
  { id: "video_response", name: "Video / voice responses", status: "partial", note: "a video_interview question plays a stimulus and records a spoken answer, which is transcribed; dictation works on every open text field; video of the respondent is not recorded in surveys", objective: "spontaneous spoken reactions", designParameters: "the stimulus video, retakes", questionTypes: ["video_interview"], actions: [], randomisation: "none", dataCapture: "audio + transcript", analysis: ["text_themes"], charts: ["word_cloud"], aliases: /\bvideo (?:response|answer|interview)\b|\bvoice (?:response|answer)s?\b|\baudio answers?\b/i },
  { id: "mixed_methods", name: "Mixed methods (phased)", status: "partial", note: "both phases are designed here (a qualitative guide, then the quantitative survey from its propositions) and recorded in the research design; nothing hands qualitative themes to the quantitative phase automatically", objective: "explore first, then measure", designParameters: "phase 1 topics, phase 2 hypotheses derived from phase 1", questionTypes: ["long_text", "single_select", "matrix_single"], actions: ["set_research", "set_probe", "create_question"], randomisation: "per phase", dataCapture: "per phase", analysis: ["text_themes", "crosstab", "chi_square", "regression"], charts: ["word_cloud", "bar_grouped"], aliases: /\bmixed[\s-]?methods?\b|\bqual(?:itative)?\s*(?:then|→|->|followed by|and)\s*quant/i },
];

/** procedures researchers ask for that the platform does not run — each with the supported alternative */
export const UNSUPPORTED_PROCEDURES: readonly Capability[] = [
  { id: "analysis:hb", kind: "analysis", name: "Hierarchical Bayes (individual utilities)", status: "not_supported", note: "aggregate logit is run; export the MaxDiff choice file / stacked CBC file for HB elsewhere", aliases: /\bhierarchical bayes\b|\bhb\b|\bindividual[\s-]level utilit/i },
  { id: "analysis:latent_class", kind: "analysis", name: "Latent class analysis", status: "not_supported", note: "k-means / hierarchical cluster instead", aliases: /\blatent[\s-]class\b|\blca\b/i },
  { id: "analysis:sem", kind: "analysis", name: "Structural equation modelling / CFA", status: "not_supported", note: "regression (moderation, mediation), exploratory factor analysis and reliability instead", aliases: /\bstructural equation\b|\bsem\b|\bconfirmatory factor\b|\bcfa\b|\bpath model/i },
  { id: "analysis:multilevel", kind: "analysis", name: "Multilevel / mixed-effects models", status: "not_supported", note: "regression with a group control instead", aliases: /\bmulti[\s-]?level\b|\bmixed[\s-]effects?\b|\bhierarchical linear\b/i },
  { id: "analysis:ai_coding", kind: "analysis", name: "Automatic AI coding of open text", status: "not_supported", note: "text_themes: counts, sentiment, a keyword coding frame", aliases: /\bai[\s-]?cod(?:e|ing)\b|\bauto[\s-]?cod(?:e|ing)\b|\bthematic analysis\b/i },
  { id: "analysis:paired", kind: "analysis", name: "Paired / repeated-measures tests in the analysis plan", status: "partial", note: "paired t, Wilcoxon and Friedman run in the Analytics workspace; the plan's methods are between-group", aliases: /\bpaired t\b|\brepeated[\s-]measures?\b|\bwilcoxon\b|\bfriedman\b/i },
  { id: "qualitative:moderated", kind: "qualitative", name: "Moderated live interviews / focus groups", status: "not_supported", note: "Studio surveys are self-completion; write the guide as a self-completion interview with AI probes (the Interviews app records and transcribes hiring interviews, not research guides)", aliases: /\bfocus groups?\b|\bmoderated\b|\blive interviews?\b|\bdepth interviews? (?:with|by) (?:a )?moderator/i },
  { id: "qualitative:quotes", kind: "qualitative", name: "Selected quotes in reports", status: "not_supported", note: "open answers are exported and themes counted; quotes are chosen by hand", aliases: /\bquotes?\b|\bverbatims?\b/i },
];

/** how each plan method is run, where it is more limited than its name says */
const ANALYSIS_NOTES: Partial<Record<AnalysisMethod, { status: CapabilityStatus; note: string }>> = {
  text_themes: { status: "partial", note: "word / phrase counts, lexicon sentiment, keyword coding frame; no AI coding, no quotes" },
  conjoint_utilities: { status: "partial", note: "aggregate logit; no HB / latent class" },
  maxdiff_scores: { status: "partial", note: "counts and aggregate utilities; no HB" },
  pricing: { status: "partial", note: "a planned item runs Van Westendorp; Gabor–Granger from the Analytics workspace" },
  brand_funnel: { status: "partial", note: "stages read in variable order (awareness → … → preference)" },
  cluster: { status: "partial", note: "k-means / hierarchical; no latent class" },
  factor: { status: "partial", note: "exploratory (PCA / rotation); no confirmatory model" },
};

const METHOD_NAMES: Record<AnalysisMethod, string> = {
  frequencies: "Frequencies", mean: "Mean", median: "Median", top_box: "Top / bottom box", nps: "NPS", crosstab: "Crosstab / banner",
  chi_square: "Chi-square test", t_test: "t-test (two groups)", anova: "One-way ANOVA", mann_whitney: "Mann–Whitney", kruskal_wallis: "Kruskal–Wallis",
  correlation: "Correlation", regression: "Linear regression (moderation, mediation)", logistic_regression: "Logistic regression", factor: "Factor analysis / PCA", reliability: "Reliability (Cronbach's α)", cluster: "Cluster analysis",
  conjoint_utilities: "Conjoint utilities", maxdiff_scores: "MaxDiff scores", turf: "TURF", driver_analysis: "Driver analysis", text_themes: "Text themes / sentiment",
  ranking_scores: "Ranking scores", allocation_shares: "Allocation shares", pricing: "Pricing (Van Westendorp / Gabor–Granger)", brand_funnel: "Brand funnel",
};

/** the chart each plan method is shown with (`@rescript/analytics` chart ids — checked against its catalogue) */
export const METHOD_CHART: Record<AnalysisMethod, string> = {
  frequencies: "bar_horizontal", mean: "mean_ci", median: "box_plot", top_box: "bar_stacked_100", nps: "gauge", crosstab: "bar_stacked_100",
  chi_square: "bar_grouped", t_test: "mean_ci", anova: "mean_ci", mann_whitney: "box_plot", kruskal_wallis: "box_plot",
  correlation: "scatter_trendline", regression: "coefficient_plot", logistic_regression: "coefficient_plot", factor: "heatmap", reliability: "bar_horizontal", cluster: "segment_size",
  conjoint_utilities: "attribute_importance", maxdiff_scores: "maxdiff_utility", turf: "bar_horizontal", driver_analysis: "coefficient_plot", text_themes: "word_cloud",
  ranking_scores: "ranking_bar", allocation_shares: "bar_horizontal", pricing: "price_sensitivity", brand_funnel: "funnel_brand",
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
];

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
export function capabilityRegistry(): Capability[] {
  registerBuiltinQuestionTypes();
  const copilot = copilotQuestionTypes();
  const out: Capability[] = [];
  for (const m of METHODOLOGIES) out.push({ id: `methodology:${m.id}`, kind: "methodology", name: m.name, status: m.status, ...(m.note ? { note: m.note } : {}), implementedAs: { questionTypes: m.questionTypes, actions: m.actions, analysis: m.analysis }, aliases: m.aliases });
  for (const p of questionTypeRegistry.all()) {
    const n = QUESTION_TYPE_NOTES[p.type];
    const viaCopilot = copilot.has(p.type);
    const note = [n?.note, viaCopilot ? "" : "built in the Studio editor (no Intelligent-mode create)"].filter(Boolean).join("; ");
    out.push({ id: `question_type:${p.type}`, kind: "question_type", name: p.label, status: n?.status ?? "supported", ...(note ? { note } : {}) });
  }
  for (const m of ANALYSIS_METHODS) {
    const n = ANALYSIS_NOTES[m];
    out.push({ id: `analysis:${m}`, kind: "analysis", name: METHOD_NAMES[m], status: n?.status ?? "supported", ...(n ? { note: n.note } : {}), implementedAs: { analysis: [m] } });
  }
  out.push(...UNSUPPORTED_PROCEDURES);
  out.push(
    { id: "qualitative:open_ends", kind: "qualitative", name: "Open-ended questions (short / essay)", status: "supported", implementedAs: { questionTypes: ["open_text", "long_text"], actions: ["create_question"] } },
    { id: "qualitative:probes", kind: "qualitative", name: "AI follow-up probes on open ends", status: "supported", note: "up to 5 per question, gated by conditions; fixed wording or written by the AI at run time", implementedAs: { actions: ["set_probe"] }, aliases: /\bprob(?:e|es|ing)\b|\bfollow[\s-]?ups?\b/i },
    { id: "qualitative:dictation", kind: "qualitative", name: "Spoken answers (dictation) on open text", status: "supported", note: "on by default on every prose field" },
    { id: "qualitative:transcription", kind: "qualitative", name: "Recorded audio answers with transcription", status: "partial", note: "video_interview questions only" },
    { id: "qualitative:conversational", kind: "qualitative", name: "AI conversational interviewer (voice)", status: "supported", note: "reads the programmed survey aloud and takes spoken answers; the survey stays the authority" },
    { id: "qualitative:themes", kind: "qualitative", name: "Theme coding of open answers", status: "partial", note: ANALYSIS_NOTES.text_themes!.note, implementedAs: { analysis: ["text_themes"] } },
  );
  out.push(...EXPORTS.map(({ module: _m, symbol: _s, ...c }) => { void _m; void _s; return c; }));
  // the action vocabulary is the source of truth for what a methodology can be built with
  for (const c of out) for (const a of c.implementedAs?.actions ?? []) if (!(SURVEY_ACTION_OPS as readonly string[]).includes(a)) throw new Error(`capability ${c.id} names an action the engine does not have: ${a}`);
  return out;
}

export const capabilityOf = (id: string): Capability | undefined => capabilityRegistry().find((c) => c.id === id);
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

const STATUS_WORD: Record<CapabilityStatus, string> = { supported: "supported", partial: "partial", not_supported: "not supported" };

/**
 * The capabilities in a few lines, for the research guide: the methodologies
 * with their status, the procedures that are partial or not run. Generated —
 * the model is told what exists from the registry, not from prose.
 */
export function capabilityBrief(): string {
  const reg = capabilityRegistry();
  const meth = METHODOLOGIES.map((m) => `${m.name}${m.status === "supported" ? "" : ` [${STATUS_WORD[m.status]}]`}`).join("; ");
  const short = (n?: string) => (n ? `: ${n.split(/;|, (?:export|the plan)/)[0].trim()}` : "");
  const limited = reg.filter((c) => c.kind === "analysis" && c.status !== "supported").map((c) => `${c.name} [${STATUS_WORD[c.status]}${short(c.note)}]`).join("; ");
  const qual = reg.filter((c) => c.kind === "qualitative" && c.status !== "supported").map((c) => `${c.name} [${STATUS_WORD[c.status]}]`).join("; ");
  return `CAPABILITIES (from the registry). Methodologies: ${meth}. Analysis limits: ${limited}. Qualitative limits: ${qual}.`;
}

/** the registry as markdown tables — the public page `capabilities.md` and the research-intelligence doc */
export function capabilityMarkdown(): string {
  const reg = capabilityRegistry();
  const esc = (s: string | undefined) => (s ?? "").replace(/\|/g, "\\|");
  const table = (rows: Capability[]) => ["| Capability | Status | What works / the alternative |", "|---|---|---|", ...rows.map((c) => `| ${esc(c.name)} | ${STATUS_WORD[c.status]} | ${esc(c.note)} |`)].join("\n");
  const meth = ["| Methodology | Status | Questions | Randomisation | Analysis | Chart | Notes |", "|---|---|---|---|---|---|---|", ...METHODOLOGIES.map((m) => `| ${esc(m.name)} | ${STATUS_WORD[m.status]} | ${m.questionTypes.join(", ")} | ${esc(m.randomisation)} | ${m.analysis.join(", ")} | ${m.charts.join(", ")} | ${esc(m.note)} |`)].join("\n");
  return [
    "## Methodologies", "", meth, "",
    "## Analytical procedures", "", table(reg.filter((c) => c.kind === "analysis")), "",
    "## Qualitative support", "", table(reg.filter((c) => c.kind === "qualitative")), "",
    "## Question types", "", table(reg.filter((c) => c.kind === "question_type")), "",
    "## Exports and documents", "", table(reg.filter((c) => c.kind === "export")), "",
  ].join("\n");
}

/**
 * STARTER TEMPLATES — the studies people actually run.
 *
 * The template mechanism has existed since the first release with exactly one
 * entry in it: the 120-question Master Demo, which is a capability showcase
 * and a poor place to start real work. "New survey" therefore offered a
 * choice between a blank definition and a demo of everything.
 *
 * These are the other kind: small, completely programmed studies that a
 * researcher recognises by name and can field or adapt the same afternoon.
 * Each one is written the way a survey programmer would write it — screening
 * that terminates, logic that depends on earlier answers, piping, quotas that
 * mean something, calculations that produce the derived variable the analysis
 * expects — because a starter that skips the programming teaches the wrong
 * lesson about what this platform is for.
 *
 * Every template here passes `runQualityCheck` with no errors and no
 * warnings. That is asserted in `starters.test.ts`, and it is the reason to
 * trust them: a starter that ships with a stranded question or an impossible
 * quota is worse than no starter at all.
 */
import { SurveyDefinition } from "@rescript/schema";
import type { FlowNode } from "@rescript/schema";
import { AGREE_5, SAT_5, YES_NO, opts, page, rule } from "./builders.js";

type Q = Record<string, unknown>;

/** The shell every starter shares: ends, branding, deployment. */
function survey(
  surveyId: string,
  meta: { code: string; title: string },
  questions: Q[],
  flow: FlowNode[],
  extra: Record<string, unknown> = {},
): SurveyDefinition {
  /*
   * Only the ends something can actually reach.
   *
   * Adding a screen-out End to a survey with no screening is not harmless
   * tidiness: it is a node no respondent will ever see, and the quality check
   * says so — correctly. So the ends are derived from the programming, which
   * is also the honest way round: a template that screens has a screen-out
   * message, and one that does not, does not.
   */
  const terminates = JSON.stringify(questions).includes('"terminate"');
  const hasQuotas = Array.isArray((extra as { quotas?: unknown[] }).quotas)
    && ((extra as { quotas: unknown[] }).quotas.length > 0);
  return SurveyDefinition.parse({
    meta: { id: surveyId, code: meta.code, title: meta.title, version: "1.0", status: "draft" },
    questions,
    flow: [
      ...flow,
      { type: "end", id: "end_complete", status: "complete", message: "Thank you — your answers have been recorded." },
      ...(terminates
        ? [{ type: "end", id: "end_screened", status: "screened", message: "Thank you for your interest. You do not qualify for this study." }]
        : []),
      ...(hasQuotas
        ? [{ type: "end", id: "end_quota", status: "quota_full", message: "Thank you — we have already heard from enough people like you." }]
        : []),
    ],
    deployment: { clientSlug: "client", studySlug: meta.code.toLowerCase().replace(/[^a-z0-9]+/g, "-") },
    ...extra,
  });
}

const screenOut = (id: string, when: unknown) =>
  ({ id, when, target: { kind: "terminate", status: "screened" } });

/* ==================================================================== NPS */

export function buildNpsSurvey(surveyId = "nps"): SurveyDefinition {
  const questions: Q[] = [
    {
      id: "q_nps", code: "Q1", variableName: "NPS", type: "nps", required: true,
      text: "How likely are you to recommend us to a friend or colleague?",
      settings: { minValue: 0, maxValue: 10, leftLabel: "Not at all likely", rightLabel: "Extremely likely" },
    },
    {
      id: "q_why_detractor", code: "Q2", variableName: "WHY_DETRACTOR", type: "long_text", required: true,
      text: "What is the main reason for your score?",
      instruction: "Please be as specific as you can — we read every answer.",
      displayLogic: rule("q_nps", "lte", 6),
    },
    {
      id: "q_why_passive", code: "Q3", variableName: "WHY_PASSIVE", type: "long_text", required: true,
      text: "What would it take to move your score closer to 10?",
      displayLogic: { type: "group", op: "and", children: [rule("q_nps", "gte", 7), rule("q_nps", "lte", 8)] },
    },
    {
      id: "q_why_promoter", code: "Q4", variableName: "WHY_PROMOTER", type: "long_text", required: true,
      text: "What do we do well that you would tell a friend about?",
      displayLogic: rule("q_nps", "gte", 9),
    },
    {
      id: "q_areas", code: "Q5", variableName: "AREAS", type: "matrix_single",
      text: "How satisfied are you with each of the following?",
      rows: opts(["Ease of use", "Value for money", "Customer support", "Reliability"]).map((o) => ({ code: o.code, label: o.label })),
      options: SAT_5, required: true,
    },
    {
      id: "q_contact", code: "Q6", variableName: "CONTACT_OK", type: "single_select", required: true,
      text: "May we contact you about your feedback?", options: YES_NO,
    },
    {
      id: "c_group", code: "C1", variableName: "NPS_GROUP", type: "calculated",
      text: "NPS group", settings: { expression: 'if(NPS >= 9, "Promoter", if(NPS >= 7, "Passive", "Detractor"))', hidden: true },
    },
  ];
  return survey(surveyId, { code: "NPS", title: "Net Promoter Score — relationship survey" }, questions, [
    page("p_score", "The score", ["q_nps"]),
    page("p_reason", "Why", ["q_why_detractor", "q_why_passive", "q_why_promoter"]),
    page("p_areas", "Where we stand", ["q_areas", "q_contact"]),
    page("p_calc", "", ["c_group"]),
  ], {
    calculations: [{
      id: "calc_nps_group", targetVariable: "NPS_GROUP_CALC", label: "NPS group",
      expression: 'if(NPS >= 9, 3, if(NPS >= 7, 2, 1))', trigger: "on_page_submit", dataType: "numeric",
    }],
  });
}

/* =================================================================== CSAT */

export function buildCsatSurvey(surveyId = "csat"): SurveyDefinition {
  const questions: Q[] = [
    {
      id: "q_csat", code: "Q1", variableName: "CSAT", type: "single_select", required: true,
      text: "Overall, how satisfied were you with the support you received?", options: SAT_5,
    },
    {
      id: "q_resolved", code: "Q2", variableName: "RESOLVED", type: "single_select", required: true,
      text: "Was your issue resolved?",
      options: opts(["Yes, completely", "Partly", "No", { code: 98, label: "It is still open", flags: ["anchor_bottom"] }]),
    },
    {
      id: "q_ces", code: "Q3", variableName: "CES", type: "single_select", required: true,
      text: "How much effort did you personally have to put in to get your issue handled?",
      options: opts(["Very low effort", "Low effort", "Neither", "High effort", "Very high effort"]),
    },
    {
      id: "q_unresolved_why", code: "Q4", variableName: "UNRESOLVED_WHY", type: "long_text", required: true,
      text: "What is still outstanding?",
      displayLogic: rule("q_resolved", "in", [2, 3, 98]),
    },
    {
      id: "q_agent", code: "Q5", variableName: "AGENT", type: "matrix_single",
      text: "Thinking about the person who helped you, how much do you agree?",
      rows: opts([
        "They understood my problem",
        "They kept me informed",
        "They were courteous",
        "They had the authority to help",
      ]).map((o) => ({ code: o.code, label: o.label })),
      options: AGREE_5, required: true,
    },
    {
      id: "q_open", code: "Q6", variableName: "OPEN", type: "long_text",
      text: "Anything else you would like us to know?",
    },
  ];
  return survey(surveyId, { code: "CSAT", title: "Customer satisfaction — support interaction" }, questions, [
    page("p_overall", "Your experience", ["q_csat", "q_resolved", "q_ces"]),
    page("p_detail", "Detail", ["q_unresolved_why", "q_agent"]),
    page("p_open", "Anything else", ["q_open"]),
  ]);
}

/* ============================================================== screener */

export function buildScreenerSurvey(surveyId = "screener"): SurveyDefinition {
  const questions: Q[] = [
    {
      id: "q_consent", code: "S1", variableName: "CONSENT", type: "single_select", required: true,
      text: "This survey takes about 10 minutes and your answers are confidential. Would you like to take part?",
      options: opts(["Yes, I agree to take part", "No thank you"]),
      skipLogic: [screenOut("sk_consent", rule("q_consent", "selected", 2))],
    },
    {
      id: "q_age", code: "S2", variableName: "AGE", type: "numeric", required: true,
      text: "What is your age?", settings: { minValue: 16, maxValue: 99 },
      skipLogic: [screenOut("sk_age", rule("q_age", "lt", 18))],
    },
    {
      id: "q_gender", code: "S3", variableName: "GENDER", type: "single_select", required: true,
      text: "How do you describe yourself?",
      options: opts(["Woman", "Man", "In another way", { code: 99, label: "Prefer not to say", flags: ["anchor_bottom"] }]),
    },
    {
      id: "q_region", code: "S4", variableName: "REGION", type: "single_select", required: true,
      text: "Where do you live?", options: opts(["North", "South", "East", "West"]),
    },
    {
      id: "q_industry", code: "S5", variableName: "INDUSTRY", type: "single_select", required: true,
      text: "Which of these best describes where you work?",
      options: opts([
        "Market research", "Advertising or marketing", "Media or journalism",
        "None of these",
      ]),
      // the standard security screen: people who work in the category are excluded
      skipLogic: [screenOut("sk_industry", rule("q_industry", "in", [1, 2, 3]))],
    },
    {
      id: "q_category", code: "S6", variableName: "CATEGORY", type: "multi_select", required: true,
      text: "Which of these have you bought in the last three months?",
      options: opts([
        "Coffee", "Tea", "Soft drinks", "Bottled water", "Energy drinks",
        { code: 98, label: "None of these", flags: ["exclusive", "none_of_above", "anchor_bottom"] },
      ]),
      skipLogic: [screenOut("sk_category", rule("q_category", "selected", 98))],
    },
    {
      id: "q_ageband", code: "C1", variableName: "AGE_BAND", type: "calculated",
      text: "Age band", settings: { expression: "if(AGE < 35, 1, if(AGE < 55, 2, 3))", hidden: true },
    },
  ];
  const agree = (v: number) => rule("q_ageband", "eq", v, undefined, { kind: "calculation" as const });
  return survey(surveyId, { code: "SCREENER", title: "Screener with quotas" }, questions, [
    page("p_consent", "Consent", ["q_consent"]),
    page("p_demo", "About you", ["q_age", "q_gender", "q_region"]),
    page("p_security", "Your work", ["q_industry"]),
    page("p_category", "The category", ["q_category"]),
    page("p_bands", "", ["q_ageband"]),
    { type: "quota_check", id: "qc1", quotaIds: ["quota_age"], onFull: { kind: "terminate" } } as FlowNode,
  ], {
    quotas: [{
      id: "quota_age", name: "Age band", mode: "hard", targetTotal: 600,
      countStatus: ["complete"], onFull: { kind: "terminate" },
      cells: [
        { id: "cell_1834", label: "18–34", limit: 200, limitType: "count", when: agree(1) },
        { id: "cell_3554", label: "35–54", limit: 200, limitType: "count", when: agree(2) },
        { id: "cell_55p", label: "55+", limit: 200, limitType: "count", when: agree(3) },
      ],
    }],
  });
}

/* ========================================================= brand tracker */

export function buildBrandTrackerSurvey(surveyId = "brand-tracker"): SurveyDefinition {
  const BRANDS = opts(["Northwind", "Contoso", "Fabrikam", "Litware", "Proseware", "Tailspin"]);
  const questions: Q[] = [
    {
      id: "q_aware", code: "Q1", variableName: "AWARE", type: "multi_select", required: true,
      text: "Which of these brands have you heard of?",
      options: [...BRANDS, { code: 98, label: "None of these", flags: ["exclusive", "none_of_above", "anchor_bottom"] }],
      randomization: { enabled: true, scope: "options", method: "shuffle" },
    },
    {
      id: "q_consider", code: "Q2", variableName: "CONSIDER", type: "multi_select", required: true,
      text: "And which of these would you consider buying?",
      instruction: "Only the brands you have heard of are shown.",
      carryForward: { sourceQuestionId: "q_aware", filter: "selected", into: "options" },
      displayLogic: rule("q_aware", "answered"),
    },
    {
      id: "q_used", code: "Q3", variableName: "USED", type: "multi_select", required: true,
      text: "Which have you actually bought in the last 12 months?",
      carryForward: { sourceQuestionId: "q_consider", filter: "selected", into: "options" },
      displayLogic: rule("q_consider", "answered"),
    },
    {
      id: "q_main", code: "Q4", variableName: "MAIN", type: "single_select", required: true,
      text: "Which is your main brand?",
      carryForward: { sourceQuestionId: "q_used", filter: "selected", into: "options" },
      displayLogic: rule("q_used", "answered"),
    },
    {
      id: "q_image", code: "Q5", variableName: "IMAGE", type: "matrix_multi",
      text: "Which brands would you say each of these describes?",
      rows: opts(["Good value", "High quality", "Innovative", "Trustworthy", "For people like me"])
        .map((o) => ({ code: o.code, label: o.label })),
      carryForward: { sourceQuestionId: "q_aware", filter: "selected", into: "options" },
      required: true,
    },
    {
      id: "q_sat", code: "Q6", variableName: "SAT_MAIN", type: "single_select", required: true,
      text: "How satisfied are you with {{Q4}}?",
      options: SAT_5,
      displayLogic: rule("q_main", "answered"),
    },
    {
      id: "q_wave", code: "H1", variableName: "WAVE", type: "hidden",
      text: "Fieldwork wave", notes: "Set from the invitation URL: ?WAVE=2026Q3",
    },
  ];
  return survey(surveyId, { code: "TRACKER", title: "Brand tracker — quarterly wave" }, questions, [
    {
      type: "embedded_data", id: "ed_wave",
      fields: [{ name: "WAVE", source: "url", dataType: "string" }],
    } as FlowNode,
    page("p_funnel", "Brand funnel", ["q_aware", "q_consider", "q_used", "q_main"]),
    page("p_image", "Brand image", ["q_image"]),
    page("p_sat", "Your main brand", ["q_sat"]),
    page("p_wave", "", ["q_wave"]),
  ]);
}

/* ==================================================== employee engagement */

export function buildEmployeeSurvey(surveyId = "employee"): SurveyDefinition {
  const questions: Q[] = [
    {
      id: "q_enps", code: "Q1", variableName: "ENPS", type: "nps", required: true,
      text: "How likely are you to recommend this organisation as a place to work?",
      settings: { minValue: 0, maxValue: 10, leftLabel: "Not at all likely", rightLabel: "Extremely likely" },
    },
    {
      id: "q_engage", code: "Q2", variableName: "ENGAGE", type: "matrix_single",
      text: "How much do you agree with each statement?",
      rows: opts([
        "I know what is expected of me at work",
        "I have the tools I need to do my job well",
        "My manager gives me useful feedback",
        "My work gives me a sense of accomplishment",
        "I can see a future for myself here",
        "I would speak up if I saw something wrong",
      ]).map((o) => ({ code: o.code, label: o.label })),
      options: AGREE_5, required: true,
      randomization: { enabled: true, scope: "rows", method: "shuffle" },
    },
    {
      id: "q_tenure", code: "Q3", variableName: "TENURE", type: "single_select", required: true,
      text: "How long have you worked here?",
      options: opts(["Less than a year", "1–3 years", "3–5 years", "More than 5 years"]),
    },
    {
      id: "q_dept", code: "Q4", variableName: "DEPT", type: "single_select", required: true,
      text: "Which team are you part of?",
      options: opts(["Product", "Engineering", "Sales", "Marketing", "Operations", "Support", "Other"]),
    },
    {
      id: "q_best", code: "Q5", variableName: "BEST", type: "long_text",
      text: "What is the best thing about working here?",
    },
    {
      id: "q_change", code: "Q6", variableName: "CHANGE", type: "long_text",
      text: "If you could change one thing, what would it be?",
    },
    {
      id: "q_confidential", code: "I1", type: "html", variableName: "CONFIDENTIAL",
      text: "Your answers are confidential.",
      customHtml: "<p>Your answers are confidential and are reported only in groups of five or more. Nobody in your team sees your individual responses.</p>",
    },
  ];
  return survey(surveyId, { code: "ENGAGE", title: "Employee engagement — annual" }, questions, [
    page("p_intro", "Before you start", ["q_confidential"]),
    page("p_enps", "Working here", ["q_enps", "q_engage"]),
    page("p_about", "About your role", ["q_tenure", "q_dept"]),
    page("p_open", "In your words", ["q_best", "q_change"]),
  ]);
}

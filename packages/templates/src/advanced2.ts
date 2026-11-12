/**
 * ADVANCED RESEARCH TEMPLATES, PART 2 (2026-11-12): adaptive conjoint, menu-based choice, diary, healthcare,
 * advertising / concept test, product test, political, multi-country and the hybrid study.
 * Same rules as advanced.ts: native parts only, the strict quality check, simulated respondents, fictional content.
 */
import { SurveyDefinition } from "@rescript/schema";
import type { FlowNode } from "@rescript/schema";
import { methodTemplateFragment } from "@rescript/engine";
import { AGREE_5, LIKELY_5, SAT_5, YES_NO, and, calcRule, embeddedRule, not, opts, or, page, rule, type OptSpec } from "./builders.js";
import { screenOut, survey } from "./starters.js";
import { AGE, AGE_BAND, NONE, OTHER, ageQuota, derived, design, rows, shuffle } from "./advanced.js";

type Q = Record<string, unknown>;
const minter = (tag: string) => { const n: Record<string, number> = {}; return (prefix: string) => { n[prefix] = (n[prefix] ?? 0) + 1; return `${prefix}_${tag}_${n[prefix]}`; }; };
const plan = (tests: Record<string, unknown>[], ids: (p: string) => string) => ({ hypotheses: [], constructs: [], analysis: [], assumptions: [], sources: [], analysisPlan: { crosstabs: [], tests: tests.map((t) => ({ id: ids("t"), ...t })), derived: [], segments: [] } });
const withResearch = (def: SurveyDefinition, research: unknown): SurveyDefinition => SurveyDefinition.parse({ ...JSON.parse(JSON.stringify(def)), research });
const PREFER_NOT: OptSpec = { code: 99, label: "Prefer not to say", flags: ["exclusive", "anchor_bottom"] };

/* ================================================================ 7. Adaptive choice-based conjoint */

export function buildAdvAcbcSurvey(surveyId = "adv-acbc"): SurveyDefinition {
  const acbc = {
    id: "design_acbc_laptop", name: "Laptop ACBC", kind: "acbc",
    config: { attributes: [
      { name: "Brand", levels: ["Arcadia", "Brightwell", "Corvus"] },
      { name: "Screen", levels: ["13 inch", "14 inch", "16 inch"] },
      { name: "Memory", levels: ["8 GB", "16 GB", "32 GB"] },
      { name: "Battery life", levels: ["8 hours", "12 hours", "18 hours"] },
      { name: "Price", levels: ["$799", "$1,099", "$1,399", "$1,799"] },
    ], screeningTasks: 4 },
  };
  const questions: Q[] = [
    AGE, AGE_BAND,
    { id: "q_buy", code: "S2", variableName: "BUY_SOON", type: "single_select", required: true, text: "Do you expect to buy a laptop in the next 12 months?", options: opts(["Yes, definitely", "Yes, probably", "No"]), skipLogic: [screenOut("sk_buy", rule("q_buy", "selected", 3))] },
    { id: "q_use", code: "S3", variableName: "MAIN_USE", type: "single_select", required: true, text: "What will you mainly use it for?", options: [...opts(["Work", "Study", "Gaming", "Creative work (photo, video, music)", "Everyday browsing"]), OTHER], randomization: shuffle },
    { id: "i_acbc", code: "I1", variableName: "I_ACBC", type: "html", text: "<p>You will now build the laptop you would like, tell us what you would never accept, and then choose between laptops made for you. What you see at each step depends on your earlier answers.</p>" },
    { id: "q_acbc", code: "A1", variableName: "ACBC", type: "acbc_task", required: true, text: "Build and choose your laptop", settings: { designRef: "design_acbc_laptop" } },
    { id: "q_sure", code: "A2", variableName: "WINNER_INTENT", type: "single_select", required: true, text: "How likely would you be to buy the laptop you ended with, at its price?", options: LIKELY_5 },
    { id: "q_stop", code: "A3", variableName: "WHY_NOT", type: "long_text", required: true, text: "What would stop you buying it?", displayLogic: rule("q_sure", "in", [1, 2, 3]) },
    derived("h_use", "USE_GROUP", "Use group (derived)", opts(["Professional", "Performance", "Everyday"]), [[1, rule("q_use", "in", [1, 2])], [2, rule("q_use", "in", [3, 4])], [3]]),
  ];
  return survey(surveyId, { code: "ACBC", title: "Adaptive choice-based conjoint — laptops" }, questions, [
    page("p_age", "About you", ["q_age", "h_age"]),
    page("p_screen", "Your next laptop", ["q_buy", "q_use", "h_use"]),
    page("p_intro", "", ["i_acbc"]),
    page("p_acbc", "Your laptop", ["q_acbc"]),
    page("p_after", "Your choice", ["q_sure", "q_stop"]),
  ], { designs: [acbc] });
}

/* ================================================================ 8. Menu-based choice */

export function buildAdvMenuSurvey(surveyId = "adv-menu"): SurveyDefinition {
  const ADDONS: [string, string, string, number][] = [["q_ad_seats", "ADD_SEATS", "Ten extra user seats", 40], ["q_ad_ai", "ADD_AI", "AI assistant", 25], ["q_ad_sso", "ADD_SSO", "Single sign-on and audit log", 30], ["q_ad_support", "ADD_SUPPORT", "Priority support (1-hour response)", 35], ["q_ad_store", "ADD_STORAGE", "Extra 1 TB storage", 15]];
  const total = `if(PLAN == 1, 20, if(PLAN == 2, 60, 150)) + ${ADDONS.map(([, v, , price]) => `if(${v} == 1, ${price}, 0)`).join(" + ")}`;
  const questions: Q[] = [
    { id: "q_resp", code: "S1", variableName: "RESPONSIBLE", type: "single_select", required: true, text: "Do you choose or pay for software subscriptions for your team or business?", options: YES_NO, skipLogic: [screenOut("sk_resp", rule("q_resp", "selected", 2))] },
    { id: "q_size", code: "S2", variableName: "TEAM_SIZE", type: "single_select", required: true, text: "How many people would use it?", options: opts(["1–5", "6–20", "21–100", "More than 100"]) },
    { id: "q_budget", code: "S3", variableName: "BUDGET", type: "numeric", required: true, text: "What is the most you would spend per month on a project-management tool, in US dollars?", settings: { minValue: 10, maxValue: 2000 } },
    { id: "i_menu", code: "I1", variableName: "I_MENU", type: "html", text: "<p><b>Plannr</b> (a fictional example) is a project-management tool. Choose a plan, then decide on each extra. Prices are per month.</p>" },
    { id: "q_plan", code: "M1", variableName: "PLAN", type: "single_select", required: true, text: "Which plan would you choose?", options: opts(["Starter — $20: 5 seats, 10 projects", "Team — $60: 20 seats, unlimited projects", "Business — $150: 100 seats, unlimited projects, admin controls"]) },
    /* single sign-on is offered only on the Business plan; extra seats are not offered where seats are already ample */
    ...ADDONS.map(([id, v, label, price]): Q => ({ id, code: v, variableName: v, type: "single_select", required: true, text: `${label} — $${price} a month. Add it?`, options: YES_NO, ...(id === "q_ad_sso" ? { displayLogic: rule("q_plan", "selected", 3) } : id === "q_ad_seats" ? { displayLogic: rule("q_plan", "in", [1, 2]) } : {}) })),
    { id: "q_ok", code: "M3", variableName: "CONFIRM", type: "single_select", required: true, text: "Your package comes to ${{calc.MENU_TOTAL}} a month. Would you buy it at that price?", options: opts(["Yes", "No — too expensive", "No — something is missing"]) },
    { id: "q_drop", code: "M4", variableName: "WOULD_DROP", type: "multi_select", required: true, text: "Your package is above the ${{BUDGET}} a month you said you would spend. What would you do?", options: [...opts(["Choose a cheaper plan", "Remove one or more extras", "Raise the budget"]), NONE("None of these — I would not buy")], displayLogic: calcRule("MENU_OVER", "eq", 1) },
    { id: "q_missing", code: "M5", variableName: "MISSING", type: "long_text", required: true, text: "What is missing?", displayLogic: rule("q_ok", "selected", 3) },
  ];
  return survey(surveyId, { code: "MENU", title: "Menu-based choice — software subscription" }, questions, [
    page("p_screen", "Your role", ["q_resp", "q_size", "q_budget"]),
    page("p_intro", "", ["i_menu"]),
    page("p_plan", "Choose a plan", ["q_plan"]),
    page("p_addons", "Choose your extras", ADDONS.map(([id]) => id)),
    page("p_total", "Your package", ["q_ok", "q_drop", "q_missing"]),
  ], { calculations: [
    { id: "calc_total", targetVariable: "MENU_TOTAL", label: "Package price per month", expression: total, trigger: "on_page_submit", dataType: "numeric" },
    { id: "calc_over", targetVariable: "MENU_OVER", label: "Over the stated budget", expression: `if((${total}) > BUDGET, 1, 0)`, trigger: "on_page_submit", dataType: "numeric" },
  ] });
}

/* ================================================================ 9. Diary study (one link per day) */

export function buildAdvDiarySurvey(surveyId = "adv-diary"): SurveyDefinition {
  const day = (op: "eq" | "gte" | "lte", v: number) => embeddedRule("DAY", op, v);
  const questions: Q[] = [
    /* day 0: baseline */
    { id: "q_consent", code: "B0", variableName: "CONSENT", type: "single_select", required: true, text: "This is a seven-day diary about a skincare product. You will get one short entry a day. Do you agree to take part?", options: opts(["Yes, I agree", "No"]), displayLogic: day("eq", 0), skipLogic: [screenOut("sk_consent", rule("q_consent", "selected", 2))] },
    { id: "q_skin", code: "B1", variableName: "SKIN_TYPE", type: "single_select", required: true, text: "How would you describe your skin?", options: opts(["Dry", "Oily", "Combination", "Sensitive", "Normal"]), displayLogic: day("eq", 0) },
    { id: "q_routine", code: "B2", variableName: "ROUTINE", type: "multi_select", required: true, text: "Which of these do you use at least weekly?", options: [...opts(["Cleanser", "Moisturiser", "Sunscreen", "Serum", "Exfoliant"]), NONE()], displayLogic: day("eq", 0), randomization: shuffle },
    { id: "q_expect", code: "B3", variableName: "EXPECT", type: "long_text", required: false, text: "What do you hope the product will do for you?", displayLogic: day("eq", 0) },
    /* days 1–7: the daily entry */
    { id: "q_used", code: "D1", variableName: "USED_TODAY", type: "single_select", required: true, text: "Day {{ed.DAY}} of 7. Did you use the product today?", options: opts(["Yes, morning and evening", "Yes, once", "No"]), displayLogic: day("gte", 1) },
    { id: "q_whynot", code: "D2", variableName: "WHY_NOT", type: "multi_select", required: true, text: "Why not?", options: [...opts(["I forgot", "No time", "My skin reacted", "I was away from home"]), OTHER], displayLogic: and(day("gte", 1), rule("q_used", "selected", 3)) },
    { id: "q_feel", code: "D3", variableName: "FEEL", type: "matrix_single", required: true, text: "How did your skin feel today?", rows: rows(["Hydrated", "Smooth", "Comfortable", "Irritated"]), options: opts(["Not at all", "A little", "Moderately", "Very"]), displayLogic: and(day("gte", 1), rule("q_used", "in", [1, 2])) },
    { id: "q_react", code: "D4", variableName: "REACTION", type: "long_text", required: true, text: "Please describe the irritation.", displayLogic: and(day("gte", 1), rule("q_feel", "in", [3, 4], undefined, { rowCode: "4" })) },
    { id: "q_daysat", code: "D5", variableName: "DAY_SAT", type: "single_select", required: true, text: "Overall, how satisfied were you with the product today?", options: SAT_5, displayLogic: and(day("gte", 1), rule("q_used", "in", [1, 2])) },
    /* day 7: wrap-up */
    { id: "q_overall", code: "W1", variableName: "OVERALL", type: "single_select", required: true, text: "After a week, how satisfied are you with the product overall?", options: SAT_5, displayLogic: day("eq", 7) },
    { id: "q_buy", code: "W2", variableName: "PURCHASE_INTENT", type: "single_select", required: true, text: "How likely would you be to buy it?", options: LIKELY_5, displayLogic: day("eq", 7) },
    { id: "q_change", code: "W3", variableName: "CHANGE", type: "long_text", required: false, text: "What one thing would you change about it?", displayLogic: day("eq", 7) },
  ];
  return survey(surveyId, { code: "DIARY", title: "Seven-day diary — product usage" }, questions, [
    { type: "embedded_data", id: "ed_wave", title: "Participant and day", fields: [{ name: "PID", source: "url", defaultValue: "TEST" }, { name: "DAY", source: "url", defaultValue: "0", dataType: "integer" }] } as FlowNode,
    /* consent has a page of its own — it is given before anything else is asked (2026-11-12) */
    page("p_consent", "Taking part", ["q_consent"]),
    page("p_base", "Before you start", ["q_skin", "q_routine", "q_expect"]),
    /* the daily entry in three steps: use, how the skin felt (with its follow-up), the day's rating */
    page("p_day", "Today", ["q_used", "q_whynot"]),
    page("p_feel", "Your skin today", ["q_feel", "q_react"]),
    page("p_daysat", "Today overall", ["q_daysat"]),
    page("p_wrap", "Looking back", ["q_overall", "q_buy", "q_change"]),
  ]);
}

/* ================================================================ 10. Healthcare: patients and professionals */

export function buildAdvHealthSurvey(surveyId = "adv-health"): SurveyDefinition {
  const pt = rule("q_who", "selected", 1), hcp = rule("q_who", "selected", 2);
  const CONDITIONS = opts(["Type 2 diabetes", "High blood pressure", "Asthma", "Migraine"]);
  const questions: Q[] = [
    { id: "q_consent", code: "C1", variableName: "CONSENT", type: "single_select", required: true, text: "This study asks about health. Your answers are confidential and reported only in total; you may skip any question marked optional and stop at any time. It is for research and education only — it is not medical advice and not a diagnostic tool. Do you agree to continue?", options: opts(["I agree", "I do not agree"]), skipLogic: [screenOut("sk_consent", rule("q_consent", "selected", 2))] },
    { id: "q_who", code: "S1", variableName: "RESP_TYPE", type: "single_select", required: true, text: "Which describes you?", options: opts(["I have, or care for someone who has, a long-term health condition", "I am a healthcare professional", "Neither"]), skipLogic: [screenOut("sk_who", rule("q_who", "selected", 3))] },
    /* patients */
    { id: "q_cond", code: "P1", variableName: "CONDITIONS", type: "multi_select", required: true, text: "Which of these conditions have been diagnosed by a doctor?", options: [...CONDITIONS, NONE()], displayLogic: pt, skipLogic: [screenOut("sk_cond", rule("q_cond", "selected", 98))] },
    { id: "q_main", code: "P2", variableName: "MAIN_CONDITION", type: "single_select", required: true, text: "Which of them affects daily life the most?", options: [], carryForward: { sourceQuestionId: "q_cond", filter: "selected", into: "options" }, displayLogic: pt },
    { id: "q_years", code: "P3", variableName: "YEARS_DX", type: "single_select", required: true, text: "How long ago was {{MAIN_CONDITION}} diagnosed?", options: opts(["Less than a year", "1–5 years", "More than 5 years"]), displayLogic: and(pt, rule("q_main", "answered")) },
    { id: "q_treat", code: "P4", variableName: "TREATMENT", type: "multi_select", required: true, text: "How is {{MAIN_CONDITION}} being managed at the moment?", options: [...opts(["Prescription medicine", "Lifestyle changes", "Regular monitoring", "Specialist care"]), OTHER, NONE("Nothing at the moment")], displayLogic: and(pt, rule("q_main", "answered")) },
    { id: "q_adhere", code: "P5", variableName: "ADHERENCE", type: "single_select", required: true, text: "In a typical week, how often is the prescription medicine taken as prescribed?", options: [...opts(["Always", "Usually", "Sometimes", "Rarely"]), PREFER_NOT], displayLogic: and(pt, rule("q_treat", "selected", 1)) },
    { id: "q_journey", code: "P6", variableName: "JOURNEY", type: "matrix_single", required: true, text: "How easy or difficult was each of these?", rows: rows(["Getting a diagnosis", "Understanding the treatment options", "Getting appointments", "Paying for care"]), options: [...opts(["Very difficult", "Difficult", "Neither", "Easy", "Very easy"]), { code: 9, label: "Not applicable", flags: ["exclusive"] }], displayLogic: and(pt, rule("q_main", "answered")) },
    /* professionals */
    { id: "q_role", code: "H1", variableName: "HCP_ROLE", type: "single_select", required: true, text: "What is your role?", options: [...opts(["Primary-care physician", "Specialist physician", "Nurse or nurse practitioner", "Pharmacist"]), OTHER], displayLogic: hcp },
    { id: "q_spec", code: "H2", variableName: "SPECIALTY", type: "single_select", required: true, text: "What is your specialty?", options: [...opts(["Endocrinology", "Cardiology", "Respiratory medicine", "Neurology"]), OTHER], displayLogic: and(hcp, rule("q_role", "selected", 2)) },
    { id: "q_exp", code: "H3", variableName: "YEARS_PRACTICE", type: "numeric", required: true, text: "How many years have you been in practice?", settings: { minValue: 0, maxValue: 60 }, displayLogic: hcp, skipLogic: [screenOut("sk_exp", rule("q_exp", "lt", 2))] },
    { id: "q_see", code: "H4", variableName: "CONDITIONS_SEEN", type: "multi_select", required: true, text: "For which of these do you see patients in a typical month?", options: [...CONDITIONS, NONE()], displayLogic: hcp, skipLogic: [screenOut("sk_see", rule("q_see", "selected", 98))] },
    { id: "q_load", code: "H5", variableName: "PATIENT_LOAD", type: "numeric", required: true, text: "About how many patients with these conditions do you see in a typical month?", settings: { minValue: 1, maxValue: 2000 }, displayLogic: hcp },
    { id: "q_barriers", code: "H6", variableName: "BARRIERS", type: "ranking", required: true, text: "Rank the three biggest barriers to good outcomes for these patients.", settings: { rankMode: "top_n", maxSelections: 3 }, options: opts(["Patients not taking medicine as prescribed", "Late diagnosis", "Cost of treatment", "Too little consultation time", "Access to specialists"]), randomization: shuffle, displayLogic: hcp },
    derived("h_path", "PATH", "Path (derived)", opts(["Patient or carer", "Professional"]), [[1, pt], [2]]),
  ];
  return survey(surveyId, { code: "HEALTH", title: "Healthcare research — patients and professionals" }, questions, [
    page("p_consent", "Consent", ["q_consent"]),
    page("p_who", "About you", ["q_who", "h_path"]),
    page("p_cond", "Conditions", ["q_cond"]),
    page("p_main", "Conditions", ["q_main", "q_years"]),
    page("p_treat", "Treatment", ["q_treat", "q_adhere"]),
    page("p_journey", "The journey", ["q_journey"]),
    page("p_hcp", "Your practice", ["q_role", "q_spec", "q_exp"]),
    page("p_hcp2", "Your patients", ["q_see", "q_load"]),
    page("p_hcp3", "Barriers", ["q_barriers"]),
  ]);
}

/* ================================================================ 11. Advertising and concept test */

export function buildAdvAdConceptSurvey(surveyId = "adv-adtest"): SurveyDefinition {
  const ids = minter("adc");
  const BRANDS = ["Solara Energy Drink", "Vantage", "Kiro", "Peakline"];
  const ad = methodTemplateFragment({ template: "ad_test", brands: BRANDS }, ids);
  const concepts = methodTemplateFragment({ template: "sequential_monadic", concepts: ["Concept A — “Clean energy, no crash”", "Concept B — “Made for the long shift”", "Concept C — “Taste first”"] }, ids);
  const questions: Q[] = [
    { id: "q_drink", code: "S1", variableName: "DRINKS_CATEGORY", type: "single_select", required: true, text: "How often do you drink energy drinks?", options: opts(["Weekly or more", "Monthly", "Less often", "Never"]), skipLogic: [screenOut("sk_drink", rule("q_drink", "selected", 4))] },
    { id: "q_pre", code: "S2", variableName: "PRE_AWARE", type: "multi_select", required: true, text: "Before today, which of these brands had you heard of?", options: [...opts(BRANDS), NONE()], randomization: shuffle },
    ...(ad.questions as Q[]), ...(concepts.questions as Q[]),
    { id: "q_best", code: "X1", variableName: "BEST_CONCEPT", type: "single_select", required: true, text: "Having seen all three ideas, which do you prefer?", options: [...opts(["Concept A", "Concept B", "Concept C"]), { code: 9, label: "No preference", flags: ["exclusive", "anchor_bottom"] }], randomization: shuffle },
    { id: "q_bestwhy", code: "X2", variableName: "BEST_WHY", type: "long_text", required: false, text: "Why {{BEST_CONCEPT}}?", displayLogic: not(rule("q_best", "selected", 9)) },
  ];
  return withResearch(survey(surveyId, { code: "ADCONCEPT", title: "Advertising and concept test — energy drink" }, questions, [
    page("p_screen", "Energy drinks", ["q_drink"]),
    page("p_pre", "Brands", ["q_pre"]),
    ad.block as FlowNode, concepts.block as FlowNode,
    page("p_best", "Your preference", ["q_best", "q_bestwhy"]),
  ]), plan([...ad.tests, ...concepts.tests], ids));
}

/* ================================================================ 12. Product / sensory test */

export function buildAdvProductTestSurvey(surveyId = "adv-product"): SurveyDefinition {
  const SAMPLES = [{ code: "417", label: "Sample 417" }, { code: "852", label: "Sample 852" }, { code: "269", label: "Sample 269" }];
  const JAR = opts(["Much too weak", "Too weak", "Just about right", "Too strong", "Much too strong"]);
  const questions: Q[] = [
    { id: "q_eat", code: "S1", variableName: "EATS_CATEGORY", type: "single_select", required: true, text: "How often do you drink iced tea?", options: opts(["Weekly or more", "Monthly", "Less often", "Never"]), skipLogic: [screenOut("sk_eat", rule("q_eat", "selected", 4))] },
    { id: "q_allergy", code: "S2", variableName: "ALLERGY", type: "single_select", required: true, text: "Do you have any food allergy or intolerance that means you should not taste the samples?", options: YES_NO, skipLogic: [screenOut("sk_allergy", rule("q_allergy", "selected", 1))] },
    { id: "i_taste", code: "I1", variableName: "I_TASTE", type: "html", text: "<p>You will taste three samples, one at a time, in the order shown on your screen. Each cup has a three-digit code. Please sip some water between samples.</p>" },
    { id: "q_ready", code: "T0", variableName: "READY", type: "html", text: "<p>Please taste <b>{{loop.label}}</b> now, then answer the questions about it.</p>" },
    { id: "q_like", code: "T1", variableName: "LIKING", type: "single_select", required: true, text: "Overall, how much do you like {{loop.label}}?", options: opts(["Dislike extremely", "Dislike very much", "Dislike moderately", "Dislike slightly", "Neither like nor dislike", "Like slightly", "Like moderately", "Like very much", "Like extremely"]) },
    { id: "q_attr", code: "T2", variableName: "ATTR_LIKING", type: "matrix_single", required: true, text: "How much do you like each of these about {{loop.label}}?", rows: rows(["Appearance", "Smell", "Taste", "Mouthfeel", "Aftertaste"]), options: opts(["Dislike a lot", "Dislike", "Neither", "Like", "Like a lot"]) },
    { id: "q_jar", code: "T3", variableName: "JAR", type: "matrix_single", required: true, text: "And how would you describe {{loop.label}} on each of these?", rows: rows(["Sweetness", "Tea flavour", "Lemon flavour"]), options: JAR },
    { id: "q_dislike", code: "T4", variableName: "DISLIKE_WHY", type: "long_text", required: true, text: "What did you dislike about {{loop.label}}?", displayLogic: rule("q_like", "in", [1, 2, 3, 4]) },
    { id: "q_pref", code: "F1", variableName: "PREFERENCE", type: "single_select", required: true, text: "Which of the three samples did you like best?", options: [...SAMPLES.map((s) => ({ code: s.code, label: s.label })), { code: "none", label: "No preference", flags: ["exclusive", "anchor_bottom"] }], randomization: shuffle },
    { id: "q_buy", code: "F2", variableName: "PURCHASE_INTENT", type: "single_select", required: true, text: "If {{PREFERENCE}} were on sale at the usual price for iced tea, how likely would you be to buy it?", options: LIKELY_5, displayLogic: not(rule("q_pref", "selected", "none")) },
  ];
  return survey(surveyId, { code: "PRODTEST", title: "Blind product test — iced tea" }, questions, [
    page("p_screen", "Before we start", ["q_eat", "q_allergy"]),
    page("p_intro", "", ["i_taste"]),
    { type: "loop", id: "loop_samples", title: "Each sample, in a random order", loopVar: "sample", source: { kind: "static", items: SAMPLES }, order: { kind: "random" }, children: [
      page("p_taste", "Tasting", ["q_ready"]),
      page("p_rate", "Your rating", ["q_like", "q_dislike"]),
      page("p_attr", "In detail", ["q_attr", "q_jar"]),
    ] } as unknown as FlowNode,
    page("p_pref", "Comparing the three", ["q_pref", "q_buy"]),
  ]);
}

/* ================================================================ 13. Political opinion (fictional) */

export function buildAdvPoliticalSurvey(surveyId = "adv-political"): SurveyDefinition {
  const CAND = opts(["Mara Ellison (Civic Union)", "Tobias Reyes (Forward Party)", "Ingrid Solheim (Green Alliance)"]);
  const UNDECIDED: OptSpec = { code: 8, label: "Undecided", flags: ["exclusive", "anchor_bottom"] };
  const questions: Q[] = [
    AGE, AGE_BAND,
    { id: "q_reg", code: "S2", variableName: "REGISTERED", type: "single_select", required: true, text: "Are you registered to vote in the Republic of Valdoria? (Valdoria, its parties and its candidates are fictional.)", options: opts(["Yes", "No", "Not sure"]), skipLogic: [screenOut("sk_reg", rule("q_reg", "selected", 2))] },
    { id: "q_region", code: "S3", variableName: "REGION", type: "single_select", required: true, text: "Which region do you live in?", options: opts(["Northern Highlands", "Capital District", "Eastern Coast", "Southern Plains"]) },
    { id: "q_gender", code: "S4", variableName: "GENDER", type: "single_select", required: true, text: "Are you…?", options: [...opts(["A woman", "A man", "Non-binary or another gender"]), PREFER_NOT] },
    { id: "q_edu", code: "S5", variableName: "EDUCATION", type: "single_select", required: true, text: "What is the highest level of education you have completed?", options: opts(["Secondary school or less", "Vocational or some college", "University degree", "Postgraduate degree"]) },
    { id: "q_turnout", code: "V1", variableName: "TURNOUT", type: "single_select", required: true, text: "How likely are you to vote in the next presidential election?", options: opts(["Certain to vote", "Likely", "50–50", "Unlikely", "Certain not to vote"]) },
    { id: "q_aware", code: "V2", variableName: "CAND_AWARE", type: "multi_select", required: true, text: "Which of these candidates have you heard of?", options: [...CAND, NONE()], randomization: shuffle },
    { id: "q_vote", code: "V3", variableName: "VOTE", type: "single_select", required: true, text: "If the election were held tomorrow, who would you vote for?", options: [...CAND, UNDECIDED, { code: 9, label: "Would not vote", flags: ["exclusive", "anchor_bottom"] }], randomization: shuffle },
    { id: "q_lean", code: "V4", variableName: "LEAN", type: "single_select", required: true, text: "Which candidate are you leaning towards, even slightly?", options: [...CAND, { code: 8, label: "None — truly undecided", flags: ["exclusive", "anchor_bottom"] }], randomization: shuffle, displayLogic: rule("q_vote", "selected", 8) },
    { id: "q_firm", code: "V5", variableName: "FIRMNESS", type: "single_select", required: true, text: "How firm is that choice?", options: opts(["I will definitely vote that way", "I could change my mind"]), displayLogic: rule("q_vote", "in", [1, 2, 3]) },
    { id: "q_issues", code: "I1", variableName: "ISSUES", type: "ranking", required: true, text: "Rank the three issues that matter most to your vote.", settings: { rankMode: "top_n", maxSelections: 3 }, options: opts(["Cost of living", "Healthcare", "Jobs and wages", "Housing", "Climate and environment", "Crime and safety", "Education"]), randomization: shuffle },
    { id: "q_image", code: "I2", variableName: "IMAGE", type: "matrix_single", required: true, text: "How well does “understands people like me” describe each candidate?", rows: [], options: opts(["Not at all", "Not very well", "Fairly well", "Very well"]), carryForward: { sourceQuestionId: "q_aware", filter: "selected", into: "rows" }, displayLogic: not(rule("q_aware", "selected", 98)) },
    { id: "q_check", code: "Q1", variableName: "ATTENTION", type: "single_select", required: true, text: "To show you are reading carefully, please select “Agree” here.", options: AGREE_5, attentionCheck: { expected: [4] } },
    derived("h_vote", "VOTE_WITH_LEAN", "Vote including leaners (derived)", [...CAND, { code: 8, label: "Undecided" }, { code: 9, label: "Would not vote" }], [[1, or(rule("q_vote", "selected", 1), rule("q_lean", "selected", 1))], [2, or(rule("q_vote", "selected", 2), rule("q_lean", "selected", 2))], [3, or(rule("q_vote", "selected", 3), rule("q_lean", "selected", 3))], [9, rule("q_vote", "selected", 9)], [8]]),
    derived("h_likely", "LIKELY_VOTER", "Likely voter (derived)", opts(["Likely voter", "Not a likely voter"]), [[1, rule("q_turnout", "in", [1, 2])], [2]]),
  ];
  return survey(surveyId, { code: "POLL", title: "Political opinion poll — fictional election" }, questions, [
    page("p_age", "About you", ["q_age", "h_age"]),
    { type: "quota_check", id: "qc_age", quotaIds: ["quota_age"], onFull: { kind: "terminate" } } as FlowNode,
    page("p_reg", "Voting", ["q_reg"]),
    page("p_demo", "About you", ["q_region", "q_gender", "q_edu"]),
    page("p_turnout", "The election", ["q_turnout", "h_likely"]),
    page("p_aware", "The candidates", ["q_aware"]),
    page("p_vote", "Your vote", ["q_vote"]),
    page("p_lean", "Your vote", ["q_lean", "q_firm", "h_vote"]),
    page("p_issues", "The issues", ["q_issues"]),
    page("p_image", "The candidates", ["q_image", "q_check"]),
  ], { quotas: [ageQuota("h_age")] });
}

/* ================================================================ 14. Multi-country study */

export function buildAdvMultiCountrySurvey(surveyId = "adv-multicountry"): SurveyDefinition {
  const C = [["India", "₹", [500, 1500, 4000], ["Flipkart", "Amazon.in", "Local market or kirana"]], ["United States", "$", [25, 75, 200], ["Amazon", "Walmart", "Target"]], ["United Kingdom", "£", [20, 60, 150], ["Amazon.co.uk", "Tesco", "Argos"]], ["Germany", "€", [20, 60, 150], ["Amazon.de", "Otto", "MediaMarkt"]], ["Japan", "¥", [3000, 9000, 25000], ["Rakuten", "Amazon.co.jp", "Yodobashi"]]] as const;
  const inC = (i: number) => rule("q_country", "selected", i + 1);
  const fmt = (n: number) => n.toLocaleString("en-US");
  const questions: Q[] = [
    { id: "q_country", code: "S1", variableName: "COUNTRY", type: "single_select", required: true, text: "Which country do you live in?", options: [...opts(C.map((c) => c[0])), { code: 9, label: "Another country", flags: ["anchor_bottom"] }], skipLogic: [screenOut("sk_country", rule("q_country", "selected", 9))] },
    AGE, AGE_BAND,
    { id: "q_online", code: "S3", variableName: "SHOPS_ONLINE", type: "single_select", required: true, text: "How often do you shop online?", options: opts(["Weekly or more", "Monthly", "Less often", "Never"]), skipLogic: [screenOut("sk_online", rule("q_online", "selected", 4))] },
    /* one answer list, each country seeing its own retailers */
    { id: "q_shops", code: "B1", variableName: "RETAILERS", type: "multi_select", required: true, text: "Which of these have you bought from in the last three months?", options: [...C.flatMap((c, i) => c[3].map((label, j): OptSpec => ({ code: (i + 1) * 10 + j + 1, label, visibleIf: inC(i) }))), OTHER, NONE()], randomization: shuffle },
    /* spend, in the respondent's own currency */
    ...C.map((c, i): Q => ({ id: `q_spend_${i + 1}`, code: `B2_${i + 1}`, variableName: `SPEND_${["IN", "US", "UK", "DE", "JP"][i]}`, type: "single_select", required: true, text: "About how much did you spend online last month?", options: opts([`Under ${c[1]}${fmt(c[2][0])}`, `${c[1]}${fmt(c[2][0])}–${c[1]}${fmt(c[2][1])}`, `${c[1]}${fmt(c[2][1])}–${c[1]}${fmt(c[2][2])}`, `More than ${c[1]}${fmt(c[2][2])}`]), displayLogic: inC(i) })),
    derived("h_spend", "SPEND_BAND", "Online spend band, comparable across countries (derived)", opts(["Low", "Medium", "High", "Very high"]), [...[1, 2, 3].map((band): [number, unknown?] => [band, or(...C.map((_c, i) => rule(`q_spend_${i + 1}`, "selected", band)))]), [4]]),
    { id: "q_pay", code: "B3", variableName: "PAYMENT", type: "multi_select", required: true, text: "How do you usually pay online?", options: [...opts(["Credit or debit card", "Digital wallet", "Bank transfer", "Cash on delivery", "Buy now, pay later"]), { code: 6, label: "UPI", visibleIf: inC(0) }, { code: 7, label: "Konbini (convenience-store payment)", visibleIf: inC(4) }, OTHER], randomization: shuffle },
    { id: "q_drivers", code: "A1", variableName: "DRIVERS", type: "matrix_single", required: true, text: "How important is each of these when you choose where to shop online?", rows: rows(["Lowest price", "Fast delivery", "Free returns", "Wide choice", "Trust in the seller"]), options: opts(["Not important", "Slightly", "Moderately", "Very", "Extremely important"]), randomization: { enabled: true, scope: "rows", method: "shuffle" } },
    { id: "q_cross", code: "A2", variableName: "CROSS_BORDER", type: "single_select", required: true, text: "In the last year, have you bought from a seller based in another country?", options: opts(["Yes", "No", "Not sure"]) },
  ];
  return survey(surveyId, { code: "MULTI", title: "Multi-country consumer study — online shopping" }, questions, [
    page("p_country", "Where you live", ["q_country"]),
    page("p_age", "About you", ["q_age", "h_age"]),
    { type: "quota_check", id: "qc_country", quotaIds: ["quota_country"], onFull: { kind: "terminate" } } as FlowNode,
    page("p_online", "Shopping online", ["q_online"]),
    page("p_shops", "Where you shop", ["q_shops"]),
    page("p_spend", "What you spend", [...C.map((_c, i) => `q_spend_${i + 1}`), "h_spend"]),
    page("p_pay", "How you pay", ["q_pay"]),
    page("p_drivers", "What matters", ["q_drivers", "q_cross"]),
  ], { quotas: [{ id: "quota_country", name: "Country", mode: "hard", targetTotal: 1500, countStatus: ["complete"], onFull: { kind: "terminate" }, cells: C.map((c, i) => ({ id: `cell_c${i + 1}`, label: c[0], limit: 300, limitType: "count", when: inC(i) })) }] });
}

/* ================================================================ 15. Hybrid experimental study */

export function buildAdvHybridSurvey(surveyId = "adv-hybrid"): SurveyDefinition {
  const ids = minter("hyb");
  const ITEMS = ["Long battery life", "Accurate heart-rate tracking", "Sleep tracking", "Built-in GPS", "Contactless payment", "Slim, light design", "Works with any phone", "Water resistance", "Music without a phone", "Guided workouts"];
  const cbc = design("design_hyb_cbc", "conjoint", "Smartwatch CBC", { attributes: [{ name: "Brand", levels: ["Orbis", "Tempo", "Vela"] }, { name: "Price", levels: ["$149", "$229", "$329"] }, { name: "Battery life", levels: ["2 days", "5 days", "10 days"] }, { name: "Health sensors", levels: ["Heart rate", "Heart rate + ECG", "Heart rate + ECG + blood oxygen"] }], tasks: 8, alternativesPerTask: 3, noneOption: true, holdoutTasks: 1, versions: 4 }, 20261115);
  const md = design("design_hyb_md", "maxdiff", "Smartwatch feature MaxDiff", { items: ITEMS, itemsPerTask: 4, tasks: 8, versions: 2, balance: "optimized" }, 20261128);
  const ladder = methodTemplateFragment({ template: "price_ladder", product: "the Orbis Pulse smartwatch", prices: [149, 189, 229, 279, 329] }, ids);
  const top = (row: number) => rule("q_att", "in", [4, 5], undefined, { rowCode: String(row) });
  const questions: Q[] = [
    AGE, AGE_BAND,
    { id: "q_own", code: "S2", variableName: "OWNERSHIP", type: "single_select", required: true, text: "Which describes you?", options: opts(["I own a smartwatch or fitness band", "I do not own one but would consider one", "I would not consider one"]), skipLogic: [screenOut("sk_own", rule("q_own", "selected", 3))] },
    { id: "q_att", code: "G1", variableName: "ATT", type: "matrix_single", required: true, text: "How much do you agree or disagree?", rows: rows(["I track my health and fitness closely", "I want the latest technology", "Price is the first thing I look at", "Style matters as much as function"]), options: AGREE_5, randomization: { enabled: true, scope: "rows", method: "shuffle" } },
    derived("h_seg", "SEGMENT", "Segment (derived — provisional typing rule)", opts(["Health-driven", "Tech-driven", "Price-driven", "Style-driven", "Unclassified"]), [[1, top(1)], [2, top(2)], [3, top(3)], [4, top(4)], [5]]),
    { id: "i_md", code: "I1", variableName: "I_MD", type: "html", text: "<p>In each list, pick the feature that matters <b>most</b> and the one that matters <b>least</b> to you in a smartwatch.</p>" },
    { id: "q_md", code: "M1", variableName: "MD", type: "maxdiff_task", required: true, text: "Which matters MOST and which matters LEAST?", settings: { designRef: "design_hyb_md" } },
    { id: "i_cbc", code: "I2", variableName: "I_CBC", type: "html", text: "<p>In each set, choose the smartwatch you would buy — or none of them.</p>" },
    { id: "q_cbc", code: "C1", variableName: "CBC", type: "conjoint_task", required: true, text: "Which would you choose?", settings: { designRef: "design_hyb_cbc" } },
    /* the concept each respondent sees is written for their segment */
    { id: "i_concept", code: "K0", variableName: "I_CONCEPT", type: "html", text: "<p><b>Orbis Pulse</b> (a fictional example) is a new smartwatch with a ten-day battery and medical-grade heart sensors.</p>" },
    { id: "q_c_health", code: "K1", variableName: "CONCEPT_HEALTH", type: "single_select", required: true, text: "“Orbis Pulse watches your heart around the clock and tells you when something changes.” How appealing is this?", options: opts(["Not at all appealing", "Not very", "Somewhat", "Very", "Extremely appealing"]), displayLogic: rule("h_seg", "selected", 1) },
    { id: "q_c_tech", code: "K2", variableName: "CONCEPT_TECH", type: "single_select", required: true, text: "“Orbis Pulse: the first watch with a ten-day battery and a full sensor suite.” How appealing is this?", options: opts(["Not at all appealing", "Not very", "Somewhat", "Very", "Extremely appealing"]), displayLogic: rule("h_seg", "selected", 2) },
    { id: "q_c_gen", code: "K3", variableName: "CONCEPT_GENERAL", type: "single_select", required: true, text: "“Orbis Pulse: more days, more insight, one charge.” How appealing is this?", options: opts(["Not at all appealing", "Not very", "Somewhat", "Very", "Extremely appealing"]), displayLogic: rule("h_seg", "in", [3, 4, 5]) },
    ...(ladder.questions as Q[]),
    { id: "q_final", code: "Z1", variableName: "FINAL_INTENT", type: "single_select", required: true, text: "All things considered, how likely are you to buy a smartwatch in the next 12 months?", options: LIKELY_5 },
  ];
  return withResearch(survey(surveyId, { code: "HYBRID", title: "Hybrid experimental study — smartwatch" }, questions, [
    { type: "embedded_data", id: "ed_src", title: "Sample source", fields: [{ name: "SOURCE", source: "url", defaultValue: "direct" }] } as FlowNode,
    page("p_age", "About you", ["q_age", "h_age"]),
    { type: "quota_check", id: "qc_age", quotaIds: ["quota_age"], onFull: { kind: "terminate" } } as FlowNode,
    page("p_own", "Smartwatches", ["q_own"]),
    page("p_att", "Your views", ["q_att", "h_seg"]),
    /* the two choice exercises in a random order per respondent, the order recorded — so order effects can be tested and removed */
    { type: "randomizer", id: "rand_modules", title: "MaxDiff and conjoint, in random order", recordOrder: true, evenPresentation: true, children: [
      { type: "block", id: "blk_md", title: "MaxDiff", children: [page("p_md_i", "", ["i_md"]), page("p_md", "Features", ["q_md"])] },
      { type: "block", id: "blk_cbc", title: "Conjoint", children: [page("p_cbc_i", "", ["i_cbc"]), page("p_cbc", "Your choices", ["q_cbc"])] },
    ] } as unknown as FlowNode,
    page("p_concept", "A new product", ["i_concept", "q_c_health", "q_c_tech", "q_c_gen"]),
    ladder.block as FlowNode,
    page("p_final", "Finally", ["q_final"]),
  ], { designs: [cbc, md], quotas: [ageQuota("h_age")] }), plan(ladder.tests, ids));
}

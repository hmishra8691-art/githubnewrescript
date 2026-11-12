/**
 * ADVANCED RESEARCH TEMPLATES (2026-11-12) — complete, fieldable studies built on a research METHOD.
 *
 * Each is an ordinary survey definition made of the engine's native parts — the experimental designs the design
 * generator produces, auto-punched hidden variables, carry-forward, quotas, terminations — so it opens, edits,
 * previews, fields and exports like any other survey. Nothing here is a mock: the same quality check and the same
 * simulated respondents that gate the starters gate these (starters.test.ts, advanced.test.ts).
 *
 * All brands, companies and figures are FICTIONAL examples to be replaced.
 */
import { SurveyDefinition, designGeneratorRegistry } from "@rescript/schema";
import type { FlowNode } from "@rescript/schema";
import { methodTemplateFragment } from "@rescript/engine";
import { AGREE_5, LIKELY_5, SAT_5, and, not, opts, or, page, rule, type OptSpec } from "./builders.js";
import { screenOut, survey } from "./starters.js";

type Q = Record<string, unknown>;
const rows = (labels: string[]) => labels.map((label, i) => ({ code: i + 1, label }));
const NONE = (label = "None of these"): OptSpec => ({ code: 98, label, flags: ["exclusive", "anchor_bottom"] });
const OTHER: OptSpec = { code: 97, label: "Other (please specify)", flags: ["other_specify", "anchor_bottom"] };
const shuffle = { enabled: true, scope: "options", method: "shuffle" };
/** a hidden single-choice variable coded by auto-punch rules — the derived variable the analysis reads */
const derived = (id: string, variableName: string, text: string, options: OptSpec[], rules: [number, unknown?][]): Q => ({
  id, code: variableName, variableName, type: "single_select", text, options, required: false, settings: { hidden: true },
  punches: rules.map(([code, when], i) => ({ id: `${id}_p${i + 1}`, source: { kind: "codes", codes: [String(code)] }, action: "select", recompute: "always", mode: i === 0 ? "if" : when ? "else_if" : "else", ...(when ? { when } : {}) })),
});
const design = (id: string, kind: "conjoint" | "maxdiff", name: string, config: Record<string, unknown>, seed: number) => {
  const g = designGeneratorRegistry.get(kind)!.generate(config as never, seed);
  return { id, kind, name, version: 1, seed, config, file: { format: "json", columns: g.columns, rows: g.rows, generatedAt: "2026-11-12T00:00:00.000Z" } };
};
const ageQuota = (ref: string) => ({
  id: "quota_age", name: "Age band", mode: "hard", targetTotal: 600, countStatus: ["complete"], onFull: { kind: "terminate" },
  cells: [["cell_1834", "18–34", 1], ["cell_3554", "35–54", 2], ["cell_55p", "55+", 3]].map(([id, label, v]) => ({ id, label, limit: 200, limitType: "count", when: rule(ref, "selected", v) })),
});
const AGE: Q = { id: "q_age", code: "S1", variableName: "AGE", type: "numeric", required: true, text: "How old are you?", settings: { minValue: 16, maxValue: 99 }, skipLogic: [screenOut("sk_age", rule("q_age", "lt", 18))] };
const AGE_BAND = derived("h_age", "AGE_BAND", "Age band (derived)", opts(["18–34", "35–54", "55+"]), [[1, rule("q_age", "lt", 35)], [2, rule("q_age", "lt", 55)], [3]]);

/* ================================================================ 1. Choice-based conjoint */

export function buildAdvCbcSurvey(surveyId = "adv-cbc"): SurveyDefinition {
  const BRANDS = opts(["Voltara", "Lumen Motors", "Kestrel", "Aurel", "Nordwind"]);
  const config = {
    attributes: [
      { name: "Brand", levels: ["Voltara", "Lumen Motors", "Kestrel"] },
      { name: "Price", levels: ["$32,000", "$38,000", "$45,000", "$54,000"] },
      { name: "Range per charge", levels: ["250 miles", "320 miles", "400 miles"] },
      { name: "Fast-charge time (10–80%)", levels: ["18 minutes", "30 minutes", "45 minutes"] },
      { name: "Battery warranty", levels: ["5 years", "8 years", "10 years"] },
    ],
    tasks: 10, alternativesPerTask: 3, noneOption: true, holdoutTasks: 2, versions: 4,
  };
  const questions: Q[] = [
    AGE, AGE_BAND,
    { id: "q_intent", code: "S2", variableName: "INTENT", type: "single_select", required: true, text: "How likely are you to buy or lease a new car in the next two years?", options: LIKELY_5, skipLogic: [screenOut("sk_intent", rule("q_intent", "in", [1, 2]))] },
    { id: "q_role", code: "S3", variableName: "ROLE", type: "single_select", required: true, text: "When your household chooses a car, what is your role?", options: opts(["I decide alone", "I decide jointly with someone else", "Someone else decides"]), skipLogic: [screenOut("sk_role", rule("q_role", "selected", 3))] },
    { id: "q_aware", code: "A1", variableName: "AWARE", type: "multi_select", required: true, text: "Which of these electric-car makers have you heard of?", options: [...BRANDS, NONE()], randomization: shuffle },
    { id: "q_consider", code: "A2", variableName: "CONSIDER", type: "multi_select", required: true, text: "Which of them would you consider for your next car?", options: [NONE("None of them")], carryForward: { sourceQuestionId: "q_aware", filter: "selected", into: "options", keepOwn: true }, displayLogic: not(rule("q_aware", "selected", 98)) },
    { id: "i_cbc", code: "I1", variableName: "I_CBC", type: "html", text: "<p>Next you will see 12 sets of three electric cars. The cars differ only in what is shown. In each set, choose the one you would buy — or say you would buy none of them.</p>" },
    { id: "q_cbc", code: "C1", variableName: "CBC", type: "conjoint_task", required: true, text: "Which of these would you choose?", settings: { designRef: "design_cbc_ev" } },
    { id: "q_driver", code: "C2", variableName: "CBC_DRIVER", type: "single_select", required: true, text: "Which one thing mattered most in the choices you just made?", options: opts(["Brand", "Price", "Range per charge", "Fast-charge time", "Battery warranty"]), randomization: shuffle },
    { id: "q_why", code: "C3", variableName: "CBC_WHY", type: "long_text", required: false, text: "Why did {{CBC_DRIVER}} matter most to you?" },
    { id: "q_budget", code: "D1", variableName: "BUDGET", type: "single_select", required: true, text: "What do you expect to spend on your next car?", options: opts(["Under $35,000", "$35,000–$44,999", "$45,000–$54,999", "$55,000 or more"]) },
    derived("h_seg", "BUYER_TYPE", "Buyer type (derived)", opts(["Price-led", "Range-led", "Brand-led", "Other"]), [[1, or(rule("q_driver", "selected", 2), rule("q_budget", "selected", 1))], [2, rule("q_driver", "in", [3, 4])], [3, rule("q_driver", "selected", 1)], [4]]),
  ];
  return survey(surveyId, { code: "CBC_EV", title: "Choice-based conjoint — electric vehicles" }, questions, [
    page("p_age", "About you", ["q_age", "h_age"]),
    { type: "quota_check", id: "qc_age", quotaIds: ["quota_age"], onFull: { kind: "terminate" } } as FlowNode,
    page("p_screen", "Your next car", ["q_intent", "q_role"]),
    page("p_aware", "Electric cars", ["q_aware"]),
    page("p_consider", "Electric cars", ["q_consider"]),
    page("p_intro", "", ["i_cbc"]),
    page("p_cbc", "Your choices", ["q_cbc"]),
    page("p_follow", "About your choices", ["q_driver", "q_why"]),
    page("p_budget", "Budget", ["q_budget", "h_seg"]),
  ], { designs: [design("design_cbc_ev", "conjoint", "Electric vehicle CBC", config, 20261112)], quotas: [ageQuota("h_age")] });
}

/* ================================================================ 2. MaxDiff */

export function buildAdvMaxDiffSurvey(surveyId = "adv-maxdiff"): SurveyDefinition {
  const ITEMS = ["Short waiting time", "Getting it solved the first time", "Friendly staff", "Staff who know the product", "Available 24 hours a day", "Help in my own language", "A choice of phone, chat or email", "Clear updates on progress", "Not having to repeat myself", "A fair refund or compensation", "Self-service that works", "Follow-up after the problem is solved"];
  const config = { items: ITEMS, itemsPerTask: 5, tasks: 9, versions: 2, balance: "optimized" };
  const questions: Q[] = [
    { id: "q_contact", code: "S1", variableName: "CONTACTED", type: "single_select", required: true, text: "In the last 12 months, have you contacted the customer service of any company?", options: opts(["Yes", "No"]), skipLogic: [screenOut("sk_contact", rule("q_contact", "selected", 2))] },
    { id: "q_channel", code: "S2", variableName: "CHANNELS", type: "multi_select", required: true, text: "How did you get in touch? Select all that apply.", options: [...opts(["Phone", "Live chat", "Email", "Social media", "In person"]), OTHER], randomization: shuffle },
    { id: "q_main", code: "S3", variableName: "MAIN_CHANNEL", type: "single_select", required: true, text: "Which of these did you use most?", options: [], carryForward: { sourceQuestionId: "q_channel", filter: "selected", into: "options" } },
    { id: "i_md", code: "I1", variableName: "I_MD", type: "html", text: "<p>You will now see 9 short lists of things a customer service can offer. In each list, pick the one that matters <b>most</b> to you and the one that matters <b>least</b>.</p>" },
    { id: "q_md", code: "M1", variableName: "MD", type: "maxdiff_task", required: true, text: "Which matters MOST and which matters LEAST to you?", settings: { designRef: "design_md_service" } },
    { id: "q_top", code: "M2", variableName: "MD_TOP3", type: "ranking", required: true, text: "Overall, rank the three that matter most to you.", settings: { rankMode: "top_n", maxSelections: 3 }, options: ITEMS.map((label, i) => ({ code: `i${i + 1}`, label })), randomization: shuffle },
    { id: "q_sat", code: "D1", variableName: "LAST_SAT", type: "single_select", required: true, text: "Thinking of the last time you contacted customer service by {{MAIN_CHANNEL}}: how satisfied were you?", options: SAT_5 },
    { id: "q_bad", code: "D2", variableName: "LAST_WHY", type: "long_text", required: true, text: "What went wrong?", displayLogic: rule("q_sat", "in", [1, 2]) },
    derived("h_sat", "SAT_GROUP", "Satisfaction group (derived)", opts(["Dissatisfied", "Neutral", "Satisfied"]), [[1, rule("q_sat", "in", [1, 2])], [2, rule("q_sat", "selected", 3)], [3]]),
  ];
  return survey(surveyId, { code: "MAXDIFF_CS", title: "MaxDiff — customer service priorities" }, questions, [
    page("p_screen", "Customer service", ["q_contact"]),
    page("p_channel", "How you got in touch", ["q_channel"]),
    page("p_main", "How you got in touch", ["q_main"]),
    page("p_intro", "", ["i_md"]),
    page("p_md", "What matters", ["q_md"]),
    page("p_top", "What matters", ["q_top"]),
    page("p_last", "Your last contact", ["q_sat", "q_bad", "h_sat"]),
  ], { designs: [design("design_md_service", "maxdiff", "Customer service MaxDiff", config, 20261114)] });
}

/* ================================================================ 3. Pricing: PSM + Gabor–Granger + elasticity */

export function buildAdvPricingSurvey(surveyId = "adv-pricing"): SurveyDefinition {
  const n: Record<string, number> = {};
  const ids = (prefix: string) => { n[prefix] = (n[prefix] ?? 0) + 1; return `${prefix}_adv_${n[prefix]}`; };
  const product = "the Brio smart coffee maker";
  const psm = methodTemplateFragment({ template: "pricing_psm", product }, ids);
  const ladder = methodTemplateFragment({ template: "price_ladder", product, prices: [79, 99, 129, 159, 189] }, ids);
  const PRICES = ["$79", "$99", "$129", "$159", "$189"];
  const questions: Q[] = [
    { id: "q_owns", code: "S1", variableName: "OWNS", type: "single_select", required: true, text: "Do you make coffee at home at least once a week?", options: opts(["Yes", "No"]), skipLogic: [screenOut("sk_owns", rule("q_owns", "selected", 2))] },
    { id: "i_concept", code: "I1", variableName: "I_CONCEPT", type: "html", text: "<p><b>Brio</b> (a fictional example) is a smart coffee maker: it grinds fresh beans, remembers each person's usual cup and can be started from a phone. Please read this before answering the questions about price.</p>" },
    ...(psm.questions as Q[]), ...(ladder.questions as Q[]),
    { id: "q_elastic", code: "E1", variableName: "BUY_AT", type: "matrix_single", required: true, text: `How likely would you be to buy ${product} at each of these prices?`, rows: rows(PRICES), options: LIKELY_5 },
    { id: "q_comp", code: "E2", variableName: "COMP_CHOICE", type: "single_select", required: true, text: "A comparable machine from another maker costs $119. If Brio cost $129, which would you buy?", options: opts(["Brio at $129", "The other machine at $119", "Neither"]), randomization: { enabled: true, scope: "options", method: "shuffle", anchored: [3] } },
    derived("h_top", "BUYS_AT_TOP", "Would buy at the highest price (derived)", opts(["Yes", "No"]), [[1, rule("q_elastic", "in", [4, 5], undefined, { rowCode: "5" })], [2]]),
  ];
  return SurveyDefinition.parse({
    ...JSON.parse(JSON.stringify(survey(surveyId, { code: "PRICING", title: "Pricing research — Van Westendorp, Gabor–Granger and price response" }, questions, [
      page("p_screen", "Coffee at home", ["q_owns"]),
      page("p_concept", "The product", ["i_concept"]),
      psm.block as FlowNode, ladder.block as FlowNode,
      page("p_elastic", "At each price", ["q_elastic", "h_top"]),
      page("p_comp", "Against a competitor", ["q_comp"]),
    ]))),
    research: { hypotheses: [], constructs: [], analysis: [], assumptions: [], sources: [], analysisPlan: { crosstabs: [], tests: [...psm.tests, ...ladder.tests].map((t) => ({ id: ids("t"), ...t })), derived: [], segments: [] } },
  });
}

/* ================================================================ 4. Market segmentation */

export function buildAdvSegmentationSurvey(surveyId = "adv-segmentation"): SurveyDefinition {
  const ATT = ["I compare prices before almost every purchase", "I am happy to pay more for the best quality", "I choose whatever is quickest and easiest", "I like to try new technology before other people do", "I stay with brands I know", "I read reviews before I buy"];
  const top = (row: number) => rule("q_att", "in", [4, 5], undefined, { rowCode: String(row) });
  const questions: Q[] = [
    AGE, AGE_BAND,
    { id: "q_shop", code: "S2", variableName: "SHOPS_ONLINE", type: "single_select", required: true, text: "How often do you buy consumer electronics (phones, laptops, audio, wearables)?", options: opts(["Several times a year", "About once a year", "Less often", "Never"]), skipLogic: [screenOut("sk_shop", rule("q_shop", "selected", 4))] },
    { id: "q_cats", code: "B1", variableName: "CATEGORIES", type: "multi_select", required: true, text: "Which of these have you bought in the last two years?", options: [...opts(["Smartphone", "Laptop or tablet", "Headphones or speakers", "Smartwatch or fitness band", "Smart-home device"]), NONE()], randomization: shuffle },
    { id: "q_last", code: "B2", variableName: "LAST_BOUGHT", type: "single_select", required: true, text: "Which of them did you buy most recently?", options: [], carryForward: { sourceQuestionId: "q_cats", filter: "selected", into: "options" }, displayLogic: not(rule("q_cats", "selected", 98)) },
    { id: "q_spend", code: "B3", variableName: "SPEND", type: "single_select", required: true, text: "Roughly how much do you spend on consumer electronics in a year?", options: opts(["Under $250", "$250–$749", "$750–$1,499", "$1,500 or more"]) },
    { id: "q_where", code: "B4", variableName: "CHANNEL", type: "single_select", required: true, text: "Where do you usually buy?", options: [...opts(["Online marketplace", "The maker's own website or store", "Electronics retailer", "Supermarket or discount store"]), OTHER] },
    { id: "q_att", code: "A1", variableName: "ATT", type: "matrix_single", required: true, text: "How much do you agree or disagree with each statement?", rows: rows(ATT), options: AGREE_5, randomization: { enabled: true, scope: "rows", method: "shuffle" } },
    /* the classification: the first rule that holds — a typing tool to replace with the cluster solution once the study has run */
    derived("h_seg", "SEGMENT", "Segment (derived — provisional typing rule)", opts(["Technology enthusiast", "Premium buyer", "Price-sensitive", "Convenience seeker", "Unclassified"]), [[1, and(top(4), rule("q_shop", "selected", 1))], [2, and(top(2), rule("q_spend", "in", [3, 4]))], [3, top(1)], [4, top(3)], [5]]),
    { id: "q_tech", code: "F1", variableName: "TECH_NEXT", type: "long_text", required: false, text: "Which new product or technology are you most looking forward to, and why?", displayLogic: rule("h_seg", "selected", 1) },
    { id: "q_prem", code: "F2", variableName: "PREMIUM_WHY", type: "multi_select", required: true, text: "What makes a product worth paying more for? Select all that apply.", options: [...opts(["Build quality", "Design", "Brand", "Longer support and updates", "Better service"]), OTHER], randomization: shuffle, displayLogic: rule("h_seg", "selected", 2) },
    { id: "q_price", code: "F3", variableName: "DEAL_SOURCE", type: "multi_select", required: true, text: "How do you find a good price? Select all that apply.", options: [...opts(["Price-comparison sites", "Waiting for sales", "Vouchers and cashback", "Buying refurbished", "Buying last year's model"]), NONE("I don't look for deals")], randomization: shuffle, displayLogic: rule("h_seg", "selected", 3) },
    { id: "q_conv", code: "F4", variableName: "CONVENIENCE", type: "single_select", required: true, text: "Which matters most when you want something quickly?", options: opts(["Next-day delivery", "Collecting from a store today", "One-click reordering", "Easy returns"]), randomization: shuffle, displayLogic: rule("h_seg", "selected", 4) },
  ];
  return survey(surveyId, { code: "SEGMENT", title: "Market segmentation — consumer electronics" }, questions, [
    page("p_age", "About you", ["q_age", "h_age"]),
    { type: "quota_check", id: "qc_age", quotaIds: ["quota_age"], onFull: { kind: "terminate" } } as FlowNode,
    page("p_screen", "Buying electronics", ["q_shop"]),
    page("p_behaviour", "What you buy", ["q_cats"]),
    page("p_last", "What you buy", ["q_last", "q_spend", "q_where"]),
    page("p_att", "Your views", ["q_att", "h_seg"]),
    page("p_follow", "A little more", ["q_tech", "q_prem", "q_price", "q_conv"]),
  ], { quotas: [ageQuota("h_age")] });
}

/* ================================================================ 5. B2B decision-maker research */

export function buildAdvB2bSurvey(surveyId = "adv-b2b"): SurveyDefinition {
  const VENDORS = opts(["Northbeam CRM", "Halcyon Suite", "Tessera", "Brightline", "Corvid Cloud"]);
  const questions: Q[] = [
    { id: "q_emp", code: "S1", variableName: "EMPLOYEES", type: "single_select", required: true, text: "How many people work at your company, across all locations?", options: opts(["Fewer than 50", "50–249", "250–999", "1,000–4,999", "5,000 or more"]), skipLogic: [screenOut("sk_emp", rule("q_emp", "selected", 1))] },
    { id: "q_ind", code: "S2", variableName: "INDUSTRY", type: "single_select", required: true, text: "Which industry is your company in?", options: [...opts(["Financial services", "Manufacturing", "Retail and e-commerce", "Healthcare", "Technology", "Professional services", "Public sector"]), OTHER] },
    { id: "q_rev", code: "S3", variableName: "REVENUE", type: "single_select", required: true, text: "What was your company's revenue last year?", options: [...opts(["Under $10 million", "$10–$99 million", "$100–$999 million", "$1 billion or more"]), { code: 99, label: "Prefer not to say", flags: ["exclusive", "anchor_bottom"] }] },
    { id: "q_level", code: "S4", variableName: "SENIORITY", type: "single_select", required: true, text: "Which best describes your level?", options: opts(["C-level or owner", "Vice president or director", "Manager", "Individual contributor"]) },
    { id: "q_involve", code: "S5", variableName: "INVOLVEMENT", type: "single_select", required: true, text: "What is your part in choosing customer-relationship (CRM) software for your company?", options: opts(["I make the final decision", "I am on the team that decides", "I recommend or evaluate options", "I use what is chosen", "I am not involved at all"]), skipLogic: [screenOut("sk_involve", rule("q_involve", "selected", 5))] },
    derived("h_role", "BUYING_ROLE", "Buying role (derived)", opts(["Decision-maker", "Influencer", "End user"]), [[1, rule("q_involve", "in", [1, 2])], [2, rule("q_involve", "selected", 3)], [3]]),
    { id: "q_use", code: "V1", variableName: "VENDORS_USED", type: "multi_select", required: true, text: "Which CRM products does your company use today?", options: [...VENDORS, OTHER, NONE("We do not use a CRM")], randomization: shuffle },
    { id: "q_main", code: "V2", variableName: "MAIN_VENDOR", type: "single_select", required: true, text: "Which is your company's main CRM?", options: [], carryForward: { sourceQuestionId: "q_use", filter: "selected", into: "options" }, displayLogic: not(rule("q_use", "selected", 98)) },
    { id: "q_vsat", code: "V3", variableName: "VENDOR_SAT", type: "matrix_single", required: true, text: "How satisfied are you with {{MAIN_VENDOR}} on each of these?", rows: rows(["Ease of use", "Integration with other systems", "Reporting", "Support", "Value for money"]), options: SAT_5, displayLogic: rule("q_main", "answered") },
    /* decision-makers: budget and process */
    { id: "q_budget", code: "D1", variableName: "BUDGET", type: "single_select", required: true, text: "What is your annual budget for CRM software and services?", options: [...opts(["Under $50,000", "$50,000–$249,999", "$250,000–$999,999", "$1 million or more"]), { code: 99, label: "Don't know", flags: ["exclusive", "anchor_bottom"] }], displayLogic: rule("h_role", "selected", 1) },
    { id: "q_alloc", code: "D2", variableName: "BUDGET_SPLIT", type: "allocation", required: true, text: "Roughly how is that budget divided? The parts must add up to 100%.", options: opts(["Licences or subscriptions", "Implementation and integration", "Training", "Support and maintenance"]), settings: { sumTarget: 100, sumUnit: "%" }, displayLogic: and(rule("h_role", "selected", 1), not(rule("q_budget", "selected", 99))) },
    { id: "q_process", code: "D3", variableName: "PROCUREMENT", type: "multi_select", required: true, text: "Which of these are part of how your company buys software? Select all that apply.", options: [...opts(["A formal request for proposal (RFP)", "Security and compliance review", "Proof of concept or pilot", "Reference calls with other customers", "Board or executive sign-off"]), NONE("None of these")], randomization: shuffle, displayLogic: rule("h_role", "selected", 1) },
    /* influencers: criteria */
    { id: "q_criteria", code: "N1", variableName: "CRITERIA", type: "ranking", required: true, text: "Rank the three criteria that matter most when you evaluate a CRM.", settings: { rankMode: "top_n", maxSelections: 3 }, options: opts(["Total cost", "Ease of use", "Integration", "Security", "Vendor stability", "Analytics and AI features"]), randomization: shuffle, displayLogic: rule("h_role", "selected", 2) },
    /* end users: daily experience */
    { id: "q_daily", code: "U1", variableName: "DAILY_USE", type: "single_select", required: true, text: "How much of your working day do you spend in the CRM?", options: opts(["Almost all of it", "About half", "An hour or two", "Less than an hour"]), displayLogic: rule("h_role", "selected", 3) },
    { id: "q_pain", code: "U2", variableName: "PAIN", type: "long_text", required: false, text: "What is the one thing you would change about it?", displayLogic: rule("h_role", "selected", 3) },
    { id: "q_adopt", code: "T1", variableName: "AI_ADOPTION", type: "single_select", required: true, text: "Where is your company with AI features in its sales and service tools?", options: opts(["In daily use", "Piloting", "Planning to within 12 months", "No plans"]) },
    { id: "q_switch", code: "T2", variableName: "SWITCH_INTENT", type: "single_select", required: true, text: "How likely is your company to change its main CRM in the next two years?", options: LIKELY_5, displayLogic: rule("q_main", "answered") },
  ];
  return survey(surveyId, { code: "B2B_CRM", title: "B2B decision-maker research — enterprise software" }, questions, [
    page("p_company", "Your company", ["q_emp", "q_ind", "q_rev"]),
    page("p_you", "Your role", ["q_level", "q_involve", "h_role"]),
    page("p_vendors", "Software in use", ["q_use"]),
    page("p_main", "Software in use", ["q_main", "q_vsat"]),
    page("p_dm", "Budget and buying", ["q_budget", "q_alloc", "q_process"]),
    page("p_inf", "Evaluating", ["q_criteria"]),
    page("p_user", "Day to day", ["q_daily", "q_pain"]),
    page("p_future", "Looking ahead", ["q_adopt", "q_switch"]),
  ]);
}

/* ================================================================ 6. Customer journey / usage and attitude */

export function buildAdvJourneySurvey(surveyId = "adv-journey"): SurveyDefinition {
  const BANKS = opts(["Meridian Bank", "Castlegate", "Tidewater", "Fennel Digital", "Oakhurst"]);
  const cf = (from: string, keepOwn = false) => ({ sourceQuestionId: from, filter: "selected", into: "options", ...(keepOwn ? { keepOwn: true } : {}) });
  const questions: Q[] = [
    { id: "q_acct", code: "S1", variableName: "HAS_ACCOUNT", type: "single_select", required: true, text: "Do you have a current (checking) account in your own name?", options: opts(["Yes", "No"]), skipLogic: [screenOut("sk_acct", rule("q_acct", "selected", 2))] },
    { id: "q_aware", code: "J1", variableName: "AWARE", type: "multi_select", required: true, text: "Which of these banks have you heard of?", options: [...BANKS, NONE()], randomization: shuffle, skipLogic: [screenOut("sk_aware", rule("q_aware", "selected", 98))] },
    { id: "q_consider", code: "J2", variableName: "CONSIDER", type: "multi_select", required: true, text: "Which of them would you consider banking with?", options: [NONE("None of them")], carryForward: cf("q_aware", true) },
    { id: "q_ever", code: "J3", variableName: "EVER_USED", type: "multi_select", required: true, text: "Which have you ever held an account with?", options: [NONE("None of them")], carryForward: cf("q_aware", true) },
    /* the engine answers this one itself when only one bank was ever used */
    { id: "q_main", code: "J4", variableName: "MAIN_BANK", type: "single_select", required: true, text: "Which is your main bank today?", options: [], carryForward: cf("q_ever"), displayLogic: not(rule("q_ever", "selected", 98)) },
    derived("h_stage", "JOURNEY_STAGE", "Journey stage (derived)", opts(["Customer", "Lapsed or never — considers", "Aware only"]), [[1, rule("q_main", "answered")], [2, not(rule("q_consider", "selected", 98))], [3]]),
    { id: "q_freq", code: "U1", variableName: "APP_FREQ", type: "single_select", required: true, text: "How often do you use {{MAIN_BANK}}'s mobile app?", options: opts(["Every day", "A few times a week", "About once a week", "Less often", "Never"]), displayLogic: rule("h_stage", "selected", 1) },
    { id: "q_touch", code: "U2", variableName: "TOUCHPOINTS", type: "matrix_single", required: true, text: "How satisfied are you with {{MAIN_BANK}} on each of these?", rows: rows(["Mobile app", "Website", "Branch", "Phone support", "Fees and charges"]), options: [...SAT_5, { code: 9, label: "Not used", flags: ["exclusive"] }], displayLogic: rule("h_stage", "selected", 1) },
    { id: "q_nps", code: "U3", variableName: "NPS", type: "nps", required: true, text: "How likely are you to recommend {{MAIN_BANK}} to a friend or colleague?", displayLogic: rule("h_stage", "selected", 1) },
    { id: "q_stay", code: "U4", variableName: "STAY", type: "single_select", required: true, text: "How likely are you to still be with {{MAIN_BANK}} in two years?", options: LIKELY_5, displayLogic: rule("h_stage", "selected", 1) },
    { id: "q_leave", code: "U5", variableName: "SWITCH_WHY", type: "multi_select", required: true, text: "What might make you leave? Select all that apply.", options: [...opts(["Fees", "A better rate elsewhere", "Poor app or website", "Poor service", "A branch closing"]), OTHER], randomization: shuffle, displayLogic: and(rule("h_stage", "selected", 1), rule("q_stay", "in", [1, 2, 3])) },
    { id: "q_barrier", code: "B1", variableName: "BARRIERS", type: "multi_select", required: true, text: "What has stopped you opening an account with a bank you would consider? Select all that apply.", options: [...opts(["Too much effort to switch", "Not sure it is better", "Fees", "No branch near me", "I am happy where I am"]), OTHER], randomization: shuffle, displayLogic: rule("h_stage", "selected", 2) },
    { id: "q_know", code: "B2", variableName: "AWARE_SOURCE", type: "multi_select", required: true, text: "Where have you seen or heard of these banks? Select all that apply.", options: [...opts(["TV or streaming ads", "Online ads", "Friends or family", "A branch or cash machine", "News"]), NONE("I can't remember")], randomization: shuffle, displayLogic: rule("h_stage", "selected", 3) },
  ];
  return survey(surveyId, { code: "JOURNEY", title: "Customer journey — retail banking" }, questions, [
    page("p_screen", "Banking", ["q_acct"]),
    page("p_aware", "Banks you know", ["q_aware"]),
    page("p_consider", "Banks you know", ["q_consider"]),
    page("p_ever", "Banks you have used", ["q_ever"]),
    page("p_main", "Your main bank", ["q_main", "h_stage"]),
    page("p_use", "Using your bank", ["q_freq", "q_touch"]),
    page("p_loyal", "Staying or leaving", ["q_nps", "q_stay"]),
    page("p_leave", "Staying or leaving", ["q_leave"]),
    page("p_barrier", "What holds you back", ["q_barrier"]),
    page("p_know", "How you know them", ["q_know"]),
  ]);
}

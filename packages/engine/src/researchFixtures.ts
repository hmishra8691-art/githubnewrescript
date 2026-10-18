import { SurveyDefinition } from "@rescript/schema";

/*
 * Fixtures for the research-intelligence tests (2026-10-17): a quantitative
 * pricing study with deliberate gaps, and a qualitative interview guide.
 * Not exported from the package index.
 */
const opts = (...ls: string[]) => ls.map((l, i) => ({ code: i + 1, label: l }));
const scale = (lo: string, hi: string) => opts(lo, "Disagree", "Neither", "Agree", hi);
export function pricingStudy(over: Record<string, unknown> = {}): SurveyDefinition {
  return SurveyDefinition.parse({
    meta: { id: "s", code: "PR", title: "Pricing" },
    research: {
      objective: "Understand whether price perception drives switching among broadband customers",
      hypotheses: ["Higher price perception increases switching intention", "Satisfaction differs by sales channel"],
      hypothesisDetails: [{ type: "causal", direction: "positive", independent: "Price perception", dependent: "Switching intention" }, { type: "difference", direction: "difference", dependent: "Satisfaction" }],
      researchQuestions: ["Which channels do customers use to buy broadband?"],
      constructs: [{ name: "Price perception", role: "independent", questionIds: ["q3"] }, { name: "Switching intention", role: "dependent", questionIds: ["q4"] }, { name: "Satisfaction", role: "dependent", questionIds: [] }],
      analysisPlan: {
        crosstabs: [],
        tests: [
          { id: "t1", method: "regression", outcome: "SWITCH", variables: ["PRICE_PERC"], priority: 1, hypotheses: ["H1"] },
          { id: "t2", method: "t_test", outcome: "SAT", groupBy: "CHANNELS", variables: [], priority: 1, hypotheses: ["H2"] },
          { id: "t3", method: "chi_square", outcome: "LOYAL", variables: ["GENDER"], priority: 2, hypotheses: [] },
        ],
        derived: [], segments: [],
      },
      ...over,
    },
    questions: [
      { id: "q1", code: "S1", variableName: "AGE", type: "numeric", text: "How old are you?" },
      { id: "q2", code: "S2", variableName: "GENDER", type: "single_select", text: "What is your gender?", options: opts("Male", "Female") },
      { id: "q3", code: "Q1", variableName: "PRICE_PERC", type: "single_select", text: "My broadband is expensive for what I get", options: scale("Strongly disagree", "Strongly agree") },
      { id: "q4", code: "Q2", variableName: "SWITCH", type: "single_select", text: "How likely are you to switch provider?", options: opts("Very unlikely", "Unlikely", "Neither", "Likely", "Very likely") },
      { id: "q5", code: "Q3", variableName: "CHANNELS", type: "multi_select", text: "Which sales channels have you used to buy broadband?", options: opts("Online", "Phone", "Store", "Agent") },
      { id: "q6", code: "Q4", variableName: "COMMENT", type: "open_text", text: "Anything about your router?" },
      { id: "q7", code: "Q5", variableName: "SAT", type: "single_select", text: "How satisfied are you overall?", options: opts("Very dissatisfied", "Dissatisfied", "Neither", "Satisfied", "Very satisfied") },
    ],
    flow: [{ type: "block", id: "b1", title: "Main", children: [{ type: "page", id: "p1", questionIds: ["q1", "q2", "q3", "q4", "q5", "q6", "q7"] }] }, { type: "end", id: "e", status: "complete" }],
  });
}


/** a self-completion interview guide: warm-up, two topic blocks of open questions (one probed), a wrap-up */
export function qualGuide(over: Record<string, unknown> = {}): SurveyDefinition {
  return SurveyDefinition.parse({
    meta: { id: "g", code: "IG", title: "Switching interviews" },
    research: {
      objective: "Explore why broadband customers switch provider",
      methodology: "Qualitative self-completion interview guide with AI follow-up probes",
      researchQuestions: ["What triggers customers to consider switching?", "How do customers compare providers?"],
      constructs: [{ name: "Switching triggers", role: "descriptive", questionIds: ["g2", "g3"] }, { name: "Comparing providers", role: "descriptive", questionIds: ["g4"] }],
      ...over,
    },
    questions: [
      { id: "g1", code: "Q1", variableName: "WARMUP", type: "long_text", text: "To start, tell us a little about how you use the internet at home." },
      { id: "g2", code: "Q2", variableName: "TRIGGER", type: "long_text", text: "Think about the last time you considered switching provider. What happened?", probe: { maxProbes: 2, instruction: "Ask for the moment they decided and what tipped it." } },
      { id: "g3", code: "Q3", variableName: "TRIGGER_FEEL", type: "long_text", text: "How did you feel about your provider at that time?" },
      { id: "g4", code: "Q4", variableName: "COMPARE", type: "long_text", text: "When you compare providers, what do you look at first?" },
      { id: "g5", code: "Q5", variableName: "WRAPUP", type: "open_text", text: "Is there anything else you would like to add?" },
    ],
    flow: [
      { type: "block", id: "b1", title: "Warm-up", children: [{ type: "page", id: "p1", questionIds: ["g1"] }] },
      { type: "block", id: "b2", title: "Triggers", children: [{ type: "page", id: "p2", questionIds: ["g2", "g3"] }] },
      { type: "block", id: "b3", title: "Comparing", children: [{ type: "page", id: "p3", questionIds: ["g4"] }] },
      { type: "block", id: "b4", title: "Wrap-up", children: [{ type: "page", id: "p4", questionIds: ["g5"] }] },
      { type: "end", id: "e", status: "complete" },
    ],
  });
}

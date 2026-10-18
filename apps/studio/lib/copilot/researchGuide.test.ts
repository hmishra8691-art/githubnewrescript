import { test } from "node:test";
import assert from "node:assert/strict";
import { ANALYSIS_METHODS, SurveyDefinition, type AnalysisMethod } from "@rescript/schema";
import { applySurveyActions, capabilityBrief, coerceSurveyActions, EXPORTS, METHOD_CHART, researchTraceability, validateResearch } from "@rescript/engine";
import * as exporters from "@rescript/exporters";
import * as analytics from "@rescript/analytics";
import * as analyticsExport from "@rescript/analytics/export";
import { COPILOT_QUAL_GUIDE, COPILOT_RESEARCH_GUIDE, qualIntent, researchPlanIntent } from "./researchGuide.ts";
import { COPILOT_SYSTEM_PROMPT, copilotUserPrompt } from "./prompt.ts";
import { copilotCall } from "../aiPromptCache.ts";

/*
 * RESEARCH INTELLIGENCE (2026-10-17): the research and qualitative guides are chosen by the
 * request, ride in the cached prefix, stay bounded, tell the model what exists from the capability
 * registry, and every worked example passes the engine's gate and leaves a study the validator
 * and the traceability accept. The registry's exports and charts are checked against the packages
 * that make them.
 */

const base = { outline: "(survey)", surveyLanguage: "English", mode: "edit" as const };
const exampleLines = (guide: string) => guide.split("\n").filter((l) => l.startsWith('{"op":')).map((l) => JSON.parse(l.split("   //")[0]));

test("chosen by the request: research briefs, hypotheses, methodology, mixed and advanced designs → research guide; interviews, probes, open-ended → qualitative guide", () => {
  const research = [
    "Here is the research brief: we need to decide whether to cut the Basic price. Plan the study.",
    "Add a hypothesis about price sensitivity", "What methodology should we use and what sample size?", "Write the research objectives and the analysis plan",
    "Show me the traceability from objectives to analysis", "Design a mixed-methods study: qualitative first, then a survey", "Set up a monadic concept test of three concepts",
    "a Van Westendorp pricing study", "Which test should I use for satisfaction by region?", "validate the study",
  ];
  for (const m of research) assert.ok(researchPlanIntent(m), m);
  assert.ok(researchPlanIntent("Create a survey about coffee", "generate"), "every generation");
  const qual = ["Create a qualitative interview guide about switching", "add probing follow-up questions to Q3", "an exploratory study with open-ended questions", "we want in-depth interviews", "run two focus groups", "mixed methods: qual then quant"];
  for (const m of qual) assert.ok(qualIntent(m), m);
  const neither = ["make Q7 a 5-point scale", "translate Q5 into Hindi", "randomize the options of Q5", "show Q10 only to people who chose Apple", "add a None option to Q4"];
  for (const m of neither) { assert.ok(!researchPlanIntent(m, "edit"), m); assert.ok(!qualIntent(m), m); }
  assert.ok(copilotUserPrompt({ ...base, message: research[0] }).includes("RESEARCH GUIDE"));
  assert.ok(copilotUserPrompt({ ...base, message: qual[0] }).includes("QUALITATIVE GUIDE"));
  const plain = copilotUserPrompt({ ...base, message: neither[0] });
  assert.ok(!plain.includes("RESEARCH GUIDE") && !plain.includes("QUALITATIVE GUIDE"), "sent only when the request needs it");
  assert.ok(!copilotUserPrompt({ ...base, message: research[0], researchPlan: false }).includes("RESEARCH GUIDE"), "the caller can say no");
});

test("sizes and caching: the system prompt is under its cap; the guides are bounded and ride in the cached prefix", () => {
  assert.ok(COPILOT_SYSTEM_PROMPT.length < 14_800, `${COPILOT_SYSTEM_PROMPT.length}`);
  assert.ok(COPILOT_RESEARCH_GUIDE.length < 8_000, `research guide ${COPILOT_RESEARCH_GUIDE.length}`);
  assert.ok(COPILOT_QUAL_GUIDE.length < 3_000, `qualitative guide ${COPILOT_QUAL_GUIDE.length}`);
  const prompt = copilotUserPrompt({ ...base, message: "Design a mixed-methods study: qualitative interviews first, then a survey" });
  const [system, user] = copilotCall(prompt);
  assert.deepEqual(system, [COPILOT_SYSTEM_PROMPT, [COPILOT_RESEARCH_GUIDE, COPILOT_QUAL_GUIDE].join("\n\n")]);
  assert.ok(!user.includes(COPILOT_RESEARCH_GUIDE) && !user.includes(COPILOT_QUAL_GUIDE));
});

test("what the model is told: the planning order, the selection rules, the status words, mixed and advanced methods — and the registry's brief", () => {
  for (const w of ["PROBLEM", "OBJECTIVES", "HYPOTHESES", "METHODOLOGY", "CONSTRUCTS", "INSTRUMENT", "SAMPLING", "ANALYSIS", "VALIDATES", "TRACEABILITY", "SELECTION RULES", "NEVER a multi-select as the groups", "RECOMMENDED", "GENERATED", "APPLIED", "EXECUTED", "PLANNED", "MIXED METHODS", "Phase 1", "Monadic concept test", "Van Westendorp", "not executable in Rescript"]) assert.ok(COPILOT_RESEARCH_GUIDE.includes(w), w);
  assert.ok(COPILOT_RESEARCH_GUIDE.endsWith(capabilityBrief()), "the capabilities come from the registry");
  for (const w of ["SELF-COMPLETION INTERVIEW GUIDE", "set_probe", "warm-up", "wrap-up", "text_themes", "NOT SUPPORTED", "focus groups", "never population percentages"]) assert.ok(COPILOT_QUAL_GUIDE.includes(w), w);
});

const studyFixture = () => SurveyDefinition.parse({
  meta: { id: "s", code: "BB", title: "Broadband" }, questions: [
    { id: "q1", code: "Q1", variableName: "PRICE_PERC", type: "single_select", text: "My plan is expensive for what it gives me", options: ["Strongly disagree", "Disagree", "Neither", "Agree", "Strongly agree"].map((label, i) => ({ code: i + 1, label })), required: true },
    { id: "q2", code: "Q2", variableName: "SWITCH", type: "single_select", text: "How likely are you to switch provider in the next year?", options: ["Very unlikely", "Unlikely", "Neither", "Likely", "Very likely"].map((label, i) => ({ code: i + 1, label })), required: true },
    { id: "q3", code: "Q3", variableName: "TENURE", type: "numeric", text: "How many years have you been with your provider?", validation: [{ kind: "min_value", value: 0 }, { kind: "max_value", value: 50 }], required: true },
  ],
  flow: [{ type: "block", id: "b1", title: "Main", children: [{ type: "page", id: "p1", questionIds: ["q1", "q2", "q3"] }] }, { type: "end", id: "e", status: "complete" }],
});

test("the research guide's worked examples apply as written and leave a study with no blocking item and H1 planned", () => {
  const ex = exampleLines(COPILOT_RESEARCH_GUIDE);
  assert.equal(ex.length, 6);
  const c = coerceSurveyActions(ex);
  assert.deepEqual(c.rejected, []);
  const r = applySurveyActions(studyFixture(), c.actions);
  assert.deepEqual(r.errors, [], JSON.stringify(r.results.filter((x) => !x.ok)));
  const v = validateResearch(r.def);
  assert.equal(v.counts.blocking, 0, JSON.stringify(v.items.filter((i) => i.class === "blocking")));
  const t = researchTraceability(r.def);
  assert.equal(t.rows[0].status, "planned");
  assert.deepEqual(t.rows[0].questions.map((q) => q.variable), ["PRICE_PERC", "SWITCH"]);
  assert.deepEqual(t.rows[0].analyses.map((a) => [a.method, a.compatible]), [["regression", true]]);
  assert.ok(!t.gaps.some((g) => g.severity === "blocking"));
});

test("the qualitative guide's worked examples build a probed, mapped guide the validator reads as qualitative", () => {
  let def = SurveyDefinition.parse({ meta: { id: "g", code: "G", title: "Guide" }, questions: [], flow: [{ type: "end", id: "e", status: "complete" }] });
  def = applySurveyActions(def, [{ op: "create_block", title: "Triggers" }]).def;
  const c = coerceSurveyActions(exampleLines(COPILOT_QUAL_GUIDE));
  assert.deepEqual(c.rejected, []);
  const r = applySurveyActions(def, c.actions);
  assert.deepEqual(r.errors, [], JSON.stringify(r.results.filter((x) => !x.ok)));
  const q = r.def.questions.find((x) => x.variableName === "TRIGGER")!;
  assert.equal(q.probe?.maxProbes, 2);
  const v = validateResearch(r.def);
  assert.equal(v.kind, "qualitative");
  assert.equal(v.counts.blocking, 0, JSON.stringify(v.items.filter((i) => i.class === "blocking")));
  assert.deepEqual(v.traceability.rows.map((x) => [x.id, x.questions.map((y) => y.variable).join(",")]), [["RQ1", "TRIGGER"]]);
});

test("the registry's exports name functions that exist, its charts are in the analytics catalogue, every plan method runs as an analytics kind", () => {
  const modules: Record<string, Record<string, unknown>> = { "@rescript/exporters": exporters, "@rescript/analytics": { ...analytics, ...analyticsExport } };
  for (const e of EXPORTS) assert.equal(typeof modules[e.module]?.[e.symbol], "function", `${e.id}: ${e.module}.${e.symbol}`);
  const charts = new Set(analytics.CHART_CATALOG.map((c) => c.type));
  for (const [m, chart] of Object.entries(METHOD_CHART)) assert.ok(charts.has(chart as never), `${m}: ${chart}`);
  const kinds = new Set(analytics.ANALYSIS_KINDS.map((k) => k.kind));
  for (const m of ANALYSIS_METHODS) {
    const d = analytics.testDefinition({ id: "t", method: m as AnalysisMethod, outcome: "A", variables: ["B"], priority: 2, hypotheses: [] }, { environment: "TEST" } as never);
    assert.ok(kinds.has(d.kind), `${m} → ${d.kind}`);
  }
});

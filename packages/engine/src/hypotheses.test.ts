import { test } from "node:test";
import assert from "node:assert/strict";
import { SurveyDefinition } from "@rescript/schema";
import { constructFor, describeHypothesis, parseHypothesis, structuredHypotheses } from "./hypotheses.js";
import { hypothesisCoverage } from "./analysisFramework.js";
import { applySurveyActions } from "./surveyActions.js";

/*
 * STRUCTURED HYPOTHESES (Research Engine audit, Phase 3): the reading of a
 * statement — type, direction, the sides, the groups — parsed from its
 * words, overridden by what is recorded, resolved to the design's
 * constructs; the actions that record it keep the readings aligned with
 * their statements; the coverage reads the resolved sides.
 */
const opts = (...ls: string[]) => ls.map((l, i) => ({ code: i + 1, label: l }));
function survey(): SurveyDefinition {
  return SurveyDefinition.parse({
    meta: { id: "s", code: "SW", title: "Brand switching" },
    research: { objective: "Why customers switch", hypotheses: ["Price drives switching", "Women are more satisfied than men", "Trust mediates the effect of exposure on purchase intention"], constructs: [
      { name: "Price perception", role: "independent", questionIds: ["q6"] }, { name: "Switching", role: "dependent", questionIds: ["q4"] }, { name: "Satisfaction", role: "dependent", questionIds: ["q7"] }, { name: "Trust", role: "mediator", questionIds: [] },
    ], analysis: [], assumptions: [], sources: [] },
    questions: [
      { id: "q2", code: "Q2", variableName: "GENDER", type: "single_select", text: "What is your gender?", options: opts("Male", "Female") },
      { id: "q4", code: "Q4", variableName: "SWITCHED", type: "single_select", text: "Have you switched brands?", options: opts("Yes", "No") },
      { id: "q6", code: "Q6", variableName: "PRICE_PERC", type: "single_select", text: "Brand B offers better value", options: opts("Disagree", "Neutral", "Agree") },
      { id: "q7", code: "Q7", variableName: "SAT", type: "single_select", text: "How satisfied are you?", options: opts("1", "2", "3", "4", "5") },
    ],
    flow: [{ type: "page", id: "p1", title: "p", questionIds: ["q2", "q4", "q6", "q7"] }, { type: "end", id: "e", status: "complete" }],
  });
}
const apply = (def: SurveyDefinition, actions: unknown[]) => { const out = applySurveyActions(def, actions as never); assert.ok(out.valid && out.results.every((x) => x.ok), JSON.stringify(out.results.filter((x) => !x.ok).map((x) => x.error).concat(out.errors))); return out; };

test("parseHypothesis: type, direction and the sides from the words", () => {
  const cases: [string, Record<string, unknown>][] = [
    ["Price perception drives switching", { type: "causal", direction: "positive", independent: "Price perception", dependent: "switching" }],
    ["Service satisfaction reduces switching", { type: "causal", direction: "negative", independent: "Service satisfaction", dependent: "switching" }],
    ["Lower prices increase purchase intent", { type: "causal", direction: "negative", independent: "prices", dependent: "purchase intent" }],
    ["Higher prices lower intent", { type: "causal", direction: "negative", independent: "prices", dependent: "intent" }],
    ["Delays reduce satisfaction and increase complaints", { type: "causal", direction: "negative", independent: "Delays", dependent: "satisfaction" }],
    ["Trust increases loyalty and reduces churn", { type: "causal", direction: "positive", independent: "Trust", dependent: "loyalty" }],
    ["Social media exposure increases the likelihood of purchasing premium skincare", { type: "causal", direction: "positive", independent: "Social media exposure", dependent: "purchasing premium skincare" }],
    ["Women are more satisfied than men", { type: "difference", direction: "positive", group: "women", lower: "men", dependent: "satisfied" }],
    ["Men are less likely to recommend than women", { type: "difference", direction: "negative", group: "women", lower: "men", dependent: "likely to recommend" }],
    ["Younger respondents are less satisfied", { type: "difference", direction: "positive", group: "younger respondents", independent: "younger respondents", dependent: "satisfied" }],
    ["Intent is higher among first-time buyers", { type: "difference", direction: "positive", dependent: "Intent", group: "first-time buyers", independent: "first-time buyers" }],
    ["Trust mediates the effect of exposure on purchase intention", { type: "causal", direction: "difference", mediator: "Trust", independent: "exposure", dependent: "purchase intention" }],
    ["Price perception moderates the effect of trust on purchase intention", { type: "causal", direction: "difference", moderator: "Price perception", independent: "trust", dependent: "purchase intention" }],
    ["Purchase intent depends on price perception", { type: "causal", direction: "difference", independent: "price perception", dependent: "Purchase intent" }],
    ["Awareness is positively related to purchase intent", { type: "association", direction: "positive", independent: "Awareness", dependent: "purchase intent" }],
    ["Price is negatively associated with loyalty", { type: "association", direction: "negative", independent: "Price", dependent: "loyalty" }],
    ["Region affects satisfaction", { type: "causal", direction: "difference", independent: "Region", dependent: "satisfaction" }],
    ["Satisfaction differs by region", { type: "difference", direction: "difference", dependent: "Satisfaction", independent: "region" }],
    ["Most customers are satisfied", { type: "descriptive", direction: "none" }],
    ["", { type: "descriptive", direction: "none" }],
  ];
  for (const [t, want] of cases) assert.deepEqual(parseHypothesis(t), want, t);
});

test("structuredHypotheses: parsed by default, recorded fields win, each side resolved to a construct of the design", () => {
  const def = survey();
  const hs = structuredHypotheses(def);
  assert.equal(hs.length, 3);
  assert.equal(hs[0].label, "H1");
  assert.equal(hs[0].direction, "positive");
  assert.equal(hs[0].source.direction, "parsed");
  assert.equal(hs[0].constructs.independent?.name, "Price perception", "“price” resolves to the construct whose name carries it");
  assert.equal(hs[0].constructs.dependent?.name, "Switching");
  assert.equal(hs[1].type, "difference");
  assert.equal(hs[1].constructs.dependent?.name, "Satisfaction", "“satisfied” is the Satisfaction construct");
  assert.equal(hs[2].constructs.mediator?.name, "Trust");
  assert.equal(hs[2].constructs.independent, undefined, "“exposure” names no construct");
  assert.match(describeHypothesis(hs[0]), /causal · Price ↑ switching/);
  assert.match(describeHypothesis(hs[1]), /difference · women > men on satisfied/);
  assert.match(describeHypothesis(hs[2]), /via Trust/);
  // recorded fields override the words
  def.research!.hypothesisDetails = [{ direction: "negative", expectedEffect: "large", status: "proposed", dependent: "Satisfaction" }];
  const r = structuredHypotheses(def)[0];
  assert.equal(r.direction, "negative");
  assert.equal(r.source.direction, "recorded");
  assert.equal(r.expectedEffect, "large");
  assert.equal(r.constructs.dependent?.name, "Satisfaction", "the recorded side replaces the parsed one");
  assert.equal(r.independent, "Price", "an unrecorded side stays parsed");
  assert.equal(constructFor(def, "shoe size"), undefined);
  assert.equal(constructFor(def, "the price perception")?.name, "Price perception");
  const two = survey();
  two.research!.constructs.push({ name: "Price sensitivity", role: "moderator", questionIds: [] });
  assert.equal(constructFor(two, "price"), undefined, "a word two constructs carry equally names neither");
  assert.equal(constructFor(two, "price sensitivity")?.name, "Price sensitivity");
  assert.equal(structuredHypotheses({ ...def, research: undefined }).length, 0);
});

test("set_hypothesis records a reading; add and remove keep the readings aligned with the statements; set_research keeps them by text", () => {
  const def = survey();
  const a = apply(def, [{ op: "set_hypothesis", hypothesis: "H1", detail: { type: "causal", direction: "positive", independent: "price perception", dependent: "Switching", expectedEffect: "medium" } }]);
  assert.deepEqual(a.def.research!.hypothesisDetails[0], { type: "causal", direction: "positive", independent: "Price perception", dependent: "Switching", expectedEffect: "medium" }, "a side a word off is corrected to the construct's name");
  assert.match(a.results[0].description, /H1: causal, positive, IV Price perception, DV Switching, medium effect/);
  // the same again changes nothing
  const same = applySurveyActions(a.def, [{ op: "set_hypothesis", hypothesis: "H1", detail: { direction: "positive" } }] as never);
  assert.ok(!same.results[0].ok && /already reads that way/.test(same.results[0].error ?? ""));
  // a capitalised single word that is no construct is refused with the list
  const bad = applySurveyActions(def, [{ op: "set_hypothesis", hypothesis: 2, detail: { dependent: "Happiness" } }] as never);
  assert.ok(!bad.results[0].ok && /no construct “Happiness”/.test(bad.results[0].error ?? ""), bad.results[0].error);
  // a phrase in words is kept as words
  const words = apply(def, [{ op: "set_hypothesis", hypothesis: 2, detail: { dependent: "overall happiness with the brand" } }]);
  assert.equal(words.def.research!.hypothesisDetails[1].dependent, "overall happiness with the brand");
  // add with a detail, then remove the first: the readings move with their statements
  const added = apply(a.def, [{ op: "add_hypothesis", text: "Awareness raises consideration", detail: { expectedEffect: "small" } }]);
  assert.equal(added.def.research!.hypothesisDetails.length, 4);
  assert.deepEqual(added.def.research!.hypothesisDetails[3], { expectedEffect: "small" });
  const removed = apply(added.def, [{ op: "remove_hypothesis", hypothesis: "H1" }]);
  assert.equal(removed.def.research!.hypotheses.length, 3);
  assert.equal(removed.def.research!.hypothesisDetails.length, 3);
  assert.deepEqual(removed.def.research!.hypothesisDetails[2], { expectedEffect: "small" }, "H4's reading is now H3's");
  // set_research with the statements reordered keeps each reading with its statement; a new statement starts blank
  const re = apply(added.def, [{ op: "set_research", hypotheses: ["Awareness raises consideration", "Price drives switching", "Brand new"] }]);
  assert.deepEqual(re.def.research!.hypothesisDetails.map((d) => d.expectedEffect ?? null), ["small", "medium", null]);
  // set_research also records questions, KPIs and the audience, and keeps them when not given
  const rq = apply(re.def, [{ op: "set_research", researchQuestions: ["Why do customers switch?"], kpis: [{ name: "Switching rate", variable: "SWITCHED", measure: "share Yes", direction: "lower" }], audience: { description: "first-time buyers", characteristics: ["no brand vocabulary"], literacy: "plain" } }]);
  assert.deepEqual(rq.def.research!.researchQuestions, ["Why do customers switch?"]);
  assert.equal(rq.def.research!.kpis[0].variable, "SWITCHED");
  assert.equal(rq.def.research!.audience?.literacy, "plain");
  assert.match(rq.results[0].description, /1 research question, 1 KPI, audience/);
  const keep = apply(rq.def, [{ op: "set_research", objective: "Churn" }]);
  assert.equal(keep.def.research!.kpis.length, 1);
  assert.equal(keep.def.research!.audience?.description, "first-time buyers");
  assert.equal(keep.def.research!.hypothesisDetails[0].expectedEffect, "small");
});

test("coverage reads the resolved sides: a hypothesis whose words do not carry the construct's name is still linked through its reading", () => {
  const def = survey();
  // H1 "Price drives switching": the construct is "Price perception" — the name is not in the statement, the parsed side resolves to it
  const cov = hypothesisCoverage(def);
  assert.deepEqual(cov[0].constructs.map((c) => c.name).sort(), ["Price perception", "Switching"]);
  assert.equal(cov[0].status, "partly", "both measured, nothing planned yet");
  assert.equal(cov[2].status, "unmeasured", "Trust (the mediator) has no question");
  // a recorded side links a construct the words never name
  def.research!.hypothesisDetails = [{}, { dependent: "Switching" }, {}];
  assert.ok(hypothesisCoverage(def)[1].constructs.some((c) => c.name === "Switching"));
});

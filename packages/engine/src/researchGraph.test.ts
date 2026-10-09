import { test } from "node:test";
import assert from "node:assert/strict";
import { SurveyDefinition } from "@rescript/schema";
import { buildDependencyIndex, objectKey } from "./dependencyIndex.js";
import { impactOf } from "./impact.js";
import { interpretRequest, type Interpretation } from "./nlIntent.js";

/*
 * THE RESEARCH DESIGN IN THE DEPENDENCY GRAPH (Phase 3.2): a hypothesis is
 * a node that reads its constructs and its tagged questions; a plan item
 * that serves it reads it; a KPI reads its variable. "Which questions
 * measure H1", "what depends on H1" and "what is affected if I remove Q6"
 * are then one graph query each.
 */
const opts = (...ls: string[]) => ls.map((l, i) => ({ code: i + 1, label: l }));
function survey(): SurveyDefinition {
  return SurveyDefinition.parse({
    meta: { id: "s", code: "SW", title: "Brand switching" },
    research: {
      objective: "Why customers switch", hypotheses: ["Price perception drives switching", "Women are more satisfied than men", "Trust mediates the effect of exposure on switching"],
      hypothesisDetails: [{}, {}, { independent: "Exposure" }],
      constructs: [{ name: "Price perception", role: "independent", questionIds: ["q6", "q8"] }, { name: "Switching", role: "dependent", questionIds: ["q4"] }, { name: "Satisfaction", role: "dependent", questionIds: ["q7"] }, { name: "Trust", role: "mediator", questionIds: [] }, { name: "Exposure", role: "independent", questionIds: ["q9"] }],
      kpis: [{ name: "Switching rate", variable: "SWITCHED", measure: "share Yes", direction: "lower" }, { name: "Value score", variable: "VALUE_SCORE" }],
      analysisPlan: { crosstabs: [{ id: "x1", rows: ["SWITCHED"], columns: ["GENDER"], priority: 1, hypotheses: ["H1"] }], tests: [{ id: "t1", method: "t_test", outcome: "SAT", groupBy: "GENDER", variables: [], priority: 1, hypotheses: ["H2"] }], derived: [{ name: "VALUE_SCORE", kind: "mean_score", from: ["PRICE_PERC", "PRICE_2"] }], segments: [] },
      analysis: [], assumptions: [], sources: [],
    },
    questions: [
      { id: "q2", code: "Q2", variableName: "GENDER", type: "single_select", text: "What is your gender?", options: opts("Male", "Female") },
      { id: "q4", code: "Q4", variableName: "SWITCHED", type: "single_select", text: "Have you switched brands?", options: opts("Yes", "No"), analysis: { hypotheses: ["H1"] } },
      { id: "q6", code: "Q6", variableName: "PRICE_PERC", type: "single_select", text: "Brand B offers better value", options: opts("Disagree", "Neutral", "Agree") },
      { id: "q7", code: "Q7", variableName: "SAT", type: "single_select", text: "How satisfied are you?", options: opts("1", "2", "3", "4", "5") },
      { id: "q8", code: "Q8", variableName: "PRICE_2", type: "single_select", text: "Brand B is fairly priced", options: opts("Disagree", "Neutral", "Agree") },
      { id: "q9", code: "Q9", variableName: "EXPOSE", type: "single_select", text: "How often do you see Brand B advertising?", options: opts("Never", "Sometimes", "Often") },
      { id: "q10", code: "Q10", variableName: "PETS", type: "single_select", text: "Do you have pets?", options: opts("Yes", "No") },
    ],
    flow: [{ type: "page", id: "p1", title: "p", questionIds: ["q2", "q4", "q6", "q7", "q8", "q9", "q10"] }, { type: "end", id: "e", status: "complete" }],
  });
}

test("the graph: hypothesis and KPI nodes with their edges, in both directions", () => {
  const ix = buildDependencyIndex(survey());
  const h1 = objectKey("hypothesis", "H1");
  assert.ok(ix.nodes.has(h1));
  assert.deepEqual(ix.dependsOn(h1).map((e) => `${e.to} ${e.label}`).sort(), [
    "construct:Price perception H1 — independent construct", "construct:Switching H1 — dependent construct", "question:q4 H1 — tagged question",
  ]);
  assert.deepEqual(ix.reach(h1).filter((k) => k.startsWith("question:")).sort(), ["question:q4", "question:q6", "question:q8"], "the questions that measure H1, through its constructs and its tag");
  assert.deepEqual(ix.usedBy(h1).map((e) => e.from), ["analysis:x1"], "the crosstab that serves it reads it");
  assert.ok(ix.affects(objectKey("question", "q6")).includes(h1), "Q6 → Price perception → H1");
  const h3 = objectKey("hypothesis", "H3");
  assert.ok(ix.dependsOn(h3).some((e) => e.to === "construct:Trust" && /mediator/.test(e.label)));
  assert.ok(ix.dependsOn(h3).some((e) => e.to === "construct:Exposure" && /independent/.test(e.label)), "the recorded side");
  const kpi = objectKey("kpi", "Switching rate");
  assert.deepEqual(ix.dependsOn(kpi).map((e) => e.to), ["question:q4"]);
  assert.deepEqual(ix.dependsOn(objectKey("kpi", "Value score")).map((e) => e.to), ["analysis:derived:VALUE_SCORE"], "a KPI on a derived variable reads the plan's variable");
  assert.equal(buildDependencyIndex({ ...survey(), research: undefined }).nodes.has(h1), false);
});

test("“which questions measure H1” / “what depends on H1” / “what is affected if I remove Q6” are graph queries", () => {
  const def = survey();
  const m = interpretRequest(def, "Which questions measure H1?");
  assert.equal(m.kind, "answer", JSON.stringify(m));
  const a = m as Extract<Interpretation, { kind: "answer" }>;
  assert.match(a.answer, /H1 \(“Price perception drives switching”; causal · Price perception ↑ switching\) is measured by Q4 \(tagged, construct “Switching”\), Q6 \(construct “Price perception”\), Q8 \(construct “Price perception”\)/, "in flow order");
  assert.deepEqual(a.sections.map((s) => s.title), ["Questions that measure H1", "Planned analyses that serve it"]);
  assert.deepEqual(a.sections[0].items.map((i) => i.key), ["question:q4", "question:q6", "question:q8"]);
  const third = interpretRequest(def, "which questions measure the third hypothesis") as Extract<Interpretation, { kind: "answer" }>;
  assert.match(third.answer, /H3 .* is measured by Q4 \(construct “Switching”\), Q9 \(construct “Exposure”\); its construct “Trust” has no question yet/);
  assert.ok(third.sections.some((s) => /no question measures/.test(s.title)));
  const none = interpretRequest(def, "which questions measure H9");
  assert.equal(none.kind, "refused");
  assert.match((none as { reason: string }).reason, /no hypothesis H9 — the hypotheses are H1, H2, H3/);
  const dep = interpretRequest(def, "What depends on H1?");
  assert.equal(dep.kind, "answer", JSON.stringify(dep));
  const d = dep as Extract<Interpretation, { kind: "answer" }>;
  assert.ok(d.sections.some((s) => s.items.some((i) => i.key === "analysis:x1")), JSON.stringify(d.sections));
  const reads = interpretRequest(def, "What does H2 read?") as Extract<Interpretation, { kind: "answer" }>;
  assert.equal(reads.kind, "answer");
  assert.ok(reads.sections.some((s) => s.items.some((i) => i.key === "construct:Satisfaction")), JSON.stringify(reads.sections));
  const kpiDep = interpretRequest(def, "What depends on Q4?") as Extract<Interpretation, { kind: "answer" }>;
  assert.ok(kpiDep.sections.some((s) => s.items.some((i) => i.key === "kpi:Switching rate")), "the KPI reads Q4");
});

test("impact: removing a question says which hypotheses lose a measure (and when they are left unmeasured) and which KPIs break", () => {
  const def = survey();
  const q6 = impactOf(def, { questions: ["q6"] }, { change: "delete" });
  const h1 = q6.items.find((i) => i.object.kind === "hypothesis" && i.object.id === "H1")!;
  assert.ok(h1, JSON.stringify(q6.items.map((i) => `${i.object.kind}:${i.object.id}`)));
  assert.equal(h1.severity, "informs", "Q8 still measures Price perception");
  assert.match(h1.text, /measures its construct “Price perception”/);
  assert.doesNotMatch(h1.text, /only question/);
  const q4 = impactOf(def, { questions: ["q4"] }, { change: "delete" });
  const h1b = q4.items.find((i) => i.object.kind === "hypothesis" && i.object.id === "H1")!;
  assert.equal(h1b.severity, "changes", "Q4 is Switching's only question");
  assert.match(h1b.text, /tagged with it, measures its construct “Switching” \(its only question\); it would be left unmeasured/);
  const kpi = q4.items.find((i) => i.object.kind === "kpi")!;
  assert.equal(kpi.severity, "breaks");
  assert.match(kpi.text, /KPI “Switching rate” is read from SWITCHED — no variable to read it from/);
  assert.match(q4.summary, /hypothesis H1/);
  const q10 = impactOf(def, { questions: ["q10"] }, { change: "delete" });
  assert.ok(!q10.items.some((i) => i.object.kind === "hypothesis" || i.object.kind === "kpi"), "a question outside the design touches none");
  const sentence = interpretRequest(def, "What will break if I delete Q4?");
  assert.equal(sentence.kind, "answer");
  assert.match((sentence as { answer: string }).answer, /hypothesis H1|KPI/);
});

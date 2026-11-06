import test from "node:test";
import assert from "node:assert/strict";
import { def as base, synthDataset } from "./analyses/fixture.js";
import { runPlan, type Finding } from "./findings.js";
import { buildOverview, plainReading } from "./overview.js";
import { evidenceLine } from "./evidence.js";

/*
 * THE EXECUTIVE OVERVIEW (M2): key findings are the ones that hold, in research terms, with plain readings that never
 * claim causation; hypotheses in words; nothing when there is no run.
 */

function designed() {
  const def = structuredClone(base);
  def.research = {
    objective: "What drives satisfaction", hypotheses: ["Region affects satisfaction", "Awareness of Alpha raises consideration"], hypothesisDetails: [], researchQuestions: [], assumptions: [], sources: [], analysis: [],
    kpis: [{ name: "Net Promoter Score", variable: "NPS", measure: "NPS", target: "40" }],
    brief: { decision: "Whether to invest in the South", stakeholders: [], deliverables: [] },
    constructs: [{ name: "Satisfaction", role: "dependent", questionIds: ["q_sat"] }, { name: "Region", role: "independent", questionIds: ["q_region"] }],
    analysisPlan: {
      crosstabs: [{ id: "x1", rows: ["SAT"], columns: ["REGION"], priority: 1, hypotheses: ["H1"], reason: "satisfaction by region" }, { id: "x2", rows: ["CONSIDER"], columns: ["AWARE"], priority: 2, hypotheses: ["H2"] }],
      tests: [{ id: "t1", method: "anova", outcome: "SAT", variables: [], groupBy: "REGION", priority: 1, hypotheses: ["H1"] }, { id: "t2", method: "correlation", outcome: "NPS", variables: ["AGE"], priority: 3, hypotheses: [] }],
      derived: [], segments: [],
    },
  } as never;
  return def;
}

test("no run: an empty overview that still carries the objective and the decision", () => {
  const o = buildOverview(designed(), null);
  assert.equal(o.run, null); assert.equal(o.objective, "What drives satisfaction"); assert.equal(o.decision, "Whether to invest in the South");
  assert.deepEqual(o.keyFindings, []); assert.deepEqual(o.hypotheses, []);
});

test("a run: key findings hold and are ranked, hypotheses have words, KPIs carry their target, caveats name a small base", () => {
  const def = designed();
  const run = runPlan(def, synthDataset(300), { trigger: "apply", discover: true });
  const o = buildOverview(def, run);
  assert.ok(o.run && o.run.n === 300);
  assert.ok(o.keyFindings.every((k) => k.kind !== "correlation" && k.kind !== "low_base" && k.kind !== "inconclusive"));
  for (const k of o.keyFindings) {
    assert.ok(k.title.length > 0 && k.plain.length > 0 && k.evidence.includes("n = "));
    assert.ok(!/\b(causes|because|leads to|drives)\b/i.test(k.plain.replace(/not a proven cause|not a cause/g, "")), k.plain);
    assert.ok(k.why.length > 0);
  }
  const h1 = o.hypotheses.find((h) => h.label === "H1")!;
  assert.ok(h1 && h1.word.length && h1.reason.length);
  assert.equal(Object.values(o.hypothesisCounts).reduce((a, b) => a + b, 0), o.hypotheses.length);
  assert.ok(o.kpis.some((k) => k.name === "Net Promoter Score" && k.target === "40"));
  assert.ok(o.beyondThePlan && o.beyondThePlan.summary.startsWith("Beyond the plan"));
  assert.ok(o.counts.findings >= o.counts.holding);
  /* a key finding on a hypothesis says so in its why */
  const onH = o.keyFindings.find((k) => k.hypotheses.length);
  if (onH) assert.match(onH.why, /^Bears on H/);

  const small = buildOverview(def, { ...run, n: 20 });
  assert.match(small.caveats[0], /Only 20 completes/);
});

test("evidence and plain readings", () => {
  const f: Finding = { id: "f", kind: "correlation", strength: "moderate", significant: true, headline: "NPS and Age are positively correlated (r = 0.31)", evidence: { test: "pearson", statistic: 0.31, p: 0.0004, n: 300, effect: { name: "r", value: 0.31 } }, variables: ["NPS", "AGE"], hypotheses: [], analysis: { name: "t2", kind: "test", hash: "h" } };
  assert.equal(evidenceLine(f), "Pearson correlation · statistic 0.31 · p < 0.001 · r = 0.31 · n = 300");
  assert.match(plainReading(f), /move together — a moderate association; the data cannot say that one causes the other/);
  assert.match(plainReading({ ...f, kind: "difference", strength: "strong" }), /a strong difference in the data, not a cause/);
  assert.match(plainReading({ ...f, kind: "no_difference" }), /no reason to think the groups differ/);
});

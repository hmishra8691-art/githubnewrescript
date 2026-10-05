import test from "node:test";
import assert from "node:assert/strict";
import { def as base, synthDataset, spec } from "./analyses/fixture.js";
import { runAnalysis } from "./analyses/index.js";
import { plannedAnalyses } from "./planBridge.js";
import { findingsFor, hypothesisVerdicts, runPlan, briefText, compactRun, nextMilestone, strengthOf, rankFindings } from "./findings.js";

/*
 * FINDINGS: what the data said, read from the results — never from the
 * sentences; the hypotheses judged from the analyses planned for them; the
 * whole plan run once; the milestones at which it runs by itself.
 *
 * The synthetic data plants a gender effect on satisfaction, satisfaction
 * driving recommendation, and NO region effect.
 */

function planned() {
  const def = structuredClone(base);
  def.research = {
    objective: "What drives satisfaction and recommendation", population: "adults",
    hypotheses: ["Women are more satisfied than men", "Region affects satisfaction", "Satisfaction drives recommendation", "Older respondents are more satisfied", "Awareness of Gamma raises consideration of Gamma"],
    constructs: [{ name: "Satisfaction", role: "dependent", questionIds: ["q_sat"] }, { name: "Recommendation", role: "dependent", questionIds: ["q_nps"] }],
    analysis: [], assumptions: [], sources: [],
    analysisPlan: {
      crosstabs: [{ id: "x1", rows: ["SAT"], columns: ["GENDER", "REGION"], priority: 1, hypotheses: ["H1", "H2"], reason: "satisfaction by profile" }],
      tests: [
        { id: "t1", method: "t_test", outcome: "SAT", variables: [], groupBy: "GENDER", priority: 1, hypotheses: ["H1"] },
        { id: "t2", method: "anova", outcome: "SAT", variables: [], groupBy: "REGION", priority: 1, hypotheses: ["H2"] },
        { id: "t3", method: "regression", outcome: "NPS", variables: ["SAT", "AGE"], priority: 1, hypotheses: ["H3"] },
        { id: "t4", method: "correlation", outcome: "SAT", variables: ["AGE"], priority: 2, hypotheses: ["H4"] },
        { id: "t5", method: "nps", variables: ["NPS"], priority: 2, hypotheses: [] },
        { id: "t6", method: "reliability", variables: ["ITEMS"], priority: 2, hypotheses: [] },
      ],
      derived: [], segments: [],
    },
  } as never;
  return def;
}

test("findings are read from the results' tests and tables: the test, the p, the effect size, the direction — with a strength on the usual scales", () => {
  const def = planned();
  const ds = synthDataset(400);
  const items = plannedAnalyses(def, spec);
  const byId = (id: string) => items.find((i) => i.source.kind === "test" && i.source.id === id)!;
  /* the t-test: women more satisfied → a significant difference with Cohen's d */
  const t1 = byId("t1"); const r1 = runAnalysis(t1.definition, ds);
  const label = (v: string) => ds.byName.get(v)?.label ?? v;
  const f1 = findingsFor(t1.definition, r1, { hypotheses: t1.hypotheses, label });
  assert.equal(f1.length, 1);
  assert.equal(f1[0].kind, "difference"); assert.ok(f1[0].significant);
  assert.match(f1[0].headline, /^Overall satisfaction across Gender: a (strong|moderate) difference \((?:Welch's )?t-test, p < \.001, Cohen's d = /);
  assert.equal(f1[0].evidence.test, "t_welch"); assert.equal(f1[0].evidence.effect?.name, "Cohen's d"); assert.ok((f1[0].evidence.p ?? 1) < 0.001); assert.equal(f1[0].evidence.n, 400);
  assert.deepEqual(f1[0].hypotheses, ["H1"]); assert.equal(f1[0].analysis.planned, "t1");
  /* the ANOVA: no region effect */
  const t2 = byId("t2"); const f2 = findingsFor(t2.definition, runAnalysis(t2.definition, ds), { hypotheses: t2.hypotheses, label });
  assert.equal(f2[0].kind, "no_difference"); assert.equal(f2[0].strength, "none"); assert.ok(!f2[0].significant);
  assert.match(f2[0].headline, /^Overall satisfaction across Region: no significant difference \(ANOVA, p = \.\d{3}\)\.$/);
  /* the regression: satisfaction drives NPS (positive), age does not */
  const t3 = byId("t3"); const f3 = findingsFor(t3.definition, runAnalysis(t3.definition, ds), { hypotheses: t3.hypotheses, label });
  const sat = f3.find((f) => f.variables[1] === "SAT")!, age = f3.find((f) => f.variables[1] === "AGE")!;
  assert.equal(sat.kind, "driver"); assert.equal(sat.strength, "strong"); assert.equal(sat.evidence.direction, "positive");
  assert.match(sat.headline, /^Overall satisfaction raises Recommend\?: a strong effect \(β = 0\.\d+, p < \.001\)\.$/, "the coefficient's label, resolved back to its variable");
  assert.equal(age.kind, "no_driver");
  assert.ok(!f3.some((f) => /intercept/i.test(f.headline)), "the intercept is not a finding");
  /* the correlation: age × satisfaction, nothing planted */
  const t4 = byId("t4"); const f4 = findingsFor(t4.definition, runAnalysis(t4.definition, ds), { hypotheses: t4.hypotheses, label });
  assert.equal(f4.length, 1); assert.equal(f4[0].kind, "no_correlation"); assert.equal(f4[0].evidence.effect?.name, "r");
  /* NPS and reliability are headline numbers, not tests */
  const t5 = byId("t5"); const f5 = findingsFor(t5.definition, runAnalysis(t5.definition, ds), { label });
  assert.equal(f5[0].kind, "nps"); assert.match(f5[0].headline, /^NPS for Recommend\? is -?\d+ on 400 responses\.$/);
  const t6 = byId("t6"); const f6 = findingsFor(t6.definition, runAnalysis(t6.definition, ds));
  assert.equal(f6[0].kind, "reliability"); assert.match(f6[0].headline, /Cronbach's α = 0\.5\d+ — the items do not hang together well/);
  assert.equal(f6[0].strength, "none"); assert.ok(!f6[0].significant, "α of 0.5 is not a reliable scale");
  /* the crosstab: one finding per banner variable, the largest gap as detail */
  const x1 = items.find((i) => i.source.kind === "crosstab")!; const fx = findingsFor(x1.definition, runAnalysis(x1.definition, ds), { hypotheses: x1.hypotheses, label });
  assert.deepEqual(fx.map((f) => [f.kind, ...f.variables]), [["difference", "SAT", "GENDER"], ["no_difference", "SAT", "REGION"]], "one finding per banner variable, each naming its pair");
  assert.match(fx[0].headline, /^Overall satisfaction by Gender: /); assert.match(fx[1].headline, /^Overall satisfaction by Region: /);
  assert.ok(fx.some((f) => /Largest gap/.test(f.detail ?? "")), "the crosstab's largest gap travels as the detail");
  /* strength scales */
  assert.equal(strengthOf({ name: "Cramér's V", value: 0.35 }, 0.01), "moderate");
  assert.equal(strengthOf({ name: "Cohen's d", value: 0.9 }, 0.01), "strong");
  assert.equal(strengthOf({ name: "η²", value: 0.02 }, 0.01), "weak");
  assert.equal(strengthOf({ name: "η²", value: 0.08 }, 0.01), "moderate", "η² has its own, smaller thresholds");
  assert.equal(strengthOf({ name: "η²", value: 0.15 }, 0.01), "strong");
  assert.equal(strengthOf({ name: "Cohen's d", value: 0.9 }, 0.2), "none", "not significant: no strength");
  assert.equal(strengthOf(undefined, 0.01), "weak", "significant without an effect size: small until shown otherwise");
  /* ranking: significant first, then strong — a strong but non-significant headline number (a reliable scale) comes after a weak significant one */
  const ranked = rankFindings([...f2, ...f1, ...f4]);
  assert.equal(ranked[0].kind, "difference");
  const weakSig = { ...f1[0], id: "w", strength: "weak" as const };
  const strongNs = { ...f6[0], id: "s", strength: "strong" as const, significant: false };
  assert.deepEqual(rankFindings([strongNs, weakSig]).map((f) => f.id), ["w", "s"]);
  /* directions and signs, from hand-made results */
  const hand = (tables: typeof r1.tables, kind: "regression" | "correlation") => findingsFor({ name: "h", kind, dataset: spec, variables: kind === "regression" ? ["NPS", "SAT"] : ["SAT", "AGE"] }, { ...r1, tables, tests: [], insights: [], recommendedCharts: [], variablesUsed: kind === "regression" ? ["NPS", "SAT"] : ["SAT", "AGE"] }, { label });
  const neg = hand([{ id: "coef", title: "c", columns: [], rows: [{ term: "(Intercept)", estimate: 5, p: "< .001" }, { term: "Overall satisfaction", estimate: -0.5, std: -0.4, p: ".002" }] }], "regression");
  assert.equal(neg.length, 1); assert.match(neg[0].headline, /^Overall satisfaction lowers Recommend\?: a moderate effect \(β = -0\.40, p = \.002\)\.$/); assert.equal(neg[0].evidence.direction, "negative");
  const negr = hand([{ id: "corr", title: "c", columns: [], rows: [{ pair: "Overall satisfaction × Age", method: "pearson", r: -0.4, p: ".001", n: 400 }] }], "correlation");
  assert.match(negr[0].headline, /a moderate negative correlation \(r = -0\.40, p = \.001\)/); assert.equal(negr[0].evidence.direction, "negative");
});

test("a small base: findings carry the caution, and a result with nothing to say is a low-base finding", () => {
  const def = planned();
  const ds = synthDataset(20);
  const items = plannedAnalyses(def, spec);
  const t1 = items.find((i) => i.source.kind === "test" && i.source.id === "t1")!;
  const fs = findingsFor(t1.definition, runAnalysis(t1.definition, ds));
  assert.ok(fs.every((f) => /Base 20 < 30: read with caution/.test(f.detail ?? "")), fs.map((f) => f.detail).join(" | "));
  const empty = synthDataset(0);
  const fe = findingsFor(t1.definition, runAnalysis(t1.definition, empty));
  assert.equal(fe[0].kind, "inconclusive"); assert.match(fe[0].headline, /no respondents in the data yet/);
});

test("the hypotheses are judged from their planned analyses: supported, not supported, mixed, inconclusive, untested — each with its reason", () => {
  const def = planned();
  const run = runPlan(def, synthDataset(400), { trigger: "first_results", now: "2026-10-05T10:00:00Z" });
  assert.equal(run.n, 400); assert.equal(run.trigger, "first_results"); assert.equal(run.environment, "LIVE");
  assert.equal(run.items.length, 7);
  const v = Object.fromEntries(run.verdicts.map((x) => [x.label, x]));
  assert.equal(v.H1.verdict, "supported", v.H1.reason);
  assert.match(v.H1.reason, /All 2 planned tests are significant: Overall satisfaction (across|by) Gender/);
  assert.equal(v.H2.verdict, "not_supported", v.H2.reason);
  assert.match(v.H2.reason, /None of the 2 planned tests are significant/);
  assert.equal(v.H3.verdict, "mixed", v.H3.reason);
  assert.match(v.H3.reason, /1 of 2 planned tests is significant — Overall satisfaction raises Recommend\?.*but Age does not predict Recommend\?/);
  /* the crosstab's REGION banner is not evidence about H1 (gender), and its GENDER banner is not evidence about H2 (region) */
  assert.ok(!v.H1.findings.some((f) => f.variables[1] === "REGION"), v.H1.findings.map((f) => f.headline).join(" | "));
  assert.ok(v.H1.findings.some((f) => f.analysis.kind === "crosstab" && f.variables[1] === "GENDER"), "the gender banner counts: the t-test pairs the same two variables");
  assert.ok(!v.H2.findings.some((f) => f.variables[1] === "GENDER"));
  assert.ok(v.H2.findings.some((f) => f.analysis.kind === "crosstab" && f.variables[1] === "REGION"), "“Region affects satisfaction” names the region banner");
  assert.equal(v.H4.verdict, "not_supported");
  assert.equal(v.H5.verdict, "untested"); assert.match(v.H5.reason, /No analysis in the plan serves/);
  assert.equal(v.H1.analyses, 2); assert.equal(v.H5.analyses, 0);
  /* the findings, strongest first; every one traces to an analysis */
  assert.ok(run.findings.length >= 8);
  assert.ok(run.findings[0].significant && run.findings[0].strength === "strong");
  assert.ok(run.findings.every((f) => f.analysis.hash && f.evidence.n === 400));
  assert.ok(run.items.every((it) => it.chart), "every item carries the chart it is best shown as");
  /* a small base makes every hypothesis inconclusive, not false */
  const small = runPlan(def, synthDataset(20));
  assert.ok(small.verdicts.filter((x) => x.analyses > 0).every((x) => x.verdict === "inconclusive"), small.verdicts.map((x) => `${x.label} ${x.verdict}`).join(", "));
  assert.match(small.verdicts[0].reason, /Only 20 respondents so far — below the 30 needed/);
  /* a hypothesis served only by descriptives is inconclusive, and says what to add */
  const desc = structuredClone(def);
  (desc.research!.analysisPlan!.tests as { id: string; hypotheses: string[] }[]).forEach((t) => { if (t.id === "t1") t.hypotheses = []; });
  (desc.research!.analysisPlan!.crosstabs as { hypotheses: string[] }[])[0].hypotheses = ["H2"];
  (desc.research!.analysisPlan!.tests as { id: string; hypotheses: string[] }[]).push({ id: "t7", hypotheses: ["H1"], ...({ method: "top_box", outcome: "SAT", variables: [], priority: 2 } as object) } as never);
  const d = runPlan(desc, synthDataset(400)).verdicts[0];
  assert.equal(d.verdict, "inconclusive"); assert.match(d.reason, /describes the data but tests nothing/);
  /* a hypothesis served by a crosstab alone: its banner counts because the hypothesis NAMES the variable */
  const nameOnly = structuredClone(def);
  (nameOnly.research!.analysisPlan!.tests as { id: string; hypotheses: string[] }[]).forEach((t) => { if (t.id === "t2") t.hypotheses = []; });
  const h2 = runPlan(nameOnly, synthDataset(400)).verdicts[1];
  assert.equal(h2.verdict, "not_supported", h2.reason);
  assert.ok(h2.findings.some((f) => f.analysis.kind === "crosstab" && f.variables[1] === "REGION") && !h2.findings.some((f) => f.variables[1] === "GENDER"));
  /* the brief the copilot reads, and the compact form that is stored */
  const brief = briefText(run);
  assert.match(brief, /\n    \[ns\] Overall satisfaction across Region: no significant difference/, "a null result is tagged ns, not by a strength");
  assert.ok(!briefText(runPlan(def, synthDataset(0))).includes("Findings ("), "an empty run has placeholders, not findings");
  assert.match(brief, /^Analysis run \(first_results\) on 400 live completes, 2026-10-05 10:00:/);
  assert.match(brief, /  H1 SUPPORTED — Women are more satisfied than men\. All 2 planned tests/);
  assert.match(brief, /  H2 NOT SUPPORTED — Region affects satisfaction\./);
  assert.match(brief, /  H5 UNTESTED — /);
  assert.match(brief, /  Findings \(strongest first\):\n    \[strong\] /);
  assert.ok(!/inconclusive/.test(brief.split("Findings")[1] ?? ""), "inconclusive placeholders are not findings in the brief");
  const compact = compactRun(run);
  assert.ok(compact.items.every((it) => !("result" in it)) && compact.findings.length === run.findings.length);
  assert.ok(JSON.stringify(compact).length < JSON.stringify(run).length / 2, "the stored form is far smaller than the results");
});

test("the plan runs by itself at the milestones of fieldwork — once each", () => {
  assert.equal(nextMilestone([], { completes: 10, target: 400 }), null, "too few to read anything");
  assert.equal(nextMilestone([], { completes: 30, target: 400 }), "first_results");
  assert.equal(nextMilestone(["first_results"], { completes: 150, target: 400 }), null);
  assert.equal(nextMilestone(["first_results"], { completes: 200, target: 400 }), "halfway");
  assert.equal(nextMilestone(["first_results", "halfway"], { completes: 399, target: 400 }), null);
  assert.equal(nextMilestone(["first_results", "halfway"], { completes: 400, target: 400 }), "target_reached");
  assert.equal(nextMilestone(["first_results", "halfway", "target_reached"], { completes: 450, target: 400 }), null);
  assert.equal(nextMilestone([], { completes: 500, target: 400 }), "first_results", "a late start still takes the milestones in order, one per pass");
  assert.equal(nextMilestone(["first_results"], { completes: 80, target: null, fieldEnd: "2026-10-01T00:00:00Z", now: "2026-10-05T00:00:00Z" }), "field_end");
  assert.equal(nextMilestone(["first_results"], { completes: 80, target: null, fieldEnd: "2026-10-09T00:00:00Z", now: "2026-10-05T00:00:00Z" }), null, "the field is still open");
  assert.equal(nextMilestone([], { completes: 12, fieldEnd: "2026-10-01T00:00:00Z", now: "2026-10-05T00:00:00Z" }), null, "the field ended with too few to read");
  assert.equal(nextMilestone(["first_results"], { completes: 30, target: 50 }), "halfway");
});

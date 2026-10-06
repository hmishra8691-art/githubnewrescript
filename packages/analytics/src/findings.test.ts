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

/* ------------------------------------------------------------ Phase 6: direction */

import { hypothesisDirection, matchGroup } from "./findings.js";
import type { RunItem, Finding } from "./findings.js";

test("hypothesisDirection — the direction a hypothesis states, from its words", () => {
  const d = (t: string) => hypothesisDirection(t);
  assert.deepEqual(d("Brand trust increases purchase intention"), { kind: "positive" });
  assert.deepEqual(d("Satisfaction drives recommendation"), { kind: "positive" });
  assert.deepEqual(d("Advertising exposure raises awareness"), { kind: "positive" });
  assert.deepEqual(d("Ad exposure leads to higher awareness"), { kind: "positive" });
  assert.deepEqual(d("Heavy users are more likely to buy"), { kind: "positive" });
  assert.deepEqual(d("Price sensitivity reduces purchase intent"), { kind: "negative" });
  assert.deepEqual(d("Long surveys make respondents less likely to finish"), { kind: "negative" });
  assert.deepEqual(d("Lower prices increase purchase intent"), { kind: "negative" }, "the low end as the subject turns the verb round");
  assert.deepEqual(d("Higher prices lower purchase intent"), { kind: "negative" }, "“lower” is the verb here, “higher” the subject");
  assert.deepEqual(d("Older respondents are more satisfied"), { kind: "positive" });
  assert.deepEqual(d("Younger respondents are less satisfied"), { kind: "positive" }, "less satisfied when younger: satisfaction rises with age");
  assert.deepEqual(d("Women are more satisfied than men"), { kind: "group_higher", group: "women", lower: "men" });
  assert.deepEqual(d("Men are less likely to recommend than women"), { kind: "group_higher", group: "women", lower: "men" });
  assert.deepEqual(d("Customers in the North score higher than those in the South."), { kind: "group_higher", group: "customers in the north", lower: "in the south" });
  assert.deepEqual(d("Region affects satisfaction"), { kind: "difference" });
  assert.deepEqual(d("Satisfaction differs by region"), { kind: "difference" });
  assert.deepEqual(d("Price perception moderates the effect of trust on purchase intention"), { kind: "difference" });
  assert.deepEqual(d("Our respondents live in cities"), { kind: "none" });
  /* the group words resolve against the grouping variable's labels, stemmed, with the usual synonyms */
  assert.equal(matchGroup("women", ["Male", "Female"]), 1);
  assert.equal(matchGroup("men", ["Male", "Female"]), 0);
  assert.equal(matchGroup("customers in the north", ["North", "South", "East"]), 0);
  assert.equal(matchGroup("Northerners", ["North", "South"]), -1, "a word the labels do not have is not guessed");
});

/** the planted data with a hypothesis list of our own, every test tagged as written */
function directional(hypotheses: string[], tests: { id: string; method: string; outcome: string; groupBy?: string; variables?: string[]; h: string }[]) {
  const def = structuredClone(base);
  def.research = { objective: "direction", population: "adults", hypotheses, constructs: [], analysis: [], assumptions: [], sources: [],
    analysisPlan: { crosstabs: [], derived: [], segments: [], tests: tests.map((t) => ({ id: t.id, method: t.method, outcome: t.outcome, variables: t.variables ?? [], ...(t.groupBy ? { groupBy: t.groupBy } : {}), priority: 1, hypotheses: [t.h] })) } } as never;
  return runPlan(def, synthDataset(400));
}

test("verdicts read the direction: a significant effect the other way is evidence AGAINST — for a coefficient's sign and for which group is higher", () => {
  const run = directional(
    ["Satisfaction increases recommendation", "Satisfaction reduces recommendation", "Women are more satisfied than men", "Men are more satisfied than women", "Men are less satisfied than women", "Region affects satisfaction"],
    [
      { id: "a", method: "regression", outcome: "NPS", variables: ["SAT"], h: "H1" },
      { id: "b", method: "regression", outcome: "NPS", variables: ["SAT"], h: "H2" },
      { id: "c", method: "t_test", outcome: "SAT", groupBy: "GENDER", h: "H3" },
      { id: "d", method: "t_test", outcome: "SAT", groupBy: "GENDER", h: "H4" },
      { id: "e", method: "t_test", outcome: "SAT", groupBy: "GENDER", h: "H5" },
      { id: "f", method: "anova", outcome: "SAT", groupBy: "REGION", h: "H6" },
    ],
  );
  const v = Object.fromEntries(run.verdicts.map((x) => [x.label, x]));
  assert.equal(v.H1.verdict, "supported", v.H1.reason);
  assert.match(v.H1.reason, /— in the direction the hypothesis states$/);
  assert.deepEqual([v.H1.direction?.kind, v.H1.direction?.agreeing, v.H1.direction?.contradicting], ["positive", 1, 0]);
  assert.equal(v.H2.verdict, "not_supported", "a significant POSITIVE β does not support “reduces”");
  assert.match(v.H2.reason, /^The planned test is significant, but in the opposite direction \(β = 0\.\d\d\): Overall satisfaction raises Recommend\?/);
  assert.equal(v.H2.direction?.contradicting, 1);
  assert.equal(v.H3.verdict, "supported", v.H3.reason);
  assert.equal(v.H4.verdict, "not_supported", v.H4.reason);
  assert.match(v.H4.reason, /significant, but in the opposite direction \(Female 3\.\d\d vs Male 3\.\d\d\)/);
  assert.equal(v.H5.verdict, "supported", "“men are LESS satisfied than women” is the same direction as H3");
  assert.equal(v.H6.direction?.kind, "difference");
  assert.ok(run.findings.some((f) => f.evidence.groups?.length === 2), "a comparison of means carries each group's mean");
});

test("verdicts — mixed when significant evidence points both ways; a control variable's sign is not the hypothesis's; an unread direction is said", () => {
  const def = structuredClone(base);
  def.research = { objective: "x", population: "adults", hypotheses: ["Satisfaction increases recommendation", "Women are more satisfied than men"], constructs: [], analysis: [], assumptions: [], sources: [] } as never;
  const result = { base: { n: 400 } } as RunItem["result"];
  const finding = (o: Partial<Finding> & { variables: string[] }, ev: Partial<Finding["evidence"]>): Finding => ({ id: Math.random().toString(36), kind: "driver", strength: "moderate", significant: true, headline: `${o.variables.join(" ~ ")}`, analysis: { name: "m", kind: "regression", hash: "h" }, hypotheses: ["H1"], ...o, evidence: { n: 400, p: 0.001, ...ev } });
  const item = (h: string, vars: string[], fs: Finding[], kind = "regression"): RunItem => ({ definition: { name: "m", kind: kind as never, dataset: spec, variables: vars }, result, findings: fs, hypotheses: [h] });
  const pos = finding({ variables: ["NPS", "SAT"] }, { direction: "positive", effect: { name: "standardized β", value: 0.4 } });
  const neg = finding({ variables: ["NPS", "SAT"] }, { direction: "negative", effect: { name: "standardized β", value: -0.42 } });
  /* one model agrees, another (a different wave's) disagrees → mixed, and the reason quotes the opposite β */
  const mixed = hypothesisVerdicts(def, [item("H1", ["NPS", "SAT"], [pos]), item("H1", ["NPS", "SAT"], [neg])])[0];
  assert.equal(mixed.verdict, "mixed");
  assert.match(mixed.reason, /^1 of 2 planned tests support it — NPS ~ SAT — but one is significant, but in the opposite direction \(β = -0\.42\)/);
  /* a negative control variable in the same model is not evidence against “satisfaction increases …” */
  const control = finding({ variables: ["NPS", "AGE"] }, { direction: "negative", effect: { name: "standardized β", value: -0.3 } });
  const withControl = hypothesisVerdicts(def, [item("H1", ["NPS", "SAT", "AGE"], [pos, control])])[0];
  assert.equal(withControl.verdict, "supported", withControl.reason);
  assert.equal(withControl.direction?.unread, 1);
  /* a group hypothesis served by a crosstab only: significant, direction not readable → supported, and said */
  const xt = finding({ kind: "difference", variables: ["SAT", "GENDER"], hypotheses: ["H2"] }, { test: "chi_square" });
  const unread = hypothesisVerdicts(def, [item("H2", ["SAT", "GENDER"], [xt], "crosstab")])[1];
  assert.equal(unread.verdict, "supported");
  assert.match(unread.reason, /\(the direction could not be read from these results\)$/);
});

/* ------------------------------------------------------------ mutation-checked edges (Phase 6) */

test("hypothesisDirection / matchGroup — edges: the first verb decides; any “-er … than” compares groups; a phrase that names two groups names none; plurals are stemmed", () => {
  assert.deepEqual(hypothesisDirection("Delays reduce satisfaction and increase complaints"), { kind: "negative" }, "the first verb decides");
  assert.deepEqual(hypothesisDirection("Women are happier than men"), { kind: "group_higher", group: "women", lower: "men" });
  assert.equal(matchGroup("north and south", ["North", "South"]), -1, "two groups named equally: none is chosen");
  assert.equal(matchGroup("students", ["Student", "Worker"]), 0, "“students” is the “Student” group");
});

test("verdicts — edges: a group that is not the highest contradicts “higher than the others”; a group the labels do not have is unread; an interaction's sign is not the hypothesis's; agreeing counts only the read ones", () => {
  const def = structuredClone(base);
  def.research = { objective: "x", population: "adults", hypotheses: ["Customers in the North score higher than the others", "Women are more satisfied than men", "Engagement increases loyalty"], constructs: [], analysis: [], assumptions: [], sources: [] } as never;
  const result = { base: { n: 400 } } as RunItem["result"];
  const finding = (o: Partial<Finding> & { variables: string[] }, ev: Partial<Finding["evidence"]>): Finding => ({ id: Math.random().toString(36), kind: "difference", strength: "moderate", significant: true, headline: o.variables.join(" ~ "), analysis: { name: "m", kind: "test", hash: "h" }, hypotheses: [], ...o, evidence: { n: 400, p: 0.001, ...ev } });
  const item = (h: string, vars: string[], fs: Finding[], kind = "test"): RunItem => ({ definition: { name: "m", kind: kind as never, dataset: spec, variables: vars }, result, findings: fs, hypotheses: [h] });
  /* North is said to be higher than the others: South is higher → against */
  const regions = finding({ variables: ["SAT", "REGION"] }, { test: "anova", groups: [{ label: "North", mean: 3.0, n: 130 }, { label: "South", mean: 3.5, n: 130 }, { label: "East", mean: 2.0, n: 140 }] });
  const v1 = hypothesisVerdicts(def, [item("H1", ["SAT", "REGION"], [regions])])[0];
  assert.equal(v1.verdict, "not_supported", v1.reason);
  assert.match(v1.reason, /opposite direction \(South 3\.50 vs East 2\.00\)/);
  /* … and when North IS the highest, it agrees */
  const top = finding({ variables: ["SAT", "REGION"] }, { test: "anova", groups: [{ label: "North", mean: 3.9, n: 130 }, { label: "South", mean: 3.5, n: 130 }, { label: "East", mean: 2.0, n: 140 }] });
  assert.equal(hypothesisVerdicts(def, [item("H1", ["SAT", "REGION"], [top])])[0].verdict, "supported");
  /* the test's groups are not women and men: the direction cannot be read */
  const ab = finding({ variables: ["SAT", "ARM"] }, { test: "t_independent", groups: [{ label: "Group A", mean: 3.0, n: 200 }, { label: "Group B", mean: 3.6, n: 200 }] });
  const v2 = hypothesisVerdicts(def, [item("H2", ["SAT", "ARM"], [ab])])[1];
  assert.equal(v2.verdict, "supported");
  assert.match(v2.reason, /\(the direction could not be read from these results\)$/);
  assert.deepEqual([v2.direction?.agreeing, v2.direction?.unread], [0, 1], "an unread finding is not counted as agreeing");
  /* a moderation model: the main effect agrees; the interaction's negative sign is not evidence against */
  const main = finding({ kind: "driver", variables: ["NPS", "SAT"] }, { direction: "positive", effect: { name: "standardized β", value: 0.4 } });
  const inter = finding({ kind: "driver", variables: ["NPS", "SAT × PRICE"] }, { direction: "negative", effect: { name: "standardized β", value: -0.2 } });
  const v3 = hypothesisVerdicts(def, [item("H3", ["NPS", "SAT", "PRICE"], [main, inter], "regression")])[2];
  assert.equal(v3.verdict, "supported", v3.reason);
  assert.deepEqual([v3.direction?.agreeing, v3.direction?.contradicting, v3.direction?.unread], [1, 0, 1]);
});

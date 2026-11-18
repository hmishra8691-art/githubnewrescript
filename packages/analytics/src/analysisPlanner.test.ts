import test from "node:test";
import assert from "node:assert/strict";
import { variableMetadata } from "./dataset.js";
import { runAnalysis } from "./analyses/index.js";
import { proposeFromText, parseAskOps, validateAskOp, definitionFor, type AskContext, type AskOp } from "./analyticsIntent.js";
import { definitionFromSpec, parseSpec } from "./analysisPlanner.js";
import { kdef, kds } from "./analyses/knownFixture.js";
import type { AnalysisDefinition } from "./types.js";

/*
 * Requests in words → one planned analysis → run on the known 12-respondent survey (analyses/knownFixture.ts), and
 * every number checked against a count done by hand from the raw answers listed in that file.
 */
const spec = { environment: "LIVE" as const, dataset: "all" as const };
const vars = variableMetadata(kdef);
const ctx = (analyses: AskContext["analyses"] = [], focus?: string): AskContext => ({ variables: vars, known: new Set(vars.map((v) => v.name)), dataset: spec, analyses, reports: [], ...(focus ? { focus: { analysisId: focus } } : {}) });
const planned = (text: string, c = ctx()) => {
  const p = proposeFromText(text, c);
  const it = p.items.find((i) => i.op.op === "add_analysis" || i.op.op === "update_analysis");
  return { p, it, op: it?.op as Extract<AskOp, { op: "add_analysis" | "update_analysis" }> | undefined };
};
const run = (op: Extract<AskOp, { op: "add_analysis" | "update_analysis" }>) => runAnalysis(definitionFor(op, spec, "test")!, kds());
const row = (t: { rows: Record<string, unknown>[] }, group: string) => t.rows.find((r) => r.group === group)!;

test("“NPS from Q15 across Gender and Age Groups at 95%”: one item, derived bands, hand-counted NPS per group, small bases not tested", () => {
  const { p, it, op } = planned("Calculate NPS from Q15 and compare it across Gender and Age Groups at 95% confidence");
  assert.equal(p.items.length, 1); assert.deepEqual(p.unread, []);
  assert.ok(op && op.op === "add_analysis");
  assert.equal(op.spec.kind, "nps"); assert.deepEqual(op.spec.target, ["NPS"]); assert.equal(op.spec.confidence, 0.95);
  assert.equal(op.spec.by[0], "GENDER"); assert.match(op.spec.by[1]!, /^_L_group_numeric_AGE_/);
  assert.deepEqual(it!.blocked, []);
  assert.match(it!.why, /1 · Understood[\s\S]*8 · Output/); assert.match(it!.why, /Assumed: Age was grouped/);
  const r = run(op);
  assert.equal(r.error, undefined);
  /* males 10,9,6,3,8,7 → 2 promoters, 2 detractors of 6 = 0; females 10,9,10,5,8 → 3 and 1 of 5 = 40; all 11 → 5−3 = 18.2 */
  const g = r.tables.find((t) => t.id === "by_GENDER")!;
  assert.equal(row(g, "Male").n, 6); assert.equal(row(g, "Male").nps, 0);
  assert.equal(row(g, "Female").n, 5); assert.equal(row(g, "Female").nps, 40);
  assert.equal(r.tables.find((t) => t.id === "nps")!.rows.find((x) => x.m === "NPS")!.v, 18.2);
  assert.ok(g.rows.every((x) => x.sig === "n<30"), "every group is under 30: shown, never tested");
  /* ages 19,23 | 31,28 | 36,40.5 | 45,52 | 61 | 70 with an NPS; 17 is below every band and reported, the missing age is missing */
  const a = r.tables.find((t) => t.id === `by_${op.spec.by[1]}`)!;
  assert.deepEqual(a.rows.map((x) => [x.group, x.n, x.nps]), [["18–24", 2, 100], ["25–34", 2, 0], ["35–44", 2, 50], ["45–54", 2, 0], ["55–64", 1, -100], ["65+", 1, 0]]);
  const band = r.layer!.reports.find((x) => x.name === op.spec.by[1])!;
  assert.equal(band.populated, 10); assert.deepEqual(band.invalid, [{ value: "17", n: 1 }]);
  assert.ok(r.warnings.some((w) => /fewer than two groups have 30\+ respondents/.test(w)));
});

test("top-2 box with “exclude don't know”: Don't know leaves the base, the box share is the hand count", () => {
  const { op, p } = planned("Top 2 box of Q12 by gender, exclude don't know");
  assert.deepEqual(p.unread, []);
  assert.ok(op && op.spec.kind === "crosstab");
  assert.deepEqual(op.spec.filters.map((f) => [f.variable, f.drop]), [["SAT", ["9"]]]);
  const r = run(op);
  const t = r.tables[0]!;
  /* male SAT 5,4,2,1,3 (9 dropped) → 2 of 5 = 40%; female 5,5,4,2 (9 dropped, one missing) → 3 of 4 = 75% */
  const box = t.rows.find((x) => typeof x.row === "string" && /^Top 2 box/.test(x.row as string))!;
  assert.ok(box, JSON.stringify(t.rows.map((x) => x.row)));
  assert.equal(box["1"], 40); assert.equal(box["2"], 75);
  assert.ok(!t.rows.some((x) => x.row === "Don't know" && Number(x.__total__n) > 0), "Don't know is not in the table's base");
});

test("“among respondents aware of Alpha” is a filter, not a grouping; the NPS is the hand count for those respondents", () => {
  const { op } = planned("NPS among respondents aware of Alpha");
  assert.ok(op);
  assert.deepEqual(op.spec.by, []);
  assert.equal(op.spec.filters.length, 1); assert.deepEqual(op.spec.filters[0]!.keep, ["1"]);
  /* aware of Alpha: rows 0,1,4,6,7,10 → NPS 10,9,8,10,9 (row 10 has none) → 4 promoters, 0 detractors of 5 = 80 */
  const r = run(op);
  const t = r.tables.find((x) => x.id === "nps")!;
  assert.equal(t.rows.find((x) => x.m === "NPS")!.v, 80);
  assert.equal(t.rows.find((x) => x.m === "n")!.v, 5);
});

test("a multi-choice target across three banner questions by code, at 90%", () => {
  const { op } = planned("Show brand awareness Q1 across Q5, Q6 and Q7 at 90% confidence");
  assert.ok(op && op.spec.kind === "crosstab");
  assert.equal(op.spec.confidence, 0.9);
  assert.equal(op.spec.by.length, 3); assert.match(op.spec.by[0]!, /^_L_group_numeric_AGE_/); assert.deepEqual(op.spec.by.slice(1), ["GENDER", "REGION"]);
  const d = definitionFor(op, spec, "x")!;
  assert.equal((d.options as Record<string, unknown>).alpha, 0.1);
  assert.equal(run(op).error, undefined);
});

test("what the survey does not say is asked, never guessed", () => {
  assert.match(planned("CSAT of Q12 by region and income groups").p.unread.join(" "), /“income groups” matches no question/);
  assert.match(planned("Top 2 box of satisfaction").p.unread.join(" "), /across what/);
  const age = planned("NPS by age at 95%").op!;
  assert.match(age.spec.by[0]!, /^_L_group_numeric_AGE_/, "age alone is banded with the stated default");
  const custom = planned("NPS by age groups under 30, 30-49, 50+ at 95%").op!;
  const bins = custom.spec.layer.find((l) => l.kind === "group_numeric") as { bins: { label: string }[] };
  assert.deepEqual(bins.bins.map((b) => b.label), ["Under 30", "30–49", "50+"]);
});

test("follow-ups change the open analysis in place, reusing its derived variables", () => {
  const first = planned("Calculate NPS from Q15 by gender at 95%").op!;
  const saved = { id: "a1", name: first.name, definition: definitionFor(first, spec, "x") as AnalysisDefinition };
  const c = ctx([saved], "a1");
  const byRegion = planned("now by region", c).op!;
  assert.equal(byRegion.op, "update_analysis"); assert.equal((byRegion as { analysisId: string }).analysisId, "a1");
  assert.deepEqual(byRegion.spec.by, ["GENDER", "REGION"]);
  assert.equal(byRegion.spec.layer.filter((l) => l.kind === "nps_class").length, 1, "the NPS classification is not made twice");
  const sig = planned("add significance testing at 99%", c).op!;
  assert.equal(sig.spec.confidence, 0.99);
  const chart = planned("change it to a horizontal bar", c).op!;
  assert.equal(chart.spec.chart, "bar_horizontal");
  assert.match(planned("change it to a 100% stacked bar", c).p.unread.join(" "), /already shown as bar stacked 100/);
  assert.match(planned("exclude don't know", c).p.unread.join(" "), /no “Don't know”-type answer/, "NPS has none: said, nothing changed");
  /* a cross-tab with a Don't know answer: the follow-up drops it from the base */
  const xt = planned("Overall satisfaction Q12 by gender at 95%").op!;
  const c2 = ctx([{ id: "x1", name: xt.name, definition: definitionFor(xt, spec, "x") as AnalysisDefinition }], "x1");
  const dk = planned("exclude don't know", c2).op!;
  assert.deepEqual(dk.spec.filters.map((f) => [f.variable, f.drop]), [["SAT", ["9"]]]);
  assert.equal(runAnalysis(definitionFor(dk, spec, "x")!, kds()).tables[0]!.rows.filter((r) => r.row === "Don't know" && Number(r.__total__n) > 0).length, 0);
  const unclear = planned("now make it nicer", c);
  assert.equal(unclear.p.items.length, 0); assert.match(unclear.p.unread.join(" "), /could not tell what to change/);
  assert.deepEqual(validateAskOp(byRegion, c).blocked, []);
  assert.match(validateAskOp({ ...byRegion, analysisId: "gone" } as AskOp, c).blocked.join(" "), /no longer exists/);
});

test("asking for the same analysis twice is refused as a duplicate; the derived-variable names are stable", () => {
  const a = planned("Calculate NPS from Q15 across gender and age groups at 95%").op!;
  const b = planned("Calculate NPS from Q15 across gender and age groups at 95%").op!;
  assert.deepEqual(a.spec.by, b.spec.by);
  const saved = { id: "a1", name: a.name, definition: definitionFor(a, spec, "x") as AnalysisDefinition };
  assert.match(validateAskOp(b, ctx([saved])).blocked.join(" "), /already have/);
});

test("the browser's copy is rebuilt field by field; unknown sources and bad shapes are refused", () => {
  const op = planned("Calculate NPS from Q15 by gender at 95%").op!;
  const back = parseAskOps([JSON.parse(JSON.stringify(op))]);
  assert.deepEqual(back.rejected, []);
  assert.deepEqual((back.ops[0] as typeof op).spec.layer, op.spec.layer);
  assert.equal(parseSpec({ kind: "regression", target: ["NPS"] }, () => true), null);
  assert.equal(parseSpec({ kind: "nps", target: ["NPS"], confidence: 0.42 }, () => true)!.confidence, null);
  assert.equal(parseSpec({ kind: "nps", target: ["NPS"], layer: [{ kind: "sql", from: ["NPS"] }] }, () => true)!.layer.length, 0);
  assert.equal(parseAskOps([{ op: "update_analysis", name: "x", spec: op.spec }]).rejected.length, 1, "an update must name its analysis");
  const forged = { ...op, spec: { ...op.spec, layer: [...op.spec.layer, { label: "x", kind: "flag", from: ["NOPE"], codes: ["1"] }] } } as AskOp;
  assert.match(validateAskOp(forged, ctx()).blocked.join(" "), /NOPE is not in this survey/);
  assert.equal(definitionFromSpec(op.spec, "n", spec, "r").kind, "nps");
});

test("requests the planner does not need still go to the existing readings", () => {
  const p = proposeFromText("crosstab of satisfaction by gender", ctx());
  assert.ok(p.items.some((i) => i.op.op === "add_crosstab"));
  assert.ok(!p.items.some((i) => i.op.op === "add_analysis"));
});

test("the model path restates, the planner decides: plan_analysis becomes the same checked item; a bad restatement is dropped with the reason (audit P2-01)", async () => {
  const { itemsFromModel } = await import("./analyticsIntent.js");
  const r = itemsFromModel({ ops: [
    { op: "plan_analysis", request: "Calculate NPS from Q15 across GENDER at 95% confidence", why: "loyalty by sex" },
    { op: "plan_analysis", request: "NPS of Q15 by income groups", why: "x" },
    { op: "plan_analysis", request: "", why: "empty" },
  ] }, ctx());
  assert.equal(r.items.length, 1);
  const op = r.items[0]!.op as Extract<AskOp, { op: "add_analysis" }>;
  assert.equal(op.op, "add_analysis"); assert.deepEqual(op.spec.by, ["GENDER"]); assert.equal(op.spec.confidence, 0.95);
  assert.match(r.items[0]!.why, /The model read the request as: “Calculate NPS from Q15 across GENDER/);
  assert.deepEqual(r.items[0]!.blocked, []);
  assert.equal(r.rejected.length, 2);
  assert.match(r.rejected[0]!, /needs an answer: .*income groups/);
});

import { test } from "node:test";
import assert from "node:assert/strict";
import { buildDataset, variableMetadata } from "./dataset.js";
import { runAnalysis } from "./analyses/index.js";
import { findVariables, proposeFromText, redundantAnalyses, validateAskOp, itemsFromModel, parseAskOps, parseUndo, type AskContext, type AskOp } from "./analyticsIntent.js";
import type { AnalysisDefinition, AnalysisResult, ReportDefinition } from "./types.js";
import { def, synthRows } from "./analyses/fixture.js";

const spec = { environment: "LIVE" as const, dataset: "all" as const };
const ds = buildDataset(def, synthRows(), { spec });
const vars = variableMetadata(def);
const names = new Set(vars.map((v) => v.name));
let n = 0;
const saved = (name: string, kind: AnalysisDefinition["kind"], variables: string[], extra: Partial<AnalysisDefinition> = {}) => {
  const definition = { name, kind, dataset: spec, variables, ...extra } as AnalysisDefinition;
  return { id: `a${++n}`, name, definition, result: runAnalysis(definition, ds) as AnalysisResult };
};
const ctx = (analyses: ReturnType<typeof saved>[] = [], reports: AskContext["reports"] = []): AskContext => ({
  variables: vars, known: names, dataset: spec, analyses, reports,
  results: Object.fromEntries(analyses.map((a) => [a.id, a.result])),
});
const op = <T extends AskOp["op"]>(p: ReturnType<typeof proposeFromText>, kind: T) => p.items.filter((i) => i.op.op === kind).map((i) => i.op as Extract<AskOp, { op: T }>);

test("findVariables reads a variable by its code or by the words of its label, never an option-flag column", () => {
  const f = (t: string) => findVariables(t, vars).found.map((v) => v.name);
  assert.deepEqual(f("satisfaction"), ["SAT"]);
  assert.deepEqual(f("how satisfied were they"), ["SAT"]);
  assert.deepEqual(f("NPS"), ["NPS"]);
  assert.deepEqual(f("brands considered"), ["CONSIDER"], "the parent question, not Alpha/Beta/Gamma flags, and not the sibling 'aware' question");
  assert.deepEqual(f("Alpha"), [], "an option flag column is not a question");
  assert.deepEqual(findVariables("Alpha", vars).ambiguous, [], "and it is not even offered as a choice between two");
  assert.deepEqual(f("age and gender").sort(), ["AGE", "GENDER"]);
  assert.deepEqual(f("_status"), [], "system variables are not offered unless a person has them in the survey");
});

test("two questions that fit the same words are an ambiguity, never a guess", () => {
  const r = findVariables("brands", vars);
  assert.equal(r.found.length, 0);
  assert.equal(r.ambiguous.length, 1);
  assert.deepEqual(r.ambiguous[0].options.map((o) => o.name).sort(), ["AWARE", "CONSIDER"]);
});

test("'satisfaction by age and gender' proposes one cross-tab per banner variable, with the reason", () => {
  const p = proposeFromText("Create cross-tabs of satisfaction by age and gender", ctx());
  const x = op(p, "add_crosstab");
  assert.equal(x.length, 2);
  assert.deepEqual(x.map((o) => o.columns[0]).sort(), ["AGE", "GENDER"]);
  assert.ok(x.every((o) => o.rows.join() === "SAT"));
  assert.ok(p.items.every((i) => !i.blocked.length && i.why && i.effect === "creates an analysis"));
  assert.ok(p.notes.some((t) => /one cross-tab was proposed for each/.test(t)));
  assert.equal(p.unread.length, 0);
});

test("a question that is not in the survey is reported, and nothing is invented for it", () => {
  const p = proposeFromText("cross-tab of loyalty by gender", ctx());
  assert.equal(p.items.length, 0);
  assert.equal(p.unread.length, 1);
  assert.match(p.unread[0], /could not find a question on the left/);
});

test("an ambiguous name asks which one", () => {
  const p = proposeFromText("brands by gender", ctx());
  assert.equal(p.items.length, 0);
  assert.match(p.unread.join(" "), /could mean/);
  assert.match(p.unread.join(" "), /AWARE/); assert.match(p.unread.join(" "), /CONSIDER/);
});

test("a proposal that repeats a saved analysis is blocked, not silently dropped", () => {
  const have = saved("Satisfaction by gender", "crosstab", [], { rows: ["SAT"], columns: ["GENDER"], measure: "pct_col", options: { layout: "separate", significance: true } });
  const p = proposeFromText("crosstab satisfaction by gender", ctx([have]));
  assert.equal(p.items.length, 1);
  assert.match(p.items[0].blocked.join(" "), /already have “Satisfaction by gender”/);
});

test("significance tests: 'does satisfaction differ by gender' → one test; the cross-tab that already carries it blocks a repeat", () => {
  const p = proposeFromText("test whether satisfaction differs by gender", ctx());
  const t = op(p, "add_test");
  assert.deepEqual(t.map((o) => [o.outcome, o.groupBy]), [["SAT", "GENDER"]]);
  const withX = saved("SAT x GENDER", "crosstab", [], { rows: ["SAT"], columns: ["GENDER"], measure: "pct_col", options: { layout: "separate", significance: true } });
  const q = proposeFromText("test whether satisfaction differs by gender", ctx([withX]));
  assert.ok(q.items[0].blocked.length, "the chi-square is already in the cross-tab");
});

test("'remove redundant analyses' finds exact repeats and tests a cross-tab already carries, keeping the researcher's own", () => {
  const mine = saved("My satisfaction", "descriptive", ["SAT"]);
  const gen = saved("Generated satisfaction", "descriptive", ["SAT"], { options: { planned: "p1" } });
  const x = saved("SAT x GENDER", "crosstab", [], { rows: ["SAT"], columns: ["GENDER"], measure: "pct_col" });
  const t = saved("SAT gap", "test", ["SAT", "GENDER"], { options: { test: "auto" } });
  const other = saved("Region", "descriptive", ["REGION"]);
  const r = redundantAnalyses([gen, mine, x, t, other]);
  assert.deepEqual(r.map((d) => d.id).sort(), [gen.id, t.id].sort());
  assert.equal(r.find((d) => d.id === gen.id)!.keptId, mine.id);
  const p = proposeFromText("Remove the redundant analyses", ctx([gen, mine, x, t, other]));
  assert.equal(op(p, "remove_analysis").length, 2);
  assert.ok(p.items.every((i) => i.effect === "removes an analysis" && /Kept:/.test(i.why)));
});

test("an analysis a report uses cannot be removed from the proposal, and nothing is redundant when nothing repeats", () => {
  const a = saved("Satisfaction", "descriptive", ["SAT"]); const b = saved("Satisfaction (2)", "descriptive", ["SAT"]);
  const rep: ReportDefinition = { title: "R", blocks: [{ id: "b1", type: "chart", analysisId: b.id, chart: { type: "bar_vertical", options: {} } }] } as never;
  const p = proposeFromText("remove duplicate analyses", ctx([a, b], [{ id: "r1", name: "Quarterly", definition: rep }]));
  const removed = p.items[0].op as Extract<AskOp, { op: "remove_analysis" }>;
  assert.equal(removed.analysisId, b.id);
  assert.match(p.items[0].blocked.join(" "), /used by “Quarterly”/);
  const none = proposeFromText("remove redundant analyses", ctx([a, saved("Region", "descriptive", ["REGION"])]));
  assert.equal(none.items.length, 0);
  assert.match(none.notes.join(" "), /No redundant analyses were found/);
});

test("'choose the best chart for each question' changes only the charts that misfit, and says why", () => {
  const multi = saved("Brands considered", "descriptive", ["CONSIDER"]);
  const sat = saved("Satisfaction", "descriptive", ["SAT"]);
  const rep: ReportDefinition = { title: "R", blocks: [
    { id: "pie", type: "chart", title: "Brands considered", analysisId: multi.id, chart: { type: "pie", options: {} } },
    { id: "ok", type: "chart", title: "Satisfaction", analysisId: sat.id, chart: { type: "bar_vertical", options: {} } },
  ] } as never;
  const p = proposeFromText("choose the best chart for each question", ctx([multi, sat], [{ id: "r1", name: "R", definition: rep }]));
  const ch = op(p, "set_chart");
  assert.deepEqual(ch.map((c) => [c.blockId, c.from]), [["pie", "pie"]]);
  assert.equal(ch[0].chart, "bar_horizontal");
  assert.match(p.items[0].why, /implies the answers add up to 100%/);
  assert.equal(p.items[0].blocked.length, 0);
});

test("a chart that cannot draw the result is blocked when applied, whatever the proposal said", () => {
  const sat = saved("Satisfaction", "descriptive", ["SAT"]);
  const rep: ReportDefinition = { title: "R", blocks: [{ id: "b", type: "chart", analysisId: sat.id, chart: { type: "bar_vertical", options: {} } }] } as never;
  const c = ctx([sat], [{ id: "r1", name: "R", definition: rep }]);
  const bad = validateAskOp({ op: "set_chart", name: "x", reportId: "r1", blockId: "b", analysisId: sat.id, chart: "heatmap" }, c);
  assert.ok(bad.blocked.length || bad.warnings.length);
  const gone = validateAskOp({ op: "set_chart", name: "x", reportId: "r1", blockId: "missing", analysisId: sat.id, chart: "bar_vertical" }, c);
  assert.match(gone.blocked.join(" "), /no longer in the report/);
});

test("reports: management summary → executive/concise; animated → story; video is declined honestly; no analyses → blocked", () => {
  const a = saved("Satisfaction", "descriptive", ["SAT"]);
  const m = proposeFromText("Prepare a management summary", ctx([a]));
  const b = op(m, "build_report")[0];
  assert.equal(b.brief.audience, "executive"); assert.equal(b.brief.tone, "concise"); assert.equal(b.story, false);
  const s = proposeFromText("make an animated video report of the key findings", ctx([a]));
  assert.equal(op(s, "build_report")[0].story, true);
  assert.match(s.notes.join(" "), /MP4\) cannot be generated/);
  const empty = proposeFromText("build a management summary", ctx());
  assert.match(empty.items[0].blocked.join(" "), /no saved analyses/);
});

test("several clauses in one request each become their own items, and what is not understood is said", () => {
  const p = proposeFromText("Add a cross-tab of satisfaction by region, remove redundant analyses and then do my taxes", ctx([saved("a", "descriptive", ["SAT"]), saved("b", "descriptive", ["SAT"])]));
  assert.equal(op(p, "add_crosstab").length, 1);
  assert.equal(op(p, "remove_analysis").length, 1);
  assert.equal(p.unread.length, 1);
  assert.match(p.unread[0], /do my taxes/);
});

test("the same operation asked twice is one item", () => {
  const p = proposeFromText("satisfaction by gender. cross-tab satisfaction by gender", ctx());
  assert.equal(op(p, "add_crosstab").length, 1);
});

test("an empty request says what to do", () => {
  const p = proposeFromText("   ", ctx());
  assert.equal(p.items.length, 0); assert.equal(p.unread.length, 1);
});

test("model operations: only the closed vocabulary, only this survey's variables, validated like any other", () => {
  const { items, rejected } = itemsFromModel({ ops: [
    { op: "add_crosstab", rows: ["SAT"], columns: ["GENDER"], why: "Compare" },
    { op: "add_crosstab", rows: ["SAT"], columns: ["MADE_UP"], why: "bogus" },
    { op: "delete_everything", why: "no" },
    { op: "add_test", outcome: "SAT", groupBy: "SAT", why: "same variable" },
    { op: "build_report", objective: "Summarise", audience: "executive", story: true, why: "asked" },
  ] }, ctx());
  assert.equal(items.length, 3);
  assert.equal(rejected.length, 2);
  assert.match(rejected.join(" "), /MADE_UP is not a variable/); assert.match(rejected.join(" "), /delete_everything/);
  assert.ok(items.find((i) => i.op.op === "add_test")!.blocked.length, "a test of a variable against itself is blocked by the same validator");
  assert.equal(itemsFromModel("garbage", ctx()).items.length, 0);
  assert.ok(itemsFromModel({ ops: Array.from({ length: 30 }, () => ({ op: "add_descriptive", variables: ["SAT"] })) }, ctx()).items.length <= 8);
});

test("each chart change lists the other charts that suit the result, all of them drawable; a poor choice the person asks for is allowed but warned about", () => {
  const multi = saved("Brands considered", "descriptive", ["CONSIDER"]);
  const rep: ReportDefinition = { title: "R", blocks: [{ id: "pie", type: "chart", title: "Brands considered", analysisId: multi.id, chart: { type: "pie", options: {} } }] } as never;
  const c = ctx([multi], [{ id: "r1", name: "R", definition: rep }]);
  const best = proposeFromText("choose the best chart for each question", c).items[0];
  assert.ok(best.options && best.options.length >= 1 && best.options.length <= 4);
  assert.ok(best.options!.every((o) => o.chart !== (best.op as Extract<AskOp, { op: "set_chart" }>).chart && o.reason));
  const asked = proposeFromText("use a donut chart for brands considered", c).items;
  assert.equal(asked.length, 1);
  assert.equal((asked[0].op as Extract<AskOp, { op: "set_chart" }>).chart, "donut");
  assert.equal(asked[0].blocked.length, 0, "it is the person's call");
  assert.ok(asked[0].warnings.length >= 1 && asked[0].warnings.length === new Set(asked[0].warnings).size, "said once, plainly");
});

test("parseAskOps and parseUndo rebuild what the browser sends: unknown operations, bad ids and unknown charts are dropped", () => {
  const id = "11111111-1111-4111-8111-111111111111";
  const { ops, rejected } = parseAskOps([
    { op: "add_crosstab", rows: ["SAT"], columns: ["GENDER"], name: "x", evil: "<script>" },
    { op: "drop_table" }, { op: "remove_analysis", analysisId: "not-a-uuid" },
    { op: "set_chart", reportId: id, blockId: "b", analysisId: id, chart: "hologram" },
    { op: "set_chart", reportId: id, blockId: "b", analysisId: id, chart: "bar_horizontal" },
  ]);
  assert.deepEqual(ops.map((o) => o.op), ["add_crosstab", "set_chart"]);
  assert.equal(rejected.length, 3);
  assert.equal("evil" in ops[0], false);
  assert.deepEqual(parseUndo([{ kind: "created_analysis", id }, { kind: "created_analysis", id: "x" }, { kind: "chart_changed", reportId: id, blockId: "b", before: { type: "pie" }, after: { type: "nope" } }, { kind: "removed_analysis", id, chartIds: [id, "bad"] }]),
    [{ kind: "created_analysis", id }, { kind: "removed_analysis", id, chartIds: [id] }]);
});

test("removing an analysis is blocked when the one it was a repeat of has gone — it is not a repeat any more", () => {
  const a = saved("A", "descriptive", ["SAT"]); const b = saved("B", "descriptive", ["SAT"]);
  const c = ctx([a, b]);
  assert.deepEqual(validateAskOp({ op: "remove_analysis", name: "B", analysisId: b.id, keptId: a.id }, c).blocked, []);
  assert.match(validateAskOp({ op: "remove_analysis", name: "B", analysisId: b.id, keptId: "00000000-0000-4000-8000-00000000dead" }, c).blocked.join(" "), /no longer exists, so it is not a repeat/);
  assert.match(validateAskOp({ op: "remove_analysis", name: "x", analysisId: "00000000-0000-4000-8000-00000000beef" }, c).blocked.join(" "), /no longer exists/);
});

test("Phase 5: 'this' means the analysis that is open — read as its own question, and the proposal says so", () => {
  const open = saved("Satisfaction", "descriptive", ["SAT"]);
  const withFocus = { ...ctx([open]), focus: { analysisId: open.id } };
  const p = proposeFromText("Cross-tab this by gender", withFocus);
  const x = op(p, "add_crosstab");
  assert.equal(x.length, 1);
  assert.deepEqual([x[0].rows, x[0].columns], [["SAT"], ["GENDER"]]);
  assert.ok(p.notes.some((t) => /“this” was read as “Satisfaction” \(SAT\), the analysis open in Explore/.test(t)), p.notes.join(" | "));
  const t = proposeFromText("Test whether this differs by region", withFocus);
  const tests = op(t, "add_test");
  assert.equal(tests.length, 1);
  assert.equal(tests[0].outcome, "SAT"); assert.equal(tests[0].groupBy, "REGION");
  /* the note appears once however many clauses say "this" */
  const both = proposeFromText("Cross-tab this by gender, then test whether this differs by region", withFocus);
  assert.equal(both.notes.filter((n) => /“this” was read as/.test(n)).length, 1);
  assert.equal(op(both, "add_crosstab").length + op(both, "add_test").length, 2);
});

test("Phase 5: 'this' with nothing open is not guessed — it asks for an open analysis, and a request that never says 'this' is unchanged", () => {
  const none = proposeFromText("Cross-tab this by gender", ctx());
  assert.equal(none.items.length, 0);
  assert.equal(none.unread.length, 1);
  assert.match(none.unread[0], /none is open\. Open one in Explore/);
  /* a focus that is not one of this survey's analyses is ignored, never trusted */
  const ghost = proposeFromText("Cross-tab this by gender", { ...ctx(), focus: { analysisId: "not-there" } });
  assert.equal(ghost.items.length, 0);
  assert.match(ghost.unread[0], /none is open/);
  const open = saved("Satisfaction", "descriptive", ["SAT"]);
  const same = proposeFromText("Create cross-tabs of satisfaction by age and gender", { ...ctx([open]), focus: { analysisId: open.id } });
  assert.equal(op(same, "add_crosstab").length, 2);
  assert.ok(!same.notes.some((n) => /“this” was read as/.test(n)));
});

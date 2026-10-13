import { test } from "node:test";
import assert from "node:assert/strict";
import { variableMetadata } from "./dataset.js";
import { crosstabDefinition, testDefinition, plannedAnalyses, type PlannedAnalysis } from "./planBridge.js";
import { validateAnalysis, reviewPlanned, analysisSignature, findExistingDuplicate, isPlanned, surveyKnownNames } from "./planCheck.js";
import type { AnalysisDefinition } from "./types.js";
import { def } from "./analyses/fixture.js";

const spec = { environment: "LIVE" as const, dataset: "all" as const };
const vars = variableMetadata(def);
const xt = (id: string, rows: string[], columns: string[]): PlannedAnalysis => ({ definition: crosstabDefinition({ id, rows, columns, measure: "pct_col", priority: 1, hypotheses: [] } as never, spec, def), source: { kind: "crosstab", id }, priority: 1, hypotheses: [] });
const chi = (id: string, outcome: string, groupBy: string): PlannedAnalysis => ({ definition: testDefinition({ id, method: "chi_square", outcome, groupBy, variables: [], priority: 2, hypotheses: [] } as never, spec), source: { kind: "test", id }, priority: 2, hypotheses: [] });
const D = (extra: Partial<AnalysisDefinition>): AnalysisDefinition => ({ name: "x", kind: "descriptive", dataset: spec, variables: [], ...extra } as AnalysisDefinition);

test("an analysis that reads a variable the survey does not have is an error naming it", () => {
  const issues = validateAnalysis(D({ variables: ["SAT", "NOT_A_VARIABLE"] }), vars);
  assert.equal(issues[0].code, "unknown_variable");
  assert.deepEqual(issues[0].variables, ["NOT_A_VARIABLE"]);
  assert.deepEqual(validateAnalysis(D({ variables: ["SAT"] }), vars), []);
  // plan-computed variables are known when the caller says so
  assert.deepEqual(validateAnalysis(D({ variables: ["SEGMENT_X"] }), vars, ["SEGMENT_X"]), []);
});

test("uncomputable shapes are caught before they run", () => {
  assert.equal(validateAnalysis(D({ kind: "crosstab", rows: ["SAT"], columns: [] }), vars)[0].code, "missing_axis");
  assert.equal(validateAnalysis(D({ kind: "crosstab", rows: ["SAT"], columns: ["SAT"], variables: ["SAT"] }), vars)[0].code, "same_variable");
  assert.equal(validateAnalysis(D({ kind: "descriptive", variables: [] }), vars)[0].code, "no_variables");
  assert.equal(validateAnalysis(D({ kind: "descriptive", variables: ["REGION"], options: { statistic: "mean" } }), vars)[0].code, "wrong_type");
  assert.equal(validateAnalysis(D({ kind: "test", variables: ["SAT"] }), vars)[0].code, "needs_groups");
  assert.equal(validateAnalysis(D({ kind: "correlation", variables: ["TEXT", "AGE"] }), vars)[0].code, "wrong_type");
});

test("a chi-square beside the crosstab for the same pair is dropped, naming what it repeats — in either order", () => {
  const a = reviewPlanned([xt("c1", ["SAT"], ["GENDER"]), chi("t1", "SAT", "GENDER")], vars);
  assert.equal(a.kept.length, 1); assert.equal(a.kept[0].definition.kind, "crosstab");
  assert.equal(a.duplicates.length, 1); assert.match(a.duplicates[0].reason, /already reports this chi-square/);
  const b = reviewPlanned([chi("t1", "SAT", "GENDER"), xt("c1", ["SAT"], ["GENDER"])], vars);
  assert.equal(b.kept.length, 1); assert.equal(b.kept[0].definition.kind, "crosstab", "the crosstab wins even when the test came first");
  // a different pair is not a duplicate
  assert.equal(reviewPlanned([xt("c1", ["SAT"], ["GENDER"]), chi("t2", "SAT", "REGION")], vars).kept.length, 2);
});

test("exact repeats collapse, dead references are blocked with the reason", () => {
  const r = reviewPlanned([xt("c1", ["SAT"], ["GENDER"]), xt("c2", ["SAT"], ["GENDER"]), xt("c3", ["SAT"], ["GHOST"])], vars);
  assert.equal(r.kept.length, 1);
  assert.equal(r.duplicates.length, 1);
  assert.equal(r.blocked.length, 1);
  assert.match(r.blocked[0].reason, /GHOST.*not in this survey/);
});

test("a hand-built analysis the plan would repeat is found, whatever it was named", () => {
  const planned = xt("c1", ["SAT"], ["GENDER"]).definition;
  const mine = { id: "m1", name: "My satisfaction by gender", definition: { ...planned, name: "My satisfaction by gender", options: { ...planned.options, planned: undefined } } };
  assert.deepEqual(findExistingDuplicate(planned, [mine]), { id: "m1", name: "My satisfaction by gender" });
  assert.equal(findExistingDuplicate(xt("c2", ["SAT"], ["REGION"]).definition, [mine]), null);
  assert.equal(analysisSignature(planned), analysisSignature({ ...planned, name: "renamed", notes: "n" }));
});

test("the real generated plan for the fixture has no dead references and no repeats once reviewed", () => {
  const items = plannedAnalyses(def, spec, { primaries: true });
  const r = reviewPlanned(items, vars, surveyKnownNames(def, vars));
  assert.ok(r.kept.length > 0);
  assert.equal(r.blocked.length, 0, r.blocked.map((b) => b.reason).join(" | "));
  const sigs = r.kept.map((k) => analysisSignature(k.definition));
  assert.equal(new Set(sigs).size, sigs.length, "no two kept items compute the same thing");
  assert.equal(isPlanned(r.kept[0].definition), true);
  assert.equal(isPlanned({ options: {} }), false);
});

import { reviewAgainstSaved } from "./planCheck.js";

test("reviewAgainstSaved: creates only what is new, usable and not already there — hand-built analyses are never duplicated", () => {
  const items = [xt("c1", ["SAT"], ["GENDER"]), chi("t1", "SAT", "GENDER"), xt("c2", ["SAT"], ["REGION"]), xt("c3", ["SAT"], ["GHOST"])];
  const mine = { id: "m1", name: "Mine", definition: { ...xt("x", ["SAT"], ["REGION"]).definition, name: "Mine", options: {} } };
  const r = reviewAgainstSaved(items, vars, () => false, [mine]);
  assert.deepEqual(r.toCreate.map((i) => (i.source as { id: string }).id), ["c1"], "c1 is new; t1 repeats it; c2 is the researcher's own; c3 is dead");
  assert.equal(r.blocked.length, 1); assert.match(r.blocked[0].reason, /GHOST/);
  assert.ok(r.duplicates.some((d) => d.duplicateOf === "Mine"), "names the analysis they already have");
  assert.equal(r.existingFor.get("c2"), "m1", "the plan item points at their analysis, so a report can use it");
  // running it again with c1 saved creates nothing
  const saved1 = { id: "s1", name: "c1", definition: items[0].definition };
  assert.deepEqual(reviewAgainstSaved(items, vars, () => false, [mine, saved1]).toCreate, []);
});

test("reviewAgainstSaved: a planned analysis the researcher has since edited is not created a second time", () => {
  const items = [xt("c1", ["SAT"], ["GENDER"])];
  const original = items[0].definition;
  // saved from plan item c1, then the researcher changed the column variable — its signature no longer matches
  const edited = { id: "s1", name: "Satisfaction by region", definition: { ...original, columns: ["REGION"] } };
  assert.equal((edited.definition.options as { planned?: string }).planned, "c1");
  const r = reviewAgainstSaved(items, vars, () => false, [edited]);
  assert.deepEqual(r.toCreate, [], "the plan item c1 already has its analysis");
  assert.equal(r.existingFor.get("c1"), "s1");
});

test("a significance test of a variable against itself is an error, not a result", () => {
  const issues = validateAnalysis(D({ kind: "test", variables: ["SAT", "SAT"] }), vars);
  assert.ok(issues.some((i) => i.code === "same_variable" && i.severity === "error"));
  assert.deepEqual(validateAnalysis(D({ kind: "test", variables: ["SAT", "GENDER"] }), vars), []);
});

/* ------------------------------------------------------------ P-4: what makes two analyses the same */

test("P-4: a table of pairs — the signature separates what changes a number and merges what does not", () => {
  const base = xt("c", ["SAT"], ["GENDER"]).definition;
  const w = { variable: "WGT" };
  const pairs: [string, AnalysisDefinition, AnalysisDefinition, boolean][] = [
    ["identical", base, { ...base }, true],
    ["renamed", base, { ...base, name: "other", notes: "n" }, true],
    ["different presentation", base, { ...base, options: { ...base.options, layout: "stacked", decimals: 2 } }, true],
    ["weighted vs unweighted", base, { ...base, weighting: w }, false],
    ["two different weights", { ...base, weighting: w }, { ...base, weighting: { variable: "OTHER" } }, false],
    ["weighting key order", { ...base, weighting: { rim: [{ variable: "A", targets: { a: 1, b: 2 } }], cap: [0.5, 2] } }, { ...base, weighting: { cap: [0.5, 2], rim: [{ targets: { b: 2, a: 1 }, variable: "A" }] } }, true],
    ["saved filter vs none", base, { ...base, filterIds: ["f1"] }, false],
    ["two saved filters", { ...base, filterIds: ["f1"] }, { ...base, filterIds: ["f2"] }, false],
    ["same saved filters, other order", { ...base, filterIds: ["f1", "f2"] }, { ...base, filterIds: ["f2", "f1"] }, true],
    ["layer vs none", base, { ...base, layers: ["REGION"] }, false],
    ["segments vs none", base, { ...base, segments: [{ name: "Young", condition: { type: "rule", source: { kind: "variable", ref: "AGE" }, operator: "lt", value: 30 } } as never] }, false],
    ["other dataset", base, { ...base, dataset: { environment: "TEST", dataset: "all" } }, false],
    ["other measure", base, { ...base, measure: "count" }, false],
    ["rows and columns swapped is another table", xt("a", ["SAT"], ["GENDER"]).definition, xt("b", ["GENDER"], ["SAT"]).definition, false],
    ["chi-square, variables reversed", chi("a", "SAT", "REGION").definition, chi("b", "REGION", "SAT").definition, true],
    ["chi-square, other pair", chi("a", "SAT", "REGION").definition, chi("b", "SAT", "GENDER").definition, false],
    ["correlation, variables reversed", D({ kind: "correlation", variables: ["AGE", "SAT"], options: { method: "pearson" } }), D({ kind: "correlation", variables: ["SAT", "AGE"], options: { method: "pearson" } }), true],
    ["correlation, other method", D({ kind: "correlation", variables: ["AGE", "SAT"], options: { method: "pearson" } }), D({ kind: "correlation", variables: ["AGE", "SAT"], options: { method: "spearman" } }), false],
    ["t-test: outcome and group are not interchangeable", D({ kind: "test", variables: ["SAT", "GENDER"], options: { test: "t_independent" } }), D({ kind: "test", variables: ["GENDER", "SAT"], options: { test: "t_independent" } }), false],
    ["descriptive weighted vs not", D({ variables: ["SAT"] }), D({ variables: ["SAT"], weighting: w }), false],
  ];
  assert.equal(pairs.length, 20);
  for (const [name, a, b, same] of pairs) assert.equal(analysisSignature(a) === analysisSignature(b), same, name);
});

test("P-4: a weighted crosstab is not dropped as a repeat of the unweighted one, nor deleted as a duplicate of it", () => {
  const plain = xt("c1", ["SAT"], ["GENDER"]);
  const weighted: PlannedAnalysis = { ...xt("c2", ["SAT"], ["GENDER"]), definition: { ...xt("c2", ["SAT"], ["GENDER"]).definition, weighting: { variable: "WGT" } } };
  assert.equal(reviewPlanned([plain, weighted], vars).kept.length, 2);
  assert.equal(findExistingDuplicate(weighted.definition, [{ id: "m", name: "plain", definition: plain.definition }]), null);
  /* and a chi-square with its variables the other way round IS a repeat of the planned one */
  const r = reviewPlanned([chi("t1", "SAT", "REGION"), chi("t2", "REGION", "SAT")], vars);
  assert.equal(r.kept.length, 1);
  assert.equal(r.duplicates.length, 1);
});

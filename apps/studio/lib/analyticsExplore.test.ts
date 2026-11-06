import test from "node:test";
import assert from "node:assert/strict";
import type { VariableMeta } from "@rescript/analytics";
import { chartChoices, combinedFilter, crossFilter, exploreDefinition } from "./analyticsExplore.ts";

const V = (name: string, role: VariableMeta["role"], extra: Partial<VariableMeta> = {}): VariableMeta => ({ name, label: name.toLowerCase().replace(/_/g, " "), role, derived: false, hidden: false, questionId: `q_${name.toLowerCase()}`, questionCode: name, ...extra });
const vars: VariableMeta[] = [
  V("AGE_GROUP", "categorical", { categories: [{ code: "1", label: "18-34" }, { code: "2", label: "35-54" }, { code: "3", label: "55+" }] }),
  V("GENDER", "categorical", { categories: [{ code: "1", label: "Male" }, { code: "2", label: "Female" }] }),
  V("AWARE", "multi", { categories: [{ code: "1", label: "Alpha" }, { code: "2", label: "Beta" }] }),
  V("INTENT", "scale", { categories: [1, 2, 3, 4, 5].map((c) => ({ code: String(c), label: String(c) })) }),
  V("SPEND", "numeric"),
  V("WHY", "text"),
];
const ds = { environment: "LIVE" as const, dataset: "all" as const };

test("the variables picked decide the analysis, with the reason in words", () => {
  assert.equal(exploreDefinition([], vars, ds), null);
  const one = exploreDefinition(["AGE_GROUP"], vars, ds)!;
  assert.equal(one.kind, "descriptive"); assert.match(one.because, /is a category/);
  const num = exploreDefinition(["SPEND"], vars, ds)!;
  assert.equal(num.kind, "descriptive"); assert.match(num.because, /is a quantity/);
  const xt = exploreDefinition(["AGE_GROUP", "AWARE"], vars, ds)!;
  assert.equal(xt.kind, "crosstab"); assert.deepEqual(xt.definition.rows, ["AGE_GROUP"]); assert.deepEqual(xt.definition.columns, ["AWARE"]); assert.equal(xt.definition.measure, "pct_col");
  const layered = exploreDefinition(["AGE_GROUP", "AWARE", "GENDER"], vars, ds)!;
  assert.deepEqual(layered.definition.layers, ["GENDER"]); assert.match(layered.because, /within gender/);
  const means = exploreDefinition(["INTENT", "AGE_GROUP"], vars, ds)!;
  assert.equal(means.kind, "test"); assert.deepEqual(means.definition.variables, ["INTENT", "AGE_GROUP"]); assert.equal(means.definition.options?.test, "anova_one_way");
  const t2 = exploreDefinition(["GENDER", "SPEND"], vars, ds)!;
  assert.equal(t2.definition.options?.test, "t_independent"); assert.deepEqual(t2.definition.variables, ["SPEND", "GENDER"], "the quantity comes first, whatever the pick order");
  const corr = exploreDefinition(["INTENT", "SPEND"], vars, ds)!;
  assert.equal(corr.kind, "correlation");
  const text = exploreDefinition(["WHY", "GENDER"], vars, ds)!;
  assert.equal(text.kind, "text"); assert.equal(text.definition.options?.by, "GENDER");
  /* a filter and a name travel into the definition */
  const f = exploreDefinition(["AGE_GROUP"], vars, ds, { filter: { type: "group", op: "and", children: [] }, name: "Who" })!;
  assert.equal(f.definition.name, "Who"); assert.ok(f.definition.filter);
  /* the mixed case: a quantity and a category and a text — the first quantity by the first category */
  assert.equal(exploreDefinition(["WHY", "SPEND", "GENDER"], vars, ds)!.kind, "test");
});

test("a clicked category becomes the filter builder's own rule; the panels' filter combines it with the person's own", () => {
  const age = vars[0];
  assert.deepEqual(crossFilter(age, "35-54"), { type: "rule", source: { kind: "question", ref: "q_age_group" }, operator: "eq", value: 2 });
  assert.deepEqual(crossFilter(vars[2], "Alpha"), { type: "rule", source: { kind: "question", ref: "q_aware" }, operator: "selected", value: 1 });
  assert.equal(crossFilter(age, "not a category"), null);
  assert.equal(crossFilter({ ...age, questionId: undefined }, "35-54"), null, "a derived variable without a question cannot be clicked into a filter");
  const r = crossFilter(age, "35-54")!;
  assert.equal(combinedFilter(null, []), null);
  assert.deepEqual(combinedFilter({ type: "group", op: "and", children: [] }, [{ variable: "AGE_GROUP", label: "age group", category: "35-54", rule: r }]), r, "an empty own filter is nothing");
  const own = crossFilter(vars[1], "Female")!;
  const both = combinedFilter(own, [{ variable: "AGE_GROUP", label: "age group", category: "35-54", rule: r }]);
  assert.deepEqual(both, { type: "group", op: "and", children: [own, r] });
});

test("the chart switcher offers what fits the result's shape, the recommendation first, no repeats", () => {
  const c = chartChoices({ chart: { categories: ["a", "b"], series: [{}] }, recommendedCharts: ["pie"] }, [{ type: "bar_horizontal" }]);
  assert.equal(c[0], "bar_horizontal"); assert.ok(c.includes("donut") && c.includes("pie")); assert.equal(new Set(c).size, c.length); assert.ok(c.length <= 8);
  const m = chartChoices({ chart: { matrix: { rows: [], columns: [], values: [] } } }, []);
  assert.equal(m[0], "heatmap");
});

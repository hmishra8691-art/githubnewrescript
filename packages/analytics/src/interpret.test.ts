import test from "node:test";
import assert from "node:assert/strict";
import { D, synthDataset } from "./analyses/fixture.js";
import { runAnalysis } from "./analyses/index.js";
import { effectWords, interpretResult } from "./interpret.js";

/*
 * DUAL-LAYER INTERPRETATION (M5): the statistical layer prints the test as it is; the plain layer says what, why and
 * what it means without ever claiming causation or significance the test did not give.
 */
const ds = synthDataset(400);
const CAUSAL = /\b(causes|because|due to|leads to|drives)\b/i;

test("a crosstab: statistical lines from its tests, a plain reading in research terms, association not causation", () => {
  const def = D("crosstab", ["SAT", "REGION"], { rows: ["SAT"], columns: ["REGION"], measure: "pct_col" });
  const r = runAnalysis(def, ds);
  const i = interpretResult(def, r, { labelOf: (n) => ({ SAT: "Satisfaction", REGION: "Region" })[n] ?? n, hypotheses: [{ label: "H1", text: "Region affects satisfaction" }], objective: "What drives satisfaction" });
  assert.ok(i.statistical.some((s) => /chi-square/.test(s) && /p (<|=)/.test(s)), i.statistical.join(" | "));
  assert.ok(i.statistical.some((s) => /^Base: n = 400/.test(s)));
  assert.match(i.plain.what, /^Satisfaction broken down by Region — a crosstab with column percentages, on 400 respondents\./);
  assert.match(i.plain.why, /^It serves H1 \(Region affects satisfaction\)\./);
  assert.ok(!CAUSAL.test(i.plain.meaning.replace(/does not say that one causes the other/, "")), i.plain.meaning);
  assert.ok(i.verdict === "significant" || i.verdict === "not_significant");
  if (i.verdict === "significant") assert.match(i.plain.meaning, /associated/); else assert.match(i.plain.meaning, /No reliable association/);
  assert.ok(i.plain.next.length >= 1);
  assert.ok(i.plain.objective && /objective/.test(i.plain.objective));
});

test("a comparison of means and a correlation read as such; a description is not a test", () => {
  const t = D("test", ["AGE", "GENDER"], { options: { test: "t_independent" } });
  const it = interpretResult(t, runAnalysis(t, ds), {});
  assert.match(it.plain.what, /compared across GENDER/);
  assert.match(it.plain.meaning, /groups differ|No reliable difference/);
  assert.match(it.plain.why, /exploration/);
  const c = D("correlation", ["AGE", "NPS"]);
  const ic = interpretResult(c, runAnalysis(c, ds), { reason: "age and advocacy" });
  assert.match(ic.plain.what, /move together/);
  assert.match(ic.plain.why, /^Age and advocacy\.$/);
  assert.ok(/Correlation is not causation|No reliable correlation/.test(ic.plain.meaning));
  const d = D("descriptive", ["GENDER"]);
  const id = interpretResult(d, runAnalysis(d, ds));
  assert.equal(id.verdict, "no_test");
  assert.match(id.plain.meaning, /A description, not a test/);
});

test("effect sizes in words, by the conventions of each measure", () => {
  assert.equal(effectWords("Cramér's V", 0.05), "negligible"); assert.equal(effectWords("Cramér's V", 0.2), "small"); assert.equal(effectWords("Cramér's V", 0.6), "large");
  assert.equal(effectWords("Cohen's d", 0.5), "medium"); assert.equal(effectWords("r", -0.35), "medium"); assert.equal(effectWords("η²", 0.02), "small"); assert.equal(effectWords("odds ratio", 0.3), "large");
});

test("caveats: a filter and a small base are said", () => {
  const def = D("crosstab", ["SAT", "REGION"], { rows: ["SAT"], columns: ["REGION"] });
  const r = runAnalysis(def, synthDataset(20));
  const i = interpretResult(def, r);
  assert.ok(i.plain.next.some((s) => /very small/.test(s)));
});

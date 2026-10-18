import { test } from "node:test";
import assert from "node:assert/strict";
import { synthDataset, D } from "./fixture.js";
import { runAnalysis } from "./index.js";
import { pairwiseComparisons } from "../posthoc.js";

/**
 * §9 GAP AUDIT (2026-10-18) — the small fix: an ANOVA / Kruskal–Wallis over three
 * or more groups in Data Analytics now says WHICH groups differ, each pair's p
 * adjusted as one family (Holm by default; Bonferroni, Benjamini–Hochberg or none
 * on request). The omnibus test and the existing tables are unchanged.
 */
const ds = synthDataset(400);

test("ANOVA over three groups adds Holm-adjusted pairwise comparisons; the omnibus test and table order are unchanged", () => {
  const r = runAnalysis(D("test", ["SAT", "REGION"], { options: { test: "anova_one_way" } }), ds);
  assert.equal(r.tests[0].test, "anova_one_way");
  const ids = r.tables.map((t) => t.id);
  assert.ok(ids.indexOf("groups") >= 0 && ids.indexOf("pairwise") > ids.indexOf("groups"), `the pairwise table follows the group table: ${ids}`);
  const pw = r.tables.find((t) => t.id === "pairwise")!;
  assert.ok(pw, r.tables.map((t) => t.id).join(","));
  assert.match(pw.title, /Welch t, Holm-adjusted/);
  assert.equal(pw.rows.length, 3, "3 groups → 3 pairs");
  const ref = pairwiseComparisons(ds, "SAT", "REGION", { method: "holm" });
  ref.pairs.forEach((p, i) => { assert.equal(pw.rows[i].a, p.a); assert.equal(pw.rows[i].sig, p.significant ? "yes" : "no"); assert.ok((p.pAdj ?? 1) >= (p.p ?? 0)); });
  assert.ok(r.insights.some((x) => /^Pairwise \(Holm-adjusted, 3 pairs\)/.test(x)));
  assert.ok(r.insights[0].startsWith("The difference in"), "the omnibus sentence still leads");
});

test("the correction is selectable: Bonferroni ≥ Holm; Kruskal–Wallis pairs use Mann–Whitney; none = omnibus only; two groups get no pairwise table", () => {
  const holm = runAnalysis(D("test", ["SAT", "REGION"], { options: { test: "anova_one_way", correction: "holm" } }), ds).tables.find((t) => t.id === "pairwise")!;
  const bonf = runAnalysis(D("test", ["SAT", "REGION"], { options: { test: "anova_one_way", correction: "bonferroni" } }), ds).tables.find((t) => t.id === "pairwise")!;
  assert.match(bonf.title, /Bonferroni/);
  const num = (s: unknown) => (String(s).startsWith("<") ? 0.0005 : Number(String(s).replace(/^\./, "0.")));
  bonf.rows.forEach((row, i) => assert.ok(num(row.pAdj) >= num(holm.rows[i].pAdj) - 1e-9));
  const kw = runAnalysis(D("test", ["SAT", "REGION"], { options: { test: "kruskal_wallis", correction: "bh" } }), ds).tables.find((t) => t.id === "pairwise")!;
  assert.match(kw.title, /Mann–Whitney, Benjamini–Hochberg-adjusted/);
  assert.equal(runAnalysis(D("test", ["SAT", "REGION"], { options: { test: "anova_one_way", correction: "none" } }), ds).tables.some((t) => t.id === "pairwise"), false);
  assert.equal(runAnalysis(D("test", ["SAT", "GENDER"], { options: { test: "t_welch" } }), ds).tables.some((t) => t.id === "pairwise"), false);
});

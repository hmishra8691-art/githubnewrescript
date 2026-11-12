/**
 * DEMONSTRATION DATA (demo.ts): fictional, labelled as such, produced by walking the real survey — and analysed
 * with the real method. The choices are generated from a stated model, so the analysis has a known answer to find:
 * that is what makes these tests of the ANALYSIS and not of a picture.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { advancedTemplates, buildDemoDataset, conjointAnalysis, findSurveyTemplate, frequency, maxdiffScores } from "./index.js";

test("every advanced template has a demonstration dataset: fictional, reproducible, with completes and the survey's own variables", () => {
  for (const t of advancedTemplates()) {
    const a = buildDemoDataset(t.key, 40);
    assert.equal(a.fictional, true);
    assert.match(a.note, /Fictional demonstration data/);
    assert.ok(a.rows.every((r) => /^DEMO-\d{4}$/.test(String(r.RESPONDENT))), `${t.key}: rows are marked as demonstration rows`);
    assert.ok((a.statuses.complete ?? 0) >= 5, `${t.key}: ${a.statuses.complete ?? 0} completes of 40`);
    const vars = new Set(t.build("x").questions.map((q) => q.variableName));
    assert.ok(Object.keys(a.rows.find((r) => r.STATUS === "complete")!).some((k) => vars.has(k)), `${t.key}: the rows carry the survey's variables`);
    assert.deepEqual(buildDemoDataset(t.key, 40).rows.slice(0, 5), a.rows.slice(0, 5), `${t.key}: the same seed gives the same data`);
  }
});

test("MaxDiff: best-minus-worst scores recover the order the demonstration respondents were given", () => {
  const def = findSurveyTemplate("adv_maxdiff")!.build("x");
  const data = buildDemoDataset("adv_maxdiff", 220);
  const scores = maxdiffScores(def, data.rows.filter((r) => r.STATUS === "complete"), "MD");
  assert.equal(scores.length, 12);
  assert.ok(scores.every((s) => s.shown > 0 && s.best <= s.shown && s.worst <= s.shown && Math.abs(s.score) <= 1));
  /* every set has one best and one worst, so the two totals are equal and the scores sum to about zero */
  assert.equal(scores.reduce((a, s) => a + s.best, 0), scores.reduce((a, s) => a + s.worst, 0));
  const items = (def.designs[0].config as { items: string[] }).items;
  const rank = (item: string) => scores.findIndex((s) => s.item === item);
  assert.ok(rank(items[0]) < 4 && rank(items[1]) < 5, "the first items of the list come out on top");
  assert.ok(rank(items[11]) > 7 && rank(items[10]) > 6, "…and the last at the bottom");
  assert.ok(scores[0].score > 0.3 && scores[11].score < -0.3);
});

test("Conjoint: counts and an aggregate logit, whose part-worths recover the model the choices came from", () => {
  const def = findSurveyTemplate("adv_cbc")!.build("x");
  const data = buildDemoDataset("adv_cbc", 320);
  const res = conjointAnalysis(def, data.rows.filter((r) => r.STATUS === "complete"), "CBC")!;
  assert.ok(res.converged, "Newton–Raphson converges");
  assert.ok(res.tasks >= 400, `${res.tasks} choice sets analysed (holdouts excluded)`);
  const pw = (attribute: string) => res.levels.filter((l) => l.attribute === attribute).map((l) => l.partWorth);
  const price = pw("Price");
  assert.equal(price[0], 0, "the first level is the reference");
  assert.ok(price[1] < 0 && price[3] < price[1], `price: dearer is worse (${price.join(", ")})`);
  assert.ok(Math.abs(price[3] - -1.2) < 0.45, `the dearest price is estimated near the −1.2 it was generated with (${price[3]})`);
  const range = pw("Range per charge");
  assert.ok(range[2] > range[1] && range[1] > 0, `range: more is better (${range.join(", ")})`);
  /* the counting analysis tells the same story */
  const share = (attribute: string) => res.levels.filter((l) => l.attribute === attribute).map((l) => l.share);
  assert.ok(share("Price")[0] > share("Price")[3]);
  assert.ok(Math.abs(res.importance.reduce((a, b) => a + b.pct, 0) - 100) < 0.5);
  assert.ok(res.noneShare > 0 && res.noneShare < 0.6);
  assert.match(res.note, /hierarchical Bayes/);
});

test("a question-level summary reads the same rows", () => {
  const def = findSurveyTemplate("adv_b2b")!.build("x");
  const data = buildDemoDataset("adv_b2b", 120);
  const f = frequency(def, data.rows.filter((r) => r.STATUS === "complete"), "BUYING_ROLE")!;
  assert.equal(f.counts.length, 3);
  assert.equal(f.counts.reduce((a, c) => a + c.n, 0), f.base);
  assert.ok(f.base > 10 && Math.abs(f.counts.reduce((a, c) => a + c.pct, 0) - 100) < 0.5);
});

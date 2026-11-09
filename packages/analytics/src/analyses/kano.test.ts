import { test } from "node:test";
import assert from "node:assert/strict";
import { SurveyDefinition } from "@rescript/schema";
import { buildDataset, type AnalyticsRow } from "../dataset.js";
import { runAnalysis } from "./index.js";
import { kanoClass, KANO_TABLE } from "./kano.js";

/*
 * KANO (Design Generators phase 2). Ten respondents answer both grids for Fast (f1) and Cheap (f2); an eleventh
 * answers only the functional grid for Fast (left out of Fast's base).
 *   Fast:  4 × (like, dislike) → O · 3 × (expect, dislike) → M · 2 × (like, neutral) → A · 1 × (neutral, neutral) → I
 *          shares O 40 M 30 A 20 I 10 → One-dimensional, strength 10; Better (2+4)/10 = 0.6, Worse −(4+3)/10 = −0.7
 *   Cheap: 3 × (like, expect) → A · 3 × (neutral, dislike) → M · 2 × (neutral, neutral) → I · 1 × (like, like) → Q ·
 *          1 × (dislike, like) → R; A = M = 30 → Must-be by the tie rule (M > O > A > I), strength 0;
 *          Better 3/8 = 0.375, Worse −3/8 = −0.375; Q 10% → the questionable warning
 */
const K = [1, 2, 3, 4, 5].map((c) => ({ code: c, label: ["I like it that way", "I expect it to be that way", "I am neutral", "I can live with it that way", "I dislike it that way"][c - 1] }));
const rows = [{ code: "f1", label: "Fast" }, { code: "f2", label: "Cheap" }];
const def = SurveyDefinition.parse({ meta: { id: "k", code: "K", title: "K", version: "1" }, questions: [
  { id: "q1", code: "KANO_FUNC", variableName: "KANO_FUNC", type: "matrix_single", text: "had", rows, options: K },
  { id: "q2", code: "KANO_DYSF", variableName: "KANO_DYSF", type: "matrix_single", text: "not", rows, options: K },
  { id: "q3", code: "KANO_IMP", variableName: "KANO_IMP", type: "matrix_single", text: "imp", rows, options: K },
], flow: [] });
const fast: [number, number][] = [[1, 5], [1, 5], [1, 5], [1, 5], [2, 5], [2, 5], [2, 5], [1, 3], [1, 3], [3, 3]];
const cheap: [number, number][] = [[1, 2], [1, 2], [1, 2], [3, 5], [3, 5], [3, 5], [3, 3], [3, 3], [1, 1], [5, 1]];
const data: AnalyticsRow[] = fast.map((f, i) => ({ id: `r${i}`, session_id: `s${i}`, status: "complete", answers: { q1: { f1: f[0], f2: cheap[i][0] }, q2: { f1: f[1], f2: cheap[i][1] }, q3: { f1: 5, f2: i < 5 ? 4 : 2 } }, calculated: {}, embedded: {}, flags: [] }));
data.push({ id: "r10", session_id: "s10", status: "complete", answers: { q1: { f1: 1 } }, calculated: {}, embedded: {}, flags: [] });
const spec = { environment: "LIVE" as const, dataset: "all" as const };

test("kanoClass follows Berger's evaluation table (corners, rows, off-scale)", () => {
  assert.equal(kanoClass(1, 5), "O"); assert.equal(kanoClass(1, 1), "Q"); assert.equal(kanoClass(5, 5), "Q");
  assert.equal(kanoClass(2, 5), "M"); assert.equal(kanoClass(4, 5), "M"); assert.equal(kanoClass(1, 3), "A");
  assert.equal(kanoClass(3, 3), "I"); assert.equal(kanoClass(5, 1), "R"); assert.equal(kanoClass(2, 1), "R");
  assert.equal(kanoClass(null, 3), null); assert.equal(kanoClass(6, 3), null);
  assert.equal(KANO_TABLE.flat().filter((x) => x === "I").length, 9);
});

test("kano analysis: shares, category with the tie rule, strength, Better / Worse, importance — the hand-computed values", () => {
  const ds = buildDataset(def, data, { spec });
  const res = runAnalysis({ name: "kano", kind: "kano", dataset: spec, variables: ["KANO_FUNC", "KANO_DYSF", "KANO_IMP"] }, ds);
  assert.equal(res.error, undefined, JSON.stringify(res.warnings));
  const [f, c] = res.tables[0].rows as Record<string, unknown>[];
  assert.deepEqual([f.feature, f.n, f.O, f.M, f.A, f.I, f.R, f.Q, f.category, f.strength, f.better, f.worse, f.importance], ["Fast", 10, 40, 30, 20, 10, 0, 0, "One-dimensional (performance)", 10, 0.6, -0.7, 5]);
  assert.deepEqual([c.feature, c.n, c.A, c.M, c.I, c.Q, c.R, c.category, c.strength, c.better, c.worse, c.importance], ["Cheap", 10, 30, 30, 20, 10, 10, "Must-be", 0, 0.375, -0.375, 3]);
  assert.ok(res.insights.some((s) => /Must-be .*: Cheap/.test(s)));
  assert.ok(res.insights.some((s) => /One-dimensional .*: Fast/.test(s)));
  assert.ok(res.insights.some((s) => /Largest satisfaction gain when present: Fast \(Better 0\.6\); largest dissatisfaction when absent: Fast \(Worse -0\.7\)/.test(s)), res.insights.join(" | "));
  assert.ok(res.warnings.some((w) => /Mixed classification .*Cheap/.test(w)));
  assert.ok(res.warnings.some((w) => /10%\+ questionable answers .*Cheap/.test(w)));
  const none = runAnalysis({ name: "kano", kind: "kano", dataset: spec, variables: ["KANO_FUNC"] }, ds);
  assert.match(none.warnings.join(" "), /needs the functional and the dysfunctional question/);
});

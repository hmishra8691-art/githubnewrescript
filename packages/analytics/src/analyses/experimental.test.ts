import { test } from "node:test";
import assert from "node:assert/strict";
import { SurveyDefinition } from "@rescript/schema";
import { buildDataset, type AnalyticsRow } from "../dataset.js";
import { runAnalysis } from "./index.js";
import { conceptPositions, holm } from "./experimental.js";

const spec = { environment: "LIVE" as const, dataset: "all" as const };
const row = (i: number, a: Record<string, unknown>, calc: Record<string, unknown> = {}, embedded: Record<string, unknown> = {}): AnalyticsRow => ({ id: `r${i}`, session_id: `s${i}`, status: "complete", answers: a, calculated: calc, embedded, flags: [] });
const near = (a: number | null | undefined, b: number, tol = 1e-3) => assert.ok(a != null && Math.abs(a - b) < tol, `${a} ≈ ${b}`);

test("holm: step-down adjusted p-values, monotone, in the input order", () => {
  assert.deepEqual(holm([0.01, 0.04, 0.03]).map((p) => Math.round(p! * 1e6) / 1e6), [0.03, 0.06, 0.06]);
  assert.deepEqual(holm([0.5, null]), [0.5, null]);
});

test("conceptPositions reads the stored ORDER_<randomizer> (non-concept children skipped)", () => {
  assert.deepEqual(conceptPositions("b2,intro,b3,b1", ["b1", "b2", "b3"]), [2, 0, 1]);
  assert.deepEqual(conceptPositions(null, ["b1", "b2"]), [null, null]);
});

/*
 * SEQUENTIAL MONADIC — six respondents rate concepts A, B, C (5-point), each in one of the six Williams orders.
 *   ratings (A,B,C) / order:  (5,3,2) ABC  (4,4,3) BCA  (5,2,3) CAB  (3,3,1) ACB  (4,2,2) CBA  (5,4,2) BAC
 * Hand-computed:
 *   means A 4.3333, B 3.0, C 2.1667
 *   paired differences A−B (2,0,3,0,2,1): mean 1.3333, t = 2.6968;  A−C: 2.1667, t = 7.0502;  B−C: 0.8333, t = 1.7461
 *   Friedman rank sums 17 / 11.5 / 7.5 → Q = 7.5833 before ties; three rows with one tie pair each → Σ(t³−t) = 18,
 *     factor 1 − 18/144 = 0.875 → Q = 8.6667, df 2, p = e^(−Q/2) = 0.013124
 *   first-position lift (first-shown − mean of the later two): 2.5, 0.5, −0.5, 1.0, −1.0, 0.5 → mean 0.5, t = 1.0
 *   A first (5,3) 4.0 vs later 4.5;  B first (4,4) 4.0 vs later 2.5;  C first (3,2) 2.5 vs later 2.0
 */
const def = SurveyDefinition.parse({
  meta: { id: "sm", code: "SM", title: "SM", version: "1.0" },
  questions: ["A", "B", "C"].map((c) => ({ id: `q_${c}`, code: `C_${c}`, variableName: `C_${c}`, type: "single_select", text: c, options: [1, 2, 3, 4, 5].map((k) => ({ code: k, label: String(k) })) })),
  flow: [{ type: "randomizer", id: "rot", order: "williams", children: ["A", "B", "C"].map((c) => ({ type: "block", id: `b${c}`, children: [{ type: "page", id: `p${c}`, questionIds: [`q_${c}`] }] })) }],
});
const DATA: [number[], string][] = [[[5, 3, 2], "ABC"], [[4, 4, 3], "BCA"], [[5, 2, 3], "CAB"], [[3, 3, 1], "ACB"], [[4, 2, 2], "CBA"], [[5, 4, 2], "BAC"]];
const rows = DATA.map(([r, o], i) => row(i, { q_A: r[0], q_B: r[1], q_C: r[2] }, { ORDER_ROT: [...o].map((c) => `b${c}`).join(",") }));

test("sequential monadic: means, Friedman, paired t per pair (Holm), first-position effect — the hand-computed values", () => {
  const ds = buildDataset(def, rows, { spec });
  const res = runAnalysis({ name: "sm", kind: "sequential_monadic", dataset: spec, variables: ["C_A", "C_B", "C_C"], options: { order: "ORDER_ROT", blocks: ["bA", "bB", "bC"] } }, ds);
  assert.equal(res.error, undefined, JSON.stringify(res.warnings));
  assert.deepEqual(res.tables[0].rows.map((r) => r.mean), [4.33, 3, 2.17]);
  const fr = res.tests.find((t) => t.test === "friedman")!;
  near(fr.statistic, 8.6667);
  near(fr.p, Math.exp(-8.6667 / 2), 1e-4);
  const pairs = res.tables.find((t) => t.id === "pairs")!.rows;
  assert.deepEqual(pairs.map((r) => r.t), [2.7, 7.05, 1.75]);
  assert.deepEqual(pairs.map((r) => r.diff), [1.33, 2.17, 0.83]);
  /* Holm on the three raw p-values, recomputed here from the table */
  const raw = pairs.map((r) => Number(r.p)), adj = holm(raw);
  pairs.forEach((r, k) => near(Number(r.pHolm), adj[k]!, 3e-4));
  near(Number(pairs[1].pHolm), 3 * Number(pairs[1].p), 3e-4);   /* the smallest raw p (A−C) is multiplied by the 3 pairs */
  const pos = res.tests.find((t) => t.test === "first_position_effect")!;
  near(pos.statistic, 1.0);
  const order = res.tables.find((t) => t.id === "order")!.rows;
  assert.deepEqual(order.map((r) => [r.meanFirst, r.meanLater, r.nFirst, r.nLater]), [[4, 4.5, 2, 4], [4, 2.5, 2, 4], [2.5, 2, 2, 4]]);
  assert.ok(res.variablesUsed.includes("ORDER_ROT"));
});

test("sequential monadic: two concepts use the paired t; no order variable is said, not guessed", () => {
  const ds = buildDataset(def, rows, { spec });
  const res = runAnalysis({ name: "sm", kind: "sequential_monadic", dataset: spec, variables: ["C_A", "C_B"] }, ds);
  near(res.tests[0].statistic, 2.6968);
  assert.ok(res.warnings.some((w) => /order effect is not checked/.test(w)));
  const one = runAnalysis({ name: "sm", kind: "sequential_monadic", dataset: spec, variables: ["C_A"] }, ds);
  assert.ok(one.warnings.some((w) => /at least two concepts/.test(w)));
});

/*
 * IAT through runAnalysis: five respondents' IAT_D as the engine stores them (one excluded, D empty).
 *   D = 0.8, 0.5, 0.2, −0.1, 0.4 → mean 0.36, SD = sqrt(Σ(d − 0.36)² / 4) = sqrt(0.452 / 4) = 0.33615, t = 0.36 / (0.33615/√5) = 2.3947
 *   bands: 0.8 strong; 0.5, 0.4 moderate; 0.2 slight; −0.1 little or none
 */
test("iat analysis: mean D, SD, t against 0, Cohen's d and the bands — the hand-computed values", () => {
  const idef = SurveyDefinition.parse({ meta: { id: "i", code: "I", title: "I", version: "1.0" }, questions: [{ id: "q1", code: "X", variableName: "X", type: "numeric", text: "x" }], flow: [] });
  const ds = buildDataset(idef, [0.8, 0.5, 0.2, -0.1, 0.4, null].map((d, i) => row(i, { q1: 1 }, d == null ? { IAT_D: null, IAT_EXCLUDED: 1 } : { IAT_D: d, IAT_EXCLUDED: 0 })), { spec });
  const res = runAnalysis({ name: "iat", kind: "iat", dataset: spec, variables: ["IAT_D"] }, ds);
  const v = (m: RegExp) => Number(res.tables[0].rows.find((r) => m.test(String(r.m)))!.v);
  assert.equal(v(/scored/), 5);
  assert.equal(v(/Excluded/), 1);
  near(v(/Mean D/), 0.36);
  near(v(/^SD/), 0.336);
  near(v(/^t /), 2.395);
  near(v(/Cohen/), 1.071);
  const bands = Object.fromEntries(res.tables[1].rows.map((r) => [r.band, r.n]));
  assert.equal(bands["strong — compatible faster"], 1);
  assert.equal(bands["moderate — compatible faster"], 2);
  assert.equal(bands["slight — compatible faster"], 1);
  assert.equal(bands["little or none"], 1);
});

/*
 * SHELF — four shoppers picked (one did not answer):
 *   p1 4.0 s examined p2,p1 second p2 | p1 6.0 s p1 → p3 | p2 3.0 s p3,p2 → p1 | p3 10.0 s p1,p2,p3 → p1
 *   share p1 50 / p2 25 / p3 25; second p1 50 / p2 25 / p3 25; examined p1 75 / p2 75 / p3 50;
 *   time to find: p1 median 5.0 mean 5.0, p2 3.0, p3 10.0
 */
test("shelf analysis: share of choice, second choice, examined and time to find — the hand-computed values", () => {
  const sdef = SurveyDefinition.parse({ meta: { id: "sh", code: "SH", title: "SH", version: "1.0" }, questions: [{ id: "q_s", code: "SHELF", variableName: "SHELF", type: "image_select", variant: "hotspot.shelf", text: "x", settings: { imageUrl: "https://example.com/s.jpg", maxSelections: 1, shelf: { secondPick: true } }, options: ["p1", "p2", "p3"].map((c, i) => ({ code: c, label: `Brand ${i + 1}`, meta: { region: { x: i * 30, y: 0, w: 25, h: 50 } } })) }], flow: [] });
  const R: [string | null, number | null, string | null, string | null][] = [["p1", 4, "p2,p1", "p2"], ["p1", 6, "p1", "p3"], ["p2", 3, "p3,p2", "p1"], ["p3", 10, "p1,p2,p3", "p1"], [null, null, null, null]];
  const ds = buildDataset(sdef, R.map(([pk, t, ex, s2], i) => row(i, pk ? { q_s: [pk] } : {}, {}, pk ? { SHELF_SHELF_TIME: t, SHELF_SHELF_EXAMINED: ex, SHELF_SHELF_PICK2: s2 } : {})), { spec });
  const res = runAnalysis({ name: "shelf", kind: "shelf", dataset: spec, variables: ["SHELF"] }, ds);
  assert.equal(res.error, undefined, JSON.stringify(res.warnings));
  assert.equal(res.tables[0].base?.n, 4);
  assert.deepEqual(res.tables[0].rows.map((r) => [r.product, r.n, r.share, r.second, r.examined, r.medianTime, r.meanTime]), [
    ["Brand 1", 2, 50, 50, 75, 5, 5], ["Brand 2", 1, 25, 25, 75, 3, 3], ["Brand 3", 1, 25, 25, 50, 10, 10],
  ]);
  assert.match(res.insights[0], /Brand 1 wins the shelf: 50% of first choices/);
});

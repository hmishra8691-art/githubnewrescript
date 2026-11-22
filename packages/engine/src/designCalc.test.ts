import { test } from "node:test";
import assert from "node:assert/strict";
import { SurveyDefinition } from "@rescript/schema";
import { apportion, fieldEstimate, interviewLength, normalQuantile, precisionOf, quotaCells, sampleForDifference, sampleForMargin } from "./designCalc.js";
import { runComputeTool, dryRunTool, TOOLS } from "./toolRegistry.js";

const val = <T>(r: { ok: boolean; value?: T; reason?: string }): T => { assert.ok(r.ok, r.reason); return r.value as T; };

test("the normal quantile matches the table values", () => {
  for (const [p, z] of [[0.975, 1.959964], [0.95, 1.644854], [0.995, 2.575829], [0.8, 0.841621], [0.9, 1.281552], [0.5, 0], [0.01, -2.326348]] as const) assert.ok(Math.abs(normalQuantile(p) - z) < 1e-5, `${p}`);
});

test("sample size for a margin: the textbook values", () => {
  /* z² p q / E²: 384.16 → 385; 1067.07 → 1068; 2400.9 → 2401; 99% and ±5: 663.5 → 664 */
  assert.equal(val(sampleForMargin({ margin: 5 })).completes, 385);
  assert.equal(val(sampleForMargin({ margin: 0.03 })).completes, 1068);
  assert.equal(val(sampleForMargin({ margin: 2 })).completes, 2401);
  assert.equal(val(sampleForMargin({ margin: 5, confidence: 99 })).completes, 664);
  /* finite population 2,000: 384.16 / (1 + 383.16/2000) = 322.4 → 323 */
  assert.equal(val(sampleForMargin({ margin: 5, population: 2000 })).completes, 323);
  /* a share of 10%: 1.96² × .1 × .9 / .03² = 384.2 → 385; design effect 1.5 on ±5: 576.2 → 577 */
  assert.equal(val(sampleForMargin({ margin: 3, share: 10 })).completes, 385);
  assert.equal(val(sampleForMargin({ margin: 5, designEffect: 1.5 })).completes, 577);
  const r = sampleForMargin({ margin: 5 });
  assert.ok(r.ok && r.assumptions.some((a) => /50%/.test(a)) && r.assumptions.some((a) => /95%/.test(a)) && r.working.at(-1)!.includes("385"));
  assert.equal(sampleForMargin({ margin: 60 }).ok, false);
  assert.equal(sampleForMargin({}).ok, false);
});

test("sample size for a difference: two shares and two means", () => {
  /* 40% v 50%, α .05, power .8, no continuity correction: 387.3 → 388 per group */
  const p = val(sampleForDifference({ share1: 40, share2: 50 }));
  assert.deepEqual([p.perGroup, p.completes, p.groups], [388, 776, 2]);
  /* d = 0.5: 2(1.96 + 0.8416)² / 0.25 + 1.96²/4 = 63.8 → 64 per group (Cohen's table: 64) */
  assert.equal(val(sampleForDifference({ effect: 0.5 })).perGroup, 64);
  /* d = 0.2: 393.4 → 394 (Cohen: 393; the z²/4 term adds one) ; 90% power, d = 0.5: 85.0+0.96 → 86 */
  assert.equal(val(sampleForDifference({ effect: 0.2 })).perGroup, 394);
  assert.equal(val(sampleForDifference({ effect: 0.5, power: 90 })).perGroup, 86);
  assert.equal(val(sampleForDifference({ share1: 0.4, share2: 0.5, groups: 3 })).completes, 388 * 3);
  assert.equal(sampleForDifference({ share1: 40, share2: 40 }).ok, false);
  assert.equal(sampleForDifference({}).ok, false);
});

test("precision is the inverse of sample size", () => {
  assert.equal(val(precisionOf({ completes: 1000 })).marginPoints, 3.1);
  assert.equal(val(precisionOf({ completes: 385 })).marginPoints, 5);
  assert.equal(val(precisionOf({ completes: 400, share: 10 })).marginPoints, 2.9);
  /* two groups of 388 at 45%: (1.96 + 0.8416) × √(2 × .45 × .55 / 388) = 10.0 points — the difference that sample was sized for */
  const two = val(precisionOf({ completes: 776, groups: 2, share: 45 }));
  assert.equal(two.detectablePoints, 10);
  assert.equal(val(precisionOf({ completes: 1000, designEffect: 2 })).marginPoints, 4.4);
  assert.equal(precisionOf({ completes: 1 }).ok, false);
});

test("quota targets sum exactly and small cells are flagged", () => {
  assert.deepEqual(apportion(100, [1, 1, 1]), [34, 33, 33]);
  assert.deepEqual(apportion(10, [0.26, 0.26, 0.48]), [3, 2, 5]);
  const q = val(quotaCells({ completes: 1000, dimensions: [{ name: "Gender", cells: [{ label: "Male", share: 49 }, { label: "Female", share: 51 }] }, { name: "Age", cells: [{ label: "18-34", share: 30 }, { label: "35-54", share: 35 }, { label: "55+", share: 35 }] }] }));
  assert.deepEqual(q.cells.map((c) => c.target), [490, 510, 300, 350, 350]);
  assert.equal(q.smallCells, 0);
  assert.equal(q.cells[0]!.marginPoints, 4.4);
  const x = val(quotaCells({ completes: 200, interlocked: true, dimensions: [{ name: "Gender", cells: [{ label: "Male", share: 49 }, { label: "Female", share: 51 }] }, { name: "Region", cells: [{ label: "North", share: 10 }, { label: "South", share: 40 }, { label: "East", share: 25 }, { label: "West", share: 25 }] }] }));
  assert.equal(x.cells.length, 8);
  assert.equal(x.cells.reduce((s, c) => s + c.target, 0), 200);
  assert.equal(x.cells.find((c) => c.label === "Male × North")!.target, 10);
  /* 9.8, 39.2, 24.5, 24.5, 10.2, 40.8, 25.5, 25.5: every cell but the two South ones is under 30 */
  assert.equal(x.smallCells, 6);
  assert.ok(x.interlocked);
  /* shares that do not add to 100 are scaled, and it says so */
  const s = quotaCells({ completes: 90, dimensions: [{ name: "Segment", cells: [{ label: "A", share: 20 }, { label: "B", share: 40 }] }] });
  assert.ok(s.ok && s.value.cells.map((c) => c.target).join() === "30,60" && s.assumptions.some((a) => /scaled/.test(a)));
  assert.equal(quotaCells({ completes: 100 }).ok, false);
  assert.equal(quotaCells({ completes: 100, dimensions: [{ name: "G", cells: [{ label: "only", share: 100 }] }] }).ok, false);
});

const survey = () => SurveyDefinition.parse({
  meta: { id: "len", code: "LEN", title: "Length", version: "1.0" },
  questions: [
    { id: "a", code: "Q1", variableName: "Q1", type: "single_select", text: "Which brand do you use most often", options: ["A", "B", "C", "D", "E"].map((l, i) => ({ code: i + 1, label: l })) },
    { id: "b", code: "Q2", variableName: "Q2", type: "matrix_single", text: "How much do you agree", rows: [1, 2, 3, 4, 5, 6].map((i) => ({ code: `r${i}`, label: `Statement ${i}` })), options: [1, 2, 3, 4, 5].map((c) => ({ code: c, label: String(c) })) },
    { id: "c", code: "Q3", variableName: "Q3", type: "long_text", text: "Why do you say that", displayLogic: { type: "rule", source: { kind: "question", ref: "a" }, operator: "eq", value: 1 } },
    { id: "d", code: "Q4", variableName: "Q4", type: "single_select", text: "Rate this brand", options: [1, 2, 3, 4, 5].map((c) => ({ code: c, label: String(c) })) },
  ],
  flow: [{ type: "page", id: "p1", questionIds: ["a", "b", "c"] }, { type: "loop", id: "l1", loopVar: "brand", source: { kind: "question", questionId: "a", filter: "selected" }, children: [{ type: "page", id: "p2", questionIds: ["d"] }] }, { type: "end", id: "e", status: "complete" }],
});

test("interview length comes from what each question asks, and the working adds up", () => {
  const r = interviewLength(survey());
  assert.ok(r.ok);
  if (!r.ok) return;
  /* by hand, in seconds: Q1 7 words × .35 + 4 + 5 × .6 = 9.45; Q2 5 × .35 + 6 × 4 + 5 × .6 = 28.75;
     Q3 (5 × .35 + 45) × 0.6 reach = 28.05; Q4 (3 × .35 + 4 + 3) = 8.05 × (5 options × 0.4 = 2 passes) = 16.1 → 82.35 s = 1.4 min
     longest: 9.45 + 28.75 + 46.75 + 8.05 × 5 = 125.2 s = 2.1 min */
  assert.equal(r.value.typicalMinutes, 1.4);
  assert.equal(r.value.longestMinutes, 2.1);
  assert.deepEqual([r.value.questions, r.value.conditional, r.value.loops], [4, 1, 1]);
  assert.equal(r.value.byKind[0]!.kind, "Grids");
  assert.ok(r.assumptions.some((a) => /not timings measured/.test(a)));
  /* a rate can be overridden: everybody sees the conditional question */
  const all = interviewLength(survey(), { conditionalReach: 1 });
  assert.ok(all.ok && all.value.typicalMinutes > r.value.typicalMinutes);
  assert.equal(interviewLength(SurveyDefinition.parse({ meta: { id: "x", code: "X", title: "x", version: "1" }, questions: [], flow: [] })).ok, false);
});

test("the field estimate assumes no rate it was not given", () => {
  const none = val(fieldEstimate({ completes: 1000 }));
  assert.deepEqual([none.starts, none.invitations, none.cost], [undefined, undefined, undefined]);
  assert.equal(none.missing.length, 2);
  /* 1000 ÷ 0.25 ÷ 0.8 = 5000 starts; ÷ 0.1 = 50,000 invitations; 1000 × 4.5 + 500 = 5000 */
  const full = val(fieldEstimate({ completes: 1000, incidence: 25, completionRate: 80, responseRate: 10, pricePerComplete: 4.5, fixedCost: 500, currency: "USD" }));
  assert.deepEqual([full.starts, full.invitations, full.cost, full.costPerComplete, full.currency], [5000, 50000, 5000, 5, "USD"]);
  assert.equal(full.missing.length, 0);
  assert.equal(val(fieldEstimate({ completes: 300, incidence: 0.3 })).starts, 1000);
  assert.equal(fieldEstimate({ completes: 100, incidence: 0 }).ok, false);
  assert.equal(fieldEstimate({ completes: 100, incidence: 140 }).ok, false);
});

test("the calculators are tools: read-only, no approval, unknown fields refused, no dry run", () => {
  const design = TOOLS.filter((t) => t.engine === "design");
  assert.equal(design.length, 6);
  for (const t of design) assert.deepEqual([t.executor, t.risk, t.approval], ["compute", "read", "none"], t.name);
  const r = runComputeTool(survey(), "design.sample_size_margin", { margin: 5 });
  assert.ok(r.ok && (r.value as { completes: number }).completes === 385 && r.working.length && r.assumptions.length);
  assert.match(runComputeTool(survey(), "design.sample_size_margin", { margn: 5 }).refused ?? "", /does not take “margn”/);
  assert.match(runComputeTool(survey(), "design.sample_size_margin", { margin: 90 }).refused ?? "", /between 0 and 50%/);
  assert.match(runComputeTool(survey(), "survey.delete_question", {}).refused ?? "", /not a calculation/);
  assert.match(runComputeTool(survey(), "design.nope", {}).refused ?? "", /no tool called/);
  assert.ok(runComputeTool(survey(), "design.interview_length", {}).ok);
  assert.match(dryRunTool(survey(), "design.precision", { completes: 100 }).refused ?? "", /calculation/);
});

import test from "node:test";
import assert from "node:assert/strict";
import { planQuotas, quotaProgress, underfilledCells, dimensionOf } from "./quotas.js";
import type { AudienceQuotaCell } from "@rescript/schema";

const cell = (id: string, label: string, target: number, criteria: Record<string, unknown>, mode: "count" | "percent" = "percent"): AudienceQuotaCell =>
  ({ id, label, target, mode, criteria });

test("two dimensions each summing to 100 is CORRECT, not 250% of the sample", () => {
  /*
   * The trap this engine exists for. Male 50 / Female 50 and three age bands summing to 100 describe the same
   * respondents along two independent dimensions. A validator that adds up a flat list calls this impossible.
   */
  const p = planQuotas([
    cell("g1", "Male", 50, { gender: "male" }),
    cell("g2", "Female", 50, { gender: "female" }),
    cell("a1", "18–34", 40, { ageBand: "18-34" }),
    cell("a2", "35–54", 35, { ageBand: "35-54" }),
    cell("a3", "55+", 25, { ageBand: "55+" }),
  ], 1000);

  assert.equal(p.ok, true, p.statement);
  assert.deepEqual(p.issues.filter((i) => i.severity === "error"), []);
  assert.equal(p.dimensions.length, 2);
  assert.deepEqual(p.dimensions.map((d) => d.dimension).sort(), ["ageBand", "gender"]);
});

test("percentages become completes against the project target", () => {
  const p = planQuotas([cell("g1", "Male", 50, { gender: "male" })], 1000);
  assert.equal(p.cells[0].targetCompletes, 500);
  assert.equal(planQuotas([cell("g1", "Male", 50, { gender: "male" })], 300).cells[0].targetCompletes, 150);
});

test("a dimension over 100% is refused with the figure, never scaled to fit", () => {
  const p = planQuotas([
    cell("g1", "Male", 60, { gender: "male" }),
    cell("g2", "Female", 60, { gender: "female" }),
  ], 1000);
  assert.equal(p.ok, false);
  assert.match(p.statement, /120%/);
  // the researcher who meant 60/40 needs to know which number was wrong, not have one silently changed
  assert.equal(p.cells.find((c) => c.id === "g1")!.target, 60, "nothing was rewritten");
});

test("a dimension under 100% is a WARNING — the remainder is simply unconstrained", () => {
  const p = planQuotas([cell("g1", "At least 40% women", 40, { gender: "female" })], 1000);
  assert.equal(p.ok, true, "wanting 40% women and not caring about the rest is a valid specification");
  const w = p.issues.find((i) => i.severity === "warning")!;
  assert.match(w.message, /60% is unconstrained/);
});

test("33/33/34 is not an error", () => {
  const p = planQuotas([
    cell("a", "A", 33, { seg: "a" }), cell("b", "B", 33, { seg: "b" }), cell("c", "C", 34, { seg: "c" }),
  ], 900);
  assert.equal(p.ok, true);
  assert.deepEqual(p.issues, [], "a half-point tolerance covers ordinary rounding");
});

test("an interlocked cell is its own dimension, not part of either one it crosses", () => {
  const p = planQuotas([
    cell("g1", "Male", 50, { gender: "male" }),
    cell("g2", "Female", 50, { gender: "female" }),
    cell("x", "Male 18–34", 20, { gender: "male", ageBand: "18-34" }),
  ], 1000);
  assert.equal(p.ok, true, "the cross must not push the gender dimension to 120%");
  const cross = p.cells.find((c) => c.id === "x")!;
  assert.equal(cross.interlocked, true);
  assert.equal(cross.dimension, "ageBand+gender");
  assert.equal(p.dimensions.find((d) => d.dimension === "gender")!.percentTotal, 100);
});

test("an interlocked cell larger than the cell containing it is caught", () => {
  // each number looks reasonable alone, which is why this survives review
  const p = planQuotas([
    cell("g1", "Male", 50, { gender: "male" }),
    cell("x", "Male 18–34", 60, { gender: "male", ageBand: "18-34" }),
  ], 1000);
  assert.equal(p.ok, false);
  assert.match(p.issues.find((i) => i.severity === "error")!.message, /more than the 500 allowed by/);
});

test("fixed counts above the project target are refused", () => {
  const p = planQuotas([
    cell("c1", "London", 700, { city: "London" }, "count"),
    cell("c2", "Manchester", 500, { city: "Manchester" }, "count"),
  ], 1000);
  assert.equal(p.ok, false);
  assert.match(p.statement, /1,200 completes against a target of 1,000/);
});

test("mixing percentages and counts inside one dimension is refused as ambiguous", () => {
  const p = planQuotas([
    cell("g1", "Male", 50, { gender: "male" }),
    cell("g2", "Female", 300, { gender: "female" }, "count"),
  ], 1000);
  assert.equal(p.ok, false);
  assert.match(p.issues[0].message, /mixes percentages and fixed counts/);
});

test("two cells constraining the same group are caught — one would never be used", () => {
  const p = planQuotas([
    cell("a", "Men", 50, { gender: "male" }),
    cell("b", "Male", 50, { gender: "male" }),
  ], 1000);
  assert.equal(p.ok, false);
  assert.match(p.issues.find((i) => i.dimension === "*")!.message, /exactly the same group/);
});

test("the dimension key is stable however the criteria were written", () => {
  assert.equal(dimensionOf({ gender: "male", ageBand: "18-34" }), "ageBand+gender");
  assert.equal(dimensionOf({ ageBand: "18-34", gender: "male" }), "ageBand+gender");
  assert.equal(dimensionOf({}), "*");
});

test("no quotas at all is a valid, stated choice", () => {
  const p = planQuotas([], 1000);
  assert.equal(p.ok, true);
  assert.match(p.statement, /whatever composition arrives/);
});

/* ------------------------------------------------------------ progress */

const twoDims = () => planQuotas([
  cell("g1", "Male", 50, { gender: "male" }),
  cell("g2", "Female", 50, { gender: "female" }),
], 1000);

test("progress reports fill per cell, and over-recruitment as over", () => {
  const p = quotaProgress(twoDims(), { g1: 500, g2: 540 });
  assert.equal(p.find((x) => x.cellId === "g1")!.state, "full");
  const over = p.find((x) => x.cellId === "g2")!;
  assert.equal(over.state, "over", "over-recruitment is reported, not clamped — somebody paid for those");
  assert.equal(over.remaining, 0);
});

test("a cell near its target is flagged before it overshoots", () => {
  const p = quotaProgress(twoDims(), { g1: 455, g2: 100 });
  assert.equal(p.find((x) => x.cellId === "g1")!.state, "nearly_full");
  assert.equal(p.find((x) => x.cellId === "g2")!.state, "open");
});

test("steering favours the emptiest cell and excludes the full ones", () => {
  const order = underfilledCells(quotaProgress(twoDims(), { g1: 500, g2: 100 }));
  assert.deepEqual(order.map((o) => o.cellId), ["g2"], "a full cell is not recruited into");

  const both = underfilledCells(quotaProgress(twoDims(), { g1: 400, g2: 100 }));
  assert.deepEqual(both.map((o) => o.cellId), ["g2", "g1"], "emptiest first");
});

test("an unstarted project reports every cell open, not an error", () => {
  const p = quotaProgress(twoDims(), {});
  assert.deepEqual(p.map((x) => x.state), ["open", "open"]);
  assert.deepEqual(p.map((x) => x.remaining), [500, 500]);
});

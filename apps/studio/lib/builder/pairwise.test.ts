import { test } from "node:test";
import assert from "node:assert/strict";
import { addPair, removePair, pairsFromOptions, unpairedOptions, optionLetter, nextOptionCode } from "./pairwise.ts";

/*
 * PAIRWISE CHOICE — "+ Field" ADDS A WHOLE PAIR (October 2026 review).
 *
 * "Option A / Option B … with a + Field button to add the next pair." A pair
 * is a row naming two options; the builder must never leave a half pair, and
 * removing one comparison must never break another that shares an option.
 */
const q0 = () => ({
  options: [{ code: 1, label: "Option A", flags: [] }, { code: 2, label: "Option B", flags: [] }],
  rows: [{ code: "p1", label: "Pair 1", flags: [], validation: [], required: false, meta: { left: "1", right: "2" } }],
  settings: {},
}) as never;

test("addPair — two new options lettered C and D, and the row that pits them", () => {
  const next = addPair(q0());
  assert.deepEqual(next.options.map((o) => [o.code, o.label]), [[1, "Option A"], [2, "Option B"], [3, "Option C"], [4, "Option D"]]);
  assert.equal(next.rows.length, 2);
  assert.deepEqual(next.rows[1].meta, { left: "3", right: "4" });
  assert.equal(next.rows[1].code, "p2");
  assert.equal(optionLetter(25), "Z");
  assert.equal(optionLetter(26), "AA");
  assert.equal(nextOptionCode([]), 1);
});

test("removePair — drops the pair's own options, keeps one another pair still uses", () => {
  const two = { ...(q0() as object), ...addPair(q0()) } as never;
  const after = removePair(two, 0);
  assert.deepEqual(after.options.map((o) => o.code), [3, 4]);
  assert.deepEqual(after.rows.map((r) => r.code), ["p2"]);
  const shared = {
    options: (q0() as { options: unknown[] }).options.concat([{ code: 3, label: "C", flags: [] }]),
    rows: [
      { code: "p1", meta: { left: "1", right: "2" } },
      { code: "p2", meta: { left: "1", right: "3" } },
    ],
  } as never;
  assert.deepEqual(removePair(shared, 0).options.map((o) => o.code), [1, 3], "option 1 is still in pair 2");
});

test("pairsFromOptions / unpairedOptions — a converted question pairs in order; the odd one is reported, not dropped", () => {
  const opts = [1, 2, 3].map((c) => ({ code: c, label: String(c), flags: [] })) as never[];
  const rows = pairsFromOptions(opts as never);
  assert.deepEqual(rows.map((r) => r.meta), [{ left: "1", right: "2" }]);
  assert.deepEqual(unpairedOptions({ options: opts, rows } as never).map((o) => o.code), [3]);
});

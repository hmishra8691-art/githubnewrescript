import { test } from "node:test";
import assert from "node:assert/strict";
import { moveItem, rankOptions, ranksInStep, optionsForResponse } from "./cards.ts";

/*
 * SWIPE CARDS (October 2026 review) — a card's fields reorder, and Swipe to
 * Rate / Rank / Categorize's response type, whose options follow it.
 */
test("moveItem — swaps neighbours; the ends do nothing", () => {
  assert.deepEqual(moveItem(["a", "b", "c"], 0, 1), ["b", "a", "c"]);
  assert.deepEqual(moveItem(["a", "b", "c"], 2, -1), ["a", "c", "b"]);
  assert.deepEqual(moveItem(["a", "b"], 0, -1), ["a", "b"]);
  assert.deepEqual(moveItem(["a", "b"], 1, 1), ["a", "b"]);
});

test("rank — the options are Rank 1…N, one per card", () => {
  assert.deepEqual(rankOptions(3).map((o) => [o.code, o.label]), [[1, "Rank 1"], [2, "Rank 2"], [3, "Rank 3"]]);
  assert.equal(rankOptions(0).length, 1);
  assert.ok(ranksInStep(rankOptions(3), 3));
  assert.ok(!ranksInStep(rankOptions(3), 4), "a card added → the ranks must grow");
  assert.ok(!ranksInStep([{ code: 1, label: "Like" }, { code: 2, label: "Rank 2" }] as never, 2));
  const q = { options: [{ code: "x", label: "X" }], rows: [{}, {}], settings: {} } as never;
  assert.deepEqual(optionsForResponse("rank", q).map((o) => o.code), [1, 2]);
  assert.deepEqual(optionsForResponse("categorize", q), (q as { options: unknown }).options, "rate → categorize keeps the author's options");
  const ranked = { options: rankOptions(2), rows: [{}, {}], settings: { swipeResponse: "rank" } } as never;
  assert.deepEqual(optionsForResponse("categorize", ranked).map((o) => o.label), ["Like", "Neutral", "Dislike"], "leaving rank never keeps Rank 1…N as categories");
  assert.deepEqual(optionsForResponse("rate", ranked).map((o) => o.code), [1, 2, 3, 4, 5]);
});

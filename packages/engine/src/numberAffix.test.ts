import { test } from "node:test";
import assert from "node:assert/strict";
import { affixFor, customAffix, numericBoxCh } from "./formats.js";

/*
 * NUMERIC — CUSTOM TEXT BESIDE THE BOX, AND A BOX ITS SIZE (October 2026
 * review): "Left: kg [ 50 ] / Right: [ 50 ] kg" in every Numeric subtype;
 * Currency's "or type a symbol" removed so the selected currency shows; a
 * Numeric List box sized by the system.
 */
test("affixFor — the selected currency wins over an older typed symbol", () => {
  assert.deepEqual(affixFor({ currencyCode: "USD", currencySymbol: "₹" }), { text: "$", side: "left" }, "the screenshot: USD selected, ₹ typed → $ shown");
  assert.deepEqual(affixFor({ currencySymbol: "pts", symbolSide: "right" }), { text: "pts", side: "right" }, "no currency selected: an older symbol still shows");
  assert.deepEqual(affixFor({ currencySymbol: "%", symbolSide: "right" }), { text: "%", side: "right" });
  assert.equal(affixFor({}), null);
});

test("customAffix — any text, left or right; Quantity's older unit is the same thing on the right", () => {
  assert.deepEqual(customAffix({ affixText: "kg", affixSide: "left" }), { text: "kg", side: "left" });
  assert.deepEqual(customAffix({ affixText: "per month" }), { text: "per month", side: "right" }, "right by default");
  assert.deepEqual(customAffix({ unitLabel: "boxes" }), { text: "boxes", side: "right" });
  assert.deepEqual(customAffix({ affixText: "items", unitLabel: "boxes", affixSide: "left" }), { text: "items", side: "left" }, "the new text wins");
  assert.equal(customAffix({ affixText: "  " }), null);
  assert.equal(customAffix(undefined), null);
});

test("numericBoxCh — sized from the bounds and decimals, never by hand; compact by default", () => {
  assert.equal(numericBoxCh({}), 8, "unbounded: compact, not the width of the card");
  assert.equal(numericBoxCh({ max: 100, whole: true }), 6, "small numbers: the minimum");
  assert.equal(numericBoxCh({ max: 1000000, decimals: 2 }), 12, "large currency: room for the digits and the decimals");
  assert.ok(numericBoxCh({ min: -50000, max: 50000, whole: true }) > numericBoxCh({ min: 0, max: 50000, whole: true }), "room for a minus sign");
  assert.equal(numericBoxCh({ max: 1e20 }), 18, "capped");
});

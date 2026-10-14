import test from "node:test";
import assert from "node:assert/strict";
import { formattingOf } from "../components/analytics/tableFormatting.ts";

const withF = (f: unknown) => ({ provenance: { definition: { options: { formatting: f } } } });

test("C-11: the formatting saved with an analysis is read from the result that carries its definition", () => {
  assert.deepEqual(formattingOf(withF({ heat: true, showCounts: true, decimals: 2, junk: 1 })), { heat: true, showCounts: true, decimals: 2 });
  assert.deepEqual(formattingOf(withF({ highlightSig: true, dense: true })), { highlightSig: true, dense: true });
});

test("C-11: nothing saved, nothing readable, or nonsense is no formatting — never an error", () => {
  assert.equal(formattingOf(undefined), undefined);
  assert.equal(formattingOf({}), undefined);
  assert.equal(formattingOf(withF(undefined)), undefined);
  assert.equal(formattingOf(withF("heat")), undefined);
  assert.equal(formattingOf(withF([1])), undefined);
  assert.equal(formattingOf(withF({ heat: "yes", decimals: "2" })), undefined);
  assert.deepEqual(formattingOf(withF({ decimals: 9 })), { decimals: 4 }, "clamped to what a table can show");
});

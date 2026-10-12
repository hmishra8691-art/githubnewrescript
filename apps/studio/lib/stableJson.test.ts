import test from "node:test";
import assert from "node:assert/strict";
import { stableStringify } from "./stableJson.ts";

test("key order does not change the string; values and array order do", () => {
  assert.equal(stableStringify({ dataset: { environment: "LIVE", dataset: "all" }, a: 1 }), stableStringify({ a: 1, dataset: { dataset: "all", environment: "LIVE" } }));
  assert.notEqual(stableStringify({ a: [1, 2] }), stableStringify({ a: [2, 1] }));
  assert.notEqual(stableStringify({ a: 1 }), stableStringify({ a: 2 }));
  assert.equal(stableStringify(null), "null");
  assert.equal(stableStringify({ a: undefined, b: 1 }), stableStringify({ b: 1 }));
});

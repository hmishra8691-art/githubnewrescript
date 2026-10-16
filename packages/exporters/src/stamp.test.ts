import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { definitionHash, sha256Hex, stableJson } from "./stamp.js";

test("the browser-safe SHA-256 equals node:crypto on short, block-edge and multi-byte input", () => {
  for (const s of ["", "abc", "x".repeat(55), "x".repeat(56), "x".repeat(64), "x".repeat(1000), "Größe — 日本語 😀"]) {
    assert.equal(sha256Hex(s), createHash("sha256").update(s).digest("hex"), JSON.stringify(s).slice(0, 20));
  }
});

test("definitionHash ignores key order and undefined, and changes with content", () => {
  assert.equal(definitionHash({ a: 1, b: [1, 2] }), definitionHash({ b: [1, 2], a: 1, c: undefined }));
  assert.notEqual(definitionHash({ a: 1 }), definitionHash({ a: 2 }));
  assert.equal(stableJson({ b: 1, a: 2 }), '{"a":2,"b":1}');
});

import { test } from "node:test";
import assert from "node:assert/strict";
import { isStaleSave, parseSaveSeq, resumeSeq } from "./saveSeq.ts";

test("D6: parseSaveSeq accepts positive safe integers only", () => {
  assert.equal(parseSaveSeq(1), 1);
  assert.equal(parseSaveSeq("42"), 42);
  for (const bad of [0, -1, 1.5, "x", null, undefined, Number.MAX_SAFE_INTEGER + 2, "1e3", {}]) assert.equal(parseSaveSeq(bad), null, String(bad));
});

test("D6: an older or equal intermediate save is stale; a newer one, a final one and an unnumbered one are not", () => {
  assert.equal(isStaleSave(2, 1, false), true, "older");
  assert.equal(isStaleSave(2, 2, false), true, "equal (a retried save already applied)");
  assert.equal(isStaleSave(2, 3, false), false, "newer");
  assert.equal(isStaleSave(5, 1, true), false, "the final save is guarded by status, not seq");
  assert.equal(isStaleSave(5, null, false), false, "an old client without seq saves as before");
  assert.equal(isStaleSave(undefined, 1, false), false, "a row before 0078 (no column)");
});

test("D6: a resumed session continues from the larger of the server's and the pending cache's seq", () => {
  assert.equal(resumeSeq(7, 9), 9);
  assert.equal(resumeSeq(7, undefined), 7);
  assert.equal(resumeSeq(undefined, undefined), 0);
  assert.equal(resumeSeq("12", 3), 12);
  assert.equal(resumeSeq(-4, "x"), 0);
});

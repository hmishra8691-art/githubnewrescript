import { test } from "node:test";
import assert from "node:assert/strict";
import { shouldSnapshotDraft } from "./draftSnapshot.ts";

/*
 * R6 — restoring a version clears the draft. These are the two ways to get
 * the "should we save it first?" decision wrong, and they fail in opposite
 * directions: one loses an afternoon's work, the other buries the version
 * list under snapshots of nothing.
 */

const defn = (title: string, questions: unknown[] = []) => ({
  meta: { id: "s", code: "S", title },
  questions,
  flow: [{ type: "page", id: "p1", questionIds: [] }],
});

test("a draft that differs from the version being restored IS saved first", () => {
  /* the whole point: this is somebody's unsaved work */
  assert.equal(shouldSnapshotDraft(defn("Tuesday's edits"), defn("Last week")), true);
});

test("a draft identical to the version being restored is NOT saved", () => {
  /*
   * Nothing would be lost, so a snapshot here is pure noise — and noise in
   * the version list is what stops anyone reading it when it matters.
   */
  assert.equal(shouldSnapshotDraft(defn("Same"), defn("Same")), false);
});

test("key order is not a difference", () => {
  /*
   * Without canonical comparison, a draft that had merely been round-tripped
   * through a different serialiser would look different from the version it
   * is identical to, and EVERY restore would cut a snapshot. The version list
   * fills up, and the feature that exists to make restore safe is the thing
   * that makes it unusable.
   */
  const a = { meta: { code: "S", id: "s", title: "T" }, questions: [], flow: [] };
  const b = { flow: [], questions: [], meta: { title: "T", id: "s", code: "S" } };
  assert.equal(shouldSnapshotDraft(a, b), false);
});

test("a nested difference is still a difference", () => {
  /* the common real case: one question's text changed, nothing else */
  const a = defn("T", [{ id: "q1", text: "How old are you?" }]);
  const b = defn("T", [{ id: "q1", text: "What is your age?" }]);
  assert.equal(shouldSnapshotDraft(a, b), true);
});

test("array order is a difference — reordering questions is real work", () => {
  const a = defn("T", [{ id: "q1" }, { id: "q2" }]);
  const b = defn("T", [{ id: "q2" }, { id: "q1" }]);
  assert.equal(shouldSnapshotDraft(a, b), true, "a reorder must not be mistaken for no change");
});

test("no draft at all means nothing to save", () => {
  for (const empty of [null, undefined, "", 0, false]) {
    assert.equal(shouldSnapshotDraft(empty, defn("x")), false, `${JSON.stringify(empty)} was treated as work`);
  }
});

test("an empty object is not work", () => {
  /*
   * A cleared draft can come back as `{}` rather than null depending on how
   * it was cleared. Snapshotting that would produce a version containing no
   * survey at all, which is worse than useless: it is restorable.
   */
  assert.equal(shouldSnapshotDraft({}, defn("x")), false);
});

test("a draft is compared against the version being RESTORED, not against nothing", () => {
  /*
   * A null target (the version row could not be read) must count as
   * different, so the draft is preserved. Failing safe here means one extra
   * version; failing unsafe means somebody's work is gone.
   */
  assert.equal(shouldSnapshotDraft(defn("work"), null), true);
});

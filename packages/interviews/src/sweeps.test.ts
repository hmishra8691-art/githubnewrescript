import test from "node:test";
import assert from "node:assert/strict";
import {
  ABANDON_UPLOAD_AFTER_MS, MAX_DELETIONS_PER_SWEEP, ORPHAN_AFTER_MS,
  findOrphans, isAbandonedUpload, isRetentionDue, orphanSweepIsSane, retentionPlan,
} from "./sweeps.js";

/*
 * Deletion is the one operation here that cannot be undone, and what it
 * deletes is somebody's research. So every test below is a way a sweep could
 * remove something it should not have, and the defaults all fall towards
 * keeping.
 */

const NOW = new Date("2026-06-01T12:00:00Z");
const daysAgo = (n: number) => new Date(NOW.getTime() - n * 86_400_000).toISOString();
const hoursAgo = (n: number) => new Date(NOW.getTime() - n * 3_600_000).toISOString();

/* ------------------------------------------------------------- retention */

test("an unset scope removes the recordings and nothing else", () => {
  /*
   * The asymmetry that matters. Somebody writing `retention_days: 90` is
   * asking to stop holding video; they are not asking for the analysis a
   * colleague wrote a report from to be destroyed.
   */
  const p = retentionPlan(undefined);
  assert.equal(p.media, true);
  assert.equal(p.transcripts, false);
  assert.equal(p.analysis, false);
  assert.equal(p.empty, false);
});

test("transcripts and analysis are removed only when asked for explicitly", () => {
  assert.equal(retentionPlan({ transcripts: true }).transcripts, true);
  assert.equal(retentionPlan({ analysis: true }).analysis, true);
  /* not "truthy" — explicitly true */
  assert.equal(retentionPlan({ transcripts: 1 as unknown as boolean }).transcripts, false);
});

test("a scope that removes nothing says so, so the sweep can skip the interview", () => {
  const p = retentionPlan({ media: false, transcripts: false, analysis: false });
  assert.equal(p.empty, true);
});

test("no retention period means nothing is ever due", () => {
  const iv = { completedAt: daysAgo(3650), mediaPurgedAt: null };
  assert.equal(isRetentionDue(iv, null, NOW), false);
  assert.equal(isRetentionDue(iv, 0, NOW), false);
  assert.equal(isRetentionDue(iv, undefined, NOW), false);
});

test("an interview that never completed is never due", () => {
  /*
   * A sitting somebody abandoned halfway has no completion date, and dating
   * retention from its creation would delete an interview that is still open.
   */
  assert.equal(isRetentionDue({ completedAt: null, mediaPurgedAt: null }, 30, NOW), false);
});

test("retention is due only once the period has actually passed", () => {
  assert.equal(isRetentionDue({ completedAt: daysAgo(29), mediaPurgedAt: null }, 30, NOW), false);
  assert.equal(isRetentionDue({ completedAt: daysAgo(31), mediaPurgedAt: null }, 30, NOW), true);
});

test("an interview already purged is not purged again", () => {
  assert.equal(
    isRetentionDue({ completedAt: daysAgo(400), mediaPurgedAt: daysAgo(10) }, 30, NOW),
    false,
  );
});

test("an unreadable completion date is not a reason to delete", () => {
  assert.equal(isRetentionDue({ completedAt: "not a date", mediaPurgedAt: null }, 30, NOW), false);
});

/* ----------------------------------------------------- abandoned uploads */

test("an upload is given two hours — the life of its signed URLs", () => {
  assert.equal(ABANDON_UPLOAD_AFTER_MS, 2 * 60 * 60 * 1000);
  assert.equal(isAbandonedUpload({ uploadStatus: "uploading", createdAt: hoursAgo(1) }, NOW), false);
  assert.equal(isAbandonedUpload({ uploadStatus: "uploading", createdAt: hoursAgo(3) }, NOW), true);
});

test("A LONG SESSION STILL IN PROGRESS IS NOT ABANDONED", () => {
  /* Ninety minutes of interview on a train is exactly who must not be cut off. */
  assert.equal(isAbandonedUpload({ uploadStatus: "uploading", createdAt: hoursAgo(1.5) }, NOW), false);
});

test("a finished or failed upload is not swept, whatever its age", () => {
  for (const status of ["stored", "failed", "deleted"]) {
    assert.equal(
      isAbandonedUpload({ uploadStatus: status, createdAt: hoursAgo(100) }, NOW), false, status,
    );
  }
});

/* ------------------------------------------------------------- orphans */

test("an object a row claims is never an orphan, however old", () => {
  const d = findOrphans(
    [{ key: "a", lastModified: daysAgo(400) }],
    new Set(["a"]),
    NOW,
  );
  assert.deepEqual(d.orphans, []);
  assert.deepEqual(d.claimed, ["a"]);
});

test("a recent unclaimed object is too new to judge", () => {
  /* An upload finishing right now has bytes in the bucket and no row yet. */
  const d = findOrphans([{ key: "a", lastModified: hoursAgo(1) }], new Set(), NOW);
  assert.deepEqual(d.orphans, []);
  assert.deepEqual(d.tooNew, ["a"]);
});

test("an old unclaimed object is an orphan", () => {
  assert.equal(ORPHAN_AFTER_MS, 24 * 60 * 60 * 1000);
  const d = findOrphans([{ key: "a", lastModified: daysAgo(3) }], new Set(), NOW);
  assert.deepEqual(d.orphans, ["a"]);
});

test("AN OBJECT WITH NO DATE IS KEPT, NOT DELETED", () => {
  /*
   * "The store could not tell us how old this is" is not evidence that nobody
   * wants it. Defaulting the other way makes a store quirk into data loss.
   */
  for (const lastModified of [null, "", "nonsense"]) {
    const d = findOrphans([{ key: "a", lastModified: lastModified as never }], new Set(), NOW);
    assert.deepEqual(d.orphans, [], JSON.stringify(lastModified));
    assert.deepEqual(d.tooNew, ["a"]);
  }
});

test("a deleted row still counts as claiming its key", () => {
  /*
   * A row marked deleted whose object is still there is a pending deletion,
   * not an orphan — and treating it as one races the retention sweep to the
   * same object.
   */
  const d = findOrphans([{ key: "gone", lastModified: daysAgo(30) }], new Set(["gone"]), NOW);
  assert.deepEqual(d.orphans, []);
});

/* --------------------------------------------------------- the safety net */

test("A SWEEP THAT WANTS TO DELETE MOST OF THE BUCKET IS REFUSED", () => {
  /*
   * The failure this exists for: the listing works, the database lookup
   * silently returns nothing, and every object looks unclaimed. The proportion
   * is the signal, and it is checked BEFORE anything is deleted.
   */
  const decision = { orphans: ["a", "b", "c", "d"], tooNew: [], claimed: [] };
  const verdict = orphanSweepIsSane(decision, 4);
  assert.equal(verdict.ok, false);
  assert.match(!verdict.ok ? verdict.reason : "", /failed lookup/);
  assert.match(!verdict.ok ? verdict.reason : "", /nothing was deleted/);
});

test("a plausible backlog passes", () => {
  const decision = { orphans: ["a"], tooNew: [], claimed: ["b", "c", "d", "e", "f"] };
  assert.equal(orphanSweepIsSane(decision, 6).ok, true);
});

test("finding no orphans at all is always sane", () => {
  assert.equal(orphanSweepIsSane({ orphans: [], tooNew: [], claimed: [] }, 0).ok, true);
});

test("the blast radius is small on purpose", () => {
  /* Nobody has ever wished a deletion sweep had been faster. */
  assert.ok(MAX_DELETIONS_PER_SWEEP <= 200, "a cap this side of a catastrophe");
  assert.ok(MAX_DELETIONS_PER_SWEEP >= 10, "but large enough to clear a real backlog");
});

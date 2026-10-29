import { test } from "node:test";
import assert from "node:assert/strict";
import { DRIVE_FAST_MS, DRIVE_IDLE_CAP_MS, completedOf, driveOf, driveWait } from "./taskDrive.ts";

const step = (status: string) => ({ status });

test("driveOf: a running task with nothing claimable stops the page (the 2026-10-30 hot loop)", () => {
  /* every step done, the deliverable check not passed: the task stays running, nothing can be claimed */
  assert.equal(driveOf({ status: "running", steps: [step("completed"), step("completed")] }), "stop");
  /* the only outstanding step failed for good */
  assert.equal(driveOf({ status: "running", steps: [step("completed"), step("failed")] }), "stop");
  /* blocked by a re-plan and tombstoned steps are not claimable either */
  assert.equal(driveOf({ status: "running", steps: [step("tombstoned"), step("blocked")] }), "stop");
});

test("driveOf: a task with a claimable step is advanced", () => {
  assert.equal(driveOf({ status: "running", steps: [step("completed"), step("pending")] }), "advance");
  assert.equal(driveOf({ status: "running", steps: [step("retrying")] }), "advance");
  /* leased by another worker: may lapse, so the page keeps going — slowly (driveWait) */
  assert.equal(driveOf({ status: "running", steps: [step("running")] }), "advance");
  assert.equal(driveOf({ status: "pending", steps: [step("pending")] }), "advance");
  /* a pending task whose steps are not written yet */
  assert.equal(driveOf({ status: "pending", steps: [] }), "advance");
});

test("driveOf: finished, paused or cancelled tasks are never advanced", () => {
  for (const status of ["completed", "failed", "cancelled", "needs_attention"]) assert.equal(driveOf({ status, steps: [step("pending")] }), "stop", status);
  assert.equal(driveOf({ status: "running", steps: [] }), "stop");
  assert.equal(driveOf({ status: "running", steps: null }), "stop");
});

test("driveWait: fast while steps complete, then 2 s → 4 s → 8 s → 15 s when slices build nothing", () => {
  const w = (idle: number, extra: Partial<Parameters<typeof driveWait>[0]> = {}) => driveWait({ viewed: true, fails: 0, drive: true, idle, ...extra });
  assert.equal(w(0), DRIVE_FAST_MS);
  assert.deepEqual([1, 2, 3, 4, 5, 40].map((i) => w(i)), [2000, 4000, 8000, DRIVE_IDLE_CAP_MS, DRIVE_IDLE_CAP_MS, DRIVE_IDLE_CAP_MS]);
  /* 60 seconds of a stuck task is now at most a handful of requests, not 240 */
  let t = 0, n = 0;
  for (let i = 1; t < 60_000; i++) { t += w(i); n++; }
  assert.ok(n <= 8, `${n} requests in a minute`);
});

test("driveWait: the server's own waits win when they are longer; a dropped connection backs off; polling is 2.5 s", () => {
  const base = { viewed: true, fails: 0, drive: true, idle: 0 };
  assert.equal(driveWait({ ...base, retryAfterMs: 7000 }), 7000);
  assert.equal(driveWait({ ...base, retryAfterMs: 120_000 }), 60_000);
  assert.equal(driveWait({ ...base, stoppedBy: "backoff" }), 3000);
  assert.equal(driveWait({ ...base, idle: 4, stoppedBy: "backoff" }), DRIVE_IDLE_CAP_MS);
  assert.equal(driveWait({ ...base, viewed: false, fails: 1 }), 2000);
  assert.equal(driveWait({ ...base, viewed: false, fails: 9 }), 30_000);
  assert.equal(driveWait({ ...base, drive: false }), 2500);
});

test("completedOf reads the view's progress, 0 when absent", () => {
  assert.equal(completedOf({ progress: { completed: 7 } }), 7);
  assert.equal(completedOf(null), 0);
  assert.equal(completedOf({}), 0);
});

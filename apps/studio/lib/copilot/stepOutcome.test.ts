import { test } from "node:test";
import assert from "node:assert/strict";
import { stepOutcome, taskOutcome } from "./stepOutcome.ts";
import { executionView } from "./deliverable.ts";

/**
 * THE STATUS A RESEARCHER SEES, for the scenarios in the 2026-11-07 bug report. Every case is computed from the
 * step rows alone — the same rows a reload reads — so a refreshed page shows exactly the same thing.
 */
const step = (stepId: string, status: string, extra: Record<string, unknown> = {}) => ({ stepId, status, retryCount: 0, title: stepId, dependsOn: [], ...extra }) as never;

test("1. success on the first attempt is Done; 2. success after retries is Done — retry successful, never failed", () => {
  assert.deepEqual(stepOutcome({ status: "completed", retryCount: 0 }, "running"), { label: "Done", tone: "ok", final: true });
  const r = stepOutcome({ status: "completed", retryCount: 2 }, "completed");
  assert.equal(r.label, "Done — retry successful (3 attempts)");
  assert.equal(r.tone, "ok");
  const v = executionView({ status: "completed", steps: [step("a", "completed", { retryCount: 2 }), step("b", "completed")] } as never);
  assert.equal(v.phase, "done");
  assert.equal(v.failed, 0);
  assert.equal(v.recovery.message, null, "no retry message once the retried step succeeded");
});

test("a completed step whose own check failed is not plain Done", () => {
  assert.equal(stepOutcome({ status: "completed", validation: { status: "invalid" } }, "running").label, "Done — check failed");
});

test("4. three of four steps done reads as partial progress, not failure", () => {
  const t = { status: "running", steps: [step("a", "completed"), step("b", "completed"), step("c", "completed"), step("d", "pending")] };
  assert.equal(taskOutcome(t as never).label, "Partially complete — 3 of 4 steps done");
  const v = executionView(t as never);
  assert.equal(v.completed, 3);
  assert.equal(v.phase, "building");
});

test("5–6. a cancelled task keeps its finished steps Done; the steps it never ran say so; nothing claims to be retrying", () => {
  const t = { status: "cancelled", steps: [step("w1", "completed", { retryCount: 2 }), step("w2", "failed", { retryCount: 4, failureKind: "invalid_output", failureMessage: "no usable question" }), step("w3", "failed", { retryCount: 1, failureKind: "invalid_output" }), step("check", "pending")] };
  const v = executionView(t as never);
  assert.equal(v.phase, "cancelled");
  assert.match(v.headline, /^Cancelled — 1 of 4 steps done, 2 failed; what the finished steps built is kept$/);
  assert.ok(!/retrying/.test(v.recovery.message ?? ""), v.recovery.message ?? "");
  assert.match(v.recovery.message ?? "", /Before the task was cancelled, 2 steps had failed/);
  assert.deepEqual(v.rows.map((r) => r.outcome), ["Done — retry successful (3 attempts)", "Failed after 4 attempts", "Failed after 1 attempt", "Not run — task cancelled"]);
  assert.equal(v.currentStep, null, "a stopped task has no current step");
});

test("7. parallel steps each keep their own state; 8. a step out of its one retry needs attention, not 'recovering'", () => {
  const open = executionView({ status: "running", steps: [step("a", "running"), step("b", "running"), step("c", "retrying", { retryCount: 1, failureKind: "invalid_output" })] } as never);
  assert.equal(open.phase, "recovering", "one attempt failed, its one retry is coming");
  assert.equal(open.rows[2].outcome, "Retrying — attempt 2");
  const spent = executionView({ status: "running", steps: [step("a", "completed"), step("c", "failed", { retryCount: 3, failureKind: "invalid_output", failureMessage: "x" })] } as never);
  assert.equal(spent.phase, "needs attention");
  assert.equal(spent.rows[1].outcome, "Failed after 3 attempts");
});

test("a paused task's queued steps wait for the person; a stopped task's running step is not 'Running'", () => {
  assert.equal(stepOutcome({ status: "pending" }, "needs_attention").label, "Waiting for you");
  assert.equal(stepOutcome({ status: "running" }, "cancelled").label, "Stopped while running");
});

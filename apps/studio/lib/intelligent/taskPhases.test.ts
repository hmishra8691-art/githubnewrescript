import { test } from "node:test";
import assert from "node:assert/strict";
import { taskPhases } from "./taskPhases.ts";
import { researcherOutcome } from "../copilot/stepOutcome.ts";

const st = (stepId: string, kind: string, status: string, retryCount = 0) => ({ stepId, kind, status, retryCount, dependsOn: [], planVersion: 1 }) as never;

test("the researcher sees four phases from the rows — never which agent holds which step", () => {
  const running = taskPhases({ status: "running", steps: [st("a", "gen.batch", "completed"), st("b", "gen.batch", "running"), st("v", "gen.validate", "pending")] });
  assert.deepEqual(running.map((p) => [p.id, p.state]), [["plan", "done"], ["work", "active"], ["check", "waiting"], ["ready", "waiting"]]);
  assert.match(running[1].detail, /1 of 2 done · 1 in progress/);
  assert.ok(running.every((p) => !/agent|writer|validation/i.test(p.detail + p.label)));
  const done = taskPhases({ status: "completed", steps: [st("a", "gen.batch", "completed"), st("v", "gen.validate", "completed")] });
  assert.deepEqual(done.map((p) => p.state), ["done", "done", "done", "done"]);
  const waiting = taskPhases({ status: "needs_attention", blocked: { message: "2 problems remain" }, steps: [st("a", "gen.batch", "completed"), st("v", "gen.validate", "completed")] });
  assert.equal(waiting[3].state, "attention");
  assert.equal(waiting[3].detail, "Needs you", "the reason itself is shown once, under the steps");
});

test("an automatic retry is the system's business: 'Working on it', never 'Failed attempt 1'; a final failure says it couldn't finish", () => {
  assert.equal(researcherOutcome({ status: "failed", retryCount: 0 }, "running").label, "Working on it");
  assert.equal(researcherOutcome({ status: "retrying", retryCount: 1 }, "running").label, "Working on it");
  assert.equal(researcherOutcome({ status: "completed", retryCount: 1 }, "running").label, "Done");
  assert.equal(researcherOutcome({ status: "failed", retryCount: 2 }, "failed").label, "Couldn't finish");
  assert.equal(researcherOutcome({ status: "completed", validation: { status: "invalid" } }, "completed").label, "Done — needs a look");
});

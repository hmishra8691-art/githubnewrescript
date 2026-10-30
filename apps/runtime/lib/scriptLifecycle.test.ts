import test from "node:test";
import assert from "node:assert/strict";
import { runScriptLifecycle, type AskFrames } from "./scriptLifecycle.ts";

const page = { questions: [{ id: "q1", code: "Q1", variableName: "AGE" }, { id: "q2", code: "Q2" }] };

test("validate: errors map to the page's questions (by id, code or variable), the rest to the page banner", async () => {
  const ask: AskFrames = async (ev) => {
    assert.equal(ev, "validate");
    return [
      { script: "A", errors: [{ message: "Too young", ref: "AGE" }, { message: "Pick one", ref: "q2" }] },
      { script: "B", errors: [{ message: "Something about the page" }, { message: "Elsewhere", ref: "Q99" }, { message: "  " }] },
    ];
  };
  const r = await runScriptLifecycle(ask, "validate", page);
  assert.deepEqual(r.errors, [
    { questionId: "q1", message: "Too young" },
    { questionId: "q2", message: "Pick one" },
    { questionId: "", message: "Something about the page" },
    { questionId: "", message: "Elsewhere" },
  ]);
  assert.match(r.logs.join("\n"), /“Q99” is not a question on this page/);
  assert.equal(r.asked, 2);
});

test("a frame that does not answer in time is treated as no error and logged; a stuck round is bounded too", async () => {
  const one: AskFrames = async () => [{ script: "Slow", timedOut: true }, { script: "Fine", errors: [] }];
  const r1 = await runScriptLifecycle(one, "validate", page, 50);
  assert.deepEqual(r1.errors, []);
  assert.equal(r1.timedOut, 1);
  assert.match(r1.logs[0], /“Slow”.*no answer within 50 ms — treated as no error/);
  // the whole round never resolves: the helper's own bound lets the respondent go
  const t0 = Date.now();
  const r2 = await runScriptLifecycle(() => new Promise(() => {}), "validate", page, 50);
  assert.ok(Date.now() - t0 < 1000, "bounded");
  assert.deepEqual(r2.errors, []);
  assert.match(r2.logs[0], /no answer within 50 ms/);
  // a throwing ask: no error, logged
  const r3 = await runScriptLifecycle(async () => { throw new Error("frame gone"); }, "validate", page);
  assert.deepEqual(r3.errors, []);
  assert.match(r3.logs[0], /frame gone/);
});

test("submit: rs.error does not stop the page (logged); no frames, nothing to do", async () => {
  const r = await runScriptLifecycle(async () => [{ script: "S", errors: [{ message: "late" }] }], "submit", page);
  assert.deepEqual(r.errors, []);
  assert.match(r.logs[0], /ignored \(use "validate"\)/);
  assert.deepEqual(await runScriptLifecycle(null, "validate", page), { errors: [], logs: [], asked: 0, timedOut: 0 });
});

test("errors are capped at 20 per page", async () => {
  const many = Array.from({ length: 30 }, (_, i) => ({ message: `e${i}` }));
  const r = await runScriptLifecycle(async () => [{ script: "X", errors: many }], "validate", page);
  assert.equal(r.errors.length, 20);
});

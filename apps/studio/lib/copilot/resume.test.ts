import { test } from "node:test";
import assert from "node:assert/strict";
import { CHECKPOINT_TTL_MS, clearCheckpoint, failureOfResponse, interruptedFailure, isTemporary, loadCheckpoint, mergeBuilt, pausedFailure, pendingIds, saveCheckpoint, STATUS, TASK_RESUME_ENV, taskDualWriteEnabled, taskResumeEnabled, waitBeforeRetry, type Checkpoint } from "./resume.ts";
import { describeFailure } from "./failure.ts";

const mem = () => { const m = new Map<string, string>(); return { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => { m.set(k, v); }, removeItem: (k: string) => { m.delete(k); }, _m: m }; };
const cp = (over: Partial<Checkpoint> = {}): Checkpoint => ({ v: 1, entryId: "e1", surveyId: "s1", text: "Create a customer satisfaction survey", kind: "build", items: ["a", "b", "c"], built: [{ id: "a", raw: { actions: [] } }], failed: [], at: 1_000, ...over });

test("a checkpoint survives a reload: the words, the plan's items and what was built", () => {
  const st = mem();
  assert.equal(saveCheckpoint(st, cp()), true);
  const back = loadCheckpoint(st, "s1", 2_000)!;
  assert.equal(back.text, "Create a customer satisfaction survey");
  assert.deepEqual(back.built.map((b) => b.id), ["a"]);
  assert.equal(loadCheckpoint(st, "another-survey", 2_000), null);
  clearCheckpoint(st, "s1");
  assert.equal(loadCheckpoint(st, "s1", 2_000), null);
});

test("a stale or damaged checkpoint is let go, never trusted", () => {
  const st = mem();
  saveCheckpoint(st, cp());
  assert.equal(loadCheckpoint(st, "s1", 1_000 + CHECKPOINT_TTL_MS + 1), null);
  st.setItem("rescript.copilot.checkpoint.s1", "{not json");
  assert.equal(loadCheckpoint(st, "s1"), null);
  assert.equal(saveCheckpoint(null, cp()), false);
});

test("a storage that is full still keeps the request and the plan", () => {
  let writes = 0;
  const st = { getItem: () => null, removeItem: () => {}, setItem: (_k: string, v: string) => { writes++; if (v.length > 400) throw new Error("QuotaExceededError"); } };
  assert.equal(saveCheckpoint(st, cp({ built: [{ id: "a", raw: { big: "x".repeat(2000) } }] })), false);
  assert.equal(writes, 2, "the second, smaller write was tried");
});

test("retrying never duplicates: an item built twice is one item, the later reply", () => {
  const m = mergeBuilt([{ id: "a", raw: 1 }, { id: "b", raw: 2 }], [{ id: "b", raw: 3 }, { id: "c", raw: 4 }]);
  assert.deepEqual(m.map((x) => x.id), ["a", "b", "c"]);
  assert.equal(m.find((x) => x.id === "b")!.raw, 3);
});

test("pending is what was asked, minus what is built or failed — completed, pending and failed are told apart", () => {
  assert.deepEqual(pendingIds(["a", "b", "c", "d"], [{ id: "a", raw: 0 }], [{ id: "c" }]), ["b", "d"]);
  assert.deepEqual(pendingIds(["a"], [{ id: "a", raw: 0 }], []), []);
});

test("the wait is what the provider asked for, else a growing jittered pause — bounded", () => {
  assert.equal(waitBeforeRetry({ retryAfterMs: 20_000 }, 0), 20_000);
  assert.equal(waitBeforeRetry({ retryAfterMs: 100 }, 0), 1500, "never an instant hammering");
  assert.equal(waitBeforeRetry({ retryAfterMs: 9_999_999 }, 0), 120_000);
  assert.equal(waitBeforeRetry({}, 0, () => 0), 1500);
  assert.equal(waitBeforeRetry({}, 3, () => 1), 24_000);
  assert.equal(waitBeforeRetry({}, 30, () => 1), 60_000);
});

test("a response with no JSON — the platform's time limit, a gateway page, a dropped connection — is temporary", () => {
  assert.equal(isTemporary({ status: 504, ok: false, d: null }), true);
  assert.equal(isTemporary({ status: 0, ok: false, d: null }), true);
  assert.equal(isTemporary({ status: 200, ok: true, d: { ok: true } }), false);
  assert.equal(isTemporary({ status: 503, ok: false, d: { ok: false, failure: describeFailure("capacity") } }), true);
  assert.equal(isTemporary({ status: 502, ok: false, d: { ok: false, failure: describeFailure("auth") } }), false, "a refused key is not retried");
  assert.equal(isTemporary({ status: 402, ok: false, d: { ok: false, failure: describeFailure("wallet") } }), false);
  assert.equal(failureOfResponse({ status: 504, ok: false, d: null })!.code, "timeout");
  assert.equal(failureOfResponse({ status: 503, ok: false, d: { failure: describeFailure("capacity") } })!.code, "capacity");
});

test("the card's words: statuses for each moment, no status codes, and a paused build says what is kept", () => {
  assert.equal(STATUS.waiting, "Temporarily waiting for AI capacity. Your work has been saved.");
  assert.equal(STATUS.resuming, "Resuming survey generation…");
  assert.equal(STATUS.ready, "Your survey draft is ready for review.");
  assert.match(STATUS.building(4, 12), /Processing the remaining questions… 4 of 12/);
  assert.match(STATUS.partial(12, 20), /12 of 20/);
  const f = pausedFailure(describeFailure("capacity"), 12, 20);
  assert.match(f.next[0], /12 of 20 items are built and kept/);
  assert.equal(pausedFailure(describeFailure("capacity"), 0, 20).next[0], describeFailure("capacity").next[0]);
  const i = interruptedFailure(cp({ built: [{ id: "a", raw: 0 }, { id: "b", raw: 0 }], items: ["a", "b", "c", "d"] }));
  assert.equal(i.code, "interrupted"); assert.match(i.message, /2 of 4 items already built/);
  for (const t of [STATUS.waiting, STATUS.resuming, STATUS.ready, f.message, i.message]) assert.doesNotMatch(t, /\b(401|403|429)\b/);
});

test("reading what is built from the database is OFF until an operator says otherwise, and the dual write is ON", () => {
  /* the switch is reversible with an environment variable and a restart — no deploy, no migration */
  assert.equal(taskResumeEnabled({}), false, "unset means the browser's checkpoint, exactly as today");
  assert.equal(taskResumeEnabled({ COPILOT_TASK_RESUME: "" }), false);
  assert.equal(taskResumeEnabled({ COPILOT_TASK_RESUME: "off" }), false);
  assert.equal(taskResumeEnabled({ COPILOT_TASK_RESUME: "maybe" }), false, "anything that is not plainly on is off");
  for (const v of ["on", "1", "true", "YES", " on "]) assert.equal(taskResumeEnabled({ COPILOT_TASK_RESUME: v }), true, v);
  /* one operator switch moves the whole read: the plan flag turns this on too, and an explicit setting still wins */
  assert.equal(taskResumeEnabled({ COPILOT_PLAN_RESUME: "on" }), true);
  assert.equal(taskResumeEnabled({ COPILOT_PLAN_RESUME: "off" }), false);
  assert.equal(taskResumeEnabled({ COPILOT_PLAN_RESUME: "on", COPILOT_TASK_RESUME: "off" }), false);
  assert.equal(TASK_RESUME_ENV, "COPILOT_TASK_RESUME");
  /* the rows must be written all along, or turning the read on later would be a lie */
  assert.equal(taskDualWriteEnabled({}), true);
  assert.equal(taskDualWriteEnabled({ COPILOT_TASK_DUAL_WRITE: "on" }), true);
  for (const v of ["off", "0", "false", "NO"]) assert.equal(taskDualWriteEnabled({ COPILOT_TASK_DUAL_WRITE: v }), false, v);
});

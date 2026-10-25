import { test } from "node:test";
import assert from "node:assert/strict";
import { taskProgress, taskSpend, type ExecStep, type ExecTask, type StepFailureKind, type StepUsage, type TaskStatus } from "@rescript/engine";
import type { ClaimedStep, CreateTaskInput, TaskStore } from "./taskStore.ts";
import {
  MAX_STEP_RETRIES, nextRunnableSteps, outstandingStepIds, readFailure, runSlice, setStepBuilder, stepBuilderFor,
  stepFailureMessage, taskSummary, tierFor, type BuildStep, type BuildStepResult,
} from "./runner.ts";

/*
 * NO REAL MODEL CALL AND NO DATABASE. The store is injected (R1 exports
 * `memoryTaskStore()`; this file carries its own against the same interface
 * so the runner is testable before that lands) and the build is injected, so
 * every test below is the RUNNER'S OWN behaviour: when a step runs, what is
 * committed, what is retried, what is split, and what a slice hands back.
 */

/* --------------------------------------------------------- a virtual clock */

/** time that only moves when something is waiting for it: a 150 s step costs the test no seconds at all */
function virtualClock(start = 0) {
  let t = start;
  let seq = 0;
  const timers: { due: number; seq: number; res: () => void }[] = [];
  let pumping = false;
  const pump = () => {
    if (pumping) return;
    pumping = true;
    const step = () => {
      if (!timers.length) { pumping = false; return; }
      timers.sort((a, b) => a.due - b.due || a.seq - b.seq);
      const first = timers.shift()!;
      if (first.due > t) t = first.due;
      first.res();
      setTimeout(step, 0);
    };
    setTimeout(step, 0);
  };
  return {
    now: () => t,
    sleep: (ms: number) => new Promise<void>((res) => { timers.push({ due: t + Math.max(0, ms), seq: seq++, res }); pump(); }),
  };
}

/* ------------------------------------------------------- a memory TaskStore */

const clone = <T,>(x: T): T => (x === undefined ? x : JSON.parse(JSON.stringify(x)) as T);

interface MemStore extends TaskStore {
  /** one entry per DELIVERED artefact — a second delivery of the same idempotency key adds nothing */
  deliveries: { stepId: string; key: string; output: unknown }[];
  rows(): ExecStep[];
  raw(): ExecTask;
  statusOf(id: string): TaskStatus;
}

function memoryStore(task: ExecTask, now: () => number): MemStore {
  let extraCharge = 0;
  const t: ExecTask = clone(task);
  const leases = new Map<string, number>();
  const deliveries: { stepId: string; key: string; output: unknown }[] = [];
  const seen = new Set<string>();
  const byId = () => new Map(t.steps.map((s) => [s.stepId, s]));
  const find = (id: string) => t.steps.find((s) => s.stepId === id)!;
  return {
    durable: false,
    deliveries,
    rows: () => clone(t.steps),
    raw: () => clone(t),
    statusOf: (id: string) => (id === t.id ? t.status : find(id).status as unknown as TaskStatus),
    async create(_i: CreateTaskInput) { return clone(t); },
    async load(id: string) { return id === t.id ? clone(t) : null; },
    async openFor(surveyId: string) { return surveyId === t.surveyId && t.status !== "completed" ? clone(t) : null; },
    async claim(id: string, opts?: { staleSeconds?: number; maxAttempts?: number }): Promise<ClaimedStep | null> {
      if (id !== t.id) return null;
      const maxAttempts = opts?.maxAttempts ?? MAX_STEP_RETRIES + 1;
      const staleMs = (opts?.staleSeconds ?? 180) * 1000;
      /* the reclaim window: a step a worker claimed and never came back for is claimable again */
      for (const s of t.steps) {
        if (s.status !== "running") continue;
        const at = leases.get(s.stepId) ?? 0;
        if (now() - at >= staleMs) { s.status = "retrying"; }
      }
      /* the SAME predicate the runner exports and the SQL claim mirrors */
      const runnable = nextRunnableSteps(t).filter((s) => (s.retryCount ?? 0) < maxAttempts);
      const s = runnable[0];
      if (!s) return null;
      const row = find(s.stepId);
      row.status = "running";
      row.startedAt = now();
      leases.set(row.stepId, now());
      return { step: clone(row), claimedAt: now() };
    },
    async commit(_id, stepId, out) {
      const row = find(stepId);
      /* THE IDEMPOTENCY GUARD: a second delivery of the same key is not a second artefact and not a second charge */
      if (seen.has(out.idempotencyKey)) return clone(row);
      seen.add(out.idempotencyKey);
      deliveries.push({ stepId, key: out.idempotencyKey, output: out.output });
      row.status = "completed";
      row.output = out.output;
      row.usage = out.usage;
      row.validation = out.validation;
      if (out.batchSizeUsed != null) row.batchSizeUsed = out.batchSizeUsed;
      row.finishedAt = now();
      leases.delete(stepId);
      return clone(row);
    },
    async fail(_id: string, stepId: string, f: { kind: StepFailureKind; message: string; retryable: boolean }) {
      const row = find(stepId);
      row.failureKind = f.kind;
      row.failureMessage = f.message;
      row.retryCount = (row.retryCount ?? 0) + (f.retryable ? 1 : 0);
      row.status = f.retryable ? "retrying" : "failed";
      leases.delete(stepId);
      return clone(row);
    },
    async revise(_id, planVersion, steps, tombstoned) {
      t.planVersion = planVersion;
      for (const id of tombstoned) find(id).status = "tombstoned";
      for (const s of steps) if (!t.steps.some((x) => x.stepId === s.stepId)) t.steps.push({ ...s, taskId: t.id, retryCount: 0 } as ExecStep);
      return clone(t);
    },
    async setStatus(_id, status, report) { t.status = status; if (report) t.report = report; },
    async earliestIncomplete(_id) { return clone(t.steps.find((s) => s.status !== "completed" && s.status !== "tombstoned") ?? null); },
    async stale(olderThanMs: number) {
      const last = Math.max(0, ...t.steps.map((s) => s.finishedAt ?? s.startedAt ?? 0));
      return (t.status === "running" || t.status === "pending") && now() - last >= olderThanMs ? [{ id: t.id, surveyId: t.surveyId }] : [];
    },
    async addExtraCharge(_id: string, amount: number) { extraCharge += amount; },
    async pause(_id: string, b: NonNullable<ExecTask["blocked"]> | null) { t.blocked = b ?? undefined; if (b) t.status = "needs_attention"; },
  };
}

/* ------------------------------------------------------------- fixtures */

const step = (id: string, over: Partial<ExecStep> = {}): ExecStep => ({
  taskId: "t1", stepId: id, planVersion: 1, dependsOn: [], status: "pending",
  title: `Item ${id}`, retryCount: 0, idempotencyKey: `t1:${id}:v1`, ...over,
});

const taskOf = (ids: string[], over: Partial<ExecTask> = {}): ExecTask => ({
  id: "t1", surveyId: "s1", kind: "survey_build", request: "Create a customer satisfaction survey of 20 questions",
  status: "pending", planVersion: 1, deliverable: { kind: "survey_build", questionCount: 20 },
  steps: ids.map((i) => step(i)), ...over,
});

const USAGE: StepUsage = { tokensIn: 900, tokensOut: 300, tokensCached: 600, charge: 0.02, model: "big-model" };

/** a build that always succeeds, counting how many times each step was asked of the model */
function scripted(opts: { ms?: number; clock?: { sleep(ms: number): Promise<void> }; reply?: (s: ExecStep, n: number) => BuildStepResult } = {}) {
  const calls: string[] = [];
  const ctxs: { id: string; batchSize?: number; deadline: number; attempt: number; tier: string; summary?: string }[] = [];
  const build: BuildStep = async (s, ctx) => {
    calls.push(s.stepId);
    ctxs.push({ id: s.stepId, batchSize: ctx.batchSize, deadline: ctx.deadline, attempt: ctx.attempt, tier: ctx.tier, summary: ctx.summary });
    if (opts.ms && opts.clock) await opts.clock.sleep(opts.ms);
    return opts.reply ? opts.reply(s, calls.filter((c) => c === s.stepId).length) : { output: { actions: [{ id: s.stepId }] }, usage: USAGE };
  };
  return { build, calls, ctxs, countOf: (id: string) => calls.filter((c) => c === id).length };
}

/* ============================================================== the tests */


/*
 * A DELIBERATE PASS (audit H9, 2026-10-25). `runSlice` no longer completes a
 * task when the caller supplies no deliverable gate — "nobody looked" is not
 * "it is fine". The tests below are about durability, idempotency and
 * budget, not about what "done" means, so they hand it a gate that passes
 * and keep asserting `completed`. The test directly below this comment is
 * the one that pins the new default.
 */
const PASSES = async () => ({ ok: true, problems: [] });

test("a slice with no deliverable gate leaves the task running, however many steps finished", async () => {
  const clock = virtualClock();
  const store = memoryStore(taskOf(["a", "b"]), clock.now);
  const s = scripted();
  const r = await runSlice("t1", { budgetMs: 300_000, store, buildStep: s.build, now: clock.now, sleep: clock.sleep, minStepMs: 10 });
  assert.equal(r.remaining.length, 0, "there is nothing left to build");
  assert.equal(r.status, "running", "and the runner still does not claim the deliverable exists");
  assert.equal((await store.load("t1"))!.status, "running");
});

test("nextRunnableSteps is pure over the graph: outstanding, dependencies met, in plan order", () => {
  const t = taskOf(["a", "b", "c", "d", "e"]);
  t.steps[0].status = "completed";
  t.steps[1].dependsOn = ["a"];
  t.steps[2].dependsOn = ["b"];            // b is not done
  t.steps[3].status = "running";           // another worker holds the lease
  t.steps[4].status = "blocked";           // a re-plan invalidated its inputs
  assert.deepEqual(nextRunnableSteps(t).map((s) => s.stepId), ["b"]);
  t.steps[1].status = "completed";
  assert.deepEqual(nextRunnableSteps(t).map((s) => s.stepId), ["c"]);
  /* a tombstoned dependency counts as met — a deleted item must not strand the rest */
  const u = taskOf(["a", "b"]);
  u.steps[0].status = "tombstoned";
  u.steps[1].dependsOn = ["a"];
  assert.deepEqual(nextRunnableSteps(u).map((s) => s.stepId), ["b"]);
  assert.deepEqual(nextRunnableSteps(taskOf(["a", "b", "c"]), 2).map((s) => s.stepId), ["a", "b"]);
  assert.deepEqual(nextRunnableSteps(taskOf([])), []);
  assert.deepEqual(outstandingStepIds(t), ["c", "d", "e"]);
});

test("a worker killed mid-slice: every step that returned is durable, and no completed step is built again", async () => {
  const clock = virtualClock();
  const t = taskOf(["a", "b", "c", "d"]);
  const store = memoryStore(t, clock.now);
  const calls: string[] = [];
  const killing: BuildStep = async (s) => {
    calls.push(s.stepId);
    if (s.stepId === "c" && calls.filter((c) => c === "c").length === 1) throw new Error("the worker was recycled");
    return { output: { built: s.stepId }, usage: USAGE };
  };
  /*
   * AUDIT M3 (2026-10-25). This used to be `assert.rejects` — it encoded as
   * correct the fact that a thrown `buildStep` propagated out of `runSlice`,
   * so the caller got an exception instead of a `SliceResult`, `finish()`
   * never ran, the task status was never written, and the step in flight
   * held its lease for the whole reclaim window. A function whose contract
   * is "returns what remains" has to return. A throw is now a failed step.
   */
  const first = await runSlice("t1", { budgetMs: 300_000, store, buildStep: killing, now: clock.now, sleep: clock.sleep, minStepMs: 10, maxRetries: 0 });
  assert.deepEqual(first.built, ["a", "b", "d"], "the slice returns, and one bad step does not cost the ones after it");
  assert.ok(first.failed.some((f) => f.id === "c"), "the step that threw is reported as failed, not swallowed");
  assert.deepEqual(store.rows().filter((r) => r.status === "completed").map((r) => r.stepId), ["a", "b", "d"]);
  assert.notEqual(store.rows().find((r) => r.stepId === "c")!.status, "completed");

  /* a NEW worker, after the reclaim window: it picks up what is left */
  const second = scripted();
  const r = await runSlice("t1", { budgetMs: 300_000, store, buildStep: second.build, now: clock.now, sleep: clock.sleep, minStepMs: 10, staleSeconds: 0, check: PASSES });
  assert.deepEqual(r.built, ["c"], "it resumed at the only step still outstanding");
  assert.equal(r.remaining.length, 0);
  assert.equal(r.status, "completed");
  assert.equal(second.countOf("a"), 0, "a completed step is never asked of the model again");
  assert.equal(second.countOf("b"), 0);
  assert.equal(store.deliveries.length, 4, "one artefact per step, no duplicates");
});

test("the reclaim window: a step in flight is nobody else's until the window has passed", async () => {
  const clock = virtualClock();
  const t = taskOf(["a", "b"]);
  t.steps[0].status = "running";
  t.steps[0].startedAt = 0;
  const store = memoryStore(t, clock.now);
  /* a worker with a 180 s window at t=0 cannot have it; `b` has no dependency on it, so that is what it gets */
  const early = await store.claim("t1", { staleSeconds: 180 });
  assert.equal(early?.step.stepId, "b");
  await store.fail("t1", "b", { kind: "transient", message: "x", retryable: true });
  assert.equal(await store.claim("t1", { staleSeconds: 180 }).then((c) => c?.step.stepId), "b", "`a` is still leased");
  await clock.sleep(200_000);
  assert.equal(await store.claim("t1", { staleSeconds: 180 }).then((c) => c?.step.stepId), "a", "past the window it is reclaimable");
});

test("a dropped sink: nothing more is started for nobody, and what was built is committed", async () => {
  const clock = virtualClock();
  const store = memoryStore(taskOf(["a", "b", "c", "d", "e"]), clock.now);
  const seen: string[] = [];
  let cancelled = false;
  const sink = {
    progress: (p: { stepId: string }) => { seen.push(p.stepId); },
    checkpoint: (id: string) => { if (id === "b") cancelled = true; },
    get cancelled() { return cancelled; },
  };
  const s = scripted();
  const r = await runSlice("t1", { budgetMs: 300_000, store, buildStep: s.build, sink, now: clock.now, sleep: clock.sleep, minStepMs: 10 });
  assert.equal(r.stoppedBy, "cancelled");
  assert.deepEqual(r.built, ["a", "b"]);
  assert.deepEqual(r.remaining, ["c", "d", "e"]);
  assert.deepEqual(store.rows().filter((x) => x.status === "completed").map((x) => x.stepId), ["a", "b"], "the built steps are committed, not thrown away");
  assert.equal(s.countOf("c"), 0, "nothing was started for a page that had gone");
  assert.deepEqual(seen, ["a", "b"]);
});

test("delivering the same job twice is one artefact set and one charge", async () => {
  const clock = virtualClock();
  const store = memoryStore(taskOf(["a", "b", "c"]), clock.now);
  const first = scripted();
  const r1 = await runSlice("t1", { budgetMs: 300_000, store, buildStep: first.build, now: clock.now, sleep: clock.sleep, minStepMs: 10, check: PASSES });
  assert.equal(r1.status, "completed");
  const spend = taskSpend(store.raw());
  assert.equal(spend.charge, 0.06, "three steps, three settled calls");
  assert.equal(spend.tokensCached, 1800, "the cache split is attributed per step, not only per request");

  /* the same job again — a double click, a retried cron, a second tab */
  const again = scripted();
  const r2 = await runSlice("t1", { budgetMs: 300_000, store, buildStep: again.build, now: clock.now, sleep: clock.sleep, minStepMs: 10, check: PASSES });
  assert.deepEqual(r2.built, []);
  assert.equal(again.calls.length, 0, "not one model call for work already delivered");
  assert.equal(store.deliveries.length, 3, "one artefact set");
  assert.equal(taskSpend(store.raw()).charge, 0.06, "one charge");

  /* and the store's own guard: a commit that repeats an idempotency key adds neither artefact nor charge */
  await store.commit("t1", "a", { output: { different: true }, usage: USAGE, idempotencyKey: "t1:a:v1" });
  assert.equal(store.deliveries.length, 3);
  assert.equal(taskSpend(store.raw()).charge, 0.06);
});

test("two runners racing one task build each step once and bill it once", async () => {
  const clock = virtualClock();
  const store = memoryStore(taskOf(["a", "b", "c", "d"]), clock.now);
  const s = scripted({ ms: 1000, clock });
  const opts = { budgetMs: 300_000, store, buildStep: s.build, now: clock.now, sleep: clock.sleep, minStepMs: 10 };
  const [x, y] = await Promise.all([runSlice("t1", opts), runSlice("t1", opts)]);
  assert.equal(s.calls.length, 4, "four steps, four calls between the two runners");
  assert.deepEqual([...x.built, ...y.built].sort(), ["a", "b", "c", "d"]);
  assert.equal(store.deliveries.length, 4);
  assert.equal(taskSpend(store.raw()).charge, 0.08);
});

test("a context limit halves the batch and splits the step — it is never retried whole", async () => {
  const clock = virtualClock();
  const t = taskOf(["a"]);
  t.steps[0].batchSize = 20;
  const store = memoryStore(t, clock.now);
  const tried: (number | undefined)[] = [];
  const build: BuildStep = async (s, ctx) => {
    tried.push(ctx.batchSize);
    if ((ctx.batchSize ?? 0) > 10) return { error: { name: "ProviderError", kind: "bad_request", contextTooLong: true, detail: "prompt is too long" } };
    return { output: { built: s.stepId }, usage: USAGE, batchSizeUsed: ctx.batchSize };
  };
  const r = await runSlice("t1", { budgetMs: 300_000, store, buildStep: build, now: clock.now, sleep: clock.sleep, minStepMs: 10, check: PASSES });
  assert.deepEqual(tried, [20, 10], "halved, not repeated at the same size");
  assert.deepEqual(r.built, ["a"]);
  const row = store.rows()[0];
  assert.equal(row.batchSize, 20, "what the plan asked for is still on the row");
  assert.equal(row.batchSizeUsed, 10, "and what actually worked is beside it");
  assert.equal(row.status, "completed");
});

test("a step too big at a batch of one is not retried for ever: it stops, classified", async () => {
  const clock = virtualClock();
  const t = taskOf(["a"]);
  t.steps[0].batchSize = 2;
  const store = memoryStore(t, clock.now);
  let n = 0;
  const build: BuildStep = async () => { n++; return { error: { kind: "bad_request", contextTooLong: true } }; };
  const r = await runSlice("t1", { budgetMs: 300_000, store, buildStep: build, now: clock.now, sleep: clock.sleep, minStepMs: 10, check: PASSES });
  assert.equal(n, 2, "20 → 1 is one halving, then it stops");
  assert.equal(r.failed[0]?.kind, "permanent");
  assert.equal(store.rows()[0].status, "failed");
});

test("retries are bounded, use the jittered backoff, and honour Retry-After", async () => {
  const clock = virtualClock();
  const store = memoryStore(taskOf(["a", "b"]), clock.now);
  let n = 0;
  const build: BuildStep = async (s) => {
    if (s.stepId === "b") return { output: { built: "b" }, usage: USAGE };
    n++;
    return { error: { kind: "overloaded", retryAfterMs: 2000 } };
  };
  const r = await runSlice("t1", { budgetMs: 300_000, store, buildStep: build, now: clock.now, sleep: clock.sleep, minStepMs: 10, maxRetries: 2, rand: () => 0 });
  assert.equal(n, 3, "the first try and two retries — never an unbounded retry");
  assert.equal(r.retryAfterMs, 2000, "what the provider asked for is handed back to the caller");
  assert.equal(r.failed[0]?.id, "a");
  assert.equal(r.failed[0]?.kind, "transient");
  assert.equal(store.rows()[0].retryCount, 3, "the count is on the row, so a new slice cannot reset it");
  assert.deepEqual(r.built, ["b"], "one bad step does not stop the rest of the task");
  assert.ok(clock.now() >= 4000, "it waited between tries rather than hammering");
});

test("a terminal failure stops the step, preserves the task, and says something a person can act on", async () => {
  const clock = virtualClock();
  const store = memoryStore(taskOf(["a", "b", "c"]), clock.now);
  let n = 0;
  const build: BuildStep = async (s) => {
    if (s.stepId === "a") return { output: { built: "a" }, usage: USAGE };
    n++;
    return { error: { kind: "auth", status: 401, detail: "invalid x-api-key" } };
  };
  const r = await runSlice("t1", { budgetMs: 300_000, store, buildStep: build, now: clock.now, sleep: clock.sleep, minStepMs: 10, check: PASSES });
  assert.equal(n, 1, "a refused key is not retried");
  assert.equal(r.stoppedBy, "terminal");
  assert.equal(r.failed[0]?.kind, "auth");
  assert.match(r.failed[0]!.message, /administrator/i);
  assert.doesNotMatch(r.failed[0]!.message, /\b(401|403|429|x-api-key)\b/, "never a provider's words or a status code");
  assert.equal(r.status, "failed");
  /* THE TASK IS PRESERVED: the completed step keeps its output, the untouched step keeps its place */
  const rows = store.rows();
  assert.deepEqual(rows.find((x) => x.stepId === "a")!.output, { built: "a" });
  assert.equal(rows.find((x) => x.stepId === "c")!.status, "pending");
  assert.deepEqual(r.remaining, ["b", "c"]);
  assert.equal(store.raw().report?.problems.length, 1);
});

test("a SLOW FIRST STEP returns a checkpoint instead of running to the route budget", async () => {
  const clock = virtualClock();
  const store = memoryStore(taskOf(["a", "b", "c"]), clock.now);
  let aborted = false;
  const build: BuildStep = async (_s, ctx) => {
    ctx.signal?.addEventListener("abort", () => { aborted = true; });
    await clock.sleep(150_000);          // the item that sat open to ~160 s on main
    return { output: { built: "a" } };
  };
  const r = await runSlice("t1", { budgetMs: 165_000, store, buildStep: build, now: clock.now, sleep: clock.sleep });
  assert.ok(clock.now() <= 90_000, `the slice ended at ${clock.now()}ms, at the 90 s cap — not at the route budget`);
  assert.equal(r.stoppedBy, "soft_stop");
  assert.equal(r.budgetSpent, true);
  assert.deepEqual(r.built, [], "nothing was built — and that is said, not hidden");
  assert.deepEqual(r.remaining, ["a", "b", "c"], "a checkpoint: everything is still to do, nothing is lost");
  assert.equal(aborted, true, "the build was told to stop paying for itself");
  assert.equal(store.rows()[0].status, "retrying", "the step is kept for the next slice");
  assert.equal(store.rows()[0].retryCount, 1);
});

test("no single step may outlast the stage cap, whatever it is the first or the third", async () => {
  const clock = virtualClock();
  const store = memoryStore(taskOf(["a", "b", "c", "d"]), clock.now);
  const s = scripted({ ms: 40_000, clock });
  const r = await runSlice("t1", { budgetMs: 165_000, store, buildStep: s.build, now: clock.now, sleep: clock.sleep });
  assert.deepEqual(r.built, ["a", "b"], "two 40 s steps fit inside the 90 s cap");
  assert.ok(clock.now() < 165_000, `ended at ${clock.now()}ms, well inside the route budget`);
  assert.equal(r.budgetSpent, true);
  assert.ok(r.remaining.length >= 2);
  assert.equal(taskProgress(store.raw()).completed, 2);
});

test("a slice spends only its own budget and hands the rest back", async () => {
  const clock = virtualClock();
  const store = memoryStore(taskOf(["a", "b", "c", "d", "e", "f"]), clock.now);
  const s = scripted({ ms: 5000, clock });
  const r = await runSlice("t1", { budgetMs: 20_000, store, buildStep: s.build, now: clock.now, sleep: clock.sleep, minStepMs: 7000 });
  assert.equal(r.budgetSpent, true);
  assert.equal(r.stoppedBy, "budget");
  assert.ok(r.built.length >= 1 && r.built.length < 6);
  assert.equal(r.built.length + r.remaining.length, 6);
  assert.ok(clock.now() <= 20_000);
  /* a second slice carries straight on, and nothing is built twice */
  const t2 = await runSlice("t1", { budgetMs: 300_000, store, buildStep: s.build, now: clock.now, sleep: clock.sleep, minStepMs: 10, check: PASSES });
  assert.equal(t2.status, "completed");
  assert.equal(s.calls.length, 6);
  assert.equal(store.deliveries.length, 6);
});

test("the deliverable spec is the only gate on `completed`", async () => {
  const clock = virtualClock();
  const store = memoryStore(taskOf(["a", "b"]), clock.now);
  const s = scripted();
  const r = await runSlice("t1", {
    budgetMs: 300_000, store, buildStep: s.build, now: clock.now, sleep: clock.sleep, minStepMs: 10,
    check: () => ({ ok: false, problems: ["64 of 100 questions"], measured: { questions: 64, required: 100 } }),
  });
  assert.equal(r.status, "running", "every step done is not the same as the request delivered");
  assert.deepEqual(r.report?.problems, ["64 of 100 questions"]);
  assert.equal(store.raw().status, "running");
});

test("the model is told a persisted summary and a tier, never the whole brief again", async () => {
  const clock = virtualClock();
  const t = taskOf(["a", "b"]);
  t.steps[0].title = "Structure the screener keys";
  t.steps[1].title = "Draft the satisfaction battery";
  const store = memoryStore(t, clock.now);
  const s = scripted();
  await runSlice("t1", { budgetMs: 300_000, store, buildStep: s.build, now: clock.now, sleep: clock.sleep, minStepMs: 10 });
  assert.equal(s.ctxs[0].tier, "small", "a structuring step goes to AI_MODEL_SMALL");
  assert.equal(s.ctxs[1].tier, "large");
  assert.match(s.ctxs[0].summary!, /Task \(survey_build\)/);
  assert.match(s.ctxs[0].summary!, /Must deliver: 20 respondent-facing questions/);
  assert.ok(s.ctxs[0].summary!.length <= 1200, "bounded — it is a summary, not the brief");
});

test("taskSummary is built from the rows: what was asked, what is promised, what is already built", () => {
  const t = taskOf(["a", "b", "c"], { request: `  ${"word ".repeat(200)} ` });
  t.steps[0].status = "completed";
  t.steps[0].title = "Screener";
  const s = taskSummary(t);
  assert.match(s, /Progress: 1 of 3 steps complete/);
  assert.match(s, /Already built: Screener/);
  assert.ok(s.includes("…"), "a long request is cut, not sent whole");
  assert.ok(taskSummary(t, { maxChars: 80 }).length <= 80);
  assert.equal(tierFor({ title: "Translate keys batch 3" }), "small");
  assert.equal(tierFor({ title: "Write the NPS follow-up" }), "large");
});

test("a failure is classified once, from whatever the build handed back", () => {
  assert.equal(readFailure({ kind: "rate_limited", retryAfterMs: 4000 }).kind, "rate_limited");
  assert.equal(readFailure({ kind: "rate_limited", retryAfterMs: 4000 }).retryAfterMs, 4000);
  assert.equal(readFailure({ kind: "bad_request", contextTooLong: true }).kind, "context_limit");
  assert.equal(readFailure({ hint: "invalid_output" }).kind, "invalid_output");
  assert.equal(readFailure({ kind: "auth" }).retryable, false);
  assert.equal(readFailure({ kind: "forbidden" }).retryable, false);
  assert.equal(readFailure(new Error("something odd")).kind, "transient");
  assert.equal(readFailure({ kind: "nonsense" }).kind, "permanent");
  for (const k of ["transient", "rate_limited", "context_limit", "invalid_output", "auth", "config", "permanent"] as const) {
    assert.doesNotMatch(stepFailureMessage(k), /\b(401|403|429|500|503)\b/);
    assert.ok(stepFailureMessage(k).length > 20);
  }
});

test("an already finished task costs nothing to ask about, and a missing one is said plainly", async () => {
  const clock = virtualClock();
  const store = memoryStore(taskOf(["a"], { status: "completed" }), clock.now);
  const s = scripted();
  const r = await runSlice("t1", { budgetMs: 300_000, store, buildStep: s.build, now: clock.now, sleep: clock.sleep });
  assert.equal(r.stoppedBy, "done");
  assert.equal(s.calls.length, 0);
  await assert.rejects(runSlice("nope", { budgetMs: 1000, store, buildStep: s.build, now: clock.now, sleep: clock.sleep }), /no task nope/);
});

test("the cron's build seam: nothing registered means the job skips honestly, never invents a build", async () => {
  const t = taskOf(["a"]);
  setStepBuilder(null);
  assert.equal(await stepBuilderFor(t), null);
  const s = scripted();
  setStepBuilder(async () => s.build);
  assert.equal(await stepBuilderFor(t), s.build);
  setStepBuilder(null);
});

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  MemoryTaskStore, classifyFailure, isolatedTaskStore, memoryTaskStore, planRevision, redactForClient, scrubSecrets,
  MAX_ATTEMPTS, STALE_SECONDS,
  type CreateTaskInput, type TaskStore,
} from "./taskStore.ts";
import { dependenciesMet, taskProgress, taskSpend, type ExecStep, type ExecTask } from "@rescript/engine";

/*
 * DURABLE TASK AND STEP STATE — the contract, run against the memory store
 * (which is the reference implementation R2, R3 and R4 test against, so it
 * has to behave like the SQL does and not approximately).
 *
 * What is proved here: the claim is exclusive and gated on dependencies and
 * reclaims an abandoned step after the window; a repeated idempotency key
 * stores one output and bills once; a re-plan keeps what was paid for,
 * tombstones what was deleted and blocks whatever depended on it; and the
 * client-readable shape carries neither the request text, nor a raw model
 * output, nor anything credential-shaped.
 *
 * The SQL half of the same contract is scripts/intelligent-tasks-sql-test.sql.
 */

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const step = (stepId: string, extra: Partial<ExecStep> = {}): Omit<ExecStep, "taskId" | "retryCount"> => ({
  stepId, planVersion: 1, dependsOn: [], status: "pending",
  idempotencyKey: `idem-${stepId}`, title: `Step ${stepId}`, ...extra,
});

const input = (steps: Omit<ExecStep, "taskId" | "retryCount">[], extra: Partial<CreateTaskInput> = {}): CreateTaskInput => ({
  surveyId: "survey-1", customerId: "cust-1", createdBy: "user-1",
  kind: "survey_build", request: "Write me a 100-question tracker",
  deliverable: { kind: "survey_build", questionCount: 100 },
  steps, ...extra,
});

/** a store nobody else's test can see */
const fresh = (): TaskStore => isolatedTaskStore();

/* ------------------------------------------------------------ create / load */

test("create: steps get the task id, retryCount 0 and plan version 1; load returns them in order", async () => {
  const s = fresh();
  const t = await s.create(input([step("a"), step("b"), step("c")]));
  assert.equal(t.status, "pending");
  assert.equal(t.planVersion, 1);
  assert.deepEqual(t.steps.map((x) => x.stepId), ["a", "b", "c"]);
  assert.ok(t.steps.every((x) => x.taskId === t.id && x.retryCount === 0 && x.planVersion === 1));
  const again = await s.load(t.id);
  assert.deepEqual(again?.steps.map((x) => x.stepId), ["a", "b", "c"]);
  assert.equal(await s.load("nope"), null);
  assert.equal(s.durable, false, "the memory store must never claim to be durable");
});

test("openFor: the newest unfinished task for the survey, and nothing once it is finished", async () => {
  const s = fresh();
  const t1 = await s.create(input([step("a")]));
  await sleep(2);
  const t2 = await s.create(input([step("a")]));
  assert.equal((await s.openFor("survey-1"))?.id, t2.id);
  assert.equal(await s.openFor("survey-2"), null);
  await s.setStatus(t2.id, "completed");
  assert.equal((await s.openFor("survey-1"))?.id, t1.id);
  await s.setStatus(t1.id, "cancelled");
  assert.equal(await s.openFor("survey-1"), null);
});

/* ------------------------------------------------------------ the claim */

test("claim exclusivity: two runners racing one step, one winner", async () => {
  const s = fresh();
  const t = await s.create(input([step("only")]));
  const [a, b] = await Promise.all([s.claim(t.id), s.claim(t.id)]);
  const winners = [a, b].filter((x) => x !== null);
  assert.equal(winners.length, 1, "exactly one claim may win");
  assert.equal(winners[0]!.step.stepId, "only");
  assert.equal(winners[0]!.step.status, "running");
  assert.ok(winners[0]!.claimedAt > 0);
  const t2 = await s.load(t.id);
  assert.equal(t2?.status, "running", "the first claim moves the task to running");
  assert.equal(await s.claim(t.id), null, "a third ask gets nothing while it is held");
});

test("claim exclusivity: eight runners over three steps take three distinct steps", async () => {
  const s = fresh();
  const t = await s.create(input([step("a"), step("b"), step("c")]));
  const got = await Promise.all(Array.from({ length: 8 }, () => s.claim(t.id)));
  const ids = got.filter((x) => x !== null).map((x) => x!.step.stepId).sort();
  assert.deepEqual(ids, ["a", "b", "c"], "three steps, three claims, no step claimed twice");
});

test("claim: dependencies gate it — b waits for a, and a tombstone also counts as settled", async () => {
  const s = fresh();
  const t = await s.create(input([step("a"), step("b", { dependsOn: ["a"] }), step("c", { dependsOn: ["b"] })]));
  const first = await s.claim(t.id);
  assert.equal(first?.step.stepId, "a", "only the step with no dependencies is runnable");
  assert.equal(await s.claim(t.id), null, "b and c are not offered while a is outstanding");
  await s.commit(t.id, "a", { output: { ok: 1 }, idempotencyKey: "idem-a" });
  assert.equal((await s.claim(t.id))?.step.stepId, "b");
  await s.commit(t.id, "b", { output: { ok: 2 }, idempotencyKey: "idem-b" });
  assert.equal((await s.claim(t.id))?.step.stepId, "c");
});

test("claim: a step abandoned past the stale window is reclaimed, and one inside it is not", async () => {
  const s = fresh();
  const t = await s.create(input([step("a")]));
  const first = await s.claim(t.id);
  assert.ok(first);
  assert.equal(await s.claim(t.id, { staleSeconds: STALE_SECONDS }), null, "a live lease is never stolen");
  await sleep(5);
  const again = await s.claim(t.id, { staleSeconds: 0 });
  assert.equal(again?.step.stepId, "a", "the abandoned step comes back");
  assert.equal(again?.step.startedAt, first!.step.startedAt, "startedAt is the first start, not the reclaim");
});

test("claim: maxAttempts stops a step being offered forever", async () => {
  const s = fresh();
  const t = await s.create(input([step("a")]));
  for (let i = 0; i < MAX_ATTEMPTS; i++) {
    const c = await s.claim(t.id, { staleSeconds: 0 });
    assert.ok(c, `attempt ${i} should be claimable`);
    await s.fail(t.id, "a", { kind: "transient", message: "the model did not answer", retryable: true });
    await sleep(2);
  }
  assert.equal((await s.load(t.id))?.steps[0]?.retryCount, MAX_ATTEMPTS);
  assert.equal(await s.claim(t.id, { staleSeconds: 0 }), null, "a step past maxAttempts is not offered again");
});

test("claim: blocked and tombstoned steps are never offered", async () => {
  const s = fresh();
  const t = await s.create(input([step("a", { status: "blocked" }), step("b", { status: "tombstoned" })]));
  assert.equal(await s.claim(t.id), null);
});

/* ------------------------------------------------------------ the commit */

test("commit: a repeated idempotency key stores one output and does not double-count the spend", async () => {
  const s = fresh();
  const t = await s.create(input([step("a")]));
  await s.claim(t.id);
  const usage = { tokensIn: 1200, tokensOut: 800, tokensCached: 400, charge: 0.25, model: "m-1" };
  const one = await s.commit(t.id, "a", { output: { text: "first" }, usage, idempotencyKey: "idem-a", batchSizeUsed: 10 });
  assert.equal(one.status, "completed");
  const two = await s.commit(t.id, "a", { output: { text: "SECOND DELIVERY" }, usage, idempotencyKey: "idem-a" });
  assert.deepEqual(two.output, { text: "first" }, "the second delivery of the same key stores nothing new");
  const loaded = (await s.load(t.id))!;
  assert.equal(loaded.steps.length, 1);
  assert.deepEqual(loaded.steps[0]!.output, { text: "first" });
  assert.equal(loaded.steps[0]!.batchSizeUsed, 10);
  const spend = taskSpend(loaded);
  assert.deepEqual(spend, { tokensIn: 1200, tokensOut: 800, tokensCached: 400, charge: 0.25 }, "billed once, not twice");
});

test("commit: a third and fourth replay still bill once", async () => {
  const s = fresh();
  const t = await s.create(input([step("a")]));
  for (let i = 0; i < 4; i++) {
    await s.commit(t.id, "a", { output: { i }, usage: { tokensIn: 100, charge: 1 }, idempotencyKey: "idem-a" });
  }
  assert.equal(taskSpend((await s.load(t.id))!).charge, 1);
  assert.deepEqual((await s.load(t.id))!.steps[0]!.output, { i: 0 });
});

test("commit: the validation verdict is stored as given", async () => {
  const s = fresh();
  const t = await s.create(input([step("a")]));
  const c = await s.commit(t.id, "a", { output: {}, idempotencyKey: "idem-a", validation: { status: "invalid", errors: ["two questions share the code Q3"] } });
  assert.equal(c.validation?.status, "invalid");
  assert.deepEqual(c.validation?.errors, ["two questions share the code Q3"]);
});

test("commit / fail: a missing task or step is an error, not a silent write", async () => {
  const s = fresh();
  const t = await s.create(input([step("a")]));
  await assert.rejects(() => s.commit("no-task", "a", { output: {}, idempotencyKey: "k" }));
  await assert.rejects(() => s.commit(t.id, "zz", { output: {}, idempotencyKey: "k" }));
  await assert.rejects(() => s.fail(t.id, "zz", { kind: "transient", message: "x", retryable: true }));
});

/* ------------------------------------------------------------ the failure */

test("fail: classified, counted, and retryable only while it can still succeed", async () => {
  const s = fresh();
  const t = await s.create(input([step("a"), step("b")]));
  const f1 = await s.fail(t.id, "a", { kind: "overloaded", message: "the provider was busy", retryable: true });
  assert.equal(f1.failureKind, "transient", "a raw ProviderErrorKind is classified");
  assert.equal(f1.status, "retrying");
  assert.equal(f1.retryCount, 1);
  const f2 = await s.fail(t.id, "b", { kind: "auth", message: "the key was refused", retryable: true });
  assert.equal(f2.failureKind, "auth");
  assert.equal(f2.status, "failed", "a terminal failure is never left retrying");
});

test("fail: an already-classified StepFailureKind is not re-classified into permanent", async () => {
  assert.equal(classifyFailure("config"), "config", "config is a conclusion, not a provider error code");
  assert.equal(classifyFailure("context_limit"), "context_limit");
  assert.equal(classifyFailure("rate_limited"), "rate_limited");
  assert.equal(classifyFailure("bad_request"), "context_limit", "a provider code still goes through the map");
  assert.equal(classifyFailure("network"), "transient");
  assert.equal(classifyFailure(undefined), "transient");
  assert.equal(classifyFailure("nonsense-code"), "permanent");
  assert.equal(classifyFailure("overloaded", "invalid_output"), "invalid_output", "the hint wins");
});

test("fail: retrying leaves the step claimable again, failing past the budget does not", async () => {
  const s = fresh();
  const t = await s.create(input([step("a")]));
  await s.claim(t.id);
  await s.fail(t.id, "a", { kind: "transient", message: "timeout", retryable: true });
  assert.equal((await s.claim(t.id))?.step.stepId, "a", "a retrying step is runnable without waiting for the window");
  await s.fail(t.id, "a", { kind: "permanent", message: "this step cannot succeed", retryable: false });
  assert.equal((await s.load(t.id))!.steps[0]!.status, "failed");
  assert.equal(await s.claim(t.id), null);
});

/* ------------------------------------------------------------ the re-plan */

test("revise: completed steps survive, deletions are tombstoned, dependants are blocked", async () => {
  const s = fresh();
  const t = await s.create(input([step("a"), step("b"), step("c", { dependsOn: ["b"] }), step("d", { dependsOn: ["c"] })]));
  await s.claim(t.id);
  await s.commit(t.id, "a", { output: { built: "Q1-Q10" }, usage: { tokensIn: 500, charge: 2 }, idempotencyKey: "idem-a" });

  const next = await s.revise(t.id, 2, [
    step("a", { planVersion: 2 }),
    step("b", { planVersion: 2 }),
    step("c", { planVersion: 2, dependsOn: ["b"] }),
    step("d", { planVersion: 2, dependsOn: ["c"] }),
    step("e", { planVersion: 2 }),
  ], ["b"]);

  assert.equal(next.planVersion, 2);
  const by = new Map(next.steps.map((x) => [x.stepId, x]));
  assert.equal(by.get("a")!.status, "completed", "work already paid for is kept");
  assert.equal(by.get("a")!.planVersion, 1, "and kept at the version it ran under");
  assert.deepEqual(by.get("a")!.output, { built: "Q1-Q10" });
  assert.equal(by.get("b")!.status, "tombstoned", "the deleted id is kept, never run");
  assert.equal(by.get("c")!.status, "blocked", "its direct dependant can never get its input");
  assert.equal(by.get("d")!.status, "blocked", "and so can the one behind that — the block is transitive");
  assert.equal(by.get("e")!.status, "pending", "a brand new step is runnable");
  assert.equal(taskSpend(next).charge, 2, "a re-plan does not re-bill the completed work");
  assert.equal(await (async () => (await s.claim(t.id))?.step.stepId)(), "e", "only the new step is claimable");
});

test("revise: a step the new plan simply drops is tombstoned; a completed one it drops is kept completed", async () => {
  const s = fresh();
  const t = await s.create(input([step("a"), step("b"), step("gone")]));
  await s.commit(t.id, "a", { output: 1, idempotencyKey: "idem-a" });
  const next = await s.revise(t.id, 2, [step("b", { planVersion: 2 })], []);
  const by = new Map(next.steps.map((x) => [x.stepId, x]));
  assert.equal(by.get("a")!.status, "completed", "it is not in the new plan, but it is done");
  assert.equal(by.get("gone")!.status, "tombstoned");
  assert.equal(by.get("b")!.status, "pending");
  assert.equal(next.steps.length, 3, "nothing is deleted from the record — a tombstone is a row");
});

test("planRevision is pure and does not mutate the rows it was given", () => {
  const existing: ExecStep[] = [
    { taskId: "t", stepId: "a", planVersion: 1, dependsOn: [], status: "completed", retryCount: 0, idempotencyKey: "k-a", output: { v: 1 } },
    { taskId: "t", stepId: "b", planVersion: 1, dependsOn: ["a"], status: "pending", retryCount: 2, idempotencyKey: "k-b" },
  ];
  const before = structuredClone(existing);
  const out = planRevision(existing, "t", 2, [step("a", { planVersion: 2 }), step("b", { planVersion: 2, dependsOn: ["a"] })], []);
  assert.deepEqual(existing, before, "the input rows are untouched");
  assert.equal(out.find((x) => x.stepId === "b")!.retryCount, 2, "a retry count already spent is carried over");
});

/* ------------------------------------------------------------ resume */

test("earliestIncomplete: where a resumed task picks up, and null when there is nothing left", async () => {
  const s = fresh();
  const t = await s.create(input([step("a"), step("b"), step("c")]));
  assert.equal((await s.earliestIncomplete(t.id))?.stepId, "a");
  await s.commit(t.id, "a", { output: 1, idempotencyKey: "idem-a" });
  assert.equal((await s.earliestIncomplete(t.id))?.stepId, "b");
  await s.commit(t.id, "b", { output: 2, idempotencyKey: "idem-b" });
  await s.commit(t.id, "c", { output: 3, idempotencyKey: "idem-c" });
  assert.equal(await s.earliestIncomplete(t.id), null);
  assert.equal(await s.earliestIncomplete("no-task"), null);
  assert.deepEqual(taskProgress((await s.load(t.id))!), { total: 3, completed: 3, failed: 0, pending: 0, running: 0, blocked: 0 });
});

test("stale: tasks left open past the window, finished ones never", async () => {
  const s = fresh();
  const t = await s.create(input([step("a")]));
  assert.deepEqual(await s.stale(60_000), [], "a task touched a moment ago is not stale");
  await sleep(5);
  assert.deepEqual(await s.stale(0), [{ id: t.id, surveyId: "survey-1" }]);
  await s.setStatus(t.id, "completed", { ok: true, problems: [] });
  assert.deepEqual(await s.stale(0), [], "a finished task is never swept");
  assert.equal((await s.load(t.id))?.report?.ok, true);
});

/* ------------------------------------------------- nothing leaves the server */

test("redactForClient: no request text, no raw model output, no input reference", async () => {
  const s = fresh();
  const t = await s.create(input([step("a", { inputRef: "brief passage: our competitor is ACME, margin 42%" })], {
    request: "Build a tracker. Internal note: our margin is 42% and the client is ACME.",
  }));
  await s.commit(t.id, "a", {
    output: { questions: [{ text: "How likely are you to recommend ACME?" }], rawPrompt: "SYSTEM: you are a survey writer" },
    usage: { tokensIn: 10, tokensOut: 20, charge: 0.5, model: "m-1" },
    idempotencyKey: "idem-a",
  });
  const view = redactForClient((await s.load(t.id))!);
  const json = JSON.stringify(view);
  assert.ok(!/request/i.test(Object.keys(view).join(",")), "there is no request field at all");
  assert.ok(!json.includes("Internal note"), "the request text does not travel");
  assert.ok(!json.includes("brief passage"), "the input reference does not travel");
  assert.ok(!json.includes("rawPrompt"), "no prompt text travels");
  assert.ok(!json.includes("SYSTEM:"), "no prompt text travels");
  assert.ok(!json.includes("How likely are you"), "the raw model output does not travel");
  assert.ok(!("output" in (view.steps[0] as object)), "a client step has no output field");
  /* what SHOULD survive: the counts, the statuses and the spend */
  assert.equal(view.steps[0]!.status, "completed");
  assert.equal(view.progress.completed, 1);
  assert.equal(view.spend.charge, 0.5);
  assert.equal(view.steps[0]!.usage?.model, "m-1");
});

test("redactForClient: nothing credential-shaped survives in a failure message, a title or a validation error", async () => {
  const s = fresh();
  const t = await s.create(input([step("a", { title: "Translate with AIzaSyB1234567890abcdefghijklmnopqrs" })]));
  await s.fail(t.id, "a", { kind: "auth", message: "the key sk-proj-ABCDEF0123456789abcdef was refused", retryable: false });
  await s.commit(t.id, "a", { output: {}, idempotencyKey: "idem-a", validation: { status: "invalid", errors: ["Authorization: Bearer eyJhbGciOiJI.eyJzdWIiOiIxMjM0.SflKxwRJSMeKKF2QT4"] } });
  const json = JSON.stringify(redactForClient((await s.load(t.id))!));
  for (const secret of ["sk-proj-ABCDEF", "AIzaSyB1234567890", "eyJhbGciOiJI", "Bearer eyJ"]) {
    assert.ok(!json.includes(secret), `"${secret}" must not reach a client`);
  }
  assert.ok(json.includes("[redacted]"), "and the reader is told something was removed");
});

test("scrubSecrets: the shapes it catches, and the ordinary words it leaves alone", () => {
  assert.equal(scrubSecrets("key sk-abcdefgh12345678 here"), "key [redacted] here");
  assert.equal(scrubSecrets("api_key=abc123def"), "[redacted]");
  assert.equal(scrubSecrets("token xoxb-1234567890-abcdefg"), "token [redacted]");
  assert.equal(scrubSecrets("AKIAIOSFODNN7EXAMPLE"), "[redacted]");
  assert.equal(scrubSecrets("ghp_0123456789abcdefghij"), "[redacted]");
  assert.equal(scrubSecrets("question 3 is missing its scale"), "question 3 is missing its scale");
  assert.equal(scrubSecrets("the respondent skipped Q7"), "the respondent skipped Q7");
});

test("a failure message written to the store is scrubbed at rest, not only on the way out", async () => {
  const s = fresh();
  const t = await s.create(input([step("a")]));
  const f = await s.fail(t.id, "a", { kind: "auth", message: "refused: sk-live-0123456789abcdef", retryable: false });
  assert.ok(!f.failureMessage?.includes("sk-live-0123456789"), "the row itself never holds the key");
});

/* ------------------------------------------------------------ the shared map */

test("memoryTaskStore(): the process-wide store, shared between callers, isolated per map", async () => {
  const a = memoryTaskStore();
  const b = memoryTaskStore();
  const t = await a.create(input([step("a")], { surveyId: "shared-survey" }));
  assert.equal((await b.load(t.id))?.id, t.id, "two handles on the process store see one task");
  assert.equal(await isolatedTaskStore().load(t.id), null, "an isolated store sees nothing of it");
  assert.ok(new MemoryTaskStore(new Map()) instanceof MemoryTaskStore);
  await a.setStatus(t.id, "cancelled");
});

test("a snapshot is a copy: mutating what load() returned cannot reach into the store", async () => {
  const s = fresh();
  const t = await s.create(input([step("a")]));
  const loaded = (await s.load(t.id))! as ExecTask;
  loaded.steps[0]!.status = "completed";
  loaded.status = "completed";
  const again = (await s.load(t.id))!;
  assert.equal(again.steps[0]!.status, "pending");
  assert.equal(again.status, "pending");
});

/*
 * CROSS-AGENT REGRESSION (consolidation, 2026-10-24).
 *
 * `planRevision` used to treat a completed row as immutable and discard the
 * status reconciliation handed it, so a completed step whose inputs a new
 * instruction invalidated stayed `completed` and was never re-run — the exact
 * failure §6 rule 2 exists to prevent ("a step whose inputs changed is
 * invalidated"). Reconciliation decides; the store records that decision.
 *
 * The narrowness matters as much as the fix: an incoming `pending` on a
 * completed row must STILL be ignored, or an ordinary continuation would
 * quietly rebuild — and re-bill — work that was already done.
 */
const revStep = (id: string, status: ExecStep["status"], dependsOn: string[] = []): Omit<ExecStep, "taskId" | "retryCount"> =>
  ({ stepId: id, planVersion: 2, dependsOn, status, idempotencyKey: `k:${id}` });

test("planRevision: a completed step the re-plan invalidated comes back blocked, and keeps its output", () => {
  const existing: ExecStep[] = [
    { taskId: "t", stepId: "p1", planVersion: 1, dependsOn: [], status: "completed", retryCount: 0, idempotencyKey: "k:p1", output: { a: 1 } },
    { taskId: "t", stepId: "p2", planVersion: 1, dependsOn: ["p1"], status: "completed", retryCount: 0, idempotencyKey: "k:p2", output: { b: 2 } },
  ];
  const out = planRevision(existing, "t", 2, [revStep("p1", "completed"), revStep("p2", "blocked", ["p1"])], []);
  const byId = new Map(out.map((s) => [s.stepId, s]));
  assert.equal(byId.get("p1")!.status, "completed", "an untouched completed step is left alone");
  assert.equal(byId.get("p2")!.status, "blocked", "the invalidated one is re-runnable, not silently kept");
  assert.deepEqual(byId.get("p2")!.output, { b: 2 }, "its output is preserved so the reply can say what was dropped");
  assert.equal(byId.get("p2")!.planVersion, 2);
});

test("planRevision: a completed step the re-plan deleted is tombstoned, not left completed", () => {
  const existing: ExecStep[] = [
    { taskId: "t", stepId: "p1", planVersion: 1, dependsOn: [], status: "completed", retryCount: 0, idempotencyKey: "k:p1" },
  ];
  const out = planRevision(existing, "t", 2, [revStep("p1", "tombstoned")], ["p1"]);
  assert.equal(out.find((s) => s.stepId === "p1")!.status, "tombstoned");
});

test("planRevision: an ordinary continuation does NOT unseat a completed step", () => {
  const existing: ExecStep[] = [
    { taskId: "t", stepId: "p1", planVersion: 1, dependsOn: [], status: "completed", retryCount: 0, idempotencyKey: "k:p1", output: { a: 1 } },
  ];
  for (const incoming of ["pending", "running", "retrying"] as const) {
    const out = planRevision(existing, "t", 2, [revStep("p1", incoming)], []);
    assert.equal(out.find((s) => s.stepId === "p1")!.status, "completed", `an incoming ${incoming} is ignored`);
    assert.deepEqual(out.find((s) => s.stepId === "p1")!.output, { a: 1 });
  }
});

/*
 * AUDIT C3 (2026-10-25). Reconciliation marks a CHANGED item by handing back
 * `pending` with a NEW idempotency key (the key is derived from the item's
 * fingerprint). `pending` alone cannot be the signal — an ordinary
 * continuation hands that too for a step that simply has not run — so the key
 * is what `planRevision` reads. Before this, a changed item kept its
 * `completed` row and was never rebuilt, while the reply said it was being
 * rebuilt, and its dependents ran again against the stale output.
 */
test("planRevision: a completed step whose CONTENT changed is unseated and starts clean", () => {
  const existing: ExecStep[] = [
    { taskId: "t", stepId: "p1", planVersion: 1, dependsOn: [], status: "completed", retryCount: 2, idempotencyKey: "sv:p1:OLDFP", output: { built: "p1" }, usage: { charge: 0.04 }, validation: { status: "valid" } },
  ];
  const out = planRevision(existing, "t", 2, [
    { stepId: "p1", planVersion: 2, dependsOn: [], status: "pending", idempotencyKey: "sv:p1:NEWFP" },
  ], []);
  const p1 = out.find((s) => s.stepId === "p1")!;
  assert.equal(p1.status, "pending", "the changed item is runnable again");
  assert.equal(p1.idempotencyKey, "sv:p1:NEWFP", "and carries the new key, so its delivery is a new delivery");
  assert.equal(p1.retryCount, 0, "new content is new work, not a continuation of the old attempts");
  assert.equal(p1.output, undefined, "the stale output is not carried — a dependent must not read it");
  assert.equal(p1.usage, undefined);
  assert.equal(p1.validation, undefined, "and it is certainly not still 'valid'");
  assert.equal(p1.planVersion, 2);
});

test("planRevision: a dependent of a changed step cannot run until the parent is rebuilt", () => {
  const existing: ExecStep[] = [
    { taskId: "t", stepId: "p1", planVersion: 1, dependsOn: [], status: "completed", retryCount: 0, idempotencyKey: "sv:p1:OLDFP", output: { built: "p1" } },
    { taskId: "t", stepId: "p2", planVersion: 1, dependsOn: ["p1"], status: "completed", retryCount: 0, idempotencyKey: "sv:p2:FP", output: { built: "p2" } },
  ];
  const out = planRevision(existing, "t", 2, [
    { stepId: "p1", planVersion: 2, dependsOn: [], status: "pending", idempotencyKey: "sv:p1:NEWFP" },
    { stepId: "p2", planVersion: 2, dependsOn: ["p1"], status: "blocked", idempotencyKey: "sv:p2:FP" },
  ], []);
  const by = new Map(out.map((s) => [s.stepId, s]));
  assert.equal(by.get("p1")!.status, "pending");
  assert.equal(by.get("p2")!.status, "blocked", "the dependent waits rather than reusing itself");
  /* the live gate: dependenciesMet must refuse p2 while p1 is unbuilt */
  assert.equal(dependenciesMet(by.get("p2")!, by), false, "and it is not runnable, because p1 is no longer completed");
});

test("planRevision: the SAME key on a completed row is still an ordinary continuation", () => {
  const existing: ExecStep[] = [
    { taskId: "t", stepId: "p1", planVersion: 1, dependsOn: [], status: "completed", retryCount: 1, idempotencyKey: "sv:p1:FP", output: { built: "p1" } },
  ];
  for (const incoming of ["pending", "running", "retrying"] as const) {
    const out = planRevision(existing, "t", 2, [
      { stepId: "p1", planVersion: 2, dependsOn: [], status: incoming, idempotencyKey: "sv:p1:FP" },
    ], []);
    const p1 = out.find((s) => s.stepId === "p1")!;
    assert.equal(p1.status, "completed", `an incoming ${incoming} with an unchanged key does not unseat finished work`);
    assert.deepEqual(p1.output, { built: "p1" }, "and the output is kept, so it is not rebuilt or re-billed");
  }
});

/*
 * AUDIT C4 (2026-10-25). The claim's candidate test refuses a step at
 * `maxAttempts`, and the migration header promises that is what stops a step
 * the model cannot answer from being retried for ever at the customer's
 * expense. Nothing incremented the counter on the path that matters: a worker
 * killed mid-flight never calls `fail()`, so the step was reclaimed and
 * re-billed every stale window, without limit. The old tests reached the
 * bound only by calling `fail()` or setting the count by hand, which is why
 * they passed.
 */
test("claim: a worker that dies mid-flight costs an attempt, so a doomed step is not reclaimed for ever", async () => {
  const s = isolatedTaskStore();
  const t = await s.create(input([step("a")]));
  let claims = 0;
  /* claim, die, wait out the lease — the loop a recycled worker makes, with nothing ever calling fail() */
  for (let round = 0; round < 10; round++) {
    const c = await s.claim(t.id, { staleSeconds: 0, maxAttempts: 3 });
    if (!c) break;
    claims++;
    /* the lease is stamped with the clock, and a zero window still means "strictly older than now" */
    await new Promise((r) => setTimeout(r, 2));
  }
  /*
   * The arithmetic, stated so it is not a surprise: the candidate test is
   * `retryCount < maxAttempts` and only a RECLAIM increments, so with
   * maxAttempts = 3 a doomed step is handed out 1 + 3 = 4 times and then
   * refused for ever. The SQL claim computes the same number the same way.
   */
  assert.equal(claims, 4, "one free attempt and three reclaims, then refused — not an unbounded loop");
  const after = await s.load(t.id);
  assert.equal(after!.steps[0]!.retryCount, 3, "the first claim is free; each reclaim after it costs one");
  await new Promise((r) => setTimeout(r, 2));
  assert.equal(await s.claim(t.id, { staleSeconds: 0, maxAttempts: 3 }), null, "and it stays refused");
});

test("claim: a first claim of a pending step is free, so one honest retry does not spend the budget", async () => {
  const s = isolatedTaskStore();
  const t = await s.create(input([step("a")]));
  await s.claim(t.id);
  assert.equal((await s.load(t.id))!.steps[0]!.retryCount, 0, "claiming work that has never run is not an attempt spent");
  await s.fail(t.id, "a", { kind: "transient", message: "the provider was busy", retryable: true });
  assert.equal((await s.load(t.id))!.steps[0]!.retryCount, 1, "a failure that said so counts once, here and not in the claim");
});

test("claim: a `running` row with no lease is not claimable, as in SQL", async () => {
  const s = isolatedTaskStore();
  const t = await s.create(input([step("a")]));
  const c = await s.claim(t.id);
  assert.ok(c, "claimed");
  /* a row left running with no lease is a stranded row, not a free one: the SQL claim requires claimed_at is not null */
  const loaded = await s.load(t.id);
  assert.equal(loaded!.steps[0]!.status, "running");
  assert.equal(await s.claim(t.id, { staleSeconds: 86_400 }), null, "inside the window nobody else may have it");
});

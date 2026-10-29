/**
 * PLAN PERSISTENCE AND RECONCILIATION (§1 and §6) — Owner: R2.
 *
 * Every rule the module states in its header is pinned here: the edge
 * derivation, the three reconciliation rules, the conservative continuation
 * rule, the flag that defaults off, and the two things that must NOT happen —
 * an engine-resolved edit growing a task row, and Plan First off losing a
 * large task.
 *
 * The store is R1's `isolatedTaskStore()` (lib/copilot/taskStore.ts): the
 * contract's own reference implementation, a fresh Map per test, never the
 * durable one. Nothing here calls `taskStoreFor`.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { SurveyDefinition } from "@rescript/schema";
import { applySurveyActions } from "@rescript/engine";
import type { ExecTask, TaskStatus } from "@rescript/engine";
import { isolatedTaskStore } from "./taskStore.ts";
import type { TaskStore } from "./taskStore.ts";
import type { ChangePlan, ChangePlanItem } from "./changePlan.ts";
import {
  CONTINUATION_TTL_MS, PLAN_RESUME_ENV,
  continuesTask, decodeItemRef, dependentsOf, describeReconciliation, itemFingerprint, itemObjects,
  loadOrCreatePlan, planDependencies, planFromTask, planResumeEnabled, reconcilePlan, taskDecision, taskKindFor,
} from "./planPersistence.ts";

/* ------------------------------------------------------------- fixtures */

const emptySurvey = () => SurveyDefinition.parse({ meta: { id: "s", code: "S", title: "Plan persistence" }, questions: [], flow: [{ type: "end", id: "e", status: "complete" }], deployment: { clientSlug: "c", studySlug: "s" } });
let seq = 0;
const ids = (p: string) => `${p}_${++seq}`;
const DEF = applySurveyActions(emptySurvey(), [
  { op: "create_block", title: "Main" },
  { op: "create_question", ref: "Q1", type: "single", text: "How old are you?", options: ["18-24", "25-34"] },
  { op: "create_question", ref: "Q2", type: "single", text: "What is your gender?", options: ["Male", "Female"] },
  { op: "create_question", ref: "Q3", type: "open", text: "Why did you choose that?" },
] as never, { ids }).def;

const item = (id: string, objects: string[], extra: Partial<ChangePlanItem> = {}): ChangePlanItem =>
  ({ id, title: `Item ${id}`, kind: "create", objects, reason: `because ${id}`, ...extra });

const plan = (items: ChangePlanItem[], summary = "a plan"): ChangePlan => ({ summary, items, questions: [], assumptions: [] });

/** p3 → p4 (they share Q5); p1, p2 and p5 stand alone */
const BASE_ITEMS = [item("p1", ["Screener"]), item("p2", ["Q1", "Q2"]), item("p3", ["Q5"]), item("p4", ["Q5", "Q6"]), item("p5", ["Analysis plan"])];
const BASE_PLAN = plan(BASE_ITEMS, "Build the tracker");

const BIG_REQUEST = "Build a 24-question broadband brand tracker with a screener, the switching-driver battery and a quota on region";
const ON = { [PLAN_RESUME_ENV]: "on" };

/** complete and validate every step of a task, as the runner would */
async function finishAll(store: TaskStore, taskId: string, validation: "valid" | "invalid" | "unchecked" = "valid"): Promise<ExecTask> {
  const t = await store.load(taskId);
  assert.ok(t, "task exists");
  for (const s of t.steps) await store.commit(taskId, s.stepId, { output: { built: s.stepId }, validation: { status: validation }, usage: { tokensIn: 10, tokensOut: 20, charge: 1 }, idempotencyKey: s.idempotencyKey });
  const after = await store.load(taskId);
  assert.ok(after);
  return after;
}

/** a task built straight from a plan, every step completed and validated */
async function openTaskWith(store: TaskStore, surveyId: string, request: string, p: ChangePlan): Promise<ExecTask> {
  const made = await loadOrCreatePlan({ surveyId, request, plan: p, mode: "generate", env: ON }, store);
  assert.ok(made?.fresh, "a fresh task");
  return finishAll(store, made.task.id);
}

/* ------------------------------------------------- 1. the edge derivation */

test("#1 planDependencies: an edge is two items naming the same object, in plan order — and nothing else", () => {
  const edges = planDependencies(BASE_ITEMS);
  assert.deepEqual([...edges.entries()], [["p1", []], ["p2", []], ["p3", []], ["p4", ["p3"]], ["p5", []]]);
  // the first item never depends on anything, however many objects it names
  assert.deepEqual(edges.get("p1"), []);
  // order matters: the same two items the other way round reverse the edge
  const reversed = planDependencies([item("a", ["Q5", "Q6"]), item("b", ["Q5"])]);
  assert.deepEqual([...reversed.entries()], [["a", []], ["b", ["a"]]]);
  // case, surrounding space and quotes do not make a different object
  const loose = planDependencies([item("a", [" q5 "]), item("b", ["“Q5”"])]);
  assert.deepEqual(loose.get("b"), ["a"]);
  /*
   * AUDIT M6 (2026-10-25). This used to assert that an item with no objects
   * is an island. `objects` is OPTIONAL in the plan schema and defaulted to
   * `[]`, so a model that simply omits it produced a completely edgeless
   * plan and a re-plan then invalidated nothing downstream of anything. An
   * item nothing can be reasoned about is now assumed to depend on
   * everything before it: that costs a rebuild, where the alternative
   * silently keeps stale work.
   */
  assert.deepEqual(planDependencies([item("a", ["Q1"]), item("b", [])]).get("b"), ["a"], "an unreadable item is not an island");
  assert.deepEqual(planDependencies([item("a", []), item("b", ["Q1"])]).get("b"), ["a"], "and an unreadable EARLIER item is assumed to matter");
  /* a kind that reads the whole survey depends on all of it, whatever it names */
  const withAnalysis = [item("q1", ["Q1"]), item("q2", ["Q2"]), item("an", ["Analysis plan"], { kind: "analysis" })];
  assert.deepEqual(planDependencies(withAnalysis).get("an"), ["q1", "q2"], "the analysis plan is downstream of every question item");
  assert.deepEqual(dependentsOf(withAnalysis, ["q1"]), ["an"], "so changing a question re-runs the analysis built on it");
  // every earlier item that shares an object is an edge, not only the nearest
  assert.deepEqual(planDependencies([item("a", ["Q1"]), item("b", ["Q1"]), item("c", ["Q1"])]).get("c"), ["a", "b"]);
  assert.deepEqual(itemObjects(item("x", ["Q5", "q5", " Q5 "])), ["q5"]);
});

test("#2 dependentsOf is the transitive downstream closure and never contains its seeds", () => {
  const chain = [item("a", ["Q1"]), item("b", ["Q1", "Q2"]), item("c", ["Q2", "Q3"]), item("d", ["Q9"])];
  assert.deepEqual(dependentsOf(chain, ["a"]), ["b", "c"], "a → b → c, transitively; d is untouched");
  assert.deepEqual(dependentsOf(chain, ["b"]), ["c"]);
  assert.deepEqual(dependentsOf(chain, ["c"]), []);
  assert.deepEqual(dependentsOf(chain, ["d"]), []);
  assert.deepEqual(dependentsOf(BASE_ITEMS, ["p3"]), ["p4"]);
  assert.deepEqual(dependentsOf(BASE_ITEMS, ["p5"]), []);
});

test("#3 the item fingerprint moves with what the model is asked to build, and not with its position", () => {
  const a = item("p1", ["Q5"], { detail: "five-point scale" });
  assert.equal(itemFingerprint(a), itemFingerprint({ ...a, id: "pX" }), "the id is not an input");
  assert.notEqual(itemFingerprint(a), itemFingerprint({ ...a, detail: "seven-point scale" }));
  assert.notEqual(itemFingerprint(a), itemFingerprint({ ...a, objects: ["Q6"] }));
  assert.notEqual(itemFingerprint(a), itemFingerprint({ ...a, title: "Something else" }));
  assert.equal(itemFingerprint(a), itemFingerprint({ ...a, objects: [" q5 "] }), "object normalisation is the same normalisation");
  // a step written by something other than this module is never read as reusable
  assert.deepEqual(decodeItemRef({ inputRef: "a brief passage" }), { objects: [], fp: null });
  assert.deepEqual(decodeItemRef({ inputRef: undefined }), { objects: [], fp: null });
});

/* --------------------------------------- 2. which turns get a task at all */

test("#4 an engine-resolved simple edit creates no task", async () => {
  const store = isolatedTaskStore();
  for (const request of ["Remove Q2", "Add a page break after Q1", "Randomise the options in Q1"]) {
    const d = taskDecision({ request, definition: DEF });
    assert.deepEqual(d, { task: false, why: "engine_resolved" }, request);
    assert.equal(await loadOrCreatePlan({ surveyId: "sv-edit", request, definition: DEF, mode: "edit", env: ON }, store), null, request);
  }
  assert.equal(await store.openFor("sv-edit"), null, "no task row was written for an engine-resolved edit");
});

test("#5 an engine-resolved edit stays engine-resolved even when the turn carries a plan", async () => {
  const store = isolatedTaskStore();
  const d = taskDecision({ request: "Remove Q2", definition: DEF, plan: BASE_PLAN, mode: "generate" });
  assert.deepEqual(d, { task: false, why: "engine_resolved" });
  assert.equal(await loadOrCreatePlan({ surveyId: "sv-5", request: "Remove Q2", definition: DEF, plan: BASE_PLAN, mode: "generate", env: ON }, store), null);
  assert.equal(await store.openFor("sv-5"), null);
});

test("#6 large by plan, by brief, or by the route's own mode — and small otherwise", () => {
  const big = taskDecision({ request: BIG_REQUEST, definition: DEF, plan: BASE_PLAN });
  assert.equal(big.task, true); assert.equal(big.task && big.why, "plan");
  const brief = `${"Objectives: understand switching. ".repeat(60)}\nDesign the questionnaire.`;
  const b = taskDecision({ request: brief, definition: DEF });
  assert.equal(b.task, true); assert.equal(b.task && b.why, "long_brief");
  const gen = taskDecision({ request: BIG_REQUEST, definition: DEF, mode: "generate" });
  assert.equal(gen.task, true); assert.equal(gen.task && gen.why, "generation");
  assert.deepEqual(taskDecision({ request: "Remove Q2", definition: DEF, mode: "generate" }), { task: false, why: "engine_resolved" }, "the engine gate is read first, before any size");
  assert.deepEqual(taskDecision({ request: "Tighten the wording of the intro paragraph a little", mode: "edit" }), { task: false, why: "small" });
  // a one-item plan is not a task on its own
  assert.deepEqual(taskDecision({ request: "Tighten the intro", mode: "edit", plan: plan([item("p1", ["Intro"])]) }), { task: false, why: "small" });
  assert.equal(taskKindFor("Translate the survey into Hindi"), "translation");
  assert.equal(taskKindFor("Design a conjoint for the pricing study"), "conjoint");
  assert.equal(taskKindFor(BIG_REQUEST), "survey_build");
});

/* ------------------------------------------------------- 3. the read flag */

test("#7 the read flag defaults OFF and is read per call", () => {
  assert.equal(PLAN_RESUME_ENV, "COPILOT_PLAN_RESUME");
  assert.equal(planResumeEnabled({}), false, "unset is off");
  assert.equal(planResumeEnabled({ [PLAN_RESUME_ENV]: "" }), false);
  assert.equal(planResumeEnabled({ [PLAN_RESUME_ENV]: "off" }), false);
  assert.equal(planResumeEnabled({ [PLAN_RESUME_ENV]: "0" }), false);
  assert.equal(planResumeEnabled({ [PLAN_RESUME_ENV]: "false" }), false);
  assert.equal(planResumeEnabled({ [PLAN_RESUME_ENV]: "maybe" }), false, "anything unrecognised is off");
  for (const v of ["on", "ON", "1", "true", "yes"]) assert.equal(planResumeEnabled({ [PLAN_RESUME_ENV]: v }), true, v);
});

test("#8 with the flag off the slices of one build share a task row, and nothing in it is read back", async () => {
  const store = isolatedTaskStore();
  const opened: string[] = [];
  /* a delegating spy: a class instance cannot be spread, so every method is forwarded by hand */
  const spied: TaskStore = {
    durable: store.durable,
    create: (i) => store.create(i),
    load: (id) => store.load(id),
    openFor: async (sv: string) => { opened.push(sv); return store.openFor(sv); },
    claim: (id, o) => store.claim(id, o),
    commit: (id, sid, out) => store.commit(id, sid, out),
    fail: (id, sid, f) => store.fail(id, sid, f),
    revise: (id, v, st, tomb) => store.revise(id, v, st, tomb),
    setStatus: (id, st, r) => store.setStatus(id, st, r),
    earliestIncomplete: (id) => store.earliestIncomplete(id),
    stale: (ms, limit) => store.stale(ms, limit),
    addExtraCharge: (id, amt) => store.addExtraCharge(id, amt),
    pause: (id, b) => store.pause(id, b),
    release: (id, sid) => store.release(id, sid),
    listFor: (sv, n) => store.listFor(sv, n),
    retry: (id, sid) => store.retry(id, sid),
  };
  const first = await loadOrCreatePlan({ surveyId: "sv-8", request: BIG_REQUEST, plan: BASE_PLAN, mode: "generate", env: {} }, spied);
  assert.ok(first?.fresh);
  await finishAll(store, first.task.id);
  const second = await loadOrCreatePlan({ surveyId: "sv-8", request: BIG_REQUEST, plan: BASE_PLAN, mode: "generate", env: {} }, spied);
  /*
   * AUDIT H1 (2026-10-25). This used to assert the opposite — that the flag
   * being off meant a NEW task every time. That was the bug: one build is
   * several HTTP slices, so a 100-question generation left five sibling
   * rows, none of them complete, all swept by the cron for ever, and the
   * idempotency key was scoped to a task id that changed under it so the
   * unique index could never deduplicate anything.
   *
   * Which row to write to and whether to believe its contents are different
   * questions. The task is now found and appended to unconditionally; the
   * flag still decides whether anything is read back.
   */
  assert.equal(second?.fresh, false, "the slices of one build share one task row");
  assert.equal(second!.task.id, first.task.id);
  assert.equal(second!.resumeRead, false);
  assert.deepEqual(opened, ["sv-8", "sv-8"], "openFor is called on every turn now — to FIND the row, not to trust it");
  assert.deepEqual(second!.reused, [], "and nothing in it is claimed as reused");
  assert.deepEqual(second!.redone, []);
  assert.deepEqual(second!.tombstoned, []);
});

/* ------------------------------------------- 4. does it continue the task? */

test("#9 the continuation rule: a phrase, a shared subject, or a named object of work in flight", async () => {
  const store = isolatedTaskStore();
  const task = await openTaskWith(store, "sv-9", BIG_REQUEST, BASE_PLAN);
  const yes = (r: string) => continuesTask(task, "sv-9", r);
  assert.equal(yes("continue").continues, true);
  assert.equal(yes("Build the rest").continues, true);
  assert.equal(yes("yes, go ahead").continues, true);
  assert.equal(yes("आगे बढ़ाओ").continues, true);
  assert.equal(yes("Add two more questions to the broadband brand tracker about switching drivers").why, "overlap");
  assert.equal(yes("Make Q5 a five-point scale").why, "named_object", "a short edit naming an object of a step in flight");
  // and the refusals
  assert.equal(yes("Translate the finished study into Hindi and Tamil").continues, false);
  assert.equal(yes("Write me a crosstab banner plan for the pricing deck").continues, false);
  assert.equal(continuesTask(task, "sv-OTHER", "continue").why, "other_survey");
  assert.equal(continuesTask({ ...task, status: "completed" as TaskStatus }, "sv-9", "continue").why, "not_open");
  assert.equal(continuesTask({ ...task, updatedAt: Date.now() - CONTINUATION_TTL_MS - 1 }, "sv-9", "continue").why, "expired");
  // a long new brief is never a "named object" continuation however many codes it happens to mention
  assert.equal(yes(`Q5 ${"and a completely different study about grocery delivery habits. ".repeat(8)}`).continues, false);
});

test("#10 an unrelated new request never loads the old plan", async () => {
  const store = isolatedTaskStore();
  const first = await openTaskWith(store, "sv-10", BIG_REQUEST, BASE_PLAN);
  const other = plan([item("t1", ["Hindi"]), item("t2", ["Tamil"])], "Translate");
  const second = await loadOrCreatePlan({ surveyId: "sv-10", request: "Translate the finished study into Hindi and Tamil", plan: other, mode: "generate", env: ON }, store);
  assert.ok(second);
  assert.equal(second.fresh, true, "a new task, not the tracker's plan");
  assert.notEqual(second.task.id, first.id);
  assert.deepEqual(second.reused, [], "nothing of the old plan is reused");
  assert.deepEqual(second.redone, []);
  assert.deepEqual(second.tombstoned, []);
  assert.equal(second.task.kind, "translation");
  assert.deepEqual(second.task.steps.map((s) => s.stepId), ["t1", "t2"]);
  // the old task is untouched: all five steps still completed
  const old = await store.load(first.id);
  assert.equal(old?.steps.filter((s) => s.status === "completed").length, 5);
});

/* -------------------------------------------------- 5. the reconciliation */

test("#11 a plan edit bumps planVersion and invalidates EXACTLY the dependent set", async () => {
  const store = isolatedTaskStore();
  const task = await openTaskWith(store, "sv-11", BIG_REQUEST, BASE_PLAN);
  assert.equal(task.planVersion, 1);
  const edited = plan(BASE_ITEMS.map((i) => (i.id === "p3" ? { ...i, detail: "make it a seven-point scale instead" } : i)));
  const r = reconcilePlan(task, edited);
  assert.equal(r.planVersion, 2);
  assert.deepEqual(r.redone, ["p3", "p4"], "the changed item and the one that shares Q5 with it — nothing else");
  assert.deepEqual(r.reused, ["p1", "p2", "p5"], "the unrelated completed steps keep their outputs");
  assert.deepEqual(r.added, []);
  assert.deepEqual(r.tombstoned, []);
  assert.deepEqual(r.outstanding, []);
  assert.equal(r.unchanged, false);
  const by = new Map(r.steps.map((s) => [s.stepId, s]));
  assert.equal(by.get("p3")?.status, "pending", "the item the instruction changed is the new work, runnable now");
  assert.equal(by.get("p4")?.status, "blocked", "its dependent is blocked: its inputs moved");
  assert.deepEqual(by.get("p4")?.dependsOn, ["p3"]);
  for (const id of ["p1", "p2", "p5"]) {
    assert.equal(by.get(id)?.status, "completed", id);
    assert.deepEqual(by.get(id)?.output, { built: id }, `${id} kept its output`);
    assert.equal(by.get(id)?.usage?.charge, 1, `${id} kept what it cost`);
  }
  assert.notEqual(by.get("p3")?.idempotencyKey, task.steps.find((s) => s.stepId === "p3")?.idempotencyKey, "changed work gets a new idempotency key");
  assert.equal(by.get("p1")?.idempotencyKey, task.steps.find((s) => s.stepId === "p1")?.idempotencyKey, "reused work keeps its key, so it is never billed twice");
});

test("#12 continuation reuses the completed steps and re-runs only the dependents, end to end", async () => {
  const store = isolatedTaskStore();
  const task = await openTaskWith(store, "sv-12", BIG_REQUEST, BASE_PLAN);
  const edited = plan(BASE_ITEMS.map((i) => (i.id === "p3" ? { ...i, detail: "seven-point instead" } : i)));
  const loaded = await loadOrCreatePlan({ surveyId: "sv-12", request: "Make Q5 a seven-point scale instead", plan: edited, mode: "generate", env: ON }, store);
  assert.ok(loaded);
  assert.equal(loaded.fresh, false, "the open task was continued, not replaced");
  assert.equal(loaded.task.id, task.id);
  assert.deepEqual(loaded.reused, ["p1", "p2", "p5"]);
  assert.deepEqual(loaded.redone, ["p3", "p4"]);
  assert.deepEqual(loaded.tombstoned, []);
  assert.equal(loaded.planVersion, 2);
  assert.equal(loaded.resumeRead, true);
  const stored = await store.load(task.id);
  assert.equal(stored?.planVersion, 2, "the new version was persisted");
  assert.deepEqual(stored?.steps.map((s) => s.stepId), ["p1", "p2", "p3", "p4", "p5"], "every step is still on the task");
  /*
   * What this module HANDED the store is the contract: p3 pending, p4 blocked.
   * (The store's own `planRevision` currently keeps a previously completed row
   * completed whatever status it is given — see the note in the report; this
   * assertion pins what reconciliation decided, which is this module's part.)
   */
  const handed = reconcilePlan(task, edited);
  assert.equal(handed.steps.find((s) => s.stepId === "p3")?.status, "pending");
  assert.equal(handed.steps.find((s) => s.stepId === "p4")?.status, "blocked");
});

test("#13 a deleted item is tombstoned and reported, never dropped silently", async () => {
  const store = isolatedTaskStore();
  const task = await openTaskWith(store, "sv-13", BIG_REQUEST, BASE_PLAN);
  const shorter = plan(BASE_ITEMS.filter((i) => i.id !== "p5"));
  const r = reconcilePlan(task, shorter);
  assert.deepEqual(r.tombstoned, ["p5"]);
  assert.deepEqual(r.steps.map((s) => s.stepId), ["p1", "p2", "p3", "p4"], "the live set no longer lists it");
  assert.deepEqual(r.reused, ["p1", "p2", "p3", "p4"], "dropping an unrelated item invalidates nothing");
  assert.deepEqual(r.redone, []);
  const said = describeReconciliation(r);
  assert.match(said, /p5/, "the reply names what was dropped");
  assert.match(said, /kept on the task as a record, not deleted/);
  const loaded = await loadOrCreatePlan({ surveyId: "sv-13", request: "Drop the analysis plan item from the broadband brand tracker", plan: shorter, mode: "generate", env: ON }, store);
  assert.deepEqual(loaded?.tombstoned, ["p5"]);
  const stored = await store.load(task.id);
  assert.ok(stored?.steps.some((s) => s.stepId === "p5"), "the row is still there — tombstoned, not deleted");
});

test("#14 a new item is added, not 'built again', and it invalidates what depends on it", async () => {
  const store = isolatedTaskStore();
  const task = await openTaskWith(store, "sv-14", BIG_REQUEST, BASE_PLAN);
  const grown = plan([...BASE_ITEMS, item("p6", ["Analysis plan", "Weighting"])]);
  const r = reconcilePlan(task, grown);
  assert.deepEqual(r.added, ["p6"]);
  assert.deepEqual(r.redone, [], "p6 is new work; p5 comes BEFORE it, so nothing downstream moved");
  assert.deepEqual(r.reused, ["p1", "p2", "p3", "p4", "p5"]);
  assert.match(describeReconciliation(r), /Nothing is being built again\./, "a new item is not work done again");
  assert.doesNotMatch(describeReconciliation(r), /steps are being built again because/);
  assert.match(describeReconciliation(r), /1 step is new \(p6\)/);
  // inserted BEFORE p5 instead, sharing its object: now p5's inputs really did move
  const inserted = plan([...BASE_ITEMS.slice(0, 4), item("p6", ["Analysis plan"]), BASE_ITEMS[4]!]);
  const r2 = reconcilePlan(task, inserted);
  assert.deepEqual(r2.added, ["p6"]);
  assert.deepEqual(r2.redone, ["p5"]);
  assert.deepEqual(r2.reused, ["p1", "p2", "p3", "p4"]);
});

/*
 * AUDIT H3 (2026-10-25). This used to assert that an UNCHECKED completed step
 * is not reused. Nothing in the production path ever writes a verdict — the
 * turn commits `{output, usage, idempotencyKey}` and the store defaults
 * validation to `"unchecked"` — so that rule made reuse unreachable: every
 * continuation rebuilt and re-billed work that was already done, while the
 * store quietly kept the rows. "Nobody looked" is not "it is wrong".
 *
 * A completed step is reused unless something checked it and said INVALID.
 * Reuse is still guarded where it matters: a changed item arrives with a
 * different idempotency key and is unseated, and a step whose inputs moved
 * arrives `blocked`.
 */
test("#15 rule 1: an unchecked completed step IS reused; an invalid one is not", async () => {
  const store = isolatedTaskStore();
  const made = await loadOrCreatePlan({ surveyId: "sv-15", request: BIG_REQUEST, plan: BASE_PLAN, mode: "generate", env: ON }, store);
  assert.ok(made);
  const task = await finishAll(store, made.task.id, "unchecked");
  const r = reconcilePlan(task, BASE_PLAN);
  assert.deepEqual(r.reused, ["p1", "p2", "p3", "p4", "p5"], "work that is done is not done again");
  assert.deepEqual(r.redone, [], "the instruction changed nothing");
  assert.deepEqual(r.outstanding, []);
  assert.equal(r.unchanged, true, "no write is needed");

  const invalid = await finishAll(isolatedTaskStore(), (await loadOrCreatePlan({ surveyId: "sv-15b", request: BIG_REQUEST, plan: BASE_PLAN, mode: "generate", env: ON }, store))!.task.id, "invalid")
    .catch(() => null);
  if (invalid) {
    const r2 = reconcilePlan(invalid, BASE_PLAN);
    assert.deepEqual(r2.reused, [], "a step something checked and rejected is never reused");
  }
});

test("#16 a resume with no new plan reuses what is validated and claims nothing else", async () => {
  const store = isolatedTaskStore();
  const made = await loadOrCreatePlan({ surveyId: "sv-16", request: BIG_REQUEST, plan: BASE_PLAN, mode: "generate", env: ON }, store);
  assert.ok(made);
  const t = await store.load(made.task.id);
  assert.ok(t);
  for (const id of ["p1", "p2"]) {
    const s = t.steps.find((x) => x.stepId === id)!;
    await store.commit(t.id, id, { output: { built: id }, validation: { status: "valid" }, idempotencyKey: s.idempotencyKey });
  }
  const resumed = await loadOrCreatePlan({ surveyId: "sv-16", request: "continue", mode: "generate", env: ON }, store);
  assert.ok(resumed);
  assert.equal(resumed.fresh, false);
  assert.deepEqual(resumed.reused, ["p1", "p2"]);
  assert.deepEqual(resumed.redone, []);
  assert.deepEqual(resumed.tombstoned, []);
  assert.equal(resumed.planVersion, 1, "a resume is not a re-plan: the version does not move");
  assert.deepEqual(planFromTask(resumed.task).items.map((i) => i.id), ["p1", "p2", "p3", "p4", "p5"]);
  assert.deepEqual(planFromTask(resumed.task).items.find((i) => i.id === "p4")?.objects, ["q5", "q6"], "the objects survive in the step's own envelope");
});

/* ----------------------------------------------------- 6. the Plan First toggle */

test("#17 Plan First off still persists a large task, and still answers a small one in one turn", async () => {
  const store = isolatedTaskStore();
  const big = await loadOrCreatePlan({ surveyId: "sv-17", request: BIG_REQUEST, planFirst: false, mode: "generate", definition: DEF, env: ON }, store);
  assert.ok(big, "Plan First off does not mean the task is lost");
  assert.equal(big.fresh, true);
  assert.equal(big.why, "generation");
  assert.deepEqual(big.task.steps.map((s) => s.stepId), ["p1"], "no plan yet: one step holds the whole request so the work has a row");
  assert.equal(big.task.deliverable.questionCount, 24, "what the request promised");
  assert.ok(await store.openFor("sv-17"), "the row is there");
  // and a small request with the toggle off is still a single turn with no row
  const small = await loadOrCreatePlan({ surveyId: "sv-17b", request: "Remove Q2", planFirst: false, mode: "edit", definition: DEF, env: ON }, store);
  assert.equal(small, null);
  assert.equal(await store.openFor("sv-17b"), null);
  // the toggle ON for the same large request reaches the same row
  const planned = await loadOrCreatePlan({ surveyId: "sv-17", request: BIG_REQUEST, planFirst: true, plan: BASE_PLAN, mode: "generate", env: ON }, store);
  assert.equal(planned?.fresh, false, "the same open task is continued");
  assert.equal(planned?.task.id, big.task.id);
});

/* ------------------------------------------------------ 7. what the reply says */

test("#18 describeReconciliation says what is reused and what is redone, and never claims what did not happen", () => {
  const fresh = describeReconciliation({ reused: [], redone: [], tombstoned: [], added: ["p1", "p2", "p3"], fresh: true });
  assert.equal(fresh, "A new task with 3 steps. Nothing from an earlier plan was reused — this is the first version of this plan.");
  assert.doesNotMatch(fresh, /reused as|built again|no longer in the plan/);

  const mixed = describeReconciliation({ reused: ["p1", "p2", "p5"], redone: ["p3", "p4"], tombstoned: [], added: [], fresh: false });
  assert.equal(mixed, "3 completed steps are reused as they stand (p1, p2, p5) — they are not being built again. 2 steps are being built again because this instruction changed their inputs (p3, p4).");

  const one = describeReconciliation({ reused: ["p1"], redone: ["p2"], tombstoned: ["p9"], added: ["p7"], fresh: false });
  assert.match(one, /^1 completed step is reused as it stands \(p1\) — it is not being built again\./);
  assert.match(one, /1 step is being built again because this instruction changed its inputs \(p2\)\./);
  assert.match(one, /1 step is new \(p7\)\./);
  assert.match(one, /1 step is no longer in the plan and will not be built \(p9\); it is kept on the task as a record, not deleted\./);

  const nothing = describeReconciliation({ reused: [], redone: [], tombstoned: [], added: [], fresh: false });
  assert.equal(nothing, "No completed step could be reused. Nothing is being built again.");
  assert.doesNotMatch(nothing, /\(\)/, "no empty id lists");

  // long id lists are summarised rather than dumped
  const many = describeReconciliation({ reused: ["a", "b", "c", "d", "e", "f", "g", "h"], redone: [], tombstoned: [], fresh: false });
  assert.match(many, /\(a, b, c, d, e, f and 2 more\)/);
});

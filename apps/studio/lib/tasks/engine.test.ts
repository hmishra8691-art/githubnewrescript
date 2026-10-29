import { test } from "node:test";
import assert from "node:assert/strict";
import { SurveyDefinition } from "@rescript/schema";
import { countRespondentQuestions, taskSpend } from "@rescript/engine";
import { isolatedTaskStore } from "../copilot/taskStore.ts";
import { runSlice } from "../copilot/runner.ts";
import { __resetTaskRegistry, registerStepHandler, registerTaskPlanner } from "./registry.ts";
import { __resetFakeResponders, registerFakeResponder } from "./fakeResponders.ts";
import { buildDraft } from "./draft.ts";
import { checkPlan, createPlannedTask, deliverableOf, handlerBuildStep, specToSeed, taskCheck, taskResult } from "./engine.ts";
import { guardSleep, quickSleep, runTaskInProcess, sliceInProcess, testDeps } from "./testing.ts";
import type { StepContext, StepResult, TaskPlanner } from "./types.ts";

/*
 * K's engine.test.ts logic RE-EXPRESSED AGAINST THE BASE RUNNER (2026-10-29): claim/lease/commit, split, repair,
 * retry, blocked, resume from the earliest incomplete step, idempotent billing — all through `runSlice` +
 * `handlerBuildStep` on the memory store, with a tiny synthetic family so each case is quick, then the real
 * generation planner on the production prompts.
 */

const empty = () => SurveyDefinition.parse({ meta: { id: "s", code: "S", title: "T" }, questions: [], flow: [{ type: "end", id: "e_ok", status: "complete" }], deployment: { clientSlug: "c", studySlug: "s" } });
const q = (code: string) => ({ op: "create_question", type: "single_select", code, text: `Question ${code}: which statement is correct?`, options: [{ code: 1, label: "A" }, { code: 2, label: "B" }] });
const done = (actions: unknown[] = []): StepResult => ({ status: "completed", output: { actions, validation: { ok: true, errors: [], warnings: [] } } });

/** a synthetic family: three steps a → b → c, each writing one question through `ctx.ai`, with a scripted behaviour per step */
function synthetic(script: Record<string, (ctx: StepContext) => Promise<StepResult>> = {}) {
  __resetTaskRegistry();
  __resetFakeResponders();
  const planner: TaskPlanner = {
    id: "synthetic",
    matches: ({ message }) => (/synthetic/i.test(message) ? 1 : 0),
    async plan({ message }) {
      return {
        summary: { goal: message, deliverables: ["3 questions"], constraints: [], decisions: [], sourceTurnIds: [] },
        steps: [
          { id: "a", kind: "syn.q", title: "Write Q1", dependsOn: [], input: { code: "Q1", units: 1 } },
          { id: "b", kind: "syn.q", title: "Write Q2", dependsOn: ["a"], input: { code: "Q2", units: 1 } },
          { id: "c", kind: "syn.q", title: "Write Q3", dependsOn: ["b"], input: { code: "Q3", units: 1 } },
        ],
        completion: ["questions>=3", "unique_codes"],
      };
    },
  };
  const calls: string[] = [];
  registerTaskPlanner(planner);
  registerFakeResponder("syn.", (call) => ({ value: { kind: "proposal", reply: call.prompt, actions: [] } }));
  registerStepHandler({
    kind: "syn.q",
    async run(ctx) {
      calls.push(ctx.step.id);
      const own = script[ctx.step.id];
      if (own) return own(ctx);
      const code = String(ctx.step.input.code);
      const r = await ctx.ai({ purpose: "syn.q", prompt: `write ${code}`, maxTokens: 500 });
      if (!r.ok) return { status: "retry", reason: r.message };
      return done([q(code)]);
    },
  });
  return { calls };
}
const run = (message = "synthetic: three questions") => runTaskInProcess({ message, definition: empty(), charge: 0.25 });

test("a planned task runs to completed on the base runner: steps committed in plan order, billed once each, the draft replays", async () => {
  const { calls } = synthetic();
  const r = await run();
  assert.equal(r.task.status, "completed", JSON.stringify(r.task.report));
  assert.deepEqual(calls, ["a", "b", "c"]);
  assert.deepEqual(r.task.steps.map((s) => s.status), ["completed", "completed", "completed"]);
  assert.equal(r.task.planner, "synthetic");
  assert.deepEqual(r.task.completion, ["questions>=3", "unique_codes"]);
  assert.equal(r.task.deliverable.questionCount, 3, "the count comes from the planner's criterion");
  /* every step's usage on its row, the task's spend summed from them */
  for (const s of r.task.steps) assert.equal(s.usage?.charge, 0.25, s.stepId);
  assert.equal(taskSpend(r.task).charge, 0.75);
  const draft = buildDraft(r.task);
  assert.equal(countRespondentQuestions(draft.def), 3);
  assert.deepEqual(draft.folded, ["a", "b", "c"]);
  assert.equal(taskResult(r.task).actions.length, 3);
  assert.equal(r.task.report?.ok, true);
});

test("split: a step too big for one answer is tombstoned, its children take its place and its dependants are rewired", async () => {
  synthetic({
    a: async (ctx) => (ctx.step.id === "a" ? { status: "split", reason: "too big", replaceWith: [
      { id: "a1", kind: "syn.q", title: "Write Q1a", dependsOn: [], input: { code: "Q1", units: 1 } },
      { id: "a2", kind: "syn.q", title: "Check Q1", dependsOn: [], input: { code: "", units: 1 } },
    ] } : done()),
    a2: async () => done([]),
  });
  const r = await run();
  assert.equal(r.task.status, "completed", JSON.stringify({ report: r.task.report, steps: r.task.steps.map((s) => [s.stepId, s.status, s.failureMessage]), slices: r.slices.map((x) => x.stoppedBy) }));
  const by = new Map(r.task.steps.map((s) => [s.stepId, s]));
  assert.equal(by.get("a")?.status, "tombstoned");
  assert.equal(by.get("a1")?.status, "completed");
  assert.equal(by.get("a2")?.status, "completed");
  assert.deepEqual([...by.get("b")!.dependsOn].sort(), ["a1", "a2"], "b now waits for both halves");
  assert.equal(r.task.planVersion, 2);
  assert.equal(countRespondentQuestions(buildDraft(r.task).def), 3);
});

test("repair: an invalid output is kept and a targeted repair step follows it; the dependants wait for the repair", async () => {
  let repaired = false;
  synthetic({
    a: async () => ({ status: "repair", output: { actions: [], validation: { ok: false, errors: ["Q1 was not written"], warnings: [] } }, repair: { id: "ar1", kind: "syn.q", title: "Repair Q1", dependsOn: [], input: { code: "Q1", units: 1, round: 1 } } }),
    ar1: async () => { repaired = true; return done([q("Q1")]); },
  });
  const r = await run();
  assert.equal(r.task.status, "completed", JSON.stringify({ report: r.task.report, steps: r.task.steps.map((s) => [s.stepId, s.status, s.failureMessage, s.dependsOn]) }));
  assert.ok(repaired);
  const by = new Map(r.task.steps.map((s) => [s.stepId, s]));
  assert.equal(by.get("a")?.validation?.status, "invalid");
  assert.deepEqual(by.get("ar1")?.dependsOn, ["a"]);
  assert.ok(by.get("b")!.dependsOn.includes("ar1"), "b waits for the repair");
  assert.equal(r.task.steps.map((s) => s.stepId).join(","), "a,ar1,b,c", "the repair sits right after its step");
});

test("retry: a transient answer is retried on the same row with its count kept, committed once, Retry-After honoured", async () => {
  let n = 0;
  synthetic({ b: async () => (++n < 3 ? { status: "retry", reason: "rate_limit: slow down", retryAfterMs: 5 } : done([q("Q2")])) });
  const r = await runTaskInProcess({ message: "synthetic", definition: empty() });
  assert.equal(r.task.status, "completed", JSON.stringify({ report: r.task.report, steps: r.task.steps.map((s) => [s.stepId, s.status, s.retryCount, s.failureMessage]), slices: r.slices.map((x) => [x.stoppedBy, x.built]) }));
  const b = r.task.steps.find((s) => s.stepId === "b")!;
  assert.equal(b.retryCount, 2);
  assert.equal(n, 3);
  assert.equal(r.task.steps.filter((s) => s.stepId === "b").length, 1, "one row, never a second");
});

test("failed (permanent): the step stops with the handler's own sentence, the task fails and everything built is preserved", async () => {
  synthetic({ b: async () => ({ status: "failed", reason: "Q2 already exists in the survey — ask again to re-plan.", permanent: true }) });
  const r = await run();
  assert.equal(r.task.status, "failed");
  const by = new Map(r.task.steps.map((s) => [s.stepId, s]));
  assert.equal(by.get("a")?.status, "completed", "what was built stays");
  assert.equal(by.get("b")?.status, "failed");
  assert.equal(by.get("b")?.failureKind, "permanent");
  assert.match(by.get("b")?.failureMessage ?? "", /already exists/);
  assert.equal(by.get("c")?.status, "pending");
});

test("blocked: the task pauses (needs_attention) with the reason, the step goes back to pending without spending an attempt; Resume carries on", async () => {
  let blocked = true;
  synthetic({ b: async () => (blocked ? { status: "blocked", reason: "The AI provider refused the key.", needs: "auth" } : done([q("Q2")])) });
  const r = await run();
  assert.equal(r.task.status, "needs_attention");
  assert.equal(r.task.blocked?.reason, "auth");
  assert.match(r.task.blocked?.message ?? "", /refused the key/);
  const b = r.task.steps.find((s) => s.stepId === "b")!;
  assert.equal(b.status, "pending");
  assert.equal(b.retryCount, 0);
  assert.equal(r.slices[r.slices.length - 1]!.stoppedBy, "blocked");
  /* a slice on a paused task runs nothing */
  const again = await sliceInProcess(r.store, r.task.id);
  assert.equal(again.stoppedBy, "paused");
  assert.deepEqual(again.built, []);
  /* Resume */
  blocked = false;
  await r.store.pause(r.task.id, null);
  const after = await sliceInProcess(r.store, r.task.id);
  assert.equal(after.status, "completed", JSON.stringify(after.report));
  assert.deepEqual(after.built, ["b", "c"]);
});

test("a killed slice resumes from the earliest incomplete step: nothing completed is rebuilt or re-billed (D)", async () => {
  const { calls } = synthetic();
  const store = isolatedTaskStore();
  const deps = testDeps(store, undefined, 0.5);
  const plan = await createPlannedTask(deps, { surveyId: "sv", message: "synthetic", definition: empty(), deadline: Date.now() + 10_000 });
  assert.ok(plan.ok);
  const task = plan.ok ? plan.task : null!;
  /* the first slice builds one step and is "killed" (maxSteps) */
  const first = await runSlice(task.id, { budgetMs: 60_000, store, buildStep: handlerBuildStep(deps, task), check: (t) => taskCheck(deps, t), maxSteps: 1, sleep: quickSleep, deadlineSleep: guardSleep });
  assert.deepEqual(first.built, ["a"]);
  assert.deepEqual(first.remaining, ["b", "c"]);
  assert.equal(first.stoppedBy, "max_steps");
  const chargeAfterFirst = taskSpend((await store.load(task.id))!).charge;
  assert.equal(chargeAfterFirst, 0.5);
  /* a second worker (another process, the cron) picks up at b */
  const second = await runSlice(task.id, { budgetMs: 60_000, store, buildStep: handlerBuildStep(deps, (await store.load(task.id))!), check: (t) => taskCheck(deps, t), sleep: quickSleep, deadlineSleep: guardSleep });
  assert.deepEqual(second.built, ["b", "c"]);
  assert.equal(second.status, "completed");
  assert.deepEqual(calls, ["a", "b", "c"], "a was built exactly once");
  assert.equal(taskSpend((await store.load(task.id))!).charge, 1.5, "three steps, billed once each");
});

test("checkPlan refuses duplicate ids, unknown dependencies, cycles and unregistered kinds; specToSeed binds the key to the input", () => {
  const has = (k: string) => k === "x";
  assert.deepEqual(checkPlan([{ id: "a", kind: "x", title: "", dependsOn: [], input: {} }], has), []);
  assert.match(checkPlan([{ id: "a", kind: "x", title: "", dependsOn: [], input: {} }, { id: "a", kind: "x", title: "", dependsOn: [], input: {} }], has)[0]!, /duplicate/);
  assert.match(checkPlan([{ id: "a", kind: "x", title: "", dependsOn: ["z"], input: {} }], has)[0]!, /unknown step z/);
  assert.match(checkPlan([{ id: "a", kind: "x", title: "", dependsOn: ["b"], input: {} }, { id: "b", kind: "x", title: "", dependsOn: ["a"], input: {} }], has)[0]!, /cycle/);
  assert.match(checkPlan([{ id: "a", kind: "nope", title: "", dependsOn: [], input: {} }], has)[0]!, /no handler/);
  const s1 = specToSeed("sv", { id: "b01", kind: "x", title: "t", dependsOn: ["s"], input: { codes: ["Q1"], units: 1 } });
  const s2 = specToSeed("sv", { id: "b01", kind: "x", title: "t", dependsOn: ["s"], input: { codes: ["Q2"], units: 1 } });
  assert.notEqual(s1.idempotencyKey, s2.idempotencyKey, "a changed input is new work");
  assert.equal(s1.batchSize, 1);
  assert.equal(deliverableOf("survey_build", "add 30 questions to this survey", ["questions>=42"]).questionCount, 42);
  assert.equal(deliverableOf("survey_build", "UPSC mock test with 100 questions and an answer key", ["questions>=100"]).kind, "survey_build", "an exam without the assessment planner is a survey build");
});

/* ------------------------------------------------------------ the real generation planner on the production prompts */

const UPSC = "मुझे UPSC प्रीलिम्स की तैयारी के लिए एक मॉक टेस्ट चाहिए। इसमें General Studies Paper 1 के 100 questions होने चाहिए — इतिहास, भूगोल, राजव्यवस्था, अर्थव्यवस्था, पर्यावरण, विज्ञान और करंट अफेयर्स से। हर प्रश्न multiple choice हो, चार विकल्प के साथ, और हर प्रश्न का सही उत्तर और एक छोटी व्याख्या भी दो। कठिनाई स्तर असली UPSC परीक्षा जैसा होना चाहिए। प्रश्न हिंदी में हों।";

test("A: the production UPSC request (650 chars, Hindi, 100 questions) plans as a task of small steps and completes with exactly 100 questions", async () => {
  __resetTaskRegistry(); __resetFakeResponders();
  const r = await runTaskInProcess({ message: UPSC, definition: empty() });
  assert.equal(r.task.planner, "generation");
  const batches = r.task.steps.filter((s) => s.kind === "gen.batch");
  assert.ok(batches.length >= 5 && batches.length <= 20, `batches ${batches.length}`);
  for (const b of batches) assert.ok((b.batchSize ?? 0) <= 20, `batch ${b.stepId} of ${b.batchSize}`);
  assert.equal(r.task.status, "completed", JSON.stringify(r.task.report?.problems));
  const def = buildDraft(r.task).def;
  assert.equal(countRespondentQuestions(def), 100);
  assert.equal(new Set(def.questions.map((x) => x.code)).size, 100);
  assert.equal(r.task.deliverable.questionCount, 100);
});

test("B: a 104-question follow-up 'add an explanation to every question' runs as edit batches, each ≤ 20 questions", async () => {
  __resetTaskRegistry(); __resetFakeResponders();
  const base = SurveyDefinition.parse({ meta: { id: "s", code: "S", title: "T" }, questions: [], flow: [{ type: "end", id: "e_ok", status: "complete" }], deployment: { clientSlug: "c", studySlug: "s" } });
  const big = (await runTaskInProcess({ message: "Create a 104-question survey about mobile banking", definition: base })).task;
  assert.equal(big.status, "completed", JSON.stringify(big.report?.problems));
  const def = buildDraft(big).def;
  assert.equal(countRespondentQuestions(def), 104);
  const r = await runTaskInProcess({ message: "Add an explanation to every question", definition: def });
  assert.equal(r.task.planner, "generation");
  const edits = r.task.steps.filter((s) => s.kind === "gen.edit_batch");
  assert.ok(edits.length >= 6, `edit batches ${edits.length}`);
  for (const e of edits) assert.ok((e.batchSize ?? 0) <= 20, `${e.stepId} of ${e.batchSize}`);
  assert.equal(r.task.status, "completed", JSON.stringify(r.task.report?.problems));
});

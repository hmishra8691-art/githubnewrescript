import { test } from "node:test";
import assert from "node:assert/strict";
import { SurveyDefinition } from "@rescript/schema";
import { applySurveyActions, coerceSurveyActions, validateSurveyDeliverable, parseCompletionCriteria, listBlocks, type SurveyAction } from "@rescript/engine";
import { __resetTaskRegistry, getStepHandler } from "../registry.ts";
import { __resetFakeResponders, registerFakeResponder } from "../fakeResponders.ts";
import { buildDraft, replayActions } from "../draft.ts";
import { taskResult } from "../engine.ts";
import { runTaskInProcess } from "../testing.ts";
import type { AiFn, StepContext, TaskStepSpec } from "../types.ts";
import { registerGenerationTasks, generationPlanner, buildGenerationSteps } from "./generation.ts";
import { generationFakeResponder } from "./generationFake.ts";

/*
 * GENERATION AS A DURABLE TASK (K2's tests re-expressed on the base runner, 2026-10-29): the planner, the handlers
 * with the fake provider's deterministic stand-in, and whole tasks run through `runSlice` + `handlerBuildStep`
 * in-process on the memory store — 300 questions with logic, quotas and randomization; an output-limit failure
 * split; an invalid batch repaired; a killed slice resumed without a second charge for what was built; a bulk
 * edit; CBC and MaxDiff designs validated by design criteria.
 */

const empty = () => SurveyDefinition.parse({ meta: { id: "s", code: "S", title: "T" }, questions: [], flow: [{ type: "end", id: "e_ok", status: "complete" }], deployment: { clientSlug: "c", studySlug: "s" } });
const fakeAi: AiFn = async (call) => {
  const r = generationFakeResponder({ ...call });
  if (!r) return { ok: false, kind: "invalid_output", message: "no stand-in" };
  if ("fail" in r) return { ok: false, kind: r.fail, message: r.message ?? r.fail };
  return { ok: true, value: r.value, usage: { inputTokens: 1, outputTokens: 1, cacheRead: 0, cacheWrite: 0, usd: 0, model: "fake", billable: true } };
};
function setup() { __resetTaskRegistry(); __resetFakeResponders(); registerGenerationTasks(); }
const replay = (def: SurveyDefinition, actions: unknown[], seed: string) => replayActions(def, actions, seed);

/* ------------------------------------------------------------ the planner */

test("planner: matches large generations, bulk edits and designs — not small requests or translations; an exam at a score the assessment planner beats", () => {
  setup();
  const m = (msg: string, s: unknown = empty()) => generationPlanner.matches({ message: msg, survey: s });
  assert.ok(m("Create a 300-question survey on streaming habits with display logic, skips, quotas and randomization") >= 0.9);
  assert.ok(m("Build a 60 question customer satisfaction survey") >= 0.8);
  assert.equal(m("Add an NPS question"), 0);
  assert.equal(m("Create 10 questions about coffee"), 0);
  assert.equal(m("UPSC प्रीलिम्स के लिए 100 प्रश्न बनाओ, answer key के साथ"), 0.7, "an exam: below the assessment planner's 0.9, above nothing");
  assert.equal(m("Translate the survey into Urdu"), 0);
  assert.equal(m("Design a CBC conjoint study for smartphones"), 0.9);
  assert.equal(m("Add a MaxDiff question with these 8 items"), 0.6);
});

test("planner: a 300-question plan — design, skeleton, adaptive batches, randomization, logic, quotas, final check; codes fixed up front", async () => {
  setup();
  const plan = await generationPlanner.plan({ message: "Create a 300-question survey on streaming habits with display logic, skips, quotas and randomization", survey: empty(), ai: fakeAi });
  const kinds = plan.steps.map((s) => s.kind);
  assert.equal(kinds[0], "gen.design"); assert.equal(kinds[1], "gen.skeleton");
  for (const k of ["gen.batch", "gen.randomization", "gen.logic", "gen.quotas", "gen.validate"]) assert.ok(kinds.includes(k), k);
  const batches = plan.steps.filter((s) => s.kind === "gen.batch");
  const slots = batches.flatMap((b) => (b.input.slots as { code: string; complexity: string }[]));
  assert.equal(slots.length, 300);
  assert.deepEqual(slots.map((s) => s.code), Array.from({ length: 300 }, (_, i) => `Q${i + 1}`));
  for (const b of batches) {
    const s = b.input.slots as { complexity: string }[];
    const complex = s.filter((x) => x.complexity === "complex").length;
    assert.ok(complex ? s.length <= 6 : s.length <= 20, `${b.id}: ${s.length} (${complex} complex)`);
    assert.equal((b.input as { units: number }).units, s.length, "the panel's unit hint");
  }
  assert.ok(batches.some((b) => (b.input.slots as { complexity: string }[])[0].complexity === "complex"), "complex sections get small batches");
  assert.ok(plan.completion.includes("questions>=300") && plan.completion.includes("codes:Q1..Q300") && plan.completion.includes("quotas>=1") && plan.completion.includes("randomizers>=1"));
  const logic = plan.steps.filter((s) => s.kind === "gen.logic");
  for (const l of logic) {
    const last = (l.input.codes as string[]).at(-1)!;
    const owner = batches.find((b) => (b.input.slots as { code: string }[]).some((x) => x.code === last))!;
    assert.ok(l.dependsOn.includes(owner.id) && l.dependsOn.includes(batches[0].id));
  }
});

test("planner: the outline call failing → a standard outline, never a failed plan; the same request → the same plan", async () => {
  setup();
  const failing: AiFn = async () => ({ ok: false, kind: "provider_outage", message: "down" });
  const a = await generationPlanner.plan({ message: "Create a 120 question survey about banking", survey: empty(), ai: failing });
  assert.equal(a.steps.filter((s) => s.kind === "gen.batch").flatMap((b) => b.input.slots as unknown[]).length, 120);
  assert.ok(a.summary.decisions.some((d) => /standard outline/.test(d)));
  const b = await generationPlanner.plan({ message: "Create a 120 question survey about banking", survey: empty(), ai: failing });
  assert.deepEqual(a.steps, b.steps);
});

test("buildGenerationSteps for an exam (E3 calls this): exam batches (half size), answer keys asked for, no research design", async () => {
  setup();
  const r = await buildGenerationSteps({ message: "100 UPSC questions", survey: empty(), count: 100, assessment: { perQuestion: true, optionsCount: 4 }, ai: fakeAi, idPrefix: "g_" });
  assert.ok(!r.steps.some((s) => s.kind === "gen.design"));
  const batches = r.steps.filter((s) => s.kind === "gen.batch");
  assert.ok(batches.every((b) => (b.input.slots as unknown[]).length <= 10 && b.id.startsWith("g_")));
  assert.equal(batches.flatMap((b) => b.input.slots as unknown[]).length, 100);
  assert.ok(r.completion.includes("assessment:100"));
});

/* ------------------------------------------------------------ handlers with the fake provider */

const ctxFor = (step: TaskStepSpec, draft: unknown, ai = fakeAi, attempt = 1): StepContext => ({ taskId: "t1", planVersion: 1, surveyId: "s", attempt, step: { ...step, status: "running" }, deps: {}, draft, summary: { goal: "test", deliverables: [], constraints: [], decisions: [], sourceTurnIds: [] }, ai, deadlineMs: Date.now() + 60_000, signal: new AbortController().signal });

test("handler: an output limit splits the batch in two (never a retry of the same size); a single question cannot be split; auth blocks; a rate limit retries with its Retry-After", async () => {
  setup();
  const plan = await generationPlanner.plan({ message: "Create a 40 question survey", survey: empty(), ai: fakeAi });
  const sk = plan.steps.find((s) => s.kind === "gen.skeleton")!;
  const skel = await getStepHandler("gen.skeleton")!.run(ctxFor(sk, empty()));
  assert.equal(skel.status, "completed");
  const draft = replay(empty(), (skel as { output: { actions: unknown[] } }).output.actions, "sk").def;
  const b1 = plan.steps.find((s) => s.kind === "gen.batch")!;
  const limit: AiFn = async () => ({ ok: false, kind: "output_limit", message: "max_tokens" });
  const r = await getStepHandler("gen.batch")!.run(ctxFor(b1, draft, limit));
  assert.equal(r.status, "split");
  const parts = (r as { replaceWith: TaskStepSpec[] }).replaceWith;
  assert.deepEqual(parts.map((p) => p.id), [`${b1.id}a`, `${b1.id}b`]);
  assert.deepEqual(parts.flatMap((p) => (p.input.slots as { code: string }[]).map((s) => s.code)), (b1.input.slots as { code: string }[]).map((s) => s.code));
  const one = { ...b1, input: { ...b1.input, slots: (b1.input.slots as unknown[]).slice(0, 1) } };
  assert.equal((await getStepHandler("gen.batch")!.run(ctxFor(one, draft, limit))).status, "failed");
  const auth: AiFn = async () => ({ ok: false, kind: "auth", message: "key refused" });
  assert.deepEqual(await getStepHandler("gen.batch")!.run(ctxFor(b1, draft, auth)), { status: "blocked", reason: "key refused", needs: "auth" });
  const rl: AiFn = async () => ({ ok: false, kind: "rate_limit", message: "429", retryAfterMs: 7000 });
  assert.deepEqual(await getStepHandler("gen.batch")!.run(ctxFor(b1, draft, rl)), { status: "retry", reason: "429", retryAfterMs: 7000 });
});

test("handler: an invalid batch keeps what validated and adds ONE targeted repair for exactly the bad question, with the exact error", async () => {
  setup();
  const plan = await generationPlanner.plan({ message: "Create a 40 question survey [fake:invalid-batch]", survey: empty(), ai: fakeAi });
  const sk = plan.steps.find((s) => s.kind === "gen.skeleton")!;
  const skel = await getStepHandler("gen.skeleton")!.run(ctxFor(sk, empty()));
  const draft = replay(empty(), (skel as { output: { actions: unknown[] } }).output.actions, "sk").def;
  const target = plan.steps.find((s) => s.kind === "gen.batch" && (s.input.slots as { section: number }[]).some((x) => x.section === 1))!;
  const ctx = ctxFor(target, draft);
  ctx.summary = { ...ctx.summary, goal: "a survey [fake:invalid-batch]" };
  const r = await getStepHandler("gen.batch")!.run(ctx);
  assert.equal(r.status, "repair", JSON.stringify(r).slice(0, 400));
  const rep = r as Extract<typeof r, { status: "repair" }>;
  const bad = (rep.repair.input.slots as { code: string }[]).map((s) => s.code);
  const firstOfSection = (target.input.slots as { code: string; section: number }[]).find((x) => x.section === 1)!.code;
  assert.deepEqual(bad, [firstOfSection]);
  assert.equal(rep.repair.kind, "gen.batch_repair"); assert.equal(rep.repair.input.round, 1);
  assert.ok((rep.repair.input.errors as string[]).some((e) => /needs options/.test(e)));
  assert.ok(rep.output.actions!.length > 0 && rep.output.actions!.every((a) => (a as { code?: string; target?: string }).code !== firstOfSection));
  const after = replay(draft, rep.output.actions!, "kept").def;
  const r2 = await getStepHandler("gen.batch_repair")!.run({ ...ctxFor(rep.repair, after), summary: ctx.summary });
  assert.equal(r2.status, "completed", JSON.stringify(r2).slice(0, 300));
});

/* ------------------------------------------------------------ whole tasks through the base runner */

const run = (message: string, definition = empty()) => runTaskInProcess({ message, definition, charge: 0.01 });

test("300 questions with display/skip logic (nested AND/OR), quotas and randomization: completes, validates, ids stable, applies in one go", { timeout: 600_000 }, async () => {
  setup();
  const r = await run("Create a 300-question survey on streaming habits with display logic, skips, quotas and randomization");
  assert.equal(r.task.status, "completed", JSON.stringify(r.task.report?.problems?.slice(0, 5)));
  assert.ok(r.task.steps.every((s) => s.status === "completed" || s.status === "tombstoned"));
  const draft = buildDraft(r.task);
  assert.deepEqual(draft.errors, []);
  const def = draft.def;
  const rep = validateSurveyDeliverable(def, parseCompletionCriteria(r.task.completion ?? []));
  assert.equal(rep.ok, true, JSON.stringify(rep.errors.slice(0, 5)));
  assert.equal(rep.stats.respondentQuestions, 300);
  assert.ok(rep.stats.quotas >= 1 && rep.stats.randomizers >= 1);
  assert.equal(new Set(def.questions.map((q) => q.code)).size, 300);
  assert.ok(def.questions.filter((q) => q.displayLogic).length >= 20, "display logic was written");
  assert.ok(def.questions.some((q) => JSON.stringify(q.displayLogic ?? {}).includes("\"not\"")), "a nested AND/OR/NOT condition exists");
  assert.ok(def.questions.some((q) => (q.skipLogic ?? []).length), "skip logic was written");
  assert.deepEqual(buildDraft(r.task).def, def, "the same steps replayed again give byte-identical ids and order");
  const res = taskResult(r.task);
  const applied = applySurveyActions(empty(), coerceSurveyActions(res.actions, 5000).actions, { now: "2026-01-01T00:00:00Z" });
  assert.equal(applied.errors.length, 0, applied.errors.slice(0, 3).join("; "));
  assert.equal(applied.def.questions.length, 300);
  /* one model call per step that calls one: every row's usage is its own */
  const modelSteps = r.task.steps.filter((s) => ["gen.design", "gen.batch", "gen.logic", "gen.quotas"].includes(s.kind ?? ""));
  for (const s of modelSteps) assert.equal(s.usage?.charge, 0.01, `${s.stepId} billed once`);
  assert.equal(r.calls, modelSteps.length + 1, "one call per model step plus the outline");
});

test("an output-limit failure on a batch → split into two; invalid output → targeted repair; bad logic → logic repair; still completes (F: cost per step)", { timeout: 300_000 }, async () => {
  setup();
  let limitOnce = 1;
  registerFakeResponder("gen.batch", (call) => (limitOnce > 0 && /"code":"Q2[0-9]"/.test(call.prompt) && limitOnce-- > 0 ? { fail: "output_limit", message: "max_tokens" } : generationFakeResponder(call)));
  const r = await run("Create a 80-question survey about coffee with display logic [fake:invalid-batch] [fake:bad-logic]");
  assert.equal(r.task.status, "completed", JSON.stringify(r.task.report?.problems?.slice(0, 5)));
  const ids = r.task.steps.map((s) => s.stepId);
  assert.ok(ids.some((i) => /^b\d+a$/.test(i)) && ids.some((i) => /^b\d+b$/.test(i)), `split: ${ids.join(",")}`);
  assert.ok(ids.some((i) => /^b\d+[ab]?r1$/.test(i)), `batch repair: ${ids.join(",")}`);
  assert.ok(ids.some((i) => /^logic\d+r1$/.test(i)), `logic repair: ${ids.join(",")}`);
  const split = r.task.steps.find((s) => s.status === "tombstoned")!;
  assert.ok(split, "the split batch is a tombstone, kept as a record");
  const def = buildDraft(r.task).def;
  assert.equal(def.questions.length, 80);
  const flowCodes = listBlocks(def.flow as unknown[]).flatMap((b) => b.pages.flatMap((p) => p.node.questionIds)).map((id) => def.questions.find((q) => q.id === id)!.code);
  assert.deepEqual(flowCodes, Array.from({ length: 80 }, (_, i) => `Q${i + 1}`), "the repaired question is back in its planned place");
  assert.ok(validateSurveyDeliverable(def, parseCompletionCriteria(r.task.completion ?? [])).ok);
  assert.ok(r.task.steps.filter((s) => s.status === "completed" && s.usage).length >= 8, "cost per step on the rows");
});

test("a killed slice (one step per slice) resumes from the earliest incomplete step: every batch billed once, the task completes (D)", { timeout: 300_000 }, async () => {
  setup();
  const r = await runTaskInProcess({ message: "Create a 60 question survey about travel", definition: empty(), charge: 0.01, slice: { maxSteps: 1 }, maxSlices: 40 });
  assert.equal(r.task.status, "completed", JSON.stringify(r.task.report?.problems?.slice(0, 5)));
  assert.ok(r.slices.length >= 6, `slices ${r.slices.length}`);
  for (const s of r.task.steps) assert.ok(s.retryCount === 0, `${s.stepId} was never retried`);
  const modelSteps = r.task.steps.filter((s) => ["gen.design", "gen.batch", "gen.logic", "gen.quotas"].includes(s.kind ?? ""));
  assert.equal(r.calls, modelSteps.length + 1, "no step paid twice across slices");
});

test("a bulk edit: “add an explanation to every question” on a 60-question survey → every question changed, nothing else", { timeout: 300_000 }, async () => {
  setup();
  const acts: SurveyAction[] = [{ op: "create_block", title: "Main" } as SurveyAction, ...Array.from({ length: 60 }, (_, i) => ({ op: "create_question", code: `Q${i + 1}`, type: "single", text: `Question number ${i + 1} about the topic?`, options: ["Yes", "No"] }) as SurveyAction)];
  const base = applySurveyActions(empty(), acts, { now: "2026-01-01T00:00:00Z" }).def;
  const msg = "Add an explanation to every question";
  assert.ok(generationPlanner.matches({ message: msg, survey: base }) >= 0.75);
  const r = await run(msg, base);
  assert.equal(r.task.status, "completed", JSON.stringify(r.task.report?.problems?.slice(0, 5)));
  const def = buildDraft(r.task).def;
  assert.equal(def.questions.length, 60);
  assert.ok(def.questions.every((q) => /Explanation for/.test(q.instruction ?? "")));
  assert.deepEqual(def.questions.map((q) => q.code), base.questions.map((q) => q.code));
  assert.ok(r.task.steps.filter((s) => s.kind === "gen.edit_batch").length >= 3);
});

test("CBC and MaxDiff studies (G): design generated, validated by design criteria, analysis planned", { timeout: 300_000 }, async () => {
  for (const [msg, kind] of [["Design a CBC conjoint study for smartphones", "conjoint_task"], ["Design a MaxDiff study of smartphone features", "maxdiff_task"]] as const) {
    setup();
    const r = await run(msg);
    assert.equal(r.task.status, "completed", `${msg}: ${JSON.stringify(r.task.report?.problems?.slice(0, 5))}`);
    assert.ok(r.task.completion!.some((c) => c.startsWith("design_valid:")));
    assert.equal(r.task.kind, kind === "maxdiff_task" ? "maxdiff" : "conjoint");
    const def = buildDraft(r.task).def;
    const q = def.questions.find((x) => x.type === kind)!;
    assert.ok(q, `a ${kind} question`);
    assert.equal(def.designs.length, 1);
    assert.ok((def.designs[0].file?.rows?.length ?? 0) > 0, "the design has rows");
    assert.ok(listBlocks(def.flow as unknown[]).some((b) => b.pages.some((p) => p.node.questionIds.includes(q.id))));
    assert.ok(((def.research as { analysisPlan?: { tests?: unknown[] } } | undefined)?.analysisPlan?.tests?.length ?? 0) > 0, "the analysis plan has tests");
    assert.ok(validateSurveyDeliverable(def, parseCompletionCriteria(r.task.completion ?? [])).ok);
  }
});

test("design repair: a MaxDiff refused for its items per task is corrected by the Studio (no second call); a conjoint with a one-level attribute gets a repair round", { timeout: 300_000 }, async () => {
  setup();
  const md = await run("Design a MaxDiff study of smartphone features [fake:bad-design]");
  assert.equal(md.task.status, "completed", JSON.stringify(md.task.report?.problems?.slice(0, 5)));
  const mdStep = md.task.steps.find((s) => s.stepId === "method")!;
  assert.ok(JSON.stringify((mdStep.output as { data?: unknown }).data).includes("Corrected by the Studio"), JSON.stringify((mdStep.output as { data?: unknown }).data));
  setup();
  const cj = await run("Design a CBC conjoint study for smartphones [fake:bad-design]");
  assert.equal(cj.task.status, "completed", JSON.stringify(cj.task.report?.problems?.slice(0, 5)));
  const ids = cj.task.steps.map((s) => `${s.stepId}:${s.kind}:${s.status}`);
  assert.ok(ids.includes("methodr1:gen.methods_design_repair:completed"), ids.join(","));
  const rep = cj.task.steps.find((s) => s.stepId === "methodr1")!;
  assert.ok(/level|attribute/i.test(JSON.stringify(rep.input?.errors)), JSON.stringify(rep.input?.errors));
});

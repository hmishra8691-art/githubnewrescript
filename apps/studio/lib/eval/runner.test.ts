import { test } from "node:test";
import assert from "node:assert/strict";
import { callOf, callsFromContext, runCase, runCases, type RunnerDeps, type UsageLike } from "./runner.ts";
import type { EvalCase } from "./cases.ts";

/* the runner with a stand-in handler: what it sends (memory, the applied survey, undo, plan → build with checkpoints), the meter's events per turn, the spending cap */
function stub(answers: ((body: Record<string, unknown>) => { status?: number; d: Record<string, unknown>; usage?: Partial<UsageLike>[] })[]) {
  const sent: Record<string, unknown>[] = [];
  const usage: UsageLike[] = [];
  let i = 0;
  const deps: RunnerDeps = {
    post: async (body) => { sent.push(structuredClone(body)); const a = answers[Math.min(i++, answers.length - 1)](body); for (const u of a.usage ?? [{}]) usage.push({ eventType: "AI_REQUEST", model: "m", provider: "p", inputUnits: 1000, outputUnits: 100, providerCost: 0.01, customerCharge: 0.02, metadata: { operation: "copilot_edit", tokens: { cachedInput: 600, cacheWrite: 0 }, requests: 1, latencyMs: 50 }, ...u }); return new Response(JSON.stringify(a.d), { status: a.status ?? 200 }); },
    read: async (r) => ({ status: r.status, d: await r.json() }),
    mark: () => usage.length, usageSince: (m) => usage.slice(m),
    fixture: () => ({ v: 0, questions: [{ id: "q1", code: "Q1" }] }),
    apply: (def, actions) => ({ def: { ...(def as object), v: ((def as { v: number }).v ?? 0) + actions.length }, valid: true }),
    memoryFrom: (turns) => ({ history: turns.map((t) => t.user) }),
    fake: true,
  };
  return { deps, sent, usage };
}
const ok = (actions: unknown[] = [{ op: "update_question", target: "Q1" }], extra: Record<string, unknown> = {}) => ({ d: { ok: true, reply: { kind: "edit", reply: "Done.", actions }, validation: { valid: true, results: actions.map((_, index) => ({ index, ok: true })) }, context: { mode: "edit" }, ...extra } });

test("multi-turn: the memory carries the earlier turns, the next turn sees the applied survey, an undo restores it", async () => {
  const { deps, sent } = stub([() => ok(), () => ok(), () => ok()]);
  const c: EvalCase = { id: "c", category: "multi_turn", title: "t", fixture: "x", turns: [{ message: "one", fake: { a: 1 }, selected: "Q1" }, { message: "two" }, { message: "three", undoPrevious: true }] };
  const r = await runCase(c, deps);
  assert.equal(r.passed, true);
  assert.equal(sent[0].surveyId, "sandbox", "only the sandbox project");
  assert.deepEqual(sent[0].fake, { a: 1 }); assert.equal(sent[0].selectedId, "q1");
  assert.deepEqual(sent[1].memory, { history: ["one"] });
  assert.equal((sent[1].definition as { v: number }).v, 1, "turn 2 sees turn 1 applied");
  assert.equal((sent[2].definition as { v: number }).v, 1, "after ⌘Z turn 3 sees the survey before turn 2");
  assert.equal(r.inputTokens, 3000); assert.equal(r.cacheReadTokens, 1800); assert.equal(r.costUsd, 0.03);
});

test("plan → build: the plan is kept, the build sends it and loops over checkpoints with the scripted replies not yet used", async () => {
  const plan = { summary: "s", items: [{ id: "p1", title: "a" }, { id: "p2", title: "b" }], questions: [], assumptions: [] };
  const { deps, sent } = stub([
    () => ({ d: { ok: true, stage: "plan", plan, context: { mode: "generate" } } }),
    () => ({ d: { ok: true, stage: "progress", built: [{ id: "p1", raw: { actions: [] } }], pending: ["p2"], context: {} } }),
    () => ok([{ op: "create_question" }], { stage: "executed" }),
  ]);
  const c: EvalCase = { id: "b", category: "staged_generation", title: "t", fixture: "x", turns: [{ message: "m", stage: "plan", expect: { stage: "plan", planItemsMin: 2 } }, { message: "m", stage: "execute", fake: ["r1", "r2"], expect: { stage: "executed" } }] };
  const r = await runCase(c, deps);
  assert.equal(r.passed, true, JSON.stringify(r.turns.map((t) => t.failed)));
  assert.equal(sent[0].stage, "plan");
  assert.deepEqual(sent[1].plan, plan); assert.deepEqual(sent[1].items, ["p1", "p2"]); assert.deepEqual(sent[1].fake, ["r1", "r2"]);
  assert.deepEqual(sent[2].done, [{ id: "p1", raw: { actions: [] } }], "the checkpoint is sent back");
  assert.deepEqual(sent[2].fake, ["r2"], "the next request gets the replies not yet used");
});

test("budgets fail a case; the spending cap stops the run between cases", async () => {
  const { deps } = stub([() => ({ ...ok(), usage: [{ providerCost: 0.5 }] })]);
  const c: EvalCase = { id: "x", category: "single_edit", title: "t", fixture: "x", turns: [{ message: "m" }] };
  const r = await runCase(c, deps);
  assert.equal(r.passed, false); assert.equal(r.budgetChecks.find((b) => b.name === "cost")!.ok, false);
  deps.stopAt = 0.6;
  const all = await runCases([c, { ...c, id: "y" }, { ...c, id: "z" }], deps, { startedAt: "t", mode: "fake", provider: "fake", model: "fake", key: "fake:fake" });
  assert.deepEqual(all.skipped, ["z"]); assert.equal(all.cases.length, 2);
  assert.ok(all.meta.notes?.some((n) => /spending cap/.test(n)));
});

test("a usage event becomes a call metric with the cache split, both key spellings", () => {
  assert.deepEqual(callOf({ eventType: "AI_REQUEST", model: "m", provider: "p", inputUnits: 10, outputUnits: 2, providerCost: 0.1, customerCharge: 0.2, metadata: { operation: "op", tokens: { cacheRead: 4, cacheWrite: 3 }, requests: 2, latencyMs: 7, byok: true } }),
    { operation: "op", model: "m", provider: "p", inputTokens: 10, outputTokens: 2, cacheReadTokens: 4, cacheWriteTokens: 3, requests: 2, providerCostUsd: 0.1, chargeUsd: 0.2, latencyMs: 7, byok: true });
});

test("without meter events the route's own per-call measure is used — cache write included", async () => {
  const { deps } = stub([() => ok([], { context: { mode: "edit", calls: [{ operation: "copilot_edit", inputTokens: 9000, outputTokens: 200, cachedInputTokens: 4000, cacheWriteTokens: 4171, latencyMs: 900 }] } })]);
  deps.usageSince = () => [];
  const r = await runCase({ id: "m", category: "single_edit", title: "t", fixture: "x", turns: [{ message: "m" }] }, deps);
  assert.equal(r.cacheReadTokens, 4000); assert.equal(r.cacheWriteTokens, 4171); assert.equal(r.inputTokens, 9000);
  assert.deepEqual(callsFromContext({ context: { calls: [{ operation: "x", cachedInputTokens: 1 }] } })[0].cacheWriteTokens, 0, "an older route without the field: 0");
});

import { test } from "node:test";
import assert from "node:assert/strict";
import { SurveyDefinition } from "@rescript/schema";
import { stuckOn } from "../copilot/runner.ts";
import { taskResult } from "./engine.ts";
import { GENERATION_HANDLERS } from "./handlers/generation.ts";

/**
 * 2026-11-07 — "a single failed task must never invalidate the workflow". Partial results, a task that stops (and
 * says why) instead of hanging, and a final check that orders small targeted repairs instead of one giant one.
 */
const st = (stepId: string, status: string, dependsOn: string[] = [], extra: Record<string, unknown> = {}) => ({ stepId, status, dependsOn, retryCount: 0, title: stepId, planVersion: 1, idempotencyKey: stepId, ...extra }) as never;

test("partial apply: a stopped task hands over every completed step's changes, step by step, with what is left named", () => {
  const r = taskResult({ status: "failed", steps: [
    st("b1", "completed", [], { output: { actions: [{ op: "create_question", code: "Q1" }] } }),
    st("b2", "completed", [], { output: { actions: [{ op: "create_question", code: "Q2" }, { op: "create_question", code: "Q3" }] } }),
    st("rep", "failed", ["b1", "b2"], { failureMessage: "the answer was too long", title: "Repair" }),
    st("key", "pending", ["rep"], { title: "Answer key check" }),
  ] } as never);
  assert.equal(r.partial, true);
  assert.equal(r.actions.length, 3, "38 of 50 repaired → those 38 are applicable: here 3 changes from the 2 finished steps");
  assert.deepEqual(r.byStep.map((b) => [b.stepId, b.actions.length]), [["b1", 1], ["b2", 2]]);
  assert.deepEqual(r.unresolved.map((u) => [u.title, u.reason]), [["Repair", "the answer was too long"], ["Answer key check", "not run yet"]]);
});

test("a task whose only open steps are a failed one and those waiting on it STOPS and says so — it does not hang 'running'", () => {
  const msg = stuckOn({ steps: [st("a", "completed"), st("rep", "failed", ["a"], { failureMessage: "x", title: "Repair 1 problem" }), st("key", "pending", ["rep"])] } as never);
  assert.match(msg ?? "", /“Repair 1 problem” \(x\) could not be completed, and 1 step depending on it could not run\. The 1 completed step is kept and can be reviewed and applied now; Retry runs only what failed\./);
  assert.equal(stuckOn({ steps: [st("a", "failed"), st("b", "pending")] } as never), null, "an independent step can still run — not stuck");
  assert.equal(stuckOn({ steps: [st("a", "failed"), st("b", "running")] } as never), null);
});

test("the final check repairs in small targeted steps side by side, then checks again — never one giant answer", async () => {
  const qs = Array.from({ length: 9 }, (_, i) => ({ id: `q${i + 1}`, code: `Q${i + 1}`, variableName: `Q${i + 1}`, type: "single_select", text: i === 8 ? "Which party did you vote for?" : `Question number ${i + 1} about voting?`, options: [{ code: 1, label: "Yes" }, { code: 2, label: "No" }] }));
  qs[3].text = "Which party did you vote for?"; // Q4 duplicates Q9
  const draft = SurveyDefinition.parse({ meta: { id: "s", code: "S", title: "S", version: "1" }, questions: qs, flow: [{ id: "b1", type: "block", title: "Main", children: [{ id: "p1", type: "page", questionIds: qs.map((q) => q.id) }] }] });
  const slots = Array.from({ length: 16 }, (_, i) => ({ n: i + 1, code: `Q${i + 1}`, variable: `Q${i + 1}`, block: "Main", section: 0, complexity: "simple" }));
  const validate = GENERATION_HANDLERS.find((h) => h.kind === "gen.validate")!;
  const ctx = { taskId: "t", planVersion: 1, surveyId: "s", attempt: 0, step: { id: "g_validate", kind: "gen.validate", title: "Final check", dependsOn: ["g_b01"], input: { criteria: ["questions>=16", "no_duplicate_text"], slotBlocks: Object.fromEntries(slots.map((s) => [s.code, "Main"])), assessment: false, slots, sections: [{ index: 0, title: "Main", from: "Q1", to: "Q16" }], exam: null, total: 16, round: 0 }, status: "running" }, deps: {}, draft, summary: { goal: "g", deliverables: [], constraints: [], decisions: [], sourceTurnIds: [] }, ai: async () => ({ ok: false, kind: "unknown", message: "" }), deadlineMs: Date.now() + 1e4, signal: new AbortController().signal } as never;
  const r = await validate.run(ctx);
  assert.equal(r.status, "split", JSON.stringify(r).slice(0, 300));
  const kids = (r as { replaceWith: { id: string; kind: string; title: string; dependsOn: string[]; parallelGroup?: string; input: Record<string, unknown> }[] }).replaceWith;
  const missing = kids.filter((k) => k.kind === "gen.batch_repair");
  assert.deepEqual(missing.map((k) => k.title), ["Write the missing questions Q10–Q14", "Write the missing questions Q15–Q16"], "the 7 missing planned codes, five at a time, by name");
  const fixes = kids.filter((k) => k.kind === "gen.repair");
  assert.ok(fixes.length >= 1 && fixes.every((f) => f.input.scoped === true), "duplicate wording fixed in a scoped step");
  assert.ok([...missing, ...fixes].every((k) => k.parallelGroup === "repair"), "the repairs run side by side");
  const recheck = kids.find((k) => k.kind === "gen.validate")!;
  assert.deepEqual(recheck.dependsOn.sort(), [...missing, ...fixes].map((k) => k.id).sort(), "a fresh final check after them");
  assert.equal(recheck.input.round, 1);
  /* after three rounds it stops and names what is left, keeping everything repaired */
  const last = await validate.run({ ...(ctx as object), step: { ...(ctx as { step: object }).step, input: { ...((ctx as { step: { input: object } }).step.input), round: 3 } } } as never);
  assert.equal(last.status, "failed");
  assert.match((last as { reason: string }).reason, /Everything that was repaired is kept and can be applied/);
});

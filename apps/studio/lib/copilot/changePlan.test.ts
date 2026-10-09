import { test } from "node:test";
import assert from "node:assert/strict";
import { coerceChangePlan, executeItemPrompt, mergeItemReplies, planStagePrompt, CHANGE_PLAN_SCHEMA } from "./changePlan.ts";

/* Phase 2: the change plan is read strictly, prompted for precisely, and its items' replies merge into one proposal. */
test("a plan is read with stable ids, bounded sizes and a default summary; nothing plan-shaped is null", () => {
  const plan = coerceChangePlan({ kind: "plan", items: [
    { title: "Record the research design", kind: "design", objects: [], reason: "the hypothesis names the constructs" },
    { id: "p1", title: "Add a screener block", kind: "create", objects: ["Screener"], reason: "the population is adults 18+" },
    { id: "p1", title: "Add a purchase-intent block", kind: "create", objects: ["Intent"], reason: "H1", detail: "three 5-point items" },
    { title: "", kind: "create", reason: "no title" },
    { title: "Plan the analysis", kind: "nonsense", reason: "H1, H2" },
  ], questions: ["Which brands?"], assumptions: ["online panel"] });
  assert.ok(plan);
  assert.deepEqual(plan!.items.map((i) => i.id), ["p1", "p2", "p3", "p5"], "a missing id is made, a repeated one replaced");
  assert.equal(plan!.items[3].kind, "other", "an unknown kind is 'other'");
  assert.equal(plan!.items[2].detail, "three 5-point items");
  assert.equal(plan!.summary, "4 changes");
  assert.deepEqual(plan!.questions, ["Which brands?"]);
  assert.equal(coerceChangePlan({ kind: "proposal", actions: [] }), null);
  assert.equal(coerceChangePlan({ kind: "plan", items: [] }), null);
  assert.equal(coerceChangePlan("plan"), null);
  assert.ok(CHANGE_PLAN_SCHEMA.schema.required.includes("items"));
});

test("the prompts: the plan stage forbids actions; an item's execution names the item, the plan and what was built already", () => {
  assert.match(planStagePrompt(), /NO ACTIONS/);
  assert.match(planStagePrompt(), /"kind":"plan"/);
  const plan = coerceChangePlan({ kind: "plan", summary: "A brand-switching questionnaire", items: [{ id: "a", title: "Record the design", kind: "design", reason: "r1" }, { id: "b", title: "Add the screener", kind: "create", objects: ["Screener"], reason: "r2", detail: "age and gender" }] })!;
  const p = executeItemPrompt(plan, plan.items[1], 1, plan.items, ["Record the design"]);
  assert.match(p, /BUILD ITEM 2 ONLY: "Add the screener" — age and gender \(r2\)/);
  assert.match(p, /1\. Record the design\n2\. Add the screener \[Screener\]/);
  assert.match(p, /ALREADY BUILT .*: Record the design/);
  assert.match(p, /ACTIONS FOR THIS ITEM ONLY/);
  assert.doesNotMatch(executeItemPrompt(plan, plan.items[0], 0, plan.items, []), /ALREADY BUILT/);
});

test("the items' replies merge in plan order into one proposal, with the plan carried as its blocks", () => {
  const plan = coerceChangePlan({ kind: "plan", items: [{ id: "a", title: "Design", kind: "design", reason: "why a" }, { id: "b", title: "Screener", kind: "create", reason: "why b" }] })!;
  const merged = mergeItemReplies([
    { item: plan.items[0], raw: { kind: "proposal", reply: "Recorded the objective.", actions: [{ op: "set_research", objective: "x" }], assumptions: ["one"], understanding: { hypotheses: ["H1"] } } },
    { item: plan.items[1], raw: { kind: "proposal", reply: "Two screener questions.", actions: [{ op: "create_question", type: "numeric", text: "Age?" }, { op: "create_question", type: "single_select", text: "Gender?", options: ["Male", "Female"] }], memory: "m" } },
  ]);
  assert.equal(merged.kind, "proposal");
  assert.equal((merged.actions as unknown[]).length, 3);
  assert.equal((merged.actions as { op: string }[])[0].op, "set_research");
  assert.equal(merged.reply, "Design: Recorded the objective. Screener: Two screener questions.");
  assert.deepEqual(merged.plan, [{ block: "Design", purpose: "why a" }, { block: "Screener", purpose: "why b" }]);
  assert.deepEqual(merged.assumptions, ["one"]);
  assert.deepEqual(merged.understanding, { hypotheses: ["H1"] });
  assert.equal(merged.memory, "m");
  const empty = mergeItemReplies([{ item: plan.items[0], raw: null }]);
  assert.equal(empty.reply, "Built 1 item of the plan.");
  assert.deepEqual(empty.actions, []);
});

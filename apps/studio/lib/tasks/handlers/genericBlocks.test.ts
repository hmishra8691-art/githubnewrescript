import { test } from "node:test";
import assert from "node:assert/strict";
import { applySurveyActions } from "@rescript/engine";
import { SurveyDefinition } from "@rescript/schema";
import { genericPlanner, withMissingBlocks } from "./generic.ts";

/**
 * THE 2026-11-07 BUG: "Write questions 11–20 — invalid_output: there is no block 'Core Constructs'", four retries, then
 * failed. The batches ran side by side on the same old draft, so a block one batch made was invisible to the next.
 */
const empty = SurveyDefinition.parse({ meta: { id: "s", code: "S", title: "S", version: "1" }, questions: [], flow: [] }) as never;

test("batches run one after another, so each sees the blocks and codes written before it", async () => {
  const p = await genericPlanner.plan({ message: "Generate 40 questions about voting behaviour", survey: empty, ai: (async () => ({})) as never });
  const gens = p.steps.filter((s) => s.kind === "copilot.generate");
  assert.ok(gens.length >= 2, `planned ${gens.length} batches`);
  for (let i = 1; i < gens.length; i++) assert.deepEqual(gens[i].dependsOn, [gens[i - 1].id], `${gens[i].id} waits for ${gens[i - 1].id}`);
  assert.ok(gens.every((g) => !g.parallelGroup));
});

test("a question put in a block the survey does not have gets the block made first — once — instead of being refused", () => {
  const actions = [
    { op: "create_question", block: "Core Constructs", type: "single_select", text: "How satisfied were you?", code: "Q11", options: [{ code: 1, label: "Very" }, { code: 2, label: "Not" }] },
    { op: "create_question", block: "core constructs", type: "single_select", text: "Which effects?", code: "Q12", options: [{ code: 1, label: "A" }, { code: 2, label: "B" }] },
  ] as never;
  const fixed = withMissingBlocks(actions, empty);
  assert.deepEqual(fixed.map((a) => a.op), ["create_block", "create_question", "create_question"]);
  const r = applySurveyActions(empty, fixed);
  assert.deepEqual(r.errors, []);
  assert.deepEqual(r.def.questions.map((q) => q.code), ["Q11", "Q12"]);
  /* on a draft that already has the block (the replay in plan order), nothing is added */
  assert.deepEqual(withMissingBlocks(actions, r.def).map((a) => a.op), ["create_question", "create_question"]);
});

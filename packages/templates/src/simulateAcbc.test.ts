import { test } from "node:test";
import assert from "node:assert/strict";
import { SurveyDefinition } from "@rescript/schema";
import { acbcDone } from "@rescript/engine";
import { simulateRespondent, defaultAnswer } from "./index.js";

/** METHOD-13: a required ACBC question no longer blocks a simulated walk — the headless respondent completes the exercise. */
const survey = (designs: unknown[]) => SurveyDefinition.parse({
  meta: { id: "a", code: "A", title: "ACBC", version: "1" },
  questions: [
    { id: "q1", code: "Q1", variableName: "Q1", type: "acbc_task", text: "Build your laptop", required: true, settings: { designRef: "d1" } },
    { id: "q2", code: "Q2", variableName: "Q2", type: "open_text", text: "Why?" },
  ],
  flow: [{ type: "page", id: "p1", questionIds: ["q1"] }, { type: "page", id: "p2", questionIds: ["q2"] }, { type: "end", id: "e", status: "complete" }],
  designs,
});
const acbc = {
  id: "d1", name: "Laptop", kind: "acbc",
  config: { attributes: [
    { name: "Brand", levels: ["Apex", "Bolt", "Core"] },
    { name: "Price", levels: ["$199", "$299", "$399"] },
    { name: "Colour", levels: ["Black", "Silver"] },
  ], screeningTasks: 3 },
};

test("METHOD-13: simulate answers an acbc_task with a complete exercise and walks past it", () => {
  const def = survey([acbc]);
  const state = { seed: 7 } as Parameters<typeof defaultAnswer>[2]["state"];
  const a = defaultAnswer(def, def.questions[0], { state, loop: null });
  assert.ok(acbcDone(a), "the exercise reaches a winner");
  const run = simulateRespondent(def, { answers: {}, seed: 3 });
  assert.equal(run.blocked, undefined, `not blocked: ${JSON.stringify(run.blocked)}`);
  assert.equal(run.endStatus, "complete");
  assert.ok(acbcDone(run.state.answers.q1));
});

test("METHOD-13: with no ACBC design there is nothing honest to answer — null, as before", () => {
  const def = survey([{ ...acbc, kind: "maxdiff" }]);
  const state = { seed: 1 } as Parameters<typeof defaultAnswer>[2]["state"];
  assert.equal(defaultAnswer(def, def.questions[0], { state, loop: null }), null);
});

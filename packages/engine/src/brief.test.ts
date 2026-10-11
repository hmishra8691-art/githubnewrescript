import { test } from "node:test";
import assert from "node:assert/strict";
import { SurveyDefinition } from "@rescript/schema";
import { interpretRequest, type Interpretation } from "./nlIntent.js";
import { applySurveyActions, coerceSurveyActions, describeAction } from "./surveyActions.js";
import { changeItems } from "./changeItems.js";
import { objectiveFromBusinessQuestion, researchWorkflow } from "./researchPlanner.js";

/**
 * THE PROJECT BRIEF (Phase 8): the client's question and decision behind the
 * objective — recorded by sentence, merged field by field, read back, carried
 * by the planner into the objective.
 */
const opts = (...ls: string[]) => ls.map((l, i) => ({ code: i + 1, label: l }));
function survey(): SurveyDefinition {
  return SurveyDefinition.parse({
    meta: { id: "s", code: "B", title: "Brief" },
    questions: [{ id: "q1", code: "Q1", variableName: "AGE", type: "numeric", text: "How old are you?" }, { id: "q2", code: "Q2", variableName: "BRAND", type: "single_select", text: "Which brand do you prefer?", options: opts("A", "B") }],
    flow: [{ type: "page", id: "p1", questionIds: ["q1", "q2"] }, { type: "end", id: "e", status: "complete" }],
  });
}
const actionsOf = (r: Interpretation) => { assert.equal(r.kind, "actions", JSON.stringify(r)); return r as Extract<Interpretation, { kind: "actions" }>; };

test("the brief by sentence: each field one action, merged into what is recorded; lists added to; read back; nothing twice", () => {
  let def = survey();
  const say = (t: string) => { const r = actionsOf(interpretRequest(def, t, {})); const a = applySurveyActions(def, r.actions); assert.equal(a.valid, true, a.errors.join("; ")); def = a.def; return { r, a }; };
  const c = say("the client is Acme Foods");
  assert.deepEqual(c.r.actions, [{ op: "set_research", brief: { client: "Acme Foods" } }]);
  assert.equal(c.a.results[0].description, "Research design: brief (client)");
  assert.equal(describeAction(c.r.actions[0]), "Record the project brief (client)");
  say("set the business question to Should we cut the price of Brand A?");
  assert.equal(def.research?.brief?.businessQuestion, "Should we cut the price of Brand A?", "the question mark the sentence lost comes back");
  assert.equal(def.research?.brief?.client, "Acme Foods", "a field set later keeps the one set before");
  say("this study informs the decision to launch the 500ml pack in Q2");
  assert.equal(def.research?.brief?.decision, "whether to launch the 500ml pack in Q2");
  say("the stakeholders are the CMO, the brand team and the CFO");
  assert.deepEqual(def.research?.brief?.stakeholders, ["the CMO", "the brand team", "the CFO"]);
  say("add stakeholder: the sales director");
  assert.deepEqual(def.research?.brief?.stakeholders, ["the CMO", "the brand team", "the CFO", "the sales director"]);
  const dup = interpretRequest(def, "add stakeholder the CFO", {});
  assert.equal(dup.kind, "refused"); if (dup.kind === "refused") assert.equal(dup.noop, true);
  say("the findings are due by 15 December");
  assert.equal(def.research?.brief?.deadline, "15 December");
  say("background: Brand A lost 4 points of share in 2025");
  say("the deliverables are a report and a deck");
  assert.deepEqual(def.research?.brief?.deliverables, ["a report", "a deck"]);
  const again = interpretRequest(def, "the client is Acme Foods", {});
  assert.equal(again.kind, "refused"); if (again.kind === "refused") { assert.equal(again.noop, true); assert.match(again.reason, /already the client/); }
  // the objective and the rest of the design survive a brief edit, and a brief survives an objective edit
  say("set the research objective to Understand whether to cut the price of Brand A");
  assert.equal(def.research?.brief?.client, "Acme Foods");
  say("the client is Acme Beverages");
  assert.equal(def.research?.objective, "Understand whether to cut the price of Brand A");
  assert.equal(def.research?.brief?.businessQuestion, "Should we cut the price of Brand A?");
  // read back
  const shown = interpretRequest(def, "what is the brief?", {});
  assert.equal(shown.kind, "answer");
  if (shown.kind === "answer") { assert.match(shown.answer, /client — Acme Beverages/); assert.match(shown.answer, /decision it informs — whether to launch/); assert.equal(shown.sections[0].items.length, 8); }
  // the change tree names the field, not "research design"
  const tree = changeItems(survey(), def);
  const fields = tree.items.filter((i) => i.level === "research").map((i) => i.field);
  for (const f of ["client", "business question", "decision", "background", "stakeholders", "deadline", "deliverables", "objective"]) assert.ok(fields.includes(f), `${f} in ${fields.join(", ")}`);
  // not a brief: a question's wording with the word "client" in it
  assert.notEqual(interpretRequest(def, "make Q2 required", {}).kind, "refused");
  const none = interpretRequest(survey(), "what is the brief", {});
  assert.equal(none.kind, "answer"); if (none.kind === "answer") assert.match(none.answer, /No project brief is recorded yet/);
});

test("the planner: with no objective, the brief's business question is offered as the objective; set_research keeps a brief it was not given", () => {
  assert.equal(objectiveFromBusinessQuestion("Should we cut the price of Brand A?"), "Understand whether to cut the price of Brand A");
  assert.equal(objectiveFromBusinessQuestion("Is Brand A losing younger buyers?"), "Understand whether Brand A losing younger buyers");
  assert.equal(objectiveFromBusinessQuestion("Why are customers switching to Brand B"), "Understand why are customers switching to Brand B");
  assert.equal(objectiveFromBusinessQuestion("The drivers of switching"), "The drivers of switching");
  const withBrief = applySurveyActions(survey(), [{ op: "set_research", brief: { businessQuestion: "Should we cut the price of Brand A?", client: "Acme" } }]).def;
  const wf = researchWorkflow(withBrief, {});
  const step = wf.steps.find((s) => s.id === "objective")!;
  assert.equal(step.status, "ready");
  assert.deepEqual(step.actions, [{ op: "set_research", objective: "Understand whether to cut the price of Brand A" }]);
  assert.match(step.why, /The brief asks/);
  const after = applySurveyActions(withBrief, step.actions!).def;
  assert.equal(after.research?.brief?.client, "Acme", "recording the objective keeps the brief");
  assert.equal(researchWorkflow(after, {}).steps.find((s) => s.id === "objective")!.status, "done");
  // the model's brief goes through the gate: blanks dropped, an empty brief not carried, an unknown field not carried
  const gate = coerceSurveyActions([{ op: "set_research", brief: { client: "  ", stakeholders: ["x", ""], decision: "whether to launch", nope: "y" } }, { op: "set_research", brief: { client: "" }, objective: "O" }]);
  assert.deepEqual(gate.actions, [{ op: "set_research", brief: { stakeholders: ["x"], decision: "whether to launch" } }, { op: "set_research", objective: "O" }]);
});

import test from "node:test";
import assert from "node:assert/strict";
import { SurveyDefinition, questionTypeRegistry } from "@rescript/schema";
import { renameImpact, applyRename, normalizeVariableNameInput, sameVariableName } from "./variableUsage.js";
import { renameQuestionCode } from "./renameCode.js";
import { registerBuiltinQuestionTypes } from "./questionTypes.js";
import { nextQuestionNaming } from "./variables.js";
import { resolvePiping } from "./piping.js";
import { createResponseState, getQuestionByCodeOrVar } from "./state.js";
import { flattenVariables } from "./flatten.js";

/**
 * B20 (client review 23/10/2026): the variable name keeps the case the
 * programmer typed (`Q6a` stays `Q6a`), while uniqueness is checked
 * regardless of case so `Q6a` and `Q6A` can never both exist.
 */
const survey = () => SurveyDefinition.parse({
  meta: { id: "case", code: "CASE", title: "Case", version: "1.0" },
  questions: [
    { id: "q1", code: "Q1", variableName: "Q1", type: "numeric", text: "Age?" },
    { id: "q6a", code: "Q6a", variableName: "Q6a", type: "single_select", text: "Pick", options: [{ code: "1", label: "A" }, { code: "2", label: "B" }] },
    { id: "q7", code: "Q7", variableName: "Q7", type: "open_text", text: "You picked {{Q6a}} at age {{Q1}}" },
  ],
  flow: [{ type: "page", id: "p1", questionIds: ["q1", "q6a", "q7"] }, { type: "end", id: "e", status: "complete" }],
});

test("the field normaliser only replaces invalid characters — case is kept", () => {
  assert.equal(normalizeVariableNameInput("Q6a"), "Q6a");
  assert.equal(normalizeVariableNameInput("brand awareness"), "brand_awareness");
  assert.equal(normalizeVariableNameInput("Q6-a.b"), "Q6_a_b");
  assert.equal(normalizeVariableNameInput("Région"), "R_gion");
  assert.ok(sameVariableName("Q6a", "Q6A") && !sameVariableName("Q6a", "Q6b"));
});

test("a mixed-case variable name is accepted by the safe rename and resolves exactly as stored", () => {
  const def = survey();
  const impact = renameImpact(def, "Q7", "Q7_why");
  assert.equal(impact.ok, true, impact.blockers.join("; "));
  const renamed = applyRename(def, "Q7", "Q7_why", { alsoCode: false });
  assert.equal(renamed.questions[2].variableName, "Q7_why");
  // piping and lookups match the stored spelling
  const st = createResponseState(def);
  st.answers.q6a = "2"; st.answers.q1 = 41;
  assert.equal(getQuestionByCodeOrVar(def, "Q6a")?.id, "q6a");
  assert.match(resolvePiping("You picked {{Q6a}} at age {{Q1}}", { def, state: st, loop: null }), /B.*41/);
});

test("uniqueness ignores case: Q6A cannot be taken while Q6a exists, as a variable or as a code", () => {
  const def = survey();
  const asVar = renameImpact(def, "Q7", "Q6A");
  assert.equal(asVar.ok, false);
  assert.match(asVar.blockers.join(" "), /already/i);
  const asLower = renameImpact(def, "Q7", "q1");
  assert.equal(asLower.ok, false, "a lower-case spelling of an existing code is still a clash");
  // a case-only rename of the SAME variable is not blocked by itself
  const own = renameImpact(def, "Q6a", "Q6A");
  assert.equal(own.ok, true, own.blockers.join("; "));
  // codes too
  const code = renameQuestionCode(def, "Q7", "q6A");
  assert.ok(code.problem && /already/.test(code.problem), code.problem);
});

test("a new question's variable name is its code as typed, and the next free Q<n> is found regardless of case", () => {
  registerBuiltinQuestionTypes();
  const q = questionTypeRegistry.get("single_select")!.create({ code: "Q6a" } as never);
  assert.equal(q.variableName, "Q6a");
  const def = survey();
  (def.questions[2] as any).code = "q4"; (def.questions[2] as any).variableName = "q4";
  const next = nextQuestionNaming(def);
  assert.notEqual(next.code.toUpperCase(), "Q4", "q4 is taken whatever its case");
});

test("exports keep working with mixed case: the flattener names columns from the stored name", () => {
  const def = survey();
  const st = createResponseState(def);
  st.answers.q6a = "2"; st.answers.q1 = 41; st.answers.q7 = "x";
  const flat = flattenVariables(def, st);
  const names = Object.keys(flat);
  assert.ok(names.includes("Q6a"), names.join(","));
});

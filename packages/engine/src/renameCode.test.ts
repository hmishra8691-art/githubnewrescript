import { test } from "node:test";
import assert from "node:assert/strict";
import { SurveyDefinition } from "@rescript/schema";
import { renameQuestionCode } from "./renameCode.js";
import { lintSurveyLogic } from "./lintLogic.js";
import { parseLogicExpression } from "./logicExpression.js";

/** LOGIC-02: renaming a question CODE rewrites every text and expression that spelled it. */
const survey = (variableName = "COLOR") => {
  const def = SurveyDefinition.parse({
    meta: { id: "r", code: "R", title: "Rename", version: "1" },
    questions: [
      { id: "q1", code: "Q1", variableName, type: "single_select", text: "Colour?", options: [{ code: "1", label: "Red" }, { code: "2", label: "Blue" }] },
      { id: "q2", code: "Q2", variableName: "WHY", type: "open_text", text: "You said {{Q1.label}} (code {{Q1.value}}); twice {{Q1}} and {{expr: Q1 + 1}} and {{Q10}}", instruction: "see {{ Q1 | upper }}" },
      { id: "q3", code: "Q3", variableName: "NUM", type: "numeric", text: "n" },
    ],
    flow: [{ type: "page", id: "p1", questionIds: ["q1", "q2", "q3"] }, { type: "end", id: "e", status: "complete" }],
    calculations: [{ id: "c1", label: "C", targetVariable: "SCORE", expression: "Q1 * 2 + Q1_2 + sum(Q3) + upper('Q1')", trigger: "on_page_submit", enabled: true }],
  });
  def.questions[2]!.displayLogic = { type: "rule", source: { kind: "expr", ref: "Q1 > 1 AND Q3 > 2" }, operator: "eq", value: true } as never;
  def.namedExpressions = [{ id: "n1", name: "HIGH", when: { type: "rule", source: { kind: "expr", ref: "Q1 >= 2" }, operator: "eq", value: true } }] as never;
  return def;
};

test("code ≠ variable name: pipes, expr pipes, calc and rule expressions, named expressions all follow the rename", () => {
  const def = survey();
  const r = renameQuestionCode(def, "Q1", "Q1b");
  assert.equal(r.problem, undefined);
  const q = (id: string) => r.def.questions.find((x) => x.id === id)!;
  assert.equal(q("q1").code, "Q1b");
  assert.equal(q("q2").text, "You said {{Q1b.label}} (code {{Q1b.value}}); twice {{Q1b}} and {{expr: Q1b + 1}} and {{Q10}}");
  assert.equal(q("q2").instruction, "see {{ Q1b | upper }}");
  assert.equal(r.def.calculations[0]!.expression, "Q1b * 2 + Q1b_2 + sum(Q3) + upper('Q1')", "identifiers only: strings and other names are left alone");
  assert.equal((q("q3").displayLogic as any).source.ref, "Q1b > 1 AND Q3 > 2");
  assert.equal((r.def.namedExpressions![0]!.when as any).source.ref, "Q1b >= 2");
  assert.ok(r.rewritten.length >= 5, r.rewritten.join("\n"));
  assert.ok(r.rewritten.some((w) => w.includes("Calculation C")));
  assert.deepEqual(def, survey(), "the input is never mutated");
});

test("the lint stops reporting 'Pipes from Q1, which does not exist' after a guided rename (and did before)", () => {
  const raw = survey();
  raw.questions[0]!.code = "Q1b";
  assert.ok(lintSurveyLogic(raw).some((i) => /Pipes from .Q1./.test(i.message)), "a raw patch breaks the pipes");
  const r = renameQuestionCode(survey(), "Q1", "Q1b");
  assert.ok(!lintSurveyLogic(r.def).some((i) => /Pipes from .Q1b?”/.test(i.message)), "the guided rename keeps them");
});

test("code == variable name: the old spelling still resolves, so nothing is rewritten", () => {
  const def = survey("Q1");
  const r = renameQuestionCode(def, "Q1", "Q1b");
  assert.equal(r.def.questions[0]!.code, "Q1b");
  assert.deepEqual(r.rewritten, []);
  assert.equal(r.def.questions[1]!.text, def.questions[1]!.text);
});

test("a rule that named the question by code is repointed to its id", () => {
  const def = survey();
  def.questions[2]!.displayLogic = { type: "rule", source: { kind: "question", ref: "Q1" }, operator: "eq", value: { $question: "Q1" } } as never;
  const r = renameQuestionCode(def, "Q1", "Q1b");
  const dl = r.def.questions[2]!.displayLogic as any;
  assert.equal(dl.source.ref, "q1");
  assert.equal(dl.value.$question, "q1");
});

test("clashes and invalid codes are refused with the survey unchanged", () => {
  const def = survey();
  for (const [to, re] of [["Q2", /already the code of Q2/], ["WHY", /already the variable name of Q2/], ["SCORE", /calculation/], ["1bad", /not a valid code/], ["has space", /not a valid code/]] as const) {
    const r = renameQuestionCode(def, "Q1", to);
    assert.match(r.problem ?? "", re, to);
    assert.equal(r.def, def);
  }
  assert.match(renameQuestionCode(def, "NOPE", "Z").problem ?? "", /no question coded NOPE/);
  assert.equal(renameQuestionCode(def, "Q1", "Q1").problem, undefined);
});

test("the editor having already written the new code is tolerated", () => {
  const def = survey();
  def.questions[0]!.code = "Q1b";
  const r = renameQuestionCode(def, "Q1", "Q1b");
  assert.equal(r.problem, undefined);
  assert.match(r.def.questions[1]!.text, /\{\{Q1b\.label\}\}/);
});

test("scripts that mention the code are reported for review, never rewritten", () => {
  const def = survey();
  def.scripts = [{ id: "s1", name: "x", scope: "survey", event: "on_load", enabled: true, code: "const v = get('Q1');" }] as never;
  const r = renameQuestionCode(def, "Q1", "Q1b");
  assert.equal(r.needsReview.length, 1);
  assert.equal(r.def.scripts[0]!.code, "const v = get('Q1');");
});

test("logic typed after the rename resolves the new code", () => {
  const r = renameQuestionCode(survey(), "Q1", "Q1b");
  assert.ok(parseLogicExpression(r.def, "Q1b = 2").condition);
});

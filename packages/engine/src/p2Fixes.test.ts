import { test } from "node:test";
import assert from "node:assert/strict";
import { SurveyDefinition, questionTypeRegistry } from "@rescript/schema";
import { lintSurveyLogic, operatorsForQuestion, choiceDisplayText } from "./lintLogic.js";

/** OR-01 / OR-04 / OR-05 */
test("OR-01: an unknown question type is an error-level lint, naming the type", () => {
  const def = SurveyDefinition.parse({
    meta: { id: "u", code: "U", title: "U", version: "1" },
    questions: [{ id: "q1", code: "Q1", variableName: "Q1", type: "constant_sum", text: "Split", options: [{ code: "1", label: "A" }] }],
    flow: [{ type: "page", id: "p1", questionIds: ["q1"] }, { type: "end", id: "e", status: "complete" }],
  });
  const hit = lintSurveyLogic(def).find((i) => /Unknown question type/.test(i.message));
  assert.ok(hit, "lint reports it");
  assert.equal(hit!.level, "error");
  assert.match(hit!.message, /Unknown question type “constant_sum” — this survey cannot run/);
  assert.equal(hit!.questionId, "q1");
});

test("OR-01: a plugin-registered type is known; every built-in type is known", () => {
  questionTypeRegistry.register({ type: "p2_plugin_type", label: "P2 plugin", category: "custom", features: {}, variables: () => [], create: (p: any) => p } as never);
  const mk = (type: string) => SurveyDefinition.parse({
    meta: { id: "u", code: "U", title: "U", version: "1" },
    questions: [{ id: "q1", code: "Q1", variableName: "Q1", type, text: "x" }],
    flow: [{ type: "page", id: "p1", questionIds: ["q1"] }, { type: "end", id: "e", status: "complete" }],
  });
  assert.ok(!lintSurveyLogic(mk("p2_plugin_type")).some((i) => /Unknown question type/.test(i.message)));
  assert.ok(!lintSurveyLogic(mk("single_select")).some((i) => /Unknown question type/.test(i.message)));
});

test("OR-04: a choice whose code and label are the same prints once", () => {
  assert.equal(choiceDisplayText({ ref: "1", label: "1" }), "1");
  assert.equal(choiceDisplayText({ ref: 3, label: "3" }), "3");
  assert.equal(choiceDisplayText({ ref: "2", label: "Agree" }), "2: Agree");
  assert.equal(choiceDisplayText({ ref: "9", label: "" }), "9");
});

test("OR-05: a composite column takes its own type's operators, not the whole vocabulary", () => {
  const col = (id: string, responseType: string, options: unknown[] = []) => ({ id, label: id, responseType, variableStem: id, options });
  const def = SurveyDefinition.parse({
    meta: { id: "c", code: "C", title: "C", version: "1" },
    questions: [{
      id: "qc", code: "QC", variableName: "QC", type: "composite", text: "t",
      rows: [{ code: "1", label: "r" }],
      columns: [col("n", "numeric"), col("t", "text"), col("m", "multi", [{ code: "1", label: "a" }]), col("s", "single", [{ code: "1", label: "a" }]), col("d", "date")],
    }],
    flow: [{ type: "page", id: "p1", questionIds: ["qc"] }, { type: "end", id: "e", status: "complete" }],
  });
  const q = def.questions[0]!;
  const all = operatorsForQuestion(q);
  assert.ok(all.length > 30, `no column named: the whole vocabulary stays (${all.length})`);
  const num = operatorsForQuestion(q, "n");
  assert.ok(num.includes("gt") && num.includes("between"));
  assert.ok(!num.includes("matches") && !num.includes("rankedFirst") && !num.includes("dateBefore") && !num.includes("containsAll"));
  const txt = operatorsForQuestion(q, "t");
  assert.ok(txt.includes("contains") && txt.includes("matches") && !txt.includes("gt"));
  assert.ok(operatorsForQuestion(q, "m").includes("containsAll") && !operatorsForQuestion(q, "m").includes("gt"));
  assert.ok(operatorsForQuestion(q, "s").includes("selected"));
  assert.ok(operatorsForQuestion(q, "d").includes("dateBefore") && !operatorsForQuestion(q, "d").includes("contains"));
  /* 2026-10-24: a text column also takes "is between (numbers)" / "is not between" (client item A48) — 15 operators, still a short list */
  assert.ok(num.length < 15 && txt.length < 17, "a column's list is short");
  assert.deepEqual(operatorsForQuestion(q, "nope"), all, "an unknown column falls back to the question's vocabulary");
});

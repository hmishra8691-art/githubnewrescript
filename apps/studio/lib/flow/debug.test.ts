import { test } from "node:test";
import assert from "node:assert/strict";
import { SurveyDefinition, cond } from "@rescript/schema";
import { parseAnswers, coerceAnswer, debugPath } from "./debug.ts";

const survey = () =>
  SurveyDefinition.parse({
    meta: { id: "s", code: "S", title: "Debug" },
    questions: [
      { id: "q_age", code: "Q1", variableName: "AGE", type: "numeric", text: "Age",
        skipLogic: [{ id: "sk", when: cond.rule("q_age", "lt", 18), target: { kind: "terminate", status: "screened" } }] },
      { id: "q_type", code: "Q2", variableName: "TYPE", type: "single_select", text: "Type", options: [{ code: "A", label: "Consumer" }, { code: "B", label: "Business" }] },
      { id: "q_c", code: "Q3", variableName: "C", type: "text", text: "Consumer only" },
      { id: "q_b", code: "Q4", variableName: "B", type: "text", text: "Business only" },
      { id: "q_end", code: "Q5", variableName: "E", type: "text", text: "Everyone" },
    ],
    flow: [
      { type: "page", id: "p1", questionIds: ["q_age", "q_type"] },
      { type: "branch", id: "br", branches: [
        { id: "a", when: cond.rule("q_type", "eq", "A"), children: [{ type: "page", id: "pc", questionIds: ["q_c"] }] },
        { id: "b", when: cond.rule("q_type", "eq", "B"), children: [{ type: "page", id: "pb", questionIds: ["q_b"] }] },
      ] },
      { type: "page", id: "p5", questionIds: ["q_end"] },
      { type: "end", id: "e_ok", status: "complete" },
      { type: "end", id: "e_out", status: "screened" },
    ],
    deployment: { clientSlug: "c", studySlug: "s" },
  });

test("parseAnswers reads codes, separators and multi-select lists", () => {
  assert.deepEqual(parseAnswers("Q2=A, Q1: 30; Q11 = 1|3\nQ5=yes"), [["Q2", "A"], ["Q1", "30"], ["Q11", ["1", "3"]], ["Q5", "yes"]]);
  assert.deepEqual(parseAnswers("garbage"), []);
});

test("coerceAnswer maps labels and codes to what the question stores", () => {
  const def = survey();
  assert.equal(coerceAnswer(def, "q_type", "Business"), "B", "a label resolves to its code");
  assert.equal(coerceAnswer(def, "q_type", "A"), "A");
  assert.equal(coerceAnswer(def, "q_age", "30"), 30);
});

test("the path follows a branch arm chosen by the typed answer", () => {
  const def = survey();
  const a = debugPath(def, "Q1=30, Q2=A");
  assert.deepEqual(a.pageIds, ["p1", "pc", "p5"]);
  assert.ok(a.questionIds.has("q_c") && !a.questionIds.has("q_b"));
  assert.equal(a.endStatus, "complete");
  const b = debugPath(def, "Q1=30, Q2=Business");
  assert.deepEqual(b.pageIds, ["p1", "pb", "p5"]);
  assert.equal(b.applied, 2);
});

test("a skip rule fires — this is a walk, not a compile", () => {
  const r = debugPath(survey(), "Q1=16, Q2=A");
  assert.deepEqual(r.pageIds, ["p1"], "screened out after the first page");
  assert.equal(r.endStatus, "screened");
});

test("unknown codes are reported, not silently dropped; nothing typed still walks the default path", () => {
  const r = debugPath(survey(), "Q99=1, Q1=30");
  assert.deepEqual(r.unknown, ["Q99"]);
  assert.equal(r.applied, 1);
  const none = debugPath(survey(), "");
  assert.ok(none.pageIds.length >= 1);
  assert.equal(none.truncated, false);
});

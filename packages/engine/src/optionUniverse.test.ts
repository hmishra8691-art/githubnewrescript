import { test } from "node:test";
import assert from "node:assert/strict";
import { SurveyDefinition } from "@rescript/schema";
import { buildVariableDictionary, flattenVariables, createResponseState, setAnswer, optionUniverse } from "./index.js";

/** 2026-11-02 — a carried list's answers reach the data: declared and written with the source's codes */
const def = SurveyDefinition.parse({
  meta: { id: "s", code: "CF", title: "Carry", version: "1" },
  questions: [
    { id: "q1", code: "Q1", variableName: "Q1", type: "multi_select", text: "Aware?", options: [{ code: 10, label: "Alpha" }, { code: 20, label: "Beta" }, { code: 99, label: "None", flags: ["exclusive"] }] },
    { id: "q2", code: "Q2", variableName: "Q2", type: "multi_select", text: "Bought?", options: [], carryForward: { sourceQuestionId: "q1", filter: "selected", into: "options" } },
    { id: "q3", code: "Q3", variableName: "Q3", type: "single_select", text: "Main?", options: [{ code: 98, label: "Other brand" }], carryForward: { sourceQuestionId: "q2", filter: "selected", into: "options", keepOwn: true } },
  ],
  flow: [{ type: "page", id: "p1", questionIds: ["q1", "q2", "q3"] }],
});

test("the option universe follows a chain of carries, own options first, each code once", () => {
  assert.deepEqual(optionUniverse(def.questions[2], def.questions).map((o) => o.code), [98, 10, 20, 99]);
  assert.deepEqual(optionUniverse(def.questions[0], def.questions).map((o) => o.code), [10, 20, 99], "no carry: its own");
});

test("a carried multi-select is declared and written per source code; a carried single-select gets value labels", () => {
  const names = buildVariableDictionary(def).map((v) => v.name);
  for (const n of ["Q2_10", "Q2_20", "Q2_99"]) assert.ok(names.includes(n), `${n} declared — got ${names.join(", ")}`);
  const q3 = buildVariableDictionary(def).find((v) => v.name === "Q3")!;
  assert.deepEqual(q3.valueLabels, { "98": "Other brand", "10": "Alpha", "20": "Beta", "99": "None" });

  const st = createResponseState(def, { seed: 1 });
  setAnswer(def, st, "q1", [10, 20]);
  setAnswer(def, st, "q2", [20]);
  setAnswer(def, st, "q3", 20);
  const flat = flattenVariables(def, st);
  assert.equal(flat.Q2_10, 0);
  assert.equal(flat.Q2_20, 1);
  assert.equal(flat.Q2_99, 0);
  assert.equal(flat.Q3, 20);
  /* every written per-option column is declared */
  for (const k of Object.keys(flat).filter((k) => /^Q2_/.test(k))) assert.ok(names.includes(k), k);
});

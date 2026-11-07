import { test } from "node:test";
import assert from "node:assert/strict";
import { SurveyDefinition } from "@rescript/schema";
import { importQuestions } from "./questionImport.js";
import { listPages } from "./blocks.js";

const opts = (...ls: string[]) => ls.map((l, i) => ({ code: i + 1, label: l }));
const source = SurveyDefinition.parse({
  meta: { id: "lib", code: "LIB", title: "Library" },
  questions: [
    { id: "a1", code: "Q1", variableName: "Q1", type: "single_select", text: "Own a car?", options: opts("Yes", "No") },
    { id: "a2", code: "Q2", variableName: "Q2", type: "single_select", text: "Brand of your {{Q1}} car?", options: opts("A", "B"),
      displayLogic: { type: "rule", source: { kind: "question", ref: "a1" }, operator: "eq", value: 1 } },
    { id: "a3", code: "Q3", variableName: "Q3", type: "open_text", text: "Why?",
      displayLogic: { type: "rule", source: { kind: "question", ref: "a9" }, operator: "eq", value: 1 } },
    { id: "a9", code: "Q9", variableName: "Q9", type: "single_select", text: "Other", options: opts("x", "y") },
  ],
  flow: [{ type: "page", id: "lp1", title: "Car", questionIds: ["a1", "a2"] }, { type: "page", id: "lp2", questionIds: ["a3", "a9"] }],
});
const target = SurveyDefinition.parse({
  meta: { id: "t", code: "T", title: "Target" },
  questions: [{ id: "t1", code: "Q1", variableName: "Q1", type: "numeric", text: "Age?" }],
  flow: [{ type: "page", id: "tp", questionIds: ["t1"] }, { type: "end", id: "e", status: "complete" }],
});

test("importing a page: fresh ids, a colliding code renamed, rules and piping follow the copies, a block before the end", () => {
  const r = importQuestions(target, source, { pageIds: ["lp1"] });
  assert.equal(r.count, 2);
  const q1 = r.def.questions.find((q) => q.id === r.idMap.a1)!;
  const q2 = r.def.questions.find((q) => q.id === r.idMap.a2)!;
  assert.notEqual(q1.code, "Q1", "Q1 is taken here");
  assert.equal(q2.code, "Q2", "a free code is kept");
  assert.equal((q2.displayLogic as any).source.ref, q1.id, "the rule reads the copied Q1");
  assert.match(q2.text, new RegExp(`\\{\\{${q1.code}\\}\\}`), "piping follows the renamed code");
  assert.equal((r.def.flow.at(-1) as any).type, "end");
  assert.equal((r.def.flow.at(-2) as any).type, "block");
  assert.equal(listPages(r.def.flow as any[]).length, 2);
  assert.deepEqual(r.dropped, []);
  assert.equal(target.questions.length, 1, "the target is not mutated");
});

test("a rule naming a question that was not copied is removed and listed", () => {
  const r = importQuestions(target, source, { questionIds: ["a3"] });
  const q3 = r.def.questions.find((q) => q.id === r.idMap.a3)!;
  assert.equal(q3.displayLogic ?? null, null);
  assert.ok(r.dropped.length >= 1);
});

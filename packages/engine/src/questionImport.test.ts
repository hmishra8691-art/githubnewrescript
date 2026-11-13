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

test("2026-11-14: started from a block — the copies land right after it; in it (keeping its name) while it is still empty", () => {
  const three = SurveyDefinition.parse({
    meta: { id: "t", code: "T", title: "Target" },
    questions: [{ id: "t1", code: "A1", variableName: "A1", type: "numeric", text: "Age?" }, { id: "t2", code: "Z1", variableName: "Z1", type: "open_text", text: "Last" }],
    flow: [{ type: "page", id: "b1", title: "First", questionIds: ["t1"] }, { type: "page", id: "b2", title: "Welcome", questionIds: [] }, { type: "page", id: "b3", title: "Last", questionIds: ["t2"] }, { type: "end", id: "e", status: "complete" }],
  });
  const after = importQuestions(three, source, { pageIds: ["lp1"], intoBlock: "b1" });
  assert.deepEqual((after.def.flow as { id: string; title?: string }[]).map((n) => n.title ?? n.id), ["First", "Imported from Library", "Welcome", "Last", "e"]);
  assert.equal(after.count, 2);
  const into = importQuestions(three, source, { pageIds: ["lp1"], intoBlock: "b2" });
  assert.deepEqual((into.def.flow as { id: string; title?: string }[]).map((n) => n.title ?? n.id), ["First", "Welcome", "Last", "e"], "the empty block is filled, not left empty above a new one");
  assert.equal(listPages(into.def.flow as unknown[]).find((p) => (p.node as { questionIds: string[] }).questionIds.includes(into.idMap.a1))!.node.questionIds.length, 2);
  assert.equal(into.def.questions.length, 4);
  /* the existing questions and their codes are untouched; an unknown block falls back to the end */
  assert.deepEqual(into.def.questions.slice(0, 2).map((q) => q.code), ["A1", "Z1"]);
  const fallback = importQuestions(three, source, { pageIds: ["lp1"], intoBlock: "nope" });
  assert.equal((fallback.def.flow as { type: string }[]).at(-2)!.type, "block");
  assert.doesNotThrow(() => SurveyDefinition.parse(into.def));
});

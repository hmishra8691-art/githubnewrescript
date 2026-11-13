import test from "node:test";
import assert from "node:assert/strict";
import { applyListGoal, suggestListSource, listGoalSources, sharesAnswerList } from "./index.js";

const BR = [{ code: "1", label: "Apple" }, { code: "2", label: "Samsung" }, { code: "3", label: "Google" }];
const q = (id: string, type: string, options: any[] = BR, extra: any = {}) => ({ id, code: id.toUpperCase(), variableName: id.toUpperCase(), type, text: id, options, rows: [], columns: [], listLogic: [], settings: {}, ...extra });
const mk = (qs: any[]) => ({ meta: { id: "s", code: "S", title: "t", version: "1.0" }, questions: qs, flow: [{ type: "page", id: "p", questionIds: qs.map((x) => x.id) }] }) as any;
let n = 0; const id = () => `ll_${++n}`;

test("the source offered is the nearest earlier multi-select, and only earlier questions count", () => {
  const def = mk([q("q1", "multi_select"), q("q2", "single_select"), q("q3", "open_text", []), q("q4", "multi_select"), q("q5", "multi_select")]);
  assert.equal(suggestListSource(def, "q4"), "q1");
  assert.deepEqual(listGoalSources(def, "q4").map((x) => x.id), ["q2", "q1"]);
  assert.equal(suggestListSource(def, "q1"), null);
});

test("same answer list → a list-logic rule; the sentence is the overview's own", () => {
  const def = mk([q("q1", "multi_select"), q("q2", "multi_select")]);
  const r = applyListGoal(def, def.questions[1], "only_chosen", "q1", id);
  assert.ok(r.ok);
  assert.equal(r.tool, "list-logic");
  assert.deepEqual(r.patch.listLogic, [{ id: "ll_1", sourceQuestionId: "q1", action: "include", which: "selected" }]);
  assert.match(r.summary, /Keeps only the options selected at Q1/);
  const ex = applyListGoal(def, def.questions[1], "except_chosen", "q1", id);
  assert.ok(ex.ok && ex.patch.listLogic![0]!.action === "exclude");
  const top = applyListGoal(def, def.questions[1], "chosen_first", "q1", id);
  assert.ok(top.ok && /to the top/.test(top.summary));
  const shown = applyListGoal(def, def.questions[1], "only_shown", "q1", id);
  assert.ok(shown.ok && shown.patch.listLogic![0]!.which === "displayed");
  assert.equal(def.questions[1].listLogic.length, 0, "nothing is stored by asking");
});

test("no answers of its own → carry-forward; its own different answers → carry-forward with a note", () => {
  const def = mk([q("q1", "multi_select"), q("q2", "multi_select", []), q("q3", "multi_select", [{ code: "x", label: "Other" }])]);
  const r = applyListGoal(def, def.questions[1], "except_chosen", "q1", id);
  assert.ok(r.ok);
  assert.equal(r.tool, "carry-forward");
  assert.deepEqual(r.patch.carryForward, { sourceQuestionId: "q1", filter: "not_selected", into: "options", keepOwn: false });
  assert.equal(r.note, undefined);
  const r3 = applyListGoal(def, def.questions[2], "only_chosen", "q1", id);
  assert.ok(r3.ok && /own answer is not on Q1's list/.test(r3.note!));
  const top = applyListGoal(def, def.questions[1], "chosen_first", "q1", id);
  assert.ok(!top.ok && /nothing to move to the top/.test(top.reason));
});

test("refuses a later source, a duplicate, and a second carry-forward — with the reason", () => {
  const def = mk([q("q1", "multi_select"), q("q2", "multi_select", [], { carryForward: { sourceQuestionId: "q1", filter: "selected", into: "options", keepOwn: false } }), q("q3", "multi_select", BR, { listLogic: [{ id: "a", sourceQuestionId: "q1", action: "include", which: "selected" }] }), q("q4", "multi_select")]);
  const late = applyListGoal(def, def.questions[0], "only_chosen", "q4", id);
  assert.ok(!late.ok && /not asked before/.test(late.reason));
  const dup = applyListGoal(def, def.questions[2], "only_chosen", "q1", id);
  assert.ok(!dup.ok && /already does that/.test(dup.reason));
  const cf = applyListGoal(def, def.questions[1], "only_chosen", "q1", id);
  assert.ok(!cf.ok && /already copies its list from Q1/.test(cf.reason));
  assert.equal(sharesAnswerList(def.questions[2], def.questions[0]), true);
});

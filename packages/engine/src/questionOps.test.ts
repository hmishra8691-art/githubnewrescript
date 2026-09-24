import { test } from "node:test";
import assert from "node:assert/strict";
import { SurveyDefinition, cond } from "@rescript/schema";
import {
  addQuestion, duplicateQuestion, removeQuestion, moveQuestionBy, moveQuestionTo,
  cloneQuestion, reidentifyQuestion, usedNames, listPages, buildVariableDictionary,
} from "./index.js";
import type { Question } from "@rescript/schema";

/**
 * THE QUESTION OPERATIONS, ONCE, IN THE ENGINE.
 *
 * Each of these used to be an inline closure in the Questions panel. The
 * tests pin the behaviour those closures had — where a new question lands,
 * where a copy lands, what a delete takes with it, how a move crosses a page
 * edge — so the panel can call these and nothing a programmer sees changes.
 */

const survey = () =>
  SurveyDefinition.parse({
    meta: { id: "s", code: "S", title: "T" },
    questions: [
      { id: "q1", code: "Q1", variableName: "Q1", type: "numeric", text: "One" },
      {
        id: "q2", code: "Q2", variableName: "Q2", type: "single_select", text: "Two",
        options: [{ id: "o_a", code: "A", label: "A" }, { id: "o_b", code: "B", label: "B" }],
        skipLogic: [{ id: "sk1", when: cond.rule("q2", "eq", "A"), target: { kind: "question", ref: "q4" } }],
      },
      { id: "q3", code: "Q3", variableName: "Q3", type: "text", text: "Three", displayLogic: cond.rule("q1", "gt", 1) },
      { id: "q4", code: "Q4", variableName: "Q4", type: "text", text: "Four {{Q1}}" },
    ],
    flow: [
      { type: "page", id: "p1", questionIds: ["q1", "q2"] },
      { type: "page", id: "p2", questionIds: ["q3", "q4"] },
      { type: "end", id: "e", status: "complete" },
    ],
    deployment: { clientSlug: "c", studySlug: "s" },
  });

const pageIds = (def: SurveyDefinition, pageId: string) =>
  listPages(def.flow as unknown[]).find((p) => p.node.id === pageId)!.node.questionIds;

const fresh = (id = "q9"): Question =>
  ({ id, code: "Q9", variableName: "Q9", type: "text", text: "New", options: [], rows: [], columns: [] } as never);

let n = 0;
const ids = (p: string) => `${p}_t${n++}`;

test("addQuestion places at the requested position and returns where it went", () => {
  const def = survey();
  const r = addQuestion(def, fresh(), { pageId: "p1", index: 1 });
  assert.deepEqual(r, { pageId: "p1", index: 1 });
  assert.deepEqual(pageIds(def, "p1"), ["q1", "q9", "q2"]);
  assert.ok(def.questions.some((q) => q.id === "q9"));
});

test("addQuestion with no page appends to the LAST page — a question must land somewhere visible", () => {
  const def = survey();
  const r = addQuestion(def, fresh());
  assert.equal(r.pageId, "p2");
  assert.deepEqual(pageIds(def, "p2"), ["q3", "q4", "q9"]);
  // an unknown page id gets the same treatment
  const def2 = survey();
  assert.equal(addQuestion(def2, fresh(), { pageId: "nope", index: 0 }).pageId, "p2");
});

test("addQuestion clamps an out-of-range index", () => {
  const def = survey();
  addQuestion(def, fresh(), { pageId: "p1", index: 99 });
  assert.deepEqual(pageIds(def, "p1"), ["q1", "q2", "q9"]);
});

test("duplicateQuestion puts the copy right after the original with names nothing uses", () => {
  const def = survey();
  const copy = duplicateQuestion(def, "q2", ids)!;
  assert.ok(copy);
  assert.deepEqual(pageIds(def, "p1"), ["q1", "q2", copy.id]);
  assert.equal(copy.code, "Q2_COPY");
  assert.equal(copy.variableName, "Q2_COPY");
  const again = duplicateQuestion(def, "q2", ids)!;
  assert.equal(again.code, "Q2_COPY_2", "the second copy must not collide with the first");
  assert.deepEqual(pageIds(def, "p1"), ["q1", "q2", again.id, copy.id], "each copy sits directly after its source");
});

test("a copy carries none of the original's element ids", () => {
  const def = survey();
  const copy = duplicateQuestion(def, "q2", ids)!;
  const original = def.questions.find((q) => q.id === "q2")!;
  for (const o of copy.options) assert.ok(!original.options.some((x) => x.id === o.id), `option id ${o.id} shared`);
  assert.notEqual(copy.skipLogic![0].id, original.skipLogic![0].id, "skip rule ids re-minted");
  // codes and labels ARE shared — that is what a copy is for
  assert.deepEqual(copy.options.map((o) => o.code), original.options.map((o) => o.code));
});

test("duplicateQuestion of an unknown id is a no-op returning null", () => {
  const def = survey();
  const before = JSON.stringify(def);
  assert.equal(duplicateQuestion(def, "nope", ids), null);
  assert.equal(JSON.stringify(def), before);
});

test("removeQuestion takes the page entry and every reference with it, and reports them", () => {
  const def = survey();
  const refs = removeQuestion(def, "q1");
  assert.ok(!def.questions.some((q) => q.id === "q1"));
  assert.deepEqual(pageIds(def, "p1"), ["q2"]);
  // Q3's display logic read Q1 and Q4 piped it: both must be reported and gone
  assert.ok(refs.length >= 2, `expected the display logic and the pipe, got ${JSON.stringify(refs)}`);
  const q3 = def.questions.find((q) => q.id === "q3")!;
  assert.ok(!q3.displayLogic || JSON.stringify(q3.displayLogic).indexOf("q1") < 0, "Q3 must no longer read a question that does not exist");
});

test("removeQuestion of an unknown id changes nothing and returns []", () => {
  const def = survey();
  const before = JSON.stringify(def);
  assert.deepEqual(removeQuestion(def, "nope"), []);
  assert.equal(JSON.stringify(def), before);
});

test("moveQuestionBy swaps within a page and crosses the edge into the adjacent page", () => {
  const def = survey();
  assert.equal(moveQuestionBy(def, "q2", -1), true);
  assert.deepEqual(pageIds(def, "p1"), ["q2", "q1"]);
  // q1 is now last on p1: moving down crosses into p2, at its START
  assert.equal(moveQuestionBy(def, "q1", 1), true);
  assert.deepEqual(pageIds(def, "p1"), ["q2"]);
  assert.deepEqual(pageIds(def, "p2"), ["q1", "q3", "q4"]);
  // moving up from the first item of p2 crosses into p1, at its END
  assert.equal(moveQuestionBy(def, "q1", -1), true);
  assert.deepEqual(pageIds(def, "p1"), ["q2", "q1"]);
  // nowhere to go: first question of the first page, moving up
  assert.equal(moveQuestionBy(def, "q2", -1), false);
});

test("moveQuestionTo removes from the old page and clamps the target index", () => {
  const def = survey();
  assert.equal(moveQuestionTo(def, "q1", "p2", 1), true);
  assert.deepEqual(pageIds(def, "p1"), ["q2"]);
  assert.deepEqual(pageIds(def, "p2"), ["q3", "q1", "q4"]);
  assert.equal(moveQuestionTo(def, "q1", "p1", 99), true);
  assert.deepEqual(pageIds(def, "p1"), ["q2", "q1"]);
  assert.equal(moveQuestionTo(def, "q1", "nope", 0), false);
  assert.equal(moveQuestionTo(def, "nope", "p1", 0), false);
});

test("cloneQuestion shares one taken-set across several copies", () => {
  const def = survey();
  const taken = usedNames(def);
  const a = cloneQuestion(def.questions[0], taken, ids);
  const b = cloneQuestion(def.questions[0], taken, ids);
  assert.notEqual(a.variableName, b.variableName, "two copies from one set must differ");
  assert.notEqual(a.id, b.id);
});

test("reidentifyQuestion re-mints nested column option ids too", () => {
  const copy: Record<string, unknown> = {
    columns: [{ id: "c1", options: [{ id: "co1" }, { id: "co2" }] }],
    options: [{ id: "o1" }], rows: [{ id: "r1" }], punches: [{ id: "p1" }],
  };
  reidentifyQuestion(copy, ids);
  const col = (copy.columns as { id: string; options: { id: string }[] }[])[0];
  assert.notEqual(col.id, "c1");
  assert.ok(col.options.every((o) => o.id !== "co1" && o.id !== "co2"));
  assert.notEqual((copy.punches as { id: string }[])[0].id, "p1");
});

test("after a duplicate, the variable dictionary has no duplicate names", () => {
  const def = survey();
  duplicateQuestion(def, "q2", ids);
  duplicateQuestion(def, "q2", ids);
  const names = buildVariableDictionary(def).map((v) => v.name);
  assert.equal(new Set(names).size, names.length, `duplicates: ${names.filter((x, i) => names.indexOf(x) !== i).join(", ")}`);
});

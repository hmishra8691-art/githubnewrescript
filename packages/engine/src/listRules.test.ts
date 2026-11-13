import test from "node:test";
import assert from "node:assert/strict";
import { SurveyDefinition } from "@rescript/schema";
import { listRulesOverview, LIST_RULE_TOOLS } from "./listRules.js";

const BRANDS = [{ code: 1, label: "Nike" }, { code: 2, label: "Adidas" }, { code: 3, label: "Puma" }];
const make = (extra: Record<string, unknown>) => SurveyDefinition.parse({
  meta: { id: "s", code: "S", title: "S", version: "1.0", schemaVersion: 1, status: "draft" },
  questions: [
    { id: "q1", code: "Q1", variableName: "Q1", type: "multi_select", text: "Aware", options: BRANDS },
    { id: "q2", code: "Q2", variableName: "Q2", type: "multi_select", text: "Bought", options: BRANDS },
    { id: "q3", code: "Q3", variableName: "Q3", type: "multi_select", text: "Consider", options: BRANDS, ...extra },
  ],
  flow: [{ type: "page", id: "p", questionIds: ["q1", "q2", "q3"] }, { type: "end", id: "e", status: "complete" }],
  deployment: { clientSlug: "c", studySlug: "s", languages: ["en"], access: { mode: "open" } },
});
const over = (extra: Record<string, unknown>) => { const d = make(extra); return listRulesOverview(d, d.questions[2]); };
const ref = (questionId: string, selection = "selected") => ({ kind: "ref", questionId, selection });

test("a question with nothing configured is plain", () => {
  const o = over({});
  assert.equal(o.plain, true); assert.deepEqual(o.steps, []); assert.deepEqual(o.notes, []);
});

test("the four tools are reported in the order the engine applies them, in plain words", () => {
  const o = over({
    optionPipeline: [{ id: "o1", kind: "sort", order: "az" }],
    mask: { expr: ref("q2"), action: "remove" },
    listLogic: [{ id: "r1", sourceQuestionId: "q1", action: "include", which: "selected" }],
    carryForward: { sourceQuestionId: "q1", filter: "selected", into: "options", keepOwn: true },
  });
  assert.deepEqual(o.steps.map((s) => s.section), ["carry-forward", "list-logic", "masking", "list-operations"]);
  assert.match(o.steps[0].summary, /Starts from the options selected at Q1, followed by this question's own options/);
  assert.match(o.steps[1].summary, /Keeps only the options selected at Q1/);
  assert.match(o.steps[2].summary, /^Removes /);
  assert.equal(o.plain, false);
});

test("every mask action is described for what it does to the list", () => {
  for (const [action, re] of [["display", /^Shows only /], ["remove", /^Removes /], ["preselect", /^Pre-selects .*not filtered/], ["display_and_preselect", /already selected/], ["disable", /only .* can be answered/]] as const) {
    assert.match(over({ mask: { expr: ref("q1"), action } }).steps[0].summary, re, action);
  }
});

test("keep-only and remove on the same answers is a contradiction; top and bottom too", () => {
  const o = over({ listLogic: [
    { id: "a", sourceQuestionId: "q1", action: "include", which: "selected" },
    { id: "b", sourceQuestionId: "q1", action: "exclude", which: "selected" },
    { id: "c", sourceQuestionId: "q2", action: "prioritize", which: "selected" },
    { id: "d", sourceQuestionId: "q2", action: "deprioritize", which: "selected" },
  ] });
  const conflicts = o.notes.filter((n) => n.level === "conflict");
  assert.equal(conflicts.length, 2);
  assert.match(conflicts[0].message, /nothing would be left/);
  /* keep-only selected + remove NOT selected is a legitimate pair */
  const fine = over({ listLogic: [{ id: "a", sourceQuestionId: "q1", action: "include", which: "selected" }, { id: "b", sourceQuestionId: "q2", action: "exclude", which: "selected" }] });
  assert.equal(fine.notes.filter((n) => n.level === "conflict").length, 0);
});

test("a calculated set and set-style list steps are named as doing the same job; a pre-select mask is not", () => {
  const step = { id: "o1", kind: "difference", sources: [{ questionId: "q2", which: "selected" }] };
  const o = over({ mask: { expr: ref("q1"), action: "display" }, optionPipeline: [step] });
  assert.ok(o.notes.some((n) => n.level === "overlap" && n.sections.includes("masking") && n.sections.includes("list-operations")));
  const pre = over({ mask: { expr: ref("q1"), action: "preselect" }, optionPipeline: [step] });
  assert.equal(pre.notes.filter((n) => n.level === "overlap").length, 0);
  const sortOnly = over({ mask: { expr: ref("q1"), action: "display" }, optionPipeline: [{ id: "o", kind: "sort", order: "az" }] });
  assert.equal(sortOnly.notes.filter((n) => n.level === "overlap").length, 0);
});

test("the same question used by a rule and inside the set; copying twice; shuffling twice", () => {
  const a = over({ listLogic: [{ id: "a", sourceQuestionId: "q1", action: "include", which: "selected" }], mask: { expr: ref("q1"), action: "display" } });
  assert.ok(a.notes.some((n) => n.level === "overlap" && /Q1 is used twice/.test(n.message)));
  const b = over({ listLogic: [{ id: "a", sourceQuestionId: "q1", action: "include", which: "selected" }], mask: { expr: ref("q2"), action: "display" } });
  assert.ok(b.notes.some((n) => n.level === "info" && /Both apply/.test(n.message)));
  const c = over({ carryForward: { sourceQuestionId: "q1", filter: "selected", into: "options" }, optionPipeline: [{ id: "o", kind: "carry_forward", sources: [{ questionId: "q2", which: "selected" }] }] });
  assert.ok(c.notes.some((n) => /copied from another question twice/.test(n.message)));
  const d = over({ randomization: { enabled: true, method: "shuffle" }, optionPipeline: [{ id: "o", kind: "randomize", method: "shuffle" }] });
  assert.ok(d.notes.some((n) => /shuffled twice/.test(n.message)));
});

test("the tools have a researcher's name, a technical name and a place in the order", () => {
  assert.deepEqual(Object.values(LIST_RULE_TOOLS).map((t) => t.order), [1, 2, 3, 4]);
  for (const t of Object.values(LIST_RULE_TOOLS)) { assert.ok(t.title && t.technical && t.use); assert.doesNotMatch(t.title, /intersection|union|dynamic option sets/i); }
});

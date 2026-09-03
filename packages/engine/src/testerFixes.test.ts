import { test } from "node:test";
import assert from "node:assert/strict";
import { SurveyDefinition } from "@rescript/schema";
import { createResponseState, compileFlow, validateQuestion, lintQuestionLogic } from "./index.js";

/*
 * Three engine-level fixes from the tester's sheet (2026-09-03):
 *   - block names can be hidden from respondents (per block, or survey-wide)
 *   - "Other (specify)" cannot be left blank
 *   - counts cannot be negative, and are reported if they are
 */

const opts = [
  { code: 1, label: "Yes" },
  { code: 2, label: "No" },
  { code: 99, label: "Other (please specify)", flags: ["other_specify"] },
];

function survey(flow: unknown[], extra: Record<string, unknown> = {}) {
  return SurveyDefinition.parse({
    meta: { id: "s1", code: "S1", title: "Test", version: "1.0" },
    questions: ["q1", "q2"].map((id, i) => ({
      id, code: `Q${i + 1}`, variableName: `Q${i + 1}`,
      type: i === 0 ? "single_select" : "multi_select", text: id, options: opts,
    })),
    flow,
    ...extra,
  });
}

const pages = (def: any) => {
  const state = createResponseState(def, { seed: 1 });
  return compileFlow(def, state).filter((s) => s.kind === "page") as any[];
};

// ------------------------------------------------------------ block names

test("block names show by default — existing surveys look the same", () => {
  const def = survey([{ type: "page", id: "p1", title: "Screener", questionIds: ["q1"] }]);
  const [p] = pages(def);
  assert.equal(p.title, "Screener");
  assert.equal(p.showTitle, true);
});

test("a block can hide its own name from respondents", () => {
  const def = survey([{ type: "page", id: "p1", title: "Screener", showTitle: false, questionIds: ["q1"] }]);
  const [p] = pages(def);
  assert.equal(p.title, "Screener", "the name is still there for the programmer");
  assert.equal(p.showTitle, false, "but the runtime is told not to show it");
});

test("the survey-wide default hides every block name at once", () => {
  const def = survey(
    [
      { type: "page", id: "p1", title: "A", questionIds: ["q1"] },
      { type: "page", id: "p2", title: "B", questionIds: ["q2"] },
    ],
    { branding: { layout: { showBlockTitles: false } } },
  );
  assert.deepEqual(pages(def).map((p) => p.showTitle), [false, false]);
});

test("a block overrides the survey default in either direction", () => {
  const def = survey(
    [
      { type: "page", id: "p1", title: "A", questionIds: ["q1"] },
      { type: "page", id: "p2", title: "B", showTitle: true, questionIds: ["q2"] },
    ],
    { branding: { layout: { showBlockTitles: false } } },
  );
  assert.deepEqual(pages(def).map((p) => p.showTitle), [false, true]);
});

test("a multi-page block's setting reaches every page in it", () => {
  const def = survey([{
    type: "block", id: "b1", title: "Habits", showTitle: false,
    children: [
      { type: "page", id: "p1", questionIds: ["q1"] },
      { type: "page", id: "p2", questionIds: ["q2"] },
    ],
  }]);
  const ps = pages(def);
  assert.deepEqual(ps.map((p) => p.title), ["Habits", "Habits"], "pages inherit the block name");
  assert.deepEqual(ps.map((p) => p.showTitle), [false, false], "and inherit hiding it");
});

// ------------------------------------------------------------ other specify

function ctxWith(def: any, answers: Record<string, unknown>) {
  const state = createResponseState(def, { seed: 1 });
  Object.assign(state.answers, answers);
  return { def, state };
}

test("single select: Other without text is refused", () => {
  const def = survey([{ type: "page", id: "p1", questionIds: ["q1"] }]);
  const q = def.questions[0];
  const errs = validateQuestion(def, q, 99, ctxWith(def, { q1: 99 }) as any);
  assert.equal(errs.length, 1);
  assert.match(errs[0].message, /Other/);
});

test("single select: Other with text passes; a non-Other answer never asks", () => {
  const def = survey([{ type: "page", id: "p1", questionIds: ["q1"] }]);
  const q = def.questions[0];
  assert.deepEqual(validateQuestion(def, q, 99, ctxWith(def, { q1: 99, q1__other: "a llama" }) as any), []);
  assert.deepEqual(validateQuestion(def, q, 1, ctxWith(def, { q1: 1 }) as any), []);
});

test("whitespace is not a specification", () => {
  const def = survey([{ type: "page", id: "p1", questionIds: ["q1"] }]);
  const q = def.questions[0];
  assert.equal(validateQuestion(def, q, 99, ctxWith(def, { q1: 99, q1__other: "   " }) as any).length, 1);
});

test("multi select: Other among several selections still needs its text", () => {
  const def = survey([{ type: "page", id: "p1", questionIds: ["q2"] }]);
  const q = def.questions[1];
  assert.equal(validateQuestion(def, q, [1, 99], ctxWith(def, { q2: [1, 99] }) as any).length, 1);
  assert.deepEqual(validateQuestion(def, q, [1, 99], ctxWith(def, { q2: [1, 99], q2__other: "x" }) as any), []);
  assert.deepEqual(validateQuestion(def, q, [1, 2], ctxWith(def, { q2: [1, 2] }) as any), []);
});

test("codes are compared as text, so a string '99' from a dropdown still matches", () => {
  const def = survey([{ type: "page", id: "p1", questionIds: ["q1"] }]);
  const q = def.questions[0];
  assert.equal(validateQuestion(def, q, "99", ctxWith(def, { q1: "99" }) as any).length, 1);
});

test("the programmer can make the text optional per question", () => {
  const def = survey([{ type: "page", id: "p1", questionIds: ["q1"] }]);
  const q = { ...def.questions[0], settings: { ...def.questions[0].settings, otherSpecifyOptional: true } };
  assert.deepEqual(validateQuestion(def, q as any, 99, ctxWith(def, { q1: 99 }) as any), []);
});

test("an unanswered question is not nagged about Other", () => {
  const def = survey([{ type: "page", id: "p1", questionIds: ["q1"] }]);
  const q = def.questions[0];
  assert.deepEqual(validateQuestion(def, q, undefined, ctxWith(def, {}) as any), []);
});

// ------------------------------------------------------------ counts

test("negative and fractional counts are reported by the lint", () => {
  const def = survey([{ type: "page", id: "p1", questionIds: ["q2"] }]);
  const q = { ...def.questions[1], settings: { ...def.questions[1].settings, minSelections: -5, maxSelections: 2.5 } };
  const issues = lintQuestionLogic(def, q as any).filter((i) => i.path.startsWith("settings."));
  assert.equal(issues.length, 2);
  assert.match(issues[0].message, /-5/);
  assert.match(issues[1].message, /2\.5/);
});

test("min above max is reported", () => {
  const def = survey([{ type: "page", id: "p1", questionIds: ["q2"] }]);
  const q = { ...def.questions[1], settings: { ...def.questions[1].settings, minSelections: 3, maxSelections: 2 } };
  const issues = lintQuestionLogic(def, q as any);
  assert.ok(issues.some((i) => /above maxSelections/.test(i.message)));
});

test("sane counts produce no count issues", () => {
  const def = survey([{ type: "page", id: "p1", questionIds: ["q2"] }]);
  const q = { ...def.questions[1], settings: { ...def.questions[1].settings, minSelections: 1, maxSelections: 3 } };
  assert.deepEqual(lintQuestionLogic(def, q as any).filter((i) => i.path.startsWith("settings.")), []);
});

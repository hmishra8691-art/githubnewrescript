/**
 * 2026-11-13 — carry-forward as answer-option management (exclude / always / wording / own options), its use as a
 * loop source, and the constant-sum matrix's calculation method (rows / columns / both).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { SurveyDefinition } from "@rescript/schema";
import { createResponseState } from "./state.js";
import { start, advance, setAnswer, visibleQuestions } from "./flow.js";
import { effectiveQuestion, authoringQuestionView } from "./carryforward.js";
import { validatePage } from "./validate.js";

const opt = (code: number, label: string, flags: string[] = []) => ({ code, label, flags });
const BRANDS = [opt(1, "Nike"), opt(2, "Adidas"), opt(3, "Puma"), opt(4, "Reebok"), opt(97, "Other", ["other_specify"])];
const base = (cf: Record<string, unknown>, own: unknown[] = [], more: unknown[] = [], flowMore: unknown[] = []) => SurveyDefinition.parse({
  meta: { id: "s", code: "S", title: "CF", version: "1.0" },
  questions: [
    { id: "Q1", code: "Q1", variableName: "Q1", type: "multi_select", text: "Which have you bought?", required: true, options: BRANDS },
    { id: "Q2", code: "Q2", variableName: "Q2", type: "multi_select", text: "Why?", required: true, options: own, carryForward: { sourceQuestionId: "Q1", filter: "selected", into: "options", ...cf } },
    ...more,
  ],
  flow: [{ id: "p1", type: "page", questionIds: ["Q1"] }, { id: "p2", type: "page", questionIds: ["Q2"] }, ...flowMore],
});
function shown(def: SurveyDefinition, picks: number[], qid = "Q2") {
  const state = createResponseState(def, { seed: 1 });
  start(def, state, {});
  setAnswer(def, state, "Q1", picks as never);
  advance(def, state, {});
  const q = def.questions.find((x) => x.id === qid)!;
  return { state, list: effectiveQuestion(q, { def, state }).options.map((o) => `${o.code}:${o.label.replace(/<[^>]*>/g, "")}`) };
}

test("unchanged: the selected options, the source's labels (as before)", () => {
  assert.deepEqual(shown(base({}), [1, 2]).list, ["1:Nike", "2:Adidas"]);
});

test("wording here is separate from the source: per-option text and a template; the stored code is the source's", () => {
  const def = base({ labels: { "1": "Nike products" }, labelTemplate: "{{label}} items" });
  const r = shown(def, [1, 2]);
  assert.deepEqual(r.list, ["1:Nike products", "2:Adidas items"]);
  assert.equal(def.questions[0].options[0].label, "Nike", "the source question is untouched");
  setAnswer(def, r.state, "Q2", [1] as never);
  assert.deepEqual(r.state.answers.Q2, [1], "the answer is the source code — exports and logic read the same value");
  assert.deepEqual(r.state.answers.Q1, [1, 2]);
});

test("always / exclude / own options together, in a fixed order; exclude wins; no code twice", () => {
  const own = [opt(98, "None of these", ["exclusive"]), opt(99, "Not sure"), opt(2, "Duplicate of Adidas")];
  const def = base({ always: [97, 3], exclude: [2, 3], keepOwn: true }, own);
  /* selected 1,2 → +always 97 (3 is excluded: exclude wins) → −2 → own 98, 99 (own code 2 is dropped only when carried uses it) */
  assert.deepEqual(shown(def, [1, 2]).list, ["1:Nike", "97:Other", "98:None of these", "99:Not sure", "2:Duplicate of Adidas"]);
  const def2 = base({ always: [97], keepOwn: true }, own);
  assert.deepEqual(shown(def2, [2, 4]).list, ["2:Adidas", "4:Reebok", "97:Other", "98:None of these", "99:Not sure"], "always lands in the source's order; an own option with a carried code is not listed twice");
  /* nothing chosen that survives: the always option and the own options still give the respondent an answer */
  assert.deepEqual(shown(base({ always: [97], exclude: [1], keepOwn: true }, [opt(98, "None of these")]), [1]).list, ["97:Other", "98:None of these"]);
});

test("a carried Other keeps being an Other — specify; the builder's view lists what can arrive, with this question's wording", () => {
  const def = base({ exclude: [4], labels: { "2": "Adidas products" }, keepOwn: true }, [opt(98, "None of these")]);
  const live = shown(def, [1, 97]);
  const q2 = def.questions[1];
  const other = effectiveQuestion(q2, { def, state: live.state }).options.find((o) => o.code === 97)!;
  assert.ok((other.flags ?? []).includes("other_specify"));
  const view = authoringQuestionView(q2, def);
  assert.deepEqual(view.options.map((o) => `${o.code}:${o.label}`), ["1:Nike", "2:Adidas products", "3:Puma", "97:Other", "98:None of these"]);
  assert.ok(view.options.slice(0, 4).every((o) => o.sourceQuestionId === "Q1"), "inherited options carry their source");
  assert.equal(view.options[4].sourceQuestionId, undefined, "an option added here does not");
});

test("several questions from one source, each with its own rules; an edit to the source arrives everywhere", () => {
  const def = base({ labels: { "1": "Nike products" } }, [], [
    { id: "Q3", code: "Q3", variableName: "Q3", type: "single_select", text: "Favourite?", required: true, options: [], carryForward: { sourceQuestionId: "Q1", filter: "selected", into: "options", exclude: [97] } },
  ], [{ id: "p3", type: "page", questionIds: ["Q3"] }]);
  assert.deepEqual(shown(def, [1, 97]).list, ["1:Nike products", "97:Other"]);
  assert.deepEqual(shown(def, [1, 97], "Q3").list, ["1:Nike"]);
  def.questions[0].options[1].label = "Adidas Originals";
  def.questions[0].options.splice(3, 1);
  assert.deepEqual(shown(def, [1, 2], "Q3").list, ["1:Nike", "2:Adidas Originals"], "a renamed source option is renamed here; a deleted one is simply gone");
});

test("a loop over the carried question runs once per carried option, with its wording", () => {
  const def = SurveyDefinition.parse({
    meta: { id: "s", code: "S", title: "CF loop", version: "1.0" },
    questions: [
      { id: "A4", code: "A4", variableName: "A4", type: "multi_select", text: "Brands?", required: true, options: [opt(1, "Brand A"), opt(2, "Brand B"), opt(3, "Brand C"), opt(4, "Brand D")] },
      { id: "A5", code: "A5", variableName: "A5", type: "multi_select", text: "Which again?", required: true, options: [], carryForward: { sourceQuestionId: "A4", filter: "selected", into: "options" } },
      { id: "L1", code: "L1", variableName: "L1", type: "open_text", text: "Tell us about {{loop.label}}", required: false, options: [] },
    ],
    flow: [
      { id: "p1", type: "page", questionIds: ["A4"] }, { id: "p2", type: "page", questionIds: ["A5"] },
      { id: "lp", type: "loop", loopVar: "brand", source: { kind: "question", questionId: "A5", filter: "displayed" }, children: [{ id: "pl", type: "page", questionIds: ["L1"] }] },
    ],
  });
  const state = createResponseState(def, { seed: 1 });
  start(def, state, {});
  setAnswer(def, state, "A4", [1, 3, 4] as never);
  let r = advance(def, state, {});
  setAnswer(def, state, "A5", [1] as never);
  const seen: string[] = [];
  for (let i = 0; i < 6; i++) {
    r = advance(def, state, {});
    if (r.done) break;
    const s = r.steps[r.stepIndex];
    if (s.kind === "page" && s.pageId.startsWith("pl")) seen.push(String((s.loop as { label?: string; code?: unknown } | null)?.label ?? (s.loop as { code?: unknown } | null)?.code));
    void visibleQuestions;
  }
  assert.deepEqual(seen, ["Brand A", "Brand C", "Brand D"]);
});

/* ---------------------------------------------------------------- constant-sum matrix */

const grid = (settings: Record<string, unknown>, required = true) => SurveyDefinition.parse({
  meta: { id: "s", code: "S", title: "Sum", version: "1.0" },
  questions: [{
    id: "G", code: "G", variableName: "G", type: "composite", variant: "matrix.constant_sum", text: "Split", required,
    rows: [{ code: "r1", label: "North" }, { code: "r2", label: "South" }],
    columns: [{ id: "c1", label: "Online", responseType: "numeric", variableStem: "G_C1" }, { id: "c2", label: "Store", responseType: "numeric", variableStem: "G_C2" }],
    settings: { rowSum: true, sumTarget: 100, ...settings },
  }],
  flow: [{ id: "p1", type: "page", questionIds: ["G"] }],
});
function errorsFor(def: SurveyDefinition, value: unknown) {
  const state = createResponseState(def, { seed: 1 });
  start(def, state, {});
  setAnswer(def, state, "G", value as never);
  return validatePage(def, def.questions, { def, state }).map((e) => e.message);
}

test("constant-sum matrix: rows by default (unchanged), columns, or both — each row / column named", () => {
  const rowsOk = { r1: { c1: 60, c2: 40 }, r2: { c1: 10, c2: 90 } };       // rows 100/100, columns 70/130
  const colsOk = { r1: { c1: 70, c2: 20 }, r2: { c1: 30, c2: 80 } };       // rows 90/110, columns 100/100
  const bothOk = { r1: { c1: 60, c2: 40 }, r2: { c1: 40, c2: 60 } };
  assert.deepEqual(errorsFor(grid({}), rowsOk), []);
  assert.deepEqual(errorsFor(grid({}), colsOk), ["Row “North” must total 100.", "Row “South” must total 100."]);
  assert.deepEqual(errorsFor(grid({ sumAxis: "column" }), colsOk), []);
  assert.deepEqual(errorsFor(grid({ sumAxis: "column" }), rowsOk), ["Column “Online” must total 100 (currently 70).", "Column “Store” must total 100 (currently 130)."]);
  assert.deepEqual(errorsFor(grid({ sumAxis: "both" }), bothOk), []);
  assert.equal(errorsFor(grid({ sumAxis: "both" }), rowsOk).length, 2, "rows fine, both columns named");
  assert.equal(errorsFor(grid({ sumAxis: "both" }), colsOk).length, 2, "columns fine, both rows named");
  assert.deepEqual(errorsFor(grid({ sumAxis: "column", columnSumTarget: 50 }), { r1: { c1: 20, c2: 25 }, r2: { c1: 30, c2: 25 } }), [], "columns may have their own target");
  assert.deepEqual(errorsFor(grid({ sumAxis: "column" }, false), undefined), [], "an optional grid nobody touched is not a failed total");
});

test("set_carry_forward as an action: options named by label or code, checked, and applied; a later source is refused", async () => {
  const { applySurveyActions, coerceSurveyActions } = await import("./surveyActions.js");
  const def = base({}, [opt(98, "None of these")]);
  delete (def.questions[1] as { carryForward?: unknown }).carryForward;
  const c = coerceSurveyActions([{ op: "set_carry_forward", target: "Q2", source: "Q1", always: ["Other"], exclude: ["Puma"], labels: { Nike: "Nike products", "2": "Adidas products" }, labelTemplate: "{{label}} items" }]);
  assert.deepEqual(c.rejected, []);
  const out = applySurveyActions(def, c.actions);
  assert.deepEqual(out.errors, []);
  const cf = out.def.questions[1].carryForward!;
  assert.deepEqual([cf.sourceQuestionId, cf.filter, cf.into, cf.keepOwn, cf.always, cf.exclude, cf.labels], ["Q1", "selected", "options", true, [97], [3], { "1": "Nike products", "2": "Adidas products" }]);
  assert.deepEqual(shown(out.def, [1, 3, 4]).list, ["1:Nike products", "4:Reebok items", "97:Other items", "98:None of these"]);
  for (const bad of [{ target: "Q2", source: "Q1", always: ["Nope"] }, { target: "Q1", source: "Q2" }, { target: "Q2", source: "Q1", always: ["Nike"], exclude: ["Nike"] }, { target: "Q2", source: "Q2" }]) {
    assert.equal(applySurveyActions(def, coerceSurveyActions([{ op: "set_carry_forward", ...bad }]).actions).errors.length, 1, JSON.stringify(bad));
  }
  const removed = applySurveyActions(out.def, coerceSurveyActions([{ op: "set_carry_forward", target: "Q2", remove: true }]).actions);
  assert.equal(removed.def.questions[1].carryForward, undefined);
});

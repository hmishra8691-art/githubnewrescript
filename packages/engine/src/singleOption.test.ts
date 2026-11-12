/**
 * THE ONLY ANSWER THERE IS (singleOption.ts): a required multiple-choice or ranking question that shows this
 * respondent exactly one ordinary answer is answered by the engine, recorded as engine-answered, and not shown.
 * Every case here runs the real flow (start / advance / goBack), because the rule is about what a respondent is
 * asked, not about a helper's return value.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { SurveyDefinition } from "@rescript/schema";
import { createResponseState, type ResponseState } from "./state.js";
import { start, advance, goBack, recomputePunchesAfterChange, setAnswer, visibleQuestions, type NavigationResult } from "./flow.js";
import { autoAnswered } from "./singleOption.js";
import { validatePage } from "./validate.js";

const sel = (ref: string, value: number) => ({ type: "rule", source: { kind: "question", ref }, operator: "selected", value });
const opt = (code: number, label: string, extra: Record<string, unknown> = {}) => ({ code, label, flags: [], ...extra });
const q = (id: string, type: string, options: unknown[], extra: Record<string, unknown> = {}) => ({
  id, code: id, variableName: id, type, text: id, options, rows: [], columns: [], validation: [], required: true,
  settings: { readOnly: false, hidden: false }, skipLogic: [], listLogic: [], ...extra,
});
const BRANDS = [opt(1, "Alpha"), opt(2, "Beta"), opt(3, "Gamma")];
/* Q2 (multi) and Q3 (ranking) each show a brand only when it was chosen at Q1 */
const narrowed = (extra: unknown[] = []) => [...BRANDS.map((o) => ({ ...o, visibleIf: sel("Q1", o.code) })), ...extra];
function survey(questions: unknown[], pages: string[][], more: Record<string, unknown> = {}): SurveyDefinition {
  return SurveyDefinition.parse({ meta: { id: "s", code: "S", title: "Single option", version: "1.0" }, questions, flow: pages.map((ids, i) => ({ id: `p${i + 1}`, type: "page", questionIds: ids })), ...more });
}
const pageOf = (r: NavigationResult) => { const s = r.steps[r.stepIndex]; return r.done ? "END" : s.kind === "page" ? s.pageId : s.kind; };
const shownOn = (def: SurveyDefinition, r: NavigationResult, state: ResponseState) => { const s = r.steps[r.stepIndex]; return s.kind === "page" ? visibleQuestions(def, s, state).map((x) => x.id) : []; };
function begin(def: SurveyDefinition, first: unknown) {
  const state = createResponseState(def, { seed: 1 });
  let r = start(def, state, {});
  setAnswer(def, state, "Q1", first as never);
  r = advance(def, state, {});
  return { state, r };
}

const base = () => survey([q("Q1", "multi_select", BRANDS), q("Q2", "multi_select", narrowed()), q("Q3", "ranking", narrowed()), q("Q4", "open_text", [], { required: false })], [["Q1"], ["Q2"], ["Q3"], ["Q4"]]);

test("one ordinary answer left: a multi-select is ticked, a ranking is ranked first, both pages are passed over and marked", () => {
  const def = base();
  const { state, r } = begin(def, [2]);
  assert.equal(pageOf(r), "p4", "Q2 and Q3 — two pages in a row — are not shown");
  assert.deepEqual(state.answers.Q2, [2]);
  assert.deepEqual(state.answers.Q3, [2], "rank 1 = the first (only) item of the order");
  assert.deepEqual(autoAnswered(state).sort(), ["Q2", "Q3"], "…and the dataset can tell the engine gave them");
  /* Back goes to the page the respondent actually saw */
  const b = goBack(def, state, {});
  assert.equal(pageOf(b), "p1");
});

test("several answers left: asked as usual, nothing written", () => {
  const def = base();
  const { state, r } = begin(def, [1, 3]);
  assert.equal(pageOf(r), "p2");
  assert.deepEqual(shownOn(def, r, state), ["Q2"]);
  assert.equal(state.answers.Q2, undefined);
  assert.deepEqual(autoAnswered(state), []);
});

test("one brand + None of these / + Other: there is a choice to make, so the question is asked", () => {
  for (const extra of [opt(99, "None of these", { flags: ["exclusive"] }), opt(98, "Other", { flags: ["other_specify"] })]) {
    const def = survey([q("Q1", "multi_select", BRANDS), q("Q2", "multi_select", narrowed([extra])), q("Q4", "open_text", [], { required: false })], [["Q1"], ["Q2"], ["Q4"]]);
    const { state, r } = begin(def, [2]);
    assert.equal(pageOf(r), "p2", String((extra as { label: string }).label));
    assert.equal(state.answers.Q2, undefined);
  }
  /* …and when the ONLY answer left is itself the special one, taking it is still the respondent's decision */
  const def = survey([q("Q1", "multi_select", BRANDS), q("Q2", "multi_select", [{ ...opt(1, "Alpha"), visibleIf: sel("Q1", 1) }, opt(99, "None of these", { flags: ["exclusive"] })]), q("Q4", "open_text", [], { required: false })], [["Q1"], ["Q2"], ["Q4"]]);
  const { state, r } = begin(def, [2]);
  assert.equal(pageOf(r), "p2");
  assert.equal(state.answers.Q2, undefined);
});

test("not the engine's to answer: optional, already coded by punches, a minimum of two, a single-select", () => {
  const cases: [string, Record<string, unknown>, string][] = [
    ["optional — not answering is a valid response", { required: false }, "multi_select"],
    ["min selections 2 — one answer would not be valid", { validation: [{ kind: "min_selections", value: 2, message: "two" }] }, "multi_select"],
  ];
  for (const [name, extra, type] of cases) {
    const def = survey([q("Q1", "multi_select", BRANDS), q("Q2", type, narrowed(), extra), q("Q4", "open_text", [], { required: false })], [["Q1"], ["Q2"], ["Q4"]]);
    const { state, r } = begin(def, [2]);
    assert.equal(pageOf(r), "p2", name);
    assert.equal(state.answers.Q2, undefined, name);
  }
});

test("the engine's answer drives what comes next: display logic, skip logic and a quota read it like any answer", () => {
  const def = survey([
    q("Q1", "multi_select", BRANDS),
    q("Q2", "multi_select", narrowed(), { skipLogic: [{ id: "sk", when: sel("Q2", 3), target: { kind: "question", ref: "Q6" } }] }),
    q("Q5", "open_text", [], { required: false, displayLogic: sel("Q2", 2) }),
    q("Q6", "open_text", [], { required: false }),
  ], [["Q1"], ["Q2"], ["Q5"], ["Q6"]], { quotas: [{ id: "QB", name: "Beta", mode: "hard", cells: [{ id: "c1", label: "Beta", when: sel("Q2", 2), limit: 1, limitType: "count" }], onFull: { kind: "terminate" }, countStatus: ["complete"] }] });
  /* Beta only → Q2 = [2] → Q5 (shown if Q2 = Beta) is the next page */
  const beta = begin(def, [2]);
  assert.equal(pageOf(beta.r), "p3");
  /* Gamma only → Q2 = [3] → its skip rule fires though nobody saw the page: straight to Q6 */
  const gamma = begin(def, [3]);
  assert.equal(pageOf(gamma.r), "p4");
  assert.deepEqual(gamma.state.answers.Q2, [3]);
});

test("on the same page: the question disappears as its list narrows, and is answered when the page is left", () => {
  const def = survey([q("Q1", "multi_select", BRANDS), q("Q2", "multi_select", narrowed()), q("Q4", "open_text", [], { required: false })], [["Q1", "Q2"], ["Q4"]]);
  const state = createResponseState(def, { seed: 1 });
  let r = start(def, state, {});
  setAnswer(def, state, "Q1", [1, 2] as never);
  assert.deepEqual(shownOn(def, r, state), ["Q1", "Q2"]);
  setAnswer(def, state, "Q1", [2] as never);
  assert.deepEqual(shownOn(def, r, state), ["Q1"], "one left: not asked");
  const step = r.steps[r.stepIndex];
  assert.deepEqual(step.kind === "page" ? validatePage(def, visibleQuestions(def, step, state), { def, state, loop: null }) : [], [], "…and not demanded by validation");
  r = advance(def, state, {});
  assert.equal(pageOf(r), "p2");
  assert.deepEqual(state.answers.Q2, [2]);
});

test("the list grows again: the engine's answer is withdrawn and the question is asked; the respondent's own answer is never touched", () => {
  const def = base();
  const { state } = begin(def, [2]);
  assert.deepEqual(state.answers.Q2, [2]);
  goBack(def, state, {});
  setAnswer(def, state, "Q1", [1, 2] as never);
  const r = advance(def, state, {});
  assert.equal(pageOf(r), "p2");
  assert.equal(state.answers.Q2, undefined, "what the engine wrote is not carried into a real choice");
  assert.ok(!autoAnswered(state).includes("Q2"));
  /* the respondent answers [1]; narrowing to Beta alone afterwards replaces it with the only valid answer */
  setAnswer(def, state, "Q2", [1] as never);
  goBack(def, state, {});
  setAnswer(def, state, "Q1", [1] as never);
  const again = advance(def, state, {});
  assert.deepEqual(state.answers.Q2, [1]);
  assert.notEqual(pageOf(again), "p2");
});

test("a question WRITTEN with one answer (a consent box) is never answered for the respondent; a skip rule that points back cannot loop", () => {
  const consent = survey([q("Q1", "multi_select", [opt(1, "I agree to take part")]), q("Q4", "open_text", [], { required: false })], [["Q1"], ["Q4"]]);
  const cs = createResponseState(consent, { seed: 1 });
  const cr = start(consent, cs, {});
  assert.equal(pageOf(cr), "p1", "the consent page is shown");
  assert.equal(cs.answers.Q1, undefined);
  /* Q2 narrows to one answer and carries a skip rule pointing BACK at Q1: it is answered, left, and the walk goes on forward */
  const def = survey([q("Q1", "multi_select", BRANDS), q("Q2", "ranking", narrowed(), { skipLogic: [{ id: "back", when: sel("Q2", 2), target: { kind: "question", ref: "Q1" } }] }), q("Q4", "open_text", [], { required: false })], [["Q1"], ["Q2"], ["Q4"]]);
  const { state, r } = begin(def, [2]);
  assert.deepEqual(state.answers.Q2, [2]);
  assert.equal(pageOf(r), "p3");
});

test("a single-select (radio, dropdown) with one ordinary answer left is answered too — the code itself, not a list", () => {
  for (const type of ["single_select", "dropdown"]) {
    const def = survey([q("Q1", "multi_select", BRANDS), q("Q2", type, narrowed()), q("Q4", "open_text", [], { required: false })], [["Q1"], ["Q2"], ["Q4"]]);
    const { state, r } = begin(def, [3]);
    assert.equal(pageOf(r), "p3", type);
    assert.equal(state.answers.Q2, 3, type);
    assert.deepEqual(autoAnswered(state), ["Q2"]);
    const two = begin(def, [1, 3]);
    assert.equal(pageOf(two.r), "p2", `${type}: two answers left is a choice`);
  }
  /* one brand + "None of these" stays a question */
  const def = survey([q("Q1", "multi_select", BRANDS), q("Q2", "single_select", narrowed([opt(99, "None of these", { flags: ["exclusive"] })])), q("Q4", "open_text", [], { required: false })], [["Q1"], ["Q2"], ["Q4"]]);
  assert.equal(pageOf(begin(def, [2]).r), "p2");
});

test("a chain on one page: each engine answer reveals the next question — answered if it too has one answer, asked if it has a choice", () => {
  /* Q2 and Q3 appear only once the question before is answered; Q3 offers what was chosen at Q1 plus, for Gamma, a second answer */
  const ans = (ref: string) => ({ type: "rule", source: { kind: "question", ref }, operator: "answered" });
  const def = survey([
    q("Q1", "multi_select", BRANDS),
    q("Q2", "multi_select", narrowed(), { displayLogic: ans("Q1") }),
    q("Q3", "single_select", [...narrowed(), { ...opt(4, "Delta"), visibleIf: sel("Q1", 3) }], { displayLogic: ans("Q2") }),
    q("Q4", "open_text", [], { required: false }),
  ], [["Q1", "Q2", "Q3"], ["Q4"]]);
  const go = (first: number[]) => {
    const state = createResponseState(def, { seed: 1 });
    const r = start(def, state, {});
    const step = r.steps[r.stepIndex];
    setAnswer(def, state, "Q1", first);
    /* what the Runner calls after every answer */
    recomputePunchesAfterChange(def, state, "Q1", step.kind === "page" ? visibleQuestions(def, step, state) : [], { def, state, loop: null });
    return { state, shown: shownOn(def, r, state) };
  };
  const beta = go([2]);
  assert.deepEqual([beta.state.answers.Q2, beta.state.answers.Q3], [[2], 2], "both follow from the one brand, at once");
  assert.deepEqual(beta.shown, ["Q1"]);
  const gamma = go([3]);
  assert.deepEqual(gamma.state.answers.Q2, [3]);
  assert.equal(gamma.state.answers.Q3, undefined, "Gamma or Delta: a choice");
  assert.deepEqual(gamma.shown, ["Q1", "Q3"], "…so Q3 is on the page for the respondent, not skipped");
});

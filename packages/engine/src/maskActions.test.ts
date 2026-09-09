import { test } from "node:test";
import assert from "node:assert/strict";
import { SurveyDefinition, OPERATORS_BY_KIND } from "@rescript/schema";
import {
  createResponseState,
  effectiveQuestion,
  prefillQuestions,
  simulateLoop,
  answerKey,
} from "./index.js";

/**
 * MASK ACTIONS THAT USED TO DO NOTHING, and the restrictions that used to
 * refuse rules the evaluator handles.
 *
 * `preselect`, `display_and_preselect` and `disable` were storable, offered in
 * the picker and written into the exported spec — and applied by no code at
 * all. That is worse than not offering them: the programmer had every reason
 * to believe the survey was configured. Each is now routed through the
 * mechanism auto punch already uses, so the two features cannot disagree.
 */

const q = (o: any): any => ({
  id: o.id, code: o.code ?? o.id.toUpperCase(), variableName: o.code ?? o.id.toUpperCase(),
  type: o.type ?? "multi_select", text: o.text ?? o.id,
  options: o.options ?? [], rows: o.rows ?? [], columns: o.columns ?? [],
  validation: [], skipLogic: [], punches: [], settings: {}, required: false,
  displayLogic: o.displayLogic,
  ...(o.mask ? { mask: o.mask } : {}),
});

const OPTS = [
  { code: "a", label: "Apple" },
  { code: "b", label: "Banana" },
  { code: "c", label: "Cherry" },
];

/** Q1 is the source; Q2 carries the mask. */
const withMask = (mask: Record<string, unknown>, q2Extra: Record<string, unknown> = {}) =>
  SurveyDefinition.parse({
    meta: { id: "s", code: "S", title: "masks", version: "1.0" },
    questions: [
      q({ id: "q1", code: "Q1", options: OPTS }),
      q({ id: "q2", code: "Q2", options: OPTS, mask, ...q2Extra }),
    ],
    flow: [
      { type: "page", id: "p1", questionIds: ["q1"] },
      { type: "page", id: "p2", questionIds: ["q2"] },
      { type: "end", id: "e1", status: "complete" },
    ],
  });

const stateWith = (def: any, answers: Record<string, unknown>) => {
  const st = createResponseState(def);
  Object.assign(st.answers, answers);
  return st;
};

const SELECTED_FROM_Q1 = { kind: "ref", questionId: "q1", selection: "selected" };

/* ============================================================== disable */

test("a disable mask leaves every option on screen", () => {
  const def = withMask({ expr: SELECTED_FROM_Q1, action: "disable" });
  const st = stateWith(def, { q1: ["a"] });
  const view = effectiveQuestion(def.questions[1], { def, state: st });
  assert.deepEqual(view.options.map((o: any) => o.code), ["a", "b", "c"],
    "disable shows all — it is display that filters");
});

test("a disable mask marks the options outside the set unanswerable", () => {
  const def = withMask({ expr: SELECTED_FROM_Q1, action: "disable" });
  const st = stateWith(def, { q1: ["a"] });
  const view = effectiveQuestion(def.questions[1], { def, state: st });
  const disabled = view.options.filter((o: any) => o.meta?.disabled).map((o: any) => o.code);
  assert.deepEqual(disabled, ["b", "c"],
    "the set says what stays answerable, so everything else is disabled");
});

test("a display mask still filters rather than disabling", () => {
  const def = withMask({ expr: SELECTED_FROM_Q1, action: "display" });
  const st = stateWith(def, { q1: ["a"] });
  const view = effectiveQuestion(def.questions[1], { def, state: st });
  assert.deepEqual(view.options.map((o: any) => o.code), ["a"]);
});

/* ============================================================ preselect */

test("a preselect mask ticks the computed set", () => {
  const def = withMask({ expr: SELECTED_FROM_Q1, action: "preselect" });
  const st = stateWith(def, { q1: ["a", "c"] });
  const target = def.questions[1];
  prefillQuestions([target], { def, state: st }, (x: any) => answerKey(x.id, null));
  assert.deepEqual(st.answers.q2, ["a", "c"]);
});

test("a preselect mask never overwrites an answer the respondent gave", () => {
  const def = withMask({ expr: SELECTED_FROM_Q1, action: "preselect" });
  const st = stateWith(def, { q1: ["a", "c"], q2: ["b"] });
  prefillQuestions([def.questions[1]], { def, state: st }, (x: any) => answerKey(x.id, null));
  assert.deepEqual(st.answers.q2, ["b"],
    "re-applying a preselect would make an unticked option impossible to remove");
});

test("a preselect mask cannot tick an option the question does not show", () => {
  // Q2 displays only "a"; the preselect set names "c", which is not on screen
  const def = withMask(
    { expr: { kind: "codes", codes: ["c"] }, action: "preselect" },
    {},
  );
  // narrow Q2 to a single option so "c" is genuinely absent
  def.questions[1].options = [{ code: "a", label: "Apple", flags: [], logic: undefined } as any];
  const st = stateWith(def, {});
  prefillQuestions([def.questions[1]], { def, state: st }, (x: any) => answerKey(x.id, null));
  assert.equal(st.answers.q2, undefined);
});

test("display_and_preselect both filters and ticks", () => {
  const def = withMask({ expr: SELECTED_FROM_Q1, action: "display_and_preselect" });
  const st = stateWith(def, { q1: ["a", "b"] });
  const view = effectiveQuestion(def.questions[1], { def, state: st });
  assert.deepEqual(view.options.map((o: any) => o.code), ["a", "b"]);
  prefillQuestions([def.questions[1]], { def, state: st }, (x: any) => answerKey(x.id, null));
  assert.deepEqual(st.answers.q2, ["a", "b"]);
});

/* ================================== always-show, decoupled from fallback */

test("protectAlwaysShow keeps a special code that the fallback would have dropped", () => {
  const def = SurveyDefinition.parse({
    meta: { id: "s", code: "S", title: "m", version: "1.0" },
    questions: [
      q({ id: "q1", code: "Q1", options: OPTS }),
      q({
        id: "q2", code: "Q2",
        options: [...OPTS, { code: "none", label: "None of these", flags: ["none_of_above"] }],
        // show_none would previously have taken the protection away with it
        mask: {
          expr: SELECTED_FROM_Q1, action: "display",
          onEmptySource: "show_none", protectAlwaysShow: true,
        },
      }),
    ],
    flow: [{ type: "page", id: "p1", questionIds: ["q1", "q2"] }, { type: "end", id: "e1", status: "complete" }],
  });
  const st = stateWith(def, { q1: ["a"] });
  const view = effectiveQuestion(def.questions[1], { def, state: st });
  assert.deepEqual(view.options.map((o: any) => o.code), ["a", "none"],
    "the two settings are now independent choices");
});

test("a mask with neither field set behaves exactly as it always did", () => {
  const def = SurveyDefinition.parse({
    meta: { id: "s", code: "S", title: "m", version: "1.0" },
    questions: [
      q({ id: "q1", code: "Q1", options: OPTS }),
      q({
        id: "q2", code: "Q2",
        options: [...OPTS, { code: "none", label: "None of these", flags: ["none_of_above"] }],
        mask: { expr: SELECTED_FROM_Q1, action: "display" },
      }),
    ],
    flow: [{ type: "page", id: "p1", questionIds: ["q1", "q2"] }, { type: "end", id: "e1", status: "complete" }],
  });
  const st = stateWith(def, { q1: ["a"] });
  const view = effectiveQuestion(def.questions[1], { def, state: st });
  // keepAlwaysShow defaults true -> always_show_only -> the special code survives
  assert.deepEqual(view.options.map((o: any) => o.code), ["a", "none"]);
});

/* ============================== operators the evaluator always handled */

test("a single-response answer may be compared numerically", () => {
  // a matrix_single cell holds a scale point; "rated 4 or better" is ordinary
  for (const op of ["gt", "gte", "lt", "lte", "between", "notBetween"]) {
    assert.ok(OPERATORS_BY_KIND.choice.includes(op as any), `choice should allow ${op}`);
  }
});

test("a ranking answer may be tested with the list operators", () => {
  for (const op of ["containsAny", "containsAll", "containsNone"]) {
    assert.ok(OPERATORS_BY_KIND.ranking.includes(op as any), `ranking should allow ${op}`);
  }
});

/* ================================================= loop simulator (§39) */

test("the loop simulator reports which questions each iteration runs", () => {
  const def = SurveyDefinition.parse({
    meta: { id: "s", code: "S", title: "sim", version: "1.0" },
    questions: [
      q({ id: "q1", code: "Q1", options: OPTS }),
      q({ id: "q7", code: "Q7", type: "numeric" }),
      q({
        id: "q8", code: "Q8", type: "numeric",
        // only shown while the loop is on Apple
        displayLogic: { type: "rule", source: { kind: "loop", ref: "code" }, operator: "eq", value: "a" },
      } as any),
    ],
    flow: [
      {
        type: "loop", id: "L1", loopVar: "F",
        source: { kind: "question", questionId: "q1", filter: "selected" },
        children: [{ type: "page", id: "p1", questionIds: ["q7", "q8"] }],
      },
      { type: "end", id: "e1", status: "complete" },
    ],
  });
  const st = stateWith(def, { q1: ["a", "b"] });
  const sim = simulateLoop(def, def.flow[0] as any, st);
  assert.equal(sim.count, 2);
  assert.deepEqual(sim.iterations[0].questions.map((x) => x.code), ["Q7", "Q8"]);
  assert.deepEqual(sim.iterations[1].questions.map((x) => x.code), ["Q7"],
    "per-iteration display logic must be reflected — that is the point of simulating");
});

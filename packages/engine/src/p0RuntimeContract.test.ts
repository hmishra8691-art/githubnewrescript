import { test } from "node:test";
import assert from "node:assert/strict";
import { SurveyDefinition, cond } from "@rescript/schema";
import type { Condition } from "@rescript/schema";
import {
  createResponseState, setAnswer, setOtherTextFor, otherTextFor, otherTextsOf,
  evaluateCondition, isVacuousCondition, isEmptyAnswer,
  resolvePiping, start, compileFlow, applyEmbeddedField, allEmbeddedFields,
  embeddedCatalog, embeddedFieldName, lintSurveyLogic, lintPipingTokens,
  buildVariableDictionary, flattenVariables, answerKey,
  type ResponseState,
} from "./index.js";

/**
 * THE P0 RUNTIME CONTRACT — embedded data, others specify, piping and logic.
 *
 * Every test here is a case from the bug report, written so that it FAILS
 * against the behaviour that was there before. That is the only property that
 * makes a regression test worth its runtime: a test that passes both ways
 * documents nothing.
 *
 * The four contracts under test:
 *
 *   1. An embedded variable exists when it is NAMED, wherever it is declared,
 *      and a definition that cannot produce a value produces no value — never
 *      an exception that reaches the respondent.
 *   2. "Other, specify" text belongs to ONE option of ONE question in ONE
 *      iteration, and is what `{{Q}}` pipes when that option is chosen.
 *   3. `undefined`, `null`, `""`, whitespace, `0`, `false` and real text are
 *      seven different things and none of them may become another.
 *   4. A condition means the same thing to every evaluator in the product, and
 *      a group with nothing in it constrains nothing.
 */

/* ------------------------------------------------------------------ fixtures */

const CARS = [
  { code: "1", label: "Ford" },
  { code: "2", label: "Toyota" },
  { code: "97", label: "Other, please specify", flags: ["other_specify"] },
];

/** Q1 single-select with one Other. Q2 a text question that pipes from it. */
function oneOther() {
  return SurveyDefinition.parse({
    meta: { id: "s", code: "S", title: "Other", version: "1.0" },
    questions: [
      { id: "q1", code: "Q1", variableName: "Q1", type: "single_select", text: "Which car?", options: CARS },
      { id: "q2", code: "Q2", variableName: "Q2", type: "open_text", text: "Why {{Q1}}?" },
    ],
  });
}

/** Q1 multi-select with THREE independent Other boxes. */
function threeOthers() {
  return SurveyDefinition.parse({
    meta: { id: "s", code: "S", title: "Others", version: "1.0" },
    questions: [
      {
        id: "q1", code: "Q1", variableName: "Q1", type: "multi_select", text: "Which brands?",
        options: [
          { code: "1", label: "Known brand" },
          { code: "97", label: "Other 1", flags: ["other_specify"] },
          { code: "98", label: "Other 2", flags: ["other_specify"] },
          { code: "99", label: "Other 3", flags: ["other_specify"] },
        ],
      },
      { id: "q2", code: "Q2", variableName: "Q2", type: "open_text", text: "x" },
    ],
  });
}

function embeddedSurvey(fields: unknown[], text = "Hello {{ed.source}}") {
  return SurveyDefinition.parse({
    meta: { id: "s", code: "S", title: "Embedded", version: "1.0" },
    questions: [{ id: "q1", code: "Q1", variableName: "Q1", type: "open_text", text }],
    flow: [
      { type: "embedded_data", id: "ed1", fields },
      { type: "page", id: "p1", questionIds: ["q1"] },
      { type: "end", id: "e1", status: "complete" },
    ],
  });
}

const ctxOf = (def: any, state: ResponseState, loop: any = null) => ({ def, state, loop });
const pipe = (def: any, state: ResponseState, text: string, loop: any = null) =>
  resolvePiping(text, ctxOf(def, state, loop) as never);

/* ==================================================================== 1. embedded */

test("embedded: a survey with no embedded data starts", () => {
  const def = embeddedSurvey([], "Hello");
  const st = createResponseState(def, {});
  const nav = start(def, st, {});
  assert.ok(nav.steps.length > 0);
});

test("embedded: a field with no name creates no variable at all", () => {
  /*
   * The shape the Studio itself produces the instant somebody adds an
   * Embedded Data node. It used to write `state.embedded[""] = null` — a
   * nameless variable in the response, the export and every picker.
   */
  const def = embeddedSurvey([{ name: "", source: "url", dataType: "string" }], "Hello");
  const st = createResponseState(def, {});
  start(def, st, {});
  assert.deepEqual(Object.keys(st.embedded), [], "no key, not an empty-named one");
  assert.deepEqual(allEmbeddedFields(def), [], "an unnamed row is not a declared field");
  assert.deepEqual(embeddedCatalog(def), [], "and never reaches the pickers");
});

test("embedded: a name is trimmed, so 'a ' and 'a' are one variable", () => {
  assert.equal(embeddedFieldName({ name: "  source  " }), "source");
  assert.equal(embeddedFieldName({ name: "   " }), "");
  assert.equal(embeddedFieldName({}), "");
  const def = embeddedSurvey([{ name: " source ", source: "static", value: "panelX" }]);
  const st = createResponseState(def, {});
  start(def, st, {});
  assert.equal(st.embedded.source, "panelX");
});

test("embedded: a default applies when nothing arrives; the URL wins when it does", () => {
  const def = embeddedSurvey([{ name: "source", source: "url", dataType: "string", defaultValue: "direct" }]);

  const bare = createResponseState(def, {});
  start(def, bare, {});
  assert.equal(bare.embedded.source, "direct");

  const withUrl = createResponseState(def, { embedded: { source: "panelX" } });
  start(def, withUrl, {});
  assert.equal(withUrl.embedded.source, "panelX");
});

test("embedded: a declared field reaches logic, piping, the linter and the dictionary", () => {
  const def = embeddedSurvey([{ name: "source", source: "url", dataType: "string" }]);
  const st = createResponseState(def, { embedded: { source: "panelX" } });
  start(def, st, {});

  // piping
  assert.equal(pipe(def, st, "Hello {{ed.source}}"), "Hello panelX");
  // logic
  assert.equal(
    evaluateCondition(
      { type: "rule", source: { kind: "variable", ref: "source" }, operator: "eq", value: "panelX" } as Condition,
      ctxOf(def, st) as never,
    ),
    true,
  );
  /*
   * The linters read `def.embeddedData` — the survey-level registry the
   * Studio has never written to — so both of these used to report a field
   * the survey plainly has. Two linters and a runtime, one answer now.
   */
  assert.deepEqual(lintPipingTokens(def, "{{ed.source}}"), [], "the properties panel agrees");
  const issues = lintSurveyLogic(def).filter((i) => /embedded data field/i.test(i.message));
  assert.deepEqual(issues, [], "and so does the diagnostics panel");
  assert.ok(
    buildVariableDictionary(def).some((v) => v.name === "source"),
    "and it has a column in the data dictionary",
  );
});

test("embedded: an expression that cannot be evaluated yields null, never a throw", () => {
  const def = embeddedSurvey([{ name: "score", source: "expression", value: "nosuchfn(1,", dataType: "integer" }]);
  const st = createResponseState(def, {});
  // the whole point: the interview starts
  assert.doesNotThrow(() => start(def, st, {}));
  assert.equal(st.embedded.score, null);
  const out = applyEmbeddedField(def, st, { name: "score", source: "expression", value: "nosuchfn(1," } as never);
  assert.ok(out.error, "and the reason is reported rather than swallowed");
});

test("embedded: a referenced-but-never-set variable pipes as empty, not as 'undefined'", () => {
  const def = embeddedSurvey([], "Hello {{ed.missing}}");
  const st = createResponseState(def, {});
  start(def, st, {});
  assert.equal(pipe(def, st, "Hello {{ed.missing}}"), "Hello ");
});

/* ============================================================= 2. others specify */

test("others: {{Q1}} pipes what the respondent typed, not the option label", () => {
  const def = oneOther();
  const st = createResponseState(def, {});
  setAnswer(def, st, "q1", "97", null);
  setOtherTextFor(st, def.questions[0]!, "97", "Tesla Model Y", null);

  assert.equal(pipe(def, st, "Why {{Q1}}?"), "Why Tesla Model Y?");
  assert.equal(pipe(def, st, "{{Q1.other}}"), "Tesla Model Y");
  // a normal option is unaffected
  setAnswer(def, st, "q1", "2", null);
  assert.equal(pipe(def, st, "Why {{Q1}}?"), "Why Toyota?");
});

test("others: {{Q1.code}} and {{Q1.value}} stay the CODE — four things, four answers", () => {
  const def = oneOther();
  const st = createResponseState(def, {});
  setAnswer(def, st, "q1", "97", null);
  setOtherTextFor(st, def.questions[0]!, "97", "Tesla Model Y", null);

  assert.equal(pipe(def, st, "{{Q1.code}}"), "97", "the stored code");
  assert.equal(pipe(def, st, "{{Q1.value}}"), "97", "the stored code");
  assert.equal(pipe(def, st, "{{Q1.label}}"), "Tesla Model Y", "the respondent's words");
  assert.equal(pipe(def, st, "{{Q1.other}}"), "Tesla Model Y", "the box's own text");
});

test("others: an Other selected with an EMPTY box still pipes the label", () => {
  // the selection is a fact; piping nothing would lose it. `.other` is the
  // token whose contract is to give back the box exactly as it is.
  const def = oneOther();
  const st = createResponseState(def, {});
  setAnswer(def, st, "q1", "97", null);
  assert.equal(pipe(def, st, "Why {{Q1}}?"), "Why Other, please specify?");
  assert.equal(pipe(def, st, "[{{Q1.other}}]"), "[]");
});

test("others: three boxes are three answers", () => {
  const def = threeOthers();
  const q = def.questions[0]!;
  const st = createResponseState(def, {});
  setAnswer(def, st, "q1", ["97", "98", "99"], null);
  setOtherTextFor(st, q, "97", "Apple", null);
  setOtherTextFor(st, q, "98", "Samsung", null);
  setOtherTextFor(st, q, "99", "Google", null);

  assert.equal(otherTextFor(st, q, "97", null), "Apple");
  assert.equal(otherTextFor(st, q, "98", null), "Samsung");
  assert.equal(otherTextFor(st, q, "99", null), "Google");
  assert.deepEqual(otherTextsOf(st, q, null), { "97": "Apple", "98": "Samsung", "99": "Google" });
  assert.equal(pipe(def, st, "{{Q1[98].other}}"), "Samsung");
  // and clearing one leaves the others alone
  setOtherTextFor(st, q, "98", "", null);
  assert.equal(otherTextFor(st, q, "97", null), "Apple");
  assert.equal(otherTextFor(st, q, "98", null), "");
  assert.equal(otherTextFor(st, q, "99", null), "Google");
});

test("others: an empty box does not resurrect text from an older response", () => {
  /*
   * The legacy question-level key is read for the FIRST flagged option, which
   * is right — but it used to be consulted whenever the per-option key held an
   * empty string, so a respondent who cleared their answer got last month's
   * text back. Presence decides now: an empty box IS the answer.
   */
  const def = oneOther();
  const q = def.questions[0]!;
  const st = createResponseState(def, {});
  st.answers[`${answerKey("q1", null)}__other`] = "Old Text" as never;
  assert.equal(otherTextFor(st, q, "97", null), "Old Text", "an old response still reads");

  st.answers[`${answerKey("q1", null)}__other__97`] = "" as never;
  assert.equal(otherTextFor(st, q, "97", null), "", "and an explicit empty box wins over it");
});

test("others: the text of a question answered outside a loop is readable inside it", () => {
  const def = SurveyDefinition.parse({
    meta: { id: "s", code: "S", title: "Loop", version: "1.0" },
    questions: [
      { id: "q1", code: "Q1", variableName: "Q1", type: "single_select", text: "Which car?", options: CARS },
      { id: "q2", code: "Q2", variableName: "Q2", type: "open_text", text: "About {{Q1.other}}" },
    ],
  });
  const st = createResponseState(def, {});
  setAnswer(def, st, "q1", "97", null);
  setOtherTextFor(st, def.questions[0]!, "97", "Tesla Model Y", null);

  const inner = { loopVar: "brand", code: "apple", label: "Apple", index: 0 };
  // `lookupAnswer` walks outward for an ordinary answer; the Other text now does too
  assert.equal(pipe(def, st, "{{Q1.other}}", inner), "Tesla Model Y");
  assert.equal(pipe(def, st, "{{Q1}}", inner), "Tesla Model Y");
});

/* ========================================================= 3. the value contract */

test("value contract: seven states, seven meanings", () => {
  const def = oneOther();
  const q = def.questions[0]!;
  const cases: [string, unknown, string][] = [
    ["undefined", undefined, ""],
    ["null", null, ""],
    ["empty string", "", ""],
    ["whitespace", "   ", "   "],
    ["zero", 0, "0"],
    ["false", false, "false"],
    ["real text", "Tesla Model Y", "Tesla Model Y"],
  ];
  for (const [name, stored, expected] of cases) {
    const st = createResponseState(def, {});
    setAnswer(def, st, "q1", "97", null);
    if (stored !== undefined) st.answers[`${answerKey("q1", null)}__other__97`] = stored as never;
    assert.equal(
      otherTextFor(st, q, "97", null),
      expected,
      `${name} must not be turned into anything else`,
    );
    assert.ok(
      !/undefined|null|\[object/.test(otherTextFor(st, q, "97", null)),
      `${name} must never render as a language artefact`,
    );
  }
});

test("value contract: {{Q.count}} is a number for every answer shape", () => {
  const def = threeOthers();
  const st = createResponseState(def, {});
  assert.equal(pipe(def, st, "{{Q1.count}}"), "0", "unanswered is zero, not empty");
  st.answers[answerKey("q1", null)] = "" as never;
  assert.equal(pipe(def, st, "{{Q1.count}}"), "0", "an empty string selects nothing");
  setAnswer(def, st, "q1", ["97", "98"], null);
  assert.equal(pipe(def, st, "{{Q1.count}}"), "2");
});

test("value contract: one definition of 'not answered'", () => {
  assert.equal(isEmptyAnswer(null), true);
  assert.equal(isEmptyAnswer(undefined), true);
  assert.equal(isEmptyAnswer(""), true);
  assert.equal(isEmptyAnswer("   "), true, "whitespace is not an answer");
  assert.equal(isEmptyAnswer([]), true);
  assert.equal(isEmptyAnswer({ r1: null }), true, "a grid with no cell filled is not answered");
  assert.equal(isEmptyAnswer(0), false, "zero IS an answer");
  assert.equal(isEmptyAnswer(false), false, "false IS an answer");
  assert.equal(isEmptyAnswer("x"), false);
});

test("value contract: isEmpty and isNotEmpty agree with that definition", () => {
  const def = SurveyDefinition.parse({
    meta: { id: "s", code: "S", title: "Empty", version: "1.0" },
    questions: [
      { id: "q1", code: "Q1", variableName: "Q1", type: "open_text", text: "x" },
      { id: "q2", code: "Q2", variableName: "Q2", type: "numeric", text: "y" },
    ],
  });
  const st = createResponseState(def, {});
  st.answers.q1 = "   " as never;
  assert.equal(evaluateCondition(cond.rule("q1", "isEmpty") as Condition, ctxOf(def, st) as never), true);
  st.answers.q2 = 0 as never;
  assert.equal(evaluateCondition(cond.rule("q2", "isNotEmpty") as Condition, ctxOf(def, st) as never), true,
    "zero is an answer to the logic too");
});

/* ==================================================================== 4. logic */

test("logic: an empty group constrains nothing, whatever its operator", () => {
  const def = oneOther();
  const st = createResponseState(def, {});
  setAnswer(def, st, "q1", "1", null);
  const ctx = ctxOf(def, st) as never;
  const TRUE = cond.rule("q1", "eq", "1") as Condition;

  assert.equal(isVacuousCondition({ type: "group", op: "or", children: [] } as Condition), true);
  assert.equal(
    isVacuousCondition({ type: "group", op: "and", children: [{ type: "group", op: "or", children: [] }] } as Condition),
    true,
    "and nesting cannot hide one",
  );

  // the reported bug: one click on "+ Group" turned a whole AND false
  assert.equal(
    evaluateCondition(
      { type: "group", op: "and", children: [TRUE, TRUE, { type: "group", op: "or", children: [] }] } as Condition,
      ctx,
    ),
    true,
    "A AND B AND (empty) is A AND B",
  );
  // and the mirror image, which was true for the same bad reason
  assert.equal(
    evaluateCondition(
      { type: "group", op: "or", children: [cond.rule("q1", "eq", "2") as Condition, { type: "group", op: "and", children: [] }] } as Condition,
      ctx,
    ),
    false,
    "A OR (empty) is A",
  );
});

test("logic: AND is conjunction, OR is disjunction, NOT is none-of", () => {
  const def = oneOther();
  const st = createResponseState(def, {});
  setAnswer(def, st, "q1", "1", null);
  const ctx = ctxOf(def, st) as never;
  const T = cond.rule("q1", "eq", "1") as Condition;
  const F = cond.rule("q1", "eq", "2") as Condition;
  const g = (op: "and" | "or" | "not", children: Condition[]) => ({ type: "group", op, children }) as Condition;

  assert.equal(evaluateCondition(g("and", [T, T]), ctx), true);
  assert.equal(evaluateCondition(g("and", [T, F]), ctx), false);
  assert.equal(evaluateCondition(g("or", [T, F]), ctx), true);
  assert.equal(evaluateCondition(g("or", [F, F]), ctx), false);
  assert.equal(evaluateCondition(g("not", [F, F]), ctx), true, "NONE of these are true");
  assert.equal(evaluateCondition(g("not", [T, F]), ctx), false);
  // nested, which is where an operator mix-up hides
  assert.equal(evaluateCondition(g("and", [T, g("or", [F, T])]), ctx), true);
  assert.equal(evaluateCondition(g("and", [T, g("or", [F, F])]), ctx), false);
});

test("logic: `contains` has one case policy, whatever shape the answer is in", () => {
  const def = threeOthers();
  const st = createResponseState(def, {});
  const ctx = () => ctxOf(def, st) as never;

  st.answers.q1 = ["Blue"] as never;
  assert.equal(evaluateCondition(cond.rule("q1", "contains", "blue") as Condition, ctx()), true,
    "a list member matches case-insensitively…");
  st.answers.q1 = "Blue" as never;
  assert.equal(evaluateCondition(cond.rule("q1", "contains", "blue") as Condition, ctx()), true,
    "…exactly as the same rule already did for text");
  assert.equal(evaluateCondition(cond.rule("q1", "notContains", "blue") as Condition, ctx()), false,
    "and notContains is its negation, not a second policy");
});

test("logic: a count rule reads the same answer an ordinary rule does", () => {
  /*
   * `evaluate` uses `lookupAnswer`, which walks outward through the enclosing
   * iterations; `evaluateCount` used `answerKey`, which builds one exact key.
   * Inside a loop the two disagreed about a question answered outside it — so
   * an AND containing one of each was being told two different things.
   */
  const def = threeOthers();
  const st = createResponseState(def, {});
  setAnswer(def, st, "q1", ["1", "97"], null);
  const outer = ctxOf(def, st) as never;
  const inner = ctxOf(def, st, { loopVar: "brand", code: "apple", label: "Apple", index: 0 }) as never;

  const plain = cond.rule("q1", "isNotEmpty") as Condition;
  const counted = cond.minCount("q1", 2) as Condition;

  assert.equal(evaluateCondition(plain, outer), true);
  assert.equal(evaluateCondition(counted, outer), true);
  assert.equal(evaluateCondition(plain, inner), true);
  assert.equal(evaluateCondition(counted, inner), true, "the count sees it from inside the loop too");
  assert.equal(
    evaluateCondition({ type: "group", op: "and", children: [plain, counted] } as Condition, inner),
    true,
    "so an AND of the two is consistent",
  );
});

/* ====================================================== 5. nothing hangs the runtime */

test("runtime: a malformed embedded configuration never stops the interview", () => {
  for (const fields of [
    [],
    [{ name: "", source: "url" }],
    [{ name: "a", source: "expression", value: "" }],
    [{ name: "a", source: "expression", value: "1 +" }],
    [{ name: "a", source: "expression", value: "a" }],           // refers to itself
    [{ name: "a", source: "static", value: "" , dataType: "integer" }],
    [{ name: "a", source: "url", dataType: "date", defaultValue: "not a date" }],
    [{ name: "a", source: "url" }, { name: "a", source: "static", value: "2" }], // duplicate
  ]) {
    const def = embeddedSurvey(fields as never[]);
    const st = createResponseState(def, {});
    assert.doesNotThrow(() => {
      const nav = start(def, st, {});
      compileFlow(def, st, {});
      flattenVariables(def, st);
      embeddedCatalog(def);
      buildVariableDictionary(def);
      lintSurveyLogic(def);
      assert.ok(nav.steps.length > 0, "and it reaches a first step");
    }, `fields: ${JSON.stringify(fields)}`);
  }
});

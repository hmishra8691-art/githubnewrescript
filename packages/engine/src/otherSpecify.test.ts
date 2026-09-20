import test from "node:test";
import assert from "node:assert/strict";
import { SurveyDefinition } from "@rescript/schema";
import {
  otherKeyFor, legacyOtherKey, otherTextFor, otherTextsOf, setOtherTextFor,
  otherTextOf, setOtherText, otherOptions, otherColumnFor,
  otherIsSelected, selectedOtherCodes, syncOtherText, clearOtherText,
  otherSpecifyEntries,
  createResponseState, setAnswer, flattenVariables, buildVariableDictionary,
  resolvePiping, validateQuestion, lintVariables, nextQuestionNaming, evaluateCondition,
  type ResponseState,
} from "./index.js";

/**
 * THE BUG THIS SUITE EXISTS FOR.
 *
 * A multi-select with three "Other, specify" options showed three boxes and
 * stored ONE string. Typing Apple into the first put Apple into the other
 * two — on screen, in the data, and in the export. The old suite never caught
 * it because every fixture in it had exactly one flagged option per question,
 * which is the one shape where a shared key is indistinguishable from a
 * correct one.
 *
 * So the fixture here is the shape that was broken: one question, three boxes.
 */

const brands = (extra: Record<string, unknown> = {}) => ({
  id: "q1", code: "Q1", variableName: "BRAND", type: "multi_select", text: "Which brands?",
  options: [
    { code: 1, label: "Acme" },
    { code: 2, label: "Globex" },
    { code: 97, label: "Other phone", flags: ["other_specify"] },
    { code: 98, label: "Other tablet", flags: ["other_specify"] },
    { code: 99, label: "Other laptop", flags: ["other_specify"] },
  ],
  ...extra,
});

function survey(over: Record<string, unknown> = {}) {
  return SurveyDefinition.parse({
    meta: { id: "s1", code: "S", title: "T" },
    questions: [
      brands(),
      { id: "q2", code: "Q2", variableName: "WHY", type: "open_text", text: "Why?" },
      { id: "q3", code: "Q3", variableName: "ONE", type: "single_select", text: "Pick one",
        options: [{ code: 1, label: "Yes" }, { code: 9, label: "Other", flags: ["other_specify"] }] },
    ],
    flow: [
      { type: "page", id: "p1", questionIds: ["q1"] },
      { type: "page", id: "p2", questionIds: ["q2", "q3"] },
      { type: "end", id: "e1", status: "complete" },
    ],
    ...over,
  });
}

const Q = (def: ReturnType<typeof survey>, id: string) => def.questions.find((q) => q.id === id)!;

function filled(): { def: ReturnType<typeof survey>; state: ResponseState } {
  const def = survey();
  const state = createResponseState(def);
  setAnswer(def, state, "q1", [97, 98, 99]);
  setOtherTextFor(state, Q(def, "q1"), 97, "Apple");
  setOtherTextFor(state, Q(def, "q1"), 98, "Samsung");
  setOtherTextFor(state, Q(def, "q1"), 99, "Sony");
  return { def, state };
}

/* ===================================================== three boxes, three values */

test("THREE OTHER BOXES IN ONE QUESTION HOLD THREE DIFFERENT ANSWERS", () => {
  const { def, state } = filled();
  const q = Q(def, "q1");

  assert.equal(otherTextFor(state, q, 97), "Apple");
  assert.equal(otherTextFor(state, q, 98), "Samsung");
  assert.equal(otherTextFor(state, q, 99), "Sony");

  // three keys, not one
  assert.deepEqual(
    Object.keys(state.answers).filter((k) => k.includes("__other")).sort(),
    ["q1__other__97", "q1__other__98", "q1__other__99"],
  );
  assert.equal(state.answers[legacyOtherKey("q1")], undefined, "and nothing lands on the old shared key");
});

test("editing one box moves nothing else", () => {
  const { def, state } = filled();
  const q = Q(def, "q1");
  setOtherTextFor(state, q, 98, "Nokia");
  assert.deepEqual(otherTextsOf(state, q), { "97": "Apple", "98": "Nokia", "99": "Sony" });
});

test("clearing one box leaves the other two alone", () => {
  const { def, state } = filled();
  const q = Q(def, "q1");
  setOtherTextFor(state, q, 97, "");
  assert.equal(otherTextFor(state, q, 97), "");
  assert.equal(state.answers[otherKeyFor("q1", 97)], undefined, "an emptied box is absent, not blank");
  assert.equal(otherTextFor(state, q, 98), "Samsung");
  assert.equal(otherTextFor(state, q, 99), "Sony");
});

test("unticking ONE Other takes its own text and no other", () => {
  const { def, state } = filled();
  const q = Q(def, "q1");
  setAnswer(def, state, "q1", [97, 99]);     // 98 unticked
  assert.equal(otherTextFor(state, q, 98), "", "the abandoned box is cleaned up");
  assert.equal(otherTextFor(state, q, 97), "Apple", "and the ones still selected are untouched");
  assert.equal(otherTextFor(state, q, 99), "Sony");
});

test("unticking every Other clears every box", () => {
  const { def, state } = filled();
  setAnswer(def, state, "q1", [1]);
  assert.deepEqual(otherTextsOf(state, Q(def, "q1")), {});
});

test("the codes are reported in programmed order, not selection order", () => {
  const def = survey();
  const state = createResponseState(def);
  setAnswer(def, state, "q1", [99, 97, 98]);
  assert.deepEqual(selectedOtherCodes(Q(def, "q1"), state.answers.q1), ["97", "98", "99"]);
  assert.equal(otherIsSelected(Q(def, "q1"), state.answers.q1), true);
  assert.equal(otherIsSelected(Q(def, "q1"), [1, 2]), false);
});

test("a loop gives every iteration its own three boxes", () => {
  const def = survey();
  const q = Q(def, "q1");
  const state = createResponseState(def);
  const apple = { loopVar: "brand", loopId: "l1", code: "apple", label: "Apple", index: 1 } as never;
  const google = { loopVar: "brand", loopId: "l1", code: "google", label: "Google", index: 2 } as never;

  setOtherTextFor(state, q, 97, "one", apple);
  setOtherTextFor(state, q, 97, "two", google);
  setOtherTextFor(state, q, 98, "three", apple);

  assert.equal(otherTextFor(state, q, 97, apple), "one");
  assert.equal(otherTextFor(state, q, 97, google), "two");
  assert.equal(otherTextFor(state, q, 98, apple), "three");
  assert.equal(otherTextFor(state, q, 98, google), "", "an iteration does not borrow another's text");
  assert.notEqual(otherKeyFor("q1", 97, apple), otherKeyFor("q1", 97, google));
});

/* ====================================================== old responses still read */

test("a response collected before per-option keys still reads back", () => {
  const def = survey();
  const q = Q(def, "q1");
  const state = createResponseState(def);
  state.answers.q1 = [97] as never;
  state.answers[legacyOtherKey("q1")] = "Apple" as never;   // the old shape

  assert.equal(otherTextFor(state, q, 97), "Apple", "the first flagged option inherits it");
  assert.equal(otherTextFor(state, q, 98), "", "and nothing else does");
  assert.equal(flattenVariables(def, state).BRAND_other, "Apple", "the export column is unchanged");
});

test("emptying a box that came from an old response makes it stay empty", () => {
  const def = survey();
  const q = Q(def, "q1");
  const state = createResponseState(def);
  state.answers[legacyOtherKey("q1")] = "Apple" as never;
  setOtherTextFor(state, q, 97, "");
  // without removing the legacy key the fallback would put "Apple" straight back
  assert.equal(otherTextFor(state, q, 97), "");
});

/* ================================================================ the export */

test("three boxes become three columns, and the first keeps its old name", () => {
  const { def, state } = filled();
  const flat = flattenVariables(def, state);
  assert.equal(flat.BRAND_other, "Apple", "the pre-existing column still means the first box");
  assert.equal(flat.BRAND_other_98, "Samsung");
  assert.equal(flat.BRAND_other_99, "Sony");
});

test("the variable dictionary declares one column per box, named after the option", () => {
  const dict = buildVariableDictionary(survey());
  const names = dict.filter((v) => v.name.startsWith("BRAND_other")).map((v) => v.name);
  assert.deepEqual(names, ["BRAND_other", "BRAND_other_98", "BRAND_other_99"]);
  const first = dict.find((v) => v.name === "BRAND_other")!;
  assert.match(first.label, /Other phone/, "the label says WHICH other box it is");
  assert.equal(first.dataType, "text");
});

test("every box is reported separately, with the column it exports to", () => {
  const { def, state } = filled();
  const entries = otherSpecifyEntries(def, state).sort((a, b) => a.optionCode.localeCompare(b.optionCode));
  assert.equal(entries.length, 3);
  assert.deepEqual(entries.map((e) => e.text), ["Apple", "Samsung", "Sony"]);
  assert.deepEqual(entries.map((e) => e.column), ["BRAND_other", "BRAND_other_98", "BRAND_other_99"]);
  assert.deepEqual(entries.map((e) => e.optionLabel), ["Other phone", "Other tablet", "Other laptop"]);
});

test("a legacy key is still reported, as the first option's box", () => {
  const def = survey();
  const state = createResponseState(def);
  state.answers[legacyOtherKey("q1")] = "Apple" as never;
  const entries = otherSpecifyEntries(def, state);
  assert.equal(entries.length, 1);
  assert.equal(entries[0]!.optionCode, "97");
  assert.equal(entries[0]!.column, "BRAND_other");
});

/* =============================================================== the piping */

test("EACH OTHER BOX PIPES ITS OWN ANSWER", () => {
  const { def, state } = filled();
  const ctx = { def, state, loop: null };
  assert.equal(resolvePiping("You said {{Q1[97].other}}.", ctx), "You said Apple.");
  assert.equal(resolvePiping("You said {{Q1[98].other}}.", ctx), "You said Samsung.");
  assert.equal(resolvePiping("You said {{Q1[99].other}}.", ctx), "You said Sony.");
});

test("three piped boxes in one sentence stay three different answers", () => {
  const { def, state } = filled();
  assert.equal(
    resolvePiping("{{Q1[97].other}}, {{Q1[98].other}} and {{Q1[99].other}}", { def, state, loop: null }),
    "Apple, Samsung and Sony",
  );
});

test("the unqualified form means the first box", () => {
  const { def, state } = filled();
  assert.equal(resolvePiping("{{Q1.other}}", { def, state, loop: null }), "Apple");
});

test("an empty box pipes nothing rather than another box's text", () => {
  const def = survey();
  const state = createResponseState(def);
  setAnswer(def, state, "q1", [97, 98]);
  setOtherTextFor(state, Q(def, "q1"), 97, "Apple");
  const ctx = { def, state, loop: null };
  assert.equal(resolvePiping("[{{Q1[98].other}}]", ctx), "[]");
  assert.equal(resolvePiping("[{{Q1[99].other}}]", ctx), "[]", "and neither does an unselected one");
});

test("piped other text is escaped, like every other pipe", () => {
  const def = survey();
  const state = createResponseState(def);
  setOtherTextFor(state, Q(def, "q1"), 97, '<img src=x onerror="alert(1)">');
  const out = resolvePiping("{{Q1.other}}", { def, state, loop: null });
  assert.ok(!out.includes("<img"), out);
  assert.match(out, /&lt;img/);
});

test("a question with no Other box pipes nothing for it", () => {
  const { def, state } = filled();
  assert.equal(resolvePiping("[{{Q2.other}}]", { def, state, loop: null }), "[]");
});

/* --------------------------------------------- plain open ends, which must also pipe */

test("an open text answer pipes as what the respondent typed", () => {
  const def = SurveyDefinition.parse({
    meta: { id: "s", code: "S", title: "T" },
    questions: [
      { id: "t1", code: "T1", variableName: "SHORT", type: "open_text", text: "Short?" },
      { id: "t2", code: "T2", variableName: "LONG", type: "long_text", text: "Long?" },
      { id: "t3", code: "T3", variableName: "NUM", type: "numeric", text: "How many?" },
      { id: "t4", code: "T4", variableName: "GRID", type: "matrix_text", text: "Grid",
        rows: [{ code: "r1", label: "Row one" }, { code: "r2", label: "Row two" }] },
    ],
  });
  const state = createResponseState(def);
  setAnswer(def, state, "t1", "a short one");
  setAnswer(def, state, "t2", "a much longer one");
  setAnswer(def, state, "t3", 42);
  setAnswer(def, state, "t4", { r1: "first cell", r2: "second cell" });
  const ctx = { def, state, loop: null };

  assert.equal(resolvePiping("{{T1}}", ctx), "a short one");
  assert.equal(resolvePiping("{{T2}}", ctx), "a much longer one");
  assert.equal(resolvePiping("{{T3}}", ctx), "42");
  assert.equal(resolvePiping("{{T1.value}}", ctx), "a short one", "and the explicit form agrees");
  assert.equal(resolvePiping("{{T4[r1]}}", ctx), "first cell", "a grid cell pipes its own cell");
  assert.equal(resolvePiping("{{T4[r2]}}", ctx), "second cell");
});

test("an unanswered open end pipes nothing, not the question text", () => {
  const def = survey();
  const state = createResponseState(def);
  assert.equal(resolvePiping("[{{Q2}}]", { def, state, loop: null }), "[]");
});

/* ============================================================ the validation */

test("EVERY selected Other needs its own text, not one between them", () => {
  const def = survey();
  const q = Q(def, "q1");
  const state = createResponseState(def);
  state.answers.q1 = [97, 98, 99] as never;
  setOtherTextFor(state, q, 97, "Apple");
  const ctx = { def, state, loop: null };

  // one filled, two blank — this used to pass, which is how blank "Other"
  // answers reached the data
  assert.ok(validateQuestion(def, q, state.answers.q1, ctx).length > 0, "two empty boxes are refused");

  setOtherTextFor(state, q, 98, "Samsung");
  assert.ok(validateQuestion(def, q, state.answers.q1, ctx).length > 0, "one still empty");

  setOtherTextFor(state, q, 99, "Sony");
  assert.deepEqual(validateQuestion(def, q, state.answers.q1, ctx), [], "all three filled");
});

test("an unselected Other box is not required to be filled", () => {
  const def = survey();
  const q = Q(def, "q1");
  const state = createResponseState(def);
  state.answers.q1 = [1] as never;
  assert.deepEqual(validateQuestion(def, q, state.answers.q1, { def, state, loop: null }), []);
});

test("otherSpecifyOptional still waives all of them", () => {
  const def = survey();
  const q = { ...Q(def, "q1"), settings: { ...Q(def, "q1").settings, otherSpecifyOptional: true } };
  const state = createResponseState(def);
  state.answers.q1 = [97, 98] as never;
  assert.deepEqual(validateQuestion(def, q, state.answers.q1, { def, state, loop: null }), []);
});

test("whitespace is not an answer", () => {
  const def = survey();
  const q = Q(def, "q1");
  const state = createResponseState(def);
  state.answers.q1 = [97] as never;
  setOtherTextFor(state, q, 97, "   ");
  assert.ok(validateQuestion(def, q, state.answers.q1, { def, state, loop: null }).length > 0);
});

/* ================================================== the single-box shorthand */

test("the one-box shorthand still works, and means the first box", () => {
  const def = survey();
  const q = Q(def, "q3");            // a single_select with one flagged option
  const state = createResponseState(def);
  setAnswer(def, state, "q3", 9);
  setOtherText(state, q, "Something else");
  assert.equal(otherTextOf(state, q), "Something else");
  assert.equal(state.answers[otherKeyFor("q3", 9)], "Something else");
  assert.equal(flattenVariables(def, state).ONE_other, "Something else");
  assert.deepEqual(otherOptions(q).map((o) => o.code), [9]);
  assert.equal(otherColumnFor(q, 9), "ONE_other");
});

test("clearing a question's boxes wholesale leaves nothing behind", () => {
  const { def, state } = filled();
  clearOtherText(state, Q(def, "q1"));
  assert.deepEqual(Object.keys(state.answers).filter((k) => k.includes("__other")), []);
});

test("syncOtherText reports whether it removed anything", () => {
  const { def, state } = filled();
  const q = Q(def, "q1");
  assert.equal(syncOtherText(state, q), false, "everything is still selected");
  state.answers.q1 = [97] as never;
  assert.equal(syncOtherText(state, q), true);
  assert.deepEqual(otherTextsOf(state, q), { "97": "Apple" });
});

/* ====================================================== no duplicate columns */

test("the new columns do not collide with a question someone named BRAND_other_98", () => {
  const def = survey({
    questions: [
      brands(),
      { id: "qx", code: "QX", variableName: "BRAND_other_98", type: "open_text", text: "Collision" },
    ],
  });
  const issues = lintVariables(def);
  assert.ok(
    issues.some((i) => /BRAND_other_98/.test(String(i))),
    `the clash is reported: ${issues.map((i) => String(i)).join(" | ")}`,
  );
  void nextQuestionNaming;
});

/* ================================================================== logic */

test("CONDITIONAL LOGIC CAN TELL THE THREE BOXES APART", () => {
  const { def, state } = filled();
  const ctx = { def, state, loop: null };
  const when = (expression: string) =>
    evaluateCondition(
      { type: "rule", source: { kind: "expr", ref: expression }, operator: "eq", value: true } as never,
      ctx,
    );

  // each box is its own flat variable, so a rule can name exactly one
  assert.equal(when('BRAND_other == "Apple"'), true);
  assert.equal(when('BRAND_other_98 == "Samsung"'), true);
  assert.equal(when('BRAND_other_99 == "Sony"'), true);
  // and cannot be satisfied by another box's answer
  assert.equal(when('BRAND_other_98 == "Apple"'), false);
  assert.equal(when('BRAND_other_99 == "Samsung"'), false);
});

test("a script reads each box through the same flat names", () => {
  const { def, state } = filled();
  const flat = flattenVariables(def, state);
  assert.equal(flat.BRAND_other, "Apple");
  assert.equal(flat.BRAND_other_98, "Samsung");
  assert.equal(flat.BRAND_other_99, "Sony");
});

test("CLEARING A BOX INSIDE A LOOP DOES NOT PUT THE OUTER ITERATION'S TEXT BACK", () => {
  /*
   * `otherTextFor` walks outward through the enclosing iterations to the
   * survey level, which is right for a box that was never filled in this
   * iteration and wrong for one the respondent emptied: clearing used to
   * DELETE the key, so the read fell through and the previous scope's answer
   * reappeared. A respondent who typed "Tesla" at brand 1 and cleared the box
   * at brand 2 was recorded as having said "Tesla" twice.
   */
  const def = survey();
  const q = Q(def, "q1");
  const state = createResponseState(def);
  const brand1 = { loopVar: "brand", loopId: "l1", code: "apple", label: "Apple", index: 1 } as never;

  setOtherTextFor(state, q, 97, "SurveyLevel");
  setOtherTextFor(state, q, 97, "InLoop", brand1);
  assert.equal(otherTextFor(state, q, 97, brand1), "InLoop");

  setOtherTextFor(state, q, 97, "", brand1);
  assert.equal(otherTextFor(state, q, 97, brand1), "", "emptied here means empty here");
  assert.equal(otherTextFor(state, q, 97), "SurveyLevel", "and the outer answer is untouched");

  /* an iteration that was never filled still inherits, which is the behaviour
     the outward walk exists for */
  const brand2 = { loopVar: "brand", loopId: "l1", code: "google", label: "Google", index: 2 } as never;
  assert.equal(otherTextFor(state, q, 97, brand2), "SurveyLevel");
});

test("clearing at the survey level still removes the key rather than storing empty", () => {
  const def = survey();
  const q = Q(def, "q1");
  const state = createResponseState(def);
  setOtherTextFor(state, q, 97, "Apple");
  setOtherTextFor(state, q, 97, "");
  assert.equal(otherKeyFor("q1", 97) in state.answers, false,
    "there is nothing to shadow at the top, so an absent answer stays absent");
});

/* ------------------------------- the export gap (§44 wave 1, N1) */

test("every question type that can collect a verbatim also DECLARES it", async () => {
  /*
   * THE BUG THIS EXISTS FOR.
   *
   * `flatten.ts` writes the other-specify column for every question with a
   * flagged option — the loop sits outside its type switch. `variables.ts`
   * declared it inside two arms of ITS switch, single-select and multi.
   *
   * So on a ranking, an allocation or any of the four matrix families the
   * respondent typed a verbatim, it was validated, stored and written at
   * interview time, and declared nowhere. Every exporter builds its columns
   * from the dictionary, so those answers reached no delivered file —
   * silently, in both directions.
   *
   * Reproduced before the fix as:
   *   ranking       declared=0  written=1  LOST=["V_other"]
   *   allocation    declared=0  written=1  LOST=["V_other"]
   *   matrix_single declared=0  written=1  LOST=["V_other"]
   */
  const { SurveyDefinition } = await import("@rescript/schema");
  const { buildVariableDictionary } = await import("./variables.js");
  const { flattenVariables } = await import("./flatten.js");
  const { createResponseState } = await import("./state.js");

  const cases: { type: string; answer: unknown; extra?: Record<string, unknown> }[] = [
    { type: "single_select", answer: "98" },
    { type: "multi_select", answer: ["98"] },
    { type: "ranking", answer: ["98", "1"] },
    { type: "allocation", answer: { "1": 40, "98": 60 } },
    { type: "matrix_single", answer: { r1: "98" }, extra: { rows: [{ code: "r1", label: "R1" }] } },
    { type: "matrix_multi", answer: { r1: ["98"] }, extra: { rows: [{ code: "r1", label: "R1" }] } },
  ];

  for (const c of cases) {
    const def = SurveyDefinition.parse({
      meta: { id: "o", code: "O", title: "t", version: "1.0", status: "draft" },
      questions: [{
        id: "q", code: "Q1", variableName: "V", type: c.type, text: "t",
        options: [{ code: "1", label: "A" }, { code: "98", label: "Other", flags: ["other_specify"] }],
        ...(c.extra ?? {}),
      }],
      flow: [{ type: "page", id: "p", questionIds: ["q"] }, { type: "end", id: "e", status: "complete" }],
    });

    const state = createResponseState(def);
    state.answers = { q: c.answer, q__other__98: "a verbatim nobody should lose" } as any;

    const declared = new Set(buildVariableDictionary(def).map((v) => v.name));
    const written = Object.keys(flattenVariables(def, state as any, {}));
    const verbatimCols = written.filter((n) => /_other/i.test(n));

    assert.ok(verbatimCols.length > 0, `${c.type}: the runtime should write a verbatim column`);
    for (const col of verbatimCols) {
      assert.ok(
        declared.has(col),
        `${c.type}: "${col}" is written at interview time but not declared, so it reaches no export`,
      );
    }
  }
});

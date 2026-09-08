import { test } from "node:test";
import assert from "node:assert/strict";
import { SurveyDefinition, cond } from "@rescript/schema";
import type { Condition } from "@rescript/schema";
import {
  createResponseState, setAnswer, evaluateCondition, evaluateCount, lintCount,
  visibleQuestions, compileFlow, selectedCodes, conditionSummary,
} from "./index.js";

/**
 * COUNT CONDITIONS (§1–12).
 *
 * The design claim under test is that a count is a SOURCE and not an
 * operator — so the six comparison operators, AND/OR/NOT nesting, and every
 * consumer of `evaluateCondition` get it without changes. The last two tests
 * in this file are the ones that prove that claim rather than assuming it:
 * one drives a count through real display logic, another through option
 * masking.
 */

/* Q1: five brands, multi-select. Q2: the thing a count gates.
   Q3: a 5×5 grid. Q4: a numeric list with per-row validation. */
function survey(extra: Record<string, unknown> = {}) {
  return SurveyDefinition.parse({
    meta: { id: "s1", code: "S1", title: "Counts", version: "1.0" },
    questions: [
      {
        id: "q_brands", code: "Q1", variableName: "BRANDS", type: "multi_select",
        text: "Which do you use?",
        options: [
          { code: "A", label: "Apple" }, { code: "B", label: "Bosch" },
          { code: "C", label: "Candy" }, { code: "D", label: "Dell" },
          { code: "E", label: "Electrolux" },
        ],
      },
      { id: "q_next", code: "Q2", variableName: "NEXT", type: "text", text: "Why those?" },
      {
        id: "q_grid", code: "Q3", variableName: "GRID", type: "matrix_single",
        text: "Rate each",
        rows: [
          { code: "pa", label: "Product A" }, { code: "pb", label: "Product B" },
          { code: "pc", label: "Product C" }, { code: "pd", label: "Product D" },
          { code: "pe", label: "Product E" },
        ],
        options: [
          { code: "1", label: "Very poor" }, { code: "2", label: "Poor" },
          { code: "3", label: "Neutral" }, { code: "4", label: "Good" },
          { code: "5", label: "Very good" },
        ],
      },
      {
        id: "q_ages", code: "Q4", variableName: "AGES", type: "numeric_list",
        text: "Ages of each child",
        rows: [
          { code: "c1", label: "Child 1", validation: [{ kind: "max_value", value: 18 }] },
          { code: "c2", label: "Child 2", validation: [{ kind: "max_value", value: 18 }] },
          { code: "c3", label: "Child 3", validation: [{ kind: "max_value", value: 18 }] },
        ],
      },
      { id: "q_yes", code: "Q5", variableName: "YES", type: "single_select", text: "Continue?",
        options: [{ code: 1, label: "Yes" }, { code: 2, label: "No" }] },
    ],
    flow: [
      { type: "page", id: "p1", questionIds: ["q_brands", "q_yes"] },
      { type: "page", id: "p2", questionIds: ["q_next"] },
      { type: "page", id: "p3", questionIds: ["q_grid", "q_ages"] },
      { type: "end", id: "e1", status: "complete" },
    ],
    ...extra,
  });
}

const ctxWith = (answers: Record<string, unknown>, def = survey()) => {
  const state = createResponseState(def, { seed: 1 });
  for (const [k, v] of Object.entries(answers)) setAnswer(def, state, k, v);
  return { def, state, loop: null };
};

const count = (spec: Record<string, unknown>, answers: Record<string, unknown>, def = survey()) =>
  evaluateCount({ kind: "question", ref: spec.ref as string, count: spec.count as never } as never,
    ctxWith(answers, def) as never);

/* ------------------------------------------------------- multi-select counts */

test("COUNT SELECTED over a whole multi-select", () => {
  assert.equal(count({ ref: "q_brands", count: { of: "selected", scope: "options" } },
    { q_brands: ["A", "C"] }), 2);
  assert.equal(count({ ref: "q_brands", count: { of: "selected", scope: "options" } },
    { q_brands: [] }), 0);
  assert.equal(count({ ref: "q_brands", count: { of: "selected", scope: "options" } }, {}), 0);
});

test("every comparison operator works on a count, because a count is a source", () => {
  const at2 = { q_brands: ["A", "C"] };
  const c = (op: Parameters<typeof cond.count>[1], n: number) =>
    evaluateCondition(cond.count("q_brands", op, n), ctxWith(at2) as never);

  assert.equal(c("eq", 2), true, "= 2");
  assert.equal(c("eq", 3), false);
  assert.equal(c("ne", 3), true, "!= 3");
  assert.equal(c("ne", 2), false);
  assert.equal(c("gt", 1), true, "> 1");
  assert.equal(c("gt", 2), false);
  assert.equal(c("lt", 5), true, "< 5");
  assert.equal(c("lt", 2), false);
  assert.equal(c("gte", 2), true, ">= 2");
  assert.equal(c("gte", 3), false);
  assert.equal(c("lte", 4), true, "<= 4");
  assert.equal(c("lte", 1), false);
});

test("`between` came free too — nobody had to add it", () => {
  const r: Condition = {
    type: "rule",
    source: { kind: "question", ref: "q_brands", count: { of: "selected", scope: "options" } },
    operator: "between", value: 2, value2: 4,
  } as never;
  assert.equal(evaluateCondition(r, ctxWith({ q_brands: ["A", "C", "D"] }) as never), true);
  assert.equal(evaluateCondition(r, ctxWith({ q_brands: ["A"] }) as never), false);
  assert.equal(evaluateCondition(r, ctxWith({ q_brands: ["A", "B", "C", "D", "E"] }) as never), false);
});

test("EXACTLY N IS NOT AT LEAST N — both are available and they differ", () => {
  const three = ctxWith({ q_brands: ["A", "C", "E"] }) as never;
  assert.equal(evaluateCondition(cond.exactCount("q_brands", 2), three), false, "= 2 is false at three");
  assert.equal(evaluateCondition(cond.minCount("q_brands", 2), three), true, ">= 2 is true at three");
});

test("minCount and maxCount are the same mechanism with the operator filled in", () => {
  const two = ctxWith({ q_brands: ["A", "C"] }) as never;
  assert.equal(evaluateCondition(cond.minCount("q_brands", 2), two), true);
  assert.equal(evaluateCondition(cond.minCount("q_brands", 3), two), false);
  assert.equal(evaluateCondition(cond.maxCount("q_brands", 4), two), true);
  assert.equal(evaluateCondition(cond.maxCount("q_brands", 1), two), false);

  /* and the rule they build is indistinguishable from a hand-written one */
  assert.deepEqual(cond.minCount("q_brands", 2), cond.count("q_brands", "gte", 2));
});

test("COUNT NOT SELECTED counts the rest of the list", () => {
  assert.equal(count({ ref: "q_brands", count: { of: "notSelected", scope: "options" } },
    { q_brands: ["A", "C"] }), 3);
  assert.equal(count({ ref: "q_brands", count: { of: "notSelected", scope: "options" } },
    {}), 5, "an unanswered question has all five not selected");
});

/* --------------------------------------------------------------- subsets */

test("COUNT ONLY SPECIFIC OPTIONS — the A/C/E case from the brief", () => {
  const spec = { of: "selected", scope: "options", only: ["A", "C", "E"] };
  assert.equal(count({ ref: "q_brands", count: spec }, { q_brands: ["A", "C"] }), 2, "A + C passes");
  assert.equal(count({ ref: "q_brands", count: spec }, { q_brands: ["A"] }), 1, "A alone fails >= 2");
  assert.equal(count({ ref: "q_brands", count: spec }, { q_brands: ["B", "D"] }), 0,
    "options outside the subset are not counted at all");
  assert.equal(count({ ref: "q_brands", count: spec }, { q_brands: ["A", "B", "C", "D"] }), 2,
    "and B and D do not inflate it");
});

test("two subset counts combine with OR, each counting its own list", () => {
  const rule = cond.or(
    cond.count("q_brands", "gte", 2, { only: ["A", "C", "E"] }),
    cond.count("q_brands", "gte", 1, { only: ["B", "D"] }),
  );
  assert.equal(evaluateCondition(rule, ctxWith({ q_brands: ["A", "C"] }) as never), true, "left arm");
  assert.equal(evaluateCondition(rule, ctxWith({ q_brands: ["B"] }) as never), true, "right arm");
  assert.equal(evaluateCondition(rule, ctxWith({ q_brands: ["A"] }) as never), false, "neither");
});

test("a count nests inside AND / OR / NOT with ordinary rules", () => {
  const rule = cond.and(
    cond.count("q_brands", "gte", 2),
    cond.rule("q_yes", "eq", 1),
  );
  assert.equal(evaluateCondition(rule, ctxWith({ q_brands: ["A", "C"], q_yes: 1 }) as never), true);
  assert.equal(evaluateCondition(rule, ctxWith({ q_brands: ["A", "C"], q_yes: 2 }) as never), false);
  assert.equal(evaluateCondition(rule, ctxWith({ q_brands: ["A"], q_yes: 1 }) as never), false);

  const notMany = cond.not(cond.count("q_brands", "gte", 3));
  assert.equal(evaluateCondition(notMany, ctxWith({ q_brands: ["A", "C"] }) as never), true);
  assert.equal(evaluateCondition(notMany, ctxWith({ q_brands: ["A", "C", "E"] }) as never), false);
});

/* ------------------------------------------------------------ grid counts */

test("COUNT GRID ROWS BY RESPONSE — rated Very good", () => {
  const answers = { q_grid: { pa: "5", pb: "4", pc: "5", pd: "2", pe: "3" } };
  assert.equal(count({ ref: "q_grid", count: { of: "matching", scope: "rows", responseIn: ["5"] } },
    answers), 2, "two rows rated 5");
  assert.equal(count({ ref: "q_grid", count: { of: "matching", scope: "rows", responseIn: ["4", "5"] } },
    answers), 3, "three rated 4 or 5");
  assert.equal(count({ ref: "q_grid", count: { of: "matching", scope: "rows", responseIn: ["1"] } },
    answers), 0);
});

test("COUNT SPECIFIC GRID ROWS — only Products A, C and E", () => {
  const answers = { q_grid: { pa: "5", pb: "5", pc: "4", pd: "5", pe: "2" } };
  assert.equal(
    count({ ref: "q_grid", count: { of: "matching", scope: "rows", only: ["pa", "pc", "pe"], responseIn: ["4", "5"] } },
      answers),
    2, "A (5) and C (4) qualify; E (2) does not, and B and D are not counted");
});

test("a multi-response grid row matches when it holds ANY of the wanted responses", () => {
  const answers = { q_grid: { pa: ["3", "5"], pb: ["1"], pc: ["4"] } };
  assert.equal(count({ ref: "q_grid", count: { of: "matching", scope: "rows", responseIn: ["4", "5"] } },
    answers), 2, "pa via 5, pc via 4");
});

test("a grid row is 'selected' when it holds any answer", () => {
  const answers = { q_grid: { pa: "5", pc: "3" } };
  assert.equal(count({ ref: "q_grid", count: { of: "selected", scope: "rows" } }, answers), 2);
  assert.equal(count({ ref: "q_grid", count: { of: "notSelected", scope: "rows" } }, answers), 3,
    "the three unanswered rows");
});

/* --------------------------------------------- carry-forward matrix counts */

/*
 * A matrix whose ROWS are carried forward from Q1's selection — the exact
 * family of bug this file's COUNT fixes address. Before the fix, `pool()`
 * read the static `q_cf_grid.rows` array, which is empty by construction for
 * a carry-forward question (its rows only exist as a runtime computation),
 * so every COUNT / ANY / ALL / NONE against it silently evaluated to 0.
 */
function cfGridSurvey() {
  return SurveyDefinition.parse({
    meta: { id: "s2", code: "S2", title: "Carry-forward counts", version: "1.0" },
    questions: [
      {
        id: "q_brands", code: "Q1", variableName: "BRANDS", type: "multi_select",
        text: "Which do you use?",
        options: [
          { code: "A", label: "Apple" }, { code: "B", label: "Bosch" }, { code: "C", label: "Candy" },
        ],
      },
      {
        id: "q_cf_grid", code: "Q2", variableName: "CFGRID", type: "composite",
        text: "Tell us about each",
        carryForward: { sourceQuestionId: "q_brands", filter: "selected", into: "rows" },
        columns: [
          { id: "c_rating", label: "Rating", responseType: "numeric", variableStem: "RATING" },
          {
            id: "c_rec", label: "Recommend?", responseType: "single", variableStem: "REC",
            options: [{ code: 1, label: "Yes" }, { code: 0, label: "No" }],
          },
        ],
      },
    ],
    flow: [
      { type: "page", id: "p1", questionIds: ["q_brands"] },
      { type: "page", id: "p2", questionIds: ["q_cf_grid"] },
      { type: "end", id: "e1", status: "complete" },
    ],
  });
}

test("COUNT over a carry-forward matrix's rows — was silently 0, now counts the carried rows", () => {
  const def = cfGridSurvey();
  const answers = {
    q_brands: ["A", "B"],
    q_cf_grid: { A: { c_rating: 8, c_rec: 1 }, B: { c_rating: 3, c_rec: 0 } },
  };
  assert.equal(count({ ref: "q_cf_grid", count: { of: "selected", scope: "rows" } }, answers, def), 2,
    "both carried rows (Apple, Bosch) hold an answer");
  assert.equal(count({ ref: "q_cf_grid", count: { of: "notSelected", scope: "rows" } }, answers, def), 0,
    "no carried row is left unanswered");
});

test("COUNT MATCHING with columnId reads one named column of a carry-forward matrix cell", () => {
  const def = cfGridSurvey();
  const answers = {
    q_brands: ["A", "B", "C"],
    q_cf_grid: { A: { c_rating: 8, c_rec: 1 }, B: { c_rating: 3, c_rec: 0 }, C: { c_rating: 9, c_rec: 1 } },
  };
  const spec = {
    of: "matching", scope: "rows",
    where: {
      type: "rule",
      source: { kind: "option", ref: "value", columnId: "c_rec" },
      operator: "eq", value: 1,
    },
  };
  assert.equal(count({ ref: "q_cf_grid", count: spec }, answers, def), 2,
    "Apple and Candy were recommended (c_rec = 1); Bosch was not — a real multi-column matrix, not a single-response grid");
});

test("lintCount says nothing false about a carry-forward scope's unknowable design-time size", () => {
  const def = cfGridSurvey();
  // no answers yet: the static rows array is legitimately empty for a
  // carry-forward question — that must not read as "has no rows to count"
  const problems = lintCount(def,
    { kind: "question", ref: "q_cf_grid", count: { of: "selected", scope: "rows" } } as never, "gte", 2);
  assert.deepEqual(problems, [], `expected no false warnings, got: ${problems.join(" | ")}`);

  // an unrelated, real problem on the SAME carry-forward question still surfaces
  const groupProblems = lintCount(def,
    { kind: "question", ref: "q_cf_grid", count: { of: "selected", scope: "rows", group: "nope" } } as never,
    "gte", 1);
  assert.ok(groupProblems.some((p) => /does not have/.test(p)), groupProblems.join(" | "));
});

test("COUNT COLUMNS counts columns that were used, across every row", () => {
  const def = SurveyDefinition.parse({
    meta: { id: "s2", code: "S2", title: "Composite", version: "1.0" },
    questions: [{
      id: "q_tab", code: "Q1", variableName: "TAB", type: "composite", text: "Fill in",
      rows: [{ code: "r1", label: "Row 1" }, { code: "r2", label: "Row 2" }],
      columns: [
        { id: "cA", label: "Brand", responseType: "text", variableStem: "BRAND" },
        { id: "cB", label: "Spend", responseType: "numeric", variableStem: "SPEND" },
        { id: "cC", label: "Note", responseType: "text", variableStem: "NOTE" },
      ],
    }],
    flow: [{ type: "page", id: "p1", questionIds: ["q_tab"] }, { type: "end", id: "e", status: "complete" }],
  });
  const answers = { q_tab: { r1: { cA: "Acme", cB: 10 }, r2: { cA: "Bosch" } } };
  assert.equal(count({ ref: "q_tab", count: { of: "selected", scope: "columns" } }, answers, def), 2,
    "Brand and Spend were used; Note was not");
  assert.equal(count({ ref: "q_tab", count: { of: "notSelected", scope: "columns" } }, answers, def), 1);
});

/* -------------------------------------------------- valid / invalid counts */

test("COUNT INVALID means failing this item's own validation", () => {
  /* ages capped at 18 — two entries break it */
  const answers = { q_ages: { c1: 7, c2: 25, c3: 40 } };
  assert.equal(count({ ref: "q_ages", count: { of: "invalid", scope: "rows" } }, answers), 2);
  assert.equal(count({ ref: "q_ages", count: { of: "valid", scope: "rows" } }, answers), 1);
});

test("AN UNANSWERED ITEM IS NEITHER VALID NOR INVALID — it is missing", () => {
  const answers = { q_ages: { c1: 7 } };
  assert.equal(count({ ref: "q_ages", count: { of: "valid", scope: "rows" } }, answers), 1);
  assert.equal(count({ ref: "q_ages", count: { of: "invalid", scope: "rows" } }, answers), 0,
    "the two blanks are not invalid");
  assert.equal(count({ ref: "q_ages", count: { of: "notSelected", scope: "rows" } }, answers), 2,
    "…they are counted by notSelected, which is the question being asked");
});

test("an option carries no validation, so valid == selected and invalid is 0", () => {
  const answers = { q_brands: ["A", "C"] };
  assert.equal(count({ ref: "q_brands", count: { of: "valid", scope: "options" } }, answers), 2);
  assert.equal(count({ ref: "q_brands", count: { of: "invalid", scope: "options" } }, answers), 0);
  /* and the lint says so out loud rather than leaving a rule that never fires */
  const problems = lintCount(survey(),
    { kind: "question", ref: "q_brands", count: { of: "invalid", scope: "options" } } as never, "gte", 1);
  assert.ok(problems.some((p) => /always 0/.test(p)), problems.join(" | "));
});

/* --------------------------------------------- eligible / visible / hidden */

test("COUNT VISIBLE and HIDDEN read the pipeline, not the raw list", () => {
  /* B is only shown when Q5 = Yes */
  const def = SurveyDefinition.parse({
    ...JSON.parse(JSON.stringify(survey())),
    questions: JSON.parse(JSON.stringify(survey())).questions.map((q: { id: string; options?: unknown[] }) =>
      q.id !== "q_brands" ? q : {
        ...q,
        options: (q.options as { code: string }[]).map((o) =>
          o.code === "B" ? { ...o, visibleIf: cond.rule("q_yes", "eq", 1) } : o),
      }),
  });
  assert.equal(count({ ref: "q_brands", count: { of: "visible", scope: "options" } }, { q_yes: 1 }, def), 5);
  assert.equal(count({ ref: "q_brands", count: { of: "visible", scope: "options" } }, { q_yes: 2 }, def), 4);
  assert.equal(count({ ref: "q_brands", count: { of: "hidden", scope: "options" } }, { q_yes: 2 }, def), 1);
  assert.equal(count({ ref: "q_brands", count: { of: "eligible", scope: "options" } }, { q_yes: 2 }, def), 4,
    "eligible reads the same pipeline");
});

/* -------------------------------------------------------- count matching */

test("COUNT MATCHING CONDITION evaluates a predicate per item", () => {
  /* count the selected brands whose own code is in a shortlist */
  const spec = {
    of: "matching", scope: "options",
    where: cond.and(
      cond.rule("q_brands", "selected", { $option: "code" }),
      { type: "rule", source: { kind: "option", ref: "code" }, operator: "in", value: ["A", "B", "C"] },
    ),
  };
  assert.equal(count({ ref: "q_brands", count: spec }, { q_brands: ["A", "C", "E"] }), 2,
    "A and C match; E is selected but outside the shortlist");
});

test("a matching count with nothing to match on counts 0 and is linted", () => {
  assert.equal(count({ ref: "q_brands", count: { of: "matching", scope: "options" } },
    { q_brands: ["A", "C"] }), 0);
  const problems = lintCount(survey(),
    { kind: "question", ref: "q_brands", count: { of: "matching", scope: "options" } } as never, "gte", 1);
  assert.ok(problems.some((p) => /matches nothing/.test(p)), problems.join(" | "));
});

/* ------------------------------------------------------ answer shapes */

test("selectedCodes normalises every collection answer the platform stores", () => {
  assert.deepEqual(selectedCodes(["a", "c"]), ["a", "c"], "multi");
  assert.deepEqual(selectedCodes("a"), ["a"], "a scalar is one selection");
  assert.deepEqual(selectedCodes(["c", "a", "b"]), ["c", "a", "b"], "ranking keeps its order");
  assert.deepEqual(selectedCodes([]), []);
  assert.deepEqual(selectedCodes(null), []);
  assert.deepEqual(selectedCodes(undefined), []);
  assert.deepEqual(selectedCodes(""), []);
});

test("AN ALLOCATION OF ZERO IS NOT A SELECTION", () => {
  /*
   * A respondent who typed 0 against an option has considered it and given it
   * nothing — the opposite of choosing it. Counting it would report five
   * brands chosen on a grid where four were left at zero.
   */
  assert.deepEqual(selectedCodes({ a: 30, b: 0, c: 70 }).sort(), ["a", "c"]);
  assert.deepEqual(selectedCodes({ a: 0, b: 0 }), []);
});

/* --------------------------------------------------- a missing question */

test("A COUNT OF A DELETED QUESTION FAILS ITS RULE — it does not count 0", () => {
  /*
   * The distinction that matters: if the count were 0, `<= 5` would be
   * satisfied and the question would silently show to everybody. Returning
   * null makes every comparison fail, so a broken rule shows itself.
   */
  assert.equal(count({ ref: "q_gone", count: { of: "selected", scope: "options" } }, {}), null);
  assert.equal(evaluateCondition(cond.count("q_gone", "lte", 5), ctxWith({}) as never), false,
    "<= 5 does NOT pass against a question that is not there");
  assert.equal(evaluateCondition(cond.count("q_gone", "gte", 1), ctxWith({}) as never), false);
});

/* ----------------------------------------------------------------- lint */

test("the lint catches a count that can never be satisfied", () => {
  const problems = lintCount(survey(),
    { kind: "question", ref: "q_brands", count: { of: "selected", scope: "options" } } as never, "gte", 7);
  assert.ok(problems.some((p) => /never reach 7/.test(p)), problems.join(" | "));
  assert.ok(problems.some((p) => /only 5 options/.test(p)), problems.join(" | "));

  /* and against a subset, the ceiling is the subset */
  const sub = lintCount(survey(),
    { kind: "question", ref: "q_brands", count: { of: "selected", scope: "options", only: ["A", "C"] } } as never,
    "gte", 3);
  assert.ok(sub.some((p) => /never reach 3/.test(p)), sub.join(" | "));

  assert.deepEqual(
    lintCount(survey(),
      { kind: "question", ref: "q_brands", count: { of: "selected", scope: "options" } } as never, "gte", 2),
    [], "a satisfiable count is silent");
});

test("the lint catches options and rows that have since been deleted", () => {
  const problems = lintCount(survey(),
    { kind: "question", ref: "q_brands", count: { of: "selected", scope: "options", only: ["A", "Z"] } } as never,
    "gte", 1);
  assert.ok(problems.some((p) => /no longer exist: Z/.test(p)), problems.join(" | "));
});

/* ========================================== the claim, actually exercised */

test("A COUNT DRIVES REAL DISPLAY LOGIC — nothing in flow.ts knows counts exist", () => {
  const def = survey({
    displayRules: [{
      id: "dr1", target: { kind: "question", ref: "q_next" }, action: "show",
      when: cond.minCount("q_brands", 2),
    }],
  });

  const shown = (brands: string[]) => {
    const state = createResponseState(def, { seed: 1 });
    setAnswer(def, state, "q_brands", brands);
    const steps = compileFlow(def, state);
    /* the page Q2 lives on, as the runtime compiles it */
    const page = steps.find(
      (st) => st.kind === "page" && st.questionIds.includes("q_next"),
    ) as Extract<typeof steps[number], { kind: "page" }> | undefined;
    if (!page) return [];
    return visibleQuestions(def, page, state).map((q) => q.id);
  };

  assert.deepEqual(shown(["A", "C"]), ["q_next"], "two selected shows Q2");
  assert.deepEqual(shown(["A"]), [], "one selected hides it");
  assert.deepEqual(shown([]), [], "none selected hides it");
});

test("A COUNT DRIVES OPTION MASKING — the same engine, a different caller", () => {
  /*
   * Every option of Q1 is hidden unless the grid has three rows rated 4 or 5.
   * Masking never learned about counts; it calls `evaluateCondition`, and that
   * is the entire integration.
   */
  const def = survey({});
  const raw = JSON.parse(JSON.stringify(def));
  raw.questions = raw.questions.map((q: { id: string }) =>
    q.id !== "q_brands" ? q : {
      ...q,
      /*
       * Display only A and B — but only while the grid has at least three
       * rows rated 4 or 5. Below that the mask does not apply and the whole
       * list is shown, so the count is what decides the respondent's options.
       */
      mask: {
        expr: { kind: "codes", codes: ["A", "B"] },
        action: "display",
        keepAlwaysShow: false,
        when: {
          type: "rule",
          source: { kind: "question", ref: "q_grid", count: { of: "matching", scope: "rows", responseIn: ["4", "5"] } },
          operator: "gte", value: 3,
        } as never,
      },
    });
  const masked = SurveyDefinition.parse(raw);

  const visible = (grid: Record<string, string>) =>
    count({ ref: "q_brands", count: { of: "visible", scope: "options" } }, { q_grid: grid }, masked);

  assert.equal(visible({ pa: "5", pb: "4", pc: "5" }), 2,
    "three good ratings — the mask applies and narrows the list to A and B");
  assert.equal(visible({ pa: "5", pb: "2" }), 5,
    "one good rating — the mask's `when` is false, so the full list stands");
});

/* ------------------------------------------------------------- summaries */

test("A COUNT RULE READS AS THE NUMBER IT IS, not as the question it counts", () => {
  /*
   * "Q1 >= 2" in a collapsed rule list would be a lie about what is being
   * compared — the left-hand side is a count, and the summary has to say so
   * or a programmer reviewing somebody else's logic reads it wrong.
   */
  const def = survey();
  assert.equal(
    conditionSummary(def, cond.minCount("q_brands", 2)),
    "count of selected Q1 options is at least \u201c2\u201d",
  );
  assert.equal(
    conditionSummary(def, cond.count("q_brands", "eq", 2, { only: ["A", "C", "E"] })),
    "count of selected 3 of Q1's options is \u201c2\u201d",
  );
  assert.equal(
    conditionSummary(def, cond.count("q_grid", "gte", 3,
      { of: "matching", scope: "rows", responseIn: ["4", "5"] })),
    "count of matching Q3 rows answering Good or Very good is at least \u201c3\u201d",
  );
  assert.equal(
    conditionSummary(def, cond.count("q_brands", "lte", 1, { of: "notSelected" })),
    "count of not selected Q1 options is at most \u201c1\u201d",
  );
});

test("a count inside a group summarises with the group", () => {
  const def = survey();
  const s = conditionSummary(def, cond.and(
    cond.minCount("q_brands", 2),
    cond.rule("q_yes", "eq", 1),
  ));
  assert.match(s, /count of selected Q1 options is at least/);
  assert.match(s, / AND /);
});

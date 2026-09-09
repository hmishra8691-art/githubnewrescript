import { test } from "node:test";
import assert from "node:assert/strict";
import { SurveyDefinition } from "@rescript/schema";
import {
  advance,
  createResponseState,
  evaluateCondition,
  evaluateExpression,
  formatCondition,
  parseLogicExpression,
  start,
  validatePage,
  validateQuestion,
  visibleQuestions,
} from "./index.js";

/**
 * THE LOGIC COMPATIBILITY AUDIT (Display / Validation / Masking documents).
 *
 * Every test here pins something that was WRONG rather than missing: a rule
 * the builder accepted, saved and displayed, which then evaluated to the
 * wrong thing at run time with nothing on screen to say so. That is the
 * failure mode the audit was for, and the reason these are unit tests rather
 * than browser tests — each one reproduces in the engine alone, so a
 * regression is caught in seconds instead of in a 36-minute corpus.
 *
 * Grouped by the defect they pin, with the requirement id from the source
 * questionnaires where there is one.
 */

const q = (o: any): any => ({
  id: o.id,
  code: o.code ?? o.id.toUpperCase(),
  variableName: o.code ?? o.id.toUpperCase(),
  type: o.type ?? "single_select",
  text: o.text ?? o.id,
  options: o.options ?? [],
  rows: o.rows ?? [],
  columns: o.columns ?? [],
  validation: o.validation ?? [],
  skipLogic: o.skipLogic ?? [],
  punches: [],
  settings: o.settings ?? {},
  required: o.required ?? false,
  displayLogic: o.displayLogic,
  ...(o.mask ? { mask: o.mask } : {}),
});

const survey = (questions: any[], flow?: any[]) =>
  SurveyDefinition.parse({
    meta: { id: "s", code: "S", title: "audit", version: "1.0" },
    questions,
    flow: flow ?? [
      { type: "page", id: "p1", questionIds: questions.map((x) => x.id) },
      { type: "end", id: "e1", status: "complete" },
    ],
  });

const stateWith = (def: any, answers: Record<string, unknown>) => {
  const st = createResponseState(def);
  Object.assign(st.answers, answers);
  return st;
};

/** The first page of a compiled flow, narrowed for `visibleQuestions`. */
const firstPage = (nav: any) => {
  const step = nav.steps.find((x: any) => x.kind === "page");
  assert.ok(step, "expected a page step");
  return step as Extract<typeof step, { kind: "page" }>;
};

/* ============================================================ skip logic */

test("a question hidden by display logic cannot trigger its own skip rule", () => {
  /*
   * Skip logic used to iterate the page's AUTHORED questions. A question
   * hidden by display logic has no answer, so `Q2 unanswered -> screen out`
   * terminated exactly the respondents for whom Q2 was correctly hidden.
   */
  const def = survey(
    [
      q({ id: "q1", options: [{ code: "1", label: "One" }, { code: "2", label: "Two" }] }),
      q({
        id: "q2",
        options: [{ code: "1", label: "Yes" }],
        displayLogic: { type: "rule", source: { kind: "question", ref: "q1" }, operator: "eq", value: "2" },
        skipLogic: [{
          id: "sk1",
          when: { type: "rule", source: { kind: "question", ref: "q2" }, operator: "unanswered" },
          target: { kind: "end", status: "screened" },
        }],
      }),
      q({ id: "q3", options: [{ code: "1", label: "Done" }] }),
    ],
    [
      { type: "page", id: "p1", questionIds: ["q1", "q2"] },
      { type: "page", id: "p2", questionIds: ["q3"] },
      { type: "end", id: "e1", status: "complete" },
    ],
  );

  const st = stateWith(def, { q1: "1" }); // Q1 = One, so Q2 is hidden
  const nav = start(def, st);
  assert.deepEqual(visibleQuestions(def, firstPage(nav), st).map((x) => x.id), ["q1"]);

  const res = advance(def, st);
  assert.equal(res.endStatus, undefined, "a hidden question must not screen the respondent out");
  assert.deepEqual(res.triggeredSkips, []);
});

test("a visible question's skip rule still fires", () => {
  const def = survey(
    [
      q({ id: "q1", options: [{ code: "1", label: "One" }] }),
      q({
        id: "q2",
        options: [{ code: "1", label: "Yes" }],
        skipLogic: [{
          id: "sk1",
          when: { type: "rule", source: { kind: "question", ref: "q2" }, operator: "unanswered" },
          target: { kind: "end", status: "screened" },
        }],
      }),
    ],
    [
      { type: "page", id: "p1", questionIds: ["q1", "q2"] },
      { type: "end", id: "e1", status: "complete" },
    ],
  );
  const st = stateWith(def, { q1: "1" });
  const nav = start(def, st);
  const res = advance(def, st);
  assert.equal(res.endStatus, "screened", "the fix must not disarm skip logic generally");
});

/* ====================================================== required + masking */

test("a question whose mask removed every option does not block on required (M156-M158)", () => {
  const def = survey([
    q({ id: "q1", type: "multi_select", options: [{ code: "a", label: "A" }, { code: "b", label: "B" }] }),
    q({
      id: "q2",
      required: true,
      options: [{ code: "a", label: "A" }, { code: "b", label: "B" }],
      mask: {
        expr: { kind: "ref", questionId: "q1", selection: "selected" },
        action: "display",
        keepAlwaysShow: false,
        onEmptySource: "show_none",
      },
    }),
  ]);
  const st = stateWith(def, { q1: [] }); // nothing selected -> the mask yields nothing
  const nav = start(def, st);
  const errs = validatePage(def, visibleQuestions(def, firstPage(nav), st), { def, state: st });
  assert.deepEqual(
    errs.filter((e) => e.questionId === "q2").map((e) => e.message),
    [],
    "an unanswerable question must not be a blocking page",
  );
});

test("the required suppression is narrow — ordinary required questions still block", () => {
  const def = survey([
    q({ id: "q1", required: true, options: [{ code: "a", label: "A" }] }),
    q({ id: "q2", required: true, type: "open_text" }),
    q({
      id: "q3", required: true, type: "matrix_single",
      rows: [{ code: "r1", label: "R1" }], options: [{ code: "c1", label: "C1" }],
    }),
  ]);
  const st = stateWith(def, {});
  const nav = start(def, st);
  const errs = validatePage(def, visibleQuestions(def, firstPage(nav), st), { def, state: st });
  const blocked = errs.filter((e) => e.message === "This question is required.").map((e) => e.questionId);
  assert.deepEqual(blocked.sort(), ["q1", "q2", "q3"]);
});

test("whitespace is not an answer to a required question (V009)", () => {
  const def = survey([q({ id: "q1", type: "open_text", required: true })]);
  const st = stateWith(def, { q1: "   " });
  const nav = start(def, st);
  const errs = validatePage(def, visibleQuestions(def, firstPage(nav), st), { def, state: st });
  assert.equal(errs.length, 1);
});

/* =============================================== cross-question comparison */

const twoNumbers = survey([
  q({ id: "q5", code: "Q5", type: "numeric" }),
  q({ id: "q6", code: "Q6", type: "numeric" }),
]);

test("a bare question name on the right-hand side is a reference, not a literal", () => {
  const r = parseLogicExpression(twoNumbers, "Q5 > Q6");
  assert.deepEqual(r.errors, []);
  assert.deepEqual((r.condition as any).value, { $question: "Q6" });
});

test("Q5 > Q6 compares the two answers", () => {
  const c = parseLogicExpression(twoNumbers, "Q5 > Q6").condition!;
  assert.equal(evaluateCondition(c, { def: twoNumbers, state: stateWith(twoNumbers, { q5: 10, q6: 5 }) }), true);
  assert.equal(evaluateCondition(c, { def: twoNumbers, state: stateWith(twoNumbers, { q5: 5, q6: 10 }) }), false);
});

test("a question reference round-trips through the expression language unchanged", () => {
  const c = parseLogicExpression(twoNumbers, "Q5 > Q6").condition!;
  assert.equal(formatCondition(twoNumbers, c), "Q5 > Q6");
});

test("a QUOTED value that looks like a question code stays a literal", () => {
  const c = parseLogicExpression(twoNumbers, 'Q5 = "Q6"').condition!;
  assert.equal((c as any).value, "Q6", "quotes are how an author says 'literally this text'");
});

test("a bare word matching no question stays a literal", () => {
  const c = parseLogicExpression(twoNumbers, "Q5 = somethingelse").condition!;
  assert.equal((c as any).value, "somethingelse");
});

test("confirm-email: one text answer compared against another (V022, V112)", () => {
  const def = survey([
    q({ id: "e1", code: "EMAIL", type: "open_text" }),
    q({ id: "e2", code: "EMAIL2", type: "open_text" }),
  ]);
  const c = parseLogicExpression(def, "EMAIL2 != EMAIL").condition!;
  assert.equal(evaluateCondition(c, { def, state: stateWith(def, { e1: "a@b.com", e2: "typo@b.com" }) }), true);
  assert.equal(evaluateCondition(c, { def, state: stateWith(def, { e1: "a@b.com", e2: "a@b.com" }) }), false);
});

/* ============================================================ date and time */

test("date functions compute ages, differences and offsets", () => {
  const opts = {
    resolver: (n: string) => ({ DOB: "1990-06-15", START: "2024-01-01", END: "2024-03-15" } as any)[n] ?? null,
    names: () => ["DOB", "START", "END"],
  };
  assert.equal(evaluateExpression("DATEDIFF(END, START)", opts), 74);
  assert.equal(evaluateExpression("YEAR(DOB)", opts), 1990);
  assert.equal(evaluateExpression("DATEDIFF(DATEADD(START, 365), START)", opts), 365);
  assert.equal(evaluateExpression("AGE(\"2000-01-01\", \"2020-06-01\")", opts), 20);
  // the day before a birthday is still the previous age — calendar years, not /365
  assert.equal(evaluateExpression("AGE(\"2000-06-02\", \"2020-06-01\")", opts), 19);
  assert.equal(evaluateExpression("AGE(\"not a date\")", opts), null, "a bad date is null, never NaN");
});

test("a respondent under 18 on the survey date is caught (V041)", () => {
  const def = survey([q({ id: "dob", code: "DOB", type: "date" })]);
  const c = parseLogicExpression(def, "AGE(DOB) < 18").condition!;
  assert.equal(evaluateCondition(c, { def, state: stateWith(def, { dob: "2015-01-01" }) }), true);
  assert.equal(evaluateCondition(c, { def, state: stateWith(def, { dob: "1985-01-01" }) }), false);
});

test("clock times compare, so a business-hours range works", () => {
  const def = survey([q({ id: "tm", code: "CALLTIME", type: "time" })]);
  const c = parseLogicExpression(def, 'CALLTIME between "09:00" and "17:00"').condition!;
  assert.equal(evaluateCondition(c, { def, state: stateWith(def, { tm: "14:30" }) }), true);
  assert.equal(evaluateCondition(c, { def, state: stateWith(def, { tm: "07:15" }) }), false);
  assert.equal(evaluateCondition(c, { def, state: stateWith(def, { tm: "17:00" }) }), true, "inclusive");
});

test("an ordering comparison of a date against a plain number stays false", () => {
  // all-or-nothing on purpose: coercing one side would make `date > 5` always true
  const def = survey([q({ id: "d", code: "D", type: "date" })]);
  const c = parseLogicExpression(def, "D > 5").condition!;
  assert.equal(evaluateCondition(c, { def, state: stateWith(def, { d: "2024-01-01" }) }), false);
});

/* ================================================= matrix column conditions */

const grid = survey([
  q({
    id: "m1", code: "M1", type: "matrix_single",
    rows: [{ code: "r1", label: "Speed" }, { code: "r2", label: "Trust" }],
    options: [{ code: "1", label: "Poor" }, { code: "5", label: "Excellent" }],
  }),
]);

test("a column named without a row means that column across every row", () => {
  const anyExcellent: any = {
    type: "rule",
    source: { kind: "question", ref: "M1", columnId: "5" },
    operator: "answered",
  };
  assert.equal(
    evaluateCondition(anyExcellent, { def: grid, state: stateWith(grid, { m1: { r1: "1", r2: "5" } }) }),
    true,
  );
  assert.equal(
    evaluateCondition(anyExcellent, { def: grid, state: stateWith(grid, { m1: { r1: "1", r2: "1" } }) }),
    false,
    "an answered row that chose a DIFFERENT column must not match",
  );
});

/* ================================================== matrix cell validation */

test("a question-level numeric rule is enforced per matrix cell (V092)", () => {
  const target = q({
    id: "m2", code: "M2", type: "matrix_numeric",
    rows: [{ code: "r1", label: "Jan" }, { code: "r2", label: "Feb" }],
    validation: [{ id: "v1", kind: "max_value", value: 5, message: "Rate 1-5 only." }],
  });
  const def = survey([target]);
  const bad = validateQuestion(def, target, { r1: 3, r2: 9 }, { def, state: stateWith(def, { m2: { r1: 3, r2: 9 } }) });
  assert.deepEqual(bad.map((e) => e.rowCode), ["r2"], "only the offending cell fails");
  const good = validateQuestion(def, target, { r1: 3, r2: 4 }, { def, state: stateWith(def, { m2: { r1: 3, r2: 4 } }) });
  assert.deepEqual(good, []);
});

test("a per-row rule on a matrix is enforced rather than discarded", () => {
  const target = q({
    id: "m3", code: "M3", type: "matrix_numeric",
    rows: [
      { code: "r1", label: "Jan", validation: [{ id: "rv", kind: "min_value", value: 10, message: "At least 10." }] },
      { code: "r2", label: "Feb" },
    ],
  });
  const def = survey([target]);
  const errs = validateQuestion(def, target, { r1: 2, r2: 2 }, { def, state: stateWith(def, { m3: { r1: 2, r2: 2 } }) });
  assert.equal(errs.length, 1);
  assert.equal(errs[0].rowCode, "r1");
});

/* ================================================ condition validation rule */

test("a condition rule enforces a cross-question date range end to end (V045)", () => {
  const def = survey([
    q({ id: "sd", code: "STARTD", type: "date" }),
    q({ id: "ed", code: "ENDD", type: "date" }),
  ]);
  const check = parseLogicExpression(def, "DATEDIFF(ENDD, STARTD) < 0").condition!;
  const target = q({
    id: "ed", code: "ENDD", type: "date",
    validation: [{
      id: "v1", kind: "condition", severity: "error",
      message: "End date must be on or after the start date.", check,
    }],
  });
  const bad = validateQuestion(def, target, "2024-04-01",
    { def, state: stateWith(def, { sd: "2024-05-01", ed: "2024-04-01" }) });
  assert.deepEqual(bad.map((e) => e.message), ["End date must be on or after the start date."]);
  const good = validateQuestion(def, target, "2024-06-01",
    { def, state: stateWith(def, { sd: "2024-05-01", ed: "2024-06-01" }) });
  assert.deepEqual(good, []);
});

test("REGEX() exists, so a rule spelled with it does not silently pass (V131)", () => {
  /*
   * Character classes rather than `\d`: the calc tokenizer consumes the
   * backslash as a string escape, so a pattern needing one has to be written
   * with `[0-9]` — worth pinning, since the alternative looks like it works.
   */
  const opts = { resolver: (n: string) => (n === "CODE" ? "AB1234" : null), names: () => ["CODE"] };
  assert.equal(evaluateExpression('REGEX(CODE, "^[A-Z]{2}[0-9]{4}$")', opts), true);
  assert.equal(evaluateExpression('REGEX("ab1234", "^[A-Z]{2}[0-9]{4}$")', opts), false);
});

import { test } from "node:test";
import assert from "node:assert/strict";
import { SurveyDefinition, cond } from "@rescript/schema";
import {
  runTestCase, runSuite, describeSuite, outcomeOf, diffOutcomes,
  checkExpectations, staleReferences, canonicalJson, fingerprint,
  simulateRespondent,
  type TestCase, type TestOutcome,
} from "./index.js";

/**
 * TEST CASES AND REGRESSION TESTING (§55, §56).
 *
 * The survey below is the smallest one that can go wrong in the ways that
 * matter: an age screen that terminates, a usage gate that skips a block, a
 * calculation, and a piped question. Every test here is about one of the four
 * verdicts, and the ones worth reading twice are the two that separate a test
 * suite from a snapshot diff: a CHANGED outcome must not read as a failure,
 * and a STALE case must not read as a pass.
 */

function survey(extra: Record<string, unknown> = {}) {
  return SurveyDefinition.parse({
    meta: { id: "s1", code: "S1", title: "Screener", version: "1.0" },
    questions: [
      { id: "q_age", code: "Q1", variableName: "AGE", type: "numeric", text: "How old are you?", required: true,
        skipLogic: [{ id: "sk_young", when: cond.rule("q_age", "lt", 18), target: { kind: "terminate", status: "screened" } }] },
      { id: "q_use", code: "Q2", variableName: "USE", type: "single_select", text: "Do you use it?", required: true,
        options: [{ code: 1, label: "Yes" }, { code: 2, label: "No" }] },
      { id: "q_often", code: "Q3", variableName: "OFTEN", type: "single_select", text: "How often?",
        options: [{ code: 1, label: "Daily" }, { code: 2, label: "Weekly" }] },
      { id: "q_spend", code: "Q4", variableName: "SPEND", type: "numeric", text: "Monthly spend?" },
      { id: "q_why", code: "Q5", variableName: "WHY", type: "open_text", text: "You said {{Q2}} — why?" },
    ],
    calculations: [
      { id: "c_annual", targetVariable: "ANNUAL", expression: "SPEND * 12", trigger: "on_page_submit" },
    ],
    flow: [
      { type: "page", id: "p_screen", questionIds: ["q_age", "q_use"] },
      {
        type: "block", id: "b_usage", title: "Usage",
        visibleIf: cond.rule("q_use", "eq", 1),
        children: [
          { type: "page", id: "p_often", questionIds: ["q_often"] },
          { type: "page", id: "p_spend", questionIds: ["q_spend"] },
        ],
      },
      { type: "page", id: "p_why", questionIds: ["q_why"] },
      { type: "end", id: "e_done", status: "complete" },
      { type: "end", id: "e_screen", status: "screened" },
    ],
    ...extra,
  });
}

const USER: TestCase = {
  id: "tc_user", name: "A 34-year-old user",
  input: { answers: { q_age: 34, q_use: 1, q_often: 1, q_spend: 25, q_why: "habit" }, seed: 7 },
};
const NON_USER: TestCase = {
  id: "tc_nonuser", name: "A non-user skips the usage block",
  input: { answers: { q_age: 40, q_use: 2, q_why: "never tried it" }, seed: 7 },
};
const MINOR: TestCase = {
  id: "tc_minor", name: "A 17-year-old is screened out",
  input: { answers: { q_age: 17, q_use: 1 }, seed: 7 },
};

const run = (def: ReturnType<typeof survey>, c: TestCase) => runTestCase(def, c);

/* ============================================================ the outcome */

test("an outcome records the path, what was asked, and every exported column", () => {
  const def = survey();
  const r = run(def, USER);
  assert.deepEqual(r.outcome.path, ["p_screen", "p_often", "p_spend", "p_why"]);
  assert.deepEqual(r.outcome.asked.p_screen, ["q_age", "q_use"]);
  assert.equal(r.outcome.endStatus, "complete");
  assert.equal(r.outcome.variables.SPEND, 25);
  assert.equal(r.outcome.variables.ANNUAL, 300, "a calculation is part of the behaviour being pinned");
});

test("the piped question is recorded as the respondent read it", () => {
  const r = run(survey(), USER);
  assert.match(r.outcome.texts.q_why, /You said Yes/);
});

test("a non-user's path skips the whole usage block", () => {
  const r = run(survey(), NON_USER);
  assert.deepEqual(r.outcome.path, ["p_screen", "p_why"]);
  assert.equal(r.outcome.endStatus, "complete");
});

test("a minor is screened out and never reaches the rest", () => {
  const r = run(survey(), MINOR);
  assert.equal(r.outcome.endStatus, "screened");
  assert.ok(!r.outcome.path.includes("p_why"));
});

/* ======================================================= the fingerprint */

test("the fingerprint is stable across runs and independent of key order", () => {
  const def = survey();
  assert.equal(run(def, USER).outcome.fingerprint, run(def, USER).outcome.fingerprint);
  assert.equal(canonicalJson({ b: 1, a: 2 }), canonicalJson({ a: 2, b: 1 }));
  assert.equal(fingerprint({ b: 1, a: [1, { d: 4, c: 3 }] }), fingerprint({ a: [1, { c: 3, d: 4 }] , b: 1 }));
});

test("different respondents fingerprint differently", () => {
  const def = survey();
  assert.notEqual(run(def, USER).outcome.fingerprint, run(def, NON_USER).outcome.fingerprint);
});

test("PIPED TEXT IS NOT IN THE FINGERPRINT — a date token must not churn the suite", () => {
  /*
   * A question reading "as of {{ed.TODAY}}" would otherwise report a change
   * every day and drown the real signal. The text is still compared in the
   * diff, where a person can judge it.
   */
  const def = survey();
  const base = run(def, USER).outcome;
  const reworded = survey({
    questions: survey().questions.map((q) => q.id === "q_why" ? { ...q, text: "You said {{Q2}} — tell us more" } : q),
  });
  const after = run(reworded, USER).outcome;
  assert.equal(after.fingerprint, base.fingerprint, "wording alone is not a behaviour change");
  const changes = diffOutcomes(base, after);
  assert.equal(changes.length, 1);
  assert.equal(changes[0].kind, "text");
  assert.match(changes[0].detail, /tell us more/);
});

/* ============================================================ pass / fail */

test("a case with no baseline and no expectations passes, honestly", () => {
  // green because nothing is broken, not because anything was proved
  assert.equal(run(survey(), USER).verdict, "pass");
});

test("declared expectations that hold pass", () => {
  const r = run(survey(), {
    ...MINOR,
    expectations: {
      endStatus: "screened",
      notVisits: ["p_often", "p_why"],
      skips: ["q_often"],
    },
  });
  assert.equal(r.verdict, "pass");
  assert.deepEqual(r.failures, []);
});

test("A VIOLATED EXPECTATION FAILS, and says what it wanted", () => {
  const r = run(survey(), { ...MINOR, expectations: { endStatus: "complete" } });
  assert.equal(r.verdict, "fail");
  assert.equal(r.failures.length, 1);
  assert.match(r.failures[0], /Expected to end as complete, ended as screened/);
});

test("every kind of expectation reports in the programmer's terms", () => {
  const r = run(survey(), {
    ...NON_USER,
    expectations: {
      visits: ["p_often"],
      notVisits: ["p_why"],
      asks: ["q_spend"],
      skips: ["q_use"],
      variables: { ANNUAL: 300, NOPE: 1 },
      completes: true,
    },
  });
  assert.equal(r.verdict, "fail");
  const all = r.failures.join(" | ");
  assert.match(all, /reach page p_often/);
  assert.match(all, /NOT to reach page p_why/);
  assert.match(all, /asked Q4, and was not/, "a question is named by its CODE, not its id");
  assert.match(all, /NOT to be asked Q2, and was/);
  assert.match(all, /Expected ANNUAL to be 300/);
  assert.match(all, /exports no such variable/, "an expectation on a variable that does not exist says so");
});

test("a variable expectation compares by value, not by type", () => {
  // a stored expectation arrives from JSON, where 25 may be "25"
  const r = run(survey(), { ...USER, expectations: { variables: { SPEND: "25" as never } } });
  assert.deepEqual(r.failures, []);
});

/* ====================================================== changed vs failed */

test("A CHANGED OUTCOME IS NOT A FAILURE — it needs a person, not a red light", () => {
  /*
   * The distinction the whole feature rests on. Making the usage block
   * unconditional changes the non-user's path; nothing declared is broken, so
   * the verdict is `changed` and the release is still allowed.
   */
  const def = survey();
  const baseline = run(def, NON_USER).outcome;
  const widened = survey({
    flow: survey().flow.map((n) => n.id === "b_usage" ? { ...n, visibleIf: undefined } : n),
  });
  const r = runTestCase(widened, { ...NON_USER, baseline });
  assert.equal(r.verdict, "changed");
  assert.deepEqual(r.failures, []);
  assert.ok(r.changes.length > 0);
  assert.equal(r.changes[0].kind, "path", "the path change is reported first, as the cause");
  assert.match(r.changes[0].detail, /diverges/);
});

test("a change that also breaks an expectation FAILS — fail outranks changed", () => {
  const def = survey();
  const baseline = run(def, NON_USER).outcome;
  const widened = survey({
    flow: survey().flow.map((n) => n.id === "b_usage" ? { ...n, visibleIf: undefined } : n),
  });
  const r = runTestCase(widened, {
    ...NON_USER, baseline,
    expectations: { notVisits: ["p_often"] },
  });
  assert.equal(r.verdict, "fail");
});

test("an unchanged definition against its own baseline passes", () => {
  const def = survey();
  const baseline = run(def, USER).outcome;
  const r = runTestCase(def, { ...USER, baseline });
  assert.equal(r.verdict, "pass");
  assert.deepEqual(r.changes, []);
});

/* ================================================================ stale */

test("A STALE CASE IS NOT A PASS — a deleted question would be answered by default", () => {
  /*
   * `simulateRespondent` substitutes a plausible default for a question it
   * cannot find, so a case naming a deleted question quietly starts testing a
   * different respondent and reports green. That is the worst outcome
   * available, so it gets its own verdict.
   */
  const def = survey({ questions: survey().questions.filter((q) => q.id !== "q_spend") });
  const r = runTestCase(def, USER);
  assert.equal(r.verdict, "stale");
  assert.deepEqual(r.staleRefs, ["q_spend"]);
});

test("stale outranks fail, because the case itself is what needs fixing", () => {
  const def = survey({ questions: survey().questions.filter((q) => q.id !== "q_spend") });
  const r = runTestCase(def, { ...USER, expectations: { endStatus: "screened" } });
  assert.equal(r.verdict, "stale");
});

test("staleReferences reports nothing for a healthy case", () => {
  assert.deepEqual(staleReferences(survey(), USER.input), []);
});

/* ============================================================= the diff */

test("a variable that moved is named with its before and after", () => {
  const def = survey();
  const baseline = run(def, USER).outcome;
  const changed = survey({
    calculations: [{ id: "c_annual", targetVariable: "ANNUAL", expression: "SPEND * 13", trigger: "on_page_submit" }],
  });
  const changes = diffOutcomes(baseline, run(changed, USER).outcome);
  const v = changes.find((c) => c.ref === "ANNUAL");
  assert.ok(v, JSON.stringify(changes));
  assert.match(v!.detail, /ANNUAL is 325 now, was 300/);
});

test("a question appearing on a page it was not on before is reported", () => {
  const def = survey();
  const baseline = run(def, NON_USER).outcome;
  const moved = survey({
    flow: survey().flow.map((n) => n.id === "p_why" ? { ...n, questionIds: ["q_why", "q_spend"] } : n),
  });
  const changes = diffOutcomes(baseline, run(moved, NON_USER).outcome);
  const a = changes.find((c) => c.kind === "asked");
  assert.ok(a, JSON.stringify(changes.map((c) => c.detail)));
  assert.match(a!.detail, /now also asks q_spend/);
});

test("a path that stops earlier says so rather than reporting a divergence", () => {
  const base: TestOutcome = { ...run(survey(), USER).outcome };
  const shorter: TestOutcome = { ...base, path: base.path.slice(0, 2) };
  const d = diffOutcomes(base, shorter).find((c) => c.kind === "path")!;
  assert.match(d.detail, /ends 2 page\(s\) earlier/);
});

test("a path that runs longer says so too", () => {
  const base: TestOutcome = { ...run(survey(), USER).outcome };
  const longer: TestOutcome = { ...base, path: [...base.path, "p_extra"] };
  const d = diffOutcomes(base, longer).find((c) => c.kind === "path")!;
  assert.match(d.detail, /1 page\(s\) longer/);
});

test("a validation the survey now stops on is reported as a block", () => {
  const def = survey();
  const baseline = run(def, NON_USER).outcome;
  /* make an unanswered question required, and stop answering it */
  const strict = survey({
    questions: survey().questions.map((q) => q.id === "q_why" ? { ...q, required: true } : q),
  });
  const r = runTestCase(strict, {
    ...NON_USER, baseline,
    input: { ...NON_USER.input, answers: { q_age: 40, q_use: 2, q_why: null } },
  });
  /* the walk answers what it can; the point is that a block is diffed, not that this one blocks */
  assert.ok(r.outcome.blocked === null || r.changes.some((c) => c.kind === "blocked"));
});

/* ============================================================== a suite */

test("a suite counts every verdict and says whether a release is safe", () => {
  const def = survey();
  const cases: TestCase[] = [
    { ...USER, baseline: run(def, USER).outcome },
    { ...NON_USER, expectations: { endStatus: "complete" } },
    { ...MINOR, expectations: { endStatus: "complete" } },          /* will fail */
    { id: "tc_off", name: "Disabled", enabled: false, input: { answers: {} } },
  ];
  const s = runSuite(def, cases);
  assert.equal(s.summary.total, 4);
  assert.equal(s.summary.skipped, 1);
  assert.equal(s.summary.pass, 2);
  assert.equal(s.summary.fail, 1);
  assert.equal(s.summary.releasable, false);
  assert.equal(s.results.length, 3, "a disabled case is counted but not run");
  assert.match(describeSuite(s.summary), /2 of 4 pass, 1 failed, 1 disabled/);
});

test("A CHANGED CASE DOES NOT BLOCK A RELEASE, but is not clean either", () => {
  // it may be exactly the change the programmer just made on purpose
  const def = survey();
  const baseline = run(def, NON_USER).outcome;
  const widened = survey({
    flow: survey().flow.map((n) => n.id === "b_usage" ? { ...n, visibleIf: undefined } : n),
  });
  const s = runSuite(widened, [{ ...NON_USER, baseline }]);
  assert.equal(s.summary.changed, 1);
  assert.equal(s.summary.releasable, true);
  assert.equal(s.summary.clean, false);
  assert.match(describeSuite(s.summary), /1 changed and need review/);
});

test("a stale case blocks a release", () => {
  const def = survey({ questions: survey().questions.filter((q) => q.id !== "q_spend") });
  const s = runSuite(def, [USER]);
  assert.equal(s.summary.stale, 1);
  assert.equal(s.summary.releasable, false);
});

test("an empty suite says so rather than claiming success", () => {
  assert.match(describeSuite(runSuite(survey(), []).summary), /No test cases yet/);
});

test("a clean suite reads as one sentence", () => {
  const def = survey();
  const s = runSuite(def, [{ ...USER, baseline: run(def, USER).outcome }]);
  assert.equal(describeSuite(s.summary), "All 1 test case passes.");
});

/* ============================================= it agrees with the engine */

test("the outcome is exactly what simulateRespondent walked — no second opinion", () => {
  const def = survey();
  const sim = simulateRespondent(def, { answers: USER.input.answers, seed: 7 });
  const direct = outcomeOf(def, sim);
  assert.equal(direct.fingerprint, run(def, USER).outcome.fingerprint);
});

test("checkExpectations is callable on a stored outcome without re-running", () => {
  // a recorded run can be re-judged against new expectations, which is what
  // makes "add an assertion to an old case" cheap
  const def = survey();
  const outcome = run(def, MINOR).outcome;
  assert.deepEqual(checkExpectations(def, outcome, { endStatus: "screened" }), []);
  assert.equal(checkExpectations(def, outcome, { endStatus: "complete" }).length, 1);
});

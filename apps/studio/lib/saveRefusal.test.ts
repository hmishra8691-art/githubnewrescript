import { test } from "node:test";
import assert from "node:assert/strict";
import { SurveyDefinition } from "@rescript/schema";
import { publishGate, gateRefusal } from "./publishGate.ts";

/**
 * A REFUSED SAVE HAS TO SAY WHY, AND WHERE.
 *
 * The bug report was a survey that could not be saved, showing only "Your
 * latest changes could not be saved. Please retry before starting the test
 * survey." Nothing about it was true except that the save had failed:
 *
 *   · the server had sent a list of the exact blocking problems, which the
 *     Studio dropped;
 *   · the refusal message told the programmer to look in the "Quality panel",
 *     which is the panel that scores collected responses — the survey lint it
 *     meant is rendered by the Logic panel;
 *   · and "please retry" is advice that cannot work, because a survey with a
 *     blocking problem is refused identically every time.
 *
 * These pin the parts that live in `lib`. The two client-side halves — the
 * toast no longer being overwritten, and the problems being rendered — are
 * asserted by the browser suite.
 */

/** A sound survey, in the shape publishGate.test.ts already proves passes. */
const sound = () =>
  SurveyDefinition.parse({
    meta: { id: "svy_ok", code: "OK", title: "Fine" },
    questions: [
      { id: "q1", code: "Q1", variableName: "AGE", type: "numeric", text: "How old are you?" },
    ],
    flow: [
      { type: "page", id: "p1", questionIds: ["q1"] },
      { type: "end", id: "e1", status: "complete" },
    ],
    deployment: { clientSlug: "acme", studySlug: "tracker" },
  });

/**
 * Two questions exporting the same variable: a blocking problem, and the one
 * that matters commercially — one question's data overwrites another's in
 * every delivered file.
 */
function brokenSurvey() {
  const def = sound();
  def.questions.push({ ...def.questions[0], id: "q2", code: "Q2" } as never);
  return def;
}

test("the gate returns the problems, not just a count", () => {
  const verdict = publishGate(brokenSurvey());
  assert.equal(verdict.ok, false, "a question with no options must not be deployable");
  assert.ok(verdict.problems.length > 0, "the gate must name what is wrong, not only that something is");
  for (const p of verdict.problems) {
    assert.ok(p.area, "every problem names the area it belongs to");
    assert.ok(p.message && p.message.length > 5, `unhelpful problem message: ${JSON.stringify(p)}`);
  }
});

test("the refusal body carries those problems to the client", () => {
  const body = gateRefusal(publishGate(brokenSurvey()), "saved as a version");
  assert.ok(Array.isArray(body.lint.problems), "the client needs the list, not a summary");
  assert.ok(body.lint.problems.length > 0);
  assert.ok(Array.isArray(body.lint.blocking) && body.lint.blocking.length > 0,
    "the blocking areas let a panel open on the first one");
});

test("the refusal does not send the programmer to the wrong panel", () => {
  const body = gateRefusal(publishGate(brokenSurvey()), "saved as a version");
  /*
   * `runQualityCheck` is the SURVEY lint and the Logic panel renders it. The
   * panel called Quality scores collected responses for speeding and
   * straightlining and knows nothing about any of this, so naming it sent
   * people somewhere that had nothing to show them.
   */
  assert.ok(!/Quality panel/i.test(body.error),
    `the refusal still points at the Quality panel: ${body.error}`);
  assert.ok(/logic/i.test(body.error),
    `the refusal should name the panel that actually shows these: ${body.error}`);
});

test("the refusal does not promise a list it cannot deliver", () => {
  const body = gateRefusal(publishGate(brokenSurvey()), "saved as a version");
  // "see the list below" was written for a UI that rendered one; the Studio
  // showed this string as a toast and dropped `lint` entirely
  if (/list below/i.test(body.error)) {
    assert.ok(body.lint.problems.length > 0, "a message promising a list must ship the list");
  }
});

test("a gate that cannot run fails closed rather than waving the survey through", () => {
  // publishGate catches a throwing lint and reports it as a blocking problem
  const verdict = publishGate({ meta: { id: "x" } } as never);
  assert.equal(verdict.ok, false, "an unrunnable check must never read as a pass");
  assert.ok(verdict.problems.length > 0);
});

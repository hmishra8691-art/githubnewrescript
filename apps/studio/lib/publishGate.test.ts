import { test } from "node:test";
import assert from "node:assert/strict";
import { SurveyDefinition } from "@rescript/schema";
import { publishGate, gateRefusal } from "./publishGate.ts";

/*
 * R10 — THE LINT AS A GATE.
 *
 * `runQualityCheck` was complete and correct and had exactly one call site: a
 * panel. These tests are about the gate, not the lint — that a broken survey
 * is refused, that a sound one is not, and that the failure modes fail
 * CLOSED. The last of those is the one worth writing down: a gate that lets
 * something through when it cannot make up its mind is not a gate.
 */

const ok = () =>
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

test("a sound survey passes the gate", () => {
  const v = publishGate(ok());
  assert.equal(v.ok, true, `a clean survey was refused: ${JSON.stringify(v.problems, null, 2)}`);
  assert.equal(v.problems.length, 0);
});

test("a survey with no questions is refused, and says so", () => {
  const def = ok();
  def.questions = [];
  const v = publishGate(def);
  assert.equal(v.ok, false, "an empty survey passed the gate");
  assert.ok(v.problems.length > 0, "refused with no reason given");
  assert.match(JSON.stringify(v.problems), /no questions/i);
});

test("two variables with the same name are refused", () => {
  /*
   * The one that matters most commercially: duplicate variable names mean one
   * question's data overwrites another's in every delivered file.
   */
  const def = ok();
  def.questions.push({ ...def.questions[0], id: "q2", code: "Q2" } as never);
  const v = publishGate(def);
  assert.equal(v.ok, false, "two questions exporting AGE passed the gate");
  assert.ok(
    v.problems.some((p) => p.area === "variables"),
    `expected a variables problem, got ${JSON.stringify(v.problems)}`,
  );
});

test("a missing deployment slug is refused — no link could be built for it", () => {
  const def = ok();
  def.deployment = { ...def.deployment, studySlug: "" } as never;
  assert.equal(publishGate(def).ok, false);
});

test("a warning alone does not block", () => {
  /*
   * A gate that refuses on warnings is a gate people learn to force past, and
   * then it stops meaning anything when it refuses on an error.
   */
  const def = ok();
  def.flow = [{ type: "page", id: "p1", questionIds: ["q1"] }] as never; // no End: a warning
  const v = publishGate(def);
  assert.equal(v.ok, true, `a warning blocked the gate: ${JSON.stringify(v.problems)}`);
  assert.ok(v.result.warnings > 0, "the missing End should still be reported as a warning");
});

test("the gate FAILS CLOSED when the check itself throws", () => {
  /*
   * "The checker crashed" is the least reassuring possible reason to publish
   * something to respondents. A definition mangled past what the lint can
   * walk must be refused, not waved through.
   */
  const broken = { meta: null, questions: null, flow: null } as never;
  const v = publishGate(broken);
  assert.equal(v.ok, false, "a definition that crashed the checker was allowed through");
  assert.match(v.summary, /could not run|problem/i);
});

test("the refusal body names the blocking areas without repeating them", () => {
  const def = ok();
  def.questions = [];
  def.deployment = { clientSlug: "", studySlug: "" } as never;
  const body = gateRefusal(publishGate(def), "deployed");
  assert.match(body.error, /not deployed/);
  assert.ok(Array.isArray(body.lint.blocking));
  assert.deepEqual(
    body.lint.blocking,
    [...new Set(body.lint.blocking)],
    "blocking must be a set of areas, not one entry per issue",
  );
  assert.ok(body.lint.problems.length > 0, "a refusal with no problems listed is unactionable");
});

test("the problem list is capped, so a wrecked survey does not return a novel", () => {
  /*
   * Parsed, not hand-assembled: assigning raw objects onto an already-parsed
   * definition skips the schema defaults, and the lint then throws and takes
   * the fail-closed path — which reports ONE error and would have made this
   * test pass for entirely the wrong reason.
   */
  const ids = Array.from({ length: 60 }, (_, i) => `q${i}`);
  const def = SurveyDefinition.parse({
    meta: { id: "svy_many", code: "MANY", title: "Many" },
    questions: ids.map((id, i) => ({
      id, code: `Q${i}`, variableName: "SAME", type: "numeric", text: "n",
    })),
    flow: [
      { type: "page", id: "p1", questionIds: ids },
      { type: "end", id: "e1", status: "complete" },
    ],
    deployment: { clientSlug: "acme", studySlug: "tracker" },
  });
  const v = publishGate(def);
  assert.equal(v.ok, false);
  assert.ok(v.problems.length <= 20, `expected the list capped at 20, got ${v.problems.length}`);
  /* but the COUNT is still the true one — the cap is on the list, not the verdict */
  assert.ok(v.result.errors > 20, `the error count should report all of them, got ${v.result.errors}`);
});

import { test } from "node:test";
import assert from "node:assert/strict";
import { runQualityCheck, buildVariableDictionary } from "@rescript/engine";
import { SURVEY_TEMPLATES, findSurveyTemplate } from "./index.js";
import { simulateRespondent } from "./simulate.js";

/**
 * A starter template is a promise: open this, and it works. So the test is
 * not "does it parse" — it is the same check a programmer would run before a
 * release, plus an actual respondent walking through it.
 */

test("every template in the picker builds, and builds the same way twice", () => {
  for (const t of SURVEY_TEMPLATES) {
    const a = t.build("x");
    const b = t.build("x");
    assert.deepEqual(JSON.parse(JSON.stringify(a)), JSON.parse(JSON.stringify(b)),
      `${t.key} is not deterministic`);
    assert.equal(findSurveyTemplate(t.key)?.key, t.key);
  }
});

test("every template passes the quality check with nothing to report", () => {
  for (const t of SURVEY_TEMPLATES) {
    const r = runQualityCheck(t.build("x"));
    const bad = r.areas.filter((a) => a.status !== "pass");
    assert.equal(
      bad.length, 0,
      `${t.key}: ${bad.map((a) => `${a.label} — ${a.issues.map((i) => i.message).join("; ")}`).join(" | ")}`,
    );
    assert.equal(r.deployable, true);
  }
});

test("a respondent can walk each starter from the first page to an end", () => {
  for (const t of SURVEY_TEMPLATES) {
    if (t.key === "master_demo_2026") continue; // has its own path tests
    const def = t.build("x");
    const run = simulateRespondent(def, { seed: 7, answers: {} });
    assert.ok(run.pages.length > 0, `${t.key} showed no pages`);
    assert.ok(
      ["complete", "screened", "quota_full", "terminated"].includes(run.endStatus ?? ""),
      `${t.key} did not reach an end: ${run.endStatus}`,
    );
    assert.equal(run.blocked, undefined, `${t.key} was blocked: ${JSON.stringify(run.blocked)}`);
  }
});

test("every starter declares variables, and no two share a name", () => {
  for (const t of SURVEY_TEMPLATES) {
    const vars = buildVariableDictionary(t.build("x"));
    assert.ok(vars.length > 0, `${t.key} declares no variables`);
    const names = vars.map((v) => v.name);
    assert.equal(new Set(names).size, names.length, `${t.key} has duplicate variable names`);
  }
});

test("the starters come before the capability demo in the picker", () => {
  /*
   * Ordering is the whole point of this wave: someone starting a study wants
   * a study, not a demonstration. The Master Demo stays available and stays
   * last.
   */
  const keys = SURVEY_TEMPLATES.map((t) => t.key);
  assert.equal(keys[keys.length - 1], "master_demo_2026");
  assert.ok(keys.length >= 6, "the library should offer more than the demo");
});

test("the NPS starter asks a different reason question at each score band", () => {
  const def = buildOf("nps_relationship");
  const reasons = def.questions.filter((q) => q.id.startsWith("q_why_"));
  assert.equal(reasons.length, 3);
  assert.ok(reasons.every((q) => q.displayLogic), "each reason must be conditional on the score");
});

test("the tracker builds its funnel by carry-forward, not by repeating a list", () => {
  const def = buildOf("brand_tracker");
  const consider = def.questions.find((q) => q.code === "Q2")!;
  const used = def.questions.find((q) => q.code === "Q3")!;
  assert.equal(consider.carryForward?.sourceQuestionId, "q_aware");
  assert.equal(used.carryForward?.sourceQuestionId, "q_consider");
  assert.equal(consider.options.length, 0, "a carried list must not also be typed out");
});

test("the screener terminates, and its quota cells cover every age band once", () => {
  const def = buildOf("screener_quota");
  const terminating = def.questions.filter((q) =>
    (q.skipLogic ?? []).some((r) => (r.target as { kind?: string }).kind === "terminate"));
  assert.ok(terminating.length >= 3, "a screener that never screens anyone out is not a screener");

  const quota = def.quotas[0];
  assert.equal(quota.cells.length, 3);
  assert.equal(quota.cells.reduce((a, c) => a + c.limit, 0), quota.targetTotal);
});

function buildOf(key: string) {
  return findSurveyTemplate(key)!.build("x");
}

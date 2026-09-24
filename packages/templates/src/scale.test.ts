import { test } from "node:test";
import assert from "node:assert/strict";
import {
  buildDependencyIndex, objectStatus, runQualityCheck, normaliseQuestionOrder,
  duplicateQuestion, buildLogicFlow, lintSurveyLogic, buildVariableDictionary, objectKey,
} from "@rescript/engine";
import { buildScaleSurvey } from "./scale.js";
import { simulateRespondent } from "./simulate.js";

/**
 * PERFORMANCE BUDGETS AT 600 QUESTIONS.
 *
 * These are the operations a programming environment runs on every edit or
 * every selection. The budgets are generous for CI (a laptop is 3–5× faster
 * than the runner) and exist to catch a regression from milliseconds to
 * seconds, not to tune. A number here that moves by 10× is a bug.
 *
 * The numbers are also what decides whether Phase 1 needs a selector-based
 * store: if `structuredClone` + normalise per edit is under budget at 600,
 * the existing store is fine.
 */

const N = 600;
const def = buildScaleSurvey(N);

const timed = <T>(f: () => T): [T, number] => {
  const t0 = performance.now();
  const r = f();
  return [r, performance.now() - t0];
};

test(`the fixture really has ${N} questions and the logic density it promises`, () => {
  assert.equal(def.questions.length, N);
  const withDisplay = def.questions.filter((q) => q.displayLogic).length;
  const withSkip = def.questions.filter((q) => q.skipLogic?.length).length;
  assert.ok(withDisplay > N / 5, `only ${withDisplay} questions have display logic`);
  assert.ok(withSkip > N / 15, `only ${withSkip} questions have skips`);
  assert.ok(def.displayRules.length > 20, "named display rules");
  assert.ok(def.calculations.length > 40, "calculations");
  assert.ok(def.flow.length > 50, "blocks");
});

test("the fixture is a valid survey the quality gate does not reject", () => {
  const q = runQualityCheck(def);
  assert.equal(q.errors, 0, JSON.stringify(q.areas.filter((a) => a.errors).map((a) => a.issues.slice(0, 3)), null, 1));
});

test("a respondent can walk the fixture to the end", () => {
  // consent yes, age 30, and a default answer for everything else
  const r = simulateRespondent(def, { seed: 1, answers: { q_consent: 1, q_age: 30 } });
  assert.ok(r.endStatus, "reached an end");
  assert.ok(r.pages.length > 50, `only ${r.pages.length} pages visited — the blocks are not being reached`);
});

test("the edit path — clone + normalise — stays well inside a keystroke", () => {
  const [, ms] = timed(() => {
    const d = structuredClone(def);
    duplicateQuestion(d, "q300");
    normaliseQuestionOrder(d);
  });
  assert.ok(ms < 60, `clone + edit + normalise took ${ms.toFixed(1)}ms at ${N} questions (budget 60ms)`);
});

test("the dependency index builds in one frame's worth of time", () => {
  const [ix, ms] = timed(() => buildDependencyIndex(def));
  assert.ok(ms < 120, `index took ${ms.toFixed(1)}ms (budget 120ms)`);
  assert.ok(ix.edges.length > N, `an index this sparse (${ix.edges.length} edges) means the walkers missed something`);
  const [, walk] = timed(() => {
    for (const q of def.questions) { ix.reach(objectKey("question", q.id)); ix.affects(objectKey("question", q.id)); }
  });
  assert.ok(walk < 400, `${2 * N} transitive walks took ${walk.toFixed(0)}ms (budget 400ms)`);
});

test("lint and status regroup are affordable per edit", () => {
  const [issues, lintMs] = timed(() => lintSurveyLogic(def));
  assert.ok(lintMs < 400, `lintSurveyLogic took ${lintMs.toFixed(0)}ms (budget 400ms)`);
  const [st, statusMs] = timed(() => objectStatus(def));
  assert.ok(statusMs < 600, `runQualityCheck + regroup took ${statusMs.toFixed(0)}ms (budget 600ms)`);
  assert.ok(Array.isArray(issues));
  assert.ok(st.byKey.size >= 0);
});

test("the logic graph and the variable dictionary are affordable too", () => {
  const [g, gMs] = timed(() => buildLogicFlow(def));
  assert.ok(gMs < 300, `buildLogicFlow took ${gMs.toFixed(0)}ms (budget 300ms)`);
  assert.ok(g.nodes.length > N / 2);
  const [dict, dMs] = timed(() => buildVariableDictionary(def));
  assert.ok(dMs < 200, `dictionary took ${dMs.toFixed(0)}ms (budget 200ms)`);
  assert.ok(dict.length > N);
});

test("the survey lint scales roughly linearly, not cubically, with question count", () => {
  /*
   * Found while building this fixture: `lintQuestionLogic` recomputed the
   * whole survey's `orderIndex` per question, and `questionOrder` used an
   * array `includes` — cubic in the question count. 70 ms at 160 questions,
   * 5.5 s at 1 000. Fixed by computing the index once per survey pass. This
   * pins the shape of the curve, so the fix cannot quietly come undone: a
   * linear pass grows ~6× from 160 to 1 000 questions; the cubic one grew 80×.
   */
  const small = buildScaleSurvey(160);
  const large = buildScaleSurvey(1000);
  lintSurveyLogic(small); lintSurveyLogic(large); // warm the JIT
  const reps = 3;
  const [, ms160] = timed(() => { for (let i = 0; i < reps; i++) lintSurveyLogic(small); });
  const [, ms1000] = timed(() => { for (let i = 0; i < reps; i++) lintSurveyLogic(large); });
  const ratio = ms1000 / Math.max(ms160, 1);
  assert.ok(ratio < 9, `lint grew ${ratio.toFixed(1)}× from 160 to 1000 questions (${(ms160 / reps).toFixed(0)}ms → ${(ms1000 / reps).toFixed(0)}ms); linear is ~4–6×, quadratic ~12×, cubic ~80×`);
  assert.ok(ms1000 / reps < 1000, `lint at 1000 questions took ${(ms1000 / reps).toFixed(0)}ms — over a second per keystroke`);
});

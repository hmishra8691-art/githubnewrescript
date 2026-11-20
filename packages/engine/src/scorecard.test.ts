import { test } from "node:test";
import assert from "node:assert/strict";
import { SurveyDefinition } from "@rescript/schema";
import { bandFor, cohortValues, computeScorecard, respondentScorecard, scorecardFingerprint, scorecardOf, scorecardProblems, scorecardValues } from "./scorecard.js";

const five = () => [1, 2, 3, 4, 5].map((n) => ({ code: n, label: `Point ${n}` }));
const scale = (portal: Record<string, unknown>) => SurveyDefinition.parse({
  meta: { id: "s", code: "S", title: "Wellbeing", version: "1", schemaVersion: 1, status: "live" },
  questions: [
    { id: "q1", code: "Q1", variableName: "Q1", type: "single_select", text: "I feel calm", options: five() },
    { id: "q2", code: "Q2", variableName: "Q2", type: "single_select", text: "I feel tense", options: five() },
    { id: "g1", code: "G1", variableName: "G1", type: "matrix_single", text: "At work", rows: [{ code: "a", label: "Supported" }, { code: "b", label: "Heard" }], options: five() },
    { id: "dept", code: "DEPT", variableName: "DEPT", type: "single_select", text: "Department", options: [{ code: 1, label: "<b>Sales</b>" }, { code: 2, label: "Ops" }] },
    { id: "c1", code: "STRESS", variableName: "STRESS", type: "calculated", text: "Stress" },
    { id: "t1", code: "T1", variableName: "T1", type: "open_text", text: "Notes" },
  ],
  flow: [{ type: "page", id: "p1", questionIds: ["q1", "q2", "g1", "dept", "c1", "t1"] }, { type: "end", id: "e", status: "complete" }],
  portal: { enabled: true, ...portal },
});
const calm = { id: "calm", label: "Calm", source: { kind: "items", method: "sum", items: [{ question: "q1" }, { question: "q2", reverse: true }] }, bands: [{ upTo: 4, label: "Low" }, { upTo: 7, label: "Middle", note: "About average." }, { upTo: 10, label: "High" }] };
const work = { id: "work", label: "Work", source: { kind: "items", method: "mean", items: [{ question: "g1", row: "a" }, { question: "g1", row: "b" }] } };
const stress = { id: "stress", label: "Stress", source: { kind: "variable", name: "STRESS" }, min: 0, max: 40, higherIsBetter: false };

test("no scorecard, or a portal that is off: there is nothing to score", () => {
  assert.equal(scorecardOf(scale({})), null);
  assert.equal(computeScorecard(scale({ scorecard: { dimensions: [] } }), { answers: {} }), null);
  assert.equal(computeScorecard(scale({ enabled: false, scorecard: { dimensions: [calm] } }), { answers: { q1: 5, q2: 1 } }), null);
});

test("items: a sum with a reverse-keyed item, its range and band; a grid's rows as a mean", () => {
  const def = scale({ scorecard: { dimensions: [calm, work] } });
  const r = computeScorecard(def, { answers: { q1: 4, q2: 2, g1: { a: 5, b: 4 } } })!;
  const [c, w] = r.dimensions;
  assert.equal(c!.score, 8, "4 + (1 + 5 − 2)");
  assert.deepEqual([c!.min, c!.max, c!.percent], [2, 10, 75]);
  assert.deepEqual(c!.band, { label: "High" });
  assert.deepEqual([w!.score, w!.min, w!.max, w!.percent], [4.5, 1, 5, 87.5]);
  assert.equal(w!.band, null, "no bands were defined");
});

test("a score that cannot be worked out is null with the reason — never zero", () => {
  const def = scale({ scorecard: { dimensions: [calm, work, stress] } });
  const r = computeScorecard(def, { answers: { q1: 4, g1: { a: 3 } }, calculated: {} })!;
  assert.equal(r.dimensions[0]!.score, null); assert.match(r.dimensions[0]!.reason!, /Not every question/);
  assert.equal(r.dimensions[1]!.score, 3, "a mean needs at least half of its items: one of two is enough");
  assert.equal(r.dimensions[2]!.score, null); assert.match(r.dimensions[2]!.reason!, /not calculated/);
  const none = computeScorecard(def, { answers: { g1: {} } })!;
  assert.equal(none.dimensions[1]!.score, null); assert.match(none.dimensions[1]!.reason!, /Too few/);
  assert.equal(none.dimensions[1]!.percent, null);
});

test("a calculated variable: read by code or by id, numbers kept as text accepted, the researcher's range used", () => {
  const def = scale({ scorecard: { dimensions: [stress] } });
  assert.equal(computeScorecard(def, { answers: {}, calculated: { STRESS: 10 } })!.dimensions[0]!.percent, 25);
  assert.equal(computeScorecard(def, { answers: {}, calculated: { c1: "30" } })!.dimensions[0]!.score, 30);
  assert.equal(computeScorecard(def, { answers: {}, calculated: { STRESS: "high" } })!.dimensions[0]!.score, null);
});

test("the headline counts a less-is-better score from its good end", () => {
  const def = scale({ scorecard: { dimensions: [calm, stress], overall: { label: "Wellbeing" } } });
  const r = computeScorecard(def, { answers: { q1: 4, q2: 2 }, calculated: { STRESS: 10 } })!;
  assert.deepEqual(r.overall, { label: "Wellbeing", percent: 75 }, "(75 + (100 − 25)) / 2");
  assert.deepEqual(scorecardValues(r), { calm: 8, stress: 10, __overall: 75 });
  const partial = computeScorecard(def, { answers: {}, calculated: {} })!;
  assert.equal(partial.overall, null, "nothing scored, no headline");
});

test("bands: looked up from the raw score, in order of their upper ends; above the last band is the last band", () => {
  const bands = [{ upTo: 10, label: "High" }, { upTo: 4, label: "Low" }, { upTo: 7, label: "Middle" }];
  assert.deepEqual([0, 4, 4.01, 7, 9, 12].map((s) => bandFor(bands, s)!.label), ["Low", "Low", "Middle", "Middle", "High", "High"]);
  assert.equal(bandFor([], 3), null);
});

const mcq = (n: number, topic: string, correct: number) => ({ id: `q${n}`, code: `Q${n}`, variableName: `Q${n}`, type: "single_select", text: `Question ${n}`, options: five(), assessment: { correct: [correct], topic } });
const paper = (portal: Record<string, unknown>, assessment: Record<string, unknown> | null = { defaultMarks: 2, defaultNegativeMarks: 0.5 }) => SurveyDefinition.parse({
  meta: { id: "s", code: "T", title: "Test", version: "1", schemaVersion: 1, status: "live" },
  questions: [mcq(1, "Polity", 3), mcq(2, "Polity", 2), mcq(3, "Economy", 4)],
  flow: [{ type: "page", id: "p1", questionIds: ["q1", "q2", "q3"] }, { type: "end", id: "e", status: "complete" }],
  ...(assessment ? { assessment } : {}),
  portal: { enabled: true, ...portal },
});
const testDims = [{ id: "total", label: "Marks", source: { kind: "test_total" } }, { id: "polity", label: "Polity", source: { kind: "test_topic", topic: "Polity" } }, { id: "geo", label: "Geography", source: { kind: "test_topic", topic: "Geography" } }];

test("a knowledge test: the marks and each topic come from the marking engine, not a second scorer", () => {
  const r = computeScorecard(paper({ scorecard: { dimensions: testDims } }), { answers: { q1: 3, q2: 1, q3: 4 } })!;
  assert.deepEqual([r.dimensions[0]!.score, r.dimensions[0]!.max], [3.5, 6], "2 − 0.5 + 2");
  assert.deepEqual([r.dimensions[1]!.score, r.dimensions[1]!.max], [1.5, 4]);
  assert.equal(r.dimensions[2]!.score, null); assert.match(r.dimensions[2]!.reason!, /no topic/);
  const notATest = computeScorecard(paper({ scorecard: { dimensions: testDims } }, null), { answers: { q1: 3 } })!;
  assert.match(notATest.dimensions[0]!.reason!, /not a scored test/);
});

test("the fingerprint changes with the definition and with the answer key, and with nothing else", () => {
  const a = paper({ scorecard: { dimensions: testDims } });
  const fp = (d: SurveyDefinition, answers: Record<string, unknown>) => computeScorecard(d, { answers })!.fingerprint;
  assert.equal(fp(a, { q1: 3 }), fp(a, { q1: 1, q2: 2 }), "the answers do not change it");
  assert.notEqual(fp(a, {}), fp(paper({ scorecard: { dimensions: testDims.slice(0, 2) } }), {}));
  const rekeyed = SurveyDefinition.parse({ ...a, questions: a.questions.map((q, i) => (i ? q : { ...q, assessment: { ...q.assessment, correct: [1] } })) });
  assert.notEqual(fp(a, {}), fp(rekeyed, {}), "a changed key is a different scoring");
  const relabelled = scale({ scorecard: { dimensions: [{ ...calm, label: "Calmness", description: "New words" }] } });
  assert.equal(scorecardFingerprint(relabelled), scorecardFingerprint(scale({ scorecard: { dimensions: [calm] } })), "wording is not scoring");
});

test("comparison groups: an option's label, a list field, and no group without an answer", () => {
  const def = scale({ benchmark: { enabled: true, groups: [{ id: "dept", label: "Department", source: { kind: "question", ref: "DEPT" } }, { id: "site", label: "Site", source: { kind: "embedded", ref: "site" } }] } });
  assert.deepEqual(cohortValues(def, { answers: { dept: 1 }, embedded: { site: " Pune " } }), { dept: "Sales", site: "Pune" });
  assert.deepEqual(cohortValues(def, { answers: {}, embedded: null }), { dept: null, site: null });
  assert.equal(def.portal!.benchmark.minCohort, 10);
  assert.throws(() => scale({ benchmark: { minCohort: 5 } }), /10/, "the floor of ten cannot be lowered");
});

test("what the respondent is shown: nothing without the permission, no band when bands are off", () => {
  const withScores = (show: Record<string, unknown>) => { const d = scale({ show, scorecard: { dimensions: [calm] } }); return respondentScorecard(d, computeScorecard(d, { answers: { q1: 4, q2: 2 } })); };
  assert.equal(withScores({}), null);
  assert.deepEqual(withScores({ scores: true })!.dimensions[0]!.band, { label: "High" });
  assert.equal(withScores({ scores: true, bands: false })!.dimensions[0]!.band, null);
  assert.equal(withScores({ scores: true, bands: false })!.dimensions[0]!.score, 8);
});

test("the Studio is told what is wrong with a scorecard", () => {
  const bad = scale({
    scorecard: { dimensions: [
      { id: "a", label: "A", source: { kind: "test_total" } },
      { id: "a", label: "A again", source: { kind: "variable", name: "NOPE" } },
      { id: "b", label: "B", source: { kind: "items", items: [{ question: "t1" }, { question: "gone" }] }, bands: [{ upTo: 3, label: "x" }, { upTo: 3, label: "y" }] },
    ] },
    benchmark: { groups: [{ id: "g", label: "Team", source: { kind: "question", ref: "TEAM" } }] },
  });
  const msgs = scorecardProblems(bad).map((p) => p.message).join(" | ");
  for (const want of [/not a scored test/, /same id/, /no calculated variable called NOPE/, /lowest and highest/, /T1 has no numeric scale/, /no longer in the survey/, /same value/, /comparison group "Team"/]) assert.match(msgs, want);
  assert.deepEqual(scorecardProblems(scale({ scorecard: { dimensions: [calm, work, stress] } })), []);
});

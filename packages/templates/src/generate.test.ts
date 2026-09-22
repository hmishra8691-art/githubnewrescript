import { test } from "node:test";
import assert from "node:assert/strict";
import { buildMasterDemoSurvey } from "./masterDemo.js";
import { buildNpsSurvey, buildScreenerSurvey, buildBrandTrackerSurvey } from "./starters.js";
import { generatePopulation, sampleAnswer } from "./generate.js";

/**
 * THE GENERATOR, AGAINST THE HARDEST SURVEY IN THE REPO.
 *
 * The Master Demo is the one with loops, list fills, quotas, masking, piping,
 * conjoint and maxdiff designs — if a generated population walks that to
 * completion without tripping the survey's own validation, the sampler is
 * producing answers the live survey could actually have collected, which is
 * the whole requirement.
 */

const demo = buildMasterDemoSurvey("gen-demo");
const tracker = buildBrandTrackerSurvey("gen-track");

test("a population walks a complex survey to completion", () => {
  const r = generatePopulation(demo, { count: 8, seed: 4242 });
  assert.ok(r.respondents.length >= 7, `only ${r.respondents.length}/8 respondents completed — ${JSON.stringify(r.issues.slice(0, 3), null, 1)}`);
  assert.equal(r.stats.requested, 8);
  // every saved respondent reached a terminal status; none is a blocked walk
  for (const p of r.respondents) {
    assert.ok(p.endStatus, `respondent ${p.index} has no end status`);
    assert.equal(p.blocked, false);
  }
});

test("respondents differ — this is the point of the whole module", () => {
  const r = generatePopulation(demo, { count: 8, seed: 99 });
  const fingerprints = new Set(r.respondents.map((p) => JSON.stringify(p.sim.state.answers)));
  assert.ok(fingerprints.size > 1, "every respondent answered identically");
  // and they should differ a lot, not just at one question
  assert.ok(fingerprints.size >= r.respondents.length * 0.8,
    `only ${fingerprints.size} distinct answer sets across ${r.respondents.length} respondents`);
});

test("a run is reproducible from its seed, and a different seed gives a different population", () => {
  const a = generatePopulation(tracker, { count: 6, seed: 7 });
  const b = generatePopulation(tracker, { count: 6, seed: 7 });
  const c = generatePopulation(tracker, { count: 6, seed: 8 });
  const sig = (r: ReturnType<typeof generatePopulation>) => JSON.stringify(r.respondents.map((p) => p.sim.state.answers));
  assert.equal(sig(a), sig(b), "same seed must reproduce the population exactly");
  assert.notEqual(sig(a), sig(c), "a different seed should not reproduce it");
});

test("coverage is reported, and a simple survey is fully covered", () => {
  const nps = buildNpsSurvey("gen-nps");
  const r = generatePopulation(nps, { count: 10, seed: 3 });
  assert.equal(r.coverage.questions.exercised, r.coverage.questions.total,
    `missed: ${r.coverage.questions.missing.map((m) => m.code).join(", ")}`);
  assert.ok(r.coverage.questions.total > 0);
  assert.ok(Object.keys(r.coverage.endStatuses).length > 0);
});

test("a single-select question does not give everybody option 1", () => {
  const r = generatePopulation(tracker, { count: 14, seed: 11 });
  const singles = r.coverage.answerVariety.filter((v) => v.offered >= 3);
  assert.ok(singles.length, "the tracker should have questions with three or more options");
  // at least one multi-option question must have been answered more than one way
  assert.ok(singles.some((v) => v.distinct >= 2),
    `no variety anywhere: ${JSON.stringify(singles.slice(0, 5))}`);
});

test("a screener produces both qualified and screened-out respondents", () => {
  const screener = buildScreenerSurvey("gen-screen");
  const r = generatePopulation(screener, { count: 16, seed: 5 });
  const statuses = Object.keys(r.coverage.endStatuses);
  assert.ok(statuses.length >= 2 || r.coverage.questions.exercised === r.coverage.questions.total,
    `a screener should reach more than one outcome, saw: ${JSON.stringify(r.coverage.endStatuses)}`);
});

test("the edge rate actually changes the data", () => {
  const none = generatePopulation(tracker, { count: 8, seed: 21, edgeRate: 0 });
  const all = generatePopulation(tracker, { count: 8, seed: 21, edgeRate: 1 });
  const sig = (r: ReturnType<typeof generatePopulation>) => JSON.stringify(r.respondents.map((p) => p.sim.state.answers));
  assert.notEqual(sig(none), sig(all), "edgeRate had no effect on the generated answers");
});

test("issues are reported rather than swallowed", () => {
  const r = generatePopulation(demo, { count: 6, seed: 77 });
  // the shape is what matters: every issue names a kind and counts its hits
  for (const i of r.issues) {
    assert.ok(i.kind, "an issue with no kind");
    assert.ok(i.message.length > 10, `unhelpful issue message: ${i.message}`);
    assert.ok(i.count >= 1);
  }
  // a question nobody reached must be reported, not silently absent
  for (const m of r.coverage.questions.missing) {
    assert.ok(r.issues.some((i) => i.questionId === m.id),
      `${m.code} was never asked but no issue explains why`);
  }
});

test("sampleAnswer respects a numeric question's own bounds", () => {
  const q = { id: "n1", type: "numeric", text: "How many?", settings: { minValue: 3, maxValue: 7 }, options: [], rows: [], columns: [] } as never;
  const ctx = { def: demo, state: { answers: {}, calculated: {}, embedded: {} }, loop: null } as never;
  let rngState = 0;
  const rng = () => ((rngState = (rngState * 9301 + 49297) % 233280) / 233280);
  for (let i = 0; i < 50; i++) {
    const v = sampleAnswer(q, ctx, rng, false) as number;
    assert.ok(v >= 3 && v <= 7, `numeric sample ${v} outside [3, 7]`);
  }
  // and an edge respondent sits exactly on a bound
  for (let i = 0; i < 20; i++) {
    const v = sampleAnswer(q, ctx, rng, true) as number;
    assert.ok(v === 3 || v === 7, `edge sample ${v} was not a bound`);
  }
});

test("allocation always sums to its target", () => {
  const q = {
    id: "a1", type: "allocation", text: "Split 100 points", settings: { sumTarget: 100 },
    options: [{ code: "a", label: "A", flags: [] }, { code: "b", label: "B", flags: [] }, { code: "c", label: "C", flags: [] }],
    rows: [], columns: [],
  } as never;
  const ctx = { def: demo, state: { answers: {}, calculated: {}, embedded: {} }, loop: null } as never;
  let s = 1;
  const rng = () => ((s = (s * 16807) % 2147483647) / 2147483647);
  for (let i = 0; i < 40; i++) {
    const v = sampleAnswer(q, ctx, rng, i % 5 === 0) as Record<string, number>;
    const total = Object.values(v).reduce((a, b) => a + b, 0);
    assert.equal(total, 100, `allocation summed to ${total}: ${JSON.stringify(v)}`);
  }
});

import { test } from "node:test";
import assert from "node:assert/strict";
import { buildInsights, buildProjections, detectPattern, projectTrend, PROJECTION_NOTE } from "./insights.js";
import type { DimensionTrend } from "./history.js";
import type { ScorecardResult } from "./scorecard.js";

const trend = (id: string, scores: number[], over: Partial<DimensionTrend> = {}, apart: number[] = []): DimensionTrend => {
  const points = scores.map((score, i) => ({ at: new Date(Date.UTC(2026, i, 1)).toISOString(), wave: "", responseId: `r${i}`, score, percent: null, band: null, comparable: !apart.includes(i), groupMean: null, groupN: null }));
  const likePts = points.filter((p) => p.comparable);
  const last = likePts.at(-1), prev = likePts.at(-2);
  const hib = over.higherIsBetter ?? true;
  const change = last && prev ? { fromAt: prev.at, from: prev.score, to: last.score, delta: last.score - prev.score, direction: (last.score === prev.score ? "same" : (last.score > prev.score) === hib ? "better" : "worse") as "better" | "worse" | "same", text: "" } : null;
  return { id, label: id[0]!.toUpperCase() + id.slice(1), min: 0, max: 10, higherIsBetter: hib, points, change, sinceFirst: null, yearOnYear: null, note: null, ...over };
};
const card = (dims: [string, number | null, boolean?][]): ScorecardResult => ({ v: 1, fingerprint: "f", overall: null, dimensions: dims.map(([id, score, hib = true]) => ({ id, label: id[0]!.toUpperCase() + id.slice(1), score, min: 0, max: 10, percent: score === null ? null : score * 10, band: null, higherIsBetter: hib })) });

test("a pattern needs evidence: three changes running the same way, or a latest change twice the usual", () => {
  assert.deepEqual(detectPattern(trend("energy", [3, 4, 6, 7])), { kind: "sustained", runs: 3, direction: "up" });
  assert.deepEqual(detectPattern(trend("energy", [9, 7, 6, 4, 3])), { kind: "sustained", runs: 4, direction: "down" });
  assert.equal(detectPattern(trend("energy", [3, 4, 6])), null, "two changes are not a pattern");
  assert.equal(detectPattern(trend("energy", [3, 5, 4, 6])), null, "up, down, up");
  assert.deepEqual(detectPattern(trend("energy", [5, 5.5, 5, 5.5, 8])), { kind: "sudden", latest: 2.5, usual: 0.5 });
  assert.equal(detectPattern(trend("energy", [5, 6, 5, 6, 7.5])), null, "one and a half times the usual is not sudden");
  /* below the score's own threshold a change does not count */
  assert.equal(detectPattern(trend("energy", [3, 3.2, 3.4, 3.6]), 1), null);
  /* results scored differently are not part of the run */
  assert.equal(detectPattern(trend("energy", [1, 3, 4, 6], {}, [0])), null);
});

test("sentences state facts about the scores: patterns first, then the change, the strongest, the most room, the standing", () => {
  const result = card([["energy", 9], ["focus", 6], ["pressure", 7, false]]);
  const trends = [trend("energy", [3, 5, 7, 9]), trend("focus", [6, 6]), trend("pressure", [4, 7], { higherIsBetter: false })];
  const out = buildInsights(result, trends, [{ dimension: "energy", everyone: { n: 40, below: 81, above: 9 } }, { dimension: "focus", everyone: { n: 40, below: 80, above: 10 } }]);
  /* energy already has two sentences, so it is not also "the strongest" or "higher than most" */
  assert.deepEqual(out.map((i) => [i.kind, i.dimension, i.tone]), [
    ["sustained", "energy", "better"], ["change", "energy", "better"], ["change", "pressure", "worse"], ["most_room", "pressure", "neutral"], ["standing", "focus", "neutral"],
  ]);
  assert.equal(out[0]!.text, "Energy has moved up in each of your last 4 results.");
  assert.equal(out[1]!.text, "Energy is up 2 since your previous result (from 7 to 9).");
  assert.equal(out[2]!.text, "Pressure is up 3 since your previous result (from 4 to 7).");
  assert.equal(out[3]!.text, "Of your scores, Pressure has the most room to move (7 of 10).");
  assert.equal(out.at(-1)!.text, "Your Focus score is higher than most of the 40 people compared.");
  for (const i of out) assert.ok(!/\b(because|should|must|need to|caused|due to|means you)\b/i.test(i.text), `no cause and no advice: ${i.text}`);
  assert.deepEqual(out[1]!.basis, { from: 7, to: 9, delta: 2 });
});

test("nothing is said that the figures do not support", () => {
  /* one result, close scores, a middling standing: no sentence */
  assert.deepEqual(buildInsights(card([["energy", 7], ["focus", 6.5]]), [trend("energy", [7])], [{ dimension: "energy", everyone: { n: 40, below: 50, above: 40 } }]), []);
  /* a single score has no "strongest" */
  assert.deepEqual(buildInsights(card([["energy", 9]]), null, null), []);
  /* an unscored score, and one with no group figure, are left out */
  const out = buildInsights(card([["energy", 9], ["focus", null], ["calm", 3]]), null, [{ dimension: "focus", everyone: { n: 40, below: 90, above: 5 } }, { dimension: "energy", everyone: null }]);
  assert.deepEqual(out.map((i) => [i.kind, i.dimension]), [["strongest", "energy"], ["most_room", "calm"]]);
  /* "about the same" is not news */
  assert.deepEqual(buildInsights(card([["energy", 7]]), [trend("energy", [7, 7])], null), []);
  /* a less-is-better score: the strongest is the LOWEST number */
  const mixed = buildInsights(card([["stress", 2, false], ["energy", 5]]), null, null);
  assert.deepEqual(mixed.map((i) => [i.kind, i.dimension]), [["strongest", "stress"], ["most_room", "energy"]]);
  assert.equal(buildInsights(card([["a", 9], ["b", 1], ["c", 5]]), null, null, {}, 1).length, 1, "the limit is kept");
});

test("a projection is a range from at least four like results, inside the scale, and says what it is not", () => {
  const p = projectTrend(trend("energy", [4, 5, 6, 7]));
  assert.ok(p.ok); assert.deepEqual([p.ok && p.low, p.ok && p.high, p.ok && p.results], [8, 8, 4]);
  assert.equal(p.text, "If the pattern of your last 4 results continued, your next Energy score would be about 8.");
  const noisy = projectTrend(trend("energy", [5, 5.6, 5.3, 6.1, 5.9]));
  assert.ok(noisy.ok && noisy.low < noisy.middle && noisy.middle < noisy.high && noisy.high - noisy.low < 5);
  assert.match(noisy.text, /would most likely be between [\d.]+ and [\d.]+\.$/);
  /* never outside the possible scores */
  const top = projectTrend(trend("energy", [7, 8, 9, 10]));
  assert.ok(top.ok && top.high <= 10 && top.middle === 10);
  const few = projectTrend(trend("energy", [4, 5, 6]));
  assert.deepEqual([few.ok, !few.ok && few.reason], [false, "few_results"]);
  /* a result scored differently does not count towards the four */
  assert.equal(projectTrend(trend("energy", [1, 4, 5, 6], {}, [0])).ok, false);
  const wild = projectTrend(trend("energy", [1, 9, 2, 8, 3]));
  assert.deepEqual([wild.ok, !wild.ok && wild.reason], [false, "too_variable"]);
  assert.match(wild.text, /vary too much/);
  assert.match(PROJECTION_NOTE, /not a prediction/);
});

test("projections are offered only where they say something: enough results, or results too variable to project", () => {
  const out = buildProjections([trend("energy", [4, 5, 6, 7]), trend("focus", [4, 5]), trend("calm", [1, 9, 2, 8, 3])]);
  assert.deepEqual(out.map((p) => [p.dimension, p.ok]), [["energy", true], ["calm", false]]);
  assert.deepEqual(buildProjections([]), []);
});

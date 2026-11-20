import { test } from "node:test";
import assert from "node:assert/strict";
import { SurveyDefinition } from "@rescript/schema";
import { buildTrends, describeScoreChange, minChanges, nextDue, seriesOf, OVERALL_ID, type HistoryPoint } from "./history.js";
import { computeScorecard, type ScorecardResult } from "./scorecard.js";

const five = (hi = 5) => Array.from({ length: hi }, (_, i) => ({ code: i + 1, label: `Point ${i + 1}` }));
/* the same scale, programmed in different surveys: ids differ, codes do not */
const survey = (idPrefix: string, over: { items?: Record<string, unknown>[]; q2Options?: unknown[]; dim?: Record<string, unknown>; portal?: Record<string, unknown>; overall?: boolean } = {}) => SurveyDefinition.parse({
  meta: { id: idPrefix, code: idPrefix.toUpperCase(), title: "Wellbeing", version: "1", schemaVersion: 1, status: "live" },
  questions: [
    { id: `${idPrefix}-q1`, code: "E1", variableName: "E1", type: "single_select", text: "Energy one", options: five() },
    { id: `${idPrefix}-q2`, code: "E2", variableName: "E2", type: "single_select", text: "Energy two", options: over.q2Options ?? five() },
    { id: `${idPrefix}-q3`, code: "P1", variableName: "P1", type: "single_select", text: "Pressure", options: five() },
  ],
  flow: [{ type: "page", id: "p1", questionIds: [`${idPrefix}-q1`, `${idPrefix}-q2`, `${idPrefix}-q3`] }, { type: "end", id: "e", status: "complete" }],
  portal: {
    enabled: true,
    scorecard: {
      ...(over.overall ? { overall: { label: "Index" } } : {}),
      dimensions: [
        { id: "energy", label: "Energy", source: { kind: "items", items: over.items ?? [{ question: `${idPrefix}-q1` }, { question: `${idPrefix}-q2` }] }, minChange: 2, ...over.dim },
        { id: "pressure", label: "Pressure", higherIsBetter: false, source: { kind: "items", items: [{ question: `${idPrefix}-q3` }] } },
      ],
    },
    ...over.portal,
  },
});
const result = (def: SurveyDefinition, e1: number, e2: number, p1: number | null): ScorecardResult => {
  const [a, b, c] = def.questions.map((q) => q.id);
  return computeScorecard(def, { answers: { [a!]: e1, [b!]: e2, ...(p1 === null ? {} : { [c!]: p1 }) } })!;
};
const point = (at: string, def: SurveyDefinition, e1: number, e2: number, p1: number | null, over: Partial<HistoryPoint> = {}): HistoryPoint => ({ at, wave: "", surveyId: def.meta.id, responseId: `r-${at}`, result: result(def, e1, e2, p1), ...over });

test("a change is worded from the person's side: up or down, better or worse by the score's direction, 'about the same' below the threshold", () => {
  assert.deepEqual(describeScoreChange(7, 9, true, undefined), { delta: 2, direction: "better", text: "Up 2 (from 7 to 9)" });
  assert.deepEqual(describeScoreChange(7, 9, false, undefined), { delta: 2, direction: "worse", text: "Up 2 (from 7 to 9)" });
  assert.deepEqual(describeScoreChange(9, 6.5, false, undefined), { delta: -2.5, direction: "better", text: "Down 2.5 (from 9 to 6.5)" });
  assert.deepEqual(describeScoreChange(7, 8, true, 2), { delta: 1, direction: "same", text: "About the same (7 to 8)" });
  assert.deepEqual(describeScoreChange(7, 9, true, 2).direction, "better", "a change equal to the threshold counts");
  assert.deepEqual(describeScoreChange(7, 7, true, undefined), { delta: 0, direction: "same", text: "The same (7)" });
});

test("one survey taken three times: points oldest first, change against the previous, since the first, and a missing score is not a point", () => {
  const def = survey("a");
  const t = buildTrends([point("2026-09-01T10:00:00Z", def, 4, 5, 2), point("2026-03-01T10:00:00Z", def, 2, 2, 4), point("2026-06-01T10:00:00Z", def, 3, 4, null)], minChanges(def));
  const energy = t.find((x) => x.id === "energy")!, pressure = t.find((x) => x.id === "pressure")!;
  assert.deepEqual(energy.points.map((p) => p.score), [4, 7, 9]);
  assert.ok(energy.points.every((p) => p.comparable));
  assert.deepEqual([energy.change!.text, energy.change!.direction, energy.change!.fromAt], ["Up 2 (from 7 to 9)", "better", "2026-06-01T10:00:00Z"]);
  assert.deepEqual([energy.sinceFirst!.text, energy.sinceFirst!.direction], ["Up 5 (from 4 to 9)", "better"]);
  assert.equal(energy.note, null);
  assert.deepEqual(pressure.points.map((p) => p.score), [4, 2], "the attempt with no pressure answer is not a point");
  assert.deepEqual([pressure.change!.text, pressure.change!.direction], ["Down 2 (from 4 to 2)", "better"]);
  assert.equal(pressure.sinceFirst, null, "the first is the previous: said once");
});

test("one result: a point and no change figure", () => {
  const def = survey("a");
  const [energy] = buildTrends([point("2026-09-01T10:00:00Z", def, 4, 5, 2)]);
  assert.equal(energy!.points.length, 1);
  assert.deepEqual([energy!.change, energy!.sinceFirst, energy!.yearOnYear], [null, null, null]);
});

test("the same scale programmed again in another survey IS comparable: codes and scale ends decide, not ids", () => {
  const y1 = survey("y2025"), y2 = survey("y2026");
  assert.notEqual(y1.questions[0]!.id, y2.questions[0]!.id);
  const [energy] = buildTrends([point("2025-11-10T10:00:00Z", y1, 3, 3, 3, { wave: "2025" }), point("2026-11-12T10:00:00Z", y2, 4, 5, 3, { wave: "2026" })]);
  assert.deepEqual(energy!.points.map((p) => [p.wave, p.score, p.comparable]), [["2025", 6, true], ["2026", 9, true]]);
  assert.equal(energy!.change!.text, "Up 3 (from 6 to 9)");
  assert.equal(energy!.yearOnYear, null, "the year-earlier result is the previous one: said once");
});

test("scored differently = shown, marked, never compared: an item dropped, reversed, a longer scale, another range or direction", () => {
  const now = survey("b");
  const variants: Record<string, SurveyDefinition> = {
    "an item dropped": survey("a", { items: [{ question: "a-q1" }] }),
    "an item reversed": survey("a", { items: [{ question: "a-q1" }, { question: "a-q2", reverse: true }] }),
    "a seven-point item": survey("a", { q2Options: five(7) }),
    "another range": survey("a", { dim: { max: 20 } }),
    "the other direction": survey("a", { dim: { higherIsBetter: false } }),
    "averaged, not added": survey("a", { items: undefined, dim: { source: { kind: "items", method: "mean", items: [{ question: "a-q1" }, { question: "a-q2" }] } } }),
  };
  for (const [what, old] of Object.entries(variants)) {
    const [energy] = buildTrends([point("2026-01-01T10:00:00Z", old, 2, 2, 3), point("2026-06-01T10:00:00Z", now, 4, 5, 3)]);
    assert.deepEqual(energy!.points.map((p) => p.comparable), [false, true], what);
    assert.equal(energy!.change, null, `${what}: no change figure`);
    assert.match(energy!.note!, /1 earlier result was scored differently/);
  }
  /* wording and range names are not scoring */
  const reworded = survey("a", { dim: { label: "Vitality", description: "x", bands: [{ upTo: 5, label: "Low" }, { upTo: 10, label: "High" }], minChange: 1 } });
  const [same] = buildTrends([point("2026-01-01T10:00:00Z", reworded, 2, 2, 3), point("2026-06-01T10:00:00Z", now, 4, 5, 3)]);
  assert.deepEqual(same!.points.map((p) => [p.comparable, p.band]), [[true, "Low"], [true, null]]);
  assert.equal(same!.label, "Energy", "the latest result names the score");
});

test("a mixed history: the change is between the latest and the last LIKE result, skipping the unlike one in between", () => {
  const def = survey("a"), odd = survey("a", { items: [{ question: "a-q1" }] });
  const [energy] = buildTrends([point("2026-01-01T10:00:00Z", def, 2, 2, 3), point("2026-04-01T10:00:00Z", odd, 5, 5, 3), point("2026-08-01T10:00:00Z", def, 4, 4, 3)]);
  assert.deepEqual(energy!.points.map((p) => p.comparable), [true, false, true]);
  assert.equal(energy!.change!.text, "Up 4 (from 4 to 8)");
});

test("year on year: the like result closest to twelve months earlier, within 45 days — otherwise none", () => {
  const def = survey("a");
  const months = buildTrends([point("2025-11-01T10:00:00Z", def, 2, 2, 3), point("2026-05-01T10:00:00Z", def, 3, 3, 3), point("2026-08-01T10:00:00Z", def, 3, 4, 3), point("2026-11-20T10:00:00Z", def, 5, 5, 3)])[0]!;
  assert.equal(months.change!.fromAt, "2026-08-01T10:00:00Z");
  assert.deepEqual([months.yearOnYear!.fromAt, months.yearOnYear!.text], ["2025-11-01T10:00:00Z", "Up 6 (from 4 to 10)"]);
  const none = buildTrends([point("2025-06-01T10:00:00Z", def, 2, 2, 3), point("2026-08-01T10:00:00Z", def, 3, 4, 3), point("2026-11-20T10:00:00Z", def, 5, 5, 3)])[0]!;
  assert.equal(none.yearOnYear, null);
});

test("the headline: first in the list, compared only when the whole scoring is the same", () => {
  const def = survey("a", { overall: true }), other = survey("a", { overall: true, items: [{ question: "a-q1" }] });
  const t = buildTrends([point("2026-01-01T10:00:00Z", def, 1, 1, 5), point("2026-06-01T10:00:00Z", def, 5, 5, 1)]);
  assert.equal(t[0]!.id, OVERALL_ID); assert.deepEqual(t[0]!.points.map((p) => p.score), [0, 100]); assert.equal(t[0]!.change!.direction, "better");
  const mixed = buildTrends([point("2026-01-01T10:00:00Z", other, 1, 1, 5), point("2026-06-01T10:00:00Z", def, 5, 5, 1)]);
  assert.deepEqual(mixed[0]!.points.map((p) => p.comparable), [false, true]);
  assert.equal(mixed.find((x) => x.id === "pressure")!.change!.text, "Down 4 (from 5 to 1)", "a score made the same way is still compared");
});

test("the group's average travels with its point, and only where one was given", () => {
  const def = survey("a");
  const [energy] = buildTrends([point("2026-01-01T10:00:00Z", def, 2, 2, 3, { group: { energy: { mean: 5.5, n: 40 } } }), point("2026-06-01T10:00:00Z", def, 4, 5, 3)]);
  assert.deepEqual(energy!.points.map((p) => [p.groupMean, p.groupN]), [[5.5, 40], [null, null]]);
});

test("a repeated assessment: when the next one is due; the series a survey belongs to", () => {
  const def = survey("a", { portal: { series: { id: "wellbeing", label: "Wellbeing check", period: "2026", repeatEveryDays: 30 } } });
  const now = Date.parse("2026-11-20T10:00:00Z");
  assert.deepEqual(nextDue(def, "2026-11-01T10:00:00Z", now), { at: "2026-12-01T10:00:00.000Z", overdue: false });
  assert.equal(nextDue(def, "2026-10-01T10:00:00Z", now)!.overdue, true);
  assert.equal(nextDue(def, null, now), null); assert.equal(nextDue(survey("a"), "2026-11-01T10:00:00Z", now), null);
  assert.equal(seriesOf(def)!.id, "wellbeing"); assert.equal(seriesOf(survey("a")), null);
  assert.equal(seriesOf(survey("a", { portal: { enabled: false, series: { id: "x", label: "X" } } })), null, "a portal that is off has no series");
  assert.deepEqual(minChanges(def), { energy: 2, pressure: undefined });
});

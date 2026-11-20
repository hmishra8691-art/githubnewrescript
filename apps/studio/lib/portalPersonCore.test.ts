import { test } from "node:test";
import assert from "node:assert/strict";
import { SurveyDefinition } from "@rescript/schema";
import { personResults, PERSON_ATTEMPTS } from "./portalPersonCore.ts";
import type { CompletedRow } from "./portalScoresCore.ts";

const five = () => [1, 2, 3, 4, 5].map((n) => ({ code: n, label: `Point ${n}` }));
const make = (portal: Record<string, unknown> | null, items = [{ question: "e1" }, { question: "e2" }]) => SurveyDefinition.parse({
  meta: { id: "s", code: "S", title: "Index", version: "1", schemaVersion: 1, status: "live" },
  questions: [
    { id: "e1", code: "E1", variableName: "E1", type: "single_select", text: "One", options: five() },
    { id: "e2", code: "E2", variableName: "E2", type: "single_select", text: "Two", options: five() },
  ],
  flow: [{ type: "page", id: "p1", questionIds: ["e1", "e2"] }, { type: "end", id: "e", status: "complete" }],
  ...(portal ? { portal: { enabled: true, scorecard: { dimensions: [{ id: "energy", label: "Energy", source: { kind: "items", items }, bands: [{ upTo: 5, label: "Low" }, { upTo: 10, label: "High" }] }] }, ...portal } } : {}),
});
const row = (id: string, at: string | null, e1: number, e2: number, over: Partial<CompletedRow> = {}): CompletedRow => ({ id, survey_id: "sv", respondent_id: "p1", is_test: false, version_id: "v1", completed_at: at, answers: { e1, e2 }, calculated: {}, embedded: {}, ...over });

test("a person's results: the latest scorecard in full, and the history oldest first with the change", () => {
  /* the member sees scores and range names whatever the respondent's own switches say */
  const live = make({ show: { scores: false, bands: false } });
  const out = personResults([row("b", "2026-06-01T10:00:00Z", 3, 4), row("a", "2026-01-01T10:00:00Z", 1, 2), row("c", "2026-11-01T10:00:00Z", 4, 5)], live, new Map([["v1", make(null)]]));
  assert.deepEqual([out.attempts, out.latestAt], [3, "2026-11-01T10:00:00Z"]);
  assert.deepEqual([out.latest!.dimensions[0]!.score, out.latest!.dimensions[0]!.band?.label], [9, "High"]);
  const [energy] = out.trends;
  assert.deepEqual(energy!.points.map((p) => [p.score, p.band]), [[3, "Low"], [7, "High"], [9, "High"]]);
  assert.equal(energy!.change!.text, "Up 2 (from 7 to 9)"); assert.equal(energy!.sinceFirst!.text, "Up 6 (from 3 to 9)");
});

test("nothing is guessed: an interview whose version cannot be read or that has no completion time is left out; no scorecard, no results", () => {
  const live = make({});
  const out = personResults([row("a", "2026-01-01T10:00:00Z", 1, 2, { version_id: "gone" }), row("b", null, 5, 5), row("c", "2026-11-01T10:00:00Z", 4, 5)], live, new Map([["v1", live]]));
  assert.equal(out.trends[0]!.points.length, 1); assert.equal(out.latest!.dimensions[0]!.score, 9);
  const none = personResults([row("c", "2026-11-01T10:00:00Z", 4, 5)], make(null), new Map([["v1", make(null)]]));
  assert.deepEqual([none.latest, none.trends.length, none.latestAt], [null, 0, null]);
  assert.deepEqual(personResults([], live, new Map()), { attempts: 0, latestAt: null, latest: null, trends: [] });
});

test("only the most recent interviews are read", () => {
  const live = make({});
  const rows = Array.from({ length: PERSON_ATTEMPTS + 5 }, (_, i) => row(`r${i}`, new Date(Date.UTC(2026, 0, 1 + i)).toISOString(), 1 + (i % 5), 3));
  const out = personResults(rows, live, new Map([["v1", live]]));
  assert.equal(out.attempts, PERSON_ATTEMPTS); assert.equal(out.trends[0]!.points.at(-1)!.responseId, `r${PERSON_ATTEMPTS + 4}`);
});

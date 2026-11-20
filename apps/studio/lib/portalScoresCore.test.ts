import { test } from "node:test";
import assert from "node:assert/strict";
import { SurveyDefinition } from "@rescript/schema";
import { calculatedVariables, groupingQuestions, itemKey, liveScoreKey, newScoreId, scorableItems, scorePage, type CompletedRow } from "./portalScoresCore.ts";

const five = () => [1, 2, 3, 4, 5].map((n) => ({ code: n, label: `Point ${n}` }));
const make = (portal: Record<string, unknown> | null, extraQuestions: Record<string, unknown>[] = []) => SurveyDefinition.parse({
  meta: { id: "s", code: "S", title: "Index", version: "1", schemaVersion: 1, status: "live" },
  questions: [
    { id: "e1", code: "E1", variableName: "E1", type: "single_select", text: "<p>I have <b>energy</b></p>", options: five() },
    { id: "g1", code: "G1", variableName: "G1", type: "matrix_single", text: "At work", rows: [{ code: "a", label: "Supported" }, { code: "b", label: "Heard" }], options: five() },
    { id: "team", code: "TEAM", variableName: "TEAM", type: "single_select", text: "Team", options: [{ code: "n", label: "North" }, { code: "s", label: "South" }] },
    { id: "c1", code: "STRESS", variableName: "STRESS", type: "calculated", text: "Stress score" },
    { id: "t1", code: "T1", variableName: "T1", type: "open_text", text: "Notes" },
    ...extraQuestions,
  ],
  flow: [{ type: "page", id: "p1", questionIds: ["e1", "g1", "team", "c1", "t1", ...extraQuestions.map((q) => String(q.id))] }, { type: "end", id: "e", status: "complete" }],
  ...(portal ? { portal } : {}),
});
const card = { enabled: true, scorecard: { dimensions: [{ id: "energy", label: "Energy", source: { kind: "items", items: [{ question: "e1" }] } }] }, benchmark: { enabled: true, groups: [{ id: "team", label: "Team", source: { kind: "question", ref: "team" } }] } };

test("what a score may add up: numeric single-choice questions and each row of a single-choice grid — not text, not lettered codes", () => {
  const items = scorableItems(make(null));
  assert.deepEqual(items.map((i) => i.key), ["e1", "g1::a", "g1::b"]);
  assert.equal(items[0]!.label, "E1 · I have energy");
  assert.equal(items[1]!.label, "G1 · Supported");
  assert.equal(itemKey({ question: "g1", row: "a" }), "g1::a"); assert.equal(itemKey({ question: "e1" }), "e1");
  assert.deepEqual(calculatedVariables(make(null)), [{ code: "STRESS", label: "STRESS · Stress score" }]);
  assert.deepEqual(groupingQuestions(make(null)).map((g) => g.id), ["e1", "team"]);
});

test("a score's id: readable, unique, never empty", () => {
  assert.equal(newScoreId("Énergie au travail!", []), "energie_au_travail");
  assert.equal(newScoreId("Energy", ["energy", "energy_2"]), "energy_3");
  assert.equal(newScoreId("  ", []), "score");
  assert.match(newScoreId("ऊर्जा", []), /^[A-Za-z0-9_-]+$/);
});

const row = (id: string, over: Partial<CompletedRow> = {}): CompletedRow => ({ id, survey_id: "sv", respondent_id: `p-${id}`, is_test: false, version_id: "v1", completed_at: "2026-11-20T10:00:00Z", answers: { e1: 4, team: "n" }, calculated: {}, embedded: {}, ...over });

test("scoring again: each response by the questions of its own version and the settings that are live now", () => {
  const live = make(card);
  const old = make(null); // the version these people answered had no portal at all
  const { upserts, skipped } = scorePage([row("r1"), row("r2", { answers: { e1: 2, team: "s" }, is_test: true }), row("r3", { version_id: "gone" }), row("r4", { version_id: null }), row("r5", { answers: null })], live, new Map([["v1", old]]));
  assert.equal(skipped, 2, "a response whose version cannot be read is skipped, not guessed");
  assert.deepEqual(upserts.map((u) => [u.response_id, u.scores.energy, u.cohort.team, u.is_test, u.respondent_id]), [["r1", 4, "North", false, "p-r1"], ["r2", 2, "South", true, "p-r2"], ["r5", null, null, false, "p-r5"]]);
  assert.ok(upserts.every((u) => u.fingerprint === liveScoreKey(live)), "every row carries the live key, so the portal compares them");
  assert.equal(upserts[0]!.completed_at, "2026-11-20T10:00:00Z");
});

test("no scorecard: nothing is scored and there is no key", () => {
  assert.equal(liveScoreKey(make(null)), null); assert.equal(liveScoreKey(null), null);
  assert.equal(liveScoreKey(make({ enabled: false, scorecard: card.scorecard })), null);
  assert.deepEqual(scorePage([row("r1")], make(null), new Map([["v1", make(null)]])), { upserts: [], skipped: 1 });
});

test("the key changes when the scoring or the grouping changes — not when wording does", () => {
  const base = liveScoreKey(make(card))!;
  assert.equal(liveScoreKey(make({ ...card, scorecard: { dimensions: [{ ...card.scorecard.dimensions[0], label: "Vitality" }] } })), base);
  assert.notEqual(liveScoreKey(make({ ...card, benchmark: { enabled: true, groups: [] } })), base);
  assert.notEqual(liveScoreKey(make({ ...card, scorecard: { dimensions: [{ ...card.scorecard.dimensions[0], source: { kind: "items", method: "mean", items: [{ question: "e1" }] } }] } })), base);
});

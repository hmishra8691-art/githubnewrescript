import { test } from "node:test";
import assert from "node:assert/strict";
import { buildScorecard, describeOverall, readScorecard, SCORE_CAVEAT } from "./scoring.js";
import { buildFeedback } from "./feedback.js";
import { MOCK_TEMPLATES, suggestPractice } from "./mockLibrary.js";
import { isRetentionDue, retentionPlan, retentionWindowMs } from "./sweeps.js";

const REQS = [
  { id: "r1", code: "OWN", title: "Takes ownership", criteria: "Names a mistake of their own.", weight: 2, category: "behavioural" },
  { id: "r2", code: "INC", title: "Learns from incidents", criteria: "Names a root cause and a change.", weight: 1, category: "technical" },
  { id: "r3", code: "TEACH", title: "Explains simply", criteria: "Avoids jargon.", weight: 1, category: "communication" },
  { id: "r4", code: "NOTE", title: "Tracked, not scored", criteria: "Anything.", weight: 0, category: "general" },
];

/* ------------------------------------------------------------- scoring */

test("A SCORE IS MADE ONLY OF QUOTED EVIDENCE, and names the rows it came from", () => {
  const card = buildScorecard(REQS, [
    { id: "e1", requirementId: "r1", responseId: "a1", questionId: "q1", verdict: "evidence", quote: "I broke the deploy and owned it." },
    { id: "e2", requirementId: "r2", responseId: "a2", questionId: "q2", verdict: "partial", quote: "we added an alert" },
    /* an insufficient row: the model could not quote anything, so it moves nothing */
    { id: "e3", requirementId: "r3", responseId: "a2", questionId: "q2", verdict: "insufficient", quote: null },
    /* weight zero: assessed, shown, does not move the number */
    { id: "e4", requirementId: "r4", responseId: "a1", questionId: "q1", verdict: "evidence", quote: "noted" },
  ]);

  /* weighted: r1 (2×100) + r2 (1×50) + r3 (1×0) over weight 4 = 62.5 → 63 */
  assert.equal(card.overall, 63);
  assert.deepEqual(card.evidenceIds.sort(), ["e1", "e2", "e4"], "every id that moved a number is named");
  const r1 = card.requirements.find((r) => r.code === "OWN")!;
  assert.deepEqual(r1.quotes.map((q) => q.quote), ["I broke the deploy and owned it."]);
  const r3 = card.requirements.find((r) => r.code === "TEACH")!;
  assert.equal(r3.points, 0);
  assert.deepEqual(r3.evidenceIds, [], "insufficient rests on nothing");
  assert.equal(r3.wouldHaveShown, "Avoids jargon.", "the gap says what a stronger answer contains — from the criteria, not invented");
  assert.equal(card.coverage.unscored, 1);
});

test("a partial finding does not support an evidence verdict on the same requirement", () => {
  const card = buildScorecard(REQS.slice(0, 1), [
    { id: "p", requirementId: "r1", responseId: "a1", verdict: "partial", quote: "sort of" },
    { id: "e", requirementId: "r1", responseId: "a2", verdict: "evidence", quote: "fully" },
  ]);
  const r = card.requirements[0]!;
  assert.equal(r.verdict, "evidence", "strongest wins");
  assert.deepEqual(r.evidenceIds, ["e"], "only rows AT the best verdict are listed as its support");
});

test("category scores are weighted means within the category; empty categories are omitted", () => {
  const card = buildScorecard(REQS, [
    { id: "e1", requirementId: "r1", responseId: "a1", verdict: "evidence", quote: "x" },
  ]);
  const beh = card.categories.find((c) => c.category === "behavioural")!;
  assert.equal(beh.score, 100);
  const tech = card.categories.find((c) => c.category === "technical")!;
  assert.equal(tech.score, 0);
  const general = card.categories.find((c) => c.category === "general")!;
  assert.equal(general.score, null, "a category whose requirements all weigh zero has no score");
  assert.equal(card.categories.some((c) => c.category === "domain"), false, "nothing in it, not shown");
});

test("no weighted requirement means no overall — coverage only, and the basis says so", () => {
  const card = buildScorecard([REQS[3]!], [
    { id: "e", requirementId: "r4", responseId: "a1", verdict: "evidence", quote: "x" },
  ]);
  assert.equal(card.overall, null);
  assert.match(card.basis, /no overall score/i);
  assert.match(describeOverall(card), /No overall score/);
});

test("per-question scores say which requirements THIS answer gave evidence for", () => {
  const card = buildScorecard(REQS, [
    { id: "e1", requirementId: "r1", responseId: "a1", questionId: "q1", verdict: "evidence", quote: "x" },
    { id: "e2", requirementId: "r2", responseId: "a1", questionId: "q1", verdict: "partial", quote: "y" },
    { id: "e3", requirementId: "r3", responseId: "a2", questionId: "q2", verdict: "insufficient" },
  ]);
  const q1 = card.questions.find((q) => q.responseId === "a1")!;
  assert.deepEqual(q1.demonstrated, ["r1"]);
  assert.deepEqual(q1.partial, ["r2"]);
  assert.equal(q1.score, 75);
  const q2 = card.questions.find((q) => q.responseId === "a2")!;
  assert.equal(q2.score, 0);
  assert.deepEqual(q2.evidenceIds, []);
});

test("the caveat says what a zero means — words not found, not skill absent", () => {
  assert.match(SCORE_CAVEAT, /not that the person lacks the skill/);
  assert.match(SCORE_CAVEAT, /not a ranking and not a decision/);
});

test("a stored scorecard is read back defensively", () => {
  assert.equal(readScorecard(null), null);
  assert.equal(readScorecard({ overall: 50 }), null, "missing requirements → not a scorecard");
  const card = buildScorecard(REQS, []);
  assert.ok(readScorecard(JSON.parse(JSON.stringify(card))));
});

/* ------------------------------------------------------------ feedback */

test("feedback talks about the ANSWER, never the person", () => {
  const card = buildScorecard(REQS, [
    { id: "e1", requirementId: "r1", responseId: "a1", verdict: "evidence", quote: "I owned it" },
    { id: "e2", requirementId: "r2", responseId: "a2", verdict: "partial", quote: "we added an alert" },
  ]);
  const fb = buildFeedback(card);
  assert.equal(fb.didWell[0]!.code, "OWN");
  assert.deepEqual(fb.didWell[0]!.quotes, ["I owned it"]);
  assert.ok(fb.needsWork.some((f) => f.code === "TEACH"));
  const change = fb.recommendedChanges.find((c) => c.includes("Explains simply"))!;
  assert.match(change, /a stronger answer would include avoids jargon\./i);
  assert.doesNotMatch(fb.recommendedChanges.join(" "), /you lack|you cannot|you are not/i);
  assert.match(fb.caveat, /not that you cannot do the thing/);
});

test("practice suggestions follow the weak categories and never repeat the template just taken", () => {
  const next = suggestPractice("swe_backend_behavioural", ["communication"]);
  assert.ok(next.length > 0 && next.length <= 3);
  assert.ok(next.every((t) => t.key !== "swe_backend_behavioural"));
  assert.ok(next.every((t) => t.requirements.some((r) => r.category === "communication")));
});

test("every mock template's requirements carry criteria — the analysis is shown nothing else", () => {
  for (const t of MOCK_TEMPLATES) {
    assert.ok(t.questions.length >= 3, `${t.key} has too few questions`);
    for (const r of t.requirements) {
      assert.ok(r.criteria.trim().length > 20, `${t.key}/${r.code} needs real criteria`);
    }
    const codes = t.questions.map((q) => q.code);
    assert.equal(new Set(codes).size, codes.length, `${t.key} has duplicate question codes`);
  }
});

/* ----------------------------------------------------------- retention */

test("hours win over days, and neither means never", () => {
  assert.equal(retentionWindowMs(7, null), 7 * 86_400_000);
  assert.equal(retentionWindowMs(90, 24), 24 * 3_600_000, "24 hours beats 90 days when both are set");
  assert.equal(retentionWindowMs(null, null), null);
  assert.equal(retentionWindowMs(0, 0), null);
});

test("AN UNFINISHED INTERVIEW IS DUE FROM ITS LAST ACTIVITY — it used to be exempt for ever", () => {
  const now = new Date("2026-09-17T12:00:00Z");
  const abandoned = { completedAt: null, lastActivityAt: "2026-09-01T12:00:00Z", mediaPurgedAt: null };
  assert.equal(isRetentionDue(abandoned, 7, now), true);
  /* the old signature — completion only — still works for callers that have nothing else */
  assert.equal(isRetentionDue({ completedAt: "2026-09-01T12:00:00Z", mediaPurgedAt: null }, 7, now), true);
  assert.equal(isRetentionDue({ completedAt: "2026-09-16T12:00:00Z", mediaPurgedAt: null }, 7, now), false);
  /* a 24-hour policy, in hours */
  assert.equal(isRetentionDue({ completedAt: "2026-09-16T10:00:00Z", mediaPurgedAt: null }, null, now, 24), true);
  assert.equal(isRetentionDue({ completedAt: "2026-09-16T13:00:00Z", mediaPurgedAt: null }, null, now, 24), false);
});

test("the wider scope defaults to false for everything that is not media", () => {
  const plan = retentionPlan({ media: true });
  assert.equal(plan.identity, false);
  assert.equal(plan.telemetry, false);
  assert.equal(plan.responses, false);
  const full = retentionPlan({ media: true, transcripts: true, responses: true, telemetry: true, identity: true });
  assert.equal(full.identity, true);
  assert.equal(full.empty, false);
  assert.equal(retentionPlan({ media: false }).empty, true);
});

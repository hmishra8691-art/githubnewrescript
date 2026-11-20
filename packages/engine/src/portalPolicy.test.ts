import { test } from "node:test";
import assert from "node:assert/strict";
import { SurveyDefinition } from "@rescript/schema";
import { answerAsText, editDecision, editWindow, portalAnswerLines, portalEditInput, portalSettings, questionContainers } from "./portalPolicy.js";

const NOW = Date.parse("2026-11-20T10:00:00Z");
const at = (hours: number) => new Date(NOW + hours * 3_600_000).toISOString();

const make = (portal: Record<string, unknown> | undefined, extra: Record<string, unknown> = {}) => SurveyDefinition.parse({
  meta: { id: "s", code: "S", title: "Wellbeing", version: "1", schemaVersion: 1, status: "live" },
  questions: [
    { id: "q1", code: "Q1", variableName: "Q1", type: "single_select", text: "<p>Do you own a car?</p>", options: [{ code: 1, label: "Yes" }, { code: 2, label: "No" }] },
    { id: "q2", code: "Q2", variableName: "Q2", type: "multi_select", text: "Which brands?", options: [{ code: "a", label: "Alfa" }, { code: "b", label: "<b>Beta</b>" }] },
    { id: "q3", code: "Q3", variableName: "Q3", type: "open_text", text: "Anything else?" },
    { id: "q4", code: "Q4", variableName: "Q4", type: "calculated", text: "Score" },
  ],
  flow: [
    { type: "block", id: "b1", title: "About you", children: [{ type: "page", id: "p1", questionIds: ["q1", "q2"] }] },
    { type: "page", id: "p2", questionIds: ["q3", "q4"] },
    { type: "end", id: "e", status: "complete" },
  ],
  ...(portal ? { portal } : {}),
  ...extra,
});
const done = { status: "complete", completedAt: at(-2) };
const free = { lockedAt: null, reopenedUntil: null };

test("no portal, or a portal with editing off: nothing can be changed — the default is the careful one", () => {
  assert.equal(portalSettings(make(undefined)), null);
  assert.equal(portalSettings(make({ enabled: false })), null);
  const off = editDecision(make(undefined), "q1", done, free, NOW);
  assert.equal(off.allowed, false); assert.equal(!off.allowed && off.code, "no_portal");
  const d = editDecision(make({ enabled: true }), "q1", done, free, NOW);
  assert.equal(!d.allowed && d.code, "editing_off");
});

test("the four editing modes: none, until a deadline, a window after submission, until the researcher locks", () => {
  const dl = (deadline: string) => editWindow(make({ enabled: true, editing: { mode: "until_deadline", deadline } }), done, free, NOW);
  assert.deepEqual(dl(at(5)), { allowed: true, until: at(5), reopened: false });
  assert.equal(!dl(at(-1)).allowed && (dl(at(-1)) as { code: string }).code, "deadline_passed");

  const win = (hours: number) => editWindow(make({ enabled: true, editing: { mode: "window", windowHours: hours } }), done, free, NOW);
  assert.deepEqual(win(3), { allowed: true, until: at(1), reopened: false });
  assert.equal((win(1) as { code: string }).code, "window_passed");

  const open = editWindow(make({ enabled: true, editing: { mode: "until_locked" } }), done, free, NOW);
  assert.deepEqual(open, { allowed: true, until: null, reopened: false });
  const lockedAll = editWindow(make({ enabled: true, editing: { mode: "until_locked", lockedAt: at(-1) } }), done, free, NOW);
  assert.equal((lockedAll as { code: string }).code, "locked_for_all");
});

test("a researcher's lock on one respondent refuses; their reopening overrides the mode — but never a question or section lock", () => {
  const def = make({ enabled: true, editing: { mode: "until_locked", lockedQuestions: ["q3"], lockedSections: ["b1"] } });
  const locked = editDecision(def, "q3", done, { lockedAt: at(-1), reopenedUntil: null }, NOW);
  assert.equal((locked as { code: string }).code, "locked_by_researcher");

  const closed = make({ enabled: true, editing: { mode: "none" } });
  const reopened = editDecision(closed, "q3", done, { lockedAt: at(-1), reopenedUntil: at(4) }, NOW);
  assert.deepEqual(reopened, { allowed: true, until: at(4), reopened: true });
  assert.equal(editDecision(closed, "q3", done, { lockedAt: null, reopenedUntil: at(-1) }, NOW).allowed, false, "a reopening that has run out is over");

  const re = { lockedAt: null, reopenedUntil: at(4) };
  assert.equal((editDecision(def, "q3", done, re, NOW) as { code: string }).code, "question_locked");
  assert.equal((editDecision(def, "q1", done, re, NOW) as { code: string }).code, "section_locked", "q1 is on a page inside block b1");
  assert.deepEqual(questionContainers(def).get("q1"), ["p1", "b1"]);
});

test("only-these lists, calculated questions, unknown questions, unfinished and screened-out interviews", () => {
  const def = make({ enabled: true, editing: { mode: "until_locked", onlyQuestions: ["q3"] } });
  assert.equal(editDecision(def, "q3", done, free, NOW).allowed, true);
  assert.equal((editDecision(def, "q1", done, free, NOW) as { code: string }).code, "question_locked");
  assert.equal((editDecision(make({ enabled: true, editing: { mode: "until_locked" } }), "q4", done, free, NOW) as { code: string }).code, "not_editable");
  assert.equal((editDecision(def, "nope", done, free, NOW) as { code: string }).code, "unknown_question");
  assert.equal((editDecision(def, "q3", { status: "in_progress", completedAt: null }, free, NOW) as { code: string }).code, "not_completed");
  assert.equal((editDecision(def, "q3", { status: "screened", completedAt: at(-1) }, free, NOW) as { code: string }).code, "not_completed");
});

test("a scored test is never edited after submission, whatever the settings or a reopening", () => {
  const def = make({ enabled: true, editing: { mode: "until_locked" } }, { assessment: { enabled: true } });
  const d = editDecision(def, "q1", done, { lockedAt: null, reopenedUntil: at(4) }, NOW);
  assert.equal((d as { code: string }).code, "scored_test");
});

test("answers are shown back as words, in order, without hidden or calculated questions or raw JSON", () => {
  const def = make({ enabled: true, show: { answers: true }, editing: { mode: "until_locked", lockedQuestions: ["q1"] } });
  const lines = portalAnswerLines(def, { q1: 2, q2: ["a", "b"], q3: "  ", q4: 17 }, done, free, NOW);
  assert.deepEqual(lines.map((l) => [l.code, l.text, l.answer, l.edit.allowed]), [["Q1", "Do you own a car?", "No", false], ["Q2", "Which brands?", "Alfa, Beta", true]]);
  assert.equal(lines[0]!.input, null, "a locked answer carries no control");
  assert.deepEqual(lines[1]!.input, { kind: "multi", options: [{ code: "a", label: "Alfa" }, { code: "b", label: "Beta" }], value: ["a", "b"] });
  assert.deepEqual(portalEditInput(def.questions[0]!, 2), { kind: "single", options: [{ code: 1, label: "Yes" }, { code: 2, label: "No" }], value: 2 });
  assert.deepEqual(portalEditInput(def.questions[2]!, "hello"), { kind: "text", long: true, value: "hello" });
  assert.equal(portalEditInput(def.questions[2]!, { mediaId: "m1" }), null, "a recording is not edited as text");
  const q2 = def.questions[1]!;
  assert.equal(answerAsText(q2, null), "");
  assert.equal(answerAsText(def.questions[2]!, { mediaId: "m1", transcript: { text: "I said this" } }), "I said this");
  assert.equal(answerAsText(def.questions[2]!, { mediaId: "m1" }), "A file or recording was provided.");
  assert.equal(answerAsText(def.questions[2]!, "x".repeat(900)).length, 600);
});

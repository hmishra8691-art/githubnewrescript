import { test } from "node:test";
import assert from "node:assert/strict";
import { SurveyDefinition } from "@rescript/schema";
import { applySurveyActions, coerceSurveyActions } from "@rescript/engine";
import { parseTranscript } from "@rescript/analytics";
import { excerptsCiting, launchRow, liveView, parseInterviewAction, summaryOf, transcriptText, turnsView, type SessionRow, type StudyRow, type TurnRow } from "./view.ts";

/*
 * THE STUDIO'S AI-INTERVIEW VIEWS (2026-10-22): a launch snapshots the guide and refuses without consent;
 * the live view counts real interviews only (tests apart, excluded never a complete) with quotas and links;
 * a member without contact details reads transcripts redacted; the sandbox's transcript text imports with
 * its speakers and times.
 */
const guideDef = (consent = { statement: "Voluntary.", recordingDisclosure: "Audio recorded." }) => {
  const def = SurveyDefinition.parse({ meta: { id: "g", code: "G", title: "Switching" }, questions: [], flow: [{ type: "end", id: "e", status: "complete" }] });
  const c = coerceSurveyActions([
    { op: "create_qual_guide", kind: "interview", consent, objectives: ["Understand what triggers switching"], sections: [{ title: "Intro", kind: "opening" }, { title: "Triggers", questions: ["Tell me about switching."] }, { title: "Close", kind: "closing", questions: ["Anything else?"] }] },
    { op: "configure_ai_interviews", modes: ["text", "voice"], targetCompletes: 2, quotas: [{ segment: "Payers", target: 1 }], screener: [{ text: "Who pays?", options: [{ label: "I do", segment: "Payers" }, { label: "Someone else", qualifies: false }] }] },
  ]);
  return applySurveyActions(def, c.actions).def;
};

test("launch: a snapshot of the guide + its AI settings, quotas; refused without a consent statement", () => {
  const r = launchRow(guideDef(), "u1");
  assert.ok(r.ok);
  if (!r.ok) return;
  assert.equal((r.row.guide as { aiModeration: { targetCompletes: number } }).aiModeration.targetCompletes, 2);
  assert.deepEqual(r.quotas, [{ segment: "Payers", target: 1 }]);
  assert.equal(r.row.status, "live"); assert.equal(r.row.launched_by, "u1");
  assert.ok(r.estimateUsd > 0 && r.estimateUsd < 1, String(r.estimateUsd));
  const no = launchRow(guideDef({ statement: "", recordingDisclosure: "x" } as never), "u1");
  assert.ok(!no.ok && no.blocking.some((b) => /consent statement/.test(b)));
});

const study: StudyRow = { id: "st", survey_id: "sv", title: "Switching", status: "live", link_token: "a".repeat(36), test_token: "b".repeat(36), guide: guideDef().qualStudy, guide_language: "en", spent_usd: "0.0420", launched_at: "2026-10-22T10:00:00Z", closed_at: null };
const row = (o: Partial<SessionRow>): SessionRow => ({ id: "s", status: "completed", mode: "text", language: "en", excluded: false, is_test: false, flags: [], state: { covered: ["O1"] }, turns_count: 6, cost_usd: "0.01", started_at: "2026-10-22T10:00:00Z", last_activity_at: "2026-10-22T10:12:00Z", completed_at: "2026-10-22T10:12:00Z", qual_transcript_id: "qt", ai_interview_participants: { number: 1, segment: "Payers" }, ...o });

test("the live view: counts (tests apart, excluded never complete, alerts), quotas, links, summaries", () => {
  const v = liveView(study, [
    row({ id: "a" }),
    row({ id: "b", status: "in_progress", completed_at: null, ai_interview_participants: [{ number: 2, segment: "Payers" }] }),
    row({ id: "c", excluded: true, ai_interview_participants: { number: 3, segment: null } }),
    row({ id: "d", status: "flagged", flags: [{ kind: "distress", severity: "alert", at: 3, note: "x" }] }),
    row({ id: "e", status: "screened_out" }),
    row({ id: "f", is_test: true }),
  ], "https://run.example.com/");
  assert.equal(v.study!.link, `https://run.example.com/i/${"a".repeat(36)}`);
  assert.equal(v.study!.testLink, `https://run.example.com/i/${"a".repeat(36)}?test=${"b".repeat(36)}`);
  assert.equal(v.study!.spentUsd, 0.042);
  assert.deepEqual(v.counts, { started: 4, inProgress: 1, completed: 1, screenedOut: 1, abandoned: 0, flagged: 1, ended: 0, excluded: 1, tests: 1, alerts: 1 });
  assert.deepEqual(v.quotas, [{ segment: "Payers", target: 1, completed: 1, inProgress: 1 }]);
  assert.equal(v.target, 2);
  const s = summaryOf(row({}));
  assert.equal(s.participant, "P1"); assert.equal(s.minutes, 12); assert.deepEqual(s.covered, ["O1"]); assert.equal(s.costUsd, 0.01);
  assert.deepEqual(liveView(null, [], "x").study, null);
});

test("transcripts: redacted for a member without contact details (text, STT original, translation); actions parsed", () => {
  const turns: TurnRow[] = [
    { seq: 2, speaker: "participant", text: "Mail anna@example.com, I'm Anna Smith", original_text: "mail anna at example dot com", translation: "Anna Smith here", language: "en", offset_ms: 9000, duration_ms: 3000, decision: null, audio_media_id: "m", video_media_id: null },
    { seq: 1, speaker: "moderator", text: "Hi", original_text: null, translation: null, language: "en", offset_ms: 0, duration_ms: null, decision: { intent: "open", source: "rules" }, audio_media_id: null, video_media_id: null },
  ];
  const red = turnsView(turns, { pii: false, names: ["Anna Smith"] });
  assert.deepEqual(red.map((t) => t.seq), [1, 2]);
  assert.equal(red[1].text, "Mail [email], I'm [name]"); assert.equal(red[1].translation, "[name] here"); assert.ok(red[1].hasAudio);
  assert.equal(turnsView(turns, { pii: true })[1].text, "Mail anna@example.com, I'm Anna Smith");
  assert.deepEqual(parseInterviewAction({ action: "exclude", reason: " speeder " }), { action: "exclude", reason: "speeder" });
  assert.ok("error" in parseInterviewAction({ action: "delete" }));
  assert.equal(excerptsCiting([{ sourceId: "qt" }, { sourceId: "x" }, { sourceId: "qt" }], "qt"), 2);
});

test("the sandbox's transcript text imports with speakers, roles and times", () => {
  const text = transcriptText([{ speaker: "Moderator", start: 0, text: "Hi, tell me about switching." }, { speaker: "P1", start: 75.4, text: "The price went up\ntwice." }]);
  assert.equal(text, "[00:00:00] Moderator: Hi, tell me about switching.\n[00:01:15] P1: The price went up twice.");
  const p = parseTranscript(text);
  assert.deepEqual(p.turns.map((t) => [t.speaker, t.start]), [["Moderator", 0], ["P1", 75]]);
});

test("a transcript written by an AI interview reads as one in the workspace, with roles and the segment as group", async () => {
  const { toWorkspace } = await import("../qual/qualWorkspace.ts");
  const ws = toWorkspace({ sessions: [], coding: null, events: [], transcripts: [{ id: "qt", session_id: null, title: "AI interview — P2 (Payers)", source: "ai_interview", format: "ai_interview", language: "en", status: "ready", error: null, char_count: 10, media_id: null, meta: { warnings: ["AI-moderated interview"] }, segments: [{ id: "t1", index: 0, speaker: "Moderator", start: 0, text: "Hi" }, { id: "t2", index: 1, speaker: "P2", start: 5, text: "The price" }], speakers: { Moderator: { role: "moderator" }, P2: { role: "participant", group: "Payers" } } }] }, { pii: true });
  assert.equal(ws.transcripts[0].source, "ai_interview");
  assert.deepEqual(ws.transcripts[0].segments.map((s) => [s.role, s.group ?? null]), [["moderator", null], ["participant", "Payers"]]);
});

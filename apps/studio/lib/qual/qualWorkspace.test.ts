import test from "node:test";
import assert from "node:assert/strict";
import { quoteMatchesSegment } from "@rescript/analytics";
import {
  importTranscript, sttTranscript, openEndsTranscript, parseSessionInput, parseSpeakerEdit, parseCodingRequest,
  toWorkspace, segmentsOf, speakerMap, missingQualMigration, allSegments, type TranscriptRow, type SessionRow,
} from "./qualWorkspace.ts";

/*
 * THE QUALITATIVE WORKSPACE'S PURE HALF (2026-10-18): imports become segments with speakers and
 * timestamps kept; the speaker map is suggested and editable; a member without contact details reads
 * redacted text; request bodies are validated before anything is written.
 */

const SESSION: SessionRow = { id: "s1", kind: "interview", title: "IDI 1", scheduled_at: "2026-10-10T09:00:00.000Z", moderator: "Dr Lee", participants: [{ id: "p1", label: "Anna", segment: "Switchers" }], consent: { captured: true, recording: true, method: "verbal, on the recording" }, notes: "Anna mentioned her email anna@example.com", observations: [{ at: "00:12:30", text: "hesitated" }], status: "completed", recording_media_id: null };

test("an import: format detected, segments t1…tn with speakers and timestamps, the moderator suggested, the group from the session's participants", () => {
  const r = importTranscript({ text: "[00:00:05] Moderator: Why did you switch?\n[00:00:09] Anna: The price went up. Call me on 020 7946 0958.\nModerator: Thanks.", fileName: "idi-1.txt", sessionId: "s1", participants: [{ id: "p1", label: "Anna", segment: "Switchers" }] });
  assert.ok(r.ok);
  const v = r.ok ? r.value : null!;
  assert.equal(v.format, "speaker");
  assert.equal(v.title, "idi-1");
  assert.deepEqual(v.segments.map((s) => [s.id, s.speaker, s.start ?? null]), [["t1", "Moderator", 5], ["t2", "Anna", 9], ["t3", "Moderator", null]]);
  assert.deepEqual(v.speakers, { Moderator: { role: "moderator" }, Anna: { role: "participant", group: "Switchers" } });
  assert.equal(v.session_id, "s1");
  assert.equal(importTranscript({ text: "   " }).ok, false);
  const vtt = importTranscript({ text: "WEBVTT\n\n00:00:01.000 --> 00:00:02.000\n<v P1>Hi</v>\n", format: "vtt", title: "Group 1" });
  assert.ok(vtt.ok && vtt.value.format === "vtt" && vtt.value.segments[0].speaker === "P1");
  const docx = importTranscript({ text: "Moderator: Hello\nP2: Hi", fromDocx: true, fileName: "g.docx" });
  assert.ok(docx.ok && docx.value.format === "docx");
});

test("speech-to-text: diarized segments kept with timings; an undiarized result says so; open ends become response segments", () => {
  const t = sttTranscript({ text: "a b", model: "fake-stt", language: "en", diarized: true, speakerCount: 2, segments: [{ start: 0, end: 2.5, text: "Hello there.", speaker: "Speaker 1" }, { start: 2.5, end: 5, text: "Hi.", speaker: "Speaker 2" }] }, "IDI 1 (transcribed)");
  assert.deepEqual(t.segments.map((s) => [s.id, s.speaker, s.start, s.end]), [["t1", "Speaker 1", 0, 2.5], ["t2", "Speaker 2", 2.5, 5]]);
  assert.equal(t.meta.diarized, true);
  assert.ok(t.meta.warnings.some((w) => /mishear/.test(w)));
  const flat = sttTranscript({ text: "Everything in one.", model: "m" }, "x");
  assert.deepEqual(flat.segments, [{ id: "t1", index: 0, text: "Everything in one." }]);
  assert.ok(flat.meta.warnings.some((w) => /did not separate speakers/.test(w)));
  const oe = openEndsTranscript([{ id: "r1", answers: { q5: "Too slow in the evening" } }, { id: "r2", answers: { q5: "" } }], [{ id: "q5", code: "Q5" }]);
  assert.ok(oe.ok);
  assert.deepEqual(oe.ok && oe.value.segments.map((s) => [s.id, s.responseId, s.questionId]), [["r1:q5", "r1", "q5"]]);
  assert.equal(openEndsTranscript([], []).ok, false);
});

const row = (): TranscriptRow => {
  const r = importTranscript({ text: "Moderator: Why?\nAnna: Because Anna Smith at anna@example.com was ignored.\nBen: I stayed.", participants: [{ id: "p1", label: "Anna", segment: "Switchers" }] });
  assert.ok(r.ok);
  const v = r.ok ? r.value : null!;
  return { id: "tr1", session_id: "s1", title: v.title, source: "import", format: v.format, language: null, segments: v.segments, speakers: v.speakers, status: "ready", error: null, char_count: v.char_count, media_id: null, meta: v.meta };
};

test("the workspace: segments read through the speaker map; a member without contact details reads redacted text and aliased names", () => {
  const coding = { codebook: { version: 2, method: "inductive", codes: [{ id: "c1", name: "Ignored", definition: "", status: "ai_suggested", origin: "inductive" }], themes: [], relationships: [] }, excerpts: [{ id: "x1", codeId: "c1", sourceKind: "transcript", sourceId: "tr1", segmentId: "t2", speaker: "Anna", charStart: 8, charEnd: 47, quote: "Anna Smith at anna@example.com was igno", coder: "ai", status: "ai_suggested" }], version: 7, settings: { redactNames: ["Anna Smith", "Anna"] } };
  const rows = { sessions: [SESSION], transcripts: [row()], coding, events: [{ actor: "u1", actor_label: "Dr Lee", action: "add_code", detail: "Coded “Anna Smith at anna@example.com” as Ignored", ids: [], created_at: "2026-10-18T10:00:00Z" }] };
  const full = toWorkspace(rows, { pii: true });
  assert.equal(full.pii, true);
  assert.deepEqual(full.settings, { redactNames: ["Anna Smith", "Anna"] });
  assert.equal(full.version, 7);
  const segs = allSegments(full);
  assert.deepEqual(segs.map((s) => [s.id, s.role, s.group ?? null]), [["t1", "moderator", null], ["t2", "participant", "Switchers"], ["t3", "participant", null]]);
  assert.ok(quoteMatchesSegment(full.state.excerpts[0], segs[1].text), "the stored quote is the exact span");
  const red = toWorkspace(rows, { pii: false });
  assert.equal(red.pii, false);
  assert.equal(red.settings, null, "the names list is itself personal data");
  const rs = allSegments(red);
  assert.equal(rs[1].speaker, "Participant 1");
  assert.equal(rs[1].text, "Because [name] at [email] was ignored.");
  assert.equal(red.state.excerpts[0].quote, "[name] at [email] was igno");
  assert.equal(red.state.excerpts[0].speaker, "Participant 1");
  assert.equal(red.sessions[0].participants[0].label, "Participant 1");
  assert.equal(red.sessions[0].notes, "[name] mentioned her email [email]");
  assert.equal(red.history[0].detail, "Coded “[name] at [email]” as Ignored");
  assert.ok(!JSON.stringify(red).includes("anna@example.com") && !JSON.stringify(red).includes("Anna Smith"), "nothing identifying travels");
});

test("speaker edits, session bodies, coding requests and the missing-migration message", () => {
  const r = row();
  const map = speakerMap(r);
  const ok = parseSpeakerEdit({ Ben: { role: "participant", group: "Stayers" } }, map);
  assert.ok(ok.ok && ok.value.Ben.group === "Stayers");
  assert.deepEqual(segmentsOf({ ...r, speakers: ok.ok ? ok.value : {} }).find((s) => s.speaker === "Ben")?.group, "Stayers");
  assert.equal(parseSpeakerEdit({ Zoe: { role: "participant" } }, map).ok, false);
  assert.equal(parseSpeakerEdit({ Ben: { role: "boss" } }, map).ok, false);
  const s = parseSessionInput({ title: "Group 2", kind: "focus_group", scheduledAt: "2026-10-20T18:00:00Z", participants: ["P1", { label: "P2", segment: "Stayers" }], consent: { captured: true, recording: false } }, true);
  assert.ok(s.ok);
  assert.deepEqual(s.ok && s.value.participants, [{ id: "p1", label: "P1" }, { id: "p2", label: "P2", segment: "Stayers" }]);
  assert.equal(parseSessionInput({}, true).ok, false);
  assert.equal(parseSessionInput({}, false).ok, false);
  assert.equal(parseSessionInput({ status: "live" }, false).ok, false);
  assert.equal(parseSessionInput({ scheduledAt: "not a date" }, false).ok, false);
  assert.deepEqual(parseCodingRequest({ version: 3, mode: "deductive", framework: "COM-B", sourceIds: ["tr1"] }), { ok: true, value: { mode: "deductive", framework: "COM-B", sourceIds: ["tr1"], version: 3 } });
  assert.equal(parseCodingRequest({ mode: "inductive" }).ok, false, "the version read is required");
  assert.ok(missingQualMigration('relation "public.qual_codings" does not exist'));
  assert.ok(!missingQualMigration("duplicate key value"));
});

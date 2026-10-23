import test from "node:test";
import assert from "node:assert/strict";
import { interpretQualRequest } from "@rescript/engine";
import { readScheduleInput, guideSnapshot, joinProblems, newRoomState } from "@rescript/analytics/live";
import { qualPreview } from "../copilot/qualCard.ts";

/*
 * LIVE SESSIONS IN INTELLIGENT MODE (2026-10-22, G2): "schedule two focus groups of 6 next Tuesday 6 pm IST with
 * Mumbai and Delhi segments" → a preview card (local times, instants, sizes, segments, what is missing) that
 * creates exactly what it showed — and the card's sessions pass the server's own scheduling check.
 */
const data = { state: { codebook: { version: 0, method: "inductive" as const, themes: [], codes: [], relationships: [] }, excerpts: [] }, segments: [], objectives: [], aiReady: true, sandbox: false, now: Date.UTC(2026, 9, 22, 9, 0), timeZone: "Europe/London" };

test("the brief's sentence becomes a runnable preview: two sessions, IST, Mumbai then Delhi, six links each", () => {
  const req = interpretQualRequest("schedule two focus groups of 6 next Tuesday 6 pm IST with Mumbai and Delhi segments")!;
  assert.equal(req.op, "schedule_live");
  const p = qualPreview(req, { ...data, guide: { title: "Broadband", hasConsent: true } });
  assert.equal(p.runnable, true);
  assert.equal(p.calls, 0);
  assert.equal(p.runLabel, "Schedule 2 sessions");
  assert.deepEqual(p.liveSessions!.map((s) => [s.title, s.startsAt, s.segment, s.size]), [["Broadband 1 — Mumbai", "2026-10-27T12:30:00.000Z", "Mumbai", 6], ["Broadband 2 — Delhi", "2026-10-27T14:30:00.000Z", "Delhi", 6]]);
  assert.match(p.lines[0], /2026-10-27 18:00–19:30 \(Asia\/Kolkata\) · 6 participant links · segment Mumbai/);
  assert.ok(p.lines.some((l) => /IST read as Asia\/Kolkata/.test(l)));
  /* what Run sends is accepted by the server's scheduling check */
  for (const s of p.liveSessions!) {
    const f = readScheduleInput({ title: s.title, kind: "focus_group", scheduledAt: s.startsAt, timeZone: s.timeZone, segment: s.segment, settings: { maxParticipants: s.size, durationMinutes: s.durationMinutes } });
    assert.ok(f.ok, JSON.stringify(f));
  }
});

test("missing day or time, a guide without consent, and a group bigger than the built-in connection are said, not guessed", () => {
  const p = qualPreview(interpretQualRequest("schedule a focus group of 8 with video recording")!, { ...data, guide: { hasConsent: false } });
  assert.equal(p.runnable, false);
  assert.ok(p.lines.some((l) => /Which day/.test(l)) && p.lines.some((l) => /What time/.test(l)));
  assert.ok(p.lines.some((l) => /no consent statement yet/.test(l)));
  assert.ok(p.lines.some((l) => /LiveKit/.test(l)));
  const none = qualPreview(interpretQualRequest("book an IDI tomorrow at 10:00")!, data);
  assert.ok(none.lines.some((l) => /No time zone named — read as Europe\/London/.test(l)));
  assert.ok(none.lines.some((l) => /no consent statement yet/.test(l)), "no guide at all");
});

test("a room booked from a guide without consent cannot take participants (the join page says so)", () => {
  const f = readScheduleInput({ title: "x", settings: { record: true } });
  assert.ok(f.ok);
  const room = newRoomState("r", f.value, { kind: "focus_group", sections: [] });
  assert.equal(joinProblems(room).length, 2);
  assert.equal(guideSnapshot(null).stimuli.length, 0);
});

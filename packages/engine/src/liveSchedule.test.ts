import { test } from "node:test";
import assert from "node:assert/strict";
import { interpretLiveSchedule, resolveLiveSchedule, zonedToUtc, zoneOffsetMinutes, zonedDate } from "./liveSchedule.js";
import { interpretQualRequest, describeQualRequest } from "./qualIntent.js";

/* LIVE SESSIONS SCHEDULED IN WORDS (2026-10-22, G2) */

const NOW = Date.UTC(2026, 9, 22, 9, 0); // Thursday 22 Oct 2026, 09:00 UTC (14:30 IST)

test("the brief's sentence: two focus groups of 6, next Tuesday 6 pm IST, Mumbai and Delhi", () => {
  const r = interpretLiveSchedule("schedule two focus groups of 6 next Tuesday 6 pm IST with Mumbai and Delhi segments");
  assert.ok(r);
  assert.equal(r.count, 2); assert.equal(r.kind, "focus_group"); assert.equal(r.size, 6);
  assert.deepEqual(r.day, { weekday: 2 }); assert.deepEqual(r.time, { h: 18, min: 0 });
  assert.equal(r.timeZone, "Asia/Kolkata"); assert.deepEqual(r.segments, ["Mumbai", "Delhi"]);
  const s = resolveLiveSchedule(r, { now: NOW });
  assert.deepEqual(s.problems, []);
  assert.equal(s.sessions.length, 2);
  /* Tuesday 27 Oct 2026, 18:00 IST = 12:30 UTC; the second one after 90 + 30 minutes */
  assert.equal(s.sessions[0].startsAt, "2026-10-27T12:30:00.000Z");
  assert.equal(s.sessions[0].localDate, "2026-10-27"); assert.equal(s.sessions[0].localTime, "18:00"); assert.equal(s.sessions[0].endsLocalTime, "19:30");
  assert.equal(s.sessions[1].startsAt, "2026-10-27T14:30:00.000Z");
  assert.equal(s.sessions[0].segment, "Mumbai"); assert.equal(s.sessions[1].segment, "Delhi");
  assert.match(s.sessions[1].title, /2 — Delhi$/);
  assert.ok(s.notes.some((n) => /IST read as Asia\/Kolkata/.test(n)));
  /* routed through the qualitative classifier, described for the card */
  const q = interpretQualRequest("schedule two focus groups of 6 next Tuesday 6 pm IST with Mumbai and Delhi segments");
  assert.equal(q?.op, "schedule_live");
  assert.match(describeQualRequest(q!), /^Schedule 2 live focus groups of 6 \(Mumbai, Delhi\)/);
});

test("variants: IDIs, parallel, explicit dates, 24-hour times, durations, no recording, an IANA zone", () => {
  const a = interpretLiveSchedule("book three IDIs on 3 Nov at 10:30 Europe/London for 45 minutes, no recording")!;
  assert.equal(a.kind, "interview"); assert.equal(a.count, 3); assert.equal(a.size, 1); assert.equal(a.durationMinutes, 45); assert.equal(a.record, false);
  const sa = resolveLiveSchedule(a, { now: NOW });
  assert.equal(sa.sessions[0].startsAt, "2026-11-03T10:30:00.000Z"); // GMT after the clocks went back
  assert.equal(sa.sessions[1].startsAt, "2026-11-03T11:45:00.000Z");
  const b = interpretLiveSchedule("set up 2 live video focus groups with 5 participants each tomorrow 7pm EST at the same time")!;
  assert.equal(b.size, 5); assert.equal(b.parallel, true);
  const sb = resolveLiveSchedule(b, { now: NOW });
  assert.equal(sb.sessions[0].startsAt, sb.sessions[1].startsAt);
  assert.equal(sb.sessions[0].startsAt, "2026-10-23T23:00:00.000Z"); // EDT on 23 Oct
  const c = interpretLiveSchedule("schedule a focus group of 8 on Monday at 18:00 with video recording")!;
  assert.equal(c.recordVideo, true);
  const sc = resolveLiveSchedule(c, { now: NOW, fallbackTimeZone: "Asia/Kolkata" });
  assert.ok(sc.notes.some((n) => /No time zone named/.test(n)));
  assert.ok(sc.notes.some((n) => /LiveKit/.test(n)), "8 people is over the mesh");
});

test("what is missing is said, never guessed; a past time is a problem", () => {
  const r = interpretLiveSchedule("schedule two focus groups with Gen Z and Millennials segments")!;
  const s = resolveLiveSchedule(r, { now: NOW });
  assert.equal(s.sessions.length, 0);
  assert.equal(s.problems.length, 2);
  const p = resolveLiveSchedule(interpretLiveSchedule("schedule an interview today at 9 am IST")!, { now: NOW });
  assert.ok(p.problems.some((x) => /already passed/.test(x)));
});

test("not scheduling live sessions: AI interviews, text group sessions, survey edits, analysis", () => {
  for (const s of [
    "run this guide as AI voice interviews with 50 people in Hindi and English",
    "run a group session from the guide",
    "code new interviews automatically",
    "summarise the themes from the interviews",
    "add a question about price",
    "compare Mumbai vs Delhi participants",
    "schedule the reminder emails for the interview survey",
  ]) assert.notEqual(interpretQualRequest(s)?.op, "schedule_live", s);
  assert.equal(interpretLiveSchedule("set up an AI-moderated interview study"), null);
});

test("zoned time arithmetic: offsets, DST edges, calendar dates", () => {
  assert.equal(zoneOffsetMinutes(NOW, "Asia/Kolkata"), 330);
  assert.equal(zoneOffsetMinutes(Date.UTC(2026, 6, 1), "America/New_York"), -240);
  assert.equal(zoneOffsetMinutes(Date.UTC(2026, 0, 1), "America/New_York"), -300);
  assert.equal(new Date(zonedToUtc(2026, 3, 29, 3, 0, "Europe/London")).toISOString(), "2026-03-29T02:00:00.000Z");
  /* 01:30 does not exist that night (the clocks jump 01:00 → 02:00): read forward, as 02:30 BST */
  assert.equal(new Date(zonedToUtc(2026, 3, 29, 1, 30, "Europe/London")).toISOString(), "2026-03-29T01:30:00.000Z");
  assert.deepEqual(zonedDate(Date.UTC(2026, 9, 22, 20, 0), "Asia/Kolkata"), { y: 2026, m: 10, d: 23, weekday: 5 });
});

test("design talk is not a booking: no verb of scheduling and no day or time → the copilot answers it", () => {
  for (const s of ["Run two moderated focus groups before the survey", "run a video focus group", "plan two focus groups and an interview phase", "Design a mixed-methods study: qualitative interviews first, then a quantitative survey to test what we learn"]) assert.equal(interpretLiveSchedule(s), null, s);
  assert.equal(interpretLiveSchedule("run a live video focus group tomorrow at 6 pm")?.count, 1);
});

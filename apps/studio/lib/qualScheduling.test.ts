import { test } from "node:test";
import assert from "node:assert/strict";
import { book, cancel, remindersDue, settle } from "@rescript/interviews";
import { interviewInvitationEmail, interviewReminderEmail } from "@rescript/mail";
import { bookingPatch, bookingUrl, hashToken, newToken, surveyOfToken, toBooking, toSlot, whenText } from "./qualScheduling.ts";

const SURVEY = "0b6f3c1e-2d4a-4f5b-9c8d-7e6f5a4b3c2d";

test("an invitation token names its survey, and only its hash is what is stored", () => {
  const { token, hash } = newToken(SURVEY);
  assert.equal(surveyOfToken(token), SURVEY);
  assert.equal(hash, hashToken(token));
  assert.equal(hash.length, 64);
  assert.ok(!hash.includes(token.split(".")[1]));
  assert.notEqual(newToken(SURVEY).token, token, "each token is random");
  for (const bad of ["", "abc", `${SURVEY}.short`, `not-a-uuid.${"a".repeat(43)}`, `${SURVEY}.${"a".repeat(43)}x`]) assert.equal(surveyOfToken(bad), null, bad);
});

test("rows become engine slots and bookings, and an engine change becomes only the changed columns", () => {
  const slot = toSlot({ id: "s1", starts_at: "2026-12-03T10:00:00+00:00", ends_at: "2026-12-03T10:45:00+00:00", capacity: 1, moderator: null, status: "open" });
  assert.deepEqual(slot, { id: "s1", startsAt: "2026-12-03T10:00:00.000Z", endsAt: "2026-12-03T10:45:00.000Z", capacity: 1, status: "open" });
  const row = { id: "b1", respondent_id: null, email: "a@example.com", slot_id: null, status: "invited", invited_at: "2026-11-30T09:00:00Z", reminders_sent: [] };
  const b = toBooking(row);
  assert.equal(b.inviteeId, "a@example.com");
  const now = "2026-12-01T09:00:00.000Z";
  const r = book("b1", "s1", [slot], [b], now);
  assert.ok(r.ok);
  const after = r.ok ? r.bookings[0] : b;
  const patch = bookingPatch(b, after)!;
  assert.equal(patch.status, "booked");
  assert.equal(patch.slot_id, "s1");
  assert.equal(patch.booked_at, now);
  assert.ok(!("cancelled_at" in patch));
  assert.equal(bookingPatch(after, after), null, "no change, no write");

  /* the whole life of one booking: reminder 24 h before, the late cancel inside 24 h, settled at the policy's share */
  const due = remindersDue([slot], [after], "2026-12-02T10:30:00.000Z");
  assert.deepEqual(due.map((d) => d.key), ["24h"]);
  const late = cancel("b1", [slot], [after], "2026-12-02T20:00:00.000Z")[0];
  assert.equal(late.status, "late_cancel");
  const { settlements } = settle([late], {}, { amount: 50, currency: "GBP", lateCancelShare: 0.5 });
  assert.equal(settlements[0].incentive, 25);
});

test("the booking page address prefers the configured public Studio address", () => {
  const prior = process.env.STUDIO_PUBLIC_URL;
  try {
    delete process.env.STUDIO_PUBLIC_URL;
    assert.equal(bookingUrl("t.x", "https://req.example"), "https://req.example/book/t.x");
    process.env.STUDIO_PUBLIC_URL = "https://studio.example.com/";
    assert.equal(bookingUrl("t.x", "https://req.example"), "https://studio.example.com/book/t.x");
  } finally { if (prior === undefined) delete process.env.STUDIO_PUBLIC_URL; else process.env.STUDIO_PUBLIC_URL = prior; }
  assert.equal(whenText("2026-12-03T10:00:00.000Z"), "Thursday 3 December, 10:00 UTC");
});

test("the invitation carries the personal link; the job's reminder, which has no link, points to the invitation", () => {
  const inv = interviewInvitationEmail({ name: "Ada Lovelace", senderName: "Miures", studyTitle: "Coffee habits", url: "https://s/book/t", minutes: 45, incentive: "a £25 voucher" });
  assert.match(inv.text, /Hello Ada,/);
  assert.match(inv.text, /https:\/\/s\/book\/t/);
  assert.match(inv.text, /£25 voucher/);
  assert.match(inv.html, /Pick a time/);
  const rem = interviewReminderEmail({ senderName: "The research team", studyTitle: "Coffee <habits>", when: "Thursday 3 December, 10:00 UTC", url: null, hoursBefore: 1 });
  assert.match(rem.text, /in about an hour/);
  assert.match(rem.text, /link in your invitation email/);
  assert.ok(!rem.html.includes("<habits>"), "study title is escaped in HTML");
});

import { test } from "node:test";
import assert from "node:assert/strict";
import { slotsFrom, openSlots, book, cancel, remindersDue, settle, invitesNeeded, type Booking } from "./scheduling.js";

const slots = slotsFrom({ windows: [{ date: "2026-12-03", from: "10:00", to: "12:00" }], minutes: 45, bufferMinutes: 15, timezoneOffsetMinutes: 330 });
const inv = (id: string, over: Partial<Booking> = {}): Booking => ({ id, inviteeId: `p-${id}`, slotId: null, status: "invited", invitedAt: "2026-11-29T10:00:00Z", remindersSent: [], ...over });

test("windows become slots of a length with a buffer, in UTC from the study's time zone", () => {
  assert.deepEqual(slots.map((s) => [s.startsAt, s.endsAt]), [["2026-12-03T04:30:00.000Z", "2026-12-03T05:15:00.000Z"], ["2026-12-03T05:30:00.000Z", "2026-12-03T06:15:00.000Z"]]);
  assert.throws(() => slotsFrom({ windows: [{ date: "3 Dec", from: "10:00", to: "12:00" }], minutes: 45 }), /not a date/);
  assert.equal(slotsFrom({ windows: [{ date: "2026-12-03", from: "18:00", to: "20:00" }], minutes: 90, capacity: 8 })[0]!.capacity, 8);
});

test("booking: full, past the cutoff, and already-held slots are refused in words; rebooking releases the old slot", () => {
  const now = "2026-12-01T00:00:00Z";
  let bs = [inv("a"), inv("b")];
  const r1 = book("a", slots[0]!.id, slots, bs, now); assert.ok(r1.ok); bs = (r1 as { bookings: Booking[] }).bookings;
  const r2 = book("b", slots[0]!.id, slots, bs, now); assert.ok(!r2.ok && /just been taken/.test(r2.reason));
  assert.deepEqual(openSlots(slots, bs, now).map((s) => s.id), [slots[1]!.id]);
  const r3 = book("a", slots[1]!.id, slots, bs, now); assert.ok(r3.ok); bs = (r3 as { bookings: Booking[] }).bookings;
  assert.equal(openSlots(slots, bs, now).length, 1, "a's first slot is free again");
  const late = book("b", slots[0]!.id, slots, bs, "2026-12-03T03:00:00Z"); assert.ok(!late.ok && /within 2 hours/.test(late.reason));
});

test("cancellation frees the slot early; inside 24 hours it is a late cancellation", () => {
  const bs = [inv("a", { status: "booked", slotId: slots[0]!.id })];
  assert.equal(cancel("a", slots, bs, "2026-12-01T00:00:00Z")[0]!.status, "cancelled");
  assert.equal(cancel("a", slots, bs, "2026-12-02T12:00:00Z")[0]!.status, "late_cancel");
});

test("reminders: the nearest offset reached, each once, none after the start", () => {
  const bs = [inv("a", { status: "booked", slotId: slots[0]!.id })];
  assert.deepEqual(remindersDue(slots, bs, "2026-12-01T00:00:00Z"), []);
  assert.deepEqual(remindersDue(slots, bs, "2026-12-02T05:00:00Z").map((r) => r.key), ["24h"]);
  assert.deepEqual(remindersDue(slots, [{ ...bs[0]!, remindersSent: ["24h"] }], "2026-12-03T04:00:00Z").map((r) => r.key), ["1h"]);
  assert.deepEqual(remindersDue(slots, bs, "2026-12-03T04:00:00Z").map((r) => r.key), ["1h"], "booked late: the 24 h one is not sent after the 1 h one is due");
  assert.deepEqual(remindersDue(slots, bs, "2026-12-03T05:00:00Z"), []);
});

test("settlement and incentives: attended paid, late cancellation by policy, no-show nothing", () => {
  const bs = [inv("a", { status: "booked", slotId: slots[0]!.id }), inv("b", { status: "booked", slotId: slots[1]!.id }), inv("c", { status: "late_cancel" }), inv("d")];
  const r = settle(bs, { a: "attended", b: "no_show" }, { amount: 1500, currency: "INR", lateCancelShare: 0.5 });
  assert.deepEqual(r.settlements.map((s) => [s.bookingId, s.status, s.incentive]), [["a", "attended", 1500], ["b", "no_show", 0], ["c", "late_cancel", 750]]);
  assert.equal(r.bookings[3]!.status, "invited");
});

test("invitations still needed: defaults until the study has its own rates, then its own", () => {
  const early = invitesNeeded([inv("a")], 10);
  assert.match(early.basis, /assumed/);
  assert.equal(early.invite, Math.ceil((10 - 0.3 * 0.8) / 0.24));
  const many: Booking[] = [
    ...Array.from({ length: 12 }, (_, i) => inv(`t${i}`, { status: "attended" })),
    ...Array.from({ length: 3 }, (_, i) => inv(`n${i}`, { status: "no_show" })),
    ...Array.from({ length: 25 }, (_, i) => inv(`i${i}`)),
  ];
  const own = invitesNeeded(many, 20);
  assert.match(own.basis, /from this study's 40 invitations/);
  assert.equal(own.showRate, 0.8);
  assert.ok(own.invite > 0);
});

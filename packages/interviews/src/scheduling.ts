/**
 * SCHEDULING AND RECRUITING FOR INTERVIEWS AND GROUPS (Level 5 roadmap Q6 — 2026-11-29).
 *
 * Pure rules; the Studio stores slots and bookings (migration 0107) and sends the mail.
 *
 *   slotsFrom        availability windows → bookable slots of a length, with a buffer, in UTC, each with a capacity
 *                    (1 for an interview, n for a group)
 *   book             a slot taken by an invitee — refused when full, already started or inside the booking cutoff,
 *                    or when the invitee already holds a booking; rebooking releases the old slot
 *   remindersDue     which reminders to send now (by default 24 h and 1 h before), each once
 *   settle           after a slot: attended / no-show / late cancellation, and the incentive each is owed under the
 *                    study's policy (attended paid; a late cancellation paid a share or nothing; a no-show nothing)
 *   invitesNeeded    how many more people to invite to reach the target, from the study's own acceptance and show
 *                    rates once there are enough of them, else stated defaults — said which
 *
 * Every refusal is a sentence the invitee or the researcher can act on.
 */
export interface Window { date: string; from: string; to: string }
export interface SlotSpec { windows: Window[]; minutes: number; bufferMinutes?: number; timezoneOffsetMinutes?: number; capacity?: number; moderator?: string }
export interface Slot { id: string; startsAt: string; endsAt: string; capacity: number; moderator?: string; status: "open" | "cancelled" }
export type BookingStatus = "invited" | "booked" | "cancelled" | "late_cancel" | "attended" | "no_show";
export interface Booking { id: string; inviteeId: string; slotId: string | null; status: BookingStatus; invitedAt: string; bookedAt?: string; cancelledAt?: string; remindersSent: string[] }

const iso = (ms: number) => new Date(ms).toISOString();
const hm = (s: string) => { const m = /^(\d{1,2}):(\d{2})$/.exec(s.trim()); if (!m) throw new Error(`“${s}” is not a time like 09:30`); return Number(m[1]) * 60 + Number(m[2]); };

export function slotsFrom(spec: SlotSpec): Slot[] {
  if (!(spec.minutes >= 10 && spec.minutes <= 240)) throw new Error("A slot is 10 to 240 minutes long.");
  const buf = spec.bufferMinutes ?? 0, off = spec.timezoneOffsetMinutes ?? 0, cap = Math.max(1, Math.min(30, Math.round(spec.capacity ?? 1)));
  const out: Slot[] = [];
  for (const w of spec.windows) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(w.date)) throw new Error(`“${w.date}” is not a date like 2026-12-03`);
    const day = Date.parse(`${w.date}T00:00:00Z`);
    const a = hm(w.from), b = hm(w.to);
    if (b <= a) throw new Error(`The window on ${w.date} ends before it starts.`);
    for (let t = a; t + spec.minutes <= b; t += spec.minutes + buf) {
      const start = day + (t - off) * 60_000;
      out.push({ id: `slot_${w.date}_${String(Math.floor(t / 60)).padStart(2, "0")}${String(t % 60).padStart(2, "0")}`, startsAt: iso(start), endsAt: iso(start + spec.minutes * 60_000), capacity: cap, ...(spec.moderator ? { moderator: spec.moderator } : {}), status: "open" });
    }
  }
  return out.sort((x, y) => x.startsAt.localeCompare(y.startsAt));
}

export interface BookingPolicy { cutoffHours?: number; lateCancelHours?: number }
const taken = (slot: Slot, bookings: Booking[]) => bookings.filter((b) => b.slotId === slot.id && b.status === "booked").length;

/** the slots an invitee can pick now: open, not full, not past the cutoff */
export function openSlots(slots: Slot[], bookings: Booking[], now: string, policy: BookingPolicy = {}): (Slot & { left: number })[] {
  const cut = Date.parse(now) + (policy.cutoffHours ?? 2) * 3_600_000;
  return slots.filter((s) => s.status === "open" && Date.parse(s.startsAt) >= cut).map((s) => ({ ...s, left: s.capacity - taken(s, bookings) })).filter((s) => s.left > 0);
}

export function book(bookingId: string, slotId: string, slots: Slot[], bookings: Booking[], now: string, policy: BookingPolicy = {}): { ok: true; bookings: Booking[] } | { ok: false; reason: string } {
  const b = bookings.find((x) => x.id === bookingId);
  if (!b) return { ok: false, reason: "This invitation is not recognised." };
  if (b.status === "attended" || b.status === "no_show") return { ok: false, reason: "This session has already taken place." };
  const s = slots.find((x) => x.id === slotId);
  if (!s || s.status !== "open") return { ok: false, reason: "That time is no longer offered; please pick another." };
  if (Date.parse(s.startsAt) < Date.parse(now) + (policy.cutoffHours ?? 2) * 3_600_000) return { ok: false, reason: `That time starts within ${policy.cutoffHours ?? 2} hours; please pick a later one.` };
  if (b.slotId === slotId && b.status === "booked") return { ok: true, bookings };
  if (taken(s, bookings) >= s.capacity) return { ok: false, reason: "That time has just been taken; please pick another." };
  const next = bookings.map((x) => (x.id === bookingId ? { ...x, slotId, status: "booked" as const, bookedAt: now, remindersSent: [] } : x));
  return { ok: true, bookings: next };
}

/** cancel by the invitee: before the late-cancel window it frees the slot; inside it, it counts as a late cancellation */
export function cancel(bookingId: string, slots: Slot[], bookings: Booking[], now: string, policy: BookingPolicy = {}): Booking[] {
  return bookings.map((b) => {
    if (b.id !== bookingId || b.status !== "booked") return b;
    const s = slots.find((x) => x.id === b.slotId);
    const late = !!s && Date.parse(s.startsAt) - Date.parse(now) < (policy.lateCancelHours ?? 24) * 3_600_000;
    return { ...b, status: late ? "late_cancel" as const : "cancelled" as const, cancelledAt: now };
  });
}

export interface Reminder { bookingId: string; key: string; hoursBefore: number }
export function remindersDue(slots: Slot[], bookings: Booking[], now: string, offsetsHours: number[] = [24, 1]): Reminder[] {
  const t = Date.parse(now), out: Reminder[] = [];
  for (const b of bookings) {
    if (b.status !== "booked" || !b.slotId) continue;
    const s = slots.find((x) => x.id === b.slotId);
    if (!s) continue;
    const start = Date.parse(s.startsAt);
    if (start <= t) continue;
    /* the nearest offset that has been reached and not sent; an earlier one missed (booked late) is not sent after a nearer one */
    const reached = offsetsHours.filter((h) => start - h * 3_600_000 <= t).sort((a, c) => a - c)[0];
    if (reached === undefined) continue;
    const key = `${reached}h`;
    if (!b.remindersSent.includes(key)) out.push({ bookingId: b.id, key, hoursBefore: reached });
  }
  return out;
}

export interface IncentivePolicy { amount: number; currency: string; lateCancelShare?: number; noShowShare?: number }
export interface Settlement { bookingId: string; status: BookingStatus; incentive: number; currency: string; why: string }
/** after the session: the researcher's mark (attended / no_show) for booked people; late cancellations settle by policy */
export function settle(bookings: Booking[], marks: Record<string, "attended" | "no_show">, policy: IncentivePolicy): { bookings: Booking[]; settlements: Settlement[] } {
  const settlements: Settlement[] = [];
  const next = bookings.map((b) => {
    const mark = marks[b.id];
    const status: BookingStatus = b.status === "booked" && mark ? mark : b.status;
    const share = status === "attended" ? 1 : status === "late_cancel" ? policy.lateCancelShare ?? 0 : status === "no_show" ? policy.noShowShare ?? 0 : null;
    if (share !== null) settlements.push({ bookingId: b.id, status, incentive: Math.round(policy.amount * share * 100) / 100, currency: policy.currency, why: status === "attended" ? "took part" : status === "late_cancel" ? `cancelled late: ${Math.round((policy.lateCancelShare ?? 0) * 100)}% under the study's policy` : `did not attend: ${Math.round((policy.noShowShare ?? 0) * 100)}% under the study's policy` });
    return status === b.status ? b : { ...b, status };
  });
  return { bookings: next, settlements };
}

export interface InviteMath { target: number; booked: number; attended: number; invite: number; acceptRate: number; showRate: number; basis: string }
/** more invitations to send to reach `target` attended: the study's own rates once there are 20 invitations and 10 bookings, else the defaults */
export function invitesNeeded(bookings: Booking[], target: number, defaults = { acceptRate: 0.3, showRate: 0.8 }): InviteMath {
  const invited = bookings.length;
  const bookedEver = bookings.filter((b) => b.status !== "invited").length;
  const settled = bookings.filter((b) => b.status === "attended" || b.status === "no_show").length;
  const attended = bookings.filter((b) => b.status === "attended").length;
  const booked = bookings.filter((b) => b.status === "booked").length;
  const ownAccept = invited >= 20 ? bookedEver / invited : null;
  const ownShow = settled >= 10 ? attended / settled : null;
  const acceptRate = ownAccept ?? defaults.acceptRate, showRate = ownShow ?? defaults.showRate;
  const expected = attended + booked * showRate;
  const pending = bookings.filter((b) => b.status === "invited").length;
  const short = Math.max(0, target - expected - pending * acceptRate * showRate);
  const invite = short > 0 ? Math.ceil(short / (acceptRate * showRate)) : 0;
  const basis = [ownAccept !== null ? `acceptance ${Math.round(acceptRate * 100)}% from this study's ${invited} invitations` : `acceptance ${Math.round(acceptRate * 100)}% assumed (fewer than 20 invitations so far)`, ownShow !== null ? `attendance ${Math.round(showRate * 100)}% from ${settled} settled sessions` : `attendance ${Math.round(showRate * 100)}% assumed (fewer than 10 settled sessions)`].join("; ");
  return { target, booked, attended, invite, acceptRate, showRate, basis };
}

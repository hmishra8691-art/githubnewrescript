import { createHash, randomBytes } from "node:crypto";
import type { Booking, BookingStatus, Slot } from "@rescript/interviews";
import type { Db } from "./db";

/**
 * SCHEDULING AND RECRUITING (Level 5 roadmap Q6, migration 0107) — the rows and the rules meet here.
 *
 * The rules are pure (packages/interviews/src/scheduling.ts) and work on `Slot` / `Booking`; this file turns the
 * stored rows into those and back, makes invitation tokens, and names the one sentence a database without 0107
 * answers with. The researcher route, the public booking route and the reminder job all use it.
 *
 * An invitation token is `<surveyId>.<32 random bytes, base64url>`. The survey id is in the clear so the public
 * route can find the right client database (tenancy) before it looks anything up; only the SHA-256 of the whole
 * token is stored, so a database read never yields a working link.
 */
type Row = Record<string, unknown>;
const str = (v: unknown) => (typeof v === "string" ? v : null);

export const SLOT_COLUMNS = "id, survey_id, starts_at, ends_at, capacity, moderator, status";
export const BOOKING_COLUMNS = "id, survey_id, slot_id, respondent_id, source, email, name, status, invited_at, booked_at, cancelled_at, reminders_sent, incentive";

export const MISSING_0107 = "Interview scheduling needs migration 0107 (qual_slots, qual_bookings), which has not been applied to this database.";
export const isMissingTable = (m: string) => /qual_slots|qual_bookings|does not exist|schema cache/i.test(m);

export function hashToken(token: string): string { return createHash("sha256").update(token).digest("hex"); }
export function newToken(surveyId: string): { token: string; hash: string } {
  const token = `${surveyId}.${randomBytes(32).toString("base64url")}`;
  return { token, hash: hashToken(token) };
}
/** the survey a token belongs to, or null when it is not shaped like one of ours (answered as "not recognised") */
export function surveyOfToken(token: string): string | null {
  const m = /^([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.[A-Za-z0-9_-]{43}$/i.exec(token);
  return m ? m[1].toLowerCase() : null;
}

export function toSlot(r: Row): Slot {
  return { id: String(r.id), startsAt: new Date(String(r.starts_at)).toISOString(), endsAt: new Date(String(r.ends_at)).toISOString(), capacity: Number(r.capacity ?? 1), ...(str(r.moderator) ? { moderator: String(r.moderator) } : {}), status: r.status === "cancelled" ? "cancelled" : "open" };
}
export function toBooking(r: Row): Booking {
  const at = (v: unknown) => (v ? new Date(String(v)).toISOString() : undefined);
  return {
    id: String(r.id), inviteeId: str(r.respondent_id) ?? str(r.email) ?? String(r.id), slotId: str(r.slot_id), status: String(r.status) as BookingStatus,
    invitedAt: at(r.invited_at) ?? new Date(0).toISOString(), ...(at(r.booked_at) ? { bookedAt: at(r.booked_at) } : {}), ...(at(r.cancelled_at) ? { cancelledAt: at(r.cancelled_at) } : {}),
    remindersSent: Array.isArray(r.reminders_sent) ? (r.reminders_sent as unknown[]).map(String) : [],
  };
}

/** every slot and booking of one survey (a study has hundreds at most; bounded anyway) */
export async function loadSchedule(db: Db, surveyId: string): Promise<{ slotRows: Row[]; bookingRows: Row[]; slots: Slot[]; bookings: Booking[] }> {
  const [s, b] = await Promise.all([
    db.from("qual_slots").select(SLOT_COLUMNS).eq("survey_id", surveyId).order("starts_at").limit(2000),
    db.from("qual_bookings").select(BOOKING_COLUMNS).eq("survey_id", surveyId).order("invited_at").limit(5000),
  ]);
  if (s.error) throw new Error(s.error.message);
  if (b.error) throw new Error(b.error.message);
  const slotRows = (s.data ?? []) as Row[], bookingRows = (b.data ?? []) as Row[];
  return { slotRows, bookingRows, slots: slotRows.map(toSlot), bookings: bookingRows.map(toBooking) };
}

/** the columns that changed between two engine states of one booking — what is written back */
export function bookingPatch(before: Booking, after: Booking): Row | null {
  const p: Row = {};
  if (before.status !== after.status) p.status = after.status;
  if (before.slotId !== after.slotId) p.slot_id = after.slotId;
  if (before.bookedAt !== after.bookedAt) p.booked_at = after.bookedAt ?? null;
  if (before.cancelledAt !== after.cancelledAt) p.cancelled_at = after.cancelledAt ?? null;
  if (before.remindersSent.join() !== after.remindersSent.join()) p.reminders_sent = after.remindersSent;
  if (!Object.keys(p).length) return null;
  p.updated_at = new Date().toISOString();
  return p;
}

/** a time as a person reads it, in UTC with the zone named (the invitee's own zone is not known to the server) */
export function whenText(iso: string): string {
  const d = new Date(iso);
  return `${d.toLocaleDateString("en-GB", { weekday: "long", day: "numeric", month: "long", timeZone: "UTC" })}, ${d.toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit", timeZone: "UTC" })} UTC`;
}

/** the public booking page for a token: the Studio's public address when configured, else the address the request came to */
export function bookingUrl(token: string, requestOrigin: string | null): string | null {
  const base = (process.env.STUDIO_PUBLIC_URL ?? "").trim().replace(/\/+$/, "") || requestOrigin;
  return base ? `${base}/book/${encodeURIComponent(token)}` : null;
}

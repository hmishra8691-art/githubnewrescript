import { NextRequest, NextResponse } from "next/server";
import { book, cancel, openSlots } from "@rescript/interviews";
import { surveyDb } from "@/lib/db";
import { bookingPatch, hashToken, isMissingTable, loadSchedule, surveyOfToken, toBooking } from "@/lib/qualScheduling";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * THE INVITEE'S BOOKING LINK (Level 5 roadmap Q6, migration 0107) — no account: the TOKEN in the invitation email is
 * the credential. Only its SHA-256 is stored; the survey id in front of it picks the client database (tenancy).
 *
 * GET    the study's title, the invitee's current booking and the times they can pick now
 * POST   { action: "book", slotId } | { action: "cancel" }
 *
 * What an invitee sees: the study title, times, and their own booking — never anyone else's name, address or
 * booking. An unknown, malformed or withdrawn token gets the same 404 sentence.
 */
const NOT_FOUND = { error: "This invitation link is not recognised. Please use the link from your invitation email." };
const nope = () => NextResponse.json(NOT_FOUND, { status: 404, headers: { "Cache-Control": "no-store" } });
const reply = (body: unknown, status = 200) => NextResponse.json(body, { status, headers: { "Cache-Control": "no-store" } });

async function resolve(token: string) {
  const surveyId = surveyOfToken(token);
  if (!surveyId) return null;
  const db = await surveyDb(surveyId);
  const { data, error } = await db.from("qual_bookings").select("id, survey_id, slot_id, respondent_id, email, status, invited_at, booked_at, cancelled_at, reminders_sent, name").eq("token_hash", hashToken(token)).eq("survey_id", surveyId).maybeSingle();
  if (error) throw new Error(error.message);
  if (!data) return null;
  return { db, surveyId, row: data as Record<string, unknown> };
}

export async function GET(_req: NextRequest, { params }: { params: { token: string } }) {
  const token = decodeURIComponent(params.token ?? "");
  try {
    const found = await resolve(token);
    if (!found) return nope();
    const { db, surveyId, row } = found;
    const [{ data: survey }, sched] = await Promise.all([db.from("surveys").select("title").eq("id", surveyId).maybeSingle(), loadSchedule(db, surveyId)]);
    const me = toBooking(row);
    const mine = me.slotId ? sched.slots.find((s) => s.id === me.slotId) : null;
    const now = new Date().toISOString();
    return reply({
      study: (survey as { title?: string } | null)?.title ?? "the study",
      name: typeof row.name === "string" ? row.name.split(/\s+/)[0] : null,
      status: me.status,
      booking: mine && (me.status === "booked") ? { slotId: mine.id, startsAt: mine.startsAt, endsAt: mine.endsAt, withdrawn: mine.status === "cancelled" } : null,
      slots: me.status === "attended" || me.status === "no_show" ? [] : openSlots(sched.slots, sched.bookings, now).map((s) => ({ id: s.id, startsAt: s.startsAt, endsAt: s.endsAt })),
    });
  } catch (e) {
    const m = (e as Error).message;
    return reply({ error: isMissingTable(m) ? "Booking is not available right now." : "Something went wrong; please try again." }, isMissingTable(m) ? 503 : 500);
  }
}

export async function POST(req: NextRequest, { params }: { params: { token: string } }) {
  const token = decodeURIComponent(params.token ?? "");
  try {
    const found = await resolve(token);
    if (!found) return nope();
    const { db, surveyId, row } = found;
    const body = (await req.json().catch(() => null)) as { action?: string; slotId?: string } | null;
    const sched = await loadSchedule(db, surveyId);
    const id = String(row.id);
    const before = sched.bookings.find((b) => b.id === id) ?? toBooking(row);
    const now = new Date().toISOString();
    let after;
    if (body?.action === "book") {
      if (typeof body.slotId !== "string") return reply({ error: "Pick a time." }, 400);
      const r = book(id, body.slotId, sched.slots, sched.bookings, now);
      if (!r.ok) return reply({ error: r.reason }, 409);
      after = r.bookings.find((b) => b.id === id)!;
      const patch = bookingPatch(before, after);
      if (patch) {
        /* the capacity check above read a snapshot; the conditional write and the recount below close the race */
        const { data, error } = await db.from("qual_bookings").update(patch).eq("id", id).eq("survey_id", surveyId).in("status", ["invited", "booked", "cancelled", "late_cancel"]).select("id");
        if (error) throw new Error(error.message);
        if (!data?.length) return reply({ error: "This session has already taken place." }, 409);
        const slot = sched.slots.find((s) => s.id === body.slotId)!;
        const { count } = await db.from("qual_bookings").select("id", { count: "exact", head: true }).eq("slot_id", slot.id).eq("status", "booked");
        if ((count ?? 0) > slot.capacity) {
          const undo = { status: before.status, slot_id: before.slotId, booked_at: before.bookedAt ?? null, reminders_sent: before.remindersSent, updated_at: new Date().toISOString() };
          await db.from("qual_bookings").update(undo).eq("id", id);
          return reply({ error: "That time has just been taken; please pick another." }, 409);
        }
      }
    } else if (body?.action === "cancel") {
      if (before.status !== "booked") return reply({ error: "You have no time booked." }, 409);
      after = cancel(id, sched.slots, sched.bookings, now).find((b) => b.id === id)!;
      const { error } = await db.from("qual_bookings").update(bookingPatch(before, after)!).eq("id", id).eq("survey_id", surveyId).eq("status", "booked");
      if (error) throw new Error(error.message);
    } else return reply({ error: "action is book or cancel." }, 400);
    const slot = after.slotId ? sched.slots.find((s) => s.id === after.slotId) : null;
    return reply({ ok: true, status: after.status, booking: slot && after.status === "booked" ? { slotId: slot.id, startsAt: slot.startsAt, endsAt: slot.endsAt } : null });
  } catch (e) {
    const m = (e as Error).message;
    return reply({ error: isMissingTable(m) ? "Booking is not available right now." : "Something went wrong; please try again." }, isMissingTable(m) ? 503 : 500);
  }
}

import { NextRequest } from "next/server";
import { slotsFrom, settle, cancel, invitesNeeded, type IncentivePolicy, type SlotSpec } from "@rescript/interviews";
import { interviewInvitationEmail } from "@rescript/mail";
import { isFailure, requireProjectFor, requireUser } from "@/lib/guard";
import { mailConfig, sendMail } from "@/lib/mail";
import { qualGuardCapability } from "@/lib/qual/qualAccess";
import { json, recordEvents, refuse, UUID } from "@/lib/qual/qualStore";
import { bookingPatch, bookingUrl, isMissingTable, loadSchedule, MISSING_0107, newToken } from "@/lib/qualScheduling";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export const maxDuration = 60;

/**
 * SCHEDULING AND RECRUITING FOR INTERVIEWS AND GROUPS (Level 5 roadmap Q6, migration 0107).
 *
 * GET    the study's slots (with places left), its invitations and bookings, and how many more people to invite to
 *        reach `?target=` attended sessions (the study's own acceptance and show rates once there are enough of them)
 * POST   { action: "slots", spec: SlotSpec }                          availability windows → bookable slots
 *        { action: "cancel_slot", slotId }                             the slot is withdrawn; its bookings are told nothing
 *                                                                      automatically — the response lists who to contact
 *        { action: "invite", respondentIds?: uuid[], emails?: {email, name?}[], minutes, incentive?, senderName? }
 *                                                                      one personal booking link each, by email
 *        { action: "mark", marks: {bookingId: "attended"|"no_show"}, incentive: IncentivePolicy }
 *                                                                      after a session: attendance and the incentive owed
 *        { action: "cancel", bookingId }                               cancelled on the invitee's behalf (late inside 24 h)
 *
 * Who may call: reading and writing names and email addresses, so contact details are needed as well as Data: View
 * (GET) or Data: Edit (POST) — the qualitative "playback" and "settings" operations.
 *
 * Invitations from the SAMPLE EXCHANGE: panel members are reached through their vendor, never by an address we hold,
 * so the exchange is not a source here. People who came through the exchange and gave an email address in the
 * survey are respondents of the list and are invited like any other.
 *
 * The incentive is RECORDED (amount, currency, why) on each booking; paying it is outside the platform.
 */
const MAX_INVITES = 500;
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export async function GET(req: NextRequest, { params }: { params: { id: string } }) {
  const authed = await requireUser(req);
  if (isFailure(authed)) return authed.response;
  const gate = await requireProjectFor(authed, params.id, qualGuardCapability("playback"));
  if (isFailure(gate)) return gate.response;
  const refused = refuse(gate, "playback");
  if (refused) return refused;
  const target = Math.max(0, Math.min(500, Number(new URL(req.url).searchParams.get("target") ?? 0) || 0));
  try {
    const { slotRows, bookingRows, slots, bookings } = await loadSchedule(gate.db, params.id);
    const booked = (id: string) => bookings.filter((b) => b.slotId === id && b.status === "booked").length;
    return json({
      slots: slotRows.map((r, i) => ({ ...r, booked: booked(slots[i].id), left: slots[i].capacity - booked(slots[i].id) })),
      bookings: bookingRows,
      counts: Object.fromEntries(["invited", "booked", "cancelled", "late_cancel", "attended", "no_show"].map((s) => [s, bookings.filter((b) => b.status === s).length])),
      ...(target ? { invitesNeeded: invitesNeeded(bookings, target) } : {}),
      mail: { configured: mailConfig().configured },
    });
  } catch (e) {
    const m = (e as Error).message;
    return json({ error: isMissingTable(m) ? MISSING_0107 : m }, isMissingTable(m) ? 503 : 500);
  }
}

export async function POST(req: NextRequest, { params }: { params: { id: string } }) {
  const authed = await requireUser(req);
  if (isFailure(authed)) return authed.response;
  const gate = await requireProjectFor(authed, params.id, qualGuardCapability("settings"));
  if (isFailure(gate)) return gate.response;
  const refused = refuse(gate, "settings");
  if (refused) return refused;
  const body = (await req.json().catch(() => null)) as Record<string, unknown> | null;
  if (!body) return json({ error: "Send a JSON body with an action." }, 400);
  const db = gate.db;
  const now = new Date().toISOString();
  try {
    switch (body.action) {
      case "slots": {
        let made;
        try { made = slotsFrom(body.spec as SlotSpec); } catch (e) { return json({ error: (e as Error).message }, 400); }
        if (!made.length) return json({ error: "Those windows are too short for one slot of that length." }, 400);
        if (made.length > 400) return json({ error: `That makes ${made.length} slots; add at most 400 at a time.` }, 400);
        const { data, error } = await db.from("qual_slots").insert(made.map((s) => ({ survey_id: params.id, starts_at: s.startsAt, ends_at: s.endsAt, capacity: s.capacity, moderator: s.moderator ?? null }))).select("id");
        if (error) throw new Error(error.message);
        await recordEvents(db, gate, [{ actor: "person", action: "scheduling.slots", detail: `${made.length} slot${made.length === 1 ? "" : "s"} added, ${made[0].startsAt} to ${made[made.length - 1].endsAt}`, ids: (data ?? []).map((r) => String((r as { id: string }).id)) }]);
        return json({ ok: true, added: made.length });
      }
      case "cancel_slot": {
        const slotId = typeof body.slotId === "string" && UUID.test(body.slotId) ? body.slotId : null;
        if (!slotId) return json({ error: "Which slot? Pass slotId." }, 400);
        const { data, error } = await db.from("qual_slots").update({ status: "cancelled" }).eq("id", slotId).eq("survey_id", params.id).select("id");
        if (error) throw new Error(error.message);
        if (!data?.length) return json({ error: "No such slot." }, 404);
        const { data: affected } = await db.from("qual_bookings").select("id, email, name").eq("slot_id", slotId).eq("survey_id", params.id).eq("status", "booked");
        await recordEvents(db, gate, [{ actor: "person", action: "scheduling.slot_cancelled", detail: `slot withdrawn; ${affected?.length ?? 0} booking(s) held it`, ids: [slotId] }]);
        return json({ ok: true, contact: affected ?? [], note: affected?.length ? "These people had booked this time. Their booking stays until they pick another time from their link; tell them the time was withdrawn." : undefined });
      }
      case "invite": return invite(req, gate, body);
      case "mark": {
        const marks = (body.marks && typeof body.marks === "object" ? body.marks : {}) as Record<string, string>;
        const clean = Object.fromEntries(Object.entries(marks).filter(([k, v]) => UUID.test(k) && (v === "attended" || v === "no_show"))) as Record<string, "attended" | "no_show">;
        const p = body.incentive as Partial<IncentivePolicy> | undefined;
        const policy: IncentivePolicy = { amount: Math.max(0, Number(p?.amount ?? 0) || 0), currency: typeof p?.currency === "string" ? p.currency.slice(0, 3).toUpperCase() : "USD", lateCancelShare: clamp01(p?.lateCancelShare), noShowShare: clamp01(p?.noShowShare) };
        const { bookings, bookingRows } = await loadSchedule(db, params.id);
        const ids = new Set(Object.keys(clean));
        /* a late cancellation is settled once, the first time attendance is marked after it */
        const unsettled = new Set(bookingRows.filter((r) => !r.incentive).map((r) => String(r.id)));
        const notBooked = [...ids].filter((id) => bookings.find((b) => b.id === id)?.status !== "booked");
        const { bookings: next, settlements } = settle(bookings.filter((b) => (ids.has(b.id) && b.status === "booked") || (b.status === "late_cancel" && unsettled.has(b.id))), clean, policy);
        for (const s of settlements) {
          const before = bookings.find((b) => b.id === s.bookingId)!;
          const after = next.find((b) => b.id === s.bookingId)!;
          const patch = { ...(bookingPatch(before, after) ?? { updated_at: now }), incentive: { amount: s.incentive, currency: s.currency, why: s.why, settledAt: now } };
          const { error } = await db.from("qual_bookings").update(patch).eq("id", s.bookingId).eq("survey_id", params.id);
          if (error) throw new Error(error.message);
        }
        await recordEvents(db, gate, [{ actor: "person", action: "scheduling.settled", detail: settlements.map((s) => `${s.status}: ${s.incentive} ${s.currency}`).join("; ").slice(0, 4000), ids: settlements.map((s) => s.bookingId) }]);
        return json({ ok: true, settlements, ...(notBooked.length ? { skipped: notBooked.map((id) => ({ bookingId: id, why: "not a current booking — only booked sessions are marked" })) } : {}) });
      }
      case "cancel": {
        const bookingId = typeof body.bookingId === "string" && UUID.test(body.bookingId) ? body.bookingId : null;
        if (!bookingId) return json({ error: "Which booking? Pass bookingId." }, 400);
        const { slots, bookings } = await loadSchedule(db, params.id);
        const before = bookings.find((b) => b.id === bookingId);
        if (!before) return json({ error: "No such booking." }, 404);
        if (before.status !== "booked") return json({ error: `This booking is ${before.status.replace("_", " ")}, not booked.` }, 409);
        const after = cancel(bookingId, slots, bookings, now).find((b) => b.id === bookingId)!;
        const { error } = await db.from("qual_bookings").update(bookingPatch(before, after)!).eq("id", bookingId).eq("survey_id", params.id);
        if (error) throw new Error(error.message);
        await recordEvents(db, gate, [{ actor: "person", action: "scheduling.cancelled", detail: `cancelled by the research team (${after.status})`, ids: [bookingId] }]);
        return json({ ok: true, status: after.status });
      }
      default:
        return json({ error: "action is one of slots, cancel_slot, invite, mark, cancel." }, 400);
    }
  } catch (e) {
    const m = (e as Error).message;
    return json({ error: isMissingTable(m) ? MISSING_0107 : m }, isMissingTable(m) ? 503 : 500);
  }
}

const clamp01 = (v: unknown) => Math.max(0, Math.min(1, Number(v ?? 0) || 0));

type Gate = Exclude<Awaited<ReturnType<typeof requireProjectFor>>, { response: unknown }>;

async function invite(req: NextRequest, gate: Gate, body: Record<string, unknown>) {
  const db = gate.db, surveyId = gate.surveyId;
  if (!mailConfig().configured) return json({ error: "Email is not configured on this Studio, so invitations cannot be sent." }, 503);
  const minutes = Math.max(10, Math.min(240, Math.round(Number(body.minutes ?? 45)) || 45));
  const incentive = typeof body.incentive === "string" && body.incentive.trim() ? body.incentive.trim().slice(0, 120) : null;
  const senderName = (typeof body.senderName === "string" && body.senderName.trim() ? body.senderName.trim() : gate.user.fullName || "The research team").slice(0, 120);
  const people: { email: string; name: string | null; respondentId: string | null; source: "list" | "manual" }[] = [];
  const skipped: { who: string; why: string }[] = [];

  const ids = Array.isArray(body.respondentIds) ? body.respondentIds.filter((x): x is string => typeof x === "string" && UUID.test(x)) : [];
  if (ids.length) {
    const { data, error } = await db.from("respondents").select("id, email, embedded").eq("survey_id", surveyId).in("id", ids.slice(0, MAX_INVITES));
    if (error) throw new Error(error.message);
    const found = new Map((data ?? []).map((r) => [String((r as { id: string }).id), r as { id: string; email: string | null; embedded: Record<string, unknown> | null }]));
    for (const id of ids) {
      const r = found.get(id);
      if (!r) { skipped.push({ who: id, why: "not a respondent of this survey" }); continue; }
      if (!r.email || !EMAIL.test(r.email)) { skipped.push({ who: id, why: "no email address on the list" }); continue; }
      const e = r.embedded ?? {};
      const name = [e.name, e.first_name, e.firstName].find((v) => typeof v === "string" && v.trim()) as string | undefined;
      people.push({ email: r.email.trim(), name: name?.trim() ?? null, respondentId: id, source: "list" });
    }
  }
  for (const x of Array.isArray(body.emails) ? body.emails : []) {
    const o = (typeof x === "string" ? { email: x } : x) as { email?: unknown; name?: unknown };
    const email = typeof o.email === "string" ? o.email.trim() : "";
    if (!EMAIL.test(email) || email.length > 320) { skipped.push({ who: String(o.email ?? "").slice(0, 80), why: "not an email address" }); continue; }
    people.push({ email, name: typeof o.name === "string" && o.name.trim() ? o.name.trim().slice(0, 200) : null, respondentId: null, source: "manual" });
  }
  if (!people.length) return json({ error: "No one to invite: pass respondentIds from the list or emails.", skipped }, 400);
  if (people.length > MAX_INVITES) return json({ error: `Invite at most ${MAX_INVITES} people at a time.` }, 400);

  /* an address already holding a live invitation is not invited twice */
  const { data: existing, error: exErr } = await db.from("qual_bookings").select("email").eq("survey_id", surveyId).in("status", ["invited", "booked"]);
  if (exErr) throw new Error(exErr.message);
  const held = new Set((existing ?? []).map((r) => String((r as { email: string | null }).email ?? "").toLowerCase()));
  const origin = new URL(req.url).origin;
  let sent = 0;
  const failed: { who: string; why: string }[] = [];
  for (const p of people) {
    const key = p.email.toLowerCase();
    if (held.has(key)) { skipped.push({ who: p.email, why: "already has an open invitation or booking" }); continue; }
    held.add(key);
    const { token, hash } = newToken(surveyId);
    const url = bookingUrl(token, origin);
    if (!url) { failed.push({ who: p.email, why: "no address for the booking page" }); continue; }
    const { data: row, error } = await db.from("qual_bookings").insert({ survey_id: surveyId, respondent_id: p.respondentId, source: p.source, email: p.email, name: p.name, token_hash: hash }).select("id").single();
    if (error) throw new Error(error.message);
    const m = interviewInvitationEmail({ name: p.name, senderName, studyTitle: gate.survey.title, url, minutes, incentive, replyTo: gate.user.email ?? null });
    const r = await sendMail({ to: p.email, subject: m.subject, text: m.text, html: m.html, kind: "interview_invitation", stream: "bulk", ...(gate.user.email ? { replyTo: gate.user.email } : {}), dedupeKey: `interview-invite:${String((row as { id: string }).id)}` });
    if (r.sent) sent++;
    else {
      /* the invitation row is withdrawn when its email did not go, so the address can be invited again */
      await db.from("qual_bookings").delete().eq("id", String((row as { id: string }).id));
      failed.push({ who: p.email, why: "reason" in r ? String(r.reason) : "not sent" });
    }
  }
  await recordEvents(db, gate, [{ actor: "person", action: "scheduling.invited", detail: `${sent} invitation(s) sent; ${skipped.length} skipped; ${failed.length} failed`, ids: [] }]);
  return json({ ok: true, sent, skipped, failed });
}

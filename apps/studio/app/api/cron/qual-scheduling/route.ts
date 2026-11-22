import "server-only";
import { NextResponse } from "next/server";
import { timingSafeEqual } from "node:crypto";
import { remindersDue } from "@rescript/interviews";
import { interviewReminderEmail } from "@rescript/mail";
import { everyDatabase } from "@/lib/db";
import { mailConfig, sendMail } from "@/lib/mail";
import { isMissingTable, loadSchedule, MISSING_0107, whenText } from "@/lib/qualScheduling";

/**
 * INTERVIEW REMINDERS (Level 5 roadmap Q6, migration 0107) — hourly: every booked session starting within a day
 * gets its reminder (24 h and 1 h before, each once; a booking made inside 24 h gets only the nearer one). The
 * reminder names the time in UTC and points back to the invitation email for changes, because the personal link
 * is never stored. Authorised by CRON_SECRET like the other jobs, refusing everything when it is unset.
 */
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

const BUDGET_MS = 45_000;

function authorised(req: Request): boolean {
  const secret = (process.env.CRON_SECRET ?? "").trim();
  if (!secret) return false;
  const header = req.headers.get("authorization") ?? "";
  const offered = header.startsWith("Bearer ") ? header.slice(7) : header;
  const a = Buffer.from(offered), b = Buffer.from(secret);
  return a.length === b.length && timingSafeEqual(a, b);
}

// the bearer token is checked in each handler's FIRST statement (the auth-guard audit's rule for a scheduler route), and again in run()
export async function GET(req: Request) { if (!authorised(req)) return NextResponse.json({ error: "not authorised" }, { status: 401 }); return run(req); }
export async function POST(req: Request) { if (!authorised(req)) return NextResponse.json({ error: "not authorised" }, { status: 401 }); return run(req); }

async function run(req: Request): Promise<NextResponse> {
  if (!authorised(req)) return NextResponse.json({ error: "not authorised" }, { status: 401 });
  if (!mailConfig().configured) return NextResponse.json({ ok: true, skipped: "email is not configured" });
  const started = Date.now();
  const totals = { surveys: 0, due: 0, sent: 0, failed: 0, partial: false };
  try {
    const now = new Date().toISOString();
    const soon = new Date(Date.now() + 25 * 3_600_000).toISOString();
    for (const target of everyDatabase()) {
      // only surveys with a booked session starting in the next day have anything due
      const { data: upcoming, error } = await target.db.from("qual_slots").select("survey_id").eq("status", "open").gt("starts_at", now).lte("starts_at", soon).limit(2000);
      if (error) throw new Error(error.message);
      for (const surveyId of [...new Set((upcoming ?? []).map((r) => String((r as { survey_id: string }).survey_id)))]) {
        if (Date.now() - started > BUDGET_MS) { totals.partial = true; break; }
        totals.surveys++;
        const [{ data: survey }, sched] = await Promise.all([target.db.from("surveys").select("title").eq("id", surveyId).maybeSingle(), loadSchedule(target.db, surveyId)]);
        const due = remindersDue(sched.slots, sched.bookings, now);
        totals.due += due.length;
        for (const d of due) {
          const row = sched.bookingRows.find((r) => String(r.id) === d.bookingId)!;
          const slot = sched.slots.find((s) => s.id === sched.bookings.find((b) => b.id === d.bookingId)!.slotId)!;
          const email = typeof row.email === "string" ? row.email : null;
          const sentBefore = Array.isArray(row.reminders_sent) ? (row.reminders_sent as string[]) : [];
          if (email) {
            const m = interviewReminderEmail({ name: typeof row.name === "string" ? row.name : null, senderName: "The research team", studyTitle: (survey as { title?: string } | null)?.title ?? "the study", when: whenText(slot.startsAt), url: null, hoursBefore: d.hoursBefore });
            const r = await sendMail({ to: email, subject: m.subject, text: m.text, html: m.html, kind: "interview_reminder", stream: "transactional", dedupeKey: `interview-reminder:${d.bookingId}:${slot.startsAt}:${d.key}` });
            if (r.sent || ("reason" in r && r.reason === "duplicate")) totals.sent += r.sent ? 1 : 0;
            else { totals.failed++; continue; }
          }
          // recorded as sent (or as not sendable, for a booking with no address) so it is not tried every hour
          await target.db.from("qual_bookings").update({ reminders_sent: [...sentBefore, d.key], updated_at: new Date().toISOString() }).eq("id", d.bookingId).eq("status", "booked");
        }
      }
    }
    return NextResponse.json({ ok: true, ...totals, elapsedMs: Date.now() - started });
  } catch (e) {
    const m = (e as Error).message;
    if (isMissingTable(m)) return NextResponse.json({ ok: true, skipped: MISSING_0107 });
    return NextResponse.json({ error: m.slice(0, 300) }, { status: 500 });
  }
}

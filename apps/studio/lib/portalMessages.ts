import "server-only";
import { audit, type ProjectContext } from "./guard";
import { platformDb } from "./db";
import { deliver } from "./portalNotify";
import { messageNotice } from "./portalNotifyCore";

/**
 * MESSAGES BETWEEN RESPONDENTS AND THIS SURVEY'S TEAM (phase 6, 2026-11-20; /api/surveys/[id]/portal/messages).
 * Messages are platform data beside the person's account; a project reads and writes only its own survey's. Who a
 * conversation is with is shown from the survey's own respondent list. A reply tells the respondent that there is
 * a message — the notice never carries its text.
 */
type Row = Record<string, unknown>;
const str = (v: unknown) => (typeof v === "string" ? v : null);
const missing = (m: string) => /portal_messages|schema cache|does not exist/i.test(m);

export interface ThreadRow { respondent: { id: string; name: string | null; email: string | null }; last: { body: string; at: string; fromStaff: boolean }; unread: number; count: number }

export async function listThreads(ctx: ProjectContext): Promise<{ available: boolean; threads: ThreadRow[]; unread: number }> {
  const { data, error } = await platformDb().from("portal_messages").select("enrolment_id, from_staff, body, created_at, read_by_staff_at").eq("survey_id", ctx.surveyId).order("created_at", { ascending: false }).limit(1000);
  if (error) { if (missing(error.message)) return { available: false, threads: [], unread: 0 }; throw new Error(error.message); }
  const by = new Map<string, ThreadRow>();
  for (const m of (data ?? []) as Row[]) {
    const id = String(m.enrolment_id);
    const t = by.get(id) ?? by.set(id, { respondent: { id, name: null, email: null }, last: { body: String(m.body).slice(0, 200), at: String(m.created_at), fromStaff: m.from_staff === true }, unread: 0, count: 0 }).get(id)!;
    t.count++;
    if (m.from_staff !== true && !m.read_by_staff_at) t.unread++;
  }
  if (by.size) {
    const { data: people } = await ctx.db.from("respondents").select("id, name, email").eq("survey_id", ctx.surveyId).in("id", [...by.keys()]);
    for (const p of (people ?? []) as Row[]) { const t = by.get(String(p.id)); if (t) t.respondent = { id: String(p.id), name: str(p.name), email: str(p.email) }; }
  }
  const threads = [...by.values()].sort((a, b) => b.unread - a.unread || b.last.at.localeCompare(a.last.at));
  return { available: true, threads, unread: threads.reduce((n, t) => n + t.unread, 0) };
}

/** one conversation, oldest first; opening it marks the respondent's messages as read by the team */
export async function openThread(ctx: ProjectContext, enrolmentId: string) {
  const db = platformDb();
  const { data, error } = await db.from("portal_messages").select("id, from_staff, body, created_at").eq("survey_id", ctx.surveyId).eq("enrolment_id", enrolmentId).order("created_at", { ascending: true }).limit(500);
  if (error) throw new Error(error.message);
  await db.from("portal_messages").update({ read_by_staff_at: new Date().toISOString() }).eq("survey_id", ctx.surveyId).eq("enrolment_id", enrolmentId).eq("from_staff", false).is("read_by_staff_at", null);
  return { messages: ((data ?? []) as Row[]).map((m) => ({ id: String(m.id), fromStaff: m.from_staff === true, body: String(m.body), at: String(m.created_at) })) };
}

export async function reply(ctx: ProjectContext, r: { enrolmentId: string; text: string }, surveyTitle: string): Promise<{ ok: true } | { error: string; status: number }> {
  const { data: who, error } = await ctx.db.from("respondents").select("id, account_id").eq("id", r.enrolmentId).eq("survey_id", ctx.surveyId).eq("is_test", false).maybeSingle();
  if (error) return { error: error.message, status: 500 };
  const accountId = str((who as Row | null)?.account_id);
  if (!accountId) return { error: "That respondent has no portal account, so there is nowhere to send a message.", status: 404 };
  const { data, error: wErr } = await platformDb().from("portal_messages").insert({ account_id: accountId, survey_id: ctx.surveyId, customer_id: ctx.user.customerId, enrolment_id: r.enrolmentId, from_staff: true, staff_user_id: ctx.user.userId, body: r.text, read_by_staff_at: new Date().toISOString() }).select("id").single();
  if (wErr) return missing(wErr.message) ? { error: "The message tables are not on this database yet. Apply migration 0106.", status: 409 } : { error: wErr.message, status: 500 };
  try { await deliver([messageNotice({ accountId, surveyId: ctx.surveyId, enrolmentId: r.enrolmentId, messageId: String((data as Row).id) }, surveyTitle)]); } catch { /* the message is stored; the person sees it in the portal */ }
  void audit({ action: "portal.message_sent", userId: ctx.user.userId, sessionId: ctx.user.sessionId, surveyId: ctx.surveyId, customerId: ctx.user.customerId, entity: "portal_messages", detail: {} });
  return { ok: true };
}

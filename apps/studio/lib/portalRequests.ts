import "server-only";
import { audit, type ProjectContext } from "./guard";
import { platformDb } from "./db";
import { deliver } from "./portalNotify";
import { requestAnsweredNotice } from "./portalNotifyCore";
import type { ResolveRequest } from "./portalRequestsCore";

/**
 * RESPONDENTS' PRIVACY REQUESTS FOR ONE SURVEY (phase 5, 2026-11-20; /api/surveys/[id]/portal/requests).
 * Requests are platform data beside the person's account; a project reads and answers only the ones addressed to
 * ITS survey. Who asked is shown from the survey's own respondent list.
 */
type Row = Record<string, unknown>;
const str = (v: unknown) => (typeof v === "string" ? v : null);

export interface RequestRow { id: string; kind: string; status: string; message: string | null; answer: string | null; createdAt: string; resolvedAt: string | null; respondent: { id: string; name: string | null; email: string | null } }

export async function listRequests(ctx: ProjectContext): Promise<{ available: boolean; rows: RequestRow[]; open: number }> {
  const { data, error } = await platformDb().from("portal_requests").select("id, enrolment_id, kind, status, message, response_note, created_at, resolved_at").eq("survey_id", ctx.surveyId).order("created_at", { ascending: false }).limit(200);
  if (error) { if (/portal_requests|schema cache|does not exist/i.test(error.message)) return { available: false, rows: [], open: 0 }; throw new Error(error.message); }
  const rows = (data ?? []) as Row[];
  const ids = [...new Set(rows.map((r) => String(r.enrolment_id)))];
  const who = new Map<string, Row>();
  if (ids.length) {
    const { data: people } = await ctx.db.from("respondents").select("id, name, email").eq("survey_id", ctx.surveyId).in("id", ids);
    for (const p of (people ?? []) as Row[]) who.set(String(p.id), p);
  }
  const out = rows.map((r) => { const p = who.get(String(r.enrolment_id)); return { id: String(r.id), kind: String(r.kind), status: String(r.status), message: str(r.message), answer: str(r.response_note), createdAt: String(r.created_at), resolvedAt: str(r.resolved_at), respondent: { id: String(r.enrolment_id), name: str(p?.name), email: str(p?.email) } }; });
  return { available: true, rows: out, open: out.filter((r) => r.status === "open").length };
}

export async function resolveRequest(ctx: ProjectContext, req: ResolveRequest): Promise<{ ok: true } | { error: string; status: number }> {
  const { data, error } = await platformDb().from("portal_requests").update({ status: req.status, response_note: req.note || null, resolved_at: new Date().toISOString(), resolved_by: ctx.user.userId })
    .eq("id", req.id).eq("survey_id", ctx.surveyId).eq("status", "open").select("id, kind, account_id, enrolment_id");
  if (error) return { error: error.message, status: 500 };
  const row = ((data ?? []) as Row[])[0];
  if (!row) return { error: "That request was not found, or has already been answered.", status: 404 };
  /* the person is told there is an answer; the answer itself is read in the portal */
  try { await deliver([requestAnsweredNotice({ accountId: String(row.account_id), surveyId: ctx.surveyId, enrolmentId: String(row.enrolment_id), requestId: String(row.id) }, ctx.survey.title)]); } catch { /* before migration 0106: the answer is still on their account page */ }
  void audit({ action: "portal.request_resolved", userId: ctx.user.userId, sessionId: ctx.user.sessionId, surveyId: ctx.surveyId, customerId: ctx.user.customerId, entity: "portal_requests", detail: { kind: String(row.kind), status: req.status } });
  return { ok: true };
}

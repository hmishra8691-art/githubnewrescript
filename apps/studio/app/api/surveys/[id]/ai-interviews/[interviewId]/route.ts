import { NextRequest } from "next/server";
import { isFailure, requireProjectFor, requireUser } from "@/lib/guard";
import { supabaseService } from "@/lib/authServer";
import { qualGuardCapability } from "@/lib/qual/qualAccess";
import { hasPii, json, loadSettings, refuse, UUID } from "@/lib/qual/qualStore";
import { excerptsCiting, parseInterviewAction, turnsView } from "@/lib/aiInterviews/view";
import { AiInterviewStoreError, endInterview, excludeInterview, turnsOf } from "@/lib/aiInterviews/store";
import { sandboxCall } from "@/lib/aiInterviews/sandboxProxy";

export const dynamic = "force-dynamic";

/**
 * ONE AI INTERVIEW (2026-10-22).
 *
 *   GET                         its live transcript (polled while in progress): turns with the moderator's
 *                               decision record (why it probed or moved on), the participant's words — and
 *                               their speech-to-text original and translation — redacted for a member
 *                               without contact details — Data view
 *   POST { action: "end" }      the research team ends it now: the participant's page says so; what was said
 *                               is written to the qualitative tables — Data edit
 *   POST { action: "exclude", reason? } | { action: "include" }   never a complete; its transcript leaves the
 *                               coding workspace unless coded excerpts already cite it (then it is kept, and
 *                               the answer says so) — Data edit
 */
const failure = (e: unknown) => e instanceof AiInterviewStoreError ? json({ error: e.message, ...(e.code ? { code: e.code } : {}) }, e.status) : json({ error: (e as Error).message }, 500);

export async function GET(req: NextRequest, { params }: { params: { id: string; interviewId: string } }) {
  const authed = await requireUser(req);
  if (params.id === "sandbox") {
    const r = await sandboxCall({ action: "interview", observerKey: req.nextUrl.searchParams.get("key"), id: params.interviewId });
    return json(r.body, r.status);
  }
  if (isFailure(authed)) return authed.response;
  const gate = await requireProjectFor(authed, params.id, qualGuardCapability("read"));
  if (isFailure(gate)) return gate.response;
  if (!UUID.test(params.interviewId)) return json({ error: "which interview" }, 400);
  try {
    const db = supabaseService();
    const pii = hasPii(gate);
    const names = pii ? [] : (await loadSettings(db, params.id).catch(() => ({ redactNames: [] as string[] }))).redactNames;
    return json({ ok: true, id: params.interviewId, pii, turns: turnsView(await turnsOf(db, params.id, params.interviewId), { pii, names }) });
  } catch (e) { return failure(e); }
}

export async function POST(req: NextRequest, { params }: { params: { id: string; interviewId: string } }) {
  const authed = await requireUser(req);
  const body = await req.json().catch(() => null);
  const a = parseInterviewAction(body);
  if ("error" in a) return json({ error: a.error }, 400);
  if (params.id === "sandbox") {
    const r = await sandboxCall({ action: a.action, observerKey: (body as Record<string, unknown>)?.observerKey, id: params.interviewId, ...(a.action === "exclude" && a.reason ? { reason: a.reason } : {}) });
    return json(r.body, r.status);
  }
  if (isFailure(authed)) return authed.response;
  const gate = await requireProjectFor(authed, params.id, qualGuardCapability("manage"));
  if (isFailure(gate)) return gate.response;
  const refused = refuse(gate, "manage");
  if (refused) return refused;
  if (!UUID.test(params.interviewId)) return json({ error: "which interview" }, 400);
  try {
    const db = supabaseService();
    const label = gate.user.fullName || gate.user.email;
    if (a.action === "end") {
      const r = await endInterview(db, params.id, params.interviewId, gate.user.userId);
      await db.from("qual_events").insert({ survey_id: params.id, actor: gate.user.userId, actor_label: label, action: "ai_interview.ended", detail: `Ended an AI interview in progress${r.transcriptId ? " (its transcript was added)" : ""}`, ids: [params.interviewId] });
      return json({ ok: true, ...r });
    }
    const citing = async (tid: string) => { const c = await db.from("qual_codings").select("excerpts").eq("survey_id", params.id).maybeSingle(); return excerptsCiting(c.data?.excerpts, tid); };
    const r = await excludeInterview(db, params.id, params.interviewId, a.action === "exclude", a.action === "exclude" ? a.reason : undefined, citing);
    await db.from("qual_events").insert({ survey_id: params.id, actor: gate.user.userId, actor_label: label, action: `ai_interview.${a.action}d`, detail: a.action === "exclude" ? `Excluded an AI interview${a.reason ? ` (${a.reason})` : ""}${r.transcriptKept ? ` — its transcript is kept because ${r.citations} coded excerpt(s) cite it` : ""}` : "Included an AI interview again", ids: [params.interviewId] });
    return json({ ok: true, ...r });
  } catch (e) { return failure(e); }
}

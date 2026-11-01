import { NextRequest, NextResponse } from "next/server";
import { callerFrom, canSee, notFound } from "@/lib/import/sessionAccess";
import { importSessionStore } from "@/lib/import/sessionsServer";
import { summarize } from "@/lib/import/sessions";
import { audit, isFailure, requireEditRightFor, requireProjectFor, requireUser } from "@/lib/guard";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * ONE IMPORT SESSION (I4).
 *   GET   the summary, the report digest and the decisions made during the import.
 *   POST  { action: "applied", surveyId? } — the import was applied: a new project (`surveyId` = the project
 *         POST /api/surveys created, which the caller must be able to read) or a merge (the session's own
 *         project, survey.edit). { action: "discarded" } — the preview was cancelled.
 * The status moves forward only: analyzed → applied | discarded; applied → rolled_back (the rollback route).
 */
export async function GET(req: NextRequest, { params }: { params: { id: string } }) {
  const authed = await requireUser(req);
  const store = importSessionStore();
  const s = await store.get(params.id).catch(() => null);
  if (isFailure(authed) && !(s && s.customerId === null)) return authed.response;
  const caller = callerFrom(authed, !!s && s.customerId === null);
  if ("response" in caller) return caller.response;
  if (!s || !canSee(s, caller)) return notFound();
  return NextResponse.json({ session: summarize(s), digest: s.reportDigest, decisions: s.decisions });
}

export async function POST(req: NextRequest, { params }: { params: { id: string } }) {
  const authed = await requireUser(req);
  const store = importSessionStore();
  const s = await store.get(params.id).catch(() => null);
  const caller = callerFrom(authed, !!s && s.customerId === null);
  if ("response" in caller) return caller.response;
  if (!s || !canSee(s, caller)) return notFound();
  let body: Record<string, unknown>;
  try { body = await req.json(); } catch { return NextResponse.json({ error: "bad json" }, { status: 400 }); }
  const action = body.action;
  if (action === "discarded") {
    if (s.status !== "analyzed") return NextResponse.json({ error: `this import is already ${s.status.replace("_", " ")}` }, { status: 409 });
    const next = await store.update(s.id, { status: "discarded" });
    return NextResponse.json({ session: next ? summarize(next) : null });
  }
  if (action !== "applied") return NextResponse.json({ error: "action must be applied or discarded" }, { status: 400 });
  if (s.status !== "analyzed") return NextResponse.json({ error: `this import is already ${s.status.replace("_", " ")}` }, { status: 409 });
  let surveyId = s.surveyId;
  if (s.customerId !== null) {
    if (!caller.user) return NextResponse.json({ error: "sign in" }, { status: 401 });
    if (s.into === "new") {
      const target = typeof body.surveyId === "string" ? body.surveyId : "";
      const ctx = await requireProjectFor(caller.user, target, "project.read");
      if (isFailure(ctx)) return ctx.response;
      surveyId = target;
    } else {
      const ctx = await requireProjectFor(caller.user, s.surveyId ?? "", "survey.edit");
      if (isFailure(ctx)) return ctx.response;
      /* the merge was an edit, made by whoever holds the editing lock — only they can say they made it */
      const gate = await requireEditRightFor(ctx);
      if (isFailure(gate)) return gate.response;
    }
  }
  const next = await store.update(s.id, { status: "applied", surveyId, appliedAt: new Date().toISOString() });
  if (caller.user && surveyId) await audit({ action: "survey.import_applied", userId: caller.user.userId, sessionId: caller.user.sessionId, surveyId, customerId: s.customerId, detail: { importSession: s.id, fileName: s.fileName, mode: s.into } }).catch(() => {});
  return NextResponse.json({ session: next ? summarize(next) : null });
}

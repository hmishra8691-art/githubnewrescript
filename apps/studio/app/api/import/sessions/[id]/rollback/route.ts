import { NextRequest, NextResponse } from "next/server";
import { callerFrom, canSee, notFound } from "@/lib/import/sessionAccess";
import { importSessionStore } from "@/lib/import/sessionsServer";
import { rollbackPlan, summarize } from "@/lib/import/sessions";
import { audit, isFailure, requireEditRightFor, requireProjectFor, requireUser } from "@/lib/guard";
import { supabaseAdmin } from "@/lib/admin";
import { DELETE as deleteProject } from "../../../../surveys/[id]/route";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * ROLL AN APPLIED IMPORT BACK (I4).
 *
 *   merge  → `{ action: "restore_definition", definition }`: the survey exactly as it was when the import was
 *            applied onto it. The editor applies it as one edit (undoable, saved like any edit); this route
 *            checks survey.edit and the editing lock, and marks the session rolled back.
 *   new    → the project the import created is deleted through the project DELETE route (project.delete, its
 *            audit record, its files) — refused when the project already has responses: a rollback never
 *            destroys collected data.
 * Anything else (not applied, already rolled back, the prior survey not kept) is refused with the reason.
 */
export async function POST(req: NextRequest, { params }: { params: { id: string } }) {
  const authed = await requireUser(req);
  const store = importSessionStore();
  const s = await store.get(params.id).catch(() => null);
  const caller = callerFrom(authed, !!s && s.customerId === null);
  if ("response" in caller) return caller.response;
  if (!s || !canSee(s, caller)) return notFound();

  let responses = 0;
  if (s.into === "new" && s.surveyId && s.customerId !== null) {
    const { count } = await supabaseAdmin().from("responses").select("id", { count: "exact", head: true }).eq("survey_id", s.surveyId);
    responses = count ?? 0;
  }
  const plan = rollbackPlan(s, { responses });
  if (plan.action === "refuse") return NextResponse.json({ error: plan.reason }, { status: plan.status });

  if (plan.action === "restore_definition") {
    if (s.customerId !== null) {
      if (!caller.user) return NextResponse.json({ error: "sign in" }, { status: 401 });
      const ctx = await requireProjectFor(caller.user, s.surveyId ?? "", "survey.edit");
      if (isFailure(ctx)) return ctx.response;
      const gate = await requireEditRightFor(ctx);
      if (isFailure(gate)) return gate.response;
    }
    const next = await store.update(s.id, { status: "rolled_back", rolledBackAt: new Date().toISOString() });
    if (caller.user && s.surveyId) await audit({ action: "survey.import_rolled_back", userId: caller.user.userId, sessionId: caller.user.sessionId, surveyId: s.surveyId, customerId: s.customerId, detail: { importSession: s.id, fileName: s.fileName, mode: "merge" } }).catch(() => {});
    return NextResponse.json({ action: "restore_definition", definition: plan.definition, session: next ? summarize(next) : null });
  }

  /* delete_project: the project route does the permission check (project.delete), the files and the audit */
  const res = await deleteProject(req, { params: { id: plan.surveyId } });
  if (!res.ok) return res;
  const next = await store.update(s.id, { status: "rolled_back", rolledBackAt: new Date().toISOString() });
  if (caller.user) await audit({ action: "survey.import_rolled_back", userId: caller.user.userId, sessionId: caller.user.sessionId, surveyId: null, customerId: s.customerId, detail: { importSession: s.id, fileName: s.fileName, mode: "new", deletedProject: plan.surveyId } }).catch(() => {});
  return NextResponse.json({ action: "delete_project", surveyId: plan.surveyId, session: next ? summarize(next) : null });
}

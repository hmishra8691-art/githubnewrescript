import { NextRequest, NextResponse } from "next/server";
import { isFailure, requireUser } from "@/lib/guard";
import { aiProviderName } from "@rescript/ai";
import { notFound, ownTask, taskAccess } from "@/lib/tasks/access";
import { ADVANCE_BUDGET_MS, advanceForRequest, viewOf } from "@/lib/tasks/service";

/**
 * POST /api/copilot/tasks/<id>/<action> { surveyId, budgetMs?, stepId?, aiOnce? } — survey.edit on the project.
 *   advance   run ONE slice now under the caller's own meter and consent (≤ ADVANCE_BUDGET_MS, one or two steps),
 *             answer with the persisted state — safe to call concurrently and repeatedly (leases; a completed step
 *             is never run again, a committed step is never billed again)
 *   pause     stop after the step in flight (needs_attention, reason user_input); Resume carries on
 *   resume    clear the pause and run from the earliest incomplete step; a failed step gets another go
 *   retry     { stepId? } one step again — a failed one, or every failed one when none is named
 *   cancel    stop; what was built is kept on the rows, nothing was applied
 */
export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export const maxDuration = 120;

export async function POST(req: NextRequest, { params }: { params: { id: string; action: string } }) {
  const authed = await requireUser(req);
  /* signed out: refused here (only the fake provider's sandbox may continue — checked again, by survey id, in taskAccess) */
  if (isFailure(authed) && aiProviderName() !== "fake") return authed.response;
  let body: { surveyId?: unknown; budgetMs?: unknown; stepId?: unknown; aiOnce?: unknown; maxSteps?: unknown } = {};
  try { body = await req.json(); } catch { /* an empty body is fine for most actions */ }
  const a = await taskAccess(authed, body.surveyId ?? req.nextUrl.searchParams.get("surveyId"), "survey.edit", body.aiOnce === true ? "once" : undefined);
  if ("response" in a) return a.response;
  const t = await ownTask(a, params.id);
  if (!t) return notFound();
  switch (params.action) {
    case "advance": {
      if (t.status === "completed" || t.status === "cancelled" || t.status === "failed") return NextResponse.json({ ok: true, task: viewOf(t), slice: null });
      const budgetMs = typeof body.budgetMs === "number" && body.budgetMs > 0 ? Math.min(body.budgetMs, ADVANCE_BUDGET_MS) : ADVANCE_BUDGET_MS;
      /* TEST SEAM (fake provider only): at most this many steps in the slice — a "killed" slice, one step at a time */
      const maxSteps = aiProviderName() === "fake" && typeof body.maxSteps === "number" && body.maxSteps > 0 ? Math.round(body.maxSteps) : undefined;
      const r = await advanceForRequest({ store: a.store, scope: a.scope, task: t, budgetMs, signal: req.signal, ...(maxSteps ? { maxSteps } : {}) });
      const after = (await a.store.load(t.id)) ?? t;
      return NextResponse.json({ ok: true, task: viewOf(after), slice: { built: r.built, remaining: r.remaining.length, failed: r.failed.map((f) => ({ id: f.id, kind: f.kind })), stoppedBy: r.stoppedBy, ...(r.retryAfterMs ? { retryAfterMs: r.retryAfterMs } : {}) }, usage: { charge: r.spend.charge } });
    }
    case "pause": {
      if (t.status === "pending" || t.status === "running") await a.store.pause(t.id, { reason: "user_input", message: "Paused by you. Resume carries on from the next step; everything built is kept." });
      break;
    }
    case "resume": {
      if (t.status === "needs_attention") await a.store.pause(t.id, null);
      else if (t.status === "failed") { await a.store.retry(t.id); await a.store.setStatus(t.id, "running"); }
      break;
    }
    case "retry": {
      const stepId = typeof body.stepId === "string" ? body.stepId : "";
      const revived = await a.store.retry(t.id, stepId || undefined);
      if (t.status === "failed" && revived.length) await a.store.setStatus(t.id, "running");
      else if (t.status === "needs_attention") await a.store.pause(t.id, null);
      break;
    }
    case "cancel": {
      if (t.status !== "completed" && t.status !== "cancelled") await a.store.setStatus(t.id, "cancelled", t.report);
      break;
    }
    default: return NextResponse.json({ error: "unknown action" }, { status: 404 });
  }
  const after = (await a.store.load(t.id)) ?? t;
  return NextResponse.json({ ok: true, task: viewOf(after) });
}

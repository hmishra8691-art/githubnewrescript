import { NextRequest, NextResponse } from "next/server";
import { SurveyDefinition } from "@rescript/schema";
import { isFailure, requireUser } from "@/lib/guard";
import { aiProviderName } from "@rescript/ai";
import { notFound, taskAccess } from "@/lib/tasks/access";
import { planForRequest, tasksEnabled, viewOf } from "@/lib/tasks/service";

/**
 * THE EXECUTION ENGINE'S TASKS (2026-10-29 — docs/EXECUTION-ENGINE-2026-10-29.md).
 *   GET  ?surveyId=                 the survey's open task (the one the panel reattaches to) and its recent tasks
 *   POST { surveyId, message, definition, planner? }   plan the request as a task with a registered planner and
 *        answer with its view — what the turn route does for a non-trivial request, callable directly
 */
export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export const maxDuration = 120;

export async function GET(req: NextRequest) {
  const authed = await requireUser(req);
  /* signed out: refused here (only the fake provider's sandbox may continue — checked again, by survey id, in taskAccess) */
  if (isFailure(authed) && aiProviderName() !== "fake") return authed.response;
  const a = await taskAccess(authed, req.nextUrl.searchParams.get("surveyId"), "project.read");
  if ("response" in a) return a.response;
  try {
    const [open, recent] = await Promise.all([a.store.openFor(a.surveyId), a.store.listFor(a.surveyId, 12)]);
    const newest = recent.find((t) => t.status === "needs_attention") ?? null;
    return NextResponse.json({ ok: true, durable: a.store.durable, task: open ? viewOf(open) : newest ? viewOf(newest) : null, tasks: recent.map(viewOf) });
  } catch (e) {
    console.warn("[rescript:copilot]", JSON.stringify({ event: "the tasks could not be read", error: ((e as Error)?.message ?? "").slice(0, 200) }));
    return NextResponse.json({ ok: true, durable: false, task: null, tasks: [] });
  }
}

export async function POST(req: NextRequest) {
  const authed = await requireUser(req);
  /* signed out: refused here (only the fake provider's sandbox may continue — checked again, by survey id, in taskAccess) */
  if (isFailure(authed) && aiProviderName() !== "fake") return authed.response;
  let body: { surveyId?: unknown; message?: unknown; definition?: unknown; planner?: unknown; aiOnce?: unknown };
  try { body = await req.json(); } catch { return NextResponse.json({ error: "bad json" }, { status: 400 }); }
  const a = await taskAccess(authed, body.surveyId, "survey.edit", body.aiOnce === true ? "once" : undefined);
  if ("response" in a) return a.response;
  if (!tasksEnabled()) return NextResponse.json({ error: "Plan-first tasks are switched off on this server (COPILOT_TASKS=off).", code: "tasks_off" }, { status: 501 });
  const message = typeof body.message === "string" ? body.message.trim().slice(0, 60_000) : "";
  if (!message) return NextResponse.json({ error: "say what you want (message)" }, { status: 400 });
  const parsed = SurveyDefinition.safeParse(body.definition);
  if (!parsed.success) return NextResponse.json({ error: "send the survey as it is open in the editor (definition)" }, { status: 400 });
  const plan = await planForRequest({ store: a.store, scope: a.scope, surveyId: a.surveyId, message, definition: parsed.data, ...(a.customerId ? { customerId: a.customerId } : {}), ...(a.userId ? { createdBy: a.userId } : {}), deadline: Date.now() + 90_000, signal: req.signal, ...(typeof body.planner === "string" ? { plannerId: body.planner } : {}) });
  if (!plan.ok) return plan.reason === "no_planner" ? notFound() : NextResponse.json({ ok: false, error: plan.message, code: plan.reason, errors: plan.errors ?? [] }, { status: 422 });
  return NextResponse.json({ ok: true, created: true, durable: a.store.durable, task: viewOf(plan.task), usage: { charge: plan.usage.charge } });
}

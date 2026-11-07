import { NextRequest, NextResponse } from "next/server";
import { SurveyDefinition } from "@rescript/schema";
import { isFailure, requireProjectFor, requireUser } from "@/lib/guard";
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

const RESEARCH_PLANNERS = new Set(["analysis", "report", "decision"]);

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
  let body: { surveyId?: unknown; message?: unknown; definition?: unknown; planner?: unknown; aiOnce?: unknown; options?: unknown };
  try { body = await req.json(); } catch { return NextResponse.json({ error: "bad json" }, { status: 400 }); }
  const a = await taskAccess(authed, body.surveyId, "survey.edit", body.aiOnce === true ? "once" : undefined);
  if ("response" in a) return a.response;
  if (!tasksEnabled()) return NextResponse.json({ error: "Plan-first tasks are switched off on this server (COPILOT_TASKS=off).", code: "tasks_off" }, { status: 501 });
  const message = typeof body.message === "string" ? body.message.trim().slice(0, 60_000) : "";
  if (!message) return NextResponse.json({ error: "say what you want (message)" }, { status: 400 });
  const parsed = SurveyDefinition.safeParse(body.definition);
  if (!parsed.success) return NextResponse.json({ error: "send the survey as it is open in the editor (definition)" }, { status: 400 });
  /* the research agents write the analytics tables (saved analyses, runs, reports): Data Analytics' edit right as well */
  const planner = typeof body.planner === "string" ? body.planner : undefined;
  if (planner && RESEARCH_PLANNERS.has(planner) && a.surveyId !== "sandbox") {
    if (isFailure(authed)) return authed.response;
    const ctx = await requireProjectFor(authed, a.surveyId, "analytics.edit");
    if (isFailure(ctx)) return ctx.response;
  }
  const options = body.options && typeof body.options === "object" && !Array.isArray(body.options) ? Object.fromEntries(Object.entries(body.options as Record<string, unknown>).filter(([, v]) => ["string", "number", "boolean"].includes(typeof v)).slice(0, 20)) : undefined;
  const plan = await planForRequest({ store: a.store, scope: a.scope, surveyId: a.surveyId, message, definition: parsed.data, ...(a.customerId ? { customerId: a.customerId } : {}), ...(a.userId ? { createdBy: a.userId } : {}), deadline: Date.now() + 90_000, signal: req.signal, ...(planner ? { plannerId: planner } : {}), ...(options ? { options } : {}) });
  if (!plan.ok) return plan.reason === "no_planner" ? notFound() : NextResponse.json({ ok: false, error: plan.message, code: plan.reason, errors: plan.errors ?? [] }, { status: 422 });
  return NextResponse.json({ ok: true, created: true, durable: a.store.durable, task: viewOf(plan.task), usage: { charge: plan.usage.charge } });
}

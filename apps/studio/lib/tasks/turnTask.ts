import "server-only";
/**
 * PLAN FIRST, IN THE TURN ROUTE (2026-10-29, ported from K1 onto the base engine). Read AFTER the request is
 * classified and BEFORE any model call: the deterministic size estimate (`estimateTaskSize`, packages/engine) and
 * the registered planners' own deterministic match. A non-trivial request — "100 questions, General Studies" in
 * 650 Hindi characters, "add explanations to every question" on a 104-question survey, "design a CBC study" —
 * becomes a durable task of small steps and the turn answers at once with `stage: "task"` and the task's view; the
 * page then drives it through …/advance (and the cron carries it on when the page is gone). A trivial request —
 * one edit, a question about the survey, a small proposal — returns null here and the single-turn path runs
 * exactly as before.
 *
 * Kept on the old path on purpose: the Branding theme assistant, the build of an approved change plan
 * (`stage: "plan" / "execute"`, the existing contract the suites assert on), `task: false` from the caller, and —
 * fake provider only — a turn that carries a scripted single reply (`fake`) without `task: true`: that scripted
 * reply stands in for the one model answer the existing suites expect. A store that is NOT durable on a real
 * project (migration 0074 missing) also falls back: a Vercel instance's memory is not a checkpoint, so the request
 * runs as before and the fallback is logged once per process.
 */
import { NextResponse } from "next/server";
import { aiProviderName } from "@rescript/ai";
import { estimateTaskSize, saysPlanFirst, type TaskEstimate } from "@rescript/engine";
import type { SurveyDefinition } from "@rescript/schema";
import { taskStoreFor } from "@/lib/copilot/taskStore";
import { continuesTask } from "@/lib/copilot/planPersistence";
import { NOTICES, replyLanguage } from "@/lib/copilot/notices";
import { pickTaskPlanner } from "./registry.ts";
import { isHandlerTask, planForRequest, tasksEnabled, viewOf } from "./service.ts";
import type { TaskAiScope } from "./aiServer.ts";

export interface TurnTaskArgs {
  body: { stage?: unknown; scope?: unknown; task?: unknown; forceTask?: unknown; fake?: unknown; planner?: unknown };
  message: string;
  def: SurveyDefinition;
  surveyId: string;
  /** the request's own meter, context and one-time consent — the planner's one call is paid by this request */
  scope: TaskAiScope;
  customerId?: string;
  userId?: string;
  /** absolute ms: the planner's call may not run past this */
  deadline: number;
  signal?: AbortSignal;
  /** the route's own classification, for the log */
  mode?: string;
}

export interface TurnDecision { task: boolean; reason: string; estimate: TaskEstimate; planner: string | null; score: number }

/** the decision alone (pure but for the registry): task or single turn, and why */
export function turnDecision(a: Pick<TurnTaskArgs, "body" | "message" | "def">): TurnDecision {
  const force = a.body.forceTask === true || a.body.task === true || saysPlanFirst(a.message);
  const estimate = estimateTaskSize({ message: a.message, survey: a.def, force });
  const picked = pickTaskPlanner({ message: a.message, survey: a.def });
  const plannerForces = !!picked && picked.score >= 0.9;
  return { task: estimate.task || plannerForces, reason: estimate.task ? estimate.reason : plannerForces ? `planner:${picked!.planner.id}` : "small", estimate, planner: picked?.planner.id ?? null, score: picked?.score ?? 0 };
}

const G = globalThis as unknown as { __rescriptTaskFallbackSaid?: boolean };

/**
 * The turn's answer when the request is a task, or null when it stays a single turn. Nothing here calls a model
 * except the planner's own call (an outline), under the request's meter.
 */
export async function taskForTurn(a: TurnTaskArgs): Promise<Response | null> {
  if (!tasksEnabled()) return null;
  if (a.body.scope === "theme" || a.body.stage === "execute" || a.body.stage === "plan" || a.body.task === false) return null;
  const fake = aiProviderName() === "fake";
  if (fake && a.body.fake && a.body.task !== true) return null;
  const d = turnDecision(a);
  if (!d.task) return null;
  const store = await taskStoreFor(a.surveyId);
  const sandbox = a.surveyId === "sandbox" || a.surveyId.startsWith("sandbox:");
  if (!store.durable && !sandbox) {
    if (!G.__rescriptTaskFallbackSaid) {
      G.__rescriptTaskFallbackSaid = true;
      console.warn("[rescript:copilot]", JSON.stringify({ event: "plan-first task not created: the task tables are not durable here (apply migration 0074); the request runs on the single-turn path", surveyId: a.surveyId }));
    }
    return null;
  }
  const lang = replyLanguage(a.message);
  /* "continue" / "carry on" on an open task of this survey: the task is the answer, no new plan */
  const open = await store.openFor(a.surveyId).catch(() => null);
  if (open && isHandlerTask(open) && continuesTask(open, a.surveyId, a.message).why === "phrase") {
    return NextResponse.json({ ok: true, stage: "task", created: false, durable: store.durable, task: viewOf(open), reply: answer(NOTICES.plannedAsTask(lang, open.steps.filter((s) => s.status !== "tombstoned").length, 0, "")), context: { mode: "task", task: { reason: "continuation", kind: open.kind, planner: open.planner ?? null }, modelCalled: false, promptChars: 0, cached: false }, usage: { charge: 0 } });
  }
  const plan = await planForRequest({ store, scope: a.scope, surveyId: a.surveyId, message: a.message, definition: a.def, ...(a.customerId ? { customerId: a.customerId } : {}), ...(a.userId ? { createdBy: a.userId } : {}), deadline: a.deadline, ...(a.signal ? { signal: a.signal } : {}), ...(fake && typeof a.body.planner === "string" ? { plannerId: a.body.planner } : {}) });
  if (!plan.ok) {
    /* the plan could not be made: the single-turn path, as before this feature existed — said in the log, never a lost request */
    console.warn("[rescript:copilot]", JSON.stringify({ event: "plan-first task not created; single-turn path", surveyId: a.surveyId, reason: plan.reason, message: plan.message.slice(0, 200) }));
    return null;
  }
  const t = plan.task;
  const units = d.estimate.units;
  const what = d.estimate.kind === "translate" ? "questions to translate" : d.estimate.kind === "per_question" || d.estimate.kind === "rework_all" ? "questions to change" : "questions";
  console.warn("[rescript:copilot]", JSON.stringify({ event: "planned as a durable task", surveyId: a.surveyId, taskId: t.id, planner: plan.planner, reason: d.reason, mode: a.mode ?? null, kind: d.estimate.kind, units, steps: plan.steps, outputTokens: d.estimate.outputTokens, durable: store.durable }));
  return NextResponse.json({
    ok: true, stage: "task", created: true, durable: store.durable, task: viewOf(t),
    reply: answer(NOTICES.plannedAsTask(lang, plan.steps, units, what)),
    context: { mode: "task", task: { reason: d.reason, reasons: d.estimate.reasons, kind: d.estimate.kind, taskKind: t.kind, planner: plan.planner, units, steps: plan.steps, outputTokens: d.estimate.outputTokens }, modelCalled: plan.usage.calls > 0, promptChars: 0, cached: false },
    usage: { charge: plan.usage.charge },
  });
}

const answer = (reply: string) => ({ kind: "answer", reply, plan: [], actions: [], rejected: [], findings: [], assumptions: [], questions: [], sources: [] });

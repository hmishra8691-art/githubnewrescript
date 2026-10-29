import "server-only";
/**
 * WHO MAY SEE AND DRIVE A TASK (2026-10-29). The routes call `requireUser` as their FIRST statement (the
 * auth-guard audit's rule), then this: the project must be one the caller holds the capability on
 * (`requireProjectFor` — `survey.edit` to advance / resume / retry / cancel, `project.read` to look), and the task
 * must belong to that project. The sandbox (surveyId "sandbox") is reachable without a session only against the
 * FAKE provider, exactly as `/api/copilot/task` and the turn route allow it; its meter is the in-memory sandbox
 * meter, so nothing can be spent there.
 */
import { NextResponse } from "next/server";
import { aiProviderName } from "@rescript/ai";
import type { Capability } from "@rescript/access";
import type { ExecTask } from "@rescript/engine";
import { isFailure, requireProjectFor, type AuthedUser, type GuardFailure } from "@/lib/guard";
import { billingProjectFor } from "@/lib/metering";
import { taskStoreFor, type TaskStore } from "@/lib/copilot/taskStore";
import type { TaskAiScope } from "./aiServer.ts";

export interface TaskAccess { store: TaskStore; surveyId: string; user: AuthedUser | null; customerId?: string; userId?: string; scope: TaskAiScope }

/** the caller's right on the project, the project's store and — for a write — the meter a slice runs under */
export async function taskAccess(authed: AuthedUser | GuardFailure, surveyIdRaw: unknown, capability: Capability, consent?: "once"): Promise<TaskAccess | { response: Response }> {
  const surveyId = typeof surveyIdRaw === "string" ? surveyIdRaw.trim().slice(0, 80) : "";
  if (!surveyId) return { response: NextResponse.json({ error: "Name the project (surveyId).", code: "survey_required" }, { status: 400 }) };
  let user: AuthedUser | null = null;
  if (isFailure(authed)) { if (!(surveyId === "sandbox" && aiProviderName() === "fake")) return { response: authed.response }; }
  else user = authed;
  if (surveyId !== "sandbox" && user) {
    const gate = await requireProjectFor(user, surveyId, capability);
    if (isFailure(gate)) return { response: gate.response };
  }
  /* the meter: the project's (survey.edit, as the turn route bills) or the sandbox's; a read-only view still needs none but gets the same shape */
  const billing = await billingProjectFor(user, surveyId, capability === "project.read" ? "project.read" : "survey.edit");
  if ("response" in billing) return { response: billing.response };
  const store = await taskStoreFor(surveyId);
  return { store, surveyId, user, ...(billing.ctx.customerId && billing.ctx.customerId !== "sandbox" ? { customerId: billing.ctx.customerId } : {}), ...(billing.ctx.userId ? { userId: billing.ctx.userId } : {}), scope: { meter: billing.meter, ctx: billing.ctx, ...(consent ? { consent } : {}) } };
}

/** the task, only when it is this project's */
export async function ownTask(a: TaskAccess, id: unknown): Promise<ExecTask | null> {
  const tid = typeof id === "string" ? id.trim() : "";
  if (!/^[\w-]{6,80}$/.test(tid)) return null;
  const t = await a.store.load(tid).catch(() => null);
  return t && t.surveyId === a.surveyId ? t : null;
}

export const notFound = () => NextResponse.json({ error: "No such task on this project." }, { status: 404 });

import { NextRequest, NextResponse } from "next/server";
import { isFailure, requireUser } from "@/lib/guard";
import { aiProviderName } from "@rescript/ai";
import { notFound, ownTask, taskAccess } from "@/lib/tasks/access";
import { resultOf, stepsVisible, viewOf } from "@/lib/tasks/service";

/**
 * GET /api/copilot/tasks/<id>?surveyId=[&result=1][&steps=1] — one task as the client may see it
 * (`redactForClient`: no request text, no model output); with `result=1` and a completed task, the proposal the
 * researcher reviews and applies once (every completed step's actions in plan order); with `steps=1`, the persisted
 * step rows with their outputs — a TEST SEAM that answers only on the fake provider outside production.
 */
export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET(req: NextRequest, { params }: { params: { id: string } }) {
  const authed = await requireUser(req);
  /* signed out: refused here (only the fake provider's sandbox may continue — checked again, by survey id, in taskAccess) */
  if (isFailure(authed) && aiProviderName() !== "fake") return authed.response;
  const q = req.nextUrl.searchParams;
  const a = await taskAccess(authed, q.get("surveyId"), "project.read");
  if ("response" in a) return a.response;
  const t = await ownTask(a, params.id);
  if (!t) return notFound();
  return NextResponse.json({
    ok: true, durable: a.store.durable, task: viewOf(t),
    ...(q.get("result") === "1" ? { result: resultOf(t) } : {}),
    ...(q.get("steps") === "1" && stepsVisible() ? { steps: t.steps.map((s) => ({ stepId: s.stepId, kind: s.kind, status: s.status, planVersion: s.planVersion, dependsOn: s.dependsOn, retryCount: s.retryCount, idempotencyKey: s.idempotencyKey, usage: s.usage, output: s.output, input: s.input })) } : {}),
  });
}

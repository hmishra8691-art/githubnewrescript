import { NextRequest, NextResponse } from "next/server";
import { audit, isFailure, requireEditRightFor, requireProjectFor, requireUser } from "@/lib/guard";

export const dynamic = "force-dynamic";

/**
 * THE AUDIT RECORD OF AN AI CHANGE (the copilot brief §18). A copilot
 * proposal is applied in the editor — reviewed, one undoable edit, saved by
 * the ordinary save path — and the editor records it here once applied (or
 * reverted), so the Activity tab says what the AI changed, at whose request.
 * Body: { surveyId, n, request, summary, created, modified, removed,
 * excluded?, reverted? } — `excluded`: the proposed changes the researcher
 * left out of a selective apply, so the record says what was NOT done too. Records only; changes nothing. The caller must hold the
 * editing lock: only whoever made the edit can say they made it.
 */
export async function POST(req: NextRequest) {
  const user = await requireUser(req);
  let body: Record<string, unknown>;
  try { body = await req.json(); } catch { return isFailure(user) ? user.response : NextResponse.json({ error: "bad json" }, { status: 400 }); }
  const surveyId = typeof body.surveyId === "string" ? body.surveyId : "";
  if (surveyId === "sandbox") return NextResponse.json({ ok: true, recorded: false });
  if (isFailure(user)) return user.response;
  const ctx = await requireProjectFor(user, surveyId, "survey.edit");
  if (isFailure(ctx)) return ctx.response;
  const gate = await requireEditRightFor(ctx);
  if (isFailure(gate)) return gate.response;
  const s = (k: string, n = 300) => (typeof body[k] === "string" ? String(body[k]).slice(0, n) : undefined);
  const num = (k: string) => (Number.isFinite(Number(body[k])) ? Number(body[k]) : undefined);
  const strs = (k: string) => (Array.isArray(body[k]) ? (body[k] as unknown[]).map(String).slice(0, 60) : undefined);
  await audit({
    action: "survey.ai_changed", userId: gate.user.userId, sessionId: gate.user.sessionId, surveyId, customerId: gate.survey.customer_id ?? gate.user.customerId,
    detail: { n: num("n"), request: s("request", 500), summary: s("summary", 500), created: strs("created"), modified: strs("modified"), removed: strs("removed"), excluded: strs("excluded"), reverted: body.reverted === true },
  });
  return NextResponse.json({ ok: true, recorded: true });
}

import { NextRequest, NextResponse } from "next/server";
import { audit, isFailure, requireEditRightFor, requireProjectFor, requireUser } from "@/lib/guard";

export const dynamic = "force-dynamic";

/**
 * THE AUDIT RECORD OF AN IMPORT MERGED INTO AN OPEN SURVEY (the import brief
 * §38). A new project records its import when POST /api/surveys creates it;
 * a merge is applied in the editor — reviewed, undoable, saved like any edit
 * — and the editor calls this once the programmer has applied it, so the
 * Activity tab says which file went in, from where, and how much was left to
 * review. Body: { surveyId, fileName, label, format, platform, questions,
 * review, fingerprint, scope }. Records only; changes nothing.
 */
export async function POST(req: NextRequest) {
  const user = await requireUser(req);
  let body: Record<string, unknown>;
  try { body = await req.json(); } catch { return isFailure(user) ? user.response : NextResponse.json({ error: "bad json" }, { status: 400 }); }
  const surveyId = typeof body.surveyId === "string" ? body.surveyId : "";
  // the sandbox has no project and no audit trail: nothing to record, and no session needed to say so
  if (surveyId === "sandbox") return NextResponse.json({ ok: true, recorded: false });
  if (isFailure(user)) return user.response;
  const ctx = await requireProjectFor(user, surveyId, "survey.edit");
  if (isFailure(ctx)) return ctx.response;
  // the merge was an edit, made by whoever holds the editing lock — only they can say they made it
  const gate = await requireEditRightFor(ctx);
  if (isFailure(gate)) return gate.response;
  const s = (k: string, n = 200) => (typeof body[k] === "string" ? String(body[k]).slice(0, n) : undefined);
  const num = (k: string) => (Number.isFinite(Number(body[k])) ? Number(body[k]) : undefined);
  await audit({
    action: "survey.imported", userId: gate.user.userId, sessionId: gate.user.sessionId, surveyId, customerId: gate.survey.customer_id ?? gate.user.customerId,
    detail: { mode: "merge", fileName: s("fileName"), label: s("label"), format: s("format", 20), platform: s("platform", 20), scope: s("scope", 20), fingerprint: s("fingerprint", 40), questions: num("questions"), review: num("review") },
  });
  return NextResponse.json({ ok: true, recorded: true });
}

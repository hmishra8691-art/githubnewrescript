import { NextRequest, NextResponse } from "next/server";
import type { AuditEvent } from "@rescript/access";
import { audit, isFailure, requireProject } from "@/lib/guard";

export const dynamic = "force-dynamic";

/**
 * QUOTA CHANGE RECORD.
 *
 * The Quota Dashboard edits quota configuration through the ordinary
 * definition autosave — that is where the change is persisted, exactly as an
 * edit in the Logic Builder is. What autosave cannot record is WHAT changed:
 * it stores the whole definition. So the dashboard also posts the before/after
 * of the numbers it changed here, and that lands in `audit_logs` beside every
 * other project event (who, when, previous value, new value, the revision the
 * change was made on top of). Needs `survey.edit`, the same right the edit
 * itself needed.
 */
export async function POST(req: NextRequest, { params }: { params: { id: string } }) {
  const gate = await requireProject(req, params.id, "survey.edit");
  if (isFailure(gate)) return gate.response;
  const body = await req.json().catch(() => ({}));
  const kind = body.action;
  if (kind !== "created" && kind !== "modified" && kind !== "deleted") {
    return NextResponse.json({ error: "action must be created, modified or deleted" }, { status: 400 });
  }
  if (typeof body.quotaId !== "string" || !body.quotaId) return NextResponse.json({ error: "quotaId is required" }, { status: 400 });
  await audit({
    action: `quota.${kind}` as AuditEvent,
    userId: gate.user.userId, sessionId: gate.user.sessionId,
    surveyId: params.id, customerId: gate.user.customerId,
    entity: "quota", entityId: body.quotaId,
    detail: {
      quotaId: body.quotaId,
      quotaName: typeof body.quotaName === "string" ? body.quotaName.slice(0, 200) : undefined,
      changes: body.changes && typeof body.changes === "object" ? body.changes : undefined,
      cells: typeof body.cells === "number" ? body.cells : undefined,
      environment: typeof body.environment === "string" ? body.environment : undefined,
      revision: typeof body.revision === "number" ? body.revision : undefined,
    },
  });
  return NextResponse.json({ ok: true });
}

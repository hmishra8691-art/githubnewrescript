import { NextRequest, NextResponse } from "next/server";
import { supabaseService } from "@/lib/authServer";
import { audit, isFailure, notifyProject, requireProject } from "@/lib/guard";

export const dynamic = "force-dynamic";

/**
 * TRANSFER OWNERSHIP (§12).
 *
 * The outgoing owner becomes an Editor rather than losing access: handing a
 * project over is not the same as walking away from it, and a transfer that
 * silently locked the previous owner out would be an unpleasant surprise for
 * whoever still has questions about the routing.
 *
 * The new owner must already be a collaborator. Ownership is not a way to
 * grant access — it is a way to move responsibility for access that exists.
 */
export async function POST(req: NextRequest, { params }: { params: { id: string } }) {
  const ctx = await requireProject(req, params.id, "project.transfer");
  if (isFailure(ctx)) return ctx.response;

  let body: any;
  try { body = await req.json(); } catch { return NextResponse.json({ error: "bad json" }, { status: 400 }); }
  const targetId = String(body?.userId ?? "");
  if (!targetId) return NextResponse.json({ error: "Who should own this project?" }, { status: 400 });
  if (targetId === ctx.survey.owner_id) return NextResponse.json({ ok: true, unchanged: true });

  const db = supabaseService();
  const [{ data: person }, { data: membership }] = await Promise.all([
    db.from("profiles").select("id, full_name, user_code, status, customer_id").eq("id", targetId).maybeSingle(),
    db.from("project_members").select("role").eq("survey_id", params.id).eq("user_id", targetId).maybeSingle(),
  ]);
  if (!person) return NextResponse.json({ error: "Unknown account." }, { status: 404 });
  if (person.status !== "active") return NextResponse.json({ error: "That account is disabled." }, { status: 409 });
  if (!membership) {
    return NextResponse.json(
      { error: `${person.full_name} is not a collaborator on this project. Share it with them first, then transfer ownership.` },
      { status: 409 },
    );
  }

  const previousOwner = ctx.survey.owner_id;

  // the new owner's membership row is redundant once they own it — ownership is
  // a column on the survey, and leaving both would give one person two roles
  const { error: e1 } = await db.from("surveys").update({ owner_id: targetId }).eq("id", params.id);
  if (e1) return NextResponse.json({ error: e1.message }, { status: 500 });
  await db.from("project_members").delete().eq("survey_id", params.id).eq("user_id", targetId);

  if (previousOwner) {
    await db.from("project_members").upsert(
      { survey_id: params.id, user_id: previousOwner, role: "editor", added_by: ctx.user.userId, updated_at: new Date().toISOString() },
      { onConflict: "survey_id,user_id" },
    );
  }

  await audit({
    action: "project.ownership_transferred", userId: ctx.user.userId, sessionId: ctx.user.sessionId,
    surveyId: params.id, customerId: ctx.user.customerId,
    detail: { targetName: person.full_name, targetUserCode: person.user_code, previousOwner },
  });
  await notifyProject({
    surveyId: params.id, action: "project.ownership_transferred", exceptUserId: ctx.user.userId,
    detail: { actorName: ctx.user.fullName, targetName: person.full_name, project: `${ctx.survey.code} — ${ctx.survey.title}` },
  });

  return NextResponse.json({
    ok: true,
    newOwner: { userId: person.id, name: person.full_name, userCode: person.user_code },
    previousOwnerRole: previousOwner ? "editor" : null,
    message: `${person.full_name} now owns this project. You remain an Editor.`,
  });
}

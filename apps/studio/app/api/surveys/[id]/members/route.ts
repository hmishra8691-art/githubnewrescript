import { NextRequest, NextResponse } from "next/server";
import {
  avatarHue, GRANTABLE_ROLES, initialsOf, isProjectRole, ROLE_DESCRIPTION, ROLE_LABEL,
} from "@rescript/access";
import { supabaseService } from "@/lib/authServer";
import { audit, isFailure, notifyProject, requireProject } from "@/lib/guard";

export const dynamic = "force-dynamic";

/**
 * PROJECT COLLABORATORS (§20) — read, change a role, remove access.
 *
 * The list is grouped by role with the owner first, because that is how the
 * requirement's own mock-up reads and how a researcher thinks about it: who
 * is responsible, then who can change things, then who can only look.
 *
 * Every mutation here is audited and notified. Losing access to a project you
 * were working in without being told is the kind of thing that costs a
 * morning.
 */
export async function GET(req: NextRequest, { params }: { params: { id: string } }) {
  const ctx = await requireProject(req, params.id, "project.read_members");
  if (isFailure(ctx)) return ctx.response;
  const db = supabaseService();

  const [{ data: members }, { data: invitations }] = await Promise.all([
    db.rpc("rescript_project_members", {
      p_survey: params.id,
      p_present_within_seconds: ctx.user.policies.presence.presentWithinSeconds,
    }),
    db.from("project_invitations")
      .select("id, email, user_code, role, created_at, expires_at")
      .eq("survey_id", params.id).is("accepted_at", null).is("revoked_at", null)
      .order("created_at", { ascending: false }),
  ]);

  const rows = ((members ?? []) as {
    user_id: string; user_code: string; full_name: string; email: string; organization: string;
    role: string; is_owner: boolean; added_at: string; status: string;
    last_login_at: string; present: boolean; activity: string; last_seen_at: string;
  }[]).map((m) => ({
    userId: m.user_id,
    userCode: m.user_code,
    name: m.full_name,
    email: m.email,
    organization: m.organization,
    role: m.role,
    roleLabel: ROLE_LABEL[m.role as keyof typeof ROLE_LABEL] ?? m.role,
    isOwner: m.is_owner,
    accountStatus: m.status,
    addedAt: m.added_at,
    lastActivity: m.last_seen_at ?? m.last_login_at,
    currentlyActive: !!m.present,
    activity: m.activity,
    initials: initialsOf(m.full_name, m.user_code?.slice(-2) ?? "?"),
    hue: avatarHue(m.user_id),
    isMe: m.user_id === ctx.user.userId,
    /** the owner cannot be demoted or removed — ownership is transferred (§12) */
    changeable: !m.is_owner && ctx.role === "owner",
  }));

  // grouped for the panel, in the order the requirement lists the roles
  const order = ["owner", ...GRANTABLE_ROLES];
  const groups = order
    .map((role) => ({
      role,
      label: ROLE_LABEL[role as keyof typeof ROLE_LABEL] ?? role,
      description: ROLE_DESCRIPTION[role as keyof typeof ROLE_DESCRIPTION] ?? "",
      members: rows.filter((r) => r.role === role),
    }))
    .filter((g) => g.members.length);

  return NextResponse.json({
    project: { id: ctx.survey.id, code: ctx.survey.code, title: ctx.survey.title },
    owner: rows.find((r) => r.isOwner) ?? null,
    members: rows,
    groups,
    invitations: (invitations ?? []).map((i) => ({
      id: i.id, email: i.email, userCode: i.user_code,
      role: i.role, roleLabel: ROLE_LABEL[i.role as keyof typeof ROLE_LABEL] ?? i.role,
      invitedAt: i.created_at, expiresAt: i.expires_at,
    })),
    myRole: ctx.role,
    canManage: ctx.role === "owner" || ctx.user.isPlatformAdmin,
    grantableRoles: GRANTABLE_ROLES.map((r) => ({ value: r, label: ROLE_LABEL[r], description: ROLE_DESCRIPTION[r] })),
  }, { headers: { "cache-control": "no-store" } });
}

/** Change a collaborator's role (§12). */
export async function PATCH(req: NextRequest, { params }: { params: { id: string } }) {
  const ctx = await requireProject(req, params.id, "project.manage_members");
  if (isFailure(ctx)) return ctx.response;

  let body: any;
  try { body = await req.json(); } catch { return NextResponse.json({ error: "bad json" }, { status: 400 }); }
  const targetId = String(body?.userId ?? "");
  const role = String(body?.role ?? "");
  if (!targetId) return NextResponse.json({ error: "Which collaborator?" }, { status: 400 });
  if (!isProjectRole(role) || !GRANTABLE_ROLES.includes(role)) {
    return NextResponse.json({ error: "That is not a role that can be granted." }, { status: 400 });
  }
  if (targetId === ctx.survey.owner_id) {
    return NextResponse.json(
      { error: "The owner's role cannot be changed. Transfer ownership instead." },
      { status: 409 },
    );
  }

  const db = supabaseService();
  const { data: person } = await db.from("profiles").select("full_name, user_code").eq("id", targetId).maybeSingle();
  const { data: existing } = await db
    .from("project_members").select("role").eq("survey_id", params.id).eq("user_id", targetId).maybeSingle();
  if (!existing) return NextResponse.json({ error: "That person is not a collaborator on this project." }, { status: 404 });
  if (existing.role === role) return NextResponse.json({ ok: true, unchanged: true });

  const { error } = await db
    .from("project_members")
    .update({ role, updated_at: new Date().toISOString() })
    .eq("survey_id", params.id).eq("user_id", targetId);
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  /*
   * A demotion below `survey.edit` while they hold the lock must take the lock
   * away too, or a user with no right to edit would keep editing until their
   * next save was refused — and the refusal would be confusing rather than
   * informative.
   */
  let lockReleased = false;
  if (!["editor", "programmer"].includes(role)) {
    const { data: lock } = await db
      .from("project_edit_locks").select("locked_by_user_id, status")
      .eq("survey_id", params.id).maybeSingle();
    if (lock?.status === "held" && lock.locked_by_user_id === targetId) {
      await db.rpc("rescript_force_release_lock", {
        p_survey: params.id, p_by: ctx.user.userId, p_reason: "role_changed",
      });
      lockReleased = true;
    }
  }

  await audit({
    action: "project.permission_changed", userId: ctx.user.userId, sessionId: ctx.user.sessionId,
    surveyId: params.id, customerId: ctx.user.customerId,
    detail: { targetName: person?.full_name, targetUserCode: person?.user_code, role: ROLE_LABEL[role], from: existing.role, lockReleased },
  });
  await notifyProject({
    surveyId: params.id, action: "project.permission_changed", onlyUserIds: [targetId],
    detail: { actorName: ctx.user.fullName, role: ROLE_LABEL[role], project: `${ctx.survey.code} — ${ctx.survey.title}` },
  });

  return NextResponse.json({ ok: true, role, lockReleased });
}

/** Remove a collaborator (§12). */
export async function DELETE(req: NextRequest, { params }: { params: { id: string } }) {
  const ctx = await requireProject(req, params.id, "project.manage_members");
  if (isFailure(ctx)) return ctx.response;

  let body: any = {};
  try { body = await req.json(); } catch { /* optional */ }
  const targetId = String(body?.userId ?? new URL(req.url).searchParams.get("userId") ?? "");
  if (!targetId) return NextResponse.json({ error: "Which collaborator?" }, { status: 400 });
  if (targetId === ctx.survey.owner_id) {
    return NextResponse.json(
      { error: "The owner cannot be removed from their own project. Transfer ownership first." },
      { status: 409 },
    );
  }

  const db = supabaseService();
  const { data: person } = await db.from("profiles").select("full_name, user_code").eq("id", targetId).maybeSingle();

  // whatever they were holding goes back the moment their access does
  const { data: lock } = await db
    .from("project_edit_locks").select("locked_by_user_id, status").eq("survey_id", params.id).maybeSingle();
  if (lock?.status === "held" && lock.locked_by_user_id === targetId) {
    await db.rpc("rescript_force_release_lock", { p_survey: params.id, p_by: ctx.user.userId, p_reason: "access_removed" });
  }
  await db.from("project_presence").delete().eq("survey_id", params.id).eq("user_id", targetId);

  const { error } = await db.from("project_members").delete().eq("survey_id", params.id).eq("user_id", targetId);
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  await audit({
    action: "project.access_removed", userId: ctx.user.userId, sessionId: ctx.user.sessionId,
    surveyId: params.id, customerId: ctx.user.customerId,
    detail: { targetName: person?.full_name, targetUserCode: person?.user_code },
  });
  // told, not left to discover it
  await notifyProject({
    surveyId: params.id, action: "project.access_removed", onlyUserIds: [targetId],
    detail: { actorName: ctx.user.fullName, project: `${ctx.survey.code} — ${ctx.survey.title}` },
  });

  return NextResponse.json({ ok: true });
}

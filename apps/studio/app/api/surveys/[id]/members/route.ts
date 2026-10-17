import { NextRequest, NextResponse } from "next/server";
import {
  accessLabel, avatarHue, can, diffAccess, GRANTABLE_ROLES, initialsOf, ROLE_DESCRIPTION, ROLE_LABEL,
  type AuditRow, type MemberGrant,
} from "@rescript/access";
import { supabaseService } from "@/lib/authServer";
import { audit, isFailure, notifyProject, requireProject } from "@/lib/guard";
import { accessHistory, grantRefusal, losesEditing, memberAccessView, parseAccessRequest } from "@/lib/projectAccess";

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

  const now = Date.now();
  const [{ data: members }, { data: invitations }, { data: grants }] = await Promise.all([
    db.rpc("rescript_project_members", {
      p_survey: params.id,
      p_present_within_seconds: ctx.user.policies.presence.presentWithinSeconds,
    }),
    /* the 0062 columns, read soft: a database without them answers as before */
    db.from("project_invitations")
      .select("id, email, user_code, role, created_at, expires_at, permissions, access_expires_at, resent_at, resend_count")
      .eq("survey_id", params.id).is("accepted_at", null).is("revoked_at", null)
      .order("created_at", { ascending: false })
      .then(async (r) => (r.error
        ? db.from("project_invitations")
            .select("id, email, user_code, role, created_at, expires_at")
            .eq("survey_id", params.id).is("accepted_at", null).is("revoked_at", null)
            .order("created_at", { ascending: false })
        : r)),
    /* each membership's permissions and expiry (migration 0062) — and who granted it */
    db.from("project_members").select("user_id, permissions, expires_at, added_by")
      .eq("survey_id", params.id).is("revoked_at", null)
      .then((r) => (r.error ? { data: [] as { user_id: string; permissions: unknown; expires_at: string | null; added_by: string | null }[] } : r)),
  ]);
  const grantOf = new Map(((grants ?? []) as { user_id: string; permissions: unknown; expires_at: string | null; added_by: string | null }[]).map((g) => [g.user_id, g]));
  const canManage = can(ctx.grant, "project.manage_members") || ctx.user.isPlatformAdmin;

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
    /* 0062: the researcher-facing name, the custom permissions, and the expiry — with its status */
    ...memberAccessView({ role: m.role, is_owner: m.is_owner, permissions: grantOf.get(m.user_id)?.permissions, expires_at: grantOf.get(m.user_id)?.expires_at }, now),
    isOwner: m.is_owner,
    accountStatus: m.status,
    addedAt: m.added_at,
    lastActivity: m.last_seen_at ?? m.last_login_at,
    currentlyActive: !!m.present,
    activity: m.activity,
    initials: initialsOf(m.full_name, m.user_code?.slice(-2) ?? "?"),
    hue: avatarHue(m.user_id),
    isMe: m.user_id === ctx.user.userId,
    /** the owner cannot be demoted or removed — ownership is transferred (§12); a project admin may change the others */
    changeable: !m.is_owner && m.user_id !== ctx.user.userId && canManage,
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
    invitations: ((invitations ?? []) as {
      id: string; email: string | null; user_code: string | null; role: string; created_at: string; expires_at: string;
      permissions?: unknown; access_expires_at?: string | null; resent_at?: string | null; resend_count?: number | null;
    }[]).map((i) => ({
      id: i.id, email: i.email, userCode: i.user_code,
      role: i.role, roleLabel: ROLE_LABEL[i.role as keyof typeof ROLE_LABEL] ?? i.role,
      accessLabel: accessLabel(i.role),
      invitedAt: i.created_at, expiresAt: i.expires_at,
      /* what the membership will be once accepted (0062) */
      permissions: i.role === "custom" ? i.permissions ?? null : null,
      accessExpiresAt: i.access_expires_at ?? null,
      resentAt: i.resent_at ?? null, resendCount: i.resend_count ?? 0,
      linkExpired: Date.parse(i.expires_at) <= now,
    })),
    myRole: ctx.role,
    /* the caller's own membership, so the panel can offer only what they may grant */
    myAccess: { role: ctx.role, permissions: ctx.grant && typeof ctx.grant === "object" ? ctx.grant.permissions ?? null : null, expiresAt: ctx.expiresAt },
    canManage,
    canShare: can(ctx.grant, "project.share") || ctx.user.isPlatformAdmin,
    isPlatformAdmin: ctx.user.isPlatformAdmin,
    grantableRoles: GRANTABLE_ROLES.map((r) => ({ value: r, label: ROLE_LABEL[r], accessLabel: accessLabel(r), description: ROLE_DESCRIPTION[r] })),
    /* the collaborators panel's history (?include=activity): grants, changes, removals, invitations, expiries */
    ...(new URL(req.url).searchParams.get("include") === "activity"
      ? { activity: await membershipHistory(params.id, rows.filter((r) => r.expired && r.expiresAt).map((r) => ({ userId: r.userId, name: r.name, expiresAt: r.expiresAt! })), now) }
      : {}),
  }, { headers: { "cache-control": "no-store" } });
}

/** the audit rows about who has access to this project, as sentences */
async function membershipHistory(surveyId: string, expired: { userId: string; name: string | null; expiresAt: string }[], now: number) {
  const db = supabaseService();
  const { data } = await db.from("audit_logs")
    .select("id, action, entity, entity_id, user_id, detail, created_at")
    .eq("survey_id", surveyId).like("action", "project.%")
    .order("created_at", { ascending: false }).limit(200);
  const rows = (data ?? []) as { id: number; action: string; entity: string | null; entity_id: string | null; user_id: string | null; detail: Record<string, unknown> | null; created_at: string }[];
  const ids = [...new Set(rows.map((r) => r.user_id).filter(Boolean))] as string[];
  const names = new Map<string, string>();
  if (ids.length) {
    const { data: people } = await db.from("profiles").select("id, full_name").in("id", ids);
    for (const p of people ?? []) names.set(p.id, p.full_name ?? "");
  }
  const audits: AuditRow[] = rows.map((r) => ({
    id: r.id, action: r.action, entity: r.entity, entityId: r.entity_id, surveyId, userId: r.user_id,
    actorName: r.user_id ? names.get(r.user_id) ?? null : null, detail: r.detail, createdAt: r.created_at,
  }));
  return accessHistory(audits, expired, now);
}

/**
 * Change a collaborator's access (§12): role, custom permissions, expiry —
 * any of them. `{ userId, role }` (all an older client sends) changes the
 * role exactly as before and leaves the expiry alone.
 */
export async function PATCH(req: NextRequest, { params }: { params: { id: string } }) {
  const ctx = await requireProject(req, params.id, "project.manage_members");
  if (isFailure(ctx)) return ctx.response;

  let body: any;
  try { body = await req.json(); } catch { return NextResponse.json({ error: "bad json" }, { status: 400 }); }
  const targetId = String(body?.userId ?? "");
  if (!targetId) return NextResponse.json({ error: "Which collaborator?" }, { status: 400 });
  if (targetId === ctx.survey.owner_id) {
    return NextResponse.json(
      { error: "The owner's role cannot be changed. Transfer ownership instead." },
      { status: 409 },
    );
  }
  if (targetId === ctx.user.userId && !ctx.user.isPlatformAdmin) {
    return NextResponse.json({ error: "You cannot change your own access. Ask the owner or another admin." }, { status: 409 });
  }

  const db = supabaseService();
  const { data: person } = await db.from("profiles").select("full_name, user_code").eq("id", targetId).maybeSingle();
  /* 0062 columns read soft, so this route still changes roles on a database without them */
  type Existing = { role: string; permissions?: unknown; expires_at?: string | null };
  const read = await db.from("project_members").select("role, permissions, expires_at")
    .eq("survey_id", params.id).eq("user_id", targetId).is("revoked_at", null).maybeSingle();
  const existing = (read.error
    ? (await db.from("project_members").select("role")
        .eq("survey_id", params.id).eq("user_id", targetId).is("revoked_at", null).maybeSingle()).data
    : read.data) as Existing | null;
  if (!existing) return NextResponse.json({ error: "That person is not a collaborator on this project." }, { status: 404 });

  const parsed = parseAccessRequest(body, Date.now(), existing.role as never);
  if (!parsed.ok) return NextResponse.json({ error: parsed.error }, { status: 400 });
  const { role } = parsed.value;
  const before: MemberGrant = { role: existing.role as never, permissions: existing.permissions ?? null, expiresAt: existing.expires_at ?? null };
  const after: MemberGrant = {
    role,
    /* switching to custom without sending permissions keeps the stored ones */
    permissions: role === "custom" ? ("permissions" in (body ?? {}) ? parsed.value.permissions : before.permissions ?? parsed.value.permissions) : null,
    expiresAt: parsed.value.expiresAt === undefined ? before.expiresAt ?? null : parsed.value.expiresAt,
  };

  /* nobody grants — or takes away — power over others that they do not hold themselves */
  const refused = grantRefusal(ctx.grant, ctx.user.isPlatformAdmin, after) ?? grantRefusal(ctx.grant, ctx.user.isPlatformAdmin, before);
  if (refused) return NextResponse.json({ error: refused, code: "insufficient_role" }, { status: 403 });

  const changes = diffAccess(before, after);
  if (!changes.length) return NextResponse.json({ ok: true, unchanged: true });

  const update: Record<string, unknown> = { role, revoked_at: null, revoked_by: null, updated_at: new Date().toISOString() };
  const touches0062 = role === "custom" || before.role === "custom" || (after.expiresAt ?? null) !== (before.expiresAt ?? null) || "permissions" in existing;
  if (touches0062) { update.permissions = after.permissions ?? null; update.expires_at = after.expiresAt ?? null; }
  const { error } = await db
    .from("project_members")
    .update(update)
    .eq("survey_id", params.id).eq("user_id", targetId);
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  /*
   * A change that takes away `survey.edit` while they hold the lock must take
   * the lock away too, or a user with no right to edit would keep editing
   * until their next save was refused — and the refusal would be confusing
   * rather than informative. Asked of the membership (custom permissions and
   * expiry included); for the fixed roles it is the old editor/programmer test.
   */
  let lockReleased = false;
  if (losesEditing(after)) {
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
    detail: {
      targetName: person?.full_name, targetUserCode: person?.user_code,
      /* the old sentence ("changed X's role to Y") when the role changed; the change list when only permissions or expiry did */
      ...(before.role !== role ? { role: ROLE_LABEL[role] } : {}),
      from: existing.role, changes, expiresAt: after.expiresAt ?? null, lockReleased,
    },
  });
  await notifyProject({
    surveyId: params.id, action: "project.permission_changed", onlyUserIds: [targetId],
    detail: { actorName: ctx.user.fullName, role: accessLabel(role), changes, project: `${ctx.survey.code} — ${ctx.survey.title}` },
  });

  return NextResponse.json({ ok: true, role, changes, expiresAt: after.expiresAt ?? null, lockReleased });
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

  /*
   * REMOVING ACCESS IS RECORDED, NOT ERASED.
   *
   * This used to DELETE the membership row, and deleting it did not remove
   * anybody: `rescript_project_access` falls through a missing member row to
   * the workspace baseline, and `rescript_workspace_default_role` answers
   * `editor` when nothing is configured (migration 0009; `DEFAULT_WORKSPACE_ACCESS`).
   * So removing a VIEWER in the same workspace promoted them to editor — the
   * API said `ok`, the panel dropped them, they were emailed "your access was
   * removed", and on their next request they could take the edit lock and
   * rewrite the questionnaire. Removing an unwanted editor was a no-op.
   *
   * The row now stays and is marked revoked (migration 0034), which is a
   * decision the access function can see: an explicit revocation outranks the
   * workspace baseline exactly as an explicit share does. Re-sharing the same
   * person clears the mark (see `share`).
   */
  const { data: member } = await db
    .from("project_members").select("user_id")
    .eq("survey_id", params.id).eq("user_id", targetId).maybeSingle();
  const { error } = member
    ? await db.from("project_members")
        .update({ revoked_at: new Date().toISOString(), revoked_by: ctx.user.userId, updated_at: new Date().toISOString() })
        .eq("survey_id", params.id).eq("user_id", targetId)
    : /* no row at all: they hold the workspace baseline, and removing them
         means writing the revocation the baseline has to yield to */
      await db.from("project_members")
        .insert({
          survey_id: params.id, user_id: targetId, role: "viewer", added_by: ctx.user.userId,
          revoked_at: new Date().toISOString(), revoked_by: ctx.user.userId,
        });
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  /* a pending invitation is a standing offer of access; leaving one open would
     let the person being removed walk back in by accepting it */
  {
    const { data: profile } = await db.from("profiles").select("email, user_code").eq("id", targetId).maybeSingle();
    const revoke = async (column: "email" | "user_code", value: string) => {
      await db.from("project_invitations")
        .update({ revoked_at: new Date().toISOString() })
        .eq("survey_id", params.id).is("accepted_at", null).is("revoked_at", null)
        .eq(column, value);
    };
    /* two statements rather than one `.or(...)`: an address is user input and
       PostgREST's or-syntax is comma-delimited */
    if (profile?.email) await revoke("email", profile.email);
    if (profile?.user_code) await revoke("user_code", profile.user_code);
  }

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

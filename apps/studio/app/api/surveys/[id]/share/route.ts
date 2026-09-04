import { NextRequest, NextResponse } from "next/server";
import { GRANTABLE_ROLES, isProjectRole, parseIdentifier, ROLE_LABEL } from "@rescript/access";
import { newInvitationToken, supabaseService } from "@/lib/authServer";
import { audit, isFailure, notifyProject, requireProject } from "@/lib/guard";

export const dynamic = "force-dynamic";

/**
 * SHARE A PROJECT (§10, §21, §22).
 *
 * One endpoint accepts either an email address or a User ID, because to the
 * person sharing they are the same act — "give Sarah access" — and making
 * them choose the right box first is a worse form. `parseIdentifier` decides
 * which was typed.
 *
 *   the person has an account   → a membership row, effective immediately
 *   they do not                 → an invitation, claimed when they sign up
 *
 * A User ID that does not exist is an error rather than an invitation: a code
 * is not a way to reach anybody, so there would be nowhere to send it. An
 * unknown EMAIL is invitable, which is the whole point of §22.
 */

/** Look someone up for the share dialog — "User Found: Sarah Lee, USR-10591". */
export async function GET(req: NextRequest, { params }: { params: { id: string } }) {
  const ctx = await requireProject(req, params.id, "project.share");
  if (isFailure(ctx)) return ctx.response;

  const raw = new URL(req.url).searchParams.get("q")?.trim() ?? "";
  if (!raw) return NextResponse.json({ error: "Enter an email address or User ID." }, { status: 400 });

  const identifier = parseIdentifier(raw);
  if (identifier.kind === "unknown") {
    return NextResponse.json({
      found: false,
      invitable: false,
      note: "Enter a full email address (name@company.com) or a User ID (USR-10482).",
    });
  }

  const db = supabaseService();
  const q = db.from("profiles").select("id, user_code, full_name, email, organization, status");
  const { data: person } = identifier.kind === "email"
    ? await q.eq("email", identifier.value.toLowerCase()).maybeSingle()
    : await q.eq("user_code", identifier.value).maybeSingle();

  if (!person) {
    return NextResponse.json({
      found: false,
      invitable: identifier.kind === "email",
      identifier: identifier.value,
      note: identifier.kind === "email"
        ? "No account uses that address yet. You can send a project invitation — they will get access as soon as they sign up."
        : "No account has that User ID. Check the code, or share by email address instead.",
    });
  }

  // already in? say so rather than letting the owner "share" a second time
  const [{ data: existing }, { data: theirWorkspace }] = await Promise.all([
    db.from("project_members").select("role").eq("survey_id", params.id).eq("user_id", person.id).maybeSingle(),
    db.from("profiles").select("customer_id").eq("id", person.id).maybeSingle(),
  ]);
  const isOwner = ctx.survey.owner_id === person.id;

  return NextResponse.json({
    found: true,
    user: {
      userId: person.id, userCode: person.user_code, name: person.full_name,
      email: person.email, organization: person.organization,
      disabled: person.status !== "active",
    },
    alreadyHasAccess: isOwner || !!existing,
    currentRole: isOwner ? "owner" : existing?.role ?? null,
    /**
     * Worth surfacing in the dialog: an explicit share is what authorizes
     * reaching across organizations (§24), so the person doing it should be
     * told that is what they are about to do rather than discovering it later.
     */
    differentOrganization: !!theirWorkspace?.customer_id && theirWorkspace.customer_id !== ctx.user.customerId,
  }, { headers: { "cache-control": "no-store" } });
}

export async function POST(req: NextRequest, { params }: { params: { id: string } }) {
  const ctx = await requireProject(req, params.id, "project.share");
  if (isFailure(ctx)) return ctx.response;
  const { user } = ctx;

  let body: any;
  try { body = await req.json(); } catch { return NextResponse.json({ error: "bad json" }, { status: 400 }); }

  const raw = String(body?.identifier ?? body?.email ?? body?.userCode ?? "").trim();
  const role = String(body?.role ?? "viewer");
  if (!raw) return NextResponse.json({ error: "Enter an email address or User ID." }, { status: 400 });
  if (!isProjectRole(role) || !GRANTABLE_ROLES.includes(role)) {
    // 'owner' lands here too: there is exactly one owner and it is transferred,
    // never granted (§12)
    return NextResponse.json(
      { error: `Choose one of: ${GRANTABLE_ROLES.map((r) => ROLE_LABEL[r]).join(", ")}.` },
      { status: 400 },
    );
  }

  const identifier = parseIdentifier(raw);
  if (identifier.kind === "unknown") {
    return NextResponse.json({ error: "That is not an email address or a User ID." }, { status: 400 });
  }

  const db = supabaseService();
  const sel = db.from("profiles").select("id, user_code, full_name, email, status");
  const { data: person } = identifier.kind === "email"
    ? await sel.eq("email", identifier.value).maybeSingle()
    : await sel.eq("user_code", identifier.value).maybeSingle();

  /* ---------------------------------------------------------- existing account */
  if (person) {
    if (person.id === ctx.survey.owner_id) {
      return NextResponse.json({ error: `${person.full_name} owns this project already.` }, { status: 409 });
    }
    if (person.status !== "active") {
      return NextResponse.json({ error: `${person.full_name}'s account is disabled.` }, { status: 409 });
    }
    const { error } = await db
      .from("project_members")
      .upsert(
        { survey_id: params.id, user_id: person.id, role, added_by: user.userId, updated_at: new Date().toISOString() },
        { onConflict: "survey_id,user_id" },
      );
    if (error) return NextResponse.json({ error: error.message }, { status: 500 });

    await audit({
      action: "project.shared", userId: user.userId, sessionId: user.sessionId,
      surveyId: params.id, customerId: user.customerId,
      detail: { targetName: person.full_name, targetUserCode: person.user_code, targetEmail: person.email, role: ROLE_LABEL[role] },
    });
    await notifyProject({
      surveyId: params.id, action: "project.shared", onlyUserIds: [person.id],
      detail: { actorName: user.fullName, role: ROLE_LABEL[role], project: `${ctx.survey.code} — ${ctx.survey.title}` },
    });

    return NextResponse.json({
      ok: true, kind: "granted",
      user: { userId: person.id, userCode: person.user_code, name: person.full_name, email: person.email },
      role,
      message: `${person.full_name} (${person.user_code}) now has ${ROLE_LABEL[role]} access.`,
    });
  }

  /* ---------------------------------------------------------- invitation */
  if (identifier.kind !== "email") {
    return NextResponse.json(
      { error: "No account has that User ID. Check the code, or invite them by email address instead." },
      { status: 404 },
    );
  }

  /*
   * The token is what links account creation to this grant (§22). It is
   * unguessable and single-use: `rescript_claim_invitations` marks it accepted,
   * so knowing an email address is not enough to inherit access and a leaked
   * link cannot be replayed.
   */
  const token = newInvitationToken();
  const { data: invitation, error } = await db
    .from("project_invitations")
    .upsert(
      { survey_id: params.id, email: identifier.value, role, token, invited_by: user.userId },
      { onConflict: "survey_id,email" },
    )
    .select("id, expires_at")
    .maybeSingle();
  if (error) {
    if (/duplicate|unique/i.test(error.message)) {
      return NextResponse.json({ error: "That address has already been invited to this project." }, { status: 409 });
    }
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  await audit({
    action: "project.invitation_sent", userId: user.userId, sessionId: user.sessionId,
    surveyId: params.id, customerId: user.customerId,
    detail: { targetEmail: identifier.value, role: ROLE_LABEL[role], invitationId: invitation?.id },
  });

  return NextResponse.json({
    ok: true, kind: "invited",
    email: identifier.value,
    role,
    expiresAt: invitation?.expires_at,
    /*
     * The link is returned rather than emailed. Sending it needs SMTP on the
     * Supabase project, and quietly doing nothing would be worse than handing
     * the owner a link they can pass on themselves — they know how they talk
     * to this person.
     */
    inviteUrl: `${process.env.STUDIO_PUBLIC_URL ?? ""}/signup?invite=${encodeURIComponent(token)}`,
    message: `${identifier.value} has been invited as ${ROLE_LABEL[role]}. They will get access as soon as they create an account.`,
  });
}

/** Pending invitations, and revoking one. */
export async function DELETE(req: NextRequest, { params }: { params: { id: string } }) {
  const ctx = await requireProject(req, params.id, "project.manage_members");
  if (isFailure(ctx)) return ctx.response;

  let body: any = {};
  try { body = await req.json(); } catch { /* optional */ }
  const invitationId = String(body?.invitationId ?? "");
  if (!invitationId) return NextResponse.json({ error: "Which invitation?" }, { status: 400 });

  const db = supabaseService();
  const { data: inv } = await db
    .from("project_invitations").select("id, email, survey_id, accepted_at")
    .eq("id", invitationId).maybeSingle();
  if (!inv || inv.survey_id !== params.id) return NextResponse.json({ error: "Unknown invitation." }, { status: 404 });
  if (inv.accepted_at) return NextResponse.json({ error: "That invitation was already accepted. Remove their access instead." }, { status: 409 });

  await db.from("project_invitations").update({ revoked_at: new Date().toISOString() }).eq("id", invitationId);
  await audit({
    action: "project.invitation_revoked", userId: ctx.user.userId, sessionId: ctx.user.sessionId,
    surveyId: params.id, customerId: ctx.user.customerId, detail: { targetEmail: inv.email },
  });
  return NextResponse.json({ ok: true });
}

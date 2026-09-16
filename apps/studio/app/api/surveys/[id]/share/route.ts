import { createHash } from "node:crypto";
import { NextRequest, NextResponse } from "next/server";
import { can, GRANTABLE_ROLES, isProjectRole, parseIdentifier, ROLE_LABEL } from "@rescript/access";
import { newInvitationToken, supabaseService } from "@/lib/authServer";
import { audit, isFailure, notifyProject, requireProject } from "@/lib/guard";
import { sendMail } from "@/lib/mail";
import { projectInvitationEmail } from "@rescript/mail";

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
    /*
     * SHARING ADDS SOMEBODY; IT DOES NOT RE-RANK SOMEBODY WHO IS ALREADY HERE.
     *
     * This route is gated on `project.share`, which an editor holds. The
     * upsert below is an INSERT-or-UPDATE, so re-POSTing an existing member
     * with a different role was a role change — and role changes require
     * `project.manage_members`, which only the owner holds (see `members`
     * PATCH). The owner demoting a contractor to viewer could be undone by any
     * editor re-sharing them as editor, audited only as `project.shared`.
     *
     * So: an existing member's role is changed only by somebody who could have
     * changed it through the collaborators panel. Re-sharing at the role they
     * already hold stays a no-op success, because that is not a change and
     * refusing it would make the share dialog fail for no reason.
     */
    const { data: existingRow } = await db
      .from("project_members").select("role, revoked_at")
      .eq("survey_id", params.id).eq("user_id", person.id).maybeSingle();
    /* a revoked row is history, not a collaborator: re-sharing that person is
       a grant, not a role change (see the `revoked_at` note in `members`) */
    const current = existingRow && !existingRow.revoked_at ? existingRow : null;
    if (current && current.role !== role && !can(ctx.role, "project.manage_members") && !ctx.user.isPlatformAdmin) {
      return NextResponse.json(
        {
          error: `${person.full_name} already has ${ROLE_LABEL[current.role as keyof typeof ROLE_LABEL] ?? current.role} access. Only the project's owner can change someone's role.`,
          code: "insufficient_role",
        },
        { status: 403 },
      );
    }

    const { error } = existingRow
      ? await db
          .from("project_members")
          .update({ role, revoked_at: null, revoked_by: null, updated_at: new Date().toISOString() })
          .eq("survey_id", params.id).eq("user_id", person.id)
      : await db
          .from("project_members")
          .insert({ survey_id: params.id, user_id: person.id, role, added_by: user.userId, updated_at: new Date().toISOString() });
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
   * THE TOKEN IS NOW THE CREDENTIAL, AND ONLY ITS HASH IS STORED (0017).
   *
   * The comment that used to be here said the token was "unguessable and
   * single-use, so knowing an email address is not enough to inherit access".
   * None of that was true. The token was generated, put in the link, stored in
   * plaintext — and read by nothing: `/signup` called
   * `Boolean(searchParams.get("invite"))` to change a line of copy and threw
   * the value away, and the grant was made by `rescript_claim_invitations`,
   * which matches on the account's EMAIL ADDRESS. Since nothing verifies an
   * address at signup, an invitation was claimable by whoever registered as
   * the invitee.
   *
   * So: the token goes in the link and NEVER into the database. The row keeps
   * a SHA-256 hash, hashed here exactly as a password reset is, and
   * `rescript_accept_invitation` claims the invitation the hash identifies —
   * single-use, in one statement, so a forwarded link is inert.
   *
   * The email path stays for sign-in, so an invitation sent before someone had
   * an account still takes effect when they arrive (§22). It is as strong as
   * an unverified address, which is to say not very; the strong path is the
   * link, and email verification is its own piece of work.
   */
  const token = newInvitationToken();
  const tokenHash = createHash("sha256").update(token).digest("hex");

  /*
   * SELECT, THEN UPDATE OR INSERT — NOT AN UPSERT.
   *
   * This was `.upsert(…, { onConflict: "survey_id,email" })`, and it could
   * never work: the only index on those columns is
   * `project_invitations_pending_key`, which is PARTIAL (`accepted_at is null
   * and revoked_at is null and email is not null`) and on an EXPRESSION
   * (`lower(email)`). Postgres cannot infer either for `ON CONFLICT
   * (survey_id, email)`, so every single invitation raised
   *
   *   there is no unique or exclusion constraint matching the ON CONFLICT
   *   specification
   *
   * — and because that sentence contains the word "unique", the error mapping
   * below turned a hard schema failure into a 409 reading "That address has
   * already been invited to this project." No row was written, no token was
   * minted, no mail was sent, and the owner was told the opposite of what had
   * happened.
   *
   * A plain unique constraint cannot be added instead: accepted and revoked
   * rows are kept as history, so (survey_id, email) is legitimately repeated.
   * The partial index stays, and the "one live invitation per project per
   * email" rule is now applied here, where it can also be *reported*: the 409
   * below is raised from a checked precondition, never inferred from the text
   * of a database error.
   */
  /* the index matches on `lower(email)`, so the lookup has to as well — and in
     JS rather than through `ilike`, whose `%` and `_` are wildcards and `_` is
     an ordinary character in an address */
  const wanted = identifier.value.toLowerCase();
  const { data: live } = await db
    .from("project_invitations")
    .select("id, email, expires_at")
    .eq("survey_id", params.id)
    .is("accepted_at", null)
    .is("revoked_at", null);
  const pending = (live ?? []).find((i) => (i.email ?? "").toLowerCase() === wanted) ?? null;

  const row = {
    survey_id: params.id, email: identifier.value, role,
    token_hash: tokenHash,
    /*
     * Explicitly null, not merely omitted: re-inviting somebody reuses an
     * existing row, which may be a pre-0017 row still carrying a plaintext
     * token. Leaving it would keep that credential alive.
     */
    token: null,
    invited_by: user.userId,
  };

  let invitation: { id: string; expires_at: string | null } | null = null;
  let error: { message: string; code?: string } | null = null;
  if (pending) {
    /* re-inviting: the same row is refreshed — a new token, the new role — so
       one (project, email) still means one invitation and one email; see
       `dedupeKey` below. `expires_at` is left alone, exactly as the upsert
       left it, so re-sending a link cannot extend its life indefinitely. */
    ({ data: invitation, error } = await db
      .from("project_invitations")
      .update(row)
      .eq("id", pending.id)
      .select("id, expires_at")
      .maybeSingle());
  } else {
    ({ data: invitation, error } = await db
      .from("project_invitations")
      .insert(row)
      .select("id, expires_at")
      .maybeSingle());
  }
  if (error) {
    /*
     * The partial index is still the authority under concurrency: two owners
     * inviting the same address at the same moment both read "no pending row"
     * and one of the inserts loses. That — and only that — is a real 409.
     */
    if (error.code === "23505") {
      return NextResponse.json({ error: "That address has already been invited to this project." }, { status: 409 });
    }
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  await audit({
    action: "project.invitation_sent", userId: user.userId, sessionId: user.sessionId,
    surveyId: params.id, customerId: user.customerId,
    detail: { targetEmail: identifier.value, role: ROLE_LABEL[role], invitationId: invitation?.id },
  });

  const base = (process.env.STUDIO_PUBLIC_URL ?? "").trim().replace(/\/+$/, "");
  const inviteUrl = `${base}/signup?invite=${encodeURIComponent(token)}`;

  /*
   * SEND IT — and still return the link.
   *
   * The link used to be returned INSTEAD of being emailed, because there was
   * no mail transport and quietly doing nothing would have been worse than
   * handing the inviter something they could pass on themselves. Now the
   * platform sends it, and the link is returned as well rather than instead:
   * an inviter who can see the URL can chase it up over Slack when the email
   * has not arrived, and mail that reaches nobody is the normal state of a
   * newly configured sending domain. The response says which happened.
   */
  const project = await db.from("surveys").select("title, code").eq("id", params.id).maybeSingle();
  let delivery: "sent" | "not_configured" | "suppressed" | "failed" = "not_configured";
  if (base) {
    const mail = projectInvitationEmail({
      inviterName: user.fullName || user.userCode || "A colleague",
      projectTitle: project.data?.title ?? "a survey project",
      projectCode: project.data?.code ?? "",
      roleLabel: ROLE_LABEL[role],
      url: inviteUrl,
      expiresAt: invitation?.expires_at ?? null,
      /* an existing account is being granted access; a new one has to sign up first */
      hasAccount: false,
    });
    const out = await sendMail({
      to: identifier.value,
      subject: mail.subject,
      text: mail.text,
      html: mail.html,
      kind: "project_invitation",
      surveyId: params.id,
      customerId: user.customerId,
      userId: user.userId,
      /*
       * Keyed on the invitation row, so re-inviting the same person to the
       * same project does not mail them again — the upsert above deliberately
       * reuses one row per (project, email).
       */
      dedupeKey: invitation?.id ? `project_invitation:${invitation.id}` : undefined,
      replyTo: user.email || undefined,
    });
    delivery = out.sent ? "sent" : out.reason === "not_configured" ? "not_configured" : out.reason === "suppressed" ? "suppressed" : "failed";
  } else {
    console.warn("[rescript:share] STUDIO_PUBLIC_URL is not set, so the invitation could not be emailed");
  }

  return NextResponse.json({
    ok: true, kind: "invited",
    email: identifier.value,
    role,
    expiresAt: invitation?.expires_at,
    inviteUrl,
    delivery,
    message:
      delivery === "sent"
        ? `${identifier.value} has been invited as ${ROLE_LABEL[role]}, and the invitation has been emailed to them.`
        : `${identifier.value} has been invited as ${ROLE_LABEL[role]}. ${
            delivery === "not_configured"
              ? "No mail is configured on this instance, so send them the link yourself."
              : delivery === "suppressed"
                ? "This is not the production platform, so no email was sent — send them the link yourself."
                : "The email could not be sent, so send them the link yourself."
          }`,
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

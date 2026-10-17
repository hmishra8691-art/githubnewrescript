import { createHash } from "node:crypto";
import { NextRequest, NextResponse } from "next/server";
import { accessLabel, can, diffAccess, parseIdentifier, type MemberGrant } from "@rescript/access";
import { newInvitationToken, supabaseService } from "@/lib/authServer";
import { audit, isFailure, notifyProject, requireProject } from "@/lib/guard";
import { grantRefusal, parseAccessRequest } from "@/lib/projectAccess";
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
    /* a revoked row is history, not access — the panel must not say "already has access" for it */
    db.from("project_members").select("role").eq("survey_id", params.id).eq("user_id", person.id).is("revoked_at", null).maybeSingle(),
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
    currentAccessLabel: isOwner ? "Owner" : existing?.role ? accessLabel(existing.role) : null,
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
  if (!raw) return NextResponse.json({ error: "Enter an email address or User ID." }, { status: 400 });
  /*
   * Role, custom permissions and expiry (0062). `{ identifier, role }` — what
   * an older client sends — reads as that role, no permissions, and expiry
   * not mentioned. 'owner' is refused here: there is exactly one owner and
   * it is transferred, never granted (§12).
   */
  const parsed = parseAccessRequest({ ...body, role: body?.role ?? "viewer" });
  if (!parsed.ok) return NextResponse.json({ error: parsed.error }, { status: 400 });
  const { role, permissions } = parsed.value;
  const grantWanted: MemberGrant = { role, permissions, expiresAt: parsed.value.expiresAt ?? null };
  const roleName = accessLabel(role);

  /* nobody grants what they do not hold: an editor may invite up to an editor, never a project admin */
  const refused = grantRefusal(ctx.grant, ctx.user.isPlatformAdmin, grantWanted);
  if (refused) return NextResponse.json({ error: refused, code: "insufficient_role" }, { status: 403 });

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
    /* the 0062 columns read soft: a database without them answers as before */
    type Existing = { role: string; revoked_at: string | null; permissions?: unknown; expires_at?: string | null };
    const read = await db.from("project_members").select("role, revoked_at, permissions, expires_at")
      .eq("survey_id", params.id).eq("user_id", person.id).maybeSingle();
    const existingRow = (read.error
      ? (await db.from("project_members").select("role, revoked_at").eq("survey_id", params.id).eq("user_id", person.id).maybeSingle()).data
      : read.data) as Existing | null;
    /* a revoked row is history, not a collaborator: re-sharing that person is
       a grant, not a role change (see the `revoked_at` note in `members`);
       an EXPIRED row is the same — their access had ended */
    const lapsed = !!existingRow?.expires_at && Date.parse(existingRow.expires_at) <= Date.now();
    const current = existingRow && !existingRow.revoked_at && !lapsed ? existingRow : null;
    /* an older client does not mention expiry: for a live member, leave theirs alone */
    const effective: MemberGrant = {
      ...grantWanted,
      expiresAt: parsed.value.expiresAt === undefined && current ? current.expires_at ?? null : grantWanted.expiresAt,
    };
    const changes = current ? diffAccess({ role: current.role as never, permissions: current.permissions ?? null, expiresAt: current.expires_at ?? null }, effective) : [];
    if (current && changes.length && !can(ctx.grant, "project.manage_members") && !ctx.user.isPlatformAdmin) {
      return NextResponse.json(
        {
          error: `${person.full_name} already has ${accessLabel(current.role)} access. Only the project's owner or an admin can change someone's access.`,
          code: "insufficient_role",
        },
        { status: 403 },
      );
    }

    /*
     * The 0062 columns are written only when they mean something — a custom
     * role, an expiry, or a row that already carries either (re-granting a
     * revoked or expired row must clear its old end date). So `{ identifier,
     * role }` still works on a database that has not had 0062 applied.
     */
    const carries0062 = role === "custom" || !!effective.expiresAt || !!existingRow?.expires_at || existingRow?.permissions != null;
    const extra = carries0062 ? { permissions: effective.permissions ?? null, expires_at: effective.expiresAt ?? null } : {};
    const { error } = existingRow
      ? await db
          .from("project_members")
          .update({ role, revoked_at: null, revoked_by: null, updated_at: new Date().toISOString(), ...extra })
          .eq("survey_id", params.id).eq("user_id", person.id)
      : await db
          .from("project_members")
          .insert({ survey_id: params.id, user_id: person.id, role, added_by: user.userId, updated_at: new Date().toISOString(), ...extra });
    if (error) return NextResponse.json({ error: error.message }, { status: 500 });

    await audit({
      action: current && changes.length ? "project.permission_changed" : "project.shared", userId: user.userId, sessionId: user.sessionId,
      surveyId: params.id, customerId: user.customerId,
      detail: {
        targetName: person.full_name, targetUserCode: person.user_code, targetEmail: person.email, role: roleName,
        expiresAt: effective.expiresAt ?? null, ...(current ? { from: current.role, changes } : {}),
      },
    });
    await notifyProject({
      surveyId: params.id, action: current && changes.length ? "project.permission_changed" : "project.shared", onlyUserIds: [person.id],
      detail: { actorName: user.fullName, role: roleName, expiresAt: effective.expiresAt ?? null, project: `${ctx.survey.code} — ${ctx.survey.title}` },
    });

    return NextResponse.json({
      ok: true, kind: "granted",
      user: { userId: person.id, userCode: person.user_code, name: person.full_name, email: person.email },
      role,
      expiresAt: effective.expiresAt ?? null,
      message: `${person.full_name} (${person.user_code}) now has ${roleName} access${effective.expiresAt ? ` until ${effective.expiresAt.slice(0, 10)}` : ""}.`,
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
  type Live = { id: string; email: string | null; expires_at: string; permissions?: unknown; access_expires_at?: string | null };
  const liveRead = await db
    .from("project_invitations")
    .select("id, email, expires_at, permissions, access_expires_at")
    .eq("survey_id", params.id)
    .is("accepted_at", null)
    .is("revoked_at", null);
  /* the 0062 columns read soft: a database without them answers as before */
  const live = (liveRead.error
    ? (await db.from("project_invitations").select("id, email, expires_at")
        .eq("survey_id", params.id).is("accepted_at", null).is("revoked_at", null)).data
    : liveRead.data) as Live[] | null;
  const pending = (live ?? []).find((i) => (i.email ?? "").toLowerCase() === wanted) ?? null;

  const row = {
    survey_id: params.id, email: identifier.value, role,
    /*
     * What the membership will be once accepted (0062). Written when it says
     * something — or when a re-invited row carries an older grant that must
     * not survive into this one.
     */
    ...(role === "custom" || grantWanted.expiresAt || pending?.permissions != null || pending?.access_expires_at
      ? { permissions: grantWanted.permissions ?? null, access_expires_at: grantWanted.expiresAt ?? null } : {}),
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
    detail: { targetEmail: identifier.value, role: roleName, invitationId: invitation?.id, expiresAt: grantWanted.expiresAt ?? null },
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
      roleLabel: roleName,
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
        ? `${identifier.value} has been invited as ${roleName}, and the invitation has been emailed to them.`
        : `${identifier.value} has been invited as ${roleName}. ${
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

/**
 * RESEND a pending invitation (0062): a FRESH link — the old one stops
 * working, because only the newest token's hash is kept — mailed again.
 * `project.share`, like inviting: whoever could have sent it can send it
 * again. The link's own 14-day life is not extended, for the reason the
 * re-invite path gives: re-sending must not keep a link alive for ever.
 */
export async function PATCH(req: NextRequest, { params }: { params: { id: string } }) {
  const ctx = await requireProject(req, params.id, "project.share");
  if (isFailure(ctx)) return ctx.response;
  const { user } = ctx;

  let body: any = {};
  try { body = await req.json(); } catch { /* checked below */ }
  const invitationId = String(body?.invitationId ?? "");
  if (body?.action !== "resend" || !invitationId) return NextResponse.json({ error: "Which invitation, and what to do with it?" }, { status: 400 });

  const db = supabaseService();
  const { data: inv } = await db
    .from("project_invitations").select("id, email, role, survey_id, accepted_at, revoked_at, expires_at, resend_count")
    .eq("id", invitationId).maybeSingle();
  if (!inv || inv.survey_id !== params.id) return NextResponse.json({ error: "Unknown invitation." }, { status: 404 });
  if (inv.accepted_at) return NextResponse.json({ error: "That invitation was already accepted." }, { status: 409 });
  if (inv.revoked_at) return NextResponse.json({ error: "That invitation was cancelled. Invite them again instead." }, { status: 409 });
  if (Date.parse(inv.expires_at) <= Date.now()) {
    return NextResponse.json({ error: "That invitation link has expired. Cancel it and invite them again." }, { status: 409 });
  }
  if (!inv.email) return NextResponse.json({ error: "That invitation has no email address to send to." }, { status: 409 });

  const token = newInvitationToken();
  const tokenHash = createHash("sha256").update(token).digest("hex");
  const count = Number(inv.resend_count ?? 0) + 1;
  const { error } = await db.from("project_invitations")
    .update({ token_hash: tokenHash, token: null, resent_at: new Date().toISOString(), resend_count: count })
    .eq("id", inv.id).is("accepted_at", null).is("revoked_at", null);
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  await audit({
    action: "project.invitation_resent", userId: user.userId, sessionId: user.sessionId,
    surveyId: params.id, customerId: user.customerId, detail: { targetEmail: inv.email, invitationId: inv.id, count },
  });

  const base = (process.env.STUDIO_PUBLIC_URL ?? "").trim().replace(/\/+$/, "");
  const inviteUrl = `${base}/signup?invite=${encodeURIComponent(token)}`;
  let delivery: "sent" | "not_configured" | "suppressed" | "failed" = "not_configured";
  if (base) {
    const mail = projectInvitationEmail({
      inviterName: user.fullName || user.userCode || "A colleague",
      projectTitle: ctx.survey.title, projectCode: ctx.survey.code,
      roleLabel: accessLabel(inv.role), url: inviteUrl, expiresAt: inv.expires_at, hasAccount: false,
    });
    const out = await sendMail({
      to: inv.email, subject: mail.subject, text: mail.text, html: mail.html,
      kind: "project_invitation", surveyId: params.id, customerId: user.customerId, userId: user.userId,
      /* a resend is a new message on purpose: keyed on the count, not only the row */
      dedupeKey: `project_invitation:${inv.id}:resend:${count}`,
      replyTo: user.email || undefined,
    });
    delivery = out.sent ? "sent" : out.reason === "not_configured" ? "not_configured" : out.reason === "suppressed" ? "suppressed" : "failed";
  }
  return NextResponse.json({
    ok: true, inviteUrl, delivery, resendCount: count,
    message: delivery === "sent"
      ? `The invitation was sent again to ${inv.email}. The previous link no longer works.`
      : `A new link was made for ${inv.email} (the previous one no longer works). No email was sent — send them the link yourself.`,
  });
}

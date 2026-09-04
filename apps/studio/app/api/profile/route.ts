import { NextRequest, NextResponse } from "next/server";
import { setPassword, supabaseService, verifyPassword } from "@/lib/authServer";
import { audit, isFailure, requireUser } from "@/lib/guard";

export const dynamic = "force-dynamic";

/**
 * THE PROFILE (§2).
 *
 * What may be changed, and what may not: name, organization and job title are
 * the user's own. The User ID, the email address and the platform role are
 * system identity — the requirement is explicit that a user must not edit the
 * generated User ID, and the same reasoning covers the other two: the code is
 * how colleagues address you, the email is what authenticates you, and the
 * role is an administrator's decision.
 *
 * Anything unrecognised in the body is ignored rather than merged, so a
 * crafted request cannot promote its sender by adding `"role":
 * "platform_admin"`.
 */
export async function GET(req: NextRequest) {
  const user = await requireUser(req);
  if (isFailure(user)) return user.response;

  const db = supabaseService();
  const { data: profile } = await db
    .from("profiles")
    .select("id, user_code, email, full_name, organization, job_title, role, status, created_at, last_login_at, customer_id")
    .eq("id", user.userId).maybeSingle();
  const { data: workspace } = profile?.customer_id
    ? await db.from("customers").select("name, slug").eq("id", profile.customer_id).maybeSingle()
    : { data: null };

  const [{ count: owned }, { count: shared }] = await Promise.all([
    db.from("surveys").select("id", { count: "exact", head: true }).eq("owner_id", user.userId),
    db.from("project_members").select("survey_id", { count: "exact", head: true }).eq("user_id", user.userId),
  ]);

  return NextResponse.json({
    name: profile?.full_name ?? "",
    /*
     * The user CODE, under a key that says so. This used to be called
     * `userId`, which collided with the internal row id of the same name in
     * the session payload — two different values behind one key is how a
     * screen ends up showing a UUID where a colleague expects USR-10482.
     */
    userCode: profile?.user_code ?? "",
    email: profile?.email ?? "",
    organization: profile?.organization ?? workspace?.name ?? null,
    jobTitle: profile?.job_title ?? null,
    workspace: workspace?.name ?? null,
    accountStatus: profile?.status ?? "active",
    platformRole: profile?.role ?? "programmer",
    createdDate: profile?.created_at ?? null,
    lastLogin: profile?.last_login_at ?? null,
    currentSession: { sessionId: user.sessionId, status: "active" },
    projectsOwned: owned ?? 0,
    projectsShared: shared ?? 0,
    /** what this screen is allowed to change — the UI renders the rest read-only */
    editable: ["name", "organization", "jobTitle"],
  }, { headers: { "cache-control": "no-store" } });
}

export async function PATCH(req: NextRequest) {
  const user = await requireUser(req);
  if (isFailure(user)) return user.response;

  let body: any;
  try { body = await req.json(); } catch { return NextResponse.json({ error: "bad json" }, { status: 400 }); }

  // an allow-list, not a merge: the only way a field can be written is by
  // being named here
  const update: Record<string, unknown> = { updated_at: new Date().toISOString() };
  if (typeof body?.name === "string") {
    const v = body.name.trim();
    if (v.length < 2) return NextResponse.json({ error: "Enter your name.", problems: { name: "Enter your name." } }, { status: 400 });
    if (v.length > 120) return NextResponse.json({ error: "That name is too long.", problems: { name: "Use 120 characters or fewer." } }, { status: 400 });
    update.full_name = v;
  }
  // told, not silently truncated: a value that came back shorter than what was
  // typed, with no explanation, reads as the save having gone wrong
  const problems: Record<string, string> = {};
  if (typeof body?.organization === "string") {
    const v = body.organization.trim();
    if (v.length > 160) problems.organization = "Use 160 characters or fewer.";
    else update.organization = v || null;
  }
  if (typeof body?.jobTitle === "string") {
    const v = body.jobTitle.trim();
    if (v.length > 120) problems.jobTitle = "Use 120 characters or fewer.";
    else update.job_title = v || null;
  }

  if (Object.keys(problems).length) {
    return NextResponse.json({ error: "Please correct the highlighted fields.", problems }, { status: 400 });
  }

  const rejected = ["userId", "userCode", "user_code", "email", "role", "status", "customer_id", "id"]
    .filter((k) => k in (body ?? {}));

  const db = supabaseService();
  const { error } = await db.from("profiles").update(update).eq("id", user.userId);
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  await audit({ action: "user.profile_updated", userId: user.userId, sessionId: user.sessionId, customerId: user.customerId, detail: { fields: Object.keys(update).filter((k) => k !== "updated_at") } });
  return NextResponse.json({
    ok: true,
    // said plainly rather than silently ignored, so a caller learns why
    ignored: rejected.length
      ? { fields: rejected, reason: "These are system identifiers and can only be changed by an administrator." }
      : undefined,
  });
}

/** Change my password. The current one is required — a hijacked session must not be able to lock the owner out. */
export async function PUT(req: NextRequest) {
  const user = await requireUser(req);
  if (isFailure(user)) return user.response;

  let body: any;
  try { body = await req.json(); } catch { return NextResponse.json({ error: "bad json" }, { status: 400 }); }
  const current = String(body?.currentPassword ?? "");
  const next = String(body?.newPassword ?? "");
  const confirm = String(body?.confirmPassword ?? "");

  if (next.length < 10) return NextResponse.json({ error: "Use at least 10 characters.", problems: { newPassword: "Use at least 10 characters." } }, { status: 400 });
  if (next !== confirm) return NextResponse.json({ error: "The two passwords do not match.", problems: { confirmPassword: "The two passwords do not match." } }, { status: 400 });

  const verified = await verifyPassword(user.email, current);
  if (!verified) {
    return NextResponse.json({ error: "Your current password is not correct.", problems: { currentPassword: "Not correct." } }, { status: 401 });
  }

  const { error } = await setPassword(user.userId, next);
  if (error) return NextResponse.json({ error }, { status: 400 });

  await audit({ action: "user.password_changed", userId: user.userId, sessionId: user.sessionId, customerId: user.customerId });
  return NextResponse.json({ ok: true });
}

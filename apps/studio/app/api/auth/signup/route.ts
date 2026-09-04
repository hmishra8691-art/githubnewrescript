import { NextRequest, NextResponse } from "next/server";
import { createAccount, deviceOf, ipHashOf, loadPolicies, setSessionCookie, supabaseService } from "@/lib/authServer";
import { audit } from "@/lib/guard";

export const dynamic = "force-dynamic";

/**
 * CREATE AN ACCOUNT (§1).
 *
 * The account, its profile, its unique User ID and its workspace are created
 * in ONE transaction — the profile comes from a database trigger on
 * `auth.users`, not from a second call here. If this route crashed between
 * the two, an account could otherwise exist that can authenticate but has no
 * identity, no code and no organization, and every later request would have to
 * invent one.
 *
 * The generated User ID is returned so the signup screen can show it
 * immediately: it is the identifier a colleague will use to share a project
 * with this person, and it is the one thing on the form they did not choose.
 *
 * Signing up also signs you in, which means it goes through the same
 * single-session machinery as any other login.
 */
export async function POST(req: NextRequest) {
  let body: any;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "bad json" }, { status: 400 });
  }

  const name = String(body?.name ?? "").trim();
  const email = String(body?.email ?? "").trim().toLowerCase();
  const password = String(body?.password ?? "");
  const confirm = String(body?.confirmPassword ?? body?.confirm ?? "");
  const organization = String(body?.organization ?? "").trim() || null;
  const jobTitle = String(body?.jobTitle ?? "").trim() || null;

  /* ---------------------------------------------------------- validation */
  const problems: Record<string, string> = {};
  if (name.length < 2) problems.name = "Enter your name.";
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) problems.email = "Enter a valid email address.";
  // length is the property that actually matters; a composition rule mostly
  // teaches people to write Password1! and reuse it everywhere
  if (password.length < 10) problems.password = "Use at least 10 characters.";
  else if (/^(.)\1+$/.test(password)) problems.password = "Choose a less predictable password.";
  else if (password.toLowerCase().includes(email.split("@")[0].toLowerCase()) && email.split("@")[0].length >= 4) {
    problems.password = "Your password should not contain your email name.";
  }
  if (password !== confirm) problems.confirmPassword = "The two passwords do not match.";
  if (Object.keys(problems).length) {
    return NextResponse.json({ error: "Please correct the highlighted fields.", problems }, { status: 400 });
  }

  /* ---------------------------------------------------------- create */
  const created = await createAccount({ email, password, fullName: name, organization, jobTitle });
  if ("error" in created) {
    return NextResponse.json(
      { error: created.error, problems: created.status === 409 ? { email: created.error } : undefined },
      { status: created.status },
    );
  }

  const db = supabaseService();
  const { data: profile } = await db
    .from("profiles")
    .select("id, email, full_name, user_code, customer_id, role, organization, created_at")
    .eq("id", created.userId)
    .maybeSingle();

  if (!profile?.user_code) {
    // the trigger is the only thing that mints a code; if it did not run, the
    // account is unusable and saying so is better than a half-made identity
    console.error("[rescript:auth] profile or user code missing after signup", { userId: created.userId });
    return NextResponse.json(
      { error: "The account was created but its profile could not be prepared. Please contact support." },
      { status: 500 },
    );
  }

  /* ---------------------------------------------------------- sign in */
  const policies = await loadPolicies(profile.customer_id ?? null);
  const { data: loginRows } = await db.rpc("rescript_login", {
    p_user: created.userId,
    p_stale_seconds: policies.session.staleAfterSeconds,
    p_absolute_seconds: policies.session.absoluteLifetimeSeconds,
    p_lifetime_seconds: policies.session.absoluteLifetimeSeconds,
    p_force: false,
    p_user_agent: req.headers.get("user-agent")?.slice(0, 500) ?? null,
    p_ip_hash: ipHashOf(req),
    p_device_label: deviceOf(req),
  });
  const result = (Array.isArray(loginRows) ? loginRows[0] : loginRows) as { outcome: string; session_id: string | null };

  // any project invitation already waiting for this address becomes real (§22)
  const { data: claimed } = await db.rpc("rescript_claim_invitations", { p_user: created.userId });

  await audit({
    action: "user.logged_in", userId: created.userId, sessionId: result?.session_id,
    customerId: profile.customer_id, ipHash: ipHashOf(req),
    detail: { device: deviceOf(req), viaSignup: true },
  });

  const res = NextResponse.json({
    ok: true,
    user: {
      userId: profile.id,
      userCode: profile.user_code,
      name: profile.full_name,
      email: profile.email,
      organization: profile.organization,
      isPlatformAdmin: profile.role === "platform_admin",
      createdAt: profile.created_at,
    },
    invitationsClaimed: Number(claimed ?? 0),
    signedIn: result?.outcome === "created",
  });
  if (result?.session_id) setSessionCookie(res, result.session_id, policies.session.absoluteLifetimeSeconds);
  return res;
}

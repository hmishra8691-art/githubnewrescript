import { NextRequest, NextResponse } from "next/server";
import {
  decideLogin, decideThrottle, parseIdentifier, sessionStatus,
  type SessionRecord,
} from "@rescript/access";
import {
  deviceOf, findAccount, ipHashOf, loadPolicies, recordAttempt,
  setSessionCookie, supabaseService, verifyPassword,
} from "@/lib/authServer";
import { audit } from "@/lib/guard";

export const dynamic = "force-dynamic";

/**
 * SIGN IN — and the single-active-session rule (§4).
 *
 * The order of the checks is the security design, not an implementation
 * detail:
 *
 *   1. THROTTLE first, before the password is even looked at. Checking the
 *      password of a locked-out account would let an attacker use response
 *      timing to tell a real account from a fake one.
 *   2. PASSWORD next, via Supabase Auth. A failure is recorded and answered
 *      with the same message whether the account exists or not.
 *   3. ACCOUNT STATUS — disabled accounts stop here.
 *   4. SESSION last, and atomically: `rescript_login` expires whatever the
 *      clock has ended, then inserts against a unique partial index. Two
 *      simultaneous logins cannot both succeed, and the loser is told which
 *      device holds the account and when it will be released.
 *
 * The requirement is explicit that the first session must NOT be silently
 * invalidated. It is not: a takeover happens only when `allowForceTakeover`
 * has been switched on for the workspace, and then it is audited as a
 * takeover rather than as an ordinary sign-in.
 */
export async function POST(req: NextRequest) {
  let body: any;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "bad json" }, { status: 400 });
  }

  const rawIdentifier = String(body?.identifier ?? body?.email ?? "").trim();
  const password = String(body?.password ?? "");
  if (!rawIdentifier || !password) {
    return NextResponse.json({ error: "Enter your User ID or email address and your password." }, { status: 400 });
  }

  const identifier = parseIdentifier(rawIdentifier);
  const ipHash = ipHashOf(req);
  const device = deviceOf(req);

  // policies are per workspace, but the account is not known yet — the
  // platform default governs the throttle for an unidentified attempt
  const account = identifier.kind === "unknown" ? null : await findAccount(identifier);
  const policies = await loadPolicies(account?.customer_id ?? null);

  /* ---------------------------------------------------------- 1. throttle */
  const db = supabaseService();
  const { data: failures } = await db.rpc("rescript_login_failures", {
    p_identifier: rawIdentifier,
    p_ip_hash: ipHash,
    p_window_seconds: policies.throttle.windowSeconds,
  });
  const counts = Array.isArray(failures) ? failures[0] : failures;
  const throttled = decideThrottle(
    {
      accountFailures: Number(counts?.account_failures ?? 0),
      sourceFailures: Number(counts?.source_failures ?? 0),
      lockedUntil: account?.locked_until ?? null,
    },
    policies.throttle,
  );
  if (throttled.kind === "locked") {
    await recordAttempt({ identifier: rawIdentifier, userId: account?.id, ipHash, success: false, reason: "throttled" });
    return NextResponse.json(
      { error: throttled.message, code: "throttled" },
      { status: 429, headers: { "retry-after": String(throttled.retryAfterSeconds) } },
    );
  }

  /* ---------------------------------------------------------- 2. password */
  // "no such account" and "wrong password" answer identically: the difference
  // is an account-enumeration oracle
  const GENERIC = "That User ID or email address and password do not match.";
  if (!account) {
    await recordAttempt({ identifier: rawIdentifier, ipHash, success: false, reason: "unknown_account" });
    await audit({ action: "user.login_failed", userId: null, ipHash, detail: { identifier: rawIdentifier, reason: "unknown_account" } });
    return NextResponse.json({ error: GENERIC }, { status: 401 });
  }

  const verified = await verifyPassword(account.email, password);
  if (!verified) {
    await recordAttempt({ identifier: rawIdentifier, userId: account.id, ipHash, success: false, reason: "bad_password" });
    await audit({ action: "user.login_failed", userId: null, ipHash, customerId: account.customer_id, detail: { identifier: rawIdentifier, reason: "bad_password" } });
    return NextResponse.json({ error: GENERIC }, { status: 401 });
  }

  /* ---------------------------------------------------------- 3. account status */
  if (account.status !== "active") {
    await recordAttempt({ identifier: rawIdentifier, userId: account.id, ipHash, success: false, reason: "disabled" });
    return NextResponse.json(
      { error: "This account has been disabled. Please contact your administrator.", code: "account_disabled" },
      { status: 403 },
    );
  }

  /* ---------------------------------------------------------- 4. the session */
  const { data: loginRows, error: loginErr } = await db.rpc("rescript_login", {
    p_user: account.id,
    p_stale_seconds: policies.session.staleAfterSeconds,
    p_absolute_seconds: policies.session.absoluteLifetimeSeconds,
    p_lifetime_seconds: policies.session.absoluteLifetimeSeconds,
    p_force: policies.session.allowForceTakeover,
    p_user_agent: req.headers.get("user-agent")?.slice(0, 500) ?? null,
    p_ip_hash: ipHash,
    p_device_label: device,
  });
  if (loginErr) {
    console.error("[rescript:auth] session could not be created", { error: loginErr.message });
    return NextResponse.json({ error: "Sign-in failed. Please try again." }, { status: 503 });
  }
  const result = (Array.isArray(loginRows) ? loginRows[0] : loginRows) as {
    outcome: string; session_id: string | null;
    blocking_session_id: string | null; blocking_last_seen: string | null;
    blocking_created_at: string | null; blocking_device: string | null;
  };

  if (result.outcome === "blocked") {
    /*
     * The heart of §4. The existing session is described so the message can be
     * specific and the user is not left guessing: which device, since when,
     * last active when, and how long until it releases itself if that machine
     * is gone. The password WAS correct, so this is recorded as a successful
     * credential check that was refused a session — not as a failed attempt,
     * which would otherwise count towards a lockout of the user's own account.
     */
    const existing: SessionRecord = {
      sessionId: result.blocking_session_id!,
      userId: account.id,
      status: "active",
      createdAt: result.blocking_created_at ?? new Date().toISOString(),
      lastSeenAt: result.blocking_last_seen ?? new Date().toISOString(),
      expiresAt: null,
      deviceLabel: result.blocking_device,
    };
    const decision = decideLogin(existing, policies.session);
    await recordAttempt({ identifier: rawIdentifier, userId: account.id, ipHash, success: true, reason: "session_conflict" });
    await audit({
      action: "user.login_blocked", userId: account.id, ipHash, customerId: account.customer_id,
      detail: { device: result.blocking_device, existingSince: existing.createdAt },
    });
    return NextResponse.json(
      {
        error: decision.kind === "blocked" ? decision.message : "This account is already logged in elsewhere.",
        code: "session_conflict",
        existingSession: {
          device: result.blocking_device,
          since: existing.createdAt,
          lastActive: existing.lastSeenAt,
          status: sessionStatus(existing, policies.session),
        },
        releasedAfterSeconds: policies.session.staleAfterSeconds,
      },
      { status: 409 },
    );
  }

  await recordAttempt({ identifier: rawIdentifier, userId: account.id, ipHash, success: true });
  await audit({
    action: result.outcome === "taken_over" ? "session.taken_over" : "user.logged_in",
    userId: account.id, sessionId: result.session_id, ipHash, customerId: account.customer_id,
    detail: { device, identifierKind: identifier.kind },
  });

  // an invitation sent before this person had an account takes effect now (§22)
  const { data: claimed } = await db.rpc("rescript_claim_invitations", { p_user: account.id });

  const res = NextResponse.json({
    ok: true,
    user: {
      userId: account.id,
      userCode: account.user_code,
      name: account.full_name,
      email: account.email,
      isPlatformAdmin: account.role === "platform_admin",
    },
    tookOver: result.outcome === "taken_over",
    invitationsClaimed: Number(claimed ?? 0),
  });
  setSessionCookie(res, result.session_id!, policies.session.absoluteLifetimeSeconds);
  return res;
}

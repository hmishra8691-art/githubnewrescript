import "server-only";
import { createClient } from "@supabase/supabase-js";
import { createHash, randomBytes } from "node:crypto";
import type { NextRequest, NextResponse } from "next/server";
import {
  sessionPolicy, throttlePolicy, deviceLabelFrom,
  type SessionPolicy, type ThrottlePolicy, type LockPolicy, type PresencePolicy,
  lockPolicy, presencePolicy,
} from "@rescript/access";

/**
 * AUTHENTICATION — the server side of it.
 *
 * The division of labour, and why it is this way round:
 *
 *   SUPABASE AUTH verifies the password. It owns the hashing, the reset
 *   emails and the account record. Hand-rolling password storage to save a
 *   dependency is the one shortcut in this whole feature that could not be
 *   undone later.
 *
 *   THIS FILE owns the session. Supabase's own tokens are requested, used to
 *   prove the password was right, and then DISCARDED — they never reach the
 *   browser. What the browser gets is an opaque id for a row in
 *   `user_sessions`, and that row is the single authority on whether the user
 *   is logged in.
 *
 * That split is what makes "one active session" enforceable. Supabase Auth
 * will happily mint a refresh token per device, by design; if the browser
 * held one, the platform would have two disagreeing ideas of "logged in" and
 * the requirement could not be met. With an opaque server-side session there
 * is exactly one, and revoking it is a single UPDATE.
 *
 * Nothing secret reaches the client: no access token, no anon key, no service
 * key. The cookie is httpOnly and its value is meaningless without the row.
 */

const SESSION_COOKIE = "rescript_session";

export function supabaseService() {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) throw new Error("SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY not configured");
  return createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } });
}

/**
 * A client for verifying a password.
 *
 * Deliberately separate and never reused across requests: `signInWithPassword`
 * mutates the client's own session state, and a shared client would leak one
 * request's identity into the next.
 */
function supabaseAuthClient() {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_ANON_KEY ?? process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) throw new Error("SUPABASE_URL / SUPABASE_ANON_KEY not configured");
  return createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } });
}

/* ------------------------------------------------------------ hashing */

/**
 * A salted hash of the caller's IP, for throttling and the session record.
 *
 * The same reasoning as the quality engine's device hashes: the platform needs
 * to know "the same source again", never "which house". Salted with a server
 * secret so the hashes are not a lookup table of the internet, and truncated
 * because 96 bits is ample for counting.
 */
export function ipHashOf(req: NextRequest): string | null {
  const fwd = req.headers.get("x-forwarded-for");
  const ip = (fwd ? fwd.split(",")[0] : req.headers.get("x-real-ip"))?.trim();
  if (!ip) return null;
  const salt = process.env.AUTH_HASH_SALT ?? process.env.QUALITY_HASH_SALT ?? "rescript";
  return createHash("sha256").update(`${salt}:${ip}`).digest("hex").slice(0, 24);
}

export function deviceOf(req: NextRequest): string {
  return deviceLabelFrom(req.headers.get("user-agent"));
}

export function newInvitationToken(): string {
  return randomBytes(32).toString("base64url");
}

/* ------------------------------------------------------------ the cookie */

/**
 * Session cookies.
 *
 * `httpOnly` so no script can read it, `sameSite: lax` so a cross-site POST
 * cannot act as the user while an ordinary link still works, `secure` in
 * production. The value is an opaque UUID: it identifies a row and grants
 * nothing on its own, so a leaked cookie is revoked by one UPDATE rather than
 * by rotating a signing key.
 */
export function setSessionCookie(res: NextResponse, sessionId: string, maxAgeSeconds: number): void {
  res.cookies.set(SESSION_COOKIE, sessionId, {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    path: "/",
    maxAge: maxAgeSeconds,
  });
}

export function clearSessionCookie(res: NextResponse): void {
  res.cookies.set(SESSION_COOKIE, "", {
    httpOnly: true, sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    path: "/", maxAge: 0,
  });
}

export function sessionIdFrom(req: NextRequest): string | null {
  const v = req.cookies.get(SESSION_COOKIE)?.value;
  return v && v.length >= 32 ? v : null;
}

export const SESSION_COOKIE_NAME = SESSION_COOKIE;

/* ------------------------------------------------------------ policy */

export interface AccessPolicies {
  session: SessionPolicy;
  throttle: ThrottlePolicy;
  lock: LockPolicy;
  presence: PresencePolicy;
}

/**
 * The effective timings for a customer (§7).
 *
 * Stored as one jsonb blob and interpreted by `@rescript/access`, so the
 * meaning of every threshold lives in the module that implements the state
 * machine and this function only fetches numbers. A missing or malformed
 * settings row falls back to the documented defaults rather than failing a
 * login.
 */
export async function loadPolicies(customerId: string | null): Promise<AccessPolicies> {
  let raw: Record<string, unknown> = {};
  try {
    const db = supabaseService();
    const { data } = await db.rpc("rescript_access_policy", { p_customer: customerId });
    if (data && typeof data === "object") raw = data as Record<string, unknown>;
  } catch {
    /* the defaults are correct and safe; a settings read must never block a login */
  }
  return {
    session: sessionPolicy(raw as never),
    throttle: throttlePolicy(raw as never),
    lock: lockPolicy(raw as never),
    presence: presencePolicy(raw as never),
  };
}

/* ------------------------------------------------------------ credentials */

export interface VerifiedAccount {
  userId: string;
  email: string;
}

/**
 * Check a password. Returns the account or null — never a reason.
 *
 * "No such account" and "wrong password" are the same answer on purpose: the
 * difference is an account-enumeration oracle, and someone probing for which
 * of their guesses are real employees learns nothing from a uniform failure.
 * The reason IS recorded server-side for the audit trail.
 */
export async function verifyPassword(email: string, password: string): Promise<VerifiedAccount | null> {
  const auth = supabaseAuthClient();
  const { data, error } = await auth.auth.signInWithPassword({ email, password });
  if (error || !data.user) return null;
  // the tokens Supabase just issued are not wanted: this platform's session is
  // the row in user_sessions, and a second live credential would undermine it
  await auth.auth.signOut().catch(() => {});
  return { userId: data.user.id, email: data.user.email ?? email };
}

/** Create the account. The profile, user code and workspace come from the trigger. */
export async function createAccount(args: {
  email: string;
  password: string;
  fullName: string;
  organization?: string | null;
  jobTitle?: string | null;
}): Promise<{ userId: string } | { error: string; status: number }> {
  const db = supabaseService();
  const { data, error } = await db.auth.admin.createUser({
    email: args.email,
    password: args.password,
    email_confirm: true,
    user_metadata: {
      full_name: args.fullName,
      organization: args.organization ?? null,
      job_title: args.jobTitle ?? null,
    },
  });
  if (error) {
    const msg = error.message || "The account could not be created.";
    if (/already been registered|already exists|duplicate/i.test(msg)) {
      return { error: "An account with that email address already exists.", status: 409 };
    }
    if (/password/i.test(msg)) return { error: msg, status: 400 };
    return { error: msg, status: 500 };
  }
  if (!data.user) return { error: "The account could not be created.", status: 500 };
  return { userId: data.user.id };
}

/** Change a password for an existing account. */
export async function setPassword(userId: string, password: string): Promise<{ error?: string }> {
  const db = supabaseService();
  const { error } = await db.auth.admin.updateUserById(userId, { password });
  return error ? { error: error.message } : {};
}

/**
 * Look an account up by whatever the user typed (§1: log in with either).
 *
 * A user code is resolved to its email here, on the server, so the login form
 * stays one field and the browser never needs a directory it could enumerate.
 */
export async function findAccount(identifier: { kind: "email" | "user_code" | "unknown"; value: string }) {
  if (identifier.kind === "unknown") return null;
  const db = supabaseService();
  const q = db.from("profiles").select("id, email, full_name, user_code, customer_id, status, role, locked_until");
  const { data } = identifier.kind === "email"
    ? await q.eq("email", identifier.value.toLowerCase()).maybeSingle()
    : await q.eq("user_code", identifier.value).maybeSingle();
  return data ?? null;
}

/** Record an attempt, successful or not — the throttle's raw material. */
export async function recordAttempt(args: {
  identifier: string;
  userId?: string | null;
  ipHash: string | null;
  success: boolean;
  reason?: string;
}): Promise<void> {
  try {
    const db = supabaseService();
    await db.from("login_attempts").insert({
      identifier: args.identifier.slice(0, 200),
      user_id: args.userId ?? null,
      ip_hash: args.ipHash,
      success: args.success,
      reason: args.reason ?? null,
    });
  } catch {
    /* the throttle is a safeguard; failing to write one row must not fail a login */
  }
}

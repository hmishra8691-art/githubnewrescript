import { NextRequest, NextResponse } from "next/server";
import { parseIdentifier } from "@rescript/access";
import { findAccount, ipHashOf, recordAttempt, supabaseService } from "@/lib/authServer";

export const dynamic = "force-dynamic";

/**
 * FORGOT PASSWORD.
 *
 * Answers identically whether or not the address exists. That is not
 * politeness — an endpoint that says "no such account" is a free membership
 * test for the whole platform, and on a system where the tenants are research
 * agencies, knowing who works where is itself the leak.
 *
 * Delivery is Supabase Auth's reset email, so no token is minted or stored
 * here. If the project has no SMTP configured the send fails silently for the
 * user and loudly in the server log, which is the honest split: the person
 * should not be told an internal configuration problem, and an operator must
 * be.
 */
export async function POST(req: NextRequest) {
  let body: any;
  try { body = await req.json(); } catch { return NextResponse.json({ error: "bad json" }, { status: 400 }); }

  const raw = String(body?.identifier ?? body?.email ?? "").trim();
  const identifier = parseIdentifier(raw);
  const SAME_ANSWER = {
    ok: true,
    message: "If an account exists for that User ID or email address, a password reset link is on its way. Check your inbox, including spam.",
  };
  if (identifier.kind === "unknown") return NextResponse.json(SAME_ANSWER);

  const account = await findAccount(identifier);
  await recordAttempt({ identifier: raw, userId: account?.id, ipHash: ipHashOf(req), success: true, reason: "password_reset_requested" });
  if (!account?.email) return NextResponse.json(SAME_ANSWER);

  try {
    const db = supabaseService();
    const redirectTo = process.env.STUDIO_PUBLIC_URL ? `${process.env.STUDIO_PUBLIC_URL}/reset` : undefined;
    const { error } = await db.auth.resetPasswordForEmail(account.email, redirectTo ? { redirectTo } : undefined);
    if (error) {
      console.error("[rescript:auth] reset email not sent — is SMTP configured for this Supabase project?", {
        error: error.message, email: account.email.replace(/(.{2}).*(@.*)/, "$1***$2"),
      });
    }
  } catch (e) {
    console.error("[rescript:auth] reset email failed", { error: (e as Error).message });
  }
  return NextResponse.json(SAME_ANSWER);
}

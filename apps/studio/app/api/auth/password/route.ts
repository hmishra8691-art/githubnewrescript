import { createHash, randomBytes } from "node:crypto";
import { NextRequest, NextResponse } from "next/server";
import { parseIdentifier } from "@rescript/access";
import { findAccount, ipHashOf, recordAttempt, supabaseService } from "@/lib/authServer";
import { sendMail } from "@/lib/mail";
import { passwordResetEmail } from "@rescript/mail";

export const dynamic = "force-dynamic";

/** One hour, matching `password_resets.expires_at`. */
const RESET_TTL_MINUTES = 60;
/** How many resets one account may ask for before it has to wait. */
const RESET_MAX_PER_WINDOW = 3;
const RESET_WINDOW_MINUTES = 15;

/**
 * FORGOT PASSWORD.
 *
 * Answers identically whether or not the address exists. That is not
 * politeness — an endpoint that says "no such account" is a free membership
 * test for the whole platform, and on a system where the tenants are research
 * agencies, knowing who works where is itself the leak.
 *
 * THE RESET IS OURS NOW (migration 0016). It used to call
 * `auth.resetPasswordForEmail` and swallow the failure, which meant "a reset
 * link is on its way" was a lie on every instance without SMTP configured
 * inside the Supabase project — and even with it, the link landed on `/reset`,
 * which could not complete a reset because the Studio never holds a Supabase
 * access token. So: a token minted here, stored as a hash, mailed through the
 * platform's own provider, and redeemed by `PUT` below against
 * `auth.admin.updateUserById`, which the service role can do.
 *
 * The account still lives in Supabase Auth. Only the DELIVERY and the
 * REDEMPTION moved.
 *
 *   POST { identifier }         ask for a link
 *   PUT  { token, password }    redeem one
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

  const masked = account.email.replace(/(.{2}).*(@.*)/, "$1***$2");
  try {
    /* the same-answer contract holds here: a configuration problem is the
     * operator's to see in the log, never the caller's to infer from a
     * different response */
    const db = supabaseService();

    /*
     * A per-account throttle, on top of whatever fronts the endpoint. Without
     * it, "reset my password" is a button that mails somebody as many times as
     * it is pressed — which is a way to harass a person with a platform they
     * cannot log in to, and a good way to get a sending domain blocked. The
     * answer to the CALLER is unchanged, because saying "too many requests"
     * would leak that the account exists.
     */
    const since = new Date(Date.now() - RESET_WINDOW_MINUTES * 60_000).toISOString();
    const { count: recent } = await db
      .from("password_resets")
      .select("id", { count: "exact", head: true })
      .eq("user_id", account.id)
      .gte("created_at", since);
    if ((recent ?? 0) >= RESET_MAX_PER_WINDOW) {
      console.warn("[rescript:auth] reset throttled", { email: masked, recent });
      return NextResponse.json(SAME_ANSWER);
    }

    /*
     * 32 bytes from a CSPRNG, base64url so it survives a URL and a mail
     * client that helpfully "fixes" punctuation. Only its SHA-256 is stored:
     * for the hour it lives, this token is the account.
     */
    const token = randomBytes(32).toString("base64url");
    const tokenHash = createHash("sha256").update(token).digest("hex");

    const { error: insErr } = await db.from("password_resets").insert({
      user_id: account.id,
      email: account.email,
      token_hash: tokenHash,
      expires_at: new Date(Date.now() + RESET_TTL_MINUTES * 60_000).toISOString(),
      requested_ip_hash: ipHashOf(req),
    });
    if (insErr) {
      if (/password_resets|does not exist|schema cache/i.test(insErr.message)) {
        console.error("[rescript:auth] password resets need migration 0016 — no link was sent", { email: masked });
      } else {
        console.error("[rescript:auth] reset token not stored", { email: masked, error: insErr.message });
      }
      return NextResponse.json(SAME_ANSWER);
    }

    const base = (process.env.STUDIO_PUBLIC_URL ?? "").trim().replace(/\/+$/, "");
    if (!base) {
      /*
       * Without an absolute base the link would be `/reset?token=…`, which is
       * not clickable in an email. Loud in the log, silent to the caller.
       */
      console.error("[rescript:auth] STUDIO_PUBLIC_URL is not set, so no reset link could be built", { email: masked });
      return NextResponse.json(SAME_ANSWER);
    }

    const mail = passwordResetEmail({
      name: account.full_name ?? null,
      url: `${base}/reset?token=${encodeURIComponent(token)}`,
      expiresInMinutes: RESET_TTL_MINUTES,
    });
    const sent = await sendMail({
      to: account.email,
      subject: mail.subject,
      text: mail.text,
      html: mail.html,
      kind: "password_reset",
      userId: account.id,
      /* no dedupeKey: asking twice within the throttle SHOULD deliver twice — the first may have gone astray */
    });
    if (!sent.sent) {
      console.error("[rescript:auth] reset email not sent", { email: masked, reason: sent.reason, detail: "detail" in sent ? sent.detail : undefined });
    }
  } catch (e) {
    console.error("[rescript:auth] reset failed", { email: masked, error: (e as Error).message });
  }
  return NextResponse.json(SAME_ANSWER);
}

/**
 * REDEEM A RESET LINK.
 *
 *   PUT { token, password }
 *
 * Unlike the request above, this one answers honestly: the person is holding
 * a token, so there is nothing left to conceal, and "that link has expired"
 * is the only message that tells them what to do next.
 *
 * Three things happen together on success, and the last is the one people
 * forget: the password changes, the token is spent along with every other
 * outstanding reset for that account, and EVERY EXISTING SESSION IS ENDED. A
 * reset is a statement that the old credential is not trusted — leaving
 * whoever is already signed in on that account signed in would defeat the
 * whole point when the reason for the reset is that somebody else had it.
 */
export async function PUT(req: NextRequest) {
  let body: any;
  try { body = await req.json(); } catch { return NextResponse.json({ error: "bad json" }, { status: 400 }); }

  const token = String(body?.token ?? "");
  const password = String(body?.password ?? "");
  if (!token) return NextResponse.json({ error: "That link is missing its token. Request a new one." }, { status: 400 });
  if (password.length < 8) {
    return NextResponse.json({ error: "Choose a password of at least 8 characters." }, { status: 400 });
  }

  /*
   * The database, or an honest 503.
   *
   * `supabaseService()` throws when the instance is not configured, and an
   * uncaught throw here is a bare 500 on the one screen where a person is
   * already anxious and has no other route in. Every other read path in the
   * platform turns this into a 503 with a hint (see `api/surveys/route.ts`);
   * this one now does too.
   */
  let db: ReturnType<typeof supabaseService>;
  try {
    db = supabaseService();
  } catch {
    console.error("[rescript:auth] a reset was attempted on an instance with no database configured");
    return NextResponse.json({
      error: "This platform is not configured to reach its database, so the password could not be changed. Contact whoever runs it.",
      code: "not_configured",
    }, { status: 503 });
  }
  const tokenHash = createHash("sha256").update(token).digest("hex");

  const { data: row, error } = await db
    .from("password_resets")
    .select("id, user_id, email, expires_at, used_at")
    .eq("token_hash", tokenHash)
    .maybeSingle();

  if (error && /password_resets|does not exist|schema cache/i.test(error.message)) {
    return NextResponse.json({ error: "Password resets need migration 0016 applied to this database." }, { status: 503 });
  }

  /*
   * One message for "no such token", "already used" and "expired". They are
   * three different states and the difference is only useful to somebody
   * testing tokens — for the person who clicked an old link, the answer is
   * the same and so is what they must do about it.
   */
  const invalid = () => NextResponse.json(
    { error: "That reset link has expired or has already been used. Request a new one.", code: "reset_invalid" },
    { status: 400 },
  );
  if (!row) return invalid();
  if (row.used_at) return invalid();
  if (Date.parse(row.expires_at) < Date.now()) return invalid();

  const { setPassword } = await import("@/lib/authServer");
  const result = await setPassword(row.user_id, password);
  if (result.error) {
    /* the provider refused it — most often its own strength rules */
    return NextResponse.json({ error: result.error }, { status: 400 });
  }

  const now = new Date().toISOString();
  /* spend this one, and every other live reset for the account */
  await db.from("password_resets")
    .update({ used_at: now, used_ip_hash: ipHashOf(req) })
    .eq("id", row.id);
  await db.from("password_resets")
    .update({ used_at: now })
    .eq("user_id", row.user_id)
    .is("used_at", null);

  /* and end every session on that account */
  try {
    await db.from("user_sessions")
      .update({ status: "revoked", ended_at: now, ended_reason: "password_reset" })
      .eq("user_id", row.user_id)
      .eq("status", "active");
  } catch (e) {
    console.error("[rescript:auth] sessions not revoked after reset", { error: (e as Error).message });
  }

  await recordAttempt({ identifier: row.email, userId: row.user_id, ipHash: ipHashOf(req), success: true, reason: "password_reset_completed" });

  return NextResponse.json({
    ok: true,
    message: "Your password has been changed, and you have been signed out everywhere. Sign in with the new one.",
  });
}

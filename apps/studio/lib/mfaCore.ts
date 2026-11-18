import { deriveKey, envelopeStatus, openEnvelope, sealEnvelope } from "@rescript/ai";
import { mfaRequiredFor, newRecoveryCodes, newTotpSecret, otpauthUrl, readEnrolTicket, signEnrolTicket, useRecoveryCode, verifyTotp, type MfaPolicy } from "@rescript/access/mfa";

/**
 * THE SECOND FACTOR AT SIGN-IN (audit 2026-11-17, P1-07). Called by /api/auth/login after the password and the
 * account status are checked, before a session exists.
 *
 *   enrolled                 the request must carry `mfaCode` (from the app) or `recoveryCode`; otherwise the reply
 *                            is `{ mfa: "challenge" }` and the form asks for the code. A wrong code is a failed
 *                            attempt for the throttle, like a wrong password.
 *   required, not enrolled   the reply is `{ mfa: "enrol", secret, otpauthUrl, qrSvg, ticket }`: a secret proposed
 *                            inside a signed ticket valid for 10 minutes. The next attempt carries the ticket and the
 *                            first code; only then is the secret stored (sealed) and ten recovery codes issued,
 *                            returned once with the session.
 *   neither                  nothing to do.
 *
 * NOT AVAILABLE — migration 0099 not applied, or INTEGRATIONS_SECRET_KEY not set (a secret is never stored in clear):
 * the person signs in with the password, and the sign-in is audited as `user.login_without_mfa` with the reason, so
 * a missing setup is visible rather than silently weakening sign-in. Administrators are not locked out by a
 * deployment that has not finished setting it up.
 */
const ISSUER = process.env.MFA_ISSUER ?? "Rescript";
const TICKET_MS = 10 * 60_000;
const aad = (userId: string) => `mfa|${userId}`;

export interface MfaRow { user_id: string; secret_sealed: string; recovery_hashes: string[]; last_step: number | null }
type Account = { id: string; email: string; role: string | null; customer_id: string | null };

const ticketKey = () => deriveKey("mfa-enrol-ticket");

export type SecondFactor =
  | { pass: true; recoveryCodes?: string[]; enrolledNow?: boolean; note?: string; /** a second factor was checked: what the 409 for a session conflict hands back so "sign in here" does not need a new code */ passToken?: string }
  | { pass: false; status: number; body: Record<string, unknown> };

/** what the decision needs from the outside world: the database row, the audit trail, the throttle, a QR picture */
export interface MfaDeps {
  load(userId: string): Promise<MfaRow | null | "unavailable">;
  /** recovery codes left after one was used */
  saveRecovery(userId: string, hashes: string[]): Promise<void>;
  /** set last_step only if it is still `prev`: true when this request won */
  claimStep(userId: string, prev: number | null, step: number): Promise<boolean>;
  insert(row: { user_id: string; secret_sealed: string; recovery_hashes: string[]; last_step: number }): Promise<string | null>;
  recordAttempt(a: { identifier: string; userId: string; ipHash: string | null; success: false; reason: string }): Promise<void>;
  audit(a: { action: string; userId: string | null; ipHash: string | null; customerId: string | null; detail: Record<string, unknown> }): Promise<void>;
  qr(url: string): Promise<string>;
}
const deny = (status: number, body: Record<string, unknown>) => ({ pass: false as const, status, body });

export async function secondFactorCore(args: { account: Account; policy: MfaPolicy; body: Record<string, unknown>; ipHash: string | null; throttleKey: string }, deps: MfaDeps): Promise<SecondFactor> {
  const { account, policy, body } = args;
  const required = mfaRequiredFor(policy, account.role);
  let row: MfaRow | null | "unavailable";
  try { row = await deps.load(account.id); } catch (e) {
    console.error("[rescript:auth] second-factor lookup failed", { error: (e as Error).message });
    return deny(503, { error: "Sign-in failed. Please try again.", code: "mfa_unavailable" });
  }
  const sealing = envelopeStatus();
  if (row === "unavailable" || (!sealing.ready && (required || row))) {
    if (required || row) {
      const why = row === "unavailable" ? "migration 0099 (user_mfa) is not applied" : `INTEGRATIONS_SECRET_KEY: ${sealing.reason ?? "not set"}`;
      console.warn("[rescript:auth] signed in without a second factor", JSON.stringify({ userId: account.id, required, why }));
      await deps.audit({ action: "user.login_without_mfa", userId: account.id, ipHash: args.ipHash, customerId: account.customer_id, detail: { required, why } });
    }
    return { pass: true };
  }

  const fail = async (reason: string, message: string) => {
    await deps.recordAttempt({ identifier: args.throttleKey, userId: account.id, ipHash: args.ipHash, success: false, reason });
    await deps.audit({ action: "user.login_failed", userId: null, ipHash: args.ipHash, customerId: account.customer_id, detail: { reason } });
    return deny(401, { error: message, code: reason, mfa: row ? "challenge" : "enrol" });
  };

  /* the same sign-in, repeated after a session conflict ("sign in here and end the other session"): the factor was
     checked a moment ago and a TOTP code works once, so the retry carries a 5-minute pass instead */
  const passKey = deriveKey("mfa-pass");
  if (passKey && typeof body.mfaPass === "string") {
    const p = readEnrolTicket(passKey, body.mfaPass);
    if (p && p.userId === account.id && p.sealedSecret === "pass") return { pass: true };
  }
  const passToken = () => (passKey ? signEnrolTicket(passKey, { userId: account.id, sealedSecret: "pass", exp: Date.now() + 5 * 60_000 }) : undefined);

  /* enrolled: a code from the app, or a recovery code */
  if (row) {
    const code = typeof body.mfaCode === "string" ? body.mfaCode : "";
    const recovery = typeof body.recoveryCode === "string" ? body.recoveryCode : "";
    if (!code && !recovery) return deny(401, { mfa: "challenge", error: "Enter the 6-digit code from your authenticator app.", code: "mfa_required" });
    if (recovery) {
      const left = useRecoveryCode(row.recovery_hashes ?? [], recovery);
      if (!left) return fail("bad_recovery_code", "That recovery code is not valid, or has been used.");
      await deps.saveRecovery(account.id, left);
      await deps.audit({ action: "user.mfa_recovery_used", userId: account.id, ipHash: args.ipHash, customerId: account.customer_id, detail: { left: left.length } });
      return { pass: true, note: `${left.length} recovery code${left.length === 1 ? "" : "s"} left`, passToken: passToken() };
    }
    let secret: string;
    try { secret = openEnvelope(row.secret_sealed, aad(account.id)); } catch {
      console.error("[rescript:auth] the second-factor secret could not be opened (key rotated away?)", { userId: account.id });
      return deny(401, { error: "Your two-factor setup cannot be read. Use a recovery code, or ask an administrator to reset it.", code: "mfa_unreadable", mfa: "challenge" });
    }
    const v = verifyTotp(secret, code, { lastStep: row.last_step });
    if (!v.ok) return fail(v.reason === "replayed" ? "mfa_replayed" : "bad_mfa_code", v.reason === "replayed" ? "That code was already used. Wait for the next one." : v.reason === "format" ? "The code is 6 digits." : "That code is not right. Check the time on your phone, and try the current code.");
    /* conditional on last_step, so two simultaneous uses of one code cannot both pass */
    if (!(await deps.claimStep(account.id, row.last_step, v.step))) return fail("mfa_replayed", "That code was already used. Wait for the next one.");
    return { pass: true, passToken: passToken() };
  }

  /* not enrolled */
  if (!required) return { pass: true };
  const key = ticketKey();
  if (!key) return { pass: true };
  const ticket = typeof body.mfaTicket === "string" ? readEnrolTicket(key, body.mfaTicket) : null;
  if (ticket && ticket.userId === account.id && typeof body.mfaCode === "string") {
    const secret = openEnvelope(ticket.sealedSecret, aad(account.id));
    const v = verifyTotp(secret, body.mfaCode);
    if (!v.ok) return fail("bad_mfa_code", "That code is not right. Scan the code again, or type the key, and enter the current code.");
    const { codes, hashes } = newRecoveryCodes();
    const error = await deps.insert({ user_id: account.id, secret_sealed: ticket.sealedSecret, recovery_hashes: hashes, last_step: v.step });
    if (error) return deny(503, { error: "Two-factor sign-in could not be saved. Please try again.", code: "mfa_save_failed" });
    await deps.audit({ action: "user.mfa_enabled", userId: account.id, ipHash: args.ipHash, customerId: account.customer_id, detail: { at: "sign-in", required } });
    return { pass: true, recoveryCodes: codes, enrolledNow: true, passToken: passToken() };
  }
  /* propose a secret */
  const secret = newTotpSecret();
  const { sealed } = sealEnvelope(secret, aad(account.id));
  const url = otpauthUrl(ISSUER, account.email, secret);
  return deny(401, {
      mfa: "enrol", code: "mfa_enrolment_required",
      error: "Your workspace requires two-step sign-in. Add this account to an authenticator app, then enter the code it shows.",
      secret: secret.replace(/(.{4})/g, "$1 ").trim(), otpauthUrl: url, qrSvg: await deps.qr(url),
      ticket: signEnrolTicket(key, { userId: account.id, sealedSecret: sealed, exp: Date.now() + TICKET_MS }),
  });
}

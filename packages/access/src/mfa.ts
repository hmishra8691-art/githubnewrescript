import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";

/**
 * TWO-FACTOR SIGN-IN (audit 2026-11-17, P1-07): time-based one-time passwords (RFC 6238 — the codes every
 * authenticator app shows: Google Authenticator, Microsoft Authenticator, 1Password, Authy), recovery codes, and the
 * workspace rule for who must use them.
 *
 * Pure: the Studio stores the secret sealed (envelope encryption, never in clear) and calls these to check a code.
 *   - 30-second steps, 6 digits, HMAC-SHA1 (what the apps implement); one step of clock drift either way.
 *   - A code is accepted once: the step it matched is returned and stored, and a code from that step or an earlier
 *     one is refused afterwards (a code seen over a shoulder cannot be replayed).
 *   - Ten recovery codes, shown once, stored as SHA-256 hashes; each works once.
 */

const B32 = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
export function base32Encode(buf: Buffer): string {
  let bits = 0, value = 0, out = "";
  for (const byte of buf) { value = (value << 8) | byte; bits += 8; while (bits >= 5) { out += B32[(value >>> (bits - 5)) & 31]; bits -= 5; } }
  if (bits > 0) out += B32[(value << (5 - bits)) & 31];
  return out;
}
export function base32Decode(s: string): Buffer {
  const clean = s.toUpperCase().replace(/[\s=-]/g, "");
  let bits = 0, value = 0; const out: number[] = [];
  for (const ch of clean) { const i = B32.indexOf(ch); if (i < 0) throw new Error("not base32"); value = (value << 5) | i; bits += 5; if (bits >= 8) { out.push((value >>> (bits - 8)) & 255); bits -= 8; } }
  return Buffer.from(out);
}

/** a new secret: 20 random bytes (160 bits, as RFC 4226 recommends), base32 */
export const newTotpSecret = () => base32Encode(randomBytes(20));

/** the code for one 30-second step */
export function totpAt(secretB32: string, step: number, digits = 6): string {
  const key = base32Decode(secretB32);
  const msg = Buffer.alloc(8);
  msg.writeBigUInt64BE(BigInt(step));
  const h = createHmac("sha1", key).update(msg).digest();
  const off = h[h.length - 1] & 0x0f;
  const bin = ((h[off] & 0x7f) << 24) | (h[off + 1] << 16) | (h[off + 2] << 8) | h[off + 3];
  return String(bin % 10 ** digits).padStart(digits, "0");
}
export const stepOf = (nowMs: number) => Math.floor(nowMs / 1000 / 30);

/** check a code: the step it matched (store it), or why not */
export function verifyTotp(secretB32: string, code: string, opts: { now?: number; lastStep?: number | null; window?: number } = {}): { ok: true; step: number } | { ok: false; reason: "format" | "wrong" | "replayed" } {
  const c = String(code ?? "").replace(/\s+/g, "");
  if (!/^\d{6}$/.test(c)) return { ok: false, reason: "format" };
  const now = stepOf(opts.now ?? Date.now());
  const w = opts.window ?? 1;
  for (let d = -w; d <= w; d++) {
    const step = now + d;
    const want = Buffer.from(totpAt(secretB32, step));
    if (timingSafeEqual(want, Buffer.from(c))) {
      if (opts.lastStep != null && step <= opts.lastStep) return { ok: false, reason: "replayed" };
      return { ok: true, step };
    }
  }
  return { ok: false, reason: "wrong" };
}

/** the link an authenticator app reads from the QR code */
export function otpauthUrl(issuer: string, account: string, secretB32: string): string {
  const label = encodeURIComponent(`${issuer}:${account}`);
  return `otpauth://totp/${label}?secret=${secretB32}&issuer=${encodeURIComponent(issuer)}&algorithm=SHA1&digits=6&period=30`;
}

/* -------------------------------------------------------------- recovery */

const hashCode = (code: string) => createHash("sha256").update(code.toUpperCase().replace(/[^A-Z0-9]/g, "")).digest("hex");
/** ten codes like "K7QX-9MPA", and their hashes (store only the hashes) */
export function newRecoveryCodes(n = 10): { codes: string[]; hashes: string[] } {
  const codes = Array.from({ length: n }, () => { const s = base32Encode(randomBytes(5)).slice(0, 8); return `${s.slice(0, 4)}-${s.slice(4)}`; });
  return { codes, hashes: codes.map(hashCode) };
}
/** use one recovery code: the hashes left, or null when it is not one of them */
export function useRecoveryCode(hashes: readonly string[], code: string): string[] | null {
  const h = hashCode(code);
  const i = hashes.findIndex((x) => x.length === h.length && timingSafeEqual(Buffer.from(x), Buffer.from(h)));
  return i < 0 ? null : hashes.filter((_, k) => k !== i);
}

/* ---------------------------------------------------------------- policy */

export type MfaRequirement = "off" | "admins" | "everyone";
export interface MfaPolicy { require: MfaRequirement }
/** platform administrators always; the workspace may extend it to everyone. "off" cannot remove it from administrators. */
export const DEFAULT_MFA_POLICY: MfaPolicy = { require: "admins" };
export function mfaPolicy(raw?: Partial<MfaPolicy> | null): MfaPolicy {
  const r = raw?.require;
  return { require: r === "everyone" || r === "admins" || r === "off" ? r : DEFAULT_MFA_POLICY.require };
}
export const ADMIN_ROLES = new Set(["platform_admin"]);
/** must this person use a second factor? (administrators always — the audit's "required for admins") */
export function mfaRequiredFor(policy: MfaPolicy, platformRole: string | null | undefined): boolean {
  if (ADMIN_ROLES.has(String(platformRole ?? ""))) return true;
  return policy.require === "everyone";
}

/* ------------------------------------------------------- enrolment ticket */

/**
 * Enrolment happens inside the sign-in: the password was right, a second factor is required and none is set up yet.
 * The server proposes a secret and hands it back inside a signed, short-lived ticket; the next sign-in attempt
 * carries the ticket and the first code from the app. Nothing is stored until that code checks out.
 */
export function signEnrolTicket(key: Buffer, payload: { userId: string; sealedSecret: string; exp: number }): string {
  const body = Buffer.from(JSON.stringify(payload)).toString("base64url");
  return `${body}.${createHmac("sha256", key).update(body).digest("base64url")}`;
}
export function readEnrolTicket(key: Buffer, ticket: string, now = Date.now()): { userId: string; sealedSecret: string; exp: number } | null {
  const [body, mac] = String(ticket ?? "").split(".");
  if (!body || !mac) return null;
  const want = createHmac("sha256", key).update(body).digest("base64url");
  if (want.length !== mac.length || !timingSafeEqual(Buffer.from(want), Buffer.from(mac))) return null;
  try {
    const p = JSON.parse(Buffer.from(body, "base64url").toString("utf8"));
    return p && typeof p.userId === "string" && typeof p.sealedSecret === "string" && typeof p.exp === "number" && p.exp > now ? p : null;
  } catch { return null; }
}

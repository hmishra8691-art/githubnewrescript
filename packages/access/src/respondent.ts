import { createHash, randomBytes, scrypt, timingSafeEqual } from "node:crypto";

/**
 * RESPONDENT IDENTITY (Respondent Intelligence Engine, phase 1, 2026-11-20).
 *
 * The rules of a respondent's account, kept pure so the portal, the Studio and the tests decide the same way:
 *
 *   - a respondent id (RSP-XXXXXXXX) that carries no information about the person;
 *   - passwords hashed with scrypt (memory-hard, salted, never stored or logged in clear), and a password rule that
 *     asks for length rather than symbols;
 *   - session, invitation and reset tokens: 32 random bytes, shown once, stored only as SHA-256;
 *   - a lockout after repeated wrong passwords, and sessions that end when idle (a shared or clinic computer);
 *   - when an enrolment in one survey may be started, resumed or is closed.
 *
 * Nothing here reads a database. docs/RESPONDENT-INTELLIGENCE-AUDIT-2026-11-20.md has the design.
 */

/* ------------------------------------------------------------------ ids and tokens */

/** Crockford's alphabet: no I, L, O or U, so an id read aloud or typed from paper is not mistaken */
const ID_ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
export const RESPONDENT_ID = /^RSP-[0-9A-HJKMNP-TV-Z]{8}$/;

export function newRespondentId(bytes: Buffer = randomBytes(8)): string {
  let out = "";
  for (let i = 0; i < 8; i++) out += ID_ALPHABET[bytes[i]! & 31];
  return `RSP-${out}`;
}

/** what the person typed in "Respondent ID or email" */
export function normaliseLogin(raw: unknown): { kind: "respondent_id" | "email"; value: string } | null {
  const s = String(raw ?? "").trim();
  if (!s || s.length > 254) return null;
  const id = s.toUpperCase().replace(/\s+/g, "").replace(/^RSP(?!-)/, "RSP-").replace(/[ILO]/g, (c) => (c === "O" ? "0" : "1"));
  if (RESPONDENT_ID.test(id)) return { kind: "respondent_id", value: id };
  if (/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s)) return { kind: "email", value: s.toLowerCase() };
  return null;
}

export const mintToken = (): string => randomBytes(32).toString("base64url");
export const hashToken = (token: string): string => createHash("sha256").update(token).digest("hex");
export const TOKEN = /^[A-Za-z0-9_-]{43}$/;

/* ------------------------------------------------------------------ passwords */

export const PASSWORD_MIN = 10;
export const PASSWORD_MAX = 200;
const COMMON = new Set(["password", "passw0rd", "qwertyuiop", "1234567890", "0123456789", "letmein123", "welcome123", "changeme123", "iloveyou12", "abcdefghij"]);

/** why this password is refused, in the respondent's words; [] = acceptable */
export function passwordProblems(pw: unknown, about: { email?: string | null; respondentId?: string | null } = {}): string[] {
  const p = typeof pw === "string" ? pw : "";
  const out: string[] = [];
  if (p.length < PASSWORD_MIN) out.push(`Use at least ${PASSWORD_MIN} characters. A short sentence works well.`);
  if (p.length > PASSWORD_MAX) out.push(`Use at most ${PASSWORD_MAX} characters.`);
  if (p.length >= PASSWORD_MIN && new Set(p).size < 5) out.push("Use more different characters.");
  const low = p.toLowerCase();
  if (COMMON.has(low) || /^(.)\1+$/.test(p)) out.push("That password is too easy to guess.");
  const local = (about.email ?? "").toLowerCase().split("@")[0] ?? "";
  if (local.length >= 4 && low.includes(local)) out.push("Do not use your email address in your password.");
  if (about.respondentId && low.includes(about.respondentId.toLowerCase().replace("rsp-", ""))) out.push("Do not use your Respondent ID in your password.");
  return out;
}

const N = 16384, R = 8, P = 1, KEYLEN = 32;
const derive = (pw: string, salt: Buffer, n = N): Promise<Buffer> =>
  new Promise((resolve, reject) => scrypt(pw.normalize("NFKC"), salt, KEYLEN, { N: n, r: R, p: P, maxmem: 64 * 1024 * 1024 }, (e, k) => (e ? reject(e) : resolve(k))));

/** `scrypt$<N>$<salt b64url>$<key b64url>` — the cost is in the hash, so it can be raised later and old hashes still verify */
export async function hashPassword(pw: string): Promise<string> {
  const salt = randomBytes(16);
  return `scrypt$${N}$${salt.toString("base64url")}$${(await derive(pw, salt)).toString("base64url")}`;
}

export async function verifyPassword(pw: string, stored: string | null | undefined): Promise<boolean> {
  const parts = String(stored ?? "").split("$");
  if (parts.length !== 4 || parts[0] !== "scrypt") {
    /* no hash on file: spend the same work, so "no password set" and "wrong password" take the same time */
    await derive(pw, Buffer.alloc(16));
    return false;
  }
  const n = Number(parts[1]);
  if (!Number.isInteger(n) || n < 1024 || n > 1 << 20) return false;
  const want = Buffer.from(parts[3]!, "base64url");
  const got = await derive(pw, Buffer.from(parts[2]!, "base64url"), n);
  return want.length === got.length && timingSafeEqual(want, got);
}

export const passwordNeedsRehash = (stored: string) => !stored.startsWith(`scrypt$${N}$`);

/** a first password for an account created without an invitation link — shown to the researcher once */
export function newInitialPassword(bytes: Buffer = randomBytes(12)): string {
  let s = "";
  for (let i = 0; i < 12; i++) s += ID_ALPHABET[bytes[i]! & 31]!.toLowerCase();
  return `${s.slice(0, 4)}-${s.slice(4, 8)}-${s.slice(8, 12)}`;
}

/* ------------------------------------------------------------------ lockout and sessions */

export interface PortalPolicy {
  /** wrong passwords in a row before the account pauses */
  lockAfter: number;
  lockMinutes: number;
  /** a session with no activity for this long ends (a shared or clinic computer) */
  idleMinutes: number;
  /** a session ends this long after sign-in whatever the activity */
  absoluteHours: number;
  inviteDays: number;
  resetMinutes: number;
}
export const PORTAL_POLICY: PortalPolicy = { lockAfter: 5, lockMinutes: 15, idleMinutes: 30, absoluteHours: 12, inviteDays: 14, resetMinutes: 60 };

export function lockoutVerdict(c: { failedAttempts: number; lastFailedAt: string | null }, now: number, policy = PORTAL_POLICY): { locked: boolean; until: string | null } {
  if (c.failedAttempts < policy.lockAfter || !c.lastFailedAt) return { locked: false, until: null };
  const until = Date.parse(c.lastFailedAt) + policy.lockMinutes * 60_000;
  return until > now ? { locked: true, until: new Date(until).toISOString() } : { locked: false, until: null };
}

/** the counter after one more wrong password: a lock that has run out starts counting again from one */
export function failuresAfterWrong(c: { failedAttempts: number; lastFailedAt: string | null }, now: number, policy = PORTAL_POLICY): number {
  const expired = c.failedAttempts >= policy.lockAfter && !lockoutVerdict(c, now, policy).locked;
  return expired ? 1 : c.failedAttempts + 1;
}

export type SessionEnd = "revoked" | "idle" | "expired";
export function sessionVerdict(s: { createdAt: string; lastSeenAt: string; revokedAt: string | null }, now: number, policy = PORTAL_POLICY): { ok: true } | { ok: false; reason: SessionEnd } {
  if (s.revokedAt) return { ok: false, reason: "revoked" };
  if (now - Date.parse(s.createdAt) > policy.absoluteHours * 3_600_000) return { ok: false, reason: "expired" };
  if (now - Date.parse(s.lastSeenAt) > policy.idleMinutes * 60_000) return { ok: false, reason: "idle" };
  return { ok: true };
}

export type AccountStatus = "invited" | "active" | "suspended" | "closed";
export function accountVerdict(a: { status: AccountStatus; expiresAt: string | null }, now: number): { ok: true } | { ok: false; reason: "suspended" | "closed" | "expired" | "not_activated" } {
  if (a.status === "suspended") return { ok: false, reason: "suspended" };
  if (a.status === "closed") return { ok: false, reason: "closed" };
  if (a.expiresAt && Date.parse(a.expiresAt) <= now) return { ok: false, reason: "expired" };
  if (a.status === "invited") return { ok: false, reason: "not_activated" };
  return { ok: true };
}

/* ------------------------------------------------------------------ one enrolment (a person in one survey) */

export interface EnrolmentFacts {
  /** the survey's own state: only `live` takes new interviews */
  surveyStatus: string;
  accessFrom: string | null;
  accessUntil: string | null;
  suspended: boolean;
  /** null = the survey's own rule (one, or unlimited when it allows retakes) */
  maxAttempts: number | null;
  allowRetake: boolean;
  /** finished interviews (complete, screened out, quota full, terminated) */
  finished: number;
  /** an interview started and not finished */
  inProgress: boolean;
}

export type EnrolmentState = "upcoming" | "open" | "in_progress" | "completed" | "closed" | "suspended";
export interface EnrolmentAccess { state: EnrolmentState; canStart: boolean; canResume: boolean; attemptsLeft: number | null; reason: string | null }

export function enrolmentAccess(f: EnrolmentFacts, now: number): EnrolmentAccess {
  const limit = f.maxAttempts ?? (f.allowRetake ? null : 1);
  const attemptsLeft = limit === null ? null : Math.max(0, limit - f.finished);
  const none = { canStart: false, canResume: false, attemptsLeft };
  if (f.suspended) return { ...none, state: "suspended", reason: "Your access to this assessment has been paused. Please contact the organiser." };
  if (f.accessFrom && Date.parse(f.accessFrom) > now) return { ...none, state: "upcoming", reason: "This assessment has not opened yet." };
  const over = !!f.accessUntil && Date.parse(f.accessUntil) <= now;
  const surveyOpen = f.surveyStatus === "live";
  if (over || !surveyOpen) {
    return { ...none, state: f.finished > 0 ? "completed" : "closed", reason: over ? "The time to take this assessment has ended." : "This assessment is not open at the moment." };
  }
  if (f.inProgress) return { state: "in_progress", canStart: false, canResume: true, attemptsLeft, reason: null };
  if (attemptsLeft === 0) return { ...none, state: "completed", reason: limit === 1 ? null : "You have used all your attempts." };
  return { state: f.finished > 0 ? "completed" : "open", canStart: true, canResume: false, attemptsLeft, reason: null };
}

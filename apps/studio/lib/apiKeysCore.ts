import { createHash, randomBytes } from "node:crypto";

/**
 * PUBLIC API KEYS (audit 2026-11-17, P2-13) — the pure parts: the key's shape, its hash, its scopes, the rate limit.
 *
 * A key belongs to a PERSON in a workspace and can never do more than that person can: every request is checked
 * against the person's own project role at the time of the request (a key keeps working only while its owner's
 * account is active and their access to the project stands). Scopes narrow it further. The key itself is shown once;
 * the database keeps a SHA-256 of it (a key is 160 random bits, so a fast hash is the right one — there is nothing to
 * brute-force) and a short prefix to recognise it in a list.
 */
export const API_SCOPES = ["surveys:read", "responses:read"] as const;
export type ApiScope = (typeof API_SCOPES)[number];
export const SCOPE_WORDS: Record<ApiScope, string> = { "surveys:read": "List projects and read their questionnaires", "responses:read": "Read response data" };

const B32 = "abcdefghijklmnopqrstuvwxyz234567";
export function newApiKey(): { key: string; prefix: string; hash: string } {
  const bytes = randomBytes(20);
  let bits = 0, value = 0, body = "";
  for (const b of bytes) { value = (value << 8) | b; bits += 8; while (bits >= 5) { body += B32[(value >>> (bits - 5)) & 31]; bits -= 5; } }
  const key = `rsk_${body}`;
  return { key, prefix: key.slice(0, 10), hash: hashApiKey(key) };
}
export const hashApiKey = (key: string) => createHash("sha256").update(key.trim()).digest("hex");
export const looksLikeApiKey = (s: string) => /^rsk_[a-z2-7]{32}$/.test(s.trim());

/** the bearer key from an Authorization header, or null */
export function bearerKey(header: string | null | undefined): string | null {
  const m = /^\s*Bearer\s+(\S+)\s*$/i.exec(header ?? "");
  return m && looksLikeApiKey(m[1]) ? m[1] : null;
}

export function cleanScopes(raw: unknown): ApiScope[] | null {
  if (!Array.isArray(raw) || !raw.length) return null;
  const out = [...new Set(raw.map(String))];
  return out.every((s) => (API_SCOPES as readonly string[]).includes(s)) ? (out as ApiScope[]) : null;
}

/**
 * Requests per key per minute, sliding window. Per process: a deployment with several instances allows that many
 * times the limit in the worst case (the same caveat as the runtime's limiter, docs/RATE-LIMITS-2026-11-17.md).
 */
export class KeyRateLimiter {
  private hits = new Map<string, number[]>();
  private perMinute: number;
  constructor(perMinute: number) { this.perMinute = perMinute; }
  /** null when allowed, else the seconds to wait */
  take(keyId: string, now = Date.now()): number | null {
    const since = now - 60_000;
    const list = (this.hits.get(keyId) ?? []).filter((t) => t > since);
    if (list.length >= this.perMinute) { this.hits.set(keyId, list); return Math.max(1, Math.ceil((list[0] + 60_000 - now) / 1000)); }
    list.push(now); this.hits.set(keyId, list);
    if (this.hits.size > 5000) for (const [k, v] of this.hits) if (!v.some((t) => t > since)) this.hits.delete(k);
    return null;
  }
}

/** a page cursor: the last row's (started_at, id), opaque to the caller */
export const encodeCursor = (startedAt: string, id: string) => Buffer.from(JSON.stringify([startedAt, id])).toString("base64url");
export function decodeCursor(c: string | null): { startedAt: string; id: string } | null {
  if (!c) return null;
  try { const [startedAt, id] = JSON.parse(Buffer.from(c, "base64url").toString("utf8")); return typeof startedAt === "string" && /^[0-9a-f-]{36}$/i.test(String(id)) && !Number.isNaN(Date.parse(startedAt)) ? { startedAt, id } : null; } catch { return null; }
}

import "server-only";
import { NextResponse, type NextRequest } from "next/server";
import { loadPolicies } from "./authServer";
import { platformDb } from "./db";
import type { AuthedUser, GuardFailure } from "./guard";
import { KeyRateLimiter, bearerKey, hashApiKey, type ApiScope } from "./apiKeysCore";

/**
 * THE PUBLIC API'S GATE (audit 2026-11-17, P2-13). `Authorization: Bearer rsk_…` → the key's owner, as the same
 * `AuthedUser` a session gives, so every route then calls `requireProjectFor(user, surveyId, capability)` exactly as
 * the Studio does: a key can never reach a project its owner cannot.
 *
 *   401  no key, an unknown, revoked or expired key, or an owner whose account is no longer active
 *   403  the key does not carry the scope the route needs
 *   429  over API_RATE_LIMIT requests a minute for this key (default 120), with Retry-After
 *   503  migration 0100 (api_keys) is not applied
 */
const limiter = new KeyRateLimiter(Math.max(1, Number(process.env.API_RATE_LIMIT ?? 120) || 120));
const json = (body: Record<string, unknown>, status: number, headers: Record<string, string> = {}): GuardFailure => ({ response: NextResponse.json(body, { status, headers: { "cache-control": "no-store", ...headers } }) });

export interface ApiCaller { user: AuthedUser; keyId: string; scopes: string[] }

export async function requireApiKey(req: NextRequest, scope: ApiScope): Promise<ApiCaller | GuardFailure> {
  const key = bearerKey(req.headers.get("authorization"));
  if (!key) return json({ error: "Send an API key: Authorization: Bearer rsk_…", code: "no_key" }, 401, { "www-authenticate": "Bearer" });
  let db: ReturnType<typeof platformDb>;
  try { db = platformDb(); } catch { return json({ error: "The API is not available on this server (no database).", code: "api_unavailable" }, 503); }
  const { data: row, error } = await db.from("api_keys").select("id, user_id, scopes, expires_at, revoked_at, last_used_at").eq("key_hash", hashApiKey(key)).maybeSingle();
  if (error) {
    if (/api_keys|does not exist|schema cache/i.test(error.message)) return json({ error: "The API is not enabled on this server yet (migration 0100).", code: "api_unavailable" }, 503);
    return json({ error: "The key could not be checked. Try again.", code: "key_lookup_failed" }, 503);
  }
  if (!row || row.revoked_at || (row.expires_at && Date.parse(row.expires_at) <= Date.now())) return json({ error: "This API key is not valid (unknown, revoked or expired).", code: "invalid_key" }, 401, { "www-authenticate": "Bearer error=\"invalid_token\"" });
  if (!(row.scopes as string[]).includes(scope)) return json({ error: `This key does not have the ${scope} scope.`, code: "insufficient_scope", scope }, 403);
  const wait = limiter.take(row.id as string);
  if (wait) return json({ error: `Too many requests for this key. Try again in ${wait} s.`, code: "rate_limited" }, 429, { "retry-after": String(wait) });

  const { data: p } = await db.from("profiles").select("id, email, full_name, user_code, customer_id, role, status").eq("id", row.user_id).maybeSingle();
  if (!p || p.status !== "active") return json({ error: "The account this key belongs to is not active.", code: "owner_inactive" }, 401);
  /* when it was last used, at most once a minute per key (a write per request would be a write per request) */
  if (!row.last_used_at || Date.now() - Date.parse(row.last_used_at) > 60_000) void db.from("api_keys").update({ last_used_at: new Date().toISOString() }).eq("id", row.id).then(() => {}, () => {});
  const user: AuthedUser = {
    sessionId: `api:${row.id}`, userId: p.id, customerId: p.customer_id ?? null, isPlatformAdmin: p.role === "platform_admin",
    email: p.email ?? "", fullName: p.full_name ?? p.email ?? "", userCode: p.user_code ?? "", platformRole: p.role ?? "programmer",
    policies: await loadPolicies(p.customer_id ?? null),
  };
  return { user, keyId: row.id as string, scopes: row.scopes as string[] };
}

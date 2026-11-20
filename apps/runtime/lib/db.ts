import "server-only";
import { createClient } from "@supabase/supabase-js";
import { readTenancyConfig, resolveDatabase, describeTenancy, type TenantScope, type TenancyConfig } from "@rescript/storage/tenancy";
import { makeTenantRouter, type DirectoryKind } from "@rescript/storage/routing";
import { supabaseFetch } from "./supabaseFetch";

/**
 * THE ONE WAY TO GET A DATABASE CLIENT (tenancy groundwork, 2026-11-13).
 *
 * Say what the data is:
 *
 *   dbFor({ kind: "platform" })                  people, sign-in, workspaces, billing, the survey-link directory
 *   dbFor({ kind: "customer", customerId })      a client's surveys, responses, quotas, media rows, reports
 *
 * Today both return the primary database, exactly as `supabaseAdmin()` always has. When a big client is given a
 * database of its own (`@rescript/storage/tenancy`, docs/TENANCY-2026-11-13.md), code written this way follows it
 * with no change. New code uses `dbFor`; `scripts/tenancy-audit.mjs` stops the number of direct
 * `supabaseAdmin()` call sites from growing.
 *
 * Service-role, SERVER ONLY; transport `supabaseFetch` (caching off, one short retry budget for reads).
 */
let config: TenancyConfig | null = null;
export function tenancyConfig(): TenancyConfig {
  if (config) return config;
  config = readTenancyConfig(process.env);
  for (const p of config.problems) console.error("[rescript:tenancy] configuration problem", p);
  for (const n of config.notes) console.info("[rescript:tenancy]", n);
  if (config.problems.length || config.notes.length) console.info("[rescript:tenancy]", describeTenancy(config));
  return config;
}

export function dbFor(scope: TenantScope) {
  const target = resolveDatabase(scope, tenancyConfig());
  return createClient(target.url, target.serviceKey, {
    auth: { persistSession: false, autoRefreshToken: false },
    global: { fetch: supabaseFetch() },
  });
}

/** platform data — sign-in, workspaces, billing, the directory. Shorthand for dbFor({ kind: "platform" }). */
export const platformDb = () => dbFor({ kind: "platform" });

/** one client's data. Shorthand for dbFor({ kind: "customer", customerId }). */
export const customerDb = (customerId: string | null | undefined) => dbFor({ kind: "customer", customerId });

export type { TenantScope };

/* ----------------------------------------------------------------------------------------------------------------
 * THE DIRECTORY (tenancy wiring, 2026-11-19). The respondent app holds survey ids, session ids, group join codes and
 * media ids — not client ids. `public.tenant_directory` (migration 0101, in the primary) says which client owns each.
 *
 *   surveyDb(surveyId)               a survey's data (responses, quotas, respondents, recruitment, assessments…)
 *   sessionDb(sessionId, surveyId?)  a session's row and everything keyed by it. When the caller has the survey id
 *                                    (the runner sends `surveyDbId` with every save) it is used directly; otherwise
 *                                    the session's directory row. A database that does not hold the session answers
 *                                    "unknown session", so a wrong or forged survey id can only fail, never reach
 *                                    another client's row.
 *   keyDb(kind, key)                 a group join code, a media object id
 *   registerKey(kind, key, surveyId) records a new key once routing is active (sessions at start, media at ticket)
 *
 * While routing is inactive (today) nothing is read or written and every call returns the primary, exactly as before.
 * A key with no directory row also resolves to the primary: a client not yet moved.
 * -------------------------------------------------------------------------------------------------------------- */
/** keyed by an id, or — for bearer links — by the SHA-256 of the token (the token itself is never stored) */
export { DIRECTORY_KINDS, type DirectoryKind } from "@rescript/storage/routing";

export const router = makeTenantRouter({
  config: tenancyConfig,
  customerDb,
  readDirectory: async (kind, key) => {
    const { data, error } = await platformDb().from("tenant_directory").select("customer_id").eq("kind", kind).eq("key", key).maybeSingle();
    if (error) throw new Error(`tenant directory: ${error.message}`);
    return (data?.customer_id as string | undefined) ?? null;
  },
  writeDirectory: async (row) => {
    const { error } = await platformDb().from("tenant_directory").upsert(row, { onConflict: "kind,key", ignoreDuplicates: true });
    if (error) throw new Error(error.message);
  },
});

export const customerOf = (kind: DirectoryKind, key: string | null | undefined) => router.customerOf(kind, key);
export const keyDb = (kind: DirectoryKind, key: string | null | undefined) => router.keyDb(kind, key);
export const surveyDb = (surveyId: string | null | undefined) => keyDb("survey", surveyId);

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export async function sessionDb(sessionId: string, surveyId?: unknown) {
  if (typeof surveyId === "string" && UUID.test(surveyId)) return surveyDb(surveyId);
  return keyDb("session", sessionId);
}

/**
 * record that a new key belongs to this survey's client — only once routing is active. Never throws; false means the
 * row could not be written, and a caller whose later requests depend on it (a new session) should refuse rather than
 * create something that cannot be found again.
 */
export const registerKey = (kind: Exclude<DirectoryKind, "survey">, key: string, surveyId: string) => router.registerKeyLike(kind, key, "survey", surveyId, surveyId);

/** the same, owned by whoever owns another key — a live member by its invite, an AI interview session by its study link */
export const registerKeyLike = (kind: Exclude<DirectoryKind, "survey">, key: string, ownerKind: DirectoryKind, ownerKey: string, surveyId: string | null = null) =>
  router.registerKeyLike(kind, key, ownerKind, ownerKey, surveyId);

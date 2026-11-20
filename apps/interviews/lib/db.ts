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
 * THE DIRECTORY (tenancy wiring, 2026-11-20). The interviews app reaches a project by its id, an interview by its id
 * and a candidate by their link token — not by client id. `public.tenant_directory` (0101/0102, in the primary) says
 * which client owns each; @rescript/storage/routing is the one implementation every app uses.
 *
 *   projectDb(projectId)        a project's data, before the project row is read (the access check reads it here)
 *   interviewDb(interviewId)    a researcher's page about one interview
 *   candidateDb(token)          a candidate's link (keyed by the token's SHA-256 — the hash interviews.token_hash keeps)
 *   clientDb(customerId)        once the project row is in hand, its customer_id says it directly (no directory read)
 *   everyDatabase()             sweeps and the job runner visit each database once
 *
 * While routing is inactive (today) nothing reads or writes the directory and every call returns the primary.
 * -------------------------------------------------------------------------------------------------------------- */
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

export type Db = ReturnType<typeof customerDb>;
export const keyDb = (kind: DirectoryKind, key: string | null | undefined) => router.keyDb(kind, key);
export const projectDb = (projectId: string | null | undefined) => keyDb("interview_project", projectId);
export const interviewDb = (interviewId: string | null | undefined) => keyDb("interview", interviewId);
export const candidateDb = (tokenHash: string | null | undefined) => keyDb("interview_candidate", tokenHash);
export const clientDb = (customerId: string | null | undefined) => customerDb(customerId);
export const everyDatabase = () => router.everyDatabase();
/** a new key whose client the caller knows (a project created, a candidate invited); false = could not be recorded */
export const registerKeyFor = (kind: DirectoryKind, key: string, customerId: string | null | undefined) => router.registerKeyFor(kind, key, customerId);

/** a new interview: its id (researchers' pages) and its link's hash (the candidate) belong to the project's client */
export async function registerInterview(interviewId: string, tokenHash: string, customerId: string | null | undefined): Promise<boolean> {
  return (await registerKeyFor("interview", interviewId, customerId)) && (await registerKeyFor("interview_candidate", tokenHash, customerId));
}

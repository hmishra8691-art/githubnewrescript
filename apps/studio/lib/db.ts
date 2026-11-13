import "server-only";
import { createClient } from "@supabase/supabase-js";
import { readTenancyConfig, resolveDatabase, describeTenancy, type TenantScope, type TenancyConfig } from "@rescript/storage/tenancy";
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

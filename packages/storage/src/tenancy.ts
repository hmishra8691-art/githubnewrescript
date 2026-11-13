/**
 * WHICH DATABASE HOLDS THIS CLIENT'S DATA (tenancy groundwork, 2026-11-13).
 *
 * Today every client lives in one database (the PRIMARY: SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY). This module is
 * the one place that will decide, later, that a big client's data lives in a database of its own — so that day is a
 * change HERE plus wiring, not a hunt through the code base.
 *
 * Two kinds of data, two kinds of question:
 *
 *   PLATFORM   who people are, sign-in, workspaces, billing, the directory of which client is where, which survey
 *              link belongs to which client — always the primary database             → { kind: "platform" }
 *   CLIENT     a client's surveys, responses, quotas, media rows, reports — the client's database (the primary,
 *              until that client is given its own)                                    → { kind: "customer", customerId }
 *
 * The configuration is read and VALIDATED now, so it can be prepared and checked ahead of time:
 *
 *   RESCRIPT_TENANCY            "single" (default) | "routed"
 *   RESCRIPT_DATABASES          extra databases by id, e.g. "acme,globex"; each id reads
 *                               RESCRIPT_DB_<ID>_URL and RESCRIPT_DB_<ID>_SERVICE_KEY (and optionally _ANON_KEY)
 *   RESCRIPT_TENANT_DATABASES   which client lives where: "<customer uuid>:acme,<customer uuid>:globex"
 *
 * ROUTING IS LOCKED until the wiring is finished (`ROUTING_WIRED` below): every scope resolves to the primary, a tenant
 * map is reported as inactive, and "routed" is reported as a configuration problem (and otherwise ignored). Turning it on while some
 * code still writes to the primary directly would split a client's data across two databases — the one failure this
 * must never allow. `scripts/tenancy-audit.mjs` counts the call sites still to wire.
 *
 * Pure and dependency-free: it returns WHERE (url + key), and each app makes the client exactly as it does today.
 */

export type DatabaseId = string;
export const PRIMARY: DatabaseId = "primary";

export interface DatabaseTarget {
  id: DatabaseId;
  url: string;
  serviceKey: string;
  anonKey?: string;
}

/** what the caller is about to read or write */
export type TenantScope =
  | { kind: "platform" }
  | { kind: "customer"; customerId: string | null | undefined };

export type TenancyMode = "single" | "routed";

export interface TenancyConfig {
  mode: TenancyMode;
  /** every database this deployment can reach, the primary included */
  databases: Map<DatabaseId, DatabaseTarget>;
  /** customer id → database id; customers not listed live in the primary */
  tenants: Map<string, DatabaseId>;
  /** problems found while reading the configuration — a deployment should refuse to start on any of them */
  problems: string[];
  /** facts worth logging once (e.g. a tenant map that is present but inactive) */
  notes: string[];
}

/**
 * Flip to true only when every client-data call site resolves through `dbFor` (scripts/tenancy-audit.mjs reports 0
 * direct call sites in the client-data paths) and the per-database migration check passes.
 */
export const ROUTING_WIRED = false;

type Env = Record<string, string | undefined>;

const ID_RE = /^[a-z][a-z0-9_]{0,31}$/;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const envKey = (id: DatabaseId, part: string) => `RESCRIPT_DB_${id.toUpperCase()}_${part}`;

/** read and validate the tenancy configuration; never throws — problems are returned */
export function readTenancyConfig(env: Env): TenancyConfig {
  const problems: string[] = [];
  const notes: string[] = [];
  const databases = new Map<DatabaseId, DatabaseTarget>();
  const tenants = new Map<string, DatabaseId>();

  const rawMode = (env.RESCRIPT_TENANCY ?? "single").trim().toLowerCase();
  let mode: TenancyMode = "single";
  if (rawMode === "routed") mode = "routed";
  else if (rawMode !== "single" && rawMode !== "") problems.push(`RESCRIPT_TENANCY must be "single" or "routed", not "${rawMode}"`);

  if (env.SUPABASE_URL && env.SUPABASE_SERVICE_ROLE_KEY) {
    databases.set(PRIMARY, { id: PRIMARY, url: env.SUPABASE_URL, serviceKey: env.SUPABASE_SERVICE_ROLE_KEY, anonKey: env.SUPABASE_ANON_KEY });
  }

  for (const raw of (env.RESCRIPT_DATABASES ?? "").split(",").map((x) => x.trim()).filter(Boolean)) {
    const id = raw.toLowerCase();
    if (!ID_RE.test(id) || id === PRIMARY) { problems.push(`database id "${raw}" must be lower-case letters, digits or _ (and not "primary")`); continue; }
    if (databases.has(id)) { problems.push(`database "${id}" is listed twice`); continue; }
    const url = env[envKey(id, "URL")], serviceKey = env[envKey(id, "SERVICE_KEY")];
    if (!url || !serviceKey) { problems.push(`database "${id}" needs ${envKey(id, "URL")} and ${envKey(id, "SERVICE_KEY")}`); continue; }
    if (!/^https:\/\//.test(url)) { problems.push(`${envKey(id, "URL")} must be an https:// URL`); continue; }
    if (databases.get(PRIMARY)?.url === url) { problems.push(`database "${id}" points at the primary database`); continue; }
    databases.set(id, { id, url, serviceKey, anonKey: env[envKey(id, "ANON_KEY")] });
  }

  for (const pair of (env.RESCRIPT_TENANT_DATABASES ?? "").split(",").map((x) => x.trim()).filter(Boolean)) {
    const [customerId, dbRaw] = pair.split(":").map((x) => (x ?? "").trim());
    const db = (dbRaw ?? "").toLowerCase();
    if (!customerId || !UUID_RE.test(customerId)) { problems.push(`"${pair}" in RESCRIPT_TENANT_DATABASES: the customer must be a workspace id (uuid)`); continue; }
    if (!db || !databases.has(db) || db === PRIMARY) { problems.push(`"${pair}" in RESCRIPT_TENANT_DATABASES: "${db}" is not one of RESCRIPT_DATABASES`); continue; }
    if (tenants.has(customerId.toLowerCase())) { problems.push(`customer ${customerId} is mapped twice`); continue; }
    tenants.set(customerId.toLowerCase(), db);
  }

  if (mode === "routed" && !ROUTING_WIRED) {
    problems.push("RESCRIPT_TENANCY=routed is not available yet: some code still reads and writes the primary database directly, so routing a client elsewhere would split its data. See docs/TENANCY-2026-11-13.md.");
  }
  if (mode === "single" && tenants.size) notes.push(`${tenants.size} client(s) are mapped to their own database, but RESCRIPT_TENANCY is "single": everything uses the primary.`);
  return { mode, databases, tenants, problems, notes };
}

/** which database a scope reads and writes. Throws only when there is no primary database at all. */
export function resolveDatabase(scope: TenantScope, config: TenancyConfig): DatabaseTarget {
  const primary = config.databases.get(PRIMARY);
  if (!primary) throw new Error("SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY not configured");
  /* "routed" before the wiring is finished is refused by staying on the primary (readTenancyConfig reports why): a
     misconfigured deployment keeps working, and no client's data is ever split across two databases */
  if (config.mode === "single" || scope.kind === "platform" || !ROUTING_WIRED) return primary;
  const id = scope.customerId ? config.tenants.get(scope.customerId.toLowerCase()) : undefined;
  return (id && config.databases.get(id)) || primary;
}

/** a one-line description for logs and the admin health page — never includes a key */
export function describeTenancy(config: TenancyConfig): string {
  const extra = [...config.databases.keys()].filter((id) => id !== PRIMARY);
  return `tenancy ${config.mode}; databases: ${[PRIMARY, ...extra].join(", ")}; clients on their own database: ${config.tenants.size}${config.mode === "single" && config.tenants.size ? " (inactive)" : ""}`;
}

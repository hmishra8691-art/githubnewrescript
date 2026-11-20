import { makeDirectory, routingActive } from "./directory.js";
import type { TenancyConfig } from "./tenancy.js";

/**
 * TENANT ROUTING, ONE IMPLEMENTATION FOR EVERY APP (tenancy wiring, 2026-11-20).
 *
 * A request arrives with a key — a survey id, a session id, a project id, a bearer link's hash — and the app needs the
 * database of the client that owns it. `public.tenant_directory` (migrations 0101, 0102; in the primary) maps each
 * key to its client. Each app's lib/db.ts builds one router from its own client factory:
 *
 *   keyDb(kind, key)                       the owner's database (the primary when routing is off or the key is unknown)
 *   customerOf(kind, key)                  the owner's id (null when routing is off)
 *   registerKeyLike(kind, key, owner…)     a new key, owned by whoever owns another key (a session by its survey)
 *   registerKeyFor(kind, key, customerId)  a new key whose client the caller already knows (the Studio creating a survey)
 *   everyDatabase()                        each distinct database once — for sweeps and job runners
 *
 * While routing is inactive (today) nothing reads or writes the directory, every key resolves to the primary and
 * `everyDatabase` is the primary alone. A key with no directory row resolves to the primary: a client not yet moved.
 */
export const DIRECTORY_KINDS = [
  "survey", "session", "group", "media", "interview_project",
  "ai_interview_study", "ai_interview_session", "live_invite", "live_member",
  /* 0102 */ "interview", "interview_candidate",
] as const;
export type DirectoryKind = (typeof DIRECTORY_KINDS)[number];

export interface DirectoryRow { kind: DirectoryKind; key: string; customer_id: string; survey_id: string | null }

export interface RouterDeps<C> {
  config: () => TenancyConfig;
  customerDb: (customerId: string | null) => C;
  readDirectory: (kind: DirectoryKind, key: string) => Promise<string | null>;
  /** insert, ignoring a row that is already there */
  writeDirectory: (row: DirectoryRow) => Promise<void>;
  log?: (message: string, detail: Record<string, unknown>) => void;
  /** tests only: the routing switch (default: routingActive(config), false until the wiring is declared finished) */
  active?: () => boolean;
  ttlMs?: number;
  now?: () => number;
}

export interface TenantRouter<C> {
  customerOf(kind: DirectoryKind, key: string | null | undefined): Promise<string | null>;
  keyDb(kind: DirectoryKind, key: string | null | undefined): Promise<C>;
  registerKeyLike(kind: DirectoryKind, key: string, ownerKind: DirectoryKind, ownerKey: string, surveyId?: string | null): Promise<boolean>;
  registerKeyFor(kind: DirectoryKind, key: string, customerId: string | null | undefined, surveyId?: string | null): Promise<boolean>;
  everyDatabase(): { id: string; customerIds: string[] | null; db: C }[];
  active(): boolean;
}

export function makeTenantRouter<C>(deps: RouterDeps<C>): TenantRouter<C> {
  const log = deps.log ?? ((m, d) => console.error(`[rescript:tenancy] ${m}`, JSON.stringify(d)));
  const directory = makeDirectory<DirectoryKind>({
    ttlMs: deps.ttlMs, now: deps.now,
    lookups: Object.fromEntries(DIRECTORY_KINDS.map((k) => [k, (key: string) => deps.readDirectory(k, key)])) as Record<DirectoryKind, (key: string) => Promise<string | null>>,
  });
  const active = deps.active ?? (() => routingActive(deps.config()));
  const customerOf = async (kind: DirectoryKind, key: string | null | undefined) => (!key || !active() ? null : directory.customerOf(kind, key));
  const write = async (row: Omit<DirectoryRow, "customer_id"> & { customer_id: string | null }) => {
    if (!row.customer_id) return true; // a client on the primary needs no row
    try {
      await deps.writeDirectory(row as DirectoryRow);
      return true;
    } catch (e) {
      log("directory row not written", { kind: row.kind, error: (e as Error).message });
      return false;
    }
  };
  return {
    customerOf,
    async keyDb(kind, key) { return deps.customerDb(await customerOf(kind, key)); },
    async registerKeyLike(kind, key, ownerKind, ownerKey, surveyId = null) {
      if (!active()) return true;
      try {
        return await write({ kind, key, customer_id: await customerOf(ownerKind, ownerKey), survey_id: surveyId });
      } catch (e) {
        log("directory owner not found", { kind, ownerKind, error: (e as Error).message });
        return false;
      }
    },
    async registerKeyFor(kind, key, customerId, surveyId = null) {
      if (!active()) return true;
      /* a client with no database of its own lives in the primary: no row needed, and none would be read */
      const mapped = customerId ? deps.config().tenants.has(customerId.toLowerCase()) : false;
      return write({ kind, key, customer_id: mapped ? customerId! : null, survey_id: surveyId });
    },
    everyDatabase() {
      const cfg = deps.config();
      const primary = { id: "primary", customerIds: null as string[] | null, db: deps.customerDb(null) };
      if (!active()) return [primary];
      const byDb = new Map<string, string[]>();
      for (const [customer, dbId] of cfg.tenants) byDb.set(dbId, [...(byDb.get(dbId) ?? []), customer]);
      return [primary, ...[...byDb].map(([id, customers]) => ({ id, customerIds: customers, db: deps.customerDb(customers[0]!) }))];
    },
    active,
  };
}

import { ROUTING_WIRED, type TenancyConfig } from "./tenancy.js";

/**
 * THE DIRECTORY: WHICH CLIENT OWNS THIS SURVEY, SESSION OR PROJECT (tenancy wiring, step 1, 2026-11-19).
 *
 * `dbFor({ kind: "customer", customerId })` needs the client's id. Most code paths only hold a survey id (the
 * respondent app), an interview project id (the interviews app) or a session id. This answers "whose is it?" from the
 * primary database, which keeps the directory for every client, including those later given a database of their own
 * (docs/TENANCY-2026-11-13.md, step 7: moving a client leaves its directory rows behind).
 *
 * Two rules keep it cheap and safe:
 *
 *   - NO LOOKUP WHILE ROUTING CANNOT CHANGE THE ANSWER. Until routing is wired, switched on and at least one client
 *     is mapped, every client resolves to the primary, so asking would only add a round trip to every save.
 *     `routingActive` is false today; the lookups below are never called in production yet.
 *   - A client's id for a survey never changes, so answers are cached (10 minutes), concurrent asks for the same id
 *     share one query, and "not found" is cached briefly (30 s) so a bad id cannot hammer the primary.
 *
 * Pure: the apps pass the lookup functions (lib/db.ts).
 */
export function routingActive(config: TenancyConfig): boolean {
  return ROUTING_WIRED && config.mode === "routed" && config.tenants.size > 0;
}

export type Lookup = (id: string) => Promise<string | null>;

export interface DirectoryOptions<K extends string> {
  lookups: Record<K, Lookup>;
  ttlMs?: number;
  missTtlMs?: number;
  max?: number;
  now?: () => number;
}

export interface Directory<K extends string> {
  /** the client (customers.id) that owns this thing, or null when the primary does not know it */
  customerOf(kind: K, id: string | null | undefined): Promise<string | null>;
  /** for tests and for the admin page after a client is moved */
  forget(kind?: K, id?: string): void;
  size(): number;
}

export function makeDirectory<K extends string>(opts: DirectoryOptions<K>): Directory<K> {
  const ttl = opts.ttlMs ?? 10 * 60_000, missTtl = opts.missTtlMs ?? 30_000, max = opts.max ?? 5_000;
  const now = opts.now ?? Date.now;
  const cache = new Map<string, { value: string | null; until: number }>();
  const inflight = new Map<string, Promise<string | null>>();
  const keyOf = (kind: K, id: string) => `${kind}:${id}`;
  return {
    async customerOf(kind, id) {
      if (!id) return null;
      const key = keyOf(kind, id);
      const hit = cache.get(key);
      if (hit && hit.until > now()) return hit.value;
      const pending = inflight.get(key);
      if (pending) return pending;
      const lookup = opts.lookups[kind];
      if (!lookup) throw new Error(`no directory lookup for "${kind}"`);
      const p = (async () => {
        try {
          const value = await lookup(id);
          if (cache.size >= max) { const oldest = cache.keys().next().value; if (oldest !== undefined) cache.delete(oldest); }
          cache.set(key, { value, until: now() + (value ? ttl : missTtl) });
          return value;
        } finally {
          inflight.delete(key);
        }
      })();
      inflight.set(key, p);
      return p;
    },
    forget(kind, id) {
      if (!kind) { cache.clear(); return; }
      if (id) { cache.delete(keyOf(kind, id)); return; }
      for (const k of [...cache.keys()]) if (k.startsWith(`${kind}:`)) cache.delete(k);
    },
    size: () => cache.size,
  };
}

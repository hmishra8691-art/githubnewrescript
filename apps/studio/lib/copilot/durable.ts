/**
 * A TABLE THAT MAY NOT EXIST YET — the one pattern behind the copilot's
 * stores (research documents, migration 0045; the operation history,
 * migration 0047).
 *
 * A feature ships with its migration, and the operator applies the
 * migration when they choose: between the deploy and that moment the code
 * runs against a database without the table. Failing the feature there
 * would make the deploy order matter, so each store has a DURABLE variant
 * (the table) and a MEMORY variant (this server process, for its life), and
 * says which one answered (`durable`) so the UI can tell the researcher the
 * truth: "kept on this server only until the table is set up". The sandbox
 * — no database row at all — is always memory.
 *
 * Pure (no `server-only`, no Supabase import): the stores' memory halves are
 * unit-tested through it, and the probe is handed in by the caller.
 */

/** Supabase is configured on this server at all (a local developer without it gets memory) */
export const dbConfigured = (env: Record<string, string | undefined> = process.env) => !!env.SUPABASE_URL && !!env.SUPABASE_SERVICE_ROLE_KEY;

/**
 * The error a query raises when its table is not there: Postgres 42P01
 * ("relation … does not exist") straight from the database, or PostgREST's
 * PGRST205 ("Could not find the table … in the schema cache") from the API
 * in front of it. Anything else is a real failure and must not be hidden
 * behind a quiet fallback to memory.
 */
export function tableMissing(e: unknown): boolean {
  const x = (e ?? {}) as { code?: unknown; message?: unknown };
  const code = typeof x.code === "string" ? x.code : "";
  if (code === "42P01" || code === "PGRST205") return true;
  const msg = typeof e === "string" ? e : typeof x.message === "string" ? x.message : "";
  return /relation .* does not exist|does not exist|schema cache/i.test(msg);
}

declare global {
  // eslint-disable-next-line no-var
  var __rescriptMemoryStores: Map<string, Map<string, unknown>> | undefined;
}
/**
 * One named in-process map, shared by every request this server handles —
 * on `globalThis`, because Next's dev server re-evaluates route modules and
 * a module-level map would forget everything on the next compile.
 */
export function memoryOf<T>(name: string): Map<string, T> {
  const all = (globalThis.__rescriptMemoryStores ??= new Map<string, Map<string, unknown>>());
  if (!all.has(name)) all.set(name, new Map<string, unknown>());
  return all.get(name) as Map<string, T>;
}

/**
 * The durable store when its table answers; memory when the table is
 * missing (said once per process in the log, so an operator reading it
 * knows which migration to apply); any other failure is thrown — a
 * database that is down is not a reason to start keeping records nobody
 * will see again.
 */
export async function storeWithFallback<S>(opts: {
  /** the sandbox, or no Supabase: memory without asking */
  memoryOnly: boolean;
  durable: () => S;
  probe: (s: S) => Promise<unknown>;
  memory: () => S;
  /** for the log line: "intelligent_operations (apply migration 0047)" */
  what: string;
}): Promise<S> {
  if (opts.memoryOnly) return opts.memory();
  const s = opts.durable();
  try { await opts.probe(s); return s; } catch (e) {
    if (!tableMissing(e)) throw e;
    const warned = memoryOf<boolean>("warned");
    if (!warned.get(opts.what)) { warned.set(opts.what, true); console.warn(`[rescript:copilot] ${opts.what} is missing; keeping it in this server's memory`); }
    return opts.memory();
  }
}

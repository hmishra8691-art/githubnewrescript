import "server-only";
import { platformDb } from "./db";

/**
 * Service-role client — SERVER ONLY. The service key never reaches the
 * browser; all respondent reads/writes go through the API routes below.
 *
 * The transport is `supabaseFetch`: caching off (a cached `.select()` is a
 * correctness bug here, not a staleness annoyance) and one short retry budget
 * for reads, so a dropped gateway request is not reported as a failure. Both
 * reasons are written out in full in `lib/supabaseFetch.ts`.
 */
export function supabaseAdmin() {
  /*
   * TENANCY (2026-11-13): this is the PRIMARY database — today, every client's. New code says what its data is with
   * `dbFor` / `platformDb` / `customerDb` (lib/db.ts), so it follows a client that is later given its own database;
   * the existing call sites are migrated there step by step (scripts/tenancy-audit.mjs counts them).
   */
  return platformDb();
}

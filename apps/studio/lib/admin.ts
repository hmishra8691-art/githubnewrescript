import "server-only";
import { createClient } from "@supabase/supabase-js";

/**
 * Service-role client — SERVER ONLY. The service key never reaches the
 * browser; all respondent reads/writes go through the API routes below.
 */
/**
 * `fetch` with caching switched OFF, for every read this client makes.
 *
 * Next's App Router patches the global `fetch` and, in this version, caches
 * GET requests in its Data Cache by default, with no expiry. supabase-js uses
 * that global `fetch`, so a `.select()` could be answered from a cache
 * indefinitely — which for this platform is a correctness bug rather than a
 * staleness annoyance: quota counters, List Fill allocation counts, response
 * totals and the survey draft itself are all read this way, and a live quota
 * that reads a cached count over-fills.
 *
 * RPCs happen to be POSTs and were never at risk. Relying on that distinction
 * would be relying on an implementation detail of a library, so the caching is
 * turned off at the client instead — once, here, rather than at every call
 * site where one would eventually be missed.
 */
const uncachedFetch: typeof fetch = (input, init) =>
  fetch(input as never, { ...(init ?? {}), cache: "no-store" });

export function supabaseAdmin() {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) throw new Error("SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY not configured");
  return createClient(url, key, {
    auth: { persistSession: false },
    global: { fetch: uncachedFetch },
  });
}

import "server-only";
import { createClient } from "@supabase/supabase-js";
import { supabaseFetch } from "./supabaseFetch";

/**
 * Service-role client — SERVER ONLY. The service key never reaches the
 * browser; all respondent reads/writes go through the API routes below.
 *
 * The transport is `supabaseFetch`: caching off (a cached quota count
 * over-fills) and one short retry budget for reads, so a dropped gateway
 * request does not end somebody's interview. Both reasons are written out in
 * full in `apps/studio/lib/supabaseFetch.ts`.
 */
export function supabaseAdmin() {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) throw new Error("SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY not configured");
  return createClient(url, key, {
    auth: { persistSession: false },
    global: { fetch: supabaseFetch() },
  });
}

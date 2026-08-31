import "server-only";
import { createClient } from "@supabase/supabase-js";

/**
 * Service-role client — SERVER ONLY. The service key never reaches the
 * browser; all respondent reads/writes go through the API routes below.
 */
export function supabaseAdmin() {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) throw new Error("SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY not configured");
  return createClient(url, key, { auth: { persistSession: false } });
}

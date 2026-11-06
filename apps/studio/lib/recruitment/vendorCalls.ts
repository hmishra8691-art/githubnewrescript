import "server-only";
import type { BreakerState, CallRecord } from "@rescript/recruitment";
import { supabaseAdmin } from "@/lib/admin";

/**
 * THE OTHER HALF OF vendorFetch (platform audit 2026-11-05, finding 2).
 *
 * `vendorFetch` takes an optional `record` callback and an optional durable breaker `state`. 0086 created the two
 * tables they write — `vendor_api_calls`, `vendor_circuit_state` — and `rescript_vendor_health_recompute` reads
 * the first to set every integration's `health`. For a month no caller passed either, so the call log was
 * permanently empty, the health recompute in the hourly pass returned 0 every time, every integration's health
 * stayed whatever it last said, and the circuit breaker lived in process memory — which on serverless resets
 * on nearly every request, so a vendor failing on every call was retried on every call.
 *
 * This is the one place both are built. `liveRegistry` hands them to every live adapter.
 *
 * ## Rules
 *
 * - Neither write may ever fail a vendor call. A log row that cannot be written is a warning in the server log;
 *   the call proceeds. (A breaker that cannot read its state falls back to "closed", which is what the
 *   in-memory one did on a cold start — no worse than before.)
 * - `vendor_api_calls.customer_id` is NOT NULL, and `vendorFetch` knows only the integration. The customer is
 *   read once per integration per process from `vendor_integrations` and cached; an integration this process
 *   cannot resolve (deleted mid-flight) is not logged, and says so once.
 * - The path only, never a query string — `vendorFetch` already strips it (`safePath`); this inserts what it
 *   is given and nothing more.
 */

const customerOf = new Map<string, Promise<string | null>>();

function customerFor(integrationId: string): Promise<string | null> {
  let p = customerOf.get(integrationId);
  if (!p) {
    p = (async () => {
      const { data, error } = await supabaseAdmin().from("vendor_integrations").select("customer_id").eq("id", integrationId).maybeSingle();
      if (error || !data) {
        customerOf.delete(integrationId); // try again next call rather than caching a transient miss
        return null;
      }
      return (data as { customer_id: string }).customer_id;
    })();
    customerOf.set(integrationId, p);
  }
  return p;
}

/** one row per vendor call, for `rescript_vendor_health_recompute` and the integration's call history */
export async function recordVendorCall(row: CallRecord): Promise<void> {
  try {
    const customer = await customerFor(row.integrationId);
    if (!customer) {
      console.warn(`[recruitment] vendor call not logged: integration ${row.integrationId} has no customer`);
      return;
    }
    const { error } = await supabaseAdmin().from("vendor_api_calls").insert({
      customer_id: customer,
      integration_id: row.integrationId,
      operation: row.operation.slice(0, 60),
      method: row.method,
      path: row.path.slice(0, 300),
      status: row.status,
      ok: row.ok,
      attempts: row.attempts,
      elapsed_ms: Math.max(0, Math.round(row.elapsedMs)),
      error: row.error ? row.error.slice(0, 500) : null,
    });
    if (error) console.warn(`[recruitment] vendor call not logged: ${error.message}`);
  } catch (e) {
    console.warn("[recruitment] vendor call not logged", e);
  }
}

/** the breaker's state in `vendor_circuit_state`, keyed as vendorFetch keys it (`breaker:<integration id>`) */
export const durableBreakerState: BreakerState = {
  async get(key) {
    const id = key.startsWith("breaker:") ? key.slice("breaker:".length) : key;
    try {
      const { data, error } = await supabaseAdmin().from("vendor_circuit_state").select("consecutive_failures, opened_at").eq("integration_id", id).maybeSingle();
      if (error || !data) return null;
      const row = data as { consecutive_failures: number; opened_at: string | null };
      return { failures: row.consecutive_failures, openedAt: row.opened_at ? new Date(row.opened_at).getTime() : null };
    } catch {
      return null;
    }
  },
  async set(key, value) {
    const id = key.startsWith("breaker:") ? key.slice("breaker:".length) : key;
    try {
      const { error } = await supabaseAdmin().from("vendor_circuit_state").upsert({
        integration_id: id,
        consecutive_failures: value.failures,
        opened_at: value.openedAt === null ? null : new Date(value.openedAt).toISOString(),
        updated_at: new Date().toISOString(),
      }, { onConflict: "integration_id" });
      if (error) console.warn(`[recruitment] breaker state not written: ${error.message}`);
    } catch (e) {
      console.warn("[recruitment] breaker state not written", e);
    }
  },
};

/** the two together, as every live adapter takes them */
export const liveHttpOptions = { record: recordVendorCall, state: durableBreakerState } as const;

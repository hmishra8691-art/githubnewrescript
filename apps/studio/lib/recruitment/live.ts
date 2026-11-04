import "server-only";
import { AdapterRegistry, createManualAdapter, createProlificAdapter } from "@rescript/recruitment";

/**
 * THE LIVE ADAPTER REGISTRY (Phase 6b) — built once per process, with the manual adapter as the fallback.
 *
 * Every integration not in `api` mode keeps using the manual adapter, so adding a live one changes nothing for
 * an organisation that has not given credentials. That is the registry's own rule (`mode` is the statement of
 * what is actually configured, not what is theoretically possible), and this is simply where the live ones are
 * handed to it.
 */

/**
 * A vendor call inside a comparison is bounded well below the route's own budget. A researcher pressing
 * "compare" across eight vendors must not wait for eight timeouts, and a slow vendor should cost its own row
 * its live figures rather than cost the whole screen.
 */
export const LIVE_FEASIBILITY_MS = 8_000;

const MANUAL = createManualAdapter({ pricing: async () => [], history: async () => undefined });

let cached: AdapterRegistry | null = null;

export function liveRegistry(): AdapterRegistry {
  if (cached) return cached;
  cached = new AdapterRegistry([createProlificAdapter()], MANUAL);
  return cached;
}

import type { VendorCapability, VendorCapabilityState, VendorMode } from "@rescript/schema";
import type { AdapterContext, VendorAdapter } from "../adapter.js";
import { CapabilityError, capabilityState } from "../capabilities.js";

/**
 * THE ADAPTER REGISTRY — one place that knows which adapter serves which integration, and the only place that
 * dispatches to one.
 *
 * Dispatch goes through `invoke`, which checks the capability before calling. That check is the whole reason the
 * registry exists: without it every call site would have to remember, and the first one that forgets makes a
 * vendor call the organisation is not entitled to make, or shows a researcher a figure from an operation the
 * vendor never performed.
 */

export interface RegisteredIntegration {
  integrationId: string;
  vendorName: string;
  vendorSlug: string;
  mode: VendorMode;
  recorded: readonly VendorCapabilityState[];
}

export class AdapterRegistry {
  private readonly adapters = new Map<string, VendorAdapter>();
  private readonly fallback: VendorAdapter | null;

  /** `fallback` is the manual adapter: any vendor with no live adapter is still a usable manual relationship. */
  constructor(adapters: readonly VendorAdapter[] = [], fallback: VendorAdapter | null = null) {
    for (const a of adapters) this.adapters.set(a.id, a);
    this.fallback = fallback;
  }

  register(adapter: VendorAdapter): void {
    this.adapters.set(adapter.id, adapter);
  }

  /**
   * The adapter for an integration. A vendor with its own adapter uses it only when the integration is in `api`
   * mode; a `manual` integration with Cint uses the manual adapter even though a Cint adapter exists, because the
   * organisation has not given it credentials and the mode is the statement of what is actually configured.
   */
  for(integration: RegisteredIntegration): VendorAdapter | null {
    if (integration.mode === "api") return this.adapters.get(integration.vendorSlug) ?? null;
    if (integration.mode === "manual") return this.fallback;
    return null;
  }

  /** What this integration can actually do right now, after both the adapter and the recorded state. */
  capabilities(integration: RegisteredIntegration): VendorCapability[] {
    const adapter = this.for(integration);
    if (!adapter) return [];
    return adapter.capabilities.filter(
      (c) => capabilityState(integration.mode, c, adapter.capabilities, integration.recorded) !== "unsupported",
    );
  }

  /**
   * Call one operation, having checked it is allowed. `op` is the method name, so a typo is a compile error
   * rather than a silent no-op.
   */
  async invoke<K extends keyof VendorAdapter & VendorCapabilityMethod>(
    integration: RegisteredIntegration,
    capability: VendorCapability,
    op: K,
    call: (adapter: VendorAdapter, ctx: AdapterContext) => Promise<unknown>,
    ctx: AdapterContext,
  ): Promise<unknown> {
    const adapter = this.for(integration);
    if (!adapter) throw new CapabilityError(capability, "unsupported", integration.vendorName);
    const state = capabilityState(integration.mode, capability, adapter.capabilities, integration.recorded);
    if (state === "unsupported") throw new CapabilityError(capability, state, integration.vendorName);
    if (typeof adapter[op] !== "function") throw new CapabilityError(capability, "unsupported", integration.vendorName);
    return call(adapter, ctx);
  }
}

type VendorCapabilityMethod =
  | "authenticate" | "feasibility" | "quote" | "createOrder" | "orderStatus" | "cancelOrder" | "reconcile";

/**
 * The vendors this build can actually talk to (Phase 6).
 *
 * One list, consulted by the registry and by the route that decides whether `api` mode may be chosen. Phase 1
 * refused `api` for EVERY vendor, which was true then and is not now — but the refusal still has to hold for a
 * vendor with no adapter, or the marketplace would let somebody configure an API integration that cannot make
 * a single call. A vendor is here only once its adapter exists.
 */
export const LIVE_ADAPTER_SLUGS: readonly string[] = Object.freeze(["prolific"]);

export function hasLiveAdapter(vendorSlug: string): boolean {
  return LIVE_ADAPTER_SLUGS.includes(vendorSlug);
}

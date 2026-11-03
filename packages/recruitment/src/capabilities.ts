import { VENDOR_CAPABILITIES, type VendorCapability, type VendorCapabilityState, type VendorMode } from "@rescript/schema";

/**
 * THE CAPABILITY REGISTRY.
 *
 * The brief's §5 is unambiguous: "Do not represent a vendor as integrated or available unless the relevant
 * integration or manually configured capability actually exists." That is easy to agree with and easy to break,
 * because the natural way to build a marketplace is a grid of vendor rows with a tick in every column, and the
 * ticks come from a designer's mock rather than from anything that runs.
 *
 * So capability is data, it is checked in one place, and there is no path from the registry to a screen that does
 * not go through `capabilityState`. A capability has three states, not two:
 *
 *   unsupported   the adapter does not implement it, or the integration's mode forbids it
 *   declared      implemented and configured, but never yet exercised against the vendor
 *   verified      exercised against the vendor successfully, with the date it last worked
 *
 * `declared` is the state that matters. It is what an API integration is on the day its credentials are entered,
 * and rendering it as a tick is exactly the lie the brief forbids. The UI renders the word.
 */

export type CapabilityState = "unsupported" | "declared" | "verified";

/**
 * What each mode could ever support. An integration cannot claim more than its mode allows however its adapter is
 * written — a `redirect_only` relationship has no channel to ask a question down, so it cannot have feasibility
 * whatever anybody ticks.
 */
export const MODE_CEILING: Readonly<Record<VendorMode, readonly VendorCapability[]>> = Object.freeze({
  api: VENDOR_CAPABILITIES,
  // an operator with a rate card and an e-mail thread can do all of this; none of it is automatic
  manual: ["feasibility", "quote", "order", "status", "reconcile", "cancel", "refund"] as const,
  // 0072's redirect contract: people arrive and are sent back, and nothing is ordered through the platform
  redirect_only: ["webhook"] as const,
  awaiting: [] as const,
  inactive: [] as const,
});

export function modeAllows(mode: VendorMode, capability: VendorCapability): boolean {
  return MODE_CEILING[mode].includes(capability);
}

/**
 * The state of one capability, from the integration's mode, what the adapter implements, and what the database
 * recorded. Every argument is required: there is no default that silently reads as "yes".
 */
export function capabilityState(
  mode: VendorMode,
  capability: VendorCapability,
  implemented: readonly VendorCapability[],
  recorded: readonly VendorCapabilityState[],
): CapabilityState {
  if (!modeAllows(mode, capability)) return "unsupported";
  if (!implemented.includes(capability)) return "unsupported";
  const row = recorded.find((r) => r.capability === capability);
  if (!row || !row.supported) return "unsupported";
  return row.verifiedAt ? "verified" : "declared";
}

/** Every capability's state, for a marketplace row. */
export function capabilityMatrix(
  mode: VendorMode,
  implemented: readonly VendorCapability[],
  recorded: readonly VendorCapabilityState[],
): Record<VendorCapability, CapabilityState> {
  const out = {} as Record<VendorCapability, CapabilityState>;
  for (const c of VENDOR_CAPABILITIES) out[c] = capabilityState(mode, c, implemented, recorded);
  return out;
}

/**
 * The gate. Call this before every adapter operation; it throws rather than returning false, because a caller
 * that forgets to check a boolean gets a vendor call it was not entitled to make, and a caller that forgets to
 * catch gets a 500 and a log line. The message names the capability and the reason, so the Studio can show it.
 */
export class CapabilityError extends Error {
  readonly capability: VendorCapability;
  readonly state: CapabilityState;
  constructor(capability: VendorCapability, state: CapabilityState, vendor: string) {
    super(
      state === "unsupported"
        ? `${vendor} cannot ${capability}: the integration does not support it`
        : `${vendor} cannot ${capability}`,
    );
    this.name = "CapabilityError";
    this.capability = capability;
    this.state = state;
  }
}

export function requireCapability(
  vendorName: string,
  mode: VendorMode,
  capability: VendorCapability,
  implemented: readonly VendorCapability[],
  recorded: readonly VendorCapabilityState[],
): void {
  const state = capabilityState(mode, capability, implemented, recorded);
  if (state === "unsupported") throw new CapabilityError(capability, state, vendorName);
}

/**
 * A one-line description of what an organisation's relationship with a vendor currently is, for the marketplace
 * card. Deliberately plain: a researcher deciding where to spend $40,000 is owed a sentence, not a badge.
 */
export function integrationSummary(mode: VendorMode, matrix: Record<VendorCapability, CapabilityState>): string {
  if (mode === "awaiting") return "Awaiting integration — nothing can be ordered yet";
  if (mode === "inactive") return "Inactive";
  if (mode === "redirect_only") return "Recruitment links only — feasibility and orders are handled in the vendor's own dashboard";
  const verified = Object.values(matrix).filter((s) => s === "verified").length;
  const declared = Object.values(matrix).filter((s) => s === "declared").length;
  if (mode === "manual") {
    return declared + verified === 0
      ? "Manual — no pricing configured yet"
      : `Manual — ${declared + verified} operation${declared + verified === 1 ? "" : "s"} configured, entered by an operator`;
  }
  if (verified === 0) return `API — ${declared} operation${declared === 1 ? "" : "s"} configured, none yet verified against the vendor`;
  return `API — ${verified} verified, ${declared} configured but not yet verified`;
}

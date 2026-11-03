import type {
  AudienceSpecification, FeasibilityEstimate, PricingSource, VendorCapability, VendorMode,
} from "@rescript/schema";

/**
 * THE VENDOR ADAPTER INTERFACE.
 *
 * Every sample provider is reached through one of these, and nothing above this line knows that Cint speaks
 * JSON over HTTPS while a regional provider answers e-mail. The interface is deliberately narrow and entirely
 * asynchronous — even the manual adapter, whose "network call" is a database read — so that Phase 6 can add a
 * live adapter without changing a single caller.
 *
 * Three rules hold for every implementation:
 *
 *   1. It declares what it implements in `capabilities`. The registry checks this before dispatching, so an
 *      adapter is never asked for an operation it does not have, and a vendor is never shown as having one.
 *   2. Every figure it returns carries a `source`. An adapter that invents a `live` source is the one bug in
 *      this subsystem that would cost real money, so `source` is not optional and `ManualAdapter` cannot
 *      return `live` at all.
 *   3. It never throws for a vendor-side "no". A vendor with no sample, an expired rate card or a market it does
 *      not cover is a RESULT (`available: 0`, or an estimate with `unavailableReason`), not an exception.
 *      Exceptions are for transport and configuration faults, which is what `AdapterError` is for.
 */

export interface AdapterContext {
  /** the `vendor_integrations` row id */
  integrationId: string;
  /** for messages and logs; never a credential */
  vendorName: string;
  mode: VendorMode;
  /** the organisation, for scoping every read this adapter makes */
  customerId: string;
  currency: string;
  /** basis points added to the vendor's CPI under the organisation's commercial agreement */
  markupBps: number;
  /** opened credentials, for the adapters that have them. Never logged, never returned, never serialised. */
  credentials?: Readonly<Record<string, string>>;
  /** an abort signal from the caller's request, so a slow vendor cannot hold a route open */
  signal?: AbortSignal;
}

export interface FeasibilityRequest {
  audience: AudienceSpecification;
  requiredCompletes: number;
  loiMinutes: number;
  /** the researcher's own incidence expectation, when they have one; the vendor may disagree and say so */
  expectedIr?: number;
  deadlineDays?: number;
}

export interface QuotationRequest extends FeasibilityRequest {
  recruitmentProjectId: string;
}

export interface OrderRequest {
  recruitmentProjectId: string;
  orderId: string;
  /**
   * The audience, so a live adapter can apply targeting at order time (Phase 6).
   *
   * Optional because the manual adapter has no use for it — an operator carries the audience to the vendor's
   * own portal themselves. For an API adapter it is not optional in practice: ordering without it recruits the
   * general population and bills for it, so an adapter that needs targeting must refuse rather than proceed
   * with none.
   */
  audience?: AudienceSpecification;
  completes: number;
  cpi: number;
  currency: string;
  /** the live survey link the vendor sends people to, already carrying this vendor's panel parameters */
  entryUrl: string;
  /** where the vendor's people are sent back, per outcome — 0072's redirect contract */
  returnUrls: Readonly<Partial<Record<"complete" | "screenout" | "quota_full" | "terminate" | "over_quota", string>>>;
}

export interface OrderAck {
  /** the vendor's own identifier, when it issues one; null for a manual order */
  vendorOrderRef: string | null;
  status: "placed" | "live" | "failed";
  message?: string;
}

export interface OrderProgress {
  vendorOrderRef: string | null;
  /** ABSOLUTE counts, never deltas: an out-of-order callback must not be able to double-count */
  delivered: number;
  accepted: number;
  rejected: number;
  duplicates: number;
  /** what the vendor says is owed, when it says; otherwise the platform computes accepted × agreed CPI */
  spend: number | null;
  status: "placed" | "live" | "paused" | "complete" | "cancelled" | "failed";
  /** the key that makes applying this progress idempotent */
  idempotencyKey: string;
}

export interface ReconciliationLine {
  vendorOrderRef: string | null;
  /** the vendor's identifier for the participant, as it arrived on the recruitment link */
  participantId: string;
  outcome: "complete" | "screenout" | "quota_full" | "terminate" | "over_quota";
  billable: boolean;
  amount: number | null;
  occurredAt: string | null;
}

/**
 * A transport or configuration fault. `retryable` tells the orchestrator whether to back off and try again or
 * to surface the problem to an operator; the distinction matters because a wrong API key retried forty times is
 * how an account gets locked.
 */
export class AdapterError extends Error {
  readonly retryable: boolean;
  readonly vendorStatus?: number;
  constructor(message: string, opts: { retryable?: boolean; vendorStatus?: number; cause?: unknown } = {}) {
    super(message, opts.cause !== undefined ? { cause: opts.cause } : undefined);
    this.name = "AdapterError";
    this.retryable = opts.retryable ?? false;
    this.vendorStatus = opts.vendorStatus;
  }
}

export interface VendorAdapter {
  /** stable identifier, matching `panel_vendors.slug` for catalogue vendors */
  readonly id: string;
  /** what this adapter implements. The registry will not dispatch anything outside this set. */
  readonly capabilities: readonly VendorCapability[];
  /** the strongest provenance this adapter can ever claim. The manual adapter's is `vendor_reported`. */
  readonly maxSource: PricingSource;

  /** confirm the credentials work. Never part of a respondent-facing path. */
  authenticate?(ctx: AdapterContext): Promise<{ ok: boolean; message?: string }>;
  feasibility?(ctx: AdapterContext, req: FeasibilityRequest): Promise<FeasibilityEstimate>;
  quote?(ctx: AdapterContext, req: QuotationRequest): Promise<FeasibilityEstimate>;
  createOrder?(ctx: AdapterContext, req: OrderRequest): Promise<OrderAck>;
  orderStatus?(ctx: AdapterContext, vendorOrderRef: string): Promise<OrderProgress>;
  cancelOrder?(ctx: AdapterContext, vendorOrderRef: string, reason: string): Promise<{ cancelled: boolean; message?: string }>;
  reconcile?(ctx: AdapterContext, vendorOrderRef: string): Promise<ReconciliationLine[]>;
}

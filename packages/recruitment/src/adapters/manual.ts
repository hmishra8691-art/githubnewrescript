import type { FeasibilityEstimate, VendorCapability, VendorPricingRow } from "@rescript/schema";
import type {
  AdapterContext, FeasibilityRequest, OrderAck, OrderProgress, OrderRequest, QuotationRequest,
  ReconciliationLine, VendorAdapter,
} from "../adapter.js";
import { AdapterError } from "../adapter.js";
import { estimateForVendor, type VendorHistory } from "../feasibility.js";

/**
 * THE MANUAL ADAPTER — the only adapter that works today, and the one most sample desks will use for years.
 *
 * A manual integration is a real relationship: an operator has the vendor's rate card, e-mails them for
 * feasibility, places orders in the vendor's portal and reconciles against an invoice. None of that is automated,
 * and pretending otherwise would be the brief's forbidden "fake live metrics". What this adapter does is make
 * that relationship a first-class citizen of the exchange: the rate card is queryable, the comparison includes
 * the vendor, the order exists as a record, and progress an operator enters flows through the same idempotent
 * path a live webhook will use in Phase 6.
 *
 * `maxSource` is `vendor_reported`, and `estimateForVendor` can only return the source on the rate-card row, so
 * **this adapter cannot produce a `live` figure**. That is enforced by construction rather than by review.
 */

/**
 * Everything the adapter needs, injected. Keeping the adapter free of I/O is what lets the Studio and the tests
 * share it, and what keeps `@rescript/recruitment` browser-safe so the marketplace can compute its own totals.
 */
export interface ManualSource {
  pricing(integrationId: string): Promise<readonly VendorPricingRow[]>;
  history(integrationId: string): Promise<VendorHistory | undefined>;
  /** the available sample an operator recorded for this audience, when they recorded one */
  statedAvailable?(integrationId: string, recruitmentProjectId?: string): Promise<number | null>;
  /** what an operator last entered about an order's progress */
  orderProgress?(orderId: string): Promise<OrderProgress | null>;
  reconciliation?(orderId: string): Promise<ReconciliationLine[]>;
}

const CAPABILITIES: readonly VendorCapability[] = ["feasibility", "quote", "order", "status", "reconcile", "cancel"];

export function createManualAdapter(source: ManualSource, id = "manual"): VendorAdapter {
  async function estimate(ctx: AdapterContext, req: FeasibilityRequest, projectId?: string): Promise<FeasibilityEstimate> {
    const [pricing, history, stated] = await Promise.all([
      source.pricing(ctx.integrationId),
      source.history(ctx.integrationId),
      source.statedAvailable ? source.statedAvailable(ctx.integrationId, projectId) : Promise.resolve(null),
    ]);
    return estimateForVendor(
      {
        integrationId: ctx.integrationId,
        vendorName: ctx.vendorName,
        mode: ctx.mode,
        markupBps: ctx.markupBps,
        currency: ctx.currency,
        pricing,
        history,
        statedAvailable: stated,
      },
      {
        audience: req.audience,
        requiredCompletes: req.requiredCompletes,
        loiMinutes: req.loiMinutes,
        expectedIr: req.expectedIr ?? 100,
      },
    );
  }

  return {
    id,
    capabilities: CAPABILITIES,
    maxSource: "vendor_reported",

    async authenticate() {
      // there is nothing to authenticate against: the relationship is a contract and an e-mail address
      return { ok: true, message: "Manual integration — no credentials to verify" };
    },

    feasibility: (ctx, req) => estimate(ctx, req),

    quote: (ctx, req: QuotationRequest) => estimate(ctx, req, req.recruitmentProjectId),

    /**
     * Placing a manual order records the intent and nothing else. It returns no vendor reference, because there
     * is no vendor system that issued one — an operator will paste the vendor's own job number in afterwards,
     * and `recruitment_orders.vendor_order_ref` is where it goes.
     */
    async createOrder(_ctx: AdapterContext, req: OrderRequest): Promise<OrderAck> {
      if (req.completes <= 0) throw new AdapterError("An order must be for at least one complete");
      if (!req.entryUrl) throw new AdapterError("A recruitment order needs the live entry link to give the vendor");
      return {
        vendorOrderRef: null,
        status: "placed",
        message: "Recorded. Send the vendor the entry link and the return links, then enter their job number here.",
      };
    },

    /**
     * Progress for a manual order is whatever an operator last entered. There is no polling and this adapter
     * will not invent a status: with nothing recorded it says so, rather than returning zeros that a dashboard
     * would render as "0 delivered" beside a vendor that has in fact delivered 400.
     */
    async orderStatus(_ctx, vendorOrderRef): Promise<OrderProgress> {
      if (!source.orderProgress) throw new AdapterError("This manual integration records no progress");
      const p = await source.orderProgress(vendorOrderRef);
      if (!p) throw new AdapterError("No progress has been entered for this order yet");
      return p;
    },

    async cancelOrder() {
      return { cancelled: true, message: "Marked cancelled here — cancel it with the vendor directly as well" };
    },

    async reconcile(_ctx, vendorOrderRef): Promise<ReconciliationLine[]> {
      if (!source.reconciliation) return [];
      return source.reconciliation(vendorOrderRef);
    },
  };
}

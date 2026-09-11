import type { BillingConfig } from "./config.js";
import { money6 } from "./money.js";

/**
 * THE PRICING ENGINE.
 *
 * Turns what an operation actually cost into what the customer is charged,
 * and keeps every component apart so the books can answer, per event:
 *
 *   providerCost      what the AI / translation / storage vendor billed us
 *   infraCost         the platform's own compute, database, bandwidth share
 *   actualCost        providerCost + infraCost — the true cost of the work
 *   apiMarkup         the configured uplift on providerCost
 *   infraMarkup       the configured uplift on infraCost
 *   paymentFee        the processor's share of the charge (pct + spread fixed fee)
 *   taxReserve        the share set aside for tax / refunds / chargebacks
 *   customerCharge    what leaves the wallet
 *   grossProfit       customerCharge − actualCost
 *   netProfit         grossProfit − paymentFee − taxReserve  (the platform's margin)
 *   marginPct         netProfit / customerCharge
 *   grossMarginPct    grossProfit / customerCharge
 *
 * "Actual cost" is NEVER what is deducted. Raw cost $10 at a 50% target
 * margin, 6.5% + $0.30/100 processor fee and 0% reserve prices at
 * 10 / (1 − 0.5 − 0.068) = $23.15 — of which $10 is cost, $1.57 the processor,
 * $11.57 the platform. The 50% is a share of the charge, as the business
 * model states it, not "cost plus 50%".
 */

export interface CostInputs {
  /** what the external provider charged for this operation */
  providerCost: number;
  /** the platform's infrastructure allocation for it (estimated until metered) */
  infraCost?: number;
}

export interface ChargeBreakdown {
  providerCost: number;
  infraCost: number;
  actualCost: number;
  apiMarkup: number;
  infraMarkup: number;
  paymentFee: number;
  taxReserve: number;
  customerCharge: number;
  grossProfit: number;
  netProfit: number;
  marginPct: number;
  grossMarginPct: number;
  /** the minimum-charge floor lifted the price */
  minimumApplied: boolean;
  /** a fixed customer rate from the registry was used instead of the model */
  fixedRate: boolean;
  /** TEST usage policy applied: free or discounted */
  testAdjustment: "none" | "free" | "discounted";
}

export interface PriceOptions {
  /** a fixed customer price for the whole operation (registry `customerRate` × quantity) — bypasses the model */
  fixedCustomerCharge?: number | null;
  /** TEST or LIVE — TEST follows the configured policy */
  environment?: "TEST" | "LIVE";
  /** skip the minimum-charge floor (cached / free results must stay at zero) */
  noMinimum?: boolean;
}

/** Effective processor share of a charge: percentage plus the fixed fee spread over a typical payment. */
export function effectivePaymentFeeRate(cfg: BillingConfig): number {
  const fixedShare = cfg.assumedPaymentAmount > 0 ? cfg.paymentProcessorFixedFee / cfg.assumedPaymentAmount : 0;
  return cfg.paymentProcessorFeePct / 100 + fixedShare;
}

/** The charge for one operation from its costs, under this configuration. */
export function priceOperation(costs: CostInputs, cfg: BillingConfig, opts: PriceOptions = {}): ChargeBreakdown {
  const providerCost = money6(Math.max(0, costs.providerCost || 0));
  const infraCost = money6(Math.max(0, costs.infraCost || 0));
  const actualCost = money6(providerCost + infraCost);
  const apiMarkup = money6(providerCost * (cfg.thirdPartyApiMarkupPct / 100));
  const infraMarkup = money6(infraCost * (cfg.infrastructureMarkupPct / 100));
  const base = actualCost + apiMarkup + infraMarkup;

  const feeRate = effectivePaymentFeeRate(cfg);
  const taxRate = cfg.taxReservePct / 100;
  const margin = cfg.targetMarginPct / 100;

  let charge: number;
  let fixedRate = false;
  if (opts.fixedCustomerCharge != null && Number.isFinite(opts.fixedCustomerCharge)) {
    charge = Math.max(0, opts.fixedCustomerCharge);
    fixedRate = true;
  } else if (base <= 0) {
    charge = 0;
  } else if (cfg.pricingModel === "markup") {
    // margin on top of cost, then grossed up so the fee and reserve do not eat it
    const denom = Math.max(0.05, 1 - feeRate - taxRate);
    charge = (base * (1 + margin)) / denom;
  } else {
    // target margin as a share of the charge after every cost
    const denom = Math.max(0.05, 1 - margin - feeRate - taxRate);
    charge = base / denom;
  }

  let minimumApplied = false;
  if (!opts.noMinimum && !fixedRate && base > 0 && cfg.minimumChargePerOperation > 0 && charge < cfg.minimumChargePerOperation) {
    charge = cfg.minimumChargePerOperation;
    minimumApplied = true;
  }

  let testAdjustment: ChargeBreakdown["testAdjustment"] = "none";
  if (opts.environment === "TEST") {
    if (cfg.testUsagePolicy === "free") { charge = 0; testAdjustment = "free"; }
    else if (cfg.testUsagePolicy === "discounted") { charge = charge * (1 - cfg.testUsageDiscountPct / 100); testAdjustment = "discounted"; }
  }

  charge = money6(charge);
  const paymentFee = money6(charge * feeRate);
  const taxReserve = money6(charge * taxRate);
  const grossProfit = money6(charge - actualCost);
  const netProfit = money6(grossProfit - paymentFee - taxReserve);
  return {
    providerCost, infraCost, actualCost, apiMarkup, infraMarkup, paymentFee, taxReserve,
    customerCharge: charge, grossProfit, netProfit,
    marginPct: charge > 0 ? Math.round((netProfit / charge) * 10000) / 100 : 0,
    grossMarginPct: charge > 0 ? Math.round((grossProfit / charge) * 10000) / 100 : 0,
    minimumApplied, fixedRate, testAdjustment,
  };
}

/** What a deposit of `amount` is expected to yield, under this configuration — for the admin screen's worked example. */
export function depositProjection(amount: number, cfg: BillingConfig): { deposit: number; paymentFee: number; taxReserve: number; platformMargin: number; availableForCosts: number } {
  const fee = money6(amount * (cfg.paymentProcessorFeePct / 100) + cfg.paymentProcessorFixedFee);
  const tax = money6(amount * (cfg.taxReservePct / 100));
  const marginAmt = money6(amount * (cfg.targetMarginPct / 100));
  return { deposit: amount, paymentFee: fee, taxReserve: tax, platformMargin: marginAmt, availableForCosts: money6(amount - fee - tax - marginAmt) };
}

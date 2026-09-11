import { z } from "zod";

/**
 * BILLING CONFIGURATION — every number the pricing engine uses, and none of
 * them hard-coded anywhere else.
 *
 * The business model the platform runs on is "of what a researcher pays,
 * roughly half stays with the platform and the rest covers what the work
 * actually cost" — but the half is a SETTING, as is everything around it:
 * what the payment processor takes, what is set aside for tax, how much the
 * infrastructure estimate is marked up, the smallest amount one operation
 * may be charged, and the balances at which a project is warned, warned
 * loudly, and finally made read-only.
 *
 * Stored as one jsonb row (`billing_config`, id = 1); read through
 * `billingConfig(partial)` so a row that predates a field inherits the new
 * default rather than pinning an old one.
 */

export const TEST_USAGE_POLICIES = ["free", "discounted", "metered"] as const;
export type TestUsagePolicy = (typeof TEST_USAGE_POLICIES)[number];

export const PRICING_MODELS = ["target_margin", "markup"] as const;
export type PricingModel = (typeof PRICING_MODELS)[number];

const pct = (def: number) => z.number().min(0).max(100).default(def);
const money = (def: number) => z.number().min(0).default(def);

export const BillingConfig = z.object({
  currency: z.string().min(3).max(3).default("USD"),

  /*
   * HOW A CUSTOMER CHARGE IS DERIVED FROM AN ACTUAL COST.
   *
   * target_margin — the charge is set so that, after the provider cost, the
   *   infrastructure allocation, the payment fee and the tax/reserve are all
   *   taken out of it, `targetMarginPct` of the charge remains as platform
   *   profit. This is what "50% of the deposit stays with the platform" means
   *   in arithmetic:  charge = costs / (1 − margin − fee − tax).
   * markup — the plain alternative: charge = costs × (1 + margin), then
   *   grossed up so the fee and tax do not eat the margin.
   */
  pricingModel: z.enum(PRICING_MODELS).default("target_margin"),
  targetMarginPct: pct(50),

  /* the payment processor: a percentage of every payment plus a fixed amount per payment */
  paymentProcessorFeePct: pct(6.5),
  paymentProcessorFixedFee: money(0.30),
  /* the fixed fee is spread over a typical payment of this size so per-operation prices can carry their share of it */
  assumedPaymentAmount: z.number().min(1).default(100),

  /* set aside from every charge for tax, chargebacks, refunds, bad debt */
  taxReservePct: pct(0),

  /* markups on the two cost families before the margin is applied */
  infrastructureMarkupPct: pct(0),
  thirdPartyApiMarkupPct: pct(0),

  /* the smallest amount one billable operation may be charged (0 = no floor) */
  minimumChargePerOperation: money(0.001),

  /* balances — in wallet currency */
  minimumRemainingBalance: money(0),   // an operation may not take the balance below this
  lowBalanceThreshold: money(20),
  criticalBalanceThreshold: money(5),
  readOnlyThreshold: money(0),         // at or below this the project is READ_ONLY

  /* overdraft — off by default; when on, the balance may go negative down to −overdraftLimit */
  overdraftEnabled: z.boolean().default(false),
  overdraftLimit: money(0),

  /* TEST usage: free, discounted, or metered like LIVE */
  testUsagePolicy: z.enum(TEST_USAGE_POLICIES).default("free"),
  testUsageDiscountPct: pct(50),

  /* what a read-only project may still do */
  allowExportsWhenReadOnly: z.boolean().default(true),
  /* whether a project at its limit also stops taking new LIVE interviews */
  lockRespondentsWhenReadOnly: z.boolean().default(true),

  /* an estimate used until infrastructure is metered from the providers' own usage data */
  estimatedInfrastructureCostPerResponse: money(0.002),
  estimatedInfrastructureCostPerAiRequest: money(0.0002),
  estimatedInfrastructureCostPerTranslationRequest: money(0.0001),

  /* how long a reservation may be held before it is treated as abandoned and released */
  reservationTtlMinutes: z.number().int().min(1).default(30),

  /* forecast window, in days */
  forecastWindowDays: z.number().int().min(1).max(90).default(7),
});
export type BillingConfig = z.infer<typeof BillingConfig>;

/** A full configuration from a stored (possibly partial, possibly old) document. */
export function billingConfig(partial?: unknown): BillingConfig {
  const r = BillingConfig.safeParse(partial && typeof partial === "object" ? partial : {});
  return r.success ? r.data : BillingConfig.parse({});
}

export const DEFAULT_BILLING_CONFIG: BillingConfig = BillingConfig.parse({});

/** One line per field for the administration screen: label, unit, and what it does. */
export const BILLING_CONFIG_FIELDS: { key: keyof BillingConfig; label: string; kind: "pct" | "money" | "number" | "bool" | "enum"; group: string; help: string; options?: readonly string[] }[] = [
  { key: "pricingModel", label: "Pricing model", kind: "enum", group: "Pricing", options: PRICING_MODELS, help: "target_margin keeps the margin as a share of the charge after every cost; markup adds the margin on top of cost." },
  { key: "targetMarginPct", label: "Target platform margin", kind: "pct", group: "Pricing", help: "Share of every customer charge that remains with the platform after provider, infrastructure, payment and tax/reserve costs." },
  { key: "thirdPartyApiMarkupPct", label: "Third-party API markup", kind: "pct", group: "Pricing", help: "Added to the actual AI / translation / other provider cost before the margin is applied." },
  { key: "infrastructureMarkupPct", label: "Infrastructure markup", kind: "pct", group: "Pricing", help: "Added to the infrastructure allocation before the margin is applied." },
  { key: "minimumChargePerOperation", label: "Minimum charge per operation", kind: "money", group: "Pricing", help: "A billable operation is never charged less than this (0 disables the floor)." },
  { key: "paymentProcessorFeePct", label: "Payment processor fee", kind: "pct", group: "Payments & reserves", help: "What the processor takes from every payment, as a percentage." },
  { key: "paymentProcessorFixedFee", label: "Payment processor fixed fee", kind: "money", group: "Payments & reserves", help: "What the processor takes from every payment as a fixed amount." },
  { key: "assumedPaymentAmount", label: "Typical payment amount", kind: "money", group: "Payments & reserves", help: "The fixed fee is spread over a payment of this size when pricing a single operation." },
  { key: "taxReservePct", label: "Tax / reserve", kind: "pct", group: "Payments & reserves", help: "Set aside from every charge for tax, refunds and chargebacks." },
  { key: "lowBalanceThreshold", label: "Low balance warning at", kind: "money", group: "Balances", help: "At or below this remaining balance the project shows a low-balance warning." },
  { key: "criticalBalanceThreshold", label: "Critical balance at", kind: "money", group: "Balances", help: "At or below this the warning becomes critical." },
  { key: "readOnlyThreshold", label: "Read-only at", kind: "money", group: "Balances", help: "At or below this the project becomes read-only: nothing billable runs until credits are added." },
  { key: "minimumRemainingBalance", label: "Minimum remaining balance", kind: "money", group: "Balances", help: "An operation is refused if it would take the balance below this." },
  { key: "overdraftEnabled", label: "Allow overdraft", kind: "bool", group: "Balances", help: "Off: the balance can never go negative. On: it may go down to minus the overdraft limit." },
  { key: "overdraftLimit", label: "Overdraft limit", kind: "money", group: "Balances", help: "How far below zero a wallet may go when overdraft is allowed." },
  { key: "lockRespondentsWhenReadOnly", label: "Stop new LIVE interviews when read-only", kind: "bool", group: "Balances", help: "Off: fieldwork continues at the project's own cost while the Studio is read-only." },
  { key: "allowExportsWhenReadOnly", label: "Allow exports when read-only", kind: "bool", group: "Balances", help: "Whether existing data may still be downloaded from a read-only project." },
  { key: "testUsagePolicy", label: "TEST usage", kind: "enum", group: "Test vs live", options: TEST_USAGE_POLICIES, help: "free: test interviews and test activity cost nothing; discounted: charged at a discount; metered: charged like LIVE." },
  { key: "testUsageDiscountPct", label: "TEST discount", kind: "pct", group: "Test vs live", help: "Applied when TEST usage is 'discounted'." },
  { key: "estimatedInfrastructureCostPerResponse", label: "Estimated infrastructure cost per response", kind: "money", group: "Infrastructure estimates", help: "Used until database, storage, bandwidth and compute are metered from provider usage data." },
  { key: "estimatedInfrastructureCostPerAiRequest", label: "Estimated infrastructure cost per AI request", kind: "money", group: "Infrastructure estimates", help: "Compute and database allocation for one AI call." },
  { key: "estimatedInfrastructureCostPerTranslationRequest", label: "Estimated infrastructure cost per translation request", kind: "money", group: "Infrastructure estimates", help: "Compute and cache allocation for one translation batch." },
  { key: "reservationTtlMinutes", label: "Reservation time-to-live (minutes)", kind: "number", group: "Metering", help: "A reservation not settled within this time is released back to the wallet." },
  { key: "forecastWindowDays", label: "Forecast window (days)", kind: "number", group: "Metering", help: "Average daily usage is computed over this many recent days." },
];

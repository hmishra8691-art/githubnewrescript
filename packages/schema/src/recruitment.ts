import { z } from "zod";

/**
 * THE RECRUITMENT EXCHANGE (2026-11-03) — the shapes shared by the vendor registry, the feasibility and pricing
 * engine, the allocation optimiser and the Studio's marketplace.
 *
 * Unlike `integrations.ts`, almost none of this lives on a survey definition. A panel's CONFIGURATION (how people
 * arrive, where they are sent back) is a property of the study and is versioned with it; a VENDOR RELATIONSHIP —
 * the rate card, the credentials, the quality history, the money owed — is a property of the organisation and
 * belongs in its own tables (migration 0081). The one exception is `AudienceSpecification`, which is a property of
 * the study and is stored alongside it so that cloning a project clones what it was looking for.
 *
 * NO SECRET IS EVER HERE. Vendor credentials are sealed in `vendor_integrations.credentials_sealed` under the BYOK
 * envelope scheme; nothing in this file has a field they could be put in.
 */

/* ------------------------------------------------------------ the vendor relationship */

/**
 * What an organisation's relationship with a vendor actually is. The marketplace renders this verbatim, because
 * the brief's §5 forbids showing a vendor as integrated when it is not.
 *
 *   api            an adapter talks to the vendor's API (Phase 6; requires credentials)
 *   manual         an operator enters feasibility, prices and orders by hand and reconciles by hand
 *   redirect_only  0072's recruitment redirect works; nothing is ordered through the platform
 *   awaiting       intended, not configured
 *   inactive       switched off, kept for its history
 */
export const VENDOR_MODES = ["api", "manual", "redirect_only", "awaiting", "inactive"] as const;
export const VendorMode = z.enum(VENDOR_MODES);
export type VendorMode = z.infer<typeof VendorMode>;

/** The operations an adapter may implement. An integration claims a subset; see `VendorCapabilitySet`. */
export const VENDOR_CAPABILITIES = [
  "feasibility", "quote", "order", "status", "reconcile", "cancel", "refund", "identity_token", "webhook",
] as const;
export const VendorCapability = z.enum(VENDOR_CAPABILITIES);
export type VendorCapability = z.infer<typeof VendorCapability>;

/**
 * Where a number came from. This travels with every CPI, incidence and feasibility figure the platform shows,
 * because a live quotation and an administrator's guess must never look alike on a screen somebody authorises
 * spend from (the brief's §8, "Never invent a live quotation").
 */
export const PRICING_SOURCES = ["live", "vendor_reported", "historical", "administrator"] as const;
export const PricingSource = z.enum(PRICING_SOURCES);
export type PricingSource = z.infer<typeof PricingSource>;

/** How confident the platform is that this figure still holds. Derived, never stored. */
export const SOURCE_CONFIDENCE: Readonly<Record<PricingSource, number>> = Object.freeze({
  live: 1, vendor_reported: 0.8, historical: 0.6, administrator: 0.4,
});

export const VendorCapabilityState = z.object({
  capability: VendorCapability,
  supported: z.boolean().default(false),
  /** null = DECLARED, not verified against the vendor. Every surface showing a capability shows this difference. */
  verifiedAt: z.string().datetime().nullable().default(null),
  notes: z.string().max(300).optional(),
});
export type VendorCapabilityState = z.infer<typeof VendorCapabilityState>;

export const VendorCapabilitySet = z.array(VendorCapabilityState).max(VENDOR_CAPABILITIES.length);
export type VendorCapabilitySet = z.infer<typeof VendorCapabilitySet>;

/* ------------------------------------------------------------ the audience */

const StringList = z.array(z.string().min(1).max(120)).max(200);

/**
 * The structured audience. Both halves of the brief's §7: `demographics` and `advanced` are the controls a
 * researcher sets directly, `screeners` are the study's own qualifying questions, and `conditions` is the nested
 * AND/OR tree for anything the controls cannot say.
 *
 * Vendors do not share a targeting vocabulary — Cint's age bands are not Dynata's, and a "decision maker" means
 * something different in each. So this is the PLATFORM's vocabulary, and each adapter maps it to its vendor's,
 * declaring in `unmapped` whatever it could not express. An audience that cannot be fully expressed at a vendor
 * is not quietly broadened: the feasibility result says what was dropped and the researcher decides.
 */
export const AudienceDemographics = z.object({
  countries: z.array(z.string().regex(/^[A-Z]{2}$/)).max(60).default([]),
  regions: StringList.default([]),
  cities: StringList.default([]),
  ageMin: z.number().int().min(13).max(120).optional(),
  ageMax: z.number().int().min(13).max(120).optional(),
  genders: z.array(z.enum(["male", "female", "other", "any"])).max(4).default([]),
  incomeBands: StringList.default([]),
  education: StringList.default([]),
  employment: StringList.default([]),
  occupation: StringList.default([]),
  householdSize: z.array(z.number().int().min(1).max(20)).max(20).default([]),
  maritalStatus: StringList.default([]),
  children: z.enum(["any", "with", "without"]).optional(),
}).refine((d) => d.ageMin === undefined || d.ageMax === undefined || d.ageMin <= d.ageMax, {
  message: "ageMin must not be greater than ageMax", path: ["ageMax"],
});
export type AudienceDemographics = z.infer<typeof AudienceDemographics>;

export const AudienceAdvanced = z.object({
  industries: StringList.default([]),
  jobTitles: StringList.default([]),
  seniority: StringList.default([]),
  decisionAuthority: z.enum(["any", "influencer", "decision_maker", "sole_decision_maker"]).optional(),
  companySize: StringList.default([]),
  productOwnership: StringList.default([]),
  brandUsage: StringList.default([]),
  purchaseBehaviour: StringList.default([]),
  technologyUsage: StringList.default([]),
  lifestyle: StringList.default([]),
});
export type AudienceAdvanced = z.infer<typeof AudienceAdvanced>;

/** A qualifying question asked in the survey itself rather than targeted at the vendor. */
export const AudienceScreener = z.object({
  id: z.string().min(1).max(40),
  text: z.string().min(1).max(500),
  qualifyingAnswers: StringList.default([]),
  /** the share of the general population expected to qualify, when it is known */
  expectedIncidence: z.number().min(0).max(100).optional(),
});
export type AudienceScreener = z.infer<typeof AudienceScreener>;

export const AudienceQuotaCell = z.object({
  id: z.string().min(1).max(60),
  label: z.string().max(120),
  /** absolute completes, or a share of the total when `mode` is "percent" */
  target: z.number().min(0),
  mode: z.enum(["count", "percent"]).default("count"),
  criteria: z.record(z.string(), z.unknown()).default({}),
});
export type AudienceQuotaCell = z.infer<typeof AudienceQuotaCell>;

export const AudienceSpecification = z.object({
  version: z.number().int().min(1).default(1),
  demographics: AudienceDemographics.default({} as never),
  advanced: AudienceAdvanced.default({} as never),
  screeners: z.array(AudienceScreener).max(50).default([]),
  quotas: z.array(AudienceQuotaCell).max(500).default([]),
  /** nested AND/OR for anything the controls above cannot express; the engine's own condition tree shape */
  conditions: z.unknown().optional(),
  /**
   * What the researcher typed, when the specification was produced from natural language. Kept so the structured
   * form stays reviewable against its source — the brief's "reviewable audience specification".
   */
  naturalLanguage: z.string().max(4000).optional(),
  notes: z.string().max(1000).optional(),
});
export type AudienceSpecification = z.infer<typeof AudienceSpecification>;

/* ------------------------------------------------------------ feasibility, pricing, quotations */

export const VendorPricingRow = z.object({
  id: z.string().optional(),
  integrationId: z.string(),
  market: z.string().regex(/^[A-Z]{2}$/),
  /** half-open bands: [irMin, irMax), [loiMin, loiMax) */
  irMin: z.number().min(0).max(100).default(0),
  irMax: z.number().min(0).max(100).default(100),
  loiMin: z.number().int().min(0).default(0),
  loiMax: z.number().int().min(1).default(120),
  cpi: z.number().min(0),
  currency: z.string().regex(/^[A-Z]{3}$/).default("USD"),
  source: PricingSource,
  sourceNote: z.string().max(300).optional(),
  validFrom: z.string().datetime().optional(),
  validTo: z.string().datetime().nullable().optional(),
});
export type VendorPricingRow = z.infer<typeof VendorPricingRow>;

/**
 * One vendor's answer to "can you do this, at what price, how fast". Every field that could be invented carries
 * its `source`; `available` of null means the vendor did not say, which is not the same as zero and must not be
 * rendered as "0 available".
 */
export const FeasibilityEstimate = z.object({
  integrationId: z.string(),
  vendorName: z.string().max(120),
  mode: VendorMode,
  available: z.number().int().min(0).nullable().default(null),
  expectedIr: z.number().min(0).max(100).nullable().default(null),
  cpi: z.number().min(0).nullable().default(null),
  currency: z.string().regex(/^[A-Z]{3}$/).default("USD"),
  loiMinutes: z.number().int().min(0).nullable().default(null),
  expectedRejectionRate: z.number().min(0).max(100).nullable().default(null),
  expectedDuplicateRate: z.number().min(0).max(100).nullable().default(null),
  deliveryDays: z.number().min(0).nullable().default(null),
  qualityScore: z.number().min(0).max(100).nullable().default(null),
  /** how much history the quality score rests on; low confidence must not be rendered as a firm number */
  qualityConfidence: z.enum(["none", "low", "medium", "high"]).default("none"),
  source: PricingSource,
  /** targeting criteria this vendor could not express, named so the researcher can judge the estimate */
  unmapped: StringList.default([]),
  /** why there is no estimate, when there is none */
  unavailableReason: z.string().max(300).optional(),
});
export type FeasibilityEstimate = z.infer<typeof FeasibilityEstimate>;

/* ------------------------------------------------------------ allocation */

export const ALLOCATION_STRATEGIES = ["lowest_cost", "highest_quality", "fastest_delivery", "balanced", "custom"] as const;
export const AllocationStrategy = z.enum(ALLOCATION_STRATEGIES);
export type AllocationStrategy = z.infer<typeof AllocationStrategy>;

/** Weights over the three objectives; normalised by the optimiser, so they need not sum to 1. */
export const StrategyWeights = z.object({
  cost: z.number().min(0).max(1).default(0),
  quality: z.number().min(0).max(1).default(0),
  speed: z.number().min(0).max(1).default(0),
});
export type StrategyWeights = z.infer<typeof StrategyWeights>;

export const STRATEGY_WEIGHTS: Readonly<Record<Exclude<AllocationStrategy, "custom">, StrategyWeights>> = Object.freeze({
  lowest_cost:      { cost: 1,    quality: 0,    speed: 0 },
  highest_quality:  { cost: 0.1,  quality: 0.8,  speed: 0.1 },
  fastest_delivery: { cost: 0.2,  quality: 0.2,  speed: 0.6 },
  balanced:         { cost: 0.45, quality: 0.35, speed: 0.2 },
});

export const AllocationConstraints = z.object({
  requiredCompletes: z.number().int().min(1),
  budget: z.number().min(0),
  currency: z.string().regex(/^[A-Z]{3}$/).default("USD"),
  deadlineDays: z.number().min(0).optional(),
  /** a vendor below this quality score is not allocated to at all */
  qualityFloor: z.number().min(0).max(100).optional(),
  /** no single vendor takes more than this share, however good it looks — concentration is its own risk */
  maxVendorShare: z.number().min(0).max(1).default(1),
  /** vendors to leave out of this allocation entirely */
  excludeIntegrationIds: z.array(z.string()).max(100).default([]),
});
export type AllocationConstraints = z.infer<typeof AllocationConstraints>;

export const AllocationRow = z.object({
  integrationId: z.string(),
  /** the country this row buys in (0082). "--" for a project that declared no markets. */
  market: z.string().regex(/^([A-Z]{2}|--)$/).default("--"),
  vendorName: z.string().max(120),
  completes: z.number().int().min(0),
  cpi: z.number().min(0),
  currency: z.string().regex(/^[A-Z]{3}$/).default("USD"),
  cost: z.number().min(0),
  expectedValidCompletes: z.number().int().min(0),
  /** the objective: cost per VALID ACCEPTED complete, not the quoted CPI (the brief's §25) */
  costPerValidComplete: z.number().min(0),
  expectedDeliveryDays: z.number().min(0).nullable().default(null),
  source: PricingSource,
  rationale: z.record(z.string(), z.unknown()).default({}),
});
export type AllocationRow = z.infer<typeof AllocationRow>;

/** One market's result, so a multi-country plan can be read market by market rather than as one blended blur. */
export const AllocationMarketResult = z.object({
  market: z.string().regex(/^([A-Z]{2}|--)$/),
  required: z.number().int().min(0),
  allocated: z.number().int().min(0),
  shortfall: z.number().int().min(0),
  cost: z.number().min(0),
  blendedCpi: z.number().min(0),
  expectedValidCompletes: z.number().int().min(0),
  expectedDeliveryDays: z.number().min(0).nullable().default(null),
  /** vendors left out of this market, and why — a researcher is owed the reason, not a shorter list */
  excluded: z.array(z.object({ integrationId: z.string(), vendorName: z.string(), reason: z.string().max(300) })).default([]),
});
export type AllocationMarketResult = z.infer<typeof AllocationMarketResult>;

export const AllocationPlan = z.object({
  strategy: AllocationStrategy,
  weights: StrategyWeights,
  rows: z.array(AllocationRow).max(100),
  markets: z.array(AllocationMarketResult).default([]),
  /**
   * The cost pressure the solver had to apply to fit the budget. 0 means the budget never bound and the plan is
   * the straightforward best under the chosen strategy; above 0 means cheaper vendors were preferred over better
   * ones to stay inside the ceiling, which is a thing the researcher should be told rather than discover.
   */
  costPressure: z.number().min(0).default(0),
  totalCompletes: z.number().int().min(0),
  totalCost: z.number().min(0),
  blendedCpi: z.number().min(0),
  expectedValidCompletes: z.number().int().min(0),
  expectedDeliveryDays: z.number().min(0).nullable().default(null),
  /** true when the constraints could not all be met; `shortfall` and `notes` say how */
  feasible: z.boolean(),
  shortfall: z.number().int().min(0).default(0),
  notes: z.array(z.string().max(300)).max(20).default([]),
});
export type AllocationPlan = z.infer<typeof AllocationPlan>;

/* ------------------------------------------------------------ orders and project state */

export const RECRUITMENT_PROJECT_STATUSES = [
  "draft", "feasibility", "quoted", "allocated", "authorized", "fielding", "paused", "complete", "cancelled",
] as const;
export const RecruitmentProjectStatus = z.enum(RECRUITMENT_PROJECT_STATUSES);
export type RecruitmentProjectStatus = z.infer<typeof RecruitmentProjectStatus>;

export const RECRUITMENT_ORDER_STATUSES = [
  "draft", "placed", "live", "paused", "cancelled", "complete", "failed",
] as const;
export const RecruitmentOrderStatus = z.enum(RECRUITMENT_ORDER_STATUSES);
export type RecruitmentOrderStatus = z.infer<typeof RecruitmentOrderStatus>;

/**
 * The orchestrator's state machine. Deterministic by design: the brief says AI may recommend and optimise but may
 * not bypass business rules, so every transition a project can make is in this table and nothing else is legal.
 */
export const PROJECT_TRANSITIONS: Readonly<Record<RecruitmentProjectStatus, readonly RecruitmentProjectStatus[]>> = Object.freeze({
  draft:       ["feasibility", "cancelled"],
  feasibility: ["quoted", "draft", "cancelled"],
  quoted:      ["allocated", "feasibility", "cancelled"],
  allocated:   ["authorized", "quoted", "cancelled"],
  authorized:  ["fielding", "cancelled"],
  fielding:    ["paused", "complete", "cancelled"],
  paused:      ["fielding", "cancelled"],
  complete:    [],
  cancelled:   [],
});

export function canTransition(from: RecruitmentProjectStatus, to: RecruitmentProjectStatus): boolean {
  return PROJECT_TRANSITIONS[from].includes(to);
}

/** The events the orchestrator writes. Names are the brief's §32, so a reader of that document finds them here. */
export const RECRUITMENT_EVENT_TYPES = [
  "RecruitmentRequested", "VendorFeasibilityReceived", "VendorQuotationReceived", "AllocationProposed",
  "AllocationApproved", "RecruitmentOrderCreated", "RecruitmentProgressApplied", "VendorAllocationUpdated",
  "BudgetThresholdReached", "RecruitmentReconciled", "RecruitmentCancelled",
] as const;
export const RecruitmentEventType = z.enum(RECRUITMENT_EVENT_TYPES);
export type RecruitmentEventType = z.infer<typeof RecruitmentEventType>;

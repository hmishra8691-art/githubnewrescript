import { z } from "zod";

/**
 * THE COMMERCIAL MODEL (2026-11-11) — plans, progressive response pricing, the AI wallet's rules, tax and the invoice.
 *
 * THREE INDEPENDENT BILLING CATEGORIES, each with its own arithmetic and its own lines, never one combined usage sum:
 *
 *   subscription   a fixed monthly fee per plan (Student & Academic, Professional per user, Team with included users;
 *                  Enterprise is negotiated and has no catalogue price)
 *   responses      PROGRESSIVE slabs on billable production responses: each rate applies only to the responses inside
 *                  its own slab. Never the highest slab's rate on everything.
 *   ai             a prepaid wallet: a minimum recharge, each recharge valid for its own N months, consumed oldest
 *                  first; expired recharges cannot be spent. What an operation costs is metering's job (pricing.ts —
 *                  provider cost → customer charge at the configured margin); this module owns the wallet's RULES.
 *   + tax          a configurable table by billing country: the tax's name, its rate, and which categories it applies
 *                  to. NO RATE IS BUILT IN — a country that is not configured is reported as such and taxed at
 *                  nothing, never guessed. Exemptions (a valid registration under reverse charge, an exempt customer)
 *                  are part of the customer's tax profile.
 *
 * Everything is PURE and CONFIGURABLE: the catalogue is one document (`CommercialCatalog`), stored and edited by an
 * administrator, with the approved prices as its defaults. Nothing here takes a payment, changes an existing
 * subscription or rewrites a past transaction: an invoice is computed from what it is given.
 *
 * MONEY: amounts are computed in integer minor units (cents) and rounded once per line, half away from zero; a total
 * is the sum of its rounded lines, so a checkout total, the invoice and the ledger can never differ by a cent.
 */

/* ------------------------------------------------------------ money */

/** cents from a decimal amount, rounded half away from zero */
export const toCents = (amount: number): number => { const x = Math.abs(amount) * 100; const r = Math.round(x + 1e-9); return amount < 0 ? -r : r; };
export const fromCents = (cents: number): number => Math.round(cents) / 100;

/* ------------------------------------------------------------ the catalogue */

export const PLAN_IDS = ["academic", "professional", "team", "enterprise"] as const;
export type PlanId = (typeof PLAN_IDS)[number];
export const BILLING_CATEGORIES = ["subscription", "responses", "ai"] as const;
export type BillingCategory = (typeof BILLING_CATEGORIES)[number];

const Plan = z.object({
  id: z.enum(PLAN_IDS),
  name: z.string(),
  /** null = negotiated (Enterprise): no catalogue price, never auto-billed at standard terms */
  monthly: z.number().min(0).nullable(),
  /** per_user: the price is for each user; flat: the price covers `includedUsers` */
  pricing: z.enum(["per_user", "flat"]),
  includedUsers: z.number().int().min(1).nullable(),
  /** price of each user beyond the included ones, per month; null = by agreement (not sold from the catalogue) */
  additionalUserMonthly: z.number().min(0).nullable(),
});
export type Plan = z.infer<typeof Plan>;

const Slab = z.object({ upTo: z.number().int().positive().nullable(), each: z.number().min(0) });
export type ResponseSlab = z.infer<typeof Slab>;

const TaxRule = z.object({
  /** ISO 3166-1 alpha-2, upper case */
  country: z.string().length(2),
  /** what the tax is called on the invoice: VAT, GST, Sales tax … */
  name: z.string().min(1),
  ratePct: z.number().min(0).max(100),
  /** which categories it applies to (a wallet recharge is the taxable event for `ai`) */
  appliesTo: z.array(z.enum(BILLING_CATEGORIES)).default([...BILLING_CATEGORIES]),
  /** a business customer with a valid registration is not charged (the customer accounts for it): reverse charge */
  reverseChargeForBusiness: z.boolean().default(false),
});
export type TaxRule = z.infer<typeof TaxRule>;

export const CommercialCatalog = z.object({
  currency: z.string().length(3).default("USD"),
  plans: z.array(Plan).default([
    { id: "academic", name: "Student & Academic", monthly: 39, pricing: "flat", includedUsers: 1, additionalUserMonthly: null },
    { id: "professional", name: "Professional", monthly: 99, pricing: "per_user", includedUsers: 1, additionalUserMonthly: null },
    { id: "team", name: "Team", monthly: 399, pricing: "flat", includedUsers: 5, additionalUserMonthly: null },
    { id: "enterprise", name: "Enterprise", monthly: null, pricing: "flat", includedUsers: null, additionalUserMonthly: null },
  ]),
  /** ascending; the last slab's `upTo` is null (no upper bound) */
  responseSlabs: z.array(Slab).default([{ upTo: 10_000, each: 0.03 }, { upTo: 50_000, each: 0.025 }, { upTo: 250_000, each: 0.02 }, { upTo: null, each: 0.0125 }]),
  /** warn when this share of a slab's width remains before the next threshold */
  slabAlertPct: z.number().min(0).max(100).default(10),
  wallet: z.object({
    minimumRecharge: z.number().min(0).default(50),
    validityMonths: z.number().int().min(1).default(12),
    /** alert when the available balance falls to these shares of what was recharged and is still valid */
    alertPcts: z.array(z.number().min(0).max(100)).default([50, 25]),
    /** "nearly exhausted": at or below this amount */
    nearlyExhaustedBelow: z.number().min(0).default(5),
    /** alert this many days before a recharge expires */
    expiryAlertDays: z.number().int().min(0).default(30),
    /** never true by default: a wallet is recharged only on the customer's explicit authorisation */
    autoRecharge: z.literal(false).default(false),
  }).default({}),
  /** target GROSS MARGIN on AI model usage (a share of the selling price, not a markup on cost) */
  aiTargetMarginPct: z.number().min(0).max(95).default(55),
  /** a model's own margin target, by model id — overrides the default for that model */
  aiModelMarginPct: z.record(z.number().min(0).max(95)).default({}),
  /**
   * SERVICE-LEVEL PRICES: a service priced per unit (a minute of audio, 1,000 words, a document) instead of by its
   * model consumption. When a service has a price here, THAT is the customer's whole charge for the operation — the
   * model usage behind it is not charged again. No price is built in: an administrator sets them.
   */
  aiServices: z.array(z.object({ id: z.string().min(1), name: z.string().min(1), unit: z.string().min(1), price: z.number().min(0) })).default([]),
  /** NO DEFAULT RATES: configured per country by an administrator or a tax integration */
  taxRules: z.array(TaxRule).default([]),
  /** renewal alert, days before the subscription renews */
  renewalAlertDays: z.number().int().min(0).default(7),
});
export type CommercialCatalog = z.infer<typeof CommercialCatalog>;
export const DEFAULT_CATALOG: CommercialCatalog = CommercialCatalog.parse({});

/** a full catalogue from a stored (partial, older) document; an invalid slab ladder is refused with the reason */
export function commercialCatalog(partial?: unknown): CommercialCatalog {
  const r = CommercialCatalog.safeParse(partial && typeof partial === "object" ? partial : {});
  const c = r.success ? r.data : DEFAULT_CATALOG;
  const problem = slabProblem(c.responseSlabs);
  return problem ? { ...c, responseSlabs: DEFAULT_CATALOG.responseSlabs } : c;
}

export function slabProblem(slabs: readonly ResponseSlab[]): string | null {
  if (!slabs.length) return "at least one response slab is needed";
  for (let i = 0; i < slabs.length; i++) {
    const last = i === slabs.length - 1;
    if (last && slabs[i].upTo !== null) return "the last slab has no upper bound";
    if (!last && slabs[i].upTo === null) return "only the last slab may be unbounded";
    if (i > 0 && !last && (slabs[i].upTo as number) <= (slabs[i - 1].upTo as number)) return "slab bounds must increase";
  }
  return null;
}

/* ------------------------------------------------------------ A. subscription */

export interface SubscriptionCharge { planId: PlanId; planName: string; users: number; includedUsers: number | null; additionalUsers: number; baseCents: number; additionalCents: number; totalCents: number; description: string }

/**
 * A month of a plan. Enterprise, or a plan the customer has agreed terms for, is charged ONLY what the agreement says
 * (`negotiatedMonthly`); without one, Enterprise has no price and is refused rather than billed at a standard rate.
 */
export function subscriptionCharge(catalog: CommercialCatalog, input: { planId: PlanId; users?: number; negotiatedMonthly?: number | null }): SubscriptionCharge | { error: string } {
  const plan = catalog.plans.find((p) => p.id === input.planId);
  if (!plan) return { error: `there is no plan “${input.planId}”` };
  const users = Math.max(1, Math.floor(input.users ?? plan.includedUsers ?? 1));
  if (input.negotiatedMonthly != null) {
    const c = toCents(input.negotiatedMonthly);
    return { planId: plan.id, planName: plan.name, users, includedUsers: plan.includedUsers, additionalUsers: 0, baseCents: c, additionalCents: 0, totalCents: c, description: `${plan.name} subscription (agreed terms)` };
  }
  if (plan.monthly === null) return { error: `${plan.name} is priced by agreement — record the agreed monthly fee before billing it` };
  if (plan.pricing === "per_user") {
    const c = toCents(plan.monthly) * users;
    return { planId: plan.id, planName: plan.name, users, includedUsers: 1, additionalUsers: 0, baseCents: c, additionalCents: 0, totalCents: c, description: `${plan.name} subscription${users > 1 ? ` × ${users} users` : ""}` };
  }
  const included = plan.includedUsers ?? 1, extra = Math.max(0, users - included);
  if (extra > 0 && plan.additionalUserMonthly === null) return { error: `${plan.name} includes ${included} user${included === 1 ? "" : "s"}; additional users are by agreement — set the additional-user price before billing ${extra} more` };
  const base = toCents(plan.monthly), add = extra * toCents(plan.additionalUserMonthly ?? 0);
  return { planId: plan.id, planName: plan.name, users, includedUsers: included, additionalUsers: extra, baseCents: base, additionalCents: add, totalCents: base + add, description: `${plan.name} subscription${plan.includedUsers && plan.includedUsers > 1 ? ` (${included} users included)` : ""}${extra ? ` + ${extra} additional user${extra === 1 ? "" : "s"}` : ""}` };
}

/* ------------------------------------------------------------ B. progressive production responses */

export interface SlabLine { index: number; from: number; to: number | null; each: number; responses: number; cents: number; label: string }
export interface ResponseCharge { responses: number; lines: SlabLine[]; totalCents: number; /** the slab the NEXT response falls in */ currentSlab: number; currentRate: number; nextThreshold: number | null; toNextThreshold: number | null; approachingNext: boolean }

const n0 = (x: number) => x.toLocaleString("en-US");
/** a per-response rate as written: 0.03, 0.025, 0.0125 — at least two decimals, never rounded away */
export const rate = (x: number): string => { const t = x.toFixed(4).replace(/0+$/, ""); const [i, d = ""] = t.split("."); return `${i}.${d.padEnd(2, "0")}`; };

/**
 * The charge for responses number `alreadyBilled + 1` … `alreadyBilled + responses` in the cumulative count: each slab's
 * rate applies only to the responses that fall inside that slab. `alreadyBilled` makes billing incremental — charging a
 * period's responses on top of what was billed before gives the same total as charging them all at once.
 */
export function responseCharge(catalog: CommercialCatalog, responses: number, alreadyBilled = 0, slabs: readonly ResponseSlab[] = catalog.responseSlabs): ResponseCharge {
  const count = Math.max(0, Math.floor(responses)), start = Math.max(0, Math.floor(alreadyBilled)), end = start + count;
  const lines: SlabLine[] = [];
  let from = 0;
  /* a rate can be finer than a cent ($0.0125): each slab's charge is the difference of its CUMULATIVE amount, rounded,
     at the end and at the start — so billing in parts always adds up to billing at once, to the cent */
  const cum = (upto: number, lo: number, each: number) => Math.round(Math.max(0, upto - lo) * each * 100 + 1e-6);
  slabs.forEach((s, index) => {
    const to = s.upTo;
    const lo = Math.max(start, from), hi = Math.min(end, to ?? Infinity);
    const inSlab = Math.max(0, hi - lo);
    if (inSlab > 0) lines.push({ index, from: from + 1, to, each: s.each, responses: inSlab, cents: cum(hi, from, s.each) - cum(lo, from, s.each), label: index === 0 ? `First ${n0(to ?? inSlab)}` : to === null ? `Above ${n0(from)}` : `${n0(from + 1)}–${n0(to)}` });
    from = to ?? from;
  });
  let bound = 0, currentSlab = slabs.length - 1;
  for (let i = 0; i < slabs.length; i++) { const to = slabs[i].upTo; if (to === null || end < to) { currentSlab = i; break; } bound = to; }
  void bound;
  const nextThreshold = slabs[currentSlab].upTo;
  const prevBound = currentSlab === 0 ? 0 : (slabs[currentSlab - 1].upTo as number);
  const toNext = nextThreshold === null ? null : nextThreshold - end;
  const approaching = toNext !== null && toNext <= ((nextThreshold as number) - prevBound) * (catalog.slabAlertPct / 100);
  return { responses: count, lines, totalCents: lines.reduce((t, l) => t + l.cents, 0), currentSlab, currentRate: slabs[currentSlab].each, nextThreshold, toNextThreshold: toNext, approachingNext: approaching };
}

/** what a response record is, for billing: only a completed LIVE interview is billable, once */
export type ResponseBillingStatus = "billable" | "test" | "partial" | "screened_out" | "quota_full" | "terminated" | "duplicate";
export interface ResponseRecord { id: string; projectId: string; environment: "LIVE" | "TEST"; status: string; /** the same interview submitted again, or a retry of the same completion */ respondentKey?: string | null }
export interface ResponseUsage { billable: ResponseRecord[]; notBilled: { record: ResponseRecord; reason: ResponseBillingStatus }[]; byProject: Record<string, number> }

/**
 * Sort records into billable and not, with the reason. A record is billable when it is a completed interview in the
 * LIVE environment and its id (and, where known, its respondent in that project) has not been seen: a duplicate
 * submission or a retry is counted once.
 */
export function classifyResponses(records: readonly ResponseRecord[], alreadyBilledIds: ReadonlySet<string> = new Set()): ResponseUsage {
  const out: ResponseUsage = { billable: [], notBilled: [], byProject: {} };
  const seen = new Set<string>(alreadyBilledIds), seenRespondent = new Set<string>();
  for (const r of records) {
    const status = String(r.status).toLowerCase();
    const reason: ResponseBillingStatus | null =
      r.environment !== "LIVE" ? "test"
        : status === "complete" || status === "completed" ? null
          : /screen/.test(status) ? "screened_out" : /quota/.test(status) ? "quota_full" : /terminat|disqual/.test(status) ? "terminated" : "partial";
    if (reason) { out.notBilled.push({ record: r, reason }); continue; }
    const rk = r.respondentKey ? `${r.projectId}\u0000${r.respondentKey}` : null;
    if (seen.has(r.id) || (rk && seenRespondent.has(rk))) { out.notBilled.push({ record: r, reason: "duplicate" }); continue; }
    seen.add(r.id); if (rk) seenRespondent.add(rk);
    out.billable.push(r);
    out.byProject[r.projectId] = (out.byProject[r.projectId] ?? 0) + 1;
  }
  return out;
}

/* ------------------------------------------------------------ C. the AI wallet's rules */

export interface Recharge { id: string; amountCents: number; at: string; expiresAt: string; remainingCents: number }
export interface AiWalletState { recharges: Recharge[] }
export interface AiWalletView { availableCents: number; totalRechargedCents: number; consumedCents: number; expiredCents: number; recharges: (Recharge & { expired: boolean; daysToExpiry: number })[]; alerts: string[] }

const addMonths = (iso: string, months: number): string => { const d = new Date(iso); const day = d.getUTCDate(); d.setUTCMonth(d.getUTCMonth() + months); if (d.getUTCDate() < day) d.setUTCDate(0); return d.toISOString(); };

/** a recharge: refused below the minimum; valid for the catalogue's months from ITS OWN date */
export function rechargeWallet(catalog: CommercialCatalog, state: AiWalletState, input: { id: string; amount: number; at: string }): { state: AiWalletState; recharge: Recharge } | { error: string } {
  const cents = toCents(input.amount);
  if (!(cents > 0)) return { error: "a recharge is a positive amount" };
  if (cents < toCents(catalog.wallet.minimumRecharge)) return { error: `the minimum wallet recharge is ${catalog.currency} ${catalog.wallet.minimumRecharge.toFixed(2)}` };
  if (state.recharges.some((r) => r.id === input.id)) return { state, recharge: state.recharges.find((r) => r.id === input.id)! }; // the same payment is one recharge
  const r: Recharge = { id: input.id, amountCents: cents, at: input.at, expiresAt: addMonths(input.at, catalog.wallet.validityMonths), remainingCents: cents };
  return { state: { recharges: [...state.recharges, r] }, recharge: r };
}

/**
 * Deduct an AI charge: from the recharges still valid at `at`, the one expiring soonest first. Refused whole when the
 * valid balance is short — a charge is never part-taken, and an expired recharge is never spent.
 */
export function consumeWallet(state: AiWalletState, cents: number, at: string): { state: AiWalletState; taken: { rechargeId: string; cents: number }[] } | { error: string; availableCents: number } {
  const need = Math.max(0, Math.round(cents));
  const valid = state.recharges.filter((r) => r.remainingCents > 0 && r.expiresAt > at).sort((a, b) => (a.expiresAt < b.expiresAt ? -1 : a.expiresAt > b.expiresAt ? 1 : 0));
  const available = valid.reduce((t, r) => t + r.remainingCents, 0);
  if (need > available) return { error: "the AI wallet balance does not cover this operation — recharge to continue", availableCents: available };
  let left = need;
  const taken: { rechargeId: string; cents: number }[] = [];
  const next = state.recharges.map((r) => ({ ...r }));
  for (const v of valid) { if (!left) break; const t = Math.min(left, v.remainingCents); next.find((r) => r.id === v.id)!.remainingCents -= t; taken.push({ rechargeId: v.id, cents: t }); left -= t; }
  return { state: { recharges: next }, taken };
}

export function aiWalletView(catalog: CommercialCatalog, state: AiWalletState, at: string): AiWalletView {
  const day = 86_400_000, now = new Date(at).getTime();
  const rows = state.recharges.map((r) => ({ ...r, expired: r.expiresAt <= at, daysToExpiry: Math.ceil((new Date(r.expiresAt).getTime() - now) / day) }));
  const valid = rows.filter((r) => !r.expired);
  const available = valid.reduce((t, r) => t + r.remainingCents, 0), validBase = valid.reduce((t, r) => t + r.amountCents, 0);
  const total = rows.reduce((t, r) => t + r.amountCents, 0), expired = rows.filter((r) => r.expired).reduce((t, r) => t + r.remainingCents, 0);
  const alerts: string[] = [];
  if (validBase > 0) {
    const share = (available / validBase) * 100;
    if (available <= toCents(catalog.wallet.nearlyExhaustedBelow)) alerts.push("Your AI wallet is nearly exhausted.");
    else { const hit = [...catalog.wallet.alertPcts].sort((a, b) => a - b).find((p) => share <= p); if (hit !== undefined) alerts.push(`Your AI wallet balance is at or below ${hit}%.`); }
  }
  for (const r of valid) if (r.remainingCents > 0 && r.daysToExpiry <= catalog.wallet.expiryAlertDays) alerts.push(`${catalog.currency} ${fromCents(r.remainingCents).toFixed(2)} from the recharge of ${r.at.slice(0, 10)} expires in ${r.daysToExpiry} day${r.daysToExpiry === 1 ? "" : "s"}.`);
  return { availableCents: available, totalRechargedCents: total, consumedCents: total - rows.reduce((t, r) => t + r.remainingCents, 0), expiredCents: expired, recharges: rows, alerts };
}

/* ------------------------------------------------------------ tax */

export interface TaxProfile { country: string | null; /** a tax registration the customer gave (VAT ID, GSTIN …), already validated */ taxId?: string | null; business?: boolean; exempt?: boolean }
export interface TaxDecision { country: string | null; name: string | null; ratePct: number; applies: boolean; reason: "taxed" | "no_country" | "not_configured" | "exempt" | "reverse_charge" | "category_not_taxed" }

/** which tax applies to a category for this customer — decided from the configured rules only */
export function taxFor(catalog: CommercialCatalog, profile: TaxProfile, category: BillingCategory): TaxDecision {
  const country = profile.country ? profile.country.trim().toUpperCase() : null;
  if (!country) return { country: null, name: null, ratePct: 0, applies: false, reason: "no_country" };
  const rule = catalog.taxRules.find((r) => r.country.toUpperCase() === country);
  if (!rule) return { country, name: null, ratePct: 0, applies: false, reason: "not_configured" };
  if (profile.exempt) return { country, name: rule.name, ratePct: 0, applies: false, reason: "exempt" };
  if (rule.reverseChargeForBusiness && profile.business && profile.taxId) return { country, name: rule.name, ratePct: 0, applies: false, reason: "reverse_charge" };
  if (!rule.appliesTo.includes(category)) return { country, name: rule.name, ratePct: 0, applies: false, reason: "category_not_taxed" };
  return { country, name: rule.name, ratePct: rule.ratePct, applies: true, reason: "taxed" };
}

/* ------------------------------------------------------------ the invoice */

export interface InvoiceLine { category: BillingCategory; description: string; quantity: number; unitPrice: number | null; netCents: number; taxName: string | null; taxRatePct: number; taxCents: number; taxNote: string | null; grossCents: number }
export interface Invoice { currency: string; lines: InvoiceLine[]; byCategory: Record<BillingCategory, { netCents: number; taxCents: number; grossCents: number }>; netCents: number; taxCents: number; totalCents: number; notes: string[] }
export interface InvoiceInput {
  subscription?: { planId: PlanId; users?: number; negotiatedMonthly?: number | null } | null;
  /** production responses to bill now, on top of `alreadyBilled`; `negotiatedSlabs` for an agreed rate card */
  responses?: { count: number; alreadyBilled?: number; negotiatedSlabs?: ResponseSlab[] } | null;
  /** a wallet recharge being paid for (the taxable event for AI usage) */
  aiRecharge?: { amount: number } | null;
  tax: TaxProfile;
}

const TAX_NOTES: Record<TaxDecision["reason"], string | null> = { taxed: null, no_country: "No billing country on file: tax could not be determined.", not_configured: "No tax rule is configured for this billing country.", exempt: "Tax-exempt customer.", reverse_charge: "Reverse charge: the customer accounts for the tax.", category_not_taxed: "Not taxable in this jurisdiction." };

/**
 * One invoice, three kinds of line, tax per line. Each line's tax is rounded on its own and the totals are sums of
 * lines, so the checkout's total, the invoice and the ledger agree to the cent.
 */
export function buildInvoice(catalog: CommercialCatalog, input: InvoiceInput): Invoice | { error: string } {
  const lines: InvoiceLine[] = [];
  const notes = new Set<string>();
  const add = (category: BillingCategory, description: string, quantity: number, unitPrice: number | null, netCents: number) => {
    const t = taxFor(catalog, input.tax, category);
    const taxCents = t.applies ? Math.round((netCents * t.ratePct) / 100 + (netCents >= 0 ? 1e-9 : -1e-9)) : 0;
    const note = TAX_NOTES[t.reason];
    if (note) notes.add(note);
    lines.push({ category, description, quantity, unitPrice, netCents, taxName: t.name, taxRatePct: t.applies ? t.ratePct : 0, taxCents, taxNote: note, grossCents: netCents + taxCents });
  };
  if (input.subscription) {
    const s = subscriptionCharge(catalog, input.subscription);
    if ("error" in s) return s;
    add("subscription", s.description, 1, fromCents(s.totalCents), s.totalCents);
  }
  if (input.responses && input.responses.count > 0) {
    if (input.responses.negotiatedSlabs) { const p = slabProblem(input.responses.negotiatedSlabs); if (p) return { error: `agreed response rates: ${p}` }; }
    const r = responseCharge(catalog, input.responses.count, input.responses.alreadyBilled ?? 0, input.responses.negotiatedSlabs ?? catalog.responseSlabs);
    for (const l of r.lines) add("responses", `Production responses — ${l.label} at ${catalog.currency} ${rate(l.each)} each`, l.responses, l.each, l.cents);
  }
  if (input.aiRecharge) {
    const c = toCents(input.aiRecharge.amount);
    if (c < toCents(catalog.wallet.minimumRecharge)) return { error: `the minimum wallet recharge is ${catalog.currency} ${catalog.wallet.minimumRecharge.toFixed(2)}` };
    add("ai", `AI Model Usage Wallet recharge (valid ${catalog.wallet.validityMonths} months)`, 1, fromCents(c), c);
  }
  const byCategory = Object.fromEntries(BILLING_CATEGORIES.map((k) => { const ls = lines.filter((l) => l.category === k); return [k, { netCents: ls.reduce((t, l) => t + l.netCents, 0), taxCents: ls.reduce((t, l) => t + l.taxCents, 0), grossCents: ls.reduce((t, l) => t + l.grossCents, 0) }]; })) as Invoice["byCategory"];
  const netCents = lines.reduce((t, l) => t + l.netCents, 0), taxCents = lines.reduce((t, l) => t + l.taxCents, 0);
  return { currency: catalog.currency, lines, byCategory, netCents, taxCents, totalCents: netCents + taxCents, notes: [...notes] };
}

/* ------------------------------------------------------------ AI: selling price from provider cost */

/**
 * What an AI operation is sold for: the provider's cost priced to leave the target GROSS MARGIN — margin as a share
 * of the selling price. $1.00 of provider cost at a 55 % margin sells for $2.22 (1 / 0.45), not $1.55.
 * A service with a service-level price is charged that price × its units and nothing else.
 */
export function aiCharge(catalog: CommercialCatalog, input: { providerCost: number; model?: string | null; service?: { id: string; units: number } | null }): { chargeCents: number; basis: "service" | "model"; marginPct: number; providerCostCents: number; grossMarginCents: number } {
  const costCents = Math.max(0, Math.round(input.providerCost * 100 * 1e4) / 1e4);
  const svc = input.service ? catalog.aiServices.find((x) => x.id === input.service!.id) : undefined;
  const charge = svc ? Math.round(svc.price * Math.max(0, input.service!.units) * 100 + 1e-6)
    : (() => { const own = input.model ? catalog.aiModelMarginPct[input.model] : undefined; const m = Math.min(95, Math.max(0, own ?? catalog.aiTargetMarginPct)); return Math.max(0, Math.ceil(costCents / (1 - m / 100) - 1e-9)); })();
  const marginPct = charge > 0 ? Math.round(((charge - costCents) / charge) * 1000) / 10 : 0;
  return { chargeCents: charge, basis: svc ? "service" : "model", marginPct, providerCostCents: Math.round(costCents), grossMarginCents: Math.round(charge - costCents) };
}

/* ------------------------------------------------------------ the estimate (the pricing calculator's arithmetic) */

export interface CostEstimate { subscriptionCents: number | null; responseLines: SlabLine[]; responsesCents: number; aiCents: number; subtotalCents: number | null; taxCents: number | null; taxNote: string | null; totalCents: number | null; contactSales: boolean }

/** a month's projected cost: plan + progressive responses + the AI budget the customer expects; Enterprise → contact sales */
export function estimateCost(catalog: CommercialCatalog, input: { planId: PlanId; users?: number; responses: number; aiBudget?: number; tax?: TaxProfile }): CostEstimate {
  const r = responseCharge(catalog, input.responses);
  const ai = toCents(Math.max(0, input.aiBudget ?? 0));
  const sub = subscriptionCharge(catalog, { planId: input.planId, ...(input.users ? { users: input.users } : {}) });
  if ("error" in sub) return { subscriptionCents: null, responseLines: r.lines, responsesCents: r.totalCents, aiCents: ai, subtotalCents: null, taxCents: null, taxNote: null, totalCents: null, contactSales: true };
  const subtotal = sub.totalCents + r.totalCents + ai;
  if (!input.tax?.country) return { subscriptionCents: sub.totalCents, responseLines: r.lines, responsesCents: r.totalCents, aiCents: ai, subtotalCents: subtotal, taxCents: null, taxNote: "Tax is calculated at checkout from your billing country.", totalCents: subtotal, contactSales: false };
  const part = (cat: BillingCategory, cents: number) => { const t = taxFor(catalog, input.tax!, cat); return t.applies ? Math.round((cents * t.ratePct) / 100 + 1e-9) : 0; };
  const tax = part("subscription", sub.totalCents) + r.lines.reduce((t, l) => t + part("responses", l.cents), 0) + part("ai", ai);
  const d = taxFor(catalog, input.tax, "subscription");
  return { subscriptionCents: sub.totalCents, responseLines: r.lines, responsesCents: r.totalCents, aiCents: ai, subtotalCents: subtotal, taxCents: tax, taxNote: TAX_NOTES[d.reason], totalCents: subtotal + tax, contactSales: false };
}

/* ------------------------------------------------------------ profitability */

export interface RevenueRecord { customerId: string; category: BillingCategory; revenueCents: number; providerCostCents?: number; infrastructureCostCents?: number }
export interface Profitability { customerId: string; subscriptionCents: number; responsesCents: number; aiCents: number; revenueCents: number; aiProviderCostCents: number; infrastructureCostCents: number; grossMarginCents: number; grossMarginPct: number }

/** revenue, cost and gross margin per customer and in total, by category — computed from recorded net revenue and costs */
export function profitability(records: readonly RevenueRecord[]): { customers: Profitability[]; total: Profitability } {
  const blank = (customerId: string): Profitability => ({ customerId, subscriptionCents: 0, responsesCents: 0, aiCents: 0, revenueCents: 0, aiProviderCostCents: 0, infrastructureCostCents: 0, grossMarginCents: 0, grossMarginPct: 0 });
  const by = new Map<string, Profitability>();
  for (const r of records) {
    const p = by.get(r.customerId) ?? blank(r.customerId);
    if (r.category === "subscription") p.subscriptionCents += r.revenueCents; else if (r.category === "responses") p.responsesCents += r.revenueCents; else p.aiCents += r.revenueCents;
    p.revenueCents += r.revenueCents; p.aiProviderCostCents += r.providerCostCents ?? 0; p.infrastructureCostCents += r.infrastructureCostCents ?? 0;
    by.set(r.customerId, p);
  }
  const finish = (p: Profitability) => { p.grossMarginCents = p.revenueCents - p.aiProviderCostCents - p.infrastructureCostCents; p.grossMarginPct = p.revenueCents ? Math.round((p.grossMarginCents / p.revenueCents) * 1000) / 10 : 0; return p; };
  const customers = [...by.values()].map(finish).sort((a, b) => b.revenueCents - a.revenueCents);
  const total = blank("all");
  for (const c of customers) for (const k of ["subscriptionCents", "responsesCents", "aiCents", "revenueCents", "aiProviderCostCents", "infrastructureCostCents"] as const) total[k] += c[k];
  return { customers, total: finish(total) };
}

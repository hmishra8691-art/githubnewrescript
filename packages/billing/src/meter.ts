import { billingConfig, type BillingConfig } from "./config.js";
import { money6 } from "./money.js";
import { priceOperation, type ChargeBreakdown } from "./pricing.js";
import {
  DEFAULT_BILLABLE_EVENTS, DEFAULT_RATES, eventDef, findRate, fixedChargeFor, providerCostFor,
  type BillableEventDef, type Rate, type UsageCategory,
} from "./registry.js";
import {
  READ_ONLY_MESSAGE, availableBalance, walletStateFor,
  type CreditRequest, type Environment, type LedgerEntry, type LedgerKind, type Reservation, type UsageEvent, type Wallet,
} from "./wallet.js";

/**
 * THE METERING ENGINE — one service every feature calls; no feature prices
 * anything itself.
 *
 *   estimate → check balance → RESERVE → run the operation → RECORD the
 *   actual usage → SETTLE (debit the actual charge, release the rest)
 *
 * The store does the atomic part (a wallet row is locked while its balance
 * is compared and changed — in SQL, `select … for update`; in memory, the
 * single thread). The engine does the arithmetic: which registry rate, what
 * it cost, what to charge, which category it lands in, whether TEST usage is
 * free. Both stores see exactly the same numbers because the numbers are
 * computed here and handed down.
 *
 * Refusals are values, not exceptions: `{ ok: false, reason, message }`,
 * so a route can turn "insufficient balance" into a 402 and "read-only" into
 * the sentence the brief specifies, and a runtime path can fall back to
 * "carry on without the value" — an interview is never lost to a meter.
 */

export interface MeterContext {
  customerId: string;
  surveyId: string | null;
  userId?: string | null;
  environment: Environment;
}

export interface UsageSpec {
  eventType: string;
  provider?: string | null;
  service?: string | null;
  model?: string | null;
  /** count in the event's unit (characters, responses, MB, minutes…) */
  quantity?: number;
  /** two-sided pricing (AI tokens): priced from the provider's input / output rows */
  inputUnits?: number | null;
  outputUnits?: number | null;
  unit?: string;
  /** the vendor's cost when the caller knows it (invoice data); otherwise computed from the registry */
  providerCost?: number | null;
  /** the infrastructure allocation when known; otherwise the configured estimate for the category */
  infraCost?: number | null;
  metadata?: Record<string, unknown>;
}

export type MeterRefusalReason = "read_only" | "insufficient_balance" | "no_wallet" | "suspended" | "store_error";
export interface MeterRefusal { ok: false; reason: MeterRefusalReason; message: string; wallet?: Wallet | null; estimate?: ChargeBreakdown }

export interface Priced {
  breakdown: ChargeBreakdown;
  rate: Rate | null;
  rateIn: Rate | null;
  rateOut: Rate | null;
  event: BillableEventDef;
  billable: boolean;
  category: UsageCategory;
  unit: string;
  quantity: number;
}

export interface Hold {
  ok: true;
  /** null when nothing was reserved: a free event (TEST-free, non-billable, zero cost) */
  reservation: Reservation | null;
  wallet: Wallet | null;
  ctx: MeterContext;
  spec: UsageSpec;
  estimate: ChargeBreakdown;
}

export interface UsageFilter { customerId?: string; surveyId?: string | null; walletId?: string; userId?: string; since?: string; until?: string; limit?: number; environment?: Environment }

export interface MeterStore {
  loadConfig(): Promise<unknown | null>;
  saveConfig(cfg: BillingConfig, by: string | null): Promise<void>;
  loadRates(): Promise<Rate[] | null>;
  saveRate(rate: Rate): Promise<void>;
  deleteRate(id: string): Promise<void>;
  loadEvents(): Promise<BillableEventDef[] | null>;
  saveEvent(def: BillableEventDef): Promise<void>;

  walletFor(customerId: string, surveyId: string | null, opts: { create: boolean; seedBalance?: number }): Promise<Wallet | null>;
  getWallet(id: string): Promise<Wallet | null>;
  listWallets(filter: { customerId?: string }): Promise<Wallet[]>;
  setWallet(id: string, patch: Partial<Pick<Wallet, "state" | "sharedWalletId" | "overdraftEnabled" | "overdraftLimit">>): Promise<Wallet>;

  /** Atomically hold `amount` if `balance − reserved − amount ≥ floor`. */
  reserve(input: { walletId: string; customerId: string; surveyId: string | null; userId: string | null; eventType: string; environment: Environment; estimatedCost: number; amount: number; floor: number; ttlMinutes: number }): Promise<{ ok: true; reservation: Reservation; wallet: Wallet } | { ok: false; wallet: Wallet }>;
  /** Atomically debit the actual charge, release the hold, write the usage event and its ledger line, recompute the state. */
  settle(reservationId: string, event: UsageEventInput, readOnlyThreshold: number): Promise<{ event: UsageEvent; wallet: Wallet }>;
  release(reservationId: string, status?: "released" | "expired"): Promise<void>;
  /** Write a usage event with no reservation (free events, or a debit the caller has already verified fits). */
  record(event: UsageEventInput, readOnlyThreshold: number): Promise<{ event: UsageEvent; wallet: Wallet | null }>;
  expireReservations(now: Date): Promise<number>;

  credit(input: { walletId: string; amount: number; kind: LedgerKind; reason: string; note: string | null; by: string | null; expiresAt: string | null; referenceId?: string | null; usageEventId?: string | null }, readOnlyThreshold: number): Promise<{ entry: LedgerEntry; wallet: Wallet }>;
  listLedger(walletId: string, limit?: number): Promise<LedgerEntry[]>;
  listUsage(filter: UsageFilter): Promise<UsageEvent[]>;
  getUsage(id: string): Promise<UsageEvent | null>;

  createCreditRequest(input: Omit<CreditRequest, "id" | "status" | "decidedBy" | "decidedAt" | "decidedAmount" | "adminNote" | "createdAt">): Promise<CreditRequest>;
  listCreditRequests(filter: { customerId?: string; surveyId?: string; userId?: string; status?: CreditRequest["status"] }): Promise<CreditRequest[]>;
  decideCreditRequest(id: string, decision: { status: "approved" | "rejected"; by: string; amount: number | null; note: string | null }): Promise<CreditRequest>;
}

export type UsageEventInput = Omit<UsageEvent, "id" | "createdAt">;

export class Meter {
  private cfgCache: { cfg: BillingConfig; at: number } | null = null;
  private ratesCache: { rates: Rate[]; at: number } | null = null;
  private eventsCache: { events: BillableEventDef[]; at: number } | null = null;
  constructor(readonly store: MeterStore, private readonly opts: { cacheMs?: number; seedBalance?: number } = {}) {}

  private get cacheMs() { return this.opts.cacheMs ?? 15_000; }
  invalidate() { this.cfgCache = this.ratesCache = this.eventsCache = null; }

  async config(): Promise<BillingConfig> {
    if (this.cfgCache && Date.now() - this.cfgCache.at < this.cacheMs) return this.cfgCache.cfg;
    const cfg = billingConfig(await this.store.loadConfig().catch(() => null));
    this.cfgCache = { cfg, at: Date.now() };
    return cfg;
  }
  async rates(): Promise<Rate[]> {
    if (this.ratesCache && Date.now() - this.ratesCache.at < this.cacheMs) return this.ratesCache.rates;
    const stored = await this.store.loadRates().catch(() => null);
    const rates = stored && stored.length ? stored : DEFAULT_RATES;
    this.ratesCache = { rates, at: Date.now() };
    return rates;
  }
  async events(): Promise<BillableEventDef[]> {
    if (this.eventsCache && Date.now() - this.eventsCache.at < this.cacheMs) return this.eventsCache.events;
    const stored = await this.store.loadEvents().catch(() => null);
    // stored rows override the defaults of the same type; defaults fill in the rest so a new platform event is never unknown
    const map = new Map(DEFAULT_BILLABLE_EVENTS.map((e) => [e.type, e]));
    for (const e of stored ?? []) map.set(e.type, e);
    const events = [...map.values()];
    this.eventsCache = { events, at: Date.now() };
    return events;
  }

  /* ------------------------------------------------------------ pricing */

  /** Price a spec without touching any wallet. */
  async price(spec: UsageSpec, environment: Environment): Promise<Priced> {
    const [cfg, rates, events] = await Promise.all([this.config(), this.rates(), this.events()]);
    return priceSpec(spec, environment, cfg, rates, events);
  }

  async estimate(ctx: MeterContext, spec: UsageSpec): Promise<ChargeBreakdown> {
    return (await this.price(spec, ctx.environment)).breakdown;
  }

  /* ------------------------------------------------------------ wallets */

  /** The wallet a project draws from — its own, or the one it shares. */
  async walletFor(ctx: Pick<MeterContext, "customerId" | "surveyId">, create = true): Promise<Wallet | null> {
    const own = await this.store.walletFor(ctx.customerId, ctx.surveyId, { create, seedBalance: this.opts.seedBalance });
    if (!own) return null;
    if (own.sharedWalletId) return (await this.store.getWallet(own.sharedWalletId)) ?? own;
    return own;
  }

  /** May this project run a billable operation right now? (the read-only gate for things that are not metered per call, e.g. exports) */
  async check(ctx: Pick<MeterContext, "customerId" | "surveyId">): Promise<{ allowed: boolean; state: Wallet["state"] | "none"; wallet: Wallet | null; message: string }> {
    const cfg = await this.config();
    const wallet = await this.walletFor(ctx, true).catch(() => null);
    if (!wallet) return { allowed: true, state: "none", wallet: null, message: "" };
    const state = walletStateFor(wallet.balance, cfg, wallet.state);
    if (state === "suspended") return { allowed: false, state, wallet, message: "This project's wallet is suspended. Please contact your administrator." };
    if (state === "read_only") return { allowed: false, state, wallet, message: READ_ONLY_MESSAGE };
    return { allowed: true, state, wallet, message: "" };
  }

  /* ------------------------------------------------------------ the flow */

  /** Estimate, check, reserve. */
  async reserve(ctx: MeterContext, spec: UsageSpec): Promise<Hold | MeterRefusal> {
    const cfg = await this.config();
    const priced = await this.price(spec, ctx.environment);
    const charge = priced.breakdown.customerCharge;
    let wallet: Wallet | null;
    try { wallet = await this.walletFor(ctx, true); } catch (e) { return { ok: false, reason: "store_error", message: (e as Error).message, estimate: priced.breakdown }; }
    if (!wallet) return { ok: false, reason: "no_wallet", message: "No wallet exists for this project.", estimate: priced.breakdown };

    const state = walletStateFor(wallet.balance, cfg, wallet.state);
    if (state === "suspended") return { ok: false, reason: "suspended", message: "This project's wallet is suspended. Please contact your administrator.", wallet, estimate: priced.breakdown };
    // a read-only project runs nothing billable — even at a price of zero (a free TEST run is still "running AI")
    if (state === "read_only" && priced.billable) return { ok: false, reason: "read_only", message: READ_ONLY_MESSAGE, wallet, estimate: priced.breakdown };

    if (charge <= 0) return { ok: true, reservation: null, wallet, ctx, spec, estimate: priced.breakdown };

    const overdraft = (wallet.overdraftEnabled ?? cfg.overdraftEnabled) ? (wallet.overdraftLimit ?? cfg.overdraftLimit) : 0;
    const floor = money6(cfg.minimumRemainingBalance - overdraft);
    const r = await this.store.reserve({
      walletId: wallet.id, customerId: ctx.customerId, surveyId: ctx.surveyId, userId: ctx.userId ?? null,
      eventType: spec.eventType, environment: ctx.environment,
      estimatedCost: priced.breakdown.actualCost, amount: charge, floor, ttlMinutes: cfg.reservationTtlMinutes,
    });
    if (!r.ok) {
      const avail = availableBalance(r.wallet, cfg);
      return { ok: false, reason: "insufficient_balance", message: `Insufficient balance: this operation needs ${charge.toFixed(4)} ${wallet.currency} and ${Math.max(0, avail).toFixed(2)} ${wallet.currency} is available.`, wallet: r.wallet, estimate: priced.breakdown };
    }
    return { ok: true, reservation: r.reservation, wallet: r.wallet, ctx, spec, estimate: priced.breakdown };
  }

  /** Record what actually happened and settle the hold. `actual` overrides the spec's counts (tokens really used, characters really sent). */
  async settle(hold: Hold, actual: Partial<UsageSpec> = {}): Promise<UsageEvent> {
    const cfg = await this.config();
    const spec: UsageSpec = { ...hold.spec, ...actual, metadata: { ...(hold.spec.metadata ?? {}), ...(actual.metadata ?? {}) } };
    const priced = await this.price(spec, hold.ctx.environment);
    const input = eventInput(hold.ctx, spec, priced, hold.wallet?.id ?? null, hold.reservation?.id ?? null);
    if (hold.reservation) {
      const { event } = await this.store.settle(hold.reservation.id, input, cfg.readOnlyThreshold);
      return event;
    }
    const { event } = await this.store.record(input, cfg.readOnlyThreshold);
    return event;
  }

  /** The operation did not happen (provider error, cancelled): give the hold back. */
  async release(hold: Hold): Promise<void> {
    if (hold.reservation) await this.store.release(hold.reservation.id, "released");
  }

  /** Reserve + settle in one step, for events whose size is known when they happen (a completed response, a file upload). */
  async record(ctx: MeterContext, spec: UsageSpec): Promise<{ ok: true; event: UsageEvent } | MeterRefusal> {
    const hold = await this.reserve(ctx, spec);
    if (!hold.ok) return hold;
    const event = await this.settle(hold);
    return { ok: true, event };
  }

  /** Run `fn` under a hold: settle with what it reports, release if it throws. */
  async run<T>(ctx: MeterContext, spec: UsageSpec, fn: (report: (actual: Partial<UsageSpec>) => void) => Promise<T>): Promise<{ ok: true; value: T; event: UsageEvent } | MeterRefusal> {
    const hold = await this.reserve(ctx, spec);
    if (!hold.ok) return hold;
    let actual: Partial<UsageSpec> = {};
    try {
      const value = await fn((a) => { actual = { ...actual, ...a }; });
      const event = await this.settle(hold, actual);
      return { ok: true, value, event };
    } catch (e) {
      await this.release(hold).catch(() => {});
      throw e;
    }
  }

  /**
   * CORRECTION. A usage event is never edited: a reversal event with the
   * negated amounts is written beside it and the wallet is credited back.
   */
  async reverse(eventId: string, by: string | null, note: string): Promise<{ reversal: UsageEvent; entry: LedgerEntry | null } | null> {
    const cfg = await this.config();
    const original = await this.store.getUsage(eventId);
    if (!original || original.adjustsEventId) return null;
    const neg = (n: number) => money6(-n);
    const input: UsageEventInput = {
      ...original, quantity: neg(original.quantity), inputUnits: original.inputUnits == null ? null : -original.inputUnits, outputUnits: original.outputUnits == null ? null : -original.outputUnits,
      providerCost: neg(original.providerCost), infraCost: neg(original.infraCost), paymentFee: neg(original.paymentFee), taxReserve: neg(original.taxReserve),
      customerCharge: neg(original.customerCharge), grossProfit: neg(original.grossProfit), netProfit: neg(original.netProfit),
      reservationId: null, adjustsEventId: original.id, userId: by ?? original.userId,
      metadata: { ...original.metadata, reversal: true, note },
    };
    const { event: reversal } = await this.store.record(input, cfg.readOnlyThreshold);
    let entry: LedgerEntry | null = null;
    if (original.walletId && original.customerCharge > 0) {
      ({ entry } = await this.store.credit({ walletId: original.walletId, amount: original.customerCharge, kind: "reversal", reason: "usage_reversed", note, by, expiresAt: null, referenceId: null, usageEventId: reversal.id }, cfg.readOnlyThreshold));
    }
    return { reversal, entry };
  }

  /* ------------------------------------------------------------ credits */

  /** Administrator assigns / adds / removes credits. Always a ledger line; the balance is never set directly. */
  async credit(walletId: string, amount: number, opts: { reason: string; note?: string | null; by: string | null; expiresAt?: string | null }): Promise<{ entry: LedgerEntry; wallet: Wallet }> {
    const cfg = await this.config();
    const kind: LedgerKind = amount >= 0 ? "credit" : "adjustment";
    return this.store.credit({ walletId, amount: money6(amount), kind, reason: opts.reason, note: opts.note ?? null, by: opts.by, expiresAt: opts.expiresAt ?? null }, cfg.readOnlyThreshold);
  }
}

/* ---------------------------------------------------------------- pricing */

const INFRA_BY_CATEGORY = (cfg: BillingConfig, category: UsageCategory, quantity: number): number => {
  switch (category) {
    case "ai": return cfg.estimatedInfrastructureCostPerAiRequest;
    case "translation": return cfg.estimatedInfrastructureCostPerTranslationRequest;
    case "responses": return money6(cfg.estimatedInfrastructureCostPerResponse * Math.max(1, quantity));
    default: return 0;
  }
};

export function priceSpec(spec: UsageSpec, environment: Environment, cfg: BillingConfig, rates: Rate[], events: BillableEventDef[]): Priced {
  const event = eventDef(events, spec.eventType) ?? eventDef(events, "CUSTOM_EVENT") ?? DEFAULT_BILLABLE_EVENTS[DEFAULT_BILLABLE_EVENTS.length - 1];
  const provider = spec.provider ?? event.rate?.provider ?? null;
  const service = spec.service ?? event.rate?.service ?? null;
  const model = spec.model ?? event.rate?.model ?? null;
  const twoSided = spec.inputUnits != null || spec.outputUnits != null;
  let rate: Rate | null = null, rateIn: Rate | null = null, rateOut: Rate | null = null;
  let providerCost = 0;
  let quantity = spec.quantity ?? 0;
  if (twoSided && provider && service) {
    rateIn = findRate(rates, { provider, service, model, side: "input" });
    rateOut = findRate(rates, { provider, service, model, side: "output" });
    providerCost = money6(providerCostFor(rateIn, spec.inputUnits ?? 0) + providerCostFor(rateOut, spec.outputUnits ?? 0));
    if (!spec.quantity) quantity = (spec.inputUnits ?? 0) + (spec.outputUnits ?? 0);
  } else if (provider && service) {
    rate = findRate(rates, { provider, service, model });
    providerCost = providerCostFor(rate, quantity);
  }
  if (spec.providerCost != null && Number.isFinite(spec.providerCost)) providerCost = money6(spec.providerCost);
  const infraCost = spec.infraCost != null && Number.isFinite(spec.infraCost) ? money6(spec.infraCost) : INFRA_BY_CATEGORY(cfg, event.category, quantity);
  const fixed = twoSided ? null : fixedChargeFor(rate, quantity);
  const billable = event.billable && event.active;
  const breakdown = billable
    ? priceOperation({ providerCost, infraCost }, cfg, { fixedCustomerCharge: fixed, environment })
    : { ...priceOperation({ providerCost, infraCost }, cfg, { fixedCustomerCharge: 0, environment }), fixedRate: false };
  return { breakdown, rate, rateIn, rateOut, event, billable, category: event.category, unit: spec.unit ?? event.unit, quantity };
}

function eventInput(ctx: MeterContext, spec: UsageSpec, priced: Priced, walletId: string | null, reservationId: string | null): UsageEventInput {
  const b = priced.breakdown;
  return {
    customerId: ctx.customerId, surveyId: ctx.surveyId, userId: ctx.userId ?? null, walletId,
    eventType: priced.event.type === "CUSTOM_EVENT" ? spec.eventType : priced.event.type, category: priced.category, environment: ctx.environment,
    provider: spec.provider ?? priced.event.rate?.provider ?? null, service: spec.service ?? priced.event.rate?.service ?? null, model: spec.model ?? priced.event.rate?.model ?? null,
    quantity: priced.quantity, unit: priced.unit, inputUnits: spec.inputUnits ?? null, outputUnits: spec.outputUnits ?? null,
    providerCost: b.providerCost, infraCost: b.infraCost, paymentFee: b.paymentFee, taxReserve: b.taxReserve,
    customerCharge: b.customerCharge, grossProfit: b.grossProfit, netProfit: b.netProfit, marginPct: b.marginPct,
    reservationId, adjustsEventId: null,
    metadata: { ...(spec.metadata ?? {}), billable: priced.billable, testAdjustment: b.testAdjustment, minimumApplied: b.minimumApplied, fixedRate: b.fixedRate, rateId: priced.rate?.id ?? null, rateInId: priced.rateIn?.id ?? null, rateOutId: priced.rateOut?.id ?? null },
  };
}

/* ------------------------------------------------------------- estimates */

/** Rough token count for a prompt: ~4 characters per token, never below 1. */
export function estimateTokens(text: string): number {
  return Math.max(1, Math.ceil((text ?? "").length / 4));
}

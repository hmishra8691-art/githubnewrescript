import { forecastUsage, summarizeWallet, usageByCategory, usageTimeline, balanceLevel, LEVEL_MESSAGE, CATEGORY_LABEL, type Meter, type MeterContext, type UsageEvent, type WalletSummary } from "@rescript/billing";

/**
 * THE PROJECT METER VIEW — what the Usage tab, the user page and the admin
 * screens all read. One function, so every screen shows the same numbers
 * for the same wallet.
 *
 * TWO AUDIENCES (billing update, change 2). The backend calculates and
 * stores every cost component for every event — provider cost,
 * infrastructure, payment fee, tax/reserve, gross and net profit, margin —
 * because pricing and profitability analysis need them. A RESEARCHER sees
 * none of that: only what was charged to their wallet, what remains, and
 * their usage. An ADMINISTRATOR sees everything. The split is made here,
 * server-side, before anything is serialised: a "user" view contains no
 * cost field at all, so no client can show what it was never sent.
 */
export type Audience = "user" | "admin";

export async function projectMeterView(meter: Meter, ctx: Pick<MeterContext, "customerId" | "surveyId">, opts: { days?: number; recent?: number; audience?: Audience } = {}) {
  const audience: Audience = opts.audience ?? "user";
  const cfg = await meter.config();
  const wallet = await meter.walletFor(ctx, true);
  if (!wallet) return null;
  const [ledger, events] = await Promise.all([meter.store.listLedger(wallet.id, 200), meter.store.listUsage({ surveyId: ctx.surveyId, limit: 5000 })]);
  const full = summarizeWallet(wallet, ledger, events, cfg);
  const forecast = forecastUsage(wallet.balance, events, cfg);
  const level = balanceLevel(wallet.balance, cfg);
  const { costs, ...summary } = full;
  const usedPct = full.totalAdded > 0 ? Math.round((full.used / full.totalAdded) * 10000) / 100 : full.used > 0 ? 100 : 0;
  return {
    audience,
    wallet: { id: wallet.id, currency: wallet.currency, state: full.state, sharedWalletId: wallet.sharedWalletId, overdraftEnabled: wallet.overdraftEnabled ?? cfg.overdraftEnabled },
    summary: audience === "admin" ? { ...summary, costs, usedPct } : { ...summary, usedPct },
    level, message: LEVEL_MESSAGE[level],
    thresholds: { low: cfg.lowBalanceThreshold, critical: cfg.criticalBalanceThreshold, readOnly: cfg.readOnlyThreshold, minimumRemaining: cfg.minimumRemainingBalance },
    policy: { testUsage: cfg.testUsagePolicy, testDiscountPct: cfg.testUsageDiscountPct, allowExportsWhenReadOnly: cfg.allowExportsWhenReadOnly, lockRespondentsWhenReadOnly: cfg.lockRespondentsWhenReadOnly },
    categories: usageByCategory(events).map((c) => audience === "admin" ? { ...c, label: CATEGORY_LABEL[c.category] } : { category: c.category, label: CATEGORY_LABEL[c.category], charge: c.charge, events: c.events, quantity: c.quantity }),
    byEnvironment: { TEST: sum(events.filter((e) => e.environment === "TEST"), audience), LIVE: sum(events.filter((e) => e.environment === "LIVE"), audience) },
    timeline: usageTimeline(events, opts.days ?? 30).map((p) => audience === "admin" ? p : { day: p.day, charge: p.charge, events: p.events }),
    recent: events.slice(0, opts.recent ?? 50).map((e) => audience === "admin" ? adminEvent(e) : publicEvent(e)),
    forecast,
    ledger: ledger.slice(0, 50).map((l) => ({ id: l.id, kind: l.kind, amount: l.amount, balanceAfter: l.balanceAfter, reason: l.reason, note: l.note, createdAt: l.createdAt, transferId: l.transferId })),
  };
}

export type UserMeterView = NonNullable<Awaited<ReturnType<typeof projectMeterView>>>;
export type AdminSummary = WalletSummary & { usedPct: number };

function sum(events: UsageEvent[], audience: Audience) {
  const base = { charge: round(events.reduce((a, e) => a + e.customerCharge, 0)), events: events.length };
  return audience === "admin" ? { ...base, actualCost: round(events.reduce((a, e) => a + e.providerCost + e.infraCost, 0)) } : base;
}
const round = (n: number) => Math.round(n * 1e6) / 1e6;

/**
 * What a project member sees for one usage row: the activity, how much of
 * it, in which environment, and the CHARGE to their wallet. No cost, no
 * margin, no fee — those fields do not exist on this object.
 */
export function publicEvent(e: UsageEvent) {
  return {
    id: e.id, at: e.createdAt, eventType: e.eventType, category: e.category, label: CATEGORY_LABEL[e.category], environment: e.environment,
    provider: e.provider, model: e.model, quantity: e.quantity, unit: e.unit, inputUnits: e.inputUnits, outputUnits: e.outputUnits,
    customerCharge: e.customerCharge,
    reversal: !!e.adjustsEventId, unbilled: e.metadata?.unbilled === true, operation: typeof e.metadata?.operation === "string" ? e.metadata.operation : null, cached: e.metadata?.cached === true,
    surveyId: e.surveyId,
  };
}

/** The administrator's row: the same, plus every cost component. */
export function adminEvent(e: UsageEvent) {
  return {
    ...publicEvent(e),
    actualCost: round(e.providerCost + e.infraCost), providerCost: e.providerCost, infraCost: e.infraCost, paymentFee: e.paymentFee, taxReserve: e.taxReserve,
    grossProfit: e.grossProfit, netProfit: e.netProfit, marginPct: e.marginPct,
  };
}

/** The keys a researcher must never receive — used by the tests and by the guard below. */
export const INTERNAL_COST_KEYS = ["actualCost", "providerCost", "infraCost", "paymentFee", "taxReserve", "grossProfit", "netProfit", "marginPct", "costs", "grossMarginPct", "apiMarkup", "infraMarkup"] as const;

/** Defensive: strip any internal cost key from an object tree before it leaves a user-facing route. */
export function stripInternalCosts<T>(value: T): T {
  if (Array.isArray(value)) return value.map(stripInternalCosts) as unknown as T;
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      if ((INTERNAL_COST_KEYS as readonly string[]).includes(k)) continue;
      out[k] = stripInternalCosts(v);
    }
    return out as T;
  }
  return value;
}

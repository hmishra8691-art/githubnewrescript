import { forecastUsage, summarizeWallet, usageByCategory, usageTimeline, balanceLevel, LEVEL_MESSAGE, CATEGORY_LABEL, type Meter, type MeterContext, type UsageEvent } from "@rescript/billing";

/**
 * THE PROJECT METER VIEW — what the Usage tab, the user page and the admin
 * screens all read. One function, so every screen shows the same numbers
 * for the same wallet.
 */
export async function projectMeterView(meter: Meter, ctx: Pick<MeterContext, "customerId" | "surveyId">, opts: { days?: number; recent?: number } = {}) {
  const cfg = await meter.config();
  const wallet = await meter.walletFor(ctx, true);
  if (!wallet) return null;
  const [ledger, events] = await Promise.all([meter.store.listLedger(wallet.id, 200), meter.store.listUsage({ surveyId: ctx.surveyId, limit: 5000 })]);
  const summary = summarizeWallet(wallet, ledger, events, cfg);
  const forecast = forecastUsage(wallet.balance, events, cfg);
  const level = balanceLevel(wallet.balance, cfg);
  return {
    wallet: { id: wallet.id, currency: wallet.currency, state: summary.state, sharedWalletId: wallet.sharedWalletId, overdraftEnabled: wallet.overdraftEnabled ?? cfg.overdraftEnabled },
    summary,
    level, message: LEVEL_MESSAGE[level],
    thresholds: { low: cfg.lowBalanceThreshold, critical: cfg.criticalBalanceThreshold, readOnly: cfg.readOnlyThreshold, minimumRemaining: cfg.minimumRemainingBalance },
    policy: { testUsage: cfg.testUsagePolicy, testDiscountPct: cfg.testUsageDiscountPct, allowExportsWhenReadOnly: cfg.allowExportsWhenReadOnly, lockRespondentsWhenReadOnly: cfg.lockRespondentsWhenReadOnly },
    categories: usageByCategory(events).map((c) => ({ ...c, label: CATEGORY_LABEL[c.category] })),
    byEnvironment: { TEST: sum(events.filter((e) => e.environment === "TEST")), LIVE: sum(events.filter((e) => e.environment === "LIVE")) },
    timeline: usageTimeline(events, opts.days ?? 30),
    recent: events.slice(0, opts.recent ?? 50).map(publicEvent),
    forecast,
    ledger: ledger.slice(0, 50),
  };
}

function sum(events: UsageEvent[]) {
  return { charge: round(events.reduce((a, e) => a + e.customerCharge, 0)), events: events.length, actualCost: round(events.reduce((a, e) => a + e.providerCost + e.infraCost, 0)) };
}
const round = (n: number) => Math.round(n * 1e6) / 1e6;

/** The fields a project member sees for one usage row. The cost split is shown — the brief wants the researcher to see actual cost beside charge — but nothing about other projects. */
export function publicEvent(e: UsageEvent) {
  return {
    id: e.id, at: e.createdAt, eventType: e.eventType, category: e.category, label: CATEGORY_LABEL[e.category], environment: e.environment,
    provider: e.provider, model: e.model, quantity: e.quantity, unit: e.unit, inputUnits: e.inputUnits, outputUnits: e.outputUnits,
    actualCost: round(e.providerCost + e.infraCost), providerCost: e.providerCost, infraCost: e.infraCost, customerCharge: e.customerCharge,
    reversal: !!e.adjustsEventId, unbilled: e.metadata?.unbilled === true, operation: typeof e.metadata?.operation === "string" ? e.metadata.operation : null, cached: e.metadata?.cached === true,
  };
}

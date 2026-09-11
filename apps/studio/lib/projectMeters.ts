import type { Meter, Wallet, BillingConfig, UsageEvent, ProjectMeter } from "@rescript/billing";
import { money6, projectMeter } from "@rescript/billing";

/**
 * EVERY PROJECT'S METER, IN TWO QUERIES.
 *
 * The dashboard shows a wallet on every card and "My usage" lists the same
 * wallets. Neither works out its own answer: the arithmetic is `projectMeter`
 * in the billing package, beside the rest of the wallet maths, and this file
 * only fetches. A researcher who reads $56.75 on a card, opens the project
 * and sees something else has been told two different things by one system.
 *
 * Two store reads, whatever the number of projects: every wallet in the
 * workspace and every usage event in it, grouped in memory. The obvious
 * implementation — ask each project for its own meter — is one round trip per
 * card, which on a dashboard of forty projects is eighty queries for a number
 * that is a sum. `projectMeterView` remains the answer for ONE project opened
 * on its own, where the ledger, forecast and timeline it also loads are shown.
 *
 * Nothing internal is computed here, so nothing internal can leak: provider
 * cost, infrastructure, fees, reserve and margin are not read, not summed and
 * not returned.
 */

export type { ProjectMeter };

export interface ProjectMeterSet {
  /** Keyed by survey id. A project with no wallet yet is absent. */
  meters: Map<string, ProjectMeter>;
  config: BillingConfig;
  wallets: Wallet[];
  events: UsageEvent[];
}

/**
 * The meters for a set of projects.
 *
 * `surveyIds` is the projects the caller may see, and it is applied to the
 * usage events as well as to the wallets — a workspace's events can never be
 * summed into a project the person cannot open.
 */
export async function projectMeters(meter: Meter, customerId: string | null | undefined, surveyIds: string[]): Promise<ProjectMeterSet> {
  const cfg = await meter.config();
  const visible = new Set(surveyIds);
  const [wallets, events] = await Promise.all([
    meter.store.listWallets({ customerId: customerId ?? undefined }),
    meter.store.listUsage({ customerId: customerId ?? undefined, limit: 5000 }),
  ]);

  const mineEvents = events.filter((e) => e.surveyId && visible.has(e.surveyId));
  const usedById = new Map<string, { charge: number; events: number }>();
  for (const e of mineEvents) {
    const row = usedById.get(e.surveyId!) ?? { charge: 0, events: 0 };
    row.charge = money6(row.charge + e.customerCharge);
    row.events += 1;
    usedById.set(e.surveyId!, row);
  }

  const meters = new Map<string, ProjectMeter>();
  for (const w of wallets) {
    if (!w.surveyId || !visible.has(w.surveyId)) continue;
    meters.set(w.surveyId, projectMeter(w, usedById.get(w.surveyId), cfg));
  }
  return { meters, config: cfg, wallets, events: mineEvents };
}

/**
 * The thresholds a card needs to word its own status, sent to the browser so
 * a meter can say why a project is low without a second round trip. These are
 * the administrator's configuration, not a cost.
 */
export function meterThresholds(cfg: BillingConfig) {
  return {
    low: cfg.lowBalanceThreshold,
    critical: cfg.criticalBalanceThreshold,
    readOnly: cfg.readOnlyThreshold,
  };
}

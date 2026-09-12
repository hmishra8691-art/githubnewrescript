import type { Meter, Wallet, BillingConfig, UsageEvent, ProjectMeter, ProjectSpending, WalletOverview } from "@rescript/billing";
import { money6, projectMeter, walletOverview } from "@rescript/billing";

/**
 * ONE PERSON'S WALLET, AND WHAT EACH OF THEIR PROJECTS IS SPENDING FROM IT.
 *
 * The model this serves: a person has ONE balance, every project they own
 * draws on it, and what a project may take is a policy on the project rather
 * than money inside it. So a projects page needs two different things at
 * once — the wallet, which is the same number on every card, and each
 * project's own spend and policy, which are not.
 *
 * Both come from `@rescript/billing`: `walletOverview` and `projectMeter`.
 * No screen does this arithmetic itself, because a figure that reads one way
 * on the dashboard and another inside the project is one system telling a
 * person two different things and no way for them to know which is true.
 *
 * Three store reads for the whole page, whatever the number of projects: the
 * wallets, the spending policies, and the usage events. The obvious
 * implementation — ask each project for its own meter — is a round trip per
 * card for numbers that are sums.
 *
 * Nothing internal is computed here, so nothing internal can leak: provider
 * cost, infrastructure, fees, reserve and margin are not read, not summed and
 * not returned.
 */

export type { ProjectMeter };

export interface ProjectMeterSet {
  /** Keyed by survey id. Every visible project has one, wallet or no wallet. */
  meters: Map<string, ProjectMeter>;
  /** The wallet those projects draw on — the signed-in person's. */
  wallet: WalletOverview;
  spending: Map<string, ProjectSpending>;
  config: BillingConfig;
  wallets: Wallet[];
  events: UsageEvent[];
}

/**
 * The meters for a set of projects, all drawing on one person's wallet.
 *
 * `surveyIds` is what the caller may see, and it is applied to the usage
 * events as well as to the policies — a workspace's events can never be
 * summed into a project the person cannot open.
 */
export async function projectMeters(
  meter: Meter,
  customerId: string | null | undefined,
  userId: string,
  surveyIds: string[],
): Promise<ProjectMeterSet> {
  const cfg = await meter.config();
  const visible = new Set(surveyIds);
  const [wallets, events, policies] = await Promise.all([
    meter.store.listWallets({ customerId: customerId ?? undefined }),
    meter.store.listUsage({ customerId: customerId ?? undefined, limit: 5000 }),
    meter.store.listSpending({ customerId: customerId ?? undefined, surveyIds }),
  ]);

  const mine = wallets.find((w) => w.userId === userId) ?? null;
  const ledger = mine ? await meter.store.listLedger(mine.id, 500) : [];
  const wallet = walletOverview(mine, ledger, cfg);

  const mineEvents = events.filter((e) => e.surveyId && visible.has(e.surveyId));
  const usedById = new Map<string, { charge: number; events: number }>();
  for (const e of mineEvents) {
    const row = usedById.get(e.surveyId!) ?? { charge: 0, events: 0 };
    row.charge = money6(row.charge + e.customerCharge);
    row.events += 1;
    usedById.set(e.surveyId!, row);
  }

  const spending = new Map(policies.map((p) => [p.surveyId, p]));
  /*
   * A project whose wallet is not this person's — one shared with them by a
   * colleague — is metered against the wallet that actually funds it, so the
   * card never shows a stranger's balance as though it were theirs.
   */
  const byProject = new Map(wallets.filter((w) => w.surveyId).map((w) => [w.surveyId!, w]));
  const meters = new Map<string, ProjectMeter>();
  for (const id of surveyIds) {
    const w = mine ?? byProject.get(id) ?? null;
    if (!w) continue;
    meters.set(id, projectMeter(w, usedById.get(id), cfg, spending.get(id) ?? null));
  }
  return { meters, wallet, spending, config: cfg, wallets, events: mineEvents };
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

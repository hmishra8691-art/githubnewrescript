import type { BillingConfig } from "./config.js";
import { money6, sumMoney, pctOf } from "./money.js";
import type { UsageCategory } from "./registry.js";

/**
 * WALLETS, LEDGERS AND USAGE — the records, and the arithmetic over them
 * that every screen shows. Pure: fed with rows, returns numbers. The stores
 * (memory, database) persist the rows; nothing here touches storage.
 */

export type Environment = "TEST" | "LIVE";
export const WALLET_STATES = ["active", "read_only", "suspended"] as const;
export type WalletState = (typeof WALLET_STATES)[number];
export type BalanceLevel = "normal" | "low" | "critical" | "locked";

export interface Wallet {
  id: string;
  customerId: string;
  /** the project (survey) this wallet belongs to; null = a workspace wallet or a person's own wallet */
  surveyId: string | null;
  /** the person this wallet belongs to (a personal pool credits can be moved into and out of); null for project / workspace wallets */
  userId: string | null;
  /** when set, this project draws from that wallet instead of its own (explicit shared-wallet feature) */
  sharedWalletId: string | null;
  currency: string;
  balance: number;
  /** held by open reservations — not spendable */
  reserved: number;
  totalAdded: number;
  totalUsed: number;
  state: WalletState;
  /** per-wallet override of the global overdraft switch */
  overdraftEnabled: boolean | null;
  overdraftLimit: number | null;
  createdAt: string;
  updatedAt: string;
}

export const LEDGER_KINDS = ["credit", "debit", "adjustment", "reversal", "expiry", "transfer_out", "transfer_in", "transfer_reversal"] as const;
export type LedgerKind = (typeof LEDGER_KINDS)[number];

export interface LedgerEntry {
  id: string;
  walletId: string;
  customerId: string;
  surveyId: string | null;
  kind: LedgerKind;
  /** signed: credits positive, debits negative */
  amount: number;
  balanceAfter: number;
  reason: string;
  note: string | null;
  usageEventId: string | null;
  /** the entry this one reverses / adjusts */
  referenceId: string | null;
  /** both sides of a credit transfer carry the same transfer id */
  transferId: string | null;
  createdBy: string | null;
  createdAt: string;
  expiresAt: string | null;
}

/**
 * A CREDIT TRANSFER — unused balance moved from one wallet to another by an
 * administrator: one row, two ledger lines (transfer_out on the source,
 * transfer_in on the destination) referencing it, all in one transaction.
 * A reversal is a second transfer row pointing at the first, never an edit.
 */
export type WalletKind = "project" | "user" | "workspace";
export interface CreditTransfer {
  id: string;
  /** the human-readable reference, TRX-XXXXXX */
  code: string;
  customerId: string;
  sourceWalletId: string;
  destinationWalletId: string;
  sourceKind: WalletKind;
  destinationKind: WalletKind;
  /** the project or user id behind each wallet, for the history screen */
  sourceRef: string | null;
  destinationRef: string | null;
  amount: number;
  currency: string;
  reason: string | null;
  note: string | null;
  transferredBy: string | null;
  status: "completed" | "reversed";
  /** set on a reversal: the transfer it undoes */
  reversalOf: string | null;
  /** set on the original once reversed */
  reversedBy: string | null;
  createdAt: string;
}

export function walletKind(w: Pick<Wallet, "surveyId" | "userId">): WalletKind {
  return w.surveyId ? "project" : w.userId ? "user" : "workspace";
}

/** The balance that may leave a wallet: what is there minus what open reservations hold. Never overdraft room. */
export function transferableBalance(w: Pick<Wallet, "balance" | "reserved">): number {
  return money6(Math.max(0, w.balance - w.reserved));
}

export interface UsageEvent {
  id: string;
  customerId: string;
  surveyId: string | null;
  userId: string | null;
  walletId: string | null;
  eventType: string;
  category: UsageCategory;
  environment: Environment;
  provider: string | null;
  service: string | null;
  model: string | null;
  quantity: number;
  unit: string;
  inputUnits: number | null;
  outputUnits: number | null;
  providerCost: number;
  infraCost: number;
  paymentFee: number;
  taxReserve: number;
  customerCharge: number;
  grossProfit: number;
  netProfit: number;
  marginPct: number;
  reservationId: string | null;
  /** a reversal / adjustment points at the event it corrects; the original is never edited */
  adjustsEventId: string | null;
  metadata: Record<string, unknown>;
  createdAt: string;
}

export type ReservationStatus = "held" | "settled" | "released" | "expired";
export interface Reservation {
  id: string;
  walletId: string;
  customerId: string;
  surveyId: string | null;
  userId: string | null;
  eventType: string;
  environment: Environment;
  estimatedCost: number;
  reservedAmount: number;
  status: ReservationStatus;
  actualCharge: number | null;
  createdAt: string;
  expiresAt: string;
  settledAt: string | null;
}

export interface CreditRequest {
  id: string;
  customerId: string;
  surveyId: string | null;
  walletId: string | null;
  userId: string;
  requestedAmount: number;
  reason: string;
  message: string | null;
  status: "pending" | "approved" | "rejected";
  decidedBy: string | null;
  decidedAt: string | null;
  decidedAmount: number | null;
  adminNote: string | null;
  createdAt: string;
}

/* -------------------------------------------------------------- balance */

/** Spendable now: balance minus open reservations (plus the overdraft room when allowed). */
export function availableBalance(w: Pick<Wallet, "balance" | "reserved" | "overdraftEnabled" | "overdraftLimit">, cfg: BillingConfig): number {
  const overdraft = (w.overdraftEnabled ?? cfg.overdraftEnabled) ? (w.overdraftLimit ?? cfg.overdraftLimit) : 0;
  return money6(w.balance - w.reserved + overdraft - cfg.minimumRemainingBalance);
}

export function balanceLevel(balance: number, cfg: BillingConfig): BalanceLevel {
  if (balance <= cfg.readOnlyThreshold) return "locked";
  if (balance <= cfg.criticalBalanceThreshold) return "critical";
  if (balance <= cfg.lowBalanceThreshold) return "low";
  return "normal";
}

/** The state a wallet should be in for this balance — suspended is manual and never changed here. */
export function walletStateFor(balance: number, cfg: BillingConfig, current: WalletState = "active"): WalletState {
  if (current === "suspended") return "suspended";
  return balance <= cfg.readOnlyThreshold ? "read_only" : "active";
}

export const READ_ONLY_MESSAGE = "Your project has reached its usage limit. Please request additional credits from your administrator.";
export const LEVEL_MESSAGE: Record<BalanceLevel, string> = {
  normal: "",
  low: "Low balance — this project is close to its usage limit.",
  critical: "Critical balance — billable operations will stop soon.",
  locked: READ_ONLY_MESSAGE,
};

/* -------------------------------------------------------------- summaries */

export interface WalletSummary {
  currency: string;
  initialBalance: number;
  totalAdded: number;
  used: number;
  remaining: number;
  reserved: number;
  available: number;
  level: BalanceLevel;
  state: WalletState;
  costs: { providerCost: number; infraCost: number; paymentFee: number; taxReserve: number; grossProfit: number; netProfit: number; marginPct: number };
  usage: { today: number; thisWeek: number; thisMonth: number; allTime: number };
  events: number;
}

const dayStart = (d: Date) => new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();

export function summarizeWallet(wallet: Wallet, ledger: LedgerEntry[], events: UsageEvent[], cfg: BillingConfig, now = new Date()): WalletSummary {
  const credits = ledger.filter((l) => l.kind === "credit" || (l.kind === "adjustment" && l.amount > 0));
  const initial = credits.length ? credits.reduce((a, b) => (Date.parse(a.createdAt) <= Date.parse(b.createdAt) ? a : b)).amount : 0;
  const live = events.filter((e) => !e.adjustsEventId);
  const used = sumMoney(events.map((e) => e.customerCharge));
  const t0 = dayStart(now);
  const weekStart = t0 - ((now.getDay() + 6) % 7) * 86_400_000; // Monday
  const monthStart = new Date(now.getFullYear(), now.getMonth(), 1).getTime();
  const since = (t: number) => sumMoney(events.filter((e) => Date.parse(e.createdAt) >= t).map((e) => e.customerCharge));
  const balance = wallet.balance;
  return {
    currency: wallet.currency,
    initialBalance: money6(initial),
    totalAdded: money6(wallet.totalAdded),
    used: money6(used),
    remaining: money6(balance),
    reserved: money6(wallet.reserved),
    available: availableBalance(wallet, cfg),
    level: balanceLevel(balance, cfg),
    state: wallet.state === "suspended" ? "suspended" : walletStateFor(balance, cfg, wallet.state),
    costs: {
      providerCost: sumMoney(events.map((e) => e.providerCost)),
      infraCost: sumMoney(events.map((e) => e.infraCost)),
      paymentFee: sumMoney(events.map((e) => e.paymentFee)),
      taxReserve: sumMoney(events.map((e) => e.taxReserve)),
      grossProfit: sumMoney(events.map((e) => e.grossProfit)),
      netProfit: sumMoney(events.map((e) => e.netProfit)),
      marginPct: pctOf(sumMoney(events.map((e) => e.netProfit)), used),
    },
    usage: { today: since(t0), thisWeek: since(weekStart), thisMonth: since(monthStart), allTime: money6(used) },
    events: live.length,
  };
}

export interface CategoryUsage { category: UsageCategory; charge: number; actualCost: number; events: number; quantity: number }

export function usageByCategory(events: UsageEvent[]): CategoryUsage[] {
  const m = new Map<UsageCategory, CategoryUsage>();
  for (const e of events) {
    const c = m.get(e.category) ?? { category: e.category, charge: 0, actualCost: 0, events: 0, quantity: 0 };
    c.charge = money6(c.charge + e.customerCharge);
    c.actualCost = money6(c.actualCost + e.providerCost + e.infraCost);
    c.events += 1; c.quantity += e.quantity;
    m.set(e.category, c);
  }
  return [...m.values()].sort((a, b) => b.charge - a.charge);
}

export interface TimelinePoint { day: string; charge: number; actualCost: number; events: number }

/** Daily totals for the last `days` days, zero-filled, oldest first. */
export function usageTimeline(events: UsageEvent[], days = 30, now = new Date()): TimelinePoint[] {
  const out: TimelinePoint[] = [];
  const t0 = dayStart(now);
  for (let i = days - 1; i >= 0; i--) {
    const d = new Date(t0 - i * 86_400_000);
    out.push({ day: d.toISOString().slice(0, 10), charge: 0, actualCost: 0, events: 0 });
  }
  const idx = new Map(out.map((p, i) => [p.day, i]));
  for (const e of events) {
    const key = new Date(dayStart(new Date(e.createdAt))).toISOString().slice(0, 10);
    const i = idx.get(key);
    if (i == null) continue;
    out[i].charge = money6(out[i].charge + e.customerCharge);
    out[i].actualCost = money6(out[i].actualCost + e.providerCost + e.infraCost);
    out[i].events += 1;
  }
  return out;
}

export interface Forecast {
  windowDays: number;
  averageDailyUsage: number;
  /** null when there is no usage to project from */
  estimatedRemainingDays: number | null;
  /** change of the last window against the one before it, in percent; null when the previous window is empty */
  trendPct: number | null;
  previousWindowUsage: number;
  currentWindowUsage: number;
}

/** Average daily usage over the configured window, days of balance left at that pace, and the trend against the previous window. Informational only. */
export function forecastUsage(balance: number, events: UsageEvent[], cfg: BillingConfig, now = new Date()): Forecast {
  const w = cfg.forecastWindowDays;
  const end = dayStart(now) + 86_400_000;
  const cur0 = end - w * 86_400_000, prev0 = cur0 - w * 86_400_000;
  const inRange = (a: number, b: number) => sumMoney(events.filter((e) => { const t = Date.parse(e.createdAt); return t >= a && t < b; }).map((e) => e.customerCharge));
  const cur = inRange(cur0, end), prev = inRange(prev0, cur0);
  const avg = money6(cur / w);
  return {
    windowDays: w,
    averageDailyUsage: avg,
    estimatedRemainingDays: avg > 0 ? Math.max(0, Math.floor(balance / avg)) : null,
    trendPct: prev > 0 ? Math.round(((cur - prev) / prev) * 100) : null,
    previousWindowUsage: prev,
    currentWindowUsage: cur,
  };
}

/** Usage per project for the user-level page. */
export function usageByProject(events: UsageEvent[]): { surveyId: string | null; charge: number; actualCost: number; events: number }[] {
  const m = new Map<string | null, { surveyId: string | null; charge: number; actualCost: number; events: number }>();
  for (const e of events) {
    const c = m.get(e.surveyId) ?? { surveyId: e.surveyId, charge: 0, actualCost: 0, events: 0 };
    c.charge = money6(c.charge + e.customerCharge); c.actualCost = money6(c.actualCost + e.providerCost + e.infraCost); c.events += 1;
    m.set(e.surveyId, c);
  }
  return [...m.values()].sort((a, b) => b.charge - a.charge);
}

/* ------------------------------------------------- the project card's meter */

/**
 * ONE PROJECT'S WALLET, AS A CARD SHOWS IT.
 *
 * The four numbers a researcher reads on the projects list — what was put in,
 * what has gone, what is left, and how far through the meter is — plus the
 * word for the state. It lives here, beside `summarizeWallet`, because the
 * dashboard must not do its own arithmetic: a balance that reads $56.75 on
 * the list and something else inside the project is one system telling a
 * person two different things, and they have no way to know which is true.
 *
 * `used` is the sum of the CUSTOMER CHARGES on the project's events, exactly
 * as `summarizeWallet` computes it, falling back to the wallet's own running
 * total when the caller has not loaded events. There is no cost, margin or
 * profit field on the result — a researcher's card has nowhere to put one.
 */
export interface ProjectMeter {
  surveyId: string;
  currency: string;
  /** credits put into this wallet, ever */
  allocated: number;
  used: number;
  /** what is left: the wallet balance */
  remaining: number;
  /** held by operations in flight — not spendable, not yet spent */
  reserved: number;
  available: number;
  /** 0–100 of `allocated`. A wallet nothing was ever put into reads 0. */
  usedPct: number;
  level: BalanceLevel;
  state: WalletState;
  events: number;
}

export function projectMeter(
  w: Wallet,
  usage: { charge: number; events: number } | undefined,
  cfg: BillingConfig,
): ProjectMeter {
  const used = money6(usage?.charge ?? w.totalUsed);
  const allocated = money6(w.totalAdded);
  return {
    surveyId: w.surveyId ?? "",
    currency: w.currency,
    allocated,
    used,
    remaining: money6(w.balance),
    reserved: money6(w.reserved),
    available: availableBalance(w, cfg),
    /* two decimals: a wallet is money, and "43.25% of $100" is the same
       statement as "$43.25 used". Trailing zeros never render, so a round
       half reads 50%, not 50.00%. */
    usedPct: allocated > 0 ? Math.min(100, Math.max(0, Math.round((used / allocated) * 10000) / 100)) : 0,
    level: balanceLevel(w.balance, cfg),
    state: walletStateFor(w.balance, cfg, w.state),
    events: usage?.events ?? 0,
  };
}

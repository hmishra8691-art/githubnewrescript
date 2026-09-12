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

/* ------------------------------------------------- project spending policy */

/**
 * WHAT A PROJECT MAY TAKE FROM THE WALLET IT DRAWS ON.
 *
 * A project no longer holds money. It holds a POLICY against the wallet of
 * the person who owns it, and a record of what it has actually spent. The
 * distinction matters everywhere: raising a limit from $1 to $100 moves
 * nothing, it changes permission, and the wallet's balance is identical
 * before and after.
 *
 *   shared   — no limit of its own; bounded only by the wallet
 *   budget   — may consume at most `budgetLimit` from that wallet, ever
 *   priority — shared, and marked as the study the wallet is mainly for
 *
 * `priority` grants no privilege of its own, deliberately. With every other
 * project capped, the priority project already has whatever the others cannot
 * take; giving it a second mechanism — a reservation only it may spend —
 * would be two ways to express one intention, and the second one would
 * disagree with the first the first time somebody edited a budget.
 */
export const SPENDING_MODES = ["shared", "budget", "priority"] as const;
export type SpendingMode = (typeof SPENDING_MODES)[number];

export interface ProjectSpending {
  surveyId: string;
  customerId: string;
  mode: SpendingMode;
  /** only meaningful in `budget` mode */
  budgetLimit: number | null;
  /** customer charges attributed to this project, cumulative */
  spent: number;
  /** held by this project's operations in flight */
  reserved: number;
  state: "active" | "frozen";
  frozenAt: string | null;
}

/** A project with no policy row yet behaves as `shared`, which is the default. */
export function defaultSpending(surveyId: string, customerId: string): ProjectSpending {
  return { surveyId, customerId, mode: "shared", budgetLimit: null, spent: 0, reserved: 0, state: "active", frozenAt: null };
}

/**
 * What this project may still spend under its own policy — `null` for "no
 * limit of its own". Counts its own holds, so two concurrent operations
 * cannot both be told there is room for the last dollar.
 */
export function projectHeadroom(p: ProjectSpending | null | undefined): number | null {
  if (!p) return null;
  if (p.state === "frozen") return 0;
  if (p.mode !== "budget" || p.budgetLimit == null) return null;
  return Math.max(0, money6(p.budgetLimit - p.spent - p.reserved));
}

/** The state a policy should be in for what has been spent under it. */
export function spendingStateFor(p: ProjectSpending): "active" | "frozen" {
  return p.mode === "budget" && p.budgetLimit != null && money6(p.spent + p.reserved) >= p.budgetLimit ? "frozen" : "active";
}

export const PROJECT_FROZEN_MESSAGE = "This project has reached its own spending limit. Raise the limit to continue — the rest of your wallet is unaffected.";

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
 * ONE PROJECT, AS A CARD SHOWS IT.
 *
 * The model changed under this type and the type changed with it. A project
 * no longer holds money, so there is no "balance of this project" to show;
 * what a researcher needs to know from a list of projects is:
 *
 *   · what this project has SPENT,
 *   · what it may still spend, and WHY that is the number — its own limit,
 *     or simply what is left in the wallet it draws on,
 *   · whether it is running, and if not, which of the two rules stopped it.
 *
 * `limit` and `allowance` are the honest pair. `limit` is the project's own
 * budget when it has one and `null` when it does not — a shared project is
 * not "limited to the wallet balance", it is unlimited and merely funded by
 * a wallet that can run out. `allowance` is what can actually be spent right
 * now, which is the smaller of the two, and is what the meter bar fills
 * against.
 *
 * It lives here, beside `summarizeWallet`, because no screen may do this
 * arithmetic itself: a figure that reads one way on the dashboard and another
 * inside the project is one system telling a person two different things.
 * There is no cost, margin or profit field — a researcher's card has nowhere
 * to put one.
 */
export interface ProjectMeter {
  surveyId: string;
  currency: string;
  /** customer charges attributed to this project */
  used: number;
  /** its own budget, or `null` when it spends freely from the wallet */
  limit: number | null;
  mode: SpendingMode;
  /** what it may still spend now: its own headroom, or the wallet's available balance */
  allowance: number;
  /** what the wallet funding it holds — the same number on every project that shares it */
  walletRemaining: number;
  /** held by this project's operations in flight */
  reserved: number;
  /** 0–100 against the limit when there is one, else against the wallet */
  usedPct: number;
  level: BalanceLevel;
  /** why it is or is not running */
  state: "active" | "frozen" | "read_only" | "suspended";
  events: number;

  /*
   * The wallet figures, for a screen that wants to say "of your $500". They
   * are the WALLET's, not the project's, and are named so that nothing can
   * mistake one for the other.
   */
  walletAllocated: number;
  walletUsed: number;
}

export function projectMeter(
  w: Wallet,
  usage: { charge: number; events: number } | undefined,
  cfg: BillingConfig,
  spending?: ProjectSpending | null,
): ProjectMeter {
  const used = money6(usage?.charge ?? spending?.spent ?? 0);
  const walletAvailable = Math.max(0, availableBalance(w, cfg));
  const headroom = projectHeadroom(spending);
  const allowance = headroom == null ? walletAvailable : Math.min(headroom, walletAvailable);
  const walletState = walletStateFor(w.balance, cfg, w.state);
  /*
   * Two decimals: money, and "43.25% of $100" is the same statement as
   * "$43.25 used". A project with no limit is measured against the wallet it
   * draws on, which is the only denominator that means anything for it.
   */
  const denominator = spending?.mode === "budget" && spending.budgetLimit != null ? spending.budgetLimit : money6(used + walletAvailable);
  return {
    surveyId: spending?.surveyId ?? w.surveyId ?? "",
    currency: w.currency,
    used,
    limit: spending?.mode === "budget" ? spending.budgetLimit : null,
    mode: spending?.mode ?? "shared",
    allowance: money6(allowance),
    walletRemaining: money6(w.balance),
    reserved: money6(spending?.reserved ?? 0),
    usedPct: denominator > 0 ? Math.min(100, Math.max(0, Math.round((used / denominator) * 10000) / 100)) : 0,
    /*
     * The level a researcher should act on. A project with its own budget is
     * judged against WHAT IT MAY STILL SPEND, not against the wallet: a study
     * with $0.40 left of its dollar is critical even though the wallet behind
     * it is full, and saying "healthy" there would be a lie the next AI call
     * exposes.
     */
    level: headroom == null ? balanceLevel(w.balance, cfg) : balanceLevel(allowance, cfg),
    state: walletState === "suspended" ? "suspended"
      : spending?.state === "frozen" ? "frozen"
      : walletState === "read_only" ? "read_only"
      : "active",
    events: usage?.events ?? 0,
    walletAllocated: money6(w.totalAdded),
    walletUsed: money6(w.totalUsed),
  };
}

/** The whole wallet, for the person who owns it. */
export interface WalletOverview {
  walletId: string | null;
  currency: string;
  balance: number;
  reserved: number;
  available: number;
  totalAdded: number;
  totalUsed: number;
  transferredOut: number;
  transferredIn: number;
  level: BalanceLevel;
  state: WalletState;
}

export function walletOverview(w: Wallet | null, ledger: LedgerEntry[], cfg: BillingConfig): WalletOverview {
  const sum = (kinds: LedgerKind[]) => money6(ledger.filter((l) => kinds.includes(l.kind)).reduce((a, l) => a + Math.abs(l.amount), 0));
  if (!w) {
    return { walletId: null, currency: cfg.currency, balance: 0, reserved: 0, available: 0, totalAdded: 0, totalUsed: 0, transferredOut: 0, transferredIn: 0, level: "locked", state: "read_only" };
  }
  return {
    walletId: w.id,
    currency: w.currency,
    balance: money6(w.balance),
    reserved: money6(w.reserved),
    available: Math.max(0, availableBalance(w, cfg)),
    totalAdded: money6(w.totalAdded),
    totalUsed: money6(w.totalUsed),
    transferredOut: sum(["transfer_out"]),
    transferredIn: sum(["transfer_in"]),
    level: balanceLevel(w.balance, cfg),
    state: walletStateFor(w.balance, cfg, w.state),
  };
}

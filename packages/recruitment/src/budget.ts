import { round2, round4 } from "./pricing.js";

/**
 * BUDGET CONTROL.
 *
 * The database already refuses an allocation that exceeds the approved budget (0081's
 * `rescript_recruitment_allocate`). This module is what EXPLAINS the budget: where the money has gone, where it
 * is already promised, and — the part that actually saves projects — where it is heading.
 *
 * One distinction governs everything here:
 *
 *     SPENT is what delivered completes have cost. COMMITTED is what placed orders will cost.
 *
 * A dashboard that shows only spend tells a researcher they have £28,000 left on the morning they have already
 * promised £26,000 of it to three vendors. Headroom is budget minus COMMITTED, never budget minus spent, and
 * every function here is written so that the wrong one is hard to ask for.
 *
 * The second idea is the projection. A project is not in trouble when it runs out of money; it is in trouble
 * three days earlier, when the rate it is actually paying per ACCEPTED complete implies it will. Vendors
 * reject more than they said, duplicates get caught, and the cost per usable complete drifts up from the
 * quoted CPI. `project()` extrapolates from what has actually happened rather than from what was quoted.
 */

export interface BudgetInput {
  budget: number;
  /** placed orders at their agreed CPI, whether or not anything has been delivered */
  committed: number;
  /** what delivered-and-accepted completes have cost so far */
  spent: number;
  /** valid accepted completes so far */
  accepted: number;
  /** what the project needs in total */
  required: number;
  /** the cost per valid complete the current allocation expects, for the part not yet delivered */
  plannedCostPerValidComplete?: number | null;
  /** 0–10000; the share of budget at which to raise BudgetThresholdReached */
  alertBps?: number;
}

export interface BudgetState {
  budget: number;
  committed: number;
  spent: number;
  /** budget minus COMMITTED — the money that can still be promised to someone */
  headroom: number;
  /** budget minus spent; shown, but never the basis of a decision */
  unspent: number;
  committedBps: number;
  spentBps: number;
  /** what one accepted complete has actually cost so far, null before anything has been accepted */
  actualCostPerValidComplete: number | null;
  /** valid accepted completes so far */
  accepted: number;
  /** completes still to buy */
  remaining: number;
  /** what finishing the project looks like to cost, from what has actually happened */
  projectedFinalCost: number | null;
  projectedOverrun: number | null;
  /** the alert threshold has been crossed by committed spend */
  overThreshold: boolean;
  /** committed already exceeds the approved budget — this should be impossible and is worth shouting about */
  overCommitted: boolean;
  /** one line a dashboard can show without doing arithmetic of its own */
  summary: string;
}

const bps = (part: number, whole: number): number =>
  whole > 0 ? Math.max(0, Math.round((part / whole) * 10_000)) : 0;

export function budgetState(input: BudgetInput): BudgetState {
  const budget = Math.max(0, input.budget);
  const committed = Math.max(0, input.committed);
  const spent = Math.max(0, input.spent);
  const accepted = Math.max(0, input.accepted);
  const required = Math.max(0, input.required);
  const alertBps = input.alertBps ?? 8000;

  const headroom = round2(budget - committed);
  const remaining = Math.max(0, required - accepted);
  const actual = accepted > 0 ? round4(spent / accepted) : null;

  /*
   * The rate used for the remainder: what the project is ACTUALLY paying, once there is enough of it to mean
   * anything, else what the allocation planned. Fifty completes is not a rate; it is an anecdote, and
   * extrapolating a budget overrun from it would cry wolf on every project in its first hour.
   */
  const planned = input.plannedCostPerValidComplete ?? null;
  const rate = accepted >= 100 && actual !== null ? actual : planned ?? actual;

  const projectedFinalCost = rate === null ? null : round2(spent + remaining * rate);
  const projectedOverrun = projectedFinalCost === null ? null : round2(Math.max(0, projectedFinalCost - budget));

  const committedBps = bps(committed, budget);
  const state: BudgetState = {
    budget: round2(budget), committed: round2(committed), spent: round2(spent),
    headroom, unspent: round2(budget - spent),
    committedBps, spentBps: bps(spent, budget),
    actualCostPerValidComplete: actual,
    accepted, remaining, projectedFinalCost, projectedOverrun,
    overThreshold: budget > 0 && committedBps >= alertBps,
    overCommitted: committed > budget,
    summary: "",
  };
  state.summary = summarise(state);
  return state;
}

function money(n: number): string {
  return n.toLocaleString(undefined, { maximumFractionDigits: 2 });
}

/**
 * The sentence. Written so that the most serious true thing comes first: a projected overrun outranks a
 * threshold crossing, which outranks ordinary progress.
 */
function summarise(s: BudgetState): string {
  if (s.overCommitted) {
    return `Committed ${money(s.committed)} against an approved budget of ${money(s.budget)} — ${money(s.committed - s.budget)} more than was authorised.`;
  }
  if (s.projectedOverrun !== null && s.projectedOverrun > 0) {
    return `On the rate this project is actually paying, finishing it costs about ${money(s.projectedFinalCost!)} — ${money(s.projectedOverrun)} over the ${money(s.budget)} budget. ${s.remaining.toLocaleString()} completes still to buy.`;
  }
  if (s.overThreshold) {
    return `${Math.round(s.committedBps / 100)}% of the ${money(s.budget)} budget is committed; ${money(s.headroom)} can still be promised.`;
  }
  if (s.accepted === 0) {
    return `${money(s.committed)} committed of ${money(s.budget)}; nothing delivered yet.`;
  }
  return `${money(s.spent)} spent and ${money(s.committed)} committed of ${money(s.budget)}; ${money(s.headroom)} can still be promised.`;
}

/**
 * Whether a threshold has just been crossed, as opposed to merely being past.
 *
 * An alert that fires on every order once the project is over 80% is an alert people turn off, so this is a
 * transition: it is true only on the order that takes it past the line.
 */
export function thresholdCrossed(previousCommitted: number, nowCommitted: number, budget: number, alertBps = 8000): boolean {
  if (budget <= 0) return false;
  return bps(nowCommitted, budget) >= alertBps && bps(previousCommitted, budget) < alertBps;
}

/**
 * Can this project still promise `amount` to a vendor?
 *
 * Against HEADROOM, not unspent budget — the whole point of the distinction above. Returns the reason when not,
 * because "no" without a number is not something an operator can act on.
 */
export function canCommit(state: BudgetState, amount: number): { ok: boolean; reason?: string } {
  if (!Number.isFinite(amount) || amount < 0) return { ok: false, reason: "That is not an amount." };
  if (amount <= state.headroom) return { ok: true };
  return {
    ok: false,
    reason: `That order commits ${money(round2(amount))}, but only ${money(state.headroom)} of the ${money(state.budget)} budget is uncommitted. Raise the budget or reduce the order.`,
  };
}

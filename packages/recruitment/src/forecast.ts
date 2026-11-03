import { round2, round4 } from "./pricing.js";

/**
 * FORECASTING (0085) — when will this finish, what will it cost, and when may neither question be answered.
 *
 * The brief's §26 asks for completion and cost projections. The hard part is not the arithmetic; it is the
 * refusal. A projection from 12 completes over 40 minutes is a number with a confidence interval wider than the
 * project, and a researcher who sees "finishes Thursday" does not see the interval — they see Thursday, and they
 * promise Thursday to their client.
 *
 * So this module has two outcomes and no third: a forecast, or an `insufficient` with the reason stated in words
 * and the thresholds that were missed. There is deliberately no "low confidence estimate" escape hatch, because
 * in practice that is read as an estimate.
 *
 * The two gates are independent and both must clear:
 *
 *   SAMPLE   at least 30 accepted completes. Below that the rate is dominated by the arrival of individual
 *            respondents, and the interval on the pace spans a factor of two.
 *   WINDOW   at least 6 hours of field. Survey traffic is diurnal: the first two hours of a launch at 9am in one
 *            country are nothing like the project's average rate, and a forecast from them is a forecast of the
 *            launch, not of the project.
 *
 * A project running at 400/hour clears the sample gate in minutes and still has to wait out the window; that is
 * the gate doing its job, not a bug.
 */

export const MIN_COMPLETES_TO_FORECAST = 30;
export const MIN_HOURS_TO_FORECAST = 6;

export interface FieldObservation {
  /** when the project went live */
  startedAt: string | Date;
  /** the moment the forecast is being made */
  now?: string | Date;
  target: number;
  accepted: number;
  rejected?: number;
  /** committed or spent so far, in the project currency */
  spend?: number | null;
  budget?: number | null;
  currency?: string;
}

export type InsufficientReason = "too_few_completes" | "too_early" | "no_progress" | "not_started";

export interface Insufficient {
  status: "insufficient";
  reason: InsufficientReason;
  /** a sentence a researcher can read without translating it */
  explanation: string;
  completes: number;
  hoursElapsed: number;
  needCompletes: number;
  needHours: number;
}

export interface Forecast {
  status: "forecast";
  completes: number;
  target: number;
  hoursElapsed: number;
  /** accepted completes per hour over the whole field period so far */
  ratePerHour: number;
  remaining: number;
  /** hours of field still needed at the observed rate; null when already complete */
  hoursToComplete: number | null;
  completionAt: string | null;
  /** the same projection on the pessimistic and optimistic ends of the pace interval */
  completionRange: { earliest: string; latest: string } | null;
  projectedCost: number | null;
  budget: number | null;
  /** true when the projected cost exceeds the budget — a thing to say out loud, not to bury in a field */
  overBudget: boolean;
  currency: string | null;
  /** rejection rate so far, as a percentage; null when nothing has been screened */
  rejectionRate: number | null;
}

function toDate(v: string | Date): Date {
  return v instanceof Date ? v : new Date(v);
}

/**
 * Project completion and cost — or say why neither can be projected yet.
 *
 * The pace interval is a plain √n Poisson band on the arrival count (completes arrive independently; the count
 * over a fixed window is Poisson to a good approximation). It is wide, and it is meant to be: the range is the
 * honest part of the answer and the point estimate is the convenient one.
 */
export function forecast(o: FieldObservation): Forecast | Insufficient {
  const now = toDate(o.now ?? new Date());
  const started = toDate(o.startedAt);
  const accepted = Math.max(0, Math.floor(o.accepted ?? 0));
  const target = Math.max(0, Math.floor(o.target ?? 0));
  const msElapsed = now.getTime() - started.getTime();
  const hoursElapsed = round2(Math.max(0, msElapsed) / 3_600_000);

  const base = {
    completes: accepted,
    hoursElapsed,
    needCompletes: MIN_COMPLETES_TO_FORECAST,
    needHours: MIN_HOURS_TO_FORECAST,
  };

  if (!Number.isFinite(msElapsed) || msElapsed < 0) {
    return {
      status: "insufficient", reason: "not_started", ...base,
      explanation: "The project has no field start time in the past, so there is no elapsed period to measure a rate over.",
    };
  }
  if (accepted === 0) {
    return {
      status: "insufficient", reason: "no_progress", ...base,
      explanation: hoursElapsed >= MIN_HOURS_TO_FORECAST
        ? `No accepted completes after ${hoursElapsed.toFixed(1)} hours in field. That is itself worth investigating — check the links, the quotas and the screener — but it is not something to forecast from.`
        : "No accepted completes yet.",
    };
  }
  if (accepted < MIN_COMPLETES_TO_FORECAST) {
    return {
      status: "insufficient", reason: "too_few_completes", ...base,
      explanation: `${accepted} accepted ${accepted === 1 ? "complete" : "completes"} is too few to project from — the arrival of one more respondent would move the finish date by hours. Forecasting starts at ${MIN_COMPLETES_TO_FORECAST}.`,
    };
  }
  if (hoursElapsed < MIN_HOURS_TO_FORECAST) {
    return {
      status: "insufficient", reason: "too_early", ...base,
      explanation: `Only ${hoursElapsed.toFixed(1)} hours in field. Response rates follow the clock in each market, so a rate measured over the first few hours is the rate of the launch, not of the project. Forecasting starts at ${MIN_HOURS_TO_FORECAST} hours.`,
    };
  }

  const ratePerHour = round4(accepted / hoursElapsed);
  const remaining = Math.max(0, target - accepted);

  // Poisson band on the count, carried through to the rate. Floor the low end so it can never be zero or negative.
  const sd = Math.sqrt(accepted);
  const rateLow = Math.max(accepted * 0.05, accepted - 1.96 * sd) / hoursElapsed;
  const rateHigh = (accepted + 1.96 * sd) / hoursElapsed;

  const hoursToComplete = remaining === 0 ? null : round2(remaining / ratePerHour);
  const at = (h: number) => new Date(now.getTime() + h * 3_600_000).toISOString();
  const completionAt = hoursToComplete === null ? null : at(hoursToComplete);
  const completionRange = remaining === 0 ? null : {
    earliest: at(remaining / rateHigh),  // faster rate → sooner
    latest: at(remaining / rateLow),
  };

  const costPerAccepted = typeof o.spend === "number" && o.spend > 0 ? o.spend / accepted : null;
  const projectedCost = costPerAccepted === null ? null : round2(costPerAccepted * Math.max(accepted, target));
  const budget = typeof o.budget === "number" ? round2(o.budget) : null;

  const rejected = Math.max(0, Math.floor(o.rejected ?? 0));
  const screened = accepted + rejected;

  return {
    status: "forecast",
    completes: accepted, target, hoursElapsed, ratePerHour, remaining,
    hoursToComplete, completionAt, completionRange,
    projectedCost, budget,
    overBudget: projectedCost !== null && budget !== null && projectedCost > budget,
    currency: o.currency ?? null,
    rejectionRate: screened > 0 ? round2((rejected / screened) * 100) : null,
  };
}

/** For the UI and the stored row: one sentence, whichever branch came back. */
export function forecastStatement(f: Forecast | Insufficient): string {
  if (f.status === "insufficient") return f.explanation;
  if (f.remaining === 0) return `Target reached: ${f.completes.toLocaleString()} of ${f.target.toLocaleString()} accepted completes.`;
  const days = (f.hoursToComplete ?? 0) / 24;
  const when = days >= 2 ? `${days.toFixed(1)} days` : `${(f.hoursToComplete ?? 0).toFixed(1)} hours`;
  const cost = f.projectedCost !== null
    ? ` Projected total ${f.currency ?? ""} ${f.projectedCost.toLocaleString()}${f.overBudget ? " — over budget" : ""}.`
    : "";
  return `${f.remaining.toLocaleString()} to go at ${f.ratePerHour.toFixed(1)}/hour: about ${when} of field.${cost}`;
}

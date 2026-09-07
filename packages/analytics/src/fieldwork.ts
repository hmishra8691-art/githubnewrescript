/**
 * FIELDWORK PACE — the arithmetic behind the §26 dashboard.
 *
 * The database returns counts (0019). This turns counts into the two sentences
 * a fieldwork manager actually needs:
 *
 *     "412 of 600. At the rate of the last six hours you finish on Thursday
 *      afternoon — two days past the close date."
 *
 * It is pure and lives here rather than in the route because every hard part
 * is a judgement call that deserves a test, and because a number this load-
 * bearing must not be first computed inside a JSX expression.
 *
 * ## THE FOUR JUDGEMENTS
 *
 * 1. THE RATE COMES FROM A RECENT WINDOW, NOT THE WHOLE FIELD. Averaging over
 *    the entire field period is the intuitive thing and it is wrong in the one
 *    situation that matters: a survey that delivered 300 completes on day one
 *    and nothing since has a magnificent lifetime average and is dead. The
 *    recent rate is what predicts; the lifetime rate is what reassures.
 *
 * 2. AN ANSWER THAT ISN'T KNOWN IS "unknown", NOT A GUESS. No target, no
 *    completes yet, a rate of zero — each of these makes a projection
 *    impossible rather than large. A projected finish date of the year 2400
 *    is not a cautious estimate, it is a bug that looks like an opinion.
 *
 * 3. "BEHIND" IS RELATIVE TO THE CLOSE DATE, NOT TO THE CALENDAR. A survey
 *    with 10% of its completes is not behind if it opened this morning and
 *    runs for three weeks. Pace compares the fraction DELIVERED with the
 *    fraction of the FIELD WINDOW ELAPSED, which is why §60's `fieldwork_from`
 *    and `fieldwork_to` (0015) are inputs here.
 *
 * 4. STALLED IS ITS OWN VERDICT. "Behind" says push harder. "Stalled" says
 *    something is broken — the link, the supplier, the quota — and no amount
 *    of pushing will help until somebody looks. Conflating them costs a day.
 */

/** A bucket as `rescript_field_timeline` returns it. */
export interface FieldBucket {
  /** ISO instant of the bucket's first moment, in the caller's zone. */
  bucketStart: string;
  starts: number;
  completes: number;
  screened: number;
  quotaFull: number;
  terminated: number;
  medianSeconds: number | null;
}

export type BucketSize = "hour" | "day" | "week";

export type PaceVerdict =
  /** target met or passed */
  | "done"
  /** delivering faster than the window requires */
  | "ahead"
  /** within tolerance of the required rate */
  | "on_track"
  /** delivering, but not fast enough to finish in the window */
  | "behind"
  /** nothing has arrived for long enough that something is probably wrong */
  | "stalled"
  /** not enough information to say — say so */
  | "unknown";

export interface PaceInput {
  /** completes so far, in this environment */
  completes: number;
  /** the contracted number, from the project or the sum of supplier targets */
  target: number | null;
  /** §60 field window (0015). Dates, not instants — see `dayEnd` below. */
  fieldFrom?: string | null;
  fieldTo?: string | null;
  /** completes in the recent window, and how long that window was */
  recentCompletes?: number | null;
  recentHours?: number | null;
  /** when the last complete landed, for the stall test */
  lastCompleteAt?: string | null;
  /** evaluated at this instant; injected so the tests are not clock-dependent */
  now: string;
  /** no completes for this long, while the field is open, is a stall */
  stallHours?: number;
}

export interface Pace {
  verdict: PaceVerdict;
  completes: number;
  target: number | null;
  /** how many still to get; null when there is no target */
  remaining: number | null;
  /** 0..1 of the target delivered; null when there is no target */
  delivered: number | null;
  /** 0..1 of the field window elapsed; null when the window is unknown */
  elapsed: number | null;
  /** completes per day observed in the recent window; null when unknown */
  ratePerDay: number | null;
  /** completes per day needed from now to hit the target by the close date */
  requiredPerDay: number | null;
  /** ISO date of the projected finish; null when it cannot be projected */
  projectedFinish: string | null;
  /** whole days early (negative) or late (positive) against the close date */
  daysLate: number | null;
  /** hours since the last complete; null when there has never been one */
  quietHours: number | null;
}

const HOUR_MS = 3_600_000;
const DAY_MS = 86_400_000;

/** Within this fraction of the required rate counts as on track, not behind. */
const ON_TRACK_TOLERANCE = 0.9;

const ms = (iso: string | null | undefined): number | null => {
  if (!iso) return null;
  const t = Date.parse(iso);
  return Number.isFinite(t) ? t : null;
};

/**
 * A field window's end is the END of that day.
 *
 * `fieldwork_to` is a DATE (0015): a field closing "on the 12th" closes at the
 * end of the 12th, not at midnight as it begins. Treating it as an instant
 * loses a full day of field on every project, and reports every survey as a
 * day later than it is.
 */
const dayEnd = (iso: string): number | null => {
  const t = ms(iso);
  if (t === null) return null;
  // a bare date parses as UTC midnight; anything with a time is taken as given
  return /^\d{4}-\d{2}-\d{2}$/.test(iso.trim()) ? t + DAY_MS - 1 : t;
};

/**
 * How is the field going?
 *
 * Every field of the result is independently nullable, because a fieldwork
 * dashboard is asked about half-configured projects constantly — a survey in
 * field with no target, a target with no dates, a project set up but not yet
 * launched — and each of those has some answers and not others. Returning
 * zeroes for the unknowns would be reporting confidence nobody has.
 */
export function fieldPace(input: PaceInput): Pace {
  const now = ms(input.now) ?? Date.now();
  const completes = Math.max(0, Math.floor(input.completes || 0));
  const target = input.target != null && input.target > 0 ? Math.floor(input.target) : null;

  const remaining = target === null ? null : Math.max(0, target - completes);
  const delivered = target === null ? null : Math.min(1, completes / target);

  const from = input.fieldFrom ? ms(input.fieldFrom) : null;
  const to = input.fieldTo ? dayEnd(input.fieldTo) : null;
  const haveWindow = from !== null && to !== null && to > from;

  const elapsed = haveWindow
    ? Math.min(1, Math.max(0, (now - from!) / (to! - from!)))
    : null;

  /*
   * The observed rate. `recentHours` is the width of the window the caller
   * measured over — normally the last 24 hours — and a zero-count recent
   * window is a real rate of zero, not a missing one, which is what lets the
   * stall test below fire.
   */
  const recentHours = input.recentHours != null && input.recentHours > 0 ? input.recentHours : null;
  const ratePerDay =
    recentHours !== null && input.recentCompletes != null
      ? (input.recentCompletes / recentHours) * 24
      : null;

  /*
   * What the close date demands FROM NOW. Not "target / total field days",
   * which answers a question about the past: a project that lost its first
   * week needs a higher rate for the rest, and saying so is the point.
   */
  let requiredPerDay: number | null = null;
  if (remaining !== null && to !== null) {
    const daysLeft = (to - now) / DAY_MS;
    requiredPerDay = remaining === 0 ? 0 : daysLeft > 0 ? remaining / daysLeft : Infinity;
  }

  /*
   * The projection. Deliberately refuses in three cases rather than
   * extrapolating: no target (nothing to finish), no observed rate (nothing to
   * extrapolate), and a rate of zero (a finish date at infinity is not an
   * estimate).
   */
  let projectedFinish: string | null = null;
  let daysLate: number | null = null;
  if (remaining !== null && ratePerDay !== null && ratePerDay > 0) {
    const finish = remaining === 0 ? now : now + (remaining / ratePerDay) * DAY_MS;
    projectedFinish = new Date(finish).toISOString();
    if (to !== null) {
      // whole days, rounded towards "late": half a day late is late
      daysLate = Math.ceil((finish - to) / DAY_MS);
    }
  }

  const lastComplete = ms(input.lastCompleteAt);
  const quietHours = lastComplete === null ? null : Math.max(0, (now - lastComplete) / HOUR_MS);

  return {
    verdict: verdictOf({
      completes, target, remaining, delivered, elapsed,
      ratePerDay, requiredPerDay, quietHours,
      fieldOpen: haveWindow ? now >= from! && now <= to! : null,
      stallHours: input.stallHours ?? 6,
    }),
    completes, target, remaining, delivered, elapsed,
    ratePerDay, requiredPerDay, projectedFinish, daysLate, quietHours,
  };
}

function verdictOf(a: {
  completes: number;
  target: number | null;
  remaining: number | null;
  delivered: number | null;
  elapsed: number | null;
  ratePerDay: number | null;
  requiredPerDay: number | null;
  quietHours: number | null;
  fieldOpen: boolean | null;
  stallHours: number;
}): PaceVerdict {
  if (a.target !== null && a.remaining === 0) return "done";

  /*
   * STALLED FIRST, and only while the field is supposed to be open. A survey
   * that closed last week has been quiet for a week and is not stalled; a
   * survey in field that has been quiet for six hours is the thing somebody
   * needs to be told about before anything else on this page.
   *
   * `fieldOpen === null` — no dates configured — still allows a stall, because
   * a survey taking responses has evidently been launched whether or not
   * anybody filled in the project panel.
   */
  if (a.fieldOpen !== false && a.quietHours !== null && a.quietHours >= a.stallHours) {
    return "stalled";
  }

  /* Nothing has ever arrived: not stalled, not behind — just not started. */
  if (a.completes === 0 && a.quietHours === null) return "unknown";

  if (a.requiredPerDay === null || a.ratePerDay === null) {
    /*
     * No target or no close date. There is still one honest comparison left:
     * delivered against elapsed, which needs both a target and a window — and
     * if we had both we would have had requiredPerDay. So: unknown.
     */
    return "unknown";
  }

  if (!Number.isFinite(a.requiredPerDay)) {
    /* The close date has passed and completes are still owed. */
    return "behind";
  }
  if (a.requiredPerDay === 0) return "done";
  if (a.ratePerDay >= a.requiredPerDay) return "ahead";
  if (a.ratePerDay >= a.requiredPerDay * ON_TRACK_TOLERANCE) return "on_track";
  return "behind";
}

/**
 * The verdict as a sentence, because a coloured chip that says "BEHIND"
 * without a number is a decoration.
 *
 * Kept beside the arithmetic, and tested, so the words cannot drift from the
 * thresholds that produce them.
 */
export function describePace(p: Pace): string {
  const n = (v: number) => (Math.round(v * 10) / 10).toLocaleString("en-GB");

  switch (p.verdict) {
    case "done":
      return p.target === null
        ? `${p.completes.toLocaleString("en-GB")} completes.`
        : `Target met — ${p.completes.toLocaleString("en-GB")} of ${p.target.toLocaleString("en-GB")}.`;
    case "stalled": {
      const quiet = p.quietHours === null ? "" : ` Nothing for ${n(p.quietHours)} hour${p.quietHours >= 2 ? "s" : ""}.`;
      return `Field looks stalled.${quiet} Check the link, the supplier and the quotas before pushing for more sample.`;
    }
    case "unknown": {
      if (p.target === null) return `${p.completes.toLocaleString("en-GB")} completes. Set a target to see pace.`;
      if (p.completes === 0) return `No completes yet — ${p.target.toLocaleString("en-GB")} to go.`;
      return `${p.completes.toLocaleString("en-GB")} of ${p.target.toLocaleString("en-GB")}. Set fieldwork dates to see whether that is on pace.`;
    }
    case "ahead":
    case "on_track":
    case "behind": {
      const head = `${p.completes.toLocaleString("en-GB")} of ${(p.target ?? 0).toLocaleString("en-GB")}`;
      const rate = p.ratePerDay === null ? "" : ` at ${n(p.ratePerDay)}/day`;
      const need = p.requiredPerDay === null || !Number.isFinite(p.requiredPerDay)
        ? ""
        : ` against ${n(p.requiredPerDay)}/day needed`;
      if (p.daysLate === null) return `${head}${rate}${need}.`;
      if (p.daysLate > 0) return `${head}${rate}${need} — ${p.daysLate} day${p.daysLate === 1 ? "" : "s"} past the close date.`;
      if (p.daysLate === 0) return `${head}${rate}${need} — finishing on the close date.`;
      return `${head}${rate}${need} — ${-p.daysLate} day${p.daysLate === -1 ? "" : "s"} early.`;
    }
  }
}

/**
 * The bucket that makes a window readable.
 *
 * A chart has room for something like 12–100 bars. Two days of hours is 48 and
 * reads well; two months of hours is 1 440 and reads as a smear, and 0019
 * refuses more than 2 000 of them anyway. This picks the finest bucket whose
 * count lands in that range, so a caller can say "the last 90 days" without
 * also having to know what that means for a bar chart.
 */
export function chooseBucket(fromIso: string, toIso: string): BucketSize {
  const from = ms(fromIso);
  const to = ms(toIso);
  if (from === null || to === null || to <= from) return "day";
  const hours = (to - from) / HOUR_MS;
  if (hours <= 96) return "hour";      // up to four days
  if (hours <= 24 * 120) return "day"; // up to four months
  return "week";
}

/**
 * Totals over a series, and the busiest bucket.
 *
 * `starts` and the outcomes are summed separately and deliberately not
 * reconciled: a start is counted when the respondent arrived and an outcome
 * when they finished, so within any window the two do not balance (0019). A
 * helper that returned a single "total" would be inviting somebody to subtract
 * them and get a negative number of partials.
 */
export function summariseSeries(buckets: FieldBucket[]): {
  starts: number;
  completes: number;
  screened: number;
  quotaFull: number;
  terminated: number;
  /** of everyone who reached an outcome, the share that qualified */
  incidence: number | null;
  peak: FieldBucket | null;
  /** buckets with no activity of any kind */
  quietBuckets: number;
} {
  let starts = 0, completes = 0, screened = 0, quotaFull = 0, terminated = 0, quietBuckets = 0;
  let peak: FieldBucket | null = null;

  for (const b of buckets) {
    starts += b.starts;
    completes += b.completes;
    screened += b.screened;
    quotaFull += b.quotaFull;
    terminated += b.terminated;
    const any = b.starts + b.completes + b.screened + b.quotaFull + b.terminated;
    if (any === 0) quietBuckets++;
    if (peak === null || b.completes > peak.completes) peak = b;
  }

  const outcomes = completes + screened + quotaFull + terminated;
  return {
    starts, completes, screened, quotaFull, terminated,
    incidence: outcomes === 0 ? null : Math.round((completes / outcomes) * 1000) / 10,
    /* a peak of zero completes is not a peak */
    peak: peak && peak.completes > 0 ? peak : null,
    quietBuckets,
  };
}

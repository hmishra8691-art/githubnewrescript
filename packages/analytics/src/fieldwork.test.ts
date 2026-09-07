import { test } from "node:test";
import assert from "node:assert/strict";
import {
  fieldPace, describePace, chooseBucket, summariseSeries,
} from "./fieldwork.js";
import type { FieldBucket, PaceInput } from "./fieldwork.js";

/*
 * A survey contracted for 600 completes, in field from the 1st to the 10th of
 * March, evaluated on the 5th — so the window is 40% elapsed and a good pace
 * is roughly 240 completes.
 */
const base: PaceInput = {
  completes: 240,
  target: 600,
  fieldFrom: "2026-03-01",
  fieldTo: "2026-03-10",
  recentCompletes: 60,
  recentHours: 24,
  lastCompleteAt: "2026-03-05T11:30:00Z",
  now: "2026-03-05T12:00:00Z",
};

const at = (over: Partial<PaceInput>) => fieldPace({ ...base, ...over });

/* --------------------------------------------------------- the arithmetic */

test("delivered and remaining are simple, and clamped", () => {
  const p = at({});
  assert.equal(p.remaining, 360);
  assert.equal(p.delivered, 0.4);

  const over = at({ completes: 640 });
  assert.equal(over.remaining, 0, "you cannot need a negative number of completes");
  assert.equal(over.delivered, 1, "delivered does not exceed 1 when a target is overshot");
});

test("A CLOSE DATE CLOSES AT THE END OF ITS DAY", () => {
  /*
   * `fieldwork_to` is a DATE. Read as an instant it means midnight AS THE DAY
   * BEGINS, which throws away the last day of every project and reports every
   * survey as one day later than it is.
   */
  const p = at({ now: "2026-03-10T18:00:00Z" });
  assert.ok((p.elapsed ?? 0) < 1,
    "6pm on the closing day is not yet the end of the field — read as an instant it would be exactly 1");
  assert.ok(p.requiredPerDay !== null && Number.isFinite(p.requiredPerDay),
    "there are still hours left to deliver in, so the required rate is a number rather than Infinity");
  assert.notEqual(p.verdict, "unknown", "the field is still open on its closing day");
});

test("elapsed is a fraction of the field window, and clamps at both ends", () => {
  assert.equal(at({ now: "2026-02-20T12:00:00Z" }).elapsed, 0, "before the field opens");
  assert.equal(at({ now: "2026-03-20T12:00:00Z" }).elapsed, 1, "after it closes");
  const mid = at({ now: "2026-03-05T12:00:00Z" }).elapsed ?? 0;
  assert.ok(mid > 0.4 && mid < 0.55, `mid-field, got ${mid}`);
});

test("THE RATE COMES FROM THE RECENT WINDOW, NOT THE LIFETIME AVERAGE", () => {
  /*
   * This is the whole point. A survey that delivered 240 completes on day one
   * and nothing since has a lifetime average of 60/day and is dead. The
   * recent window says so.
   */
  const dead = at({ recentCompletes: 0, recentHours: 24, lastCompleteAt: "2026-03-02T09:00:00Z" });
  assert.equal(dead.ratePerDay, 0);
  assert.equal(dead.verdict, "stalled");

  const alive = at({ recentCompletes: 60, recentHours: 24 });
  assert.equal(alive.ratePerDay, 60);
});

test("the required rate is what is needed FROM NOW, not the whole-field average", () => {
  /*
   * 360 to go and 5.5 days left is ~65/day. The naive figure — 600 over 10
   * days = 60/day — would call this project on track when it needs to go
   * faster than it ever has.
   */
  const p = at({});
  assert.ok(p.requiredPerDay !== null);
  assert.ok(p.requiredPerDay! > 64 && p.requiredPerDay! < 67, `got ${p.requiredPerDay}`);
});

test("a passed close date with completes still owed needs an impossible rate", () => {
  const p = at({ now: "2026-03-12T12:00:00Z", lastCompleteAt: "2026-03-12T11:30:00Z" });
  assert.equal(p.requiredPerDay, Infinity);
  assert.equal(p.verdict, "behind", "not 'unknown' — the field is out of time and short");
});

/* ---------------------------------------------------------- the verdicts */

test("ahead / on_track / behind split on the required rate", () => {
  assert.equal(at({ recentCompletes: 100 }).verdict, "ahead");
  assert.equal(at({ recentCompletes: 66 }).verdict, "ahead", "meeting the requirement exactly is ahead");
  assert.equal(at({ recentCompletes: 60 }).verdict, "on_track", "within 10% is on track, not behind");
  assert.equal(at({ recentCompletes: 30 }).verdict, "behind");
});

test("meeting the target is 'done' whatever the rate", () => {
  assert.equal(at({ completes: 600, recentCompletes: 0, lastCompleteAt: "2026-03-01T09:00:00Z" }).verdict, "done");
  assert.equal(at({ completes: 900 }).verdict, "done");
});

test("STALLED IS ITS OWN VERDICT, NOT A FLAVOUR OF BEHIND", () => {
  /*
   * "Behind" means push harder. "Stalled" means something is broken and
   * pushing will not help. Conflating them costs a day of fieldwork.
   */
  const stalled = at({ lastCompleteAt: "2026-03-05T02:00:00Z" }); // 10 hours quiet
  assert.equal(stalled.verdict, "stalled");
  assert.ok((stalled.quietHours ?? 0) > 9);

  const fine = at({ lastCompleteAt: "2026-03-05T10:00:00Z" }); // 2 hours quiet
  assert.notEqual(fine.verdict, "stalled");
});

test("a survey whose field has closed is quiet, not stalled", () => {
  const closed = at({
    now: "2026-03-15T12:00:00Z",
    completes: 600,
    lastCompleteAt: "2026-03-09T18:00:00Z",
  });
  assert.equal(closed.verdict, "done");

  const short = at({
    now: "2026-03-15T12:00:00Z",
    completes: 500,
    lastCompleteAt: "2026-03-09T18:00:00Z",
  });
  assert.equal(short.verdict, "behind", "it closed short — that is behind, not stalled");
});

test("a survey that has not opened yet is not stalled either", () => {
  const p = at({ now: "2026-02-25T12:00:00Z", completes: 0, lastCompleteAt: null, recentCompletes: 0 });
  assert.equal(p.verdict, "unknown");
});

test("AN UNKNOWABLE ANSWER IS 'unknown', NEVER A GUESS", () => {
  const noTarget = at({ target: null });
  assert.equal(noTarget.verdict, "unknown");
  assert.equal(noTarget.remaining, null);
  assert.equal(noTarget.delivered, null);
  assert.equal(noTarget.requiredPerDay, null);
  assert.equal(noTarget.projectedFinish, null);

  const noDates = at({ fieldFrom: null, fieldTo: null });
  assert.equal(noDates.elapsed, null);
  assert.equal(noDates.requiredPerDay, null);
  assert.equal(noDates.daysLate, null);
  assert.equal(noDates.verdict, "unknown");

  const noRate = at({ recentCompletes: null, recentHours: null });
  assert.equal(noRate.ratePerDay, null);
  assert.equal(noRate.projectedFinish, null, "nothing to extrapolate from");
});

test("a zero target is treated as no target, not as an instantly-met one", () => {
  const p = at({ target: 0 });
  assert.equal(p.target, null);
  assert.notEqual(p.verdict, "done");
});

test("a backwards field window is ignored rather than producing a negative fraction", () => {
  const p = at({ fieldFrom: "2026-03-10", fieldTo: "2026-03-01" });
  assert.equal(p.elapsed, null);
});

/* -------------------------------------------------------- the projection */

test("the projection extrapolates the observed rate", () => {
  /* 360 to go at 60/day is six days: the 11th. */
  const p = at({});
  assert.ok(p.projectedFinish);
  assert.match(p.projectedFinish!, /^2026-03-11/);
  assert.equal(p.daysLate, 1, "one day past a close of the 10th");
});

test("A RATE OF ZERO PRODUCES NO PROJECTION, NOT A DATE IN THE YEAR 2400", () => {
  const p = at({ recentCompletes: 0 });
  assert.equal(p.ratePerDay, 0);
  assert.equal(p.projectedFinish, null);
  assert.equal(p.daysLate, null);
});

test("finishing early reports negative days late", () => {
  const p = at({ recentCompletes: 200 }); // 200/day → 360 to go in under two days
  assert.ok(p.daysLate !== null && p.daysLate < 0, `got ${p.daysLate}`);
});

test("an already-met target projects finishing now", () => {
  const p = at({ completes: 600 });
  assert.equal(p.remaining, 0);
  assert.equal(p.projectedFinish, "2026-03-05T12:00:00.000Z");
});

/* ---------------------------------------------------------- the sentence */

test("the sentence carries the numbers behind the verdict", () => {
  const s = describePace(at({}));
  assert.match(s, /240 of 600/);
  assert.match(s, /60\/day/);
  assert.match(s, /needed/);
  assert.match(s, /1 day past the close date/);
});

test("the sentence pluralises, and says 'on the close date' for exactly zero", () => {
  assert.match(describePace(at({ recentCompletes: 40 })), /days past the close date/);
  const onTime = describePace(at({ recentCompletes: 66 }));
  assert.ok(/close date|early/.test(onTime), onTime);
  assert.match(describePace(at({ recentCompletes: 200 })), /day(s)? early/);
});

test("a stalled field is told what to check, not just that it is stalled", () => {
  const s = describePace(at({ lastCompleteAt: "2026-03-05T02:00:00Z" }));
  assert.match(s, /stalled/i);
  assert.match(s, /10 hours/);
  assert.match(s, /link|supplier|quota/);
});

test("the unknown sentences say what is missing rather than apologising", () => {
  assert.match(describePace(at({ target: null })), /Set a target/);
  assert.match(describePace(at({ fieldFrom: null, fieldTo: null })), /Set fieldwork dates/);
  assert.match(
    describePace(at({ completes: 0, target: 600, fieldFrom: null, fieldTo: null, lastCompleteAt: null })),
    /No completes yet/,
  );
});

test("a met target reads as met", () => {
  assert.match(describePace(at({ completes: 600 })), /Target met/);
});

/* ------------------------------------------------------------- the bucket */

test("the bucket is chosen so the chart is readable", () => {
  assert.equal(chooseBucket("2026-03-05T00:00:00Z", "2026-03-06T00:00:00Z"), "hour");
  assert.equal(chooseBucket("2026-03-01T00:00:00Z", "2026-03-04T00:00:00Z"), "hour");
  assert.equal(chooseBucket("2026-03-01T00:00:00Z", "2026-03-20T00:00:00Z"), "day");
  assert.equal(chooseBucket("2026-01-01T00:00:00Z", "2026-06-01T00:00:00Z"), "week");
  assert.equal(chooseBucket("2024-01-01T00:00:00Z", "2026-01-01T00:00:00Z"), "week",
    "two years of hours is 17 000 buckets and 0019 refuses more than 2 000");
});

test("a nonsense window falls back to days rather than throwing", () => {
  assert.equal(chooseBucket("nope", "also nope"), "day");
  assert.equal(chooseBucket("2026-03-05T00:00:00Z", "2026-03-01T00:00:00Z"), "day");
});

/* ------------------------------------------------------------ the series */

const bucket = (b: Partial<FieldBucket>): FieldBucket => ({
  bucketStart: "2026-03-05T09:00:00Z",
  starts: 0, completes: 0, screened: 0, quotaFull: 0, terminated: 0, medianSeconds: null,
  ...b,
});

test("the series totals each column independently", () => {
  const s = summariseSeries([
    bucket({ bucketStart: "2026-03-05T09:00:00Z", starts: 10, completes: 4, screened: 3 }),
    bucket({ bucketStart: "2026-03-05T10:00:00Z", starts: 8, completes: 6, terminated: 1 }),
    bucket({ bucketStart: "2026-03-05T11:00:00Z" }),
  ]);
  assert.equal(s.starts, 18);
  assert.equal(s.completes, 10);
  assert.equal(s.screened, 3);
  assert.equal(s.terminated, 1);
  assert.equal(s.quietBuckets, 1);
});

test("incidence is over outcomes, not over starts", () => {
  /*
   * 10 completes and 4 screen-outs is 71.4% incidence. Dividing by the 18
   * people who STARTED would report 55.6% and be a completion rate wearing
   * incidence's name — the mistake that makes a supplier look like it is
   * sending unqualified sample when it is sending people who abandon.
   */
  const s = summariseSeries([
    bucket({ starts: 18, completes: 10, screened: 4 }),
  ]);
  assert.equal(s.incidence, 71.4);
});

test("incidence over a series with no outcomes is null, not zero", () => {
  const s = summariseSeries([bucket({ starts: 5 })]);
  assert.equal(s.incidence, null);
});

test("the peak bucket is the busiest, and an all-quiet series has none", () => {
  const s = summariseSeries([
    bucket({ bucketStart: "2026-03-05T09:00:00Z", completes: 4 }),
    bucket({ bucketStart: "2026-03-05T10:00:00Z", completes: 9 }),
    bucket({ bucketStart: "2026-03-05T11:00:00Z", completes: 2 }),
  ]);
  assert.equal(s.peak?.bucketStart, "2026-03-05T10:00:00Z");

  assert.equal(summariseSeries([bucket({}), bucket({})]).peak, null,
    "a peak of zero completes is not a peak");
});

test("an empty series summarises to zeroes and nulls without throwing", () => {
  const s = summariseSeries([]);
  assert.equal(s.starts, 0);
  assert.equal(s.incidence, null);
  assert.equal(s.peak, null);
  assert.equal(s.quietBuckets, 0);
});

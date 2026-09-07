/**
 * FIELDWORK OVER TIME (§26) AND LIVE MONITORING (§27), IN THE BROWSER.
 *
 * The bucketing is proved in Postgres (`scripts/fieldwork-sql-test.sql`) and
 * the pace arithmetic in `packages/analytics`. What is left, and what these
 * checks cover, is the panel's contract with the route and the handful of
 * places where a fieldwork screen can be confidently wrong:
 *
 *   · a dead bucket is DRAWN, not skipped — the gap is the signal
 *   · the pace sentence carries the numbers behind the verdict
 *   · a project with no fieldwork dates is told so, not given a chip
 *   · the live half polls with `only=pulse` and does NOT re-run the chart
 *   · a stalled field is distinguished from a slow one, on screen
 *   · the drop-off table admits that a step name is a hint
 *   · migration 0019 missing degrades to a note, not a broken tab
 *
 * The route is intercepted rather than answered by a real database: the
 * container's dev servers hold no Supabase credentials, and the SQL side is
 * already proved elsewhere.
 *
 *   node scripts/fieldwork-time-test.mjs      (studio on 3000)
 */
import { chromium } from "/home/claude/.npm-global/lib/node_modules/playwright/index.mjs";
import assert from "node:assert/strict";

const STUDIO = process.env.STUDIO_URL ?? "http://localhost:3000";
let passed = 0;
const ok = (m) => { console.log("  ok  ", m); passed++; };

/* ------------------------------------------------------------- fixtures */

const HOUR = 3_600_000;
const now = Date.now();
const iso = (msAgo) => new Date(now - msAgo).toISOString();

/**
 * Five hours, the third of them completely dead.
 *
 * The dead hour is the whole reason the series is gapless: a chart fed a
 * missing row draws a straight line across the outage.
 */
const timeline = [
  { bucketStart: iso(4 * HOUR), starts: 40, completes: 18, screened: 9, quotaFull: 0, terminated: 1, medianSeconds: 480 },
  { bucketStart: iso(3 * HOUR), starts: 44, completes: 22, screened: 8, quotaFull: 1, terminated: 0, medianSeconds: 500 },
  { bucketStart: iso(2 * HOUR), starts: 0, completes: 0, screened: 0, quotaFull: 0, terminated: 0, medianSeconds: null },
  { bucketStart: iso(1 * HOUR), starts: 30, completes: 14, screened: 6, quotaFull: 0, terminated: 0, medianSeconds: 470 },
  { bucketStart: iso(0), starts: 12, completes: 6, screened: 2, quotaFull: 0, terminated: 0, medianSeconds: 455 },
];

const pulse = {
  inField: 7, stalled: 41,
  windowMinutes: 60, windowStarts: 30, windowCompletes: 14,
  windowScreened: 6, windowQuotaFull: 0, windowTerminated: 0, windowMedianSeconds: 470,
  totalStarts: 900, totalCompletes: 412, totalPartials: 48,
  lastStartAt: iso(4 * 60_000), lastCompleteAt: iso(11 * 60_000), lastActivityAt: iso(60_000),
  activeSeconds: 900,
};

const positions = [
  { stepIndex: 0, inField: 2, stalled: 4, oldestAt: iso(30 * HOUR), newestAt: iso(60_000) },
  { stepIndex: 2, inField: 4, stalled: 31, oldestAt: iso(50 * HOUR), newestAt: iso(120_000) },
  { stepIndex: 5, inField: 1, stalled: 6, oldestAt: iso(20 * HOUR), newestAt: iso(300_000) },
];

/** 412 of 600, in field 1–10 March, delivering ~56/day. */
const payload = (over = {}) => ({
  available: true,
  environment: "LIVE",
  tz: "Europe/London",
  tzAssumed: false,
  bucket: "hour",
  from: iso(5 * HOUR),
  to: new Date(now).toISOString(),
  project: {
    fieldworkFrom: "2026-03-01", fieldworkTo: "2026-03-10", dueDate: "2026-03-14",
    clientName: "Wilson College", projectManager: "Ada", status: "live",
  },
  target: 600,
  targetSource: "suppliers",
  timeline,
  summary: {
    starts: 126, completes: 60, screened: 25, quotaFull: 1, terminated: 1,
    incidence: 69, peak: timeline[1], quietBuckets: 1,
  },
  pace: {
    verdict: "behind",
    completes: 412, target: 600, remaining: 188, delivered: 0.6867, elapsed: 0.44,
    ratePerDay: 56, requiredPerDay: 66.4,
    projectedFinish: new Date(now + 3.3 * 86_400_000).toISOString(),
    daysLate: 1, quietHours: 0.18,
  },
  pulse,
  positions,
  ...over,
});

/* -------------------------------------------------------------- harness */

const browser = await chromium.launch();
const ctx = await browser.newContext({ viewport: { width: 1440, height: 1400 } });
await ctx.addCookies([{ name: "rescript_session", value: "fake", url: STUDIO }]);
const page = await ctx.newPage();
const errors = [];
page.on("pageerror", (e) => errors.push(String(e)));

/** every request the panel made to the fieldwork route, in order */
let calls = [];
let body = payload();

const routeFieldwork = async (route) => {
  const url = route.request().url();
  calls.push(url);
  if (/only=pulse/.test(url)) {
    return route.fulfill({
      status: 200, contentType: "application/json",
      body: JSON.stringify({
        available: true, environment: "LIVE", tz: "Europe/London",
        pulse: body.pulse, positions: body.positions,
        fetchedAt: new Date().toISOString(),
      }),
    });
  }
  return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(body) });
};

await page.route("**/api/surveys/*/fieldwork**", routeFieldwork);

/* the supplier half of the tab is not under test; answer it so the page settles */
await page.route("**/api/surveys/*/sample-sources**", (r) => r.fulfill({
  status: 200, contentType: "application/json",
  body: JSON.stringify({
    available: true, environment: "LIVE",
    sources: [{ id: "s1", code: "cint", label: "Cint", targetCompletes: 600, costPerComplete: 3.2, notes: null }],
    stats: [],
  }),
}));

const open = async () => {
  calls = [];
  await page.goto(`${STUDIO}/sandbox`, { waitUntil: "networkidle" });
  await page.waitForSelector(".block-badge");
  await page.click(".leftnav >> text=Fieldwork");
  await page.waitForSelector('[data-testid="fw-over-time"]', { timeout: 20_000 });
};

await open();
ok("the fieldwork tab now opens on the field over time, above the supplier table");

/* ======================================================== §26 — the pace */

const sentence = await page.textContent('[data-testid="fw-pace-sentence"]');
assert.match(sentence, /412 of 600/, sentence);
assert.match(sentence, /56\/day/, sentence);
assert.match(sentence, /66\.4\/day needed/, sentence);
assert.match(sentence, /1 day past the close date/, sentence);
ok("the pace sentence carries every number behind the verdict, not just a coloured word");

assert.equal((await page.textContent('[data-testid="fw-verdict"]')).trim(), "Behind");
ok("…and the verdict chip agrees with it");

const win = await page.textContent('[data-testid="fw-window"]');
assert.match(win, /2026-03-01/);
assert.match(win, /2026-03-10/);
assert.match(win, /44% elapsed/, win);
ok("the field window the pace was judged against is stated, with how much of it has gone");

assert.ok(await page.$('[data-testid="fw-projection"]'), "a projection is offered");
const proj = await page.textContent('[data-testid="fw-projection"]');
assert.match(proj, /last 24 hours/, "and it says which rate it extrapolated");
ok("the projection names the window it came from — a rate with no window is a guess");

const bar = await page.textContent('[data-testid="fw-target-bar"]');
assert.match(bar, /412/);
assert.match(bar, /600/);
assert.match(bar, /supplier contracts/, "where the target came from, since nobody set one on the project");
ok("the delivered bar says where its target came from");

/* ======================================================= §26 — the curve */

const bars = await page.$$('[data-testid="fw-curve-bucket"]');
assert.equal(bars.length, 5, `all five buckets are drawn, got ${bars.length}`);
ok("every bucket in the window is drawn");

/*
 * THE ASSERTION THIS SUITE EXISTS FOR. The third hour had no activity at all.
 * A chart that skips it draws a straight line from hour two to hour four, and
 * the outage — the thing the fieldwork manager opened the page to find —
 * becomes invisible.
 */
const deadBucket = timeline[2].bucketStart;
assert.ok(
  await page.$(`[data-testid="fw-curve-bucket"][data-bucket="${deadBucket}"]`),
  "the dead hour is present in the chart",
);
const deadRects = await page.$$eval(
  `[data-testid="fw-curve-bucket"][data-bucket="${deadBucket}"] rect`,
  (els) => els.length,
);
const busyRects = await page.$$eval(
  `[data-testid="fw-curve-bucket"][data-bucket="${timeline[1].bucketStart}"] rect`,
  (els) => els.length,
);
assert.ok(busyRects > deadRects, `a busy bucket draws more than a dead one (${busyRects} vs ${deadRects})`);
ok("A DEAD HOUR IS DRAWN AS A GAP, NOT SKIPPED — the hole in the curve is the signal");

const tipText = await page.textContent(
  `[data-testid="fw-curve-bucket"][data-bucket="${timeline[1].bucketStart}"] title`,
);
assert.match(tipText, /44 started, 22 completed/, tipText);
assert.match(tipText, /8 screened/);
ok("each bucket carries its own exact numbers, so the chart can be read as well as looked at");

const svgLabel = await page.getAttribute('[data-testid="fw-curve"] svg', "aria-label");
assert.match(svgLabel, /Completes per hour/i, svgLabel);
ok("the chart has a text description for anybody not looking at pixels");

const seriesSummary = await page.textContent('[data-testid="fw-series-summary"]');
assert.match(seriesSummary, /126 started/);
assert.match(seriesSummary, /60 completed/);
assert.match(seriesSummary, /69% incidence/);
assert.match(seriesSummary, /1 quiet hour/, seriesSummary);
ok("the series is summarised beneath it, including how many buckets were quiet");

const foot = await page.textContent('[data-testid="fw-over-time"]');
assert.match(foot, /Europe\/London/, "the zone the buckets were computed in");
assert.match(foot, /do not add up to each other/,
  "and the one thing a reader will otherwise think is a bug");
ok("the panel explains that starts and outcomes are keyed on different moments");

/* ==================================================== §27 — the live half */

assert.equal((await page.textContent('[data-testid="fw-in-field"]')).trim(), "7");
assert.equal((await page.textContent('[data-testid="fw-window-completes"]')).trim(), "14");
assert.equal((await page.textContent('[data-testid="fw-stalled"]')).trim(), "41");
ok("right now: seven in field, fourteen completes in the hour, forty-one stalled partials");

const liveFacts = await page.textContent('[data-testid="fw-live-facts"]');
assert.match(liveFacts, /Last complete 11m ago/, liveFacts);
assert.match(liveFacts, /in the last 15 minutes/, "what “in field” actually means");
ok("“in field” is defined on screen rather than left to be guessed at");

assert.ok(!(await page.$('[data-testid="fw-stall-warning"]')),
  "a field that completed something eleven minutes ago is not stalled");
ok("a healthy field raises no alarm");

/* ------------------------------------------------------- the drop-off */

await page.click('[data-testid="fw-dropoff"] summary');
const rows = await page.$$eval('[data-testid="fw-dropoff-row"]', (els) =>
  els.map((e) => ({ step: e.getAttribute("data-step"), text: e.textContent.replace(/\s+/g, " ").trim() })));
assert.equal(rows.length, 3);
assert.equal(rows[0].step, "2", `the busiest step is first, got ${JSON.stringify(rows.map((r) => r.step))}`);
assert.match(rows[0].text, /Step 3/, "and it is labelled 1-based, like a person counts pages");
assert.match(rows[0].text, /31/, "with the number stuck there");
ok("the drop-off table leads with the step people are stuck on");

const dropText = await page.textContent('[data-testid="fw-dropoff"]');
assert.match(dropText, /hint/i, dropText);
assert.match(dropText, /randomised or skipped/i);
ok("THE STEP NAME IS ADMITTED TO BE A HINT — randomisation and old versions move it");

/* ============================================ the poll reads the cheap half */

/*
 * The full payload runs a gapless series and a drop-off distribution; the
 * pulse is one row. A monitor refreshing twice a minute must not re-run the
 * chart nobody is looking at.
 */
const before = calls.length;
await page.evaluate(() => document.dispatchEvent(new Event("visibilitychange")));
await page.waitForTimeout(500);
const added = calls.slice(before);
assert.ok(added.length >= 1, "the visibility change triggered a refresh");
assert.ok(added.every((u) => /only=pulse/.test(u)),
  `every polled call asks for the pulse only: ${JSON.stringify(added)}`);
ok("THE POLL ASKS FOR only=pulse — the chart is not re-run to move a counter");

assert.ok(calls.some((u) => /tz=/.test(u)), "the browser sends its own zone");
assert.ok(calls.some((u) => /environment=LIVE/.test(u)), "and the environment, always");
ok("the request carries the caller's time zone and environment");

/* -------------------------- and a pulse-only response moves the numbers */

body = payload({
  pulse: { ...pulse, inField: 3, windowCompletes: 21, lastCompleteAt: iso(60_000) },
});
await page.evaluate(() => document.dispatchEvent(new Event("visibilitychange")));
await page.waitForFunction(
  () => document.querySelector('[data-testid="fw-in-field"]')?.textContent?.trim() === "3",
  null, { timeout: 5000 },
);
assert.equal((await page.textContent('[data-testid="fw-window-completes"]')).trim(), "21");
/* the chart is untouched: still the five buckets from the original payload */
assert.equal((await page.$$('[data-testid="fw-curve-bucket"]')).length, 5);
assert.match(await page.textContent('[data-testid="fw-pace-sentence"]'), /412 of 600/,
  "and the pace sentence does not change under the reader");
ok("a poll moves the live numbers and leaves the chart and the pace alone");

/* ============================================== a stalled field says so */

body = payload({
  pulse: { ...pulse, inField: 22, windowCompletes: 0, lastCompleteAt: iso(9 * HOUR) },
  pace: { ...payload().pace, verdict: "stalled", quietHours: 9, ratePerDay: 0, projectedFinish: null, daysLate: null },
});
await open();
const warn = await page.textContent('[data-testid="fw-stall-warning"]');
assert.match(warn, /No completes for 9\.0 hours/, warn);
assert.match(warn, /22 respondents in field/, warn);
assert.match(warn, /a question is failing/, "the diagnosis, not just the number");
ok("A STALL IS DIAGNOSED, NOT JUST REPORTED — people arriving and nobody finishing is a broken question");

assert.equal((await page.textContent('[data-testid="fw-verdict"]')).trim(), "Stalled");
const stalledSentence = await page.textContent('[data-testid="fw-pace-sentence"]');
assert.match(stalledSentence, /stalled/i);
assert.match(stalledSentence, /link|supplier|quota/, "and says what to check");
assert.doesNotMatch(stalledSentence, /\/day needed/,
  "a stalled field is not told to go 66 a day faster — that is not the problem");
ok("stalled is its own verdict, with its own advice");

assert.ok(!(await page.$('[data-testid="fw-projection"]')),
  "a rate of zero produces no projected finish date");
ok("no projection is offered from a rate of zero — a date in the year 2400 is not an estimate");

/* ====================================== a project with no dates is told so */

body = payload({
  project: { ...payload().project, fieldworkFrom: null, fieldworkTo: null },
  pace: {
    verdict: "unknown", completes: 412, target: 600, remaining: 188, delivered: 0.6867,
    elapsed: null, ratePerDay: 56, requiredPerDay: null, projectedFinish: null,
    daysLate: null, quietHours: 0.18,
  },
});
await open();
const noWindow = await page.textContent('[data-testid="fw-no-window"]');
assert.match(noWindow, /No fieldwork dates/);
assert.match(noWindow, /Set them under Project/, "and where to fix it");
assert.equal((await page.textContent('[data-testid="fw-verdict"]')).trim(), "No pace yet");
assert.match(await page.textContent('[data-testid="fw-pace-sentence"]'), /Set fieldwork dates/);
ok("A PROJECT WITH NO DATES IS TOLD SO, and told where — not given a confident-looking chip");

/* ================================================ 0019 not applied */

body = { available: false, environment: "LIVE", note: "Fieldwork over time needs migration 0019." };
await open().catch(() => {});
await page.waitForSelector('[data-testid="fw-time-migration"]');
const mig = await page.textContent('[data-testid="fw-time-migration"]');
assert.match(mig, /migration 0019/);
assert.ok(await page.$('[data-testid="fw-stats"]'),
  "and the supplier half of the tab still works");
ok("a missing migration degrades to a note, not a broken tab");

/* --------------------------------------------------------------- errors */

assert.deepEqual(errors, [], `no page errors: ${errors.join(" | ")}`);
ok("no uncaught errors through any of it");

await browser.close();
console.log(`\nALL FIELDWORK OVER TIME / LIVE MONITORING CHECKS PASSED (${passed})`);

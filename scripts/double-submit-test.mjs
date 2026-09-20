/**
 * Y11 — TWO CLICKS, ONE SUBMIT.
 *
 * `handleNext` is async and does real work before it returns: List Fill
 * allocation, AI-derived variables, probe wording, then the save. Nothing
 * stopped a second click landing in the middle of that. On an ordinary page
 * the respondent skipped a page they never saw; on the LAST page the whole
 * completion path ran twice — a quota cell incremented by two and two
 * billable SURVEY_RESPONSE events for one interview.
 *
 * `scripts/double-submit-sql-test.sql` proves the server half (a finalise is a
 * claim only one request can win). This proves the client half, in a real
 * browser against the real runtime: the thing the respondent actually does.
 *
 *   RUNTIME_URL=http://localhost:3001 node scripts/double-submit-test.mjs
 */
import { chromium } from "/home/claude/.npm-global/lib/node_modules/playwright/index.mjs";
import { sendPreview } from "./lib/preview.mjs";

const RUNTIME = process.env.RUNTIME_URL ?? "http://localhost:3001";
let bad = 0;
const ok = (c, m) => { console.log(`${c ? "  ok  " : "  FAIL"} ${m}`); if (!c) bad++; };

const definition = {
  meta: { id: "00000000-0000-4000-8000-000000000091", code: "DBL", title: "Double submit" },
  questions: [
    { id: "q1", code: "Q1", variableName: "A", type: "open_text", text: "Page one — anything at all?" },
    { id: "q2", code: "Q2", variableName: "B", type: "open_text", text: "Page two — and here?" },
    { id: "q3", code: "Q3", variableName: "C", type: "open_text", text: "Page three — last one." },
  ],
  flow: [
    { type: "page", id: "p1", questionIds: ["q1"] },
    { type: "page", id: "p2", questionIds: ["q2"] },
    { type: "page", id: "p3", questionIds: ["q3"] },
    { type: "end", id: "e1", status: "complete" },
  ],
};

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 900, height: 1000 } });
page.on("pageerror", (e) => { console.log("  !! page error:", e.message); bad++; });
await page.goto(`${RUNTIME}/preview`, { waitUntil: "domcontentloaded" });
await sendPreview(page, { definition });

const visibleQuestion = async () =>
  page.$$eval("[data-qid]", (els) => els.map((e) => e.getAttribute("data-qid"))[0] ?? null);

await page.waitForSelector('[data-qid="q1"]');
ok((await visibleQuestion()) === "q1", "the interview starts on page one");

/* ------------------------------------------------- 1. a page is not skipped */

/*
 * Two clicks with no await between them: the second lands while the first
 * handler is still running. Before the latch this advanced TWICE and the
 * respondent never saw page two — their answer to it is simply missing from
 * the data, with nothing anywhere recording that it was skipped.
 *
 * NOTE ON WHAT THIS PROVES. The fix has two halves — the ref that rejects a
 * re-entrant call, and `disabled` on the button — and they are deliberately
 * redundant. Mutation testing showed that removing EITHER one alone still
 * passes here, because a browser will not dispatch a click to a disabled
 * button and React has re-rendered by the time Playwright's second click is
 * sent. Removing BOTH — the actual pre-fix state — fails this check. The ref
 * still earns its place: it is what closes the window before React
 * re-renders, and what stops a re-entrant call that did not come from a
 * mouse (a keyboard Enter held down, a script, a synthetic event).
 */
await Promise.all([
  page.click('[data-testid="rs-next"]', { force: true }),
  page.click('[data-testid="rs-next"]', { force: true }).catch(() => {}),
]);
await page.waitForTimeout(700);

ok(
  (await visibleQuestion()) === "q2",
  `two fast clicks advanced exactly one page — on screen: ${await visibleQuestion()}`,
);

/* ------------------------------------ 2. the button is usable again after */

/*
 * The latch must RELEASE. A latch that stuck would pass every "did not
 * double-submit" assertion in this file while making the survey impossible
 * to finish, which is a far worse bug than the one being fixed.
 */
ok(
  !(await page.$eval('[data-testid="rs-next"]', (el) => el.disabled)),
  "the Next button is enabled again once the advance has finished",
);

/* ------------------------------------------- 3. the SUBMIT is not doubled */

await page.click('[data-testid="rs-next"]');
await page.waitForSelector('[data-qid="q3"]');
ok((await visibleQuestion()) === "q3", "reached the last page");

/*
 * The one that costs money. On the last page the click runs the completion
 * path: on_complete scripts, quota increments, List Fill confirmation and the
 * billable event. Two clicks ran all of it twice.
 *
 * Preview has no session, so nothing is persisted here — what is observable
 * is that the runtime ENTERS the completion path once. A second entry would
 * re-run `on_complete` and render the end screen again.
 */
/* a respondent reads the last page before submitting it; without this pause
 * the burst below starts inside the previous advance's own minimum interval,
 * which the latch would (correctly) swallow whole — proving nothing */
await page.waitForTimeout(600);

await Promise.all([
  page.click('[data-testid="rs-next"]', { force: true }),
  page.click('[data-testid="rs-next"]', { force: true }).catch(() => {}),
  page.click('[data-testid="rs-next"]', { force: true }).catch(() => {}),
]);
await page.waitForTimeout(900);

await page.waitForSelector('[data-testid="rs-ended"]', { timeout: 15000 });
const endScreens = await page.$$eval('[data-testid="rs-ended"]', (els) => els.length);
ok(endScreens === 1, `expected exactly one end screen, got ${endScreens}`);

/*
 * And the interview really did finish — a latch that simply swallowed every
 * click would pass every assertion above while breaking the survey, which is
 * the failure mode this test most needs to rule out.
 */
const stillOnAQuestion = await page.$$eval("[data-qid]", (els) => els.length);
ok(stillOnAQuestion === 0, "no question is on screen any more — the interview really did finish");

await browser.close();
console.log(bad === 0 ? "\nALL DOUBLE-SUBMIT CHECKS PASSED" : `\n${bad} CHECK(S) FAILED`);
process.exit(bad === 0 ? 0 : 1);

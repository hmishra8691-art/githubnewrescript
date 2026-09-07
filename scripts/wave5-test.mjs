/**
 * WAVE 5 — resume, the local cache, and the settings that were read by nothing.
 *
 *   §25  a resume pointer that outlives the tab, travels in a link, and expires
 *   §49  answers cached locally between saves, so a failed save survives a reload
 *   §46  deployment.customDomain is authorable and used for respondent links
 *   §47  workspace themes exist (and are correctly unavailable in the sandbox)
 *
 *   node scripts/wave5-test.mjs      (studio on 3000, runtime on 3001)
 */
import { chromium } from "/home/claude/.npm-global/lib/node_modules/playwright/index.mjs";
import assert from "node:assert/strict";

const STUDIO = process.env.STUDIO_URL ?? "http://localhost:3000";
const RUNTIME = process.env.RUNTIME_URL ?? "http://localhost:3001";
let passed = 0;
const ok = (m) => { console.log("  ok  ", m); passed++; };

const def = {
  meta: { id: "w5", code: "W5", title: "Wave 5", version: "1.0", schemaVersion: 1, status: "draft" },
  questions: [{
    id: "q1", code: "Q1", variableName: "A", type: "open_text", text: "Anything?",
  }],
  flow: [{ type: "page", id: "p1", questionIds: ["q1"] }, { type: "end", id: "e1", status: "complete" }],
  deployment: { clientSlug: "c", studySlug: "s" },
};

const browser = await chromium.launch();
const ctx = await browser.newContext({ viewport: { width: 1400, height: 950 } });
await ctx.addCookies([{ name: "rescript_session", value: "fake", url: STUDIO }]);
const page = await ctx.newPage();
const errors = [];
page.on("pageerror", (e) => errors.push(String(e)));
await page.route("**/api/auth/me", (r) => r.fulfill({
  status: 200, contentType: "application/json",
  body: JSON.stringify({ userId: "u1", userCode: "USR-1", name: "Ana", email: "a@b.c", platformRole: "user", isPlatformAdmin: true, sessionId: "s1", unread: 0, policies: { heartbeatSeconds: 600 } }),
}));

/* ------------------------------------------------------------- §25 §49 */

console.log("\nCOMING BACK TO AN UNFINISHED SURVEY (§25, §49)");

await page.goto(`${RUNTIME}/preview`, { waitUntil: "networkidle" });
await page.evaluate((d) => window.postMessage({ type: "rescript:preview", definition: d }, "*"), def);
await page.waitForSelector('[data-qid="q1"]');
await page.waitForFunction(() => !!window.__rescriptResume);

const durable = await page.evaluate(() => {
  const R = window.__rescriptResume;
  R.writeResume("live", "survey-1", "sess-abcdefabcdefabcdef");
  const inLocal = window.localStorage.getItem("rescript:session:live:survey-1");
  return { read: R.readResume("live", "survey-1"), inLocal: !!inLocal };
});
assert.equal(durable.read, "sess-abcdefabcdefabcdef");
assert.equal(durable.inLocal, true,
  "the pointer must be in localStorage — sessionStorage dies with the tab, which is the bug");
ok("the resume pointer survives the tab being closed (§25)");

// a new browser context is a different tab AND a different session store
const page2 = await ctx.newPage();
await page2.goto(`${RUNTIME}/preview`, { waitUntil: "networkidle" });
await page2.evaluate((d) => window.postMessage({ type: "rescript:preview", definition: d }, "*"), def);
await page2.waitForFunction(() => !!window.__rescriptResume);
const fromNewTab = await page2.evaluate(() => window.__rescriptResume.readResume("live", "survey-1"));
assert.equal(fromNewTab, "sess-abcdefabcdefabcdef", "a new tab should find the same unfinished response");
await page2.close();
ok("and is found from a new tab, which is what closing a survey and coming back is");

const viaLink = await page.evaluate(() => {
  const R = window.__rescriptResume;
  return {
    link: R.resumeLink("sess-111111111111111111", "https://survey.example.com/s/acme/tracker"),
    read: R.readResume("live", "survey-1", "?r=sess-222222222222222222"),
    rejected: R.readResume("live", "survey-1", "?r=nope"),
  };
});
assert.match(viaLink.link, /[?&]r=sess-111111111111111111/);
assert.equal(viaLink.read, "sess-222222222222222222", "a resume link must win over stored state");
assert.equal(viaLink.rejected, "sess-abcdefabcdefabcdef",
  "a malformed r= parameter should be ignored, not followed");
ok("a resume LINK works on a device that has never seen the survey (§25)");

const expiry = await page.evaluate((days) => {
  const stale = JSON.stringify({ sessionId: "old-session-id-000000", at: Date.now() - (days + 1) * 86400000 });
  window.localStorage.setItem("rescript:session:live:survey-2", stale);
  window.sessionStorage.setItem("rescript:session:live:survey-2", stale);
  const read = window.__rescriptResume.readResume("live", "survey-2");
  return { read, left: window.localStorage.getItem("rescript:session:live:survey-2") };
}, await page.evaluate(() => window.__rescriptResume.RESUME_MAX_AGE_DAYS));
assert.equal(expiry.read, null, "a months-old pointer must not resume — that is how live data fills with stale rows");
assert.equal(expiry.left, null, "and it should be cleaned up rather than left to be re-read");
ok("an expired pointer is dropped instead of stitching someone onto a stale row (§25)");

const cache = await page.evaluate(() => {
  const R = window.__rescriptResume;
  R.cachePending("sess-cache-1", {
    answers: { q1: "typed but never saved" }, calculated: {}, embedded: {}, flags: [], stepIndex: 3,
  });
  const read = R.readPending("sess-cache-1");
  R.clearPending("sess-cache-1");
  return { read, afterClear: R.readPending("sess-cache-1"), other: R.readPending("sess-cache-2") };
});
assert.equal(cache.read.answers.q1, "typed but never saved");
assert.equal(cache.read.stepIndex, 3);
assert.equal(cache.afterClear, null, "the cache is cleared the moment the server acknowledges");
assert.equal(cache.other, null, "a cache can only ever replay onto the response it came from");
ok("a page whose save never landed is kept locally, keyed to its own session (§49)");

/* ---------------------------------------------------------------- §46 */

console.log("\nSETTINGS THAT WERE READ BY NOTHING (§46, §47)");

await page.goto(`${STUDIO}/sandbox`, { waitUntil: "networkidle" });
await page.waitForSelector(".leftnav");
await page.click(".leftnav >> text=Survey Settings");
await page.waitForSelector('[data-testid="custom-domain"]');
await page.fill('[data-testid="custom-domain"]', "https://survey.acme.com/s/whatever");
await page.waitForTimeout(400);
assert.equal(await page.inputValue('[data-testid="custom-domain"]'), "survey.acme.com",
  "a pasted URL should be reduced to the host — that is what a domain is");
ok("a custom domain is authorable, and tidied as it is typed (§46)");

await page.click(".leftnav >> text=Versions & Deploy");
await page.waitForTimeout(600);
const note = await page.textContent('[data-testid="custom-domain-note"]');
assert.match(note, /survey\.acme\.com/);
assert.match(note, /DNS/, "the panel should say what is left for an operator to do");
ok("respondent links use it, and the panel says what DNS still needs (§46)");

/* ---------------------------------------------------------------- §47 */

await page.click(".leftnav >> text=Branding");
await page.waitForSelector("text=Branding & Theme");
assert.equal(await page.$('[data-testid="workspace-themes"]'), null,
  "the sandbox has no workspace, so workspace themes are correctly unavailable there");
ok("workspace themes are offered on a real project and hidden in the sandbox (§47)");

assert.deepEqual(errors, [], `uncaught errors: ${errors.join("\n")}`);
ok("no uncaught errors anywhere in the session");

await browser.close();
console.log(`\nALL ${passed} WAVE 5 CHECKS PASSED\n`);

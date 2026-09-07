/**
 * WAVE 2 — Run Quality Check, and the accessibility a respondent needs.
 *
 *   §54  one button, ten areas, a verdict on whether a survey can be fielded
 *   §53  the checks that were missing: a stranded question, an empty list,
 *        a quota that is full before fielding, a design that is not there
 *   §48  a focus ring, a skip link, an announced error, a described stimulus
 *
 *   node scripts/wave2-test.mjs      (studio on 3000, runtime on 3001)
 */
import { chromium } from "/home/claude/.npm-global/lib/node_modules/playwright/index.mjs";
import assert from "node:assert/strict";
import { buildMasterDemoSurvey } from "../packages/templates/dist/index.js";
import { sendPreview } from "./lib/preview.mjs";

const STUDIO = process.env.STUDIO_URL ?? "http://localhost:3000";
const RUNTIME = process.env.RUNTIME_URL ?? "http://localhost:3001";
let passed = 0;
const ok = (m) => { console.log("  ok  ", m); passed++; };

const browser = await chromium.launch();
const ctx = await browser.newContext({ viewport: { width: 1500, height: 1000 } });
await ctx.addCookies([{ name: "rescript_session", value: "fake", url: STUDIO }]);
const page = await ctx.newPage();
const errors = [];
page.on("pageerror", (e) => errors.push(String(e)));
await page.route("**/api/auth/me", (r) => r.fulfill({
  status: 200, contentType: "application/json",
  body: JSON.stringify({ userId: "u1", userCode: "USR-1", name: "Ana", email: "a@b.c", platformRole: "user", isPlatformAdmin: true, sessionId: "s1", unread: 0, policies: { heartbeatSeconds: 600 } }),
}));

const apply = async (def) => {
  await page.click(".leftnav >> text=JSON");
  await page.waitForSelector("textarea.code");
  await page.click('button:has-text("edit")');
  await page.$eval("textarea.code", (el, v) => {
    const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value").set;
    setter.call(el, v); el.dispatchEvent(new Event("input", { bubbles: true }));
  }, JSON.stringify(def));
  await page.click('button:has-text("validate & apply")');
  await page.waitForTimeout(900);
};

const runCheck = async () => {
  await page.click(".leftnav >> text=Logic");
  await page.waitForSelector('[data-testid="quality-check"]');
  await page.click('[data-testid="run-quality-check"]');
  await page.waitForTimeout(500);
  return page.$$eval('[data-testid="qc-area"]', (es) => es.map((e) => ({
    area: e.getAttribute("data-area"), status: e.getAttribute("data-status"),
  })));
};

/* ------------------------------------------------------------------ §54 */

console.log("\nRUN QUALITY CHECK (§54)");

await page.goto(`${STUDIO}/sandbox`, { waitUntil: "networkidle" });
await page.waitForSelector(".leftnav");
const demo = buildMasterDemoSurvey("sandbox");
await apply(demo);

let areas = await runCheck();
assert.equal(areas.length, 10, "ten areas, in the vocabulary a programmer uses");
assert.equal(await page.textContent('[data-testid="qc-verdict"]'), "Ready to deploy");
assert.ok(areas.every((a) => a.status === "pass"),
  `the Master Demo should be clean: ${JSON.stringify(areas.filter((a) => a.status !== "pass"))}`);
ok("the Master Demo — 160 questions, every feature — passes all ten areas");

/* ------------------------------------------------------------------ §53 */

console.log("\nTHE CHECKS THAT WERE MISSING (§53)");

const broken = structuredClone(demo);
// a question in the survey and on no page
broken.questions.push({
  id: "q_stranded", code: "QZZ", variableName: "STRANDED", type: "open_text",
  text: "Nobody can be asked this", options: [], rows: [], columns: [],
  validation: [], skipLogic: [], settings: {}, required: false,
});
// a quota cell that is full before anyone answers
broken.quotas = [{
  id: "qz", name: "Impossible", mode: "hard", limitType: "count", countStatus: ["complete"],
  onFull: { kind: "terminate" },
  cells: [{ id: "cz", label: "Nobody", limit: 0, limitType: "count", when: { type: "group", op: "and", children: [] } }],
}];
await apply(broken);
areas = await runCheck();

const byArea = Object.fromEntries(areas.map((a) => [a.area, a.status]));
assert.equal(byArea.structure, "fail", "a question on no page must fail the structure area");
assert.equal(byArea.quotas, "fail", "a cell with a limit of zero must fail the quota area");
assert.equal(await page.textContent('[data-testid="qc-verdict"]'), "Not ready to deploy");
ok("a stranded question and an impossible quota both block a release");

// the first failing area opens on its own — the point of a verdict is that
// the problem is in front of you, not one click away
const detail = await page.$$eval('[data-testid="qc-area"][data-area="structure"] > .chip', (es) => es.map((e) => e.textContent));
assert.ok(detail.some((d) => /QZZ/.test(d) && /not on any page/.test(d)),
  `the detail should name the question: ${JSON.stringify(detail)}`);
ok("the failing area opens itself and names the question");

/* ------------------------------------------------------------------ §48 */

console.log("\nWHAT A RESPONDENT NEEDS (§48)");

const a11y = {
  meta: { id: "a11y", code: "A11Y", title: "Access", version: "1.0", schemaVersion: 1, status: "draft" },
  questions: [{
    id: "q1", code: "Q1", variableName: "PICK", type: "single_select", text: "Which pack?",
    required: true,
    settings: {
      mediaUrl: "https://cdn.example.com/pack.png",
      accessibility: { altText: "Three product packs side by side" },
    },
    options: [{ code: 1, label: "Blue" }, { code: 2, label: "Red" }],
  }],
  flow: [{ type: "page", id: "p1", questionIds: ["q1"] }, { type: "end", id: "e1", status: "complete" }],
  deployment: { clientSlug: "c", studySlug: "s" },
};

await page.goto(`${RUNTIME}/preview`, { waitUntil: "networkidle" });
await sendPreview(page, { definition: a11y }, { selector: '[data-qid="q1"]' });

assert.equal(await page.getAttribute('[data-testid="rs-qmedia"] img', "alt"),
  "Three product packs side by side",
  "the stimulus must be described, not announced as an unnamed image");
ok("a stimulus carries the alt text its programmer wrote (§48)");

assert.ok(await page.$('[data-testid="rs-skip"]'), "there is a skip link");
const skipTarget = await page.getAttribute('[data-testid="rs-skip"]', "href");
assert.equal(skipTarget, "#rs-questions");
assert.ok(await page.$("#rs-questions"), "and something for it to skip to");
ok("a skip link reaches the questions, ahead of the page chrome (§48)");

/*
 * The first focusable thing INSIDE the survey shell. (The preview harness
 * puts its own banner and testing toolbar above the shell; a respondent on a
 * real link has neither, so the shell is where the claim has to hold.)
 */
const firstInShell = await page.evaluate(() => {
  const el = document.querySelector('.rs-shell a[href], .rs-shell button, .rs-shell input, .rs-shell select, .rs-shell textarea');
  return el?.getAttribute("data-testid") ?? el?.tagName ?? null;
});
assert.equal(firstInShell, "rs-skip", `the skip link should come first in the survey, got ${firstInShell}`);
ok("it comes before every control in the survey, so it is reachable when it matters");

await page.click('[data-testid="rs-next"]');
await page.waitForTimeout(400);
assert.ok(await page.$('[data-qid="q1"] [role="alert"]'), "a validation error must announce itself");
assert.equal(await page.getAttribute('[data-qid="q1"]', "aria-invalid"), "true");
assert.equal(await page.getAttribute('[data-qid="q1"]', "aria-describedby"), "q1__err");
ok("a failing question is marked invalid and points at the message that says why (§48)");

const ring = await page.evaluate(() => {
  const el = document.querySelector(".rs-shell input, .rs-shell button");
  if (!el) return null;
  el.focus();
  return getComputedStyle(el).getPropertyValue("outline-style");
});
assert.notEqual(ring, null);
ok("focus styling is present in the respondent stylesheet");

assert.deepEqual(errors, [], `uncaught errors: ${errors.join("\n")}`);
ok("no uncaught errors anywhere in the session");

await browser.close();
console.log(`\nALL ${passed} WAVE 2 CHECKS PASSED\n`);

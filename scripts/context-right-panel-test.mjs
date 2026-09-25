/**
 * CONTEXT-AWARE RIGHT PANEL & LIVE PREVIEW UI FIX (Sept 21 follow-up brief).
 *
 *   node scripts/context-right-panel-test.mjs      (studio :3000)
 *
 * Before this brief, `<aside className="rightpanel"><PropertiesPanel /></aside>`
 * rendered unconditionally on every Studio tab — so Survey Settings and
 * Branding got a "Select a question…" panel with a second, duplicate copy of
 * Survey Settings pasted underneath it, and Survey Flow / Logic got the same
 * dead panel beside editors that already do their own contextual editing
 * inline. This checks the fix end to end:
 *
 *   - Questions, nothing selected → no visible right panel at all.
 *   - Questions, a question selected → Question Properties, and nothing else.
 *   - Survey Settings / Survey Flow / Logic → no right panel, no duplicate
 *     Survey Settings, no "Select a question…" placeholder anywhere.
 *   - Branding → the live theme preview on the right, side by side with the
 *     controls (not stacked above them with a scroll in between), updating
 *     immediately on every edit — with the URL-import and logo-detect
 *     controls this session's earlier brief shipped still working beside it.
 *   - Switching away and back preserves what the Properties panel's own
 *     local UI state was doing (which accordion sections are open) — the
 *     regression this exact fix could reintroduce if the panel were made to
 *     literally unmount instead of just hide.
 */
import { chromium } from "/home/claude/.npm-global/lib/node_modules/playwright/index.mjs";
import { openTab } from "./lib/nav.mjs";
import assert from "node:assert/strict";

const STUDIO = process.env.STUDIO_URL ?? "http://localhost:3000";
let passed = 0;
const ok = (m) => { console.log("  ok  ", m); passed++; };

const FIXTURE = {
  meta: { id: "sandbox", code: "SANDBOX", title: "Right Panel", version: "1.0" },
  questions: [
    {
      id: "q1", code: "Q1", variableName: "Q1", type: "single_select", text: "Pick one",
      options: [{ code: "a", label: "Alpha" }, { code: "b", label: "Beta" }],
      skipLogic: [{
        id: "sr1",
        when: { type: "rule", source: { kind: "question", ref: "q1" }, operator: "eq", value: "a" },
        target: { kind: "end", status: "complete" },
      }],
    },
  ],
  flow: [
    { type: "page", id: "p1", questionIds: ["q1"] },
    { type: "end", id: "e1", status: "complete" },
  ],
};

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1700, height: 1150 } });
const errors = [];
page.on("pageerror", (e) => errors.push(e.message));
page.on("dialog", (d) => d.accept());

const goTab = async (name) => { await openTab(page, `${name}`); await page.waitForTimeout(200); };
const propertiesVisible = () => page.isVisible('[data-testid="rightpanel-properties"]');
const previewVisible = () => page.isVisible('[data-testid="rightpanel-preview"]');
/** Nothing rendered claims to be a right panel at all, hidden or not. */
const anyRightpanelInDom = () => page.$$eval(".rightpanel", (els) => els.length);
const bodyText = () => page.textContent("body");

await page.goto(`${STUDIO}/sandbox`, { waitUntil: "networkidle" });
await page.waitForSelector(".menubar");
await goTab("JSON");
await page.waitForSelector("textarea.code");
await page.click('button:has-text("edit")');
await page.fill("textarea.code", JSON.stringify(FIXTURE, null, 2));
await page.click('button:has-text("validate & apply")');
await page.waitForTimeout(300);
ok("fixture loaded: one question, with skip logic already configured");

/* ============================================================ Questions */

await goTab("Questions");
assert.equal(await propertiesVisible(), false, "no question selected yet — Properties must not show");
assert.equal(await previewVisible(), false, "and definitely not the Branding preview, on the Questions tab");
ok("Questions, nothing selected: no right panel at all");

await page.waitForSelector(".qcard");
await page.click(".qcard");
await page.waitForSelector('[data-testid="rightpanel-properties"]');
assert.equal(await propertiesVisible(), true, "selecting a question must show Properties");
const propHeading = await page.textContent('[data-testid="rightpanel-properties"] h2');
assert.match(propHeading, /Q1 properties/, `the panel is Q1's own properties: ${propHeading}`);
ok("Questions, a question selected: Question Properties shows, and names the right question");

/* =================================================== accordion survives */

// Skip logic is already configured by the fixture, so it OPENS BY DEFAULT
// regardless of whether the panel remounts — not a real test of anything.
// Randomization has nothing configured, so it starts collapsed; opening it
// by hand is a pure UI preference that only survives a tab round trip if
// the Properties panel genuinely stays mounted (hidden, not unmounted) —
// exactly the distinction this check exists to catch.
const randHead = '[data-testid="psec-head-randomization"]';
await page.waitForSelector(randHead);
assert.equal(await page.getAttribute(randHead, "aria-expanded"), "false",
  "Randomization starts collapsed — nothing is configured on it");
await page.click(randHead);
await page.waitForTimeout(150);
assert.equal(await page.getAttribute(randHead, "aria-expanded"), "true", "Randomization opened by hand");

/* ============================================= Settings / Flow / Logic */

for (const tab of ["Survey Settings", "Survey Flow", "Logic"]) {
  await goTab(tab);
  assert.equal(await propertiesVisible(), false, `${tab}: no Question Properties`);
  assert.equal(await previewVisible(), false, `${tab}: no Branding preview either`);
  const text = await bodyText();
  assert.doesNotMatch(text, /Select a question to edit its logic/,
    `${tab}: the Questions-tab "Select a question…" placeholder must not leak in here: saw it in "${tab}"`);
  ok(`${tab}: no right panel — main has this tab's own content and nothing else on the right`);
}

// Survey Settings must not be a second, duplicate copy of itself
await goTab("Survey Settings");
const settingsHeadings = await page.$$eval("h2", (els) => els.map((e) => e.textContent?.trim()));
assert.equal(settingsHeadings.filter((t) => /^Survey$/.test(t ?? "")).length, 0,
  `no stray "Survey" heading (the old duplicate SurveySettings block's own title) — saw: ${JSON.stringify(settingsHeadings)}`);
ok('Survey Settings renders exactly once, not twice via a leftover Properties fallback');

/* ================================ back to Questions: selection survived */

await goTab("Questions");
await page.waitForSelector('[data-testid="rightpanel-properties"]');
assert.equal(await propertiesVisible(), true, "the previously selected question is still selected");
assert.equal(await page.getAttribute(randHead, "aria-expanded"), "true",
  "Randomization is STILL open — a trip through Settings/Flow/Logic must not have reset the Properties panel's own UI state");
ok("switching tabs and back preserves the question's selection AND the Properties panel's own accordion state");

/* ==================================================================== */
/* Branding: live preview replaces Properties, side by side with controls */
/* ==================================================================== */

await goTab("Branding");
assert.equal(await propertiesVisible(), false, "Branding: no generic Question Properties");
await page.waitForSelector('[data-testid="rightpanel-preview"]');
assert.equal(await previewVisible(), true, "Branding: the live preview shows on the right");
await page.waitForSelector('[data-testid="theme-live-preview"]');
ok("Branding shows the live survey preview on the right, not Properties");

// still exactly one .rightpanel actually rendering content people can see —
// PropertiesPanel is mounted-but-hidden alongside it, never two visible panels
const visibleRightpanels = await page.$$eval(".rightpanel", (els) =>
  els.filter((e) => getComputedStyle(e).display !== "none").length);
assert.equal(visibleRightpanels, 1, `exactly one visible .rightpanel at a time, got ${visibleRightpanels}`);
ok("only one right panel is ever visible at once (the hidden Properties aside stays truly hidden)");

// side by side, not stacked: the preview sits to the right of the controls,
// at the same vertical position — not scrolled miles below them
const mainBox = await page.$eval("main.center", (e) => e.getBoundingClientRect());
const previewBox = await page.$eval('[data-testid="rightpanel-preview"]', (e) => e.getBoundingClientRect());
assert.ok(previewBox.left >= mainBox.right - 1,
  `preview sits to the right of the controls: main right=${mainBox.right}, preview left=${previewBox.left}`);
assert.ok(Math.abs(previewBox.top - mainBox.top) < 5,
  `preview starts at the same height as the controls, not below a scroll: main top=${mainBox.top}, preview top=${previewBox.top}`);
ok("theme controls (left) and live preview (right) are a true two-column layout, not stacked with a scroll between them");

// editing a control updates the relocated preview immediately, no save step
const before = await page.$eval('[data-testid="theme-preview-next"]', (e) => getComputedStyle(e).backgroundColor);
// the Primary swatch's own hex text field, in the Colors section (not the
// brand-hex-entry field up in the theme generator, which needs "Generate
// theme" clicked before it touches anything)
await page.fill('main.center label:has-text("Primary") input.mono', "#059669");
await page.waitForTimeout(250);
const after = await page.$eval('[data-testid="theme-preview-next"]', (e) => getComputedStyle(e).backgroundColor);
assert.notEqual(before, after, `changing Primary must repaint the relocated preview immediately: ${before} -> ${after}`);
assert.equal(after, "rgb(5, 150, 105)", `the preview reflects the exact color typed: ${after}`);
ok("editing a theme control updates the right-hand preview instantly — no Save, no leaving the panel");

// this session's earlier "Import brand from URL" feature still sits right
// beside the (now relocated) preview, untouched by any of this
await page.waitForSelector('[data-testid="brand-url-input"]');
await page.waitForSelector('[data-testid="generate-from-hex"]');
ok("the URL-import and hex-generator controls from the brand-scraping brief are still present, unaffected");

assert.equal(errors.length, 0, `no page errors expected, got: ${errors.join("; ")}`);
ok("no console/page errors throughout");

await browser.close();
console.log(`\n${passed} checks passed.`);

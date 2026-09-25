/**
 * Sept 21 follow-up — Survey Settings & Survey Flow use the available width.
 *
 * Brief #1 (context-aware right panel) freed up the space the aside used to
 * reserve on these two tabs, but the content inside was still capped at
 * widths sized for the old, narrower `main`: `.flow-panel` at 940px and an
 * inline `maxWidth: 620` around Survey Settings. That left a large blank
 * strip on the right at any reasonably wide window — exactly what this test
 * guards against regressing to.
 *
 * The fix raises both caps to 1400px (matching the precedent already set by
 * `.dash` and `.ax-page`, the two pages the brief cited as "already using
 * the available space appropriately") and regroups Survey Settings' short
 * fields into a responsive grid so individual inputs don't balloon. This
 * test asserts the *outcome* — real width, not the specific CSS numbers — so
 * it keeps meaning if those numbers are retuned later, and checks the panels
 * stay usable (no horizontal overflow) at a narrower width too.
 */
import { chromium } from "/home/claude/.npm-global/lib/node_modules/playwright/index.mjs";
import { openTab } from "./lib/nav.mjs";
import assert from "node:assert/strict";

const browser = await chromium.launch();
let failed = false;
const check = (label, cond) => {
  console.log(`  ${cond ? "ok  " : "FAIL"}   ${label}`);
  if (!cond) failed = true;
};

/* --------------------------------------------------------- wide viewport */
{
  const ctx = await browser.newContext({ viewport: { width: 1900, height: 1000 } });
  const page = await ctx.newPage();
  // Matches the convention in context-right-panel-test.mjs: only page-level
  // (uncaught JS) errors count here. The sandbox has no session, so its own
  // draft/version API calls 401 by design, and font requests get blocked at
  // the egress proxy — both log as console "error" noise unrelated to this
  // fix, not something this layout test should judge.
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));

  await page.goto("http://localhost:3000/sandbox", { waitUntil: "networkidle" });
  await page.waitForSelector(".menubar");

  // Survey Settings: the wrapper must be using real width, not the old
  // fixed 620px cap, and the short fields must have reflowed into columns
  // rather than each sitting alone in a full-width row.
  await openTab(page, "Survey Settings");
  await page.waitForSelector('[data-testid="survey-settings"]');
  const settingsWidth = await page.$eval(".settings-wrap", (e) => e.getBoundingClientRect().width);
  check(`Survey Settings content is wide (${Math.round(settingsWidth)}px, was capped at 620px)`, settingsWidth > 900);

  const titleBox = await page.$eval('label.f:has-text("Title") input', (e) => e.getBoundingClientRect());
  const codeBox = await page.$eval('label.f:has-text("Survey code") input', (e) => e.getBoundingClientRect());
  check("Title and Survey code sit side by side in the grid, not stacked full-width",
    Math.abs(titleBox.top - codeBox.top) < 5 && codeBox.left > titleBox.right);
  check("neither field itself has stretched to an absurd width", titleBox.width < 440 && codeBox.width < 440);

  // Fields still function: editing Title still reaches the definition.
  await page.fill('label.f:has-text("Title") input', "Width Fix Check");
  await openTab(page, "JSON");
  await page.waitForSelector("textarea.code");
  const def1 = JSON.parse(await page.$eval("textarea.code", (e) => e.value));
  check("editing Title in the new grid layout still writes through to the definition",
    def1.meta.title === "Width Fix Check");
  await openTab(page, "Survey Settings");

  // Survey Flow: the panel must be using real width, not the old 940px cap.
  await openTab(page, "Survey Flow");
  await page.waitForSelector(".flow-panel");
  const flowWidth = await page.$eval(".flow-panel", (e) => e.getBoundingClientRect().width);
  check(`Survey Flow content is wide (${Math.round(flowWidth)}px, was capped at 940px)`, flowWidth > 1100);

  // Neither panel silently uncapped into a document-wide mess — both should
  // land at (or under) the 1400px precedent shared with .dash / .ax-page.
  check("Survey Flow width stays bounded by the app's established wide-panel precedent", flowWidth <= 1401);
  check("Survey Settings width stays bounded by the same precedent", settingsWidth <= 1401);

  check("no console/page errors", errors.length === 0);
  await ctx.close();
}

/* --------------------------------------------------- narrower viewport */
{
  const ctx = await browser.newContext({ viewport: { width: 1000, height: 900 } });
  const page = await ctx.newPage();
  await page.goto("http://localhost:3000/sandbox", { waitUntil: "networkidle" });
  await page.waitForSelector(".menubar");

  await openTab(page, "Survey Settings");
  await page.waitForSelector('[data-testid="survey-settings"]');
  const settingsOverflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  check("Survey Settings has no horizontal overflow at a narrower (1000px) window", settingsOverflow <= 1);

  await openTab(page, "Survey Flow");
  await page.waitForSelector(".flow-panel");
  const flowOverflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  check("Survey Flow has no horizontal overflow at a narrower (1000px) window", flowOverflow <= 1);

  await ctx.close();
}

await browser.close();

if (failed) {
  console.error("\nSOME CHECKS FAILED");
  process.exit(1);
} else {
  console.log("\nALL SETTINGS/FLOW WIDTH CHECKS PASSED");
}

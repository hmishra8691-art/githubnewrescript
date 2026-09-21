/**
 * URL-BASED BRAND COLOR SCRAPING & AUTOMATIC THEME GENERATION (Sept 21
 * follow-up brief) — the parts a browser can prove.
 *
 *   node scripts/brand-url-import-test.mjs      (studio :3000)
 *
 * The actual detection/scoring logic (SSRF guard, HTML/CSS extraction, role
 * scoring, fetch mechanics against a real fixture server) is unit-tested
 * exhaustively in apps/studio/lib/brandScrapeCore.test.ts — 27 checks, no
 * server needed. This file covers what only a browser (or a raw HTTP
 * request) can show:
 *
 *   - the new "Import brand from URL" control exists, is correctly
 *     disabled with an explanatory message in the sandbox (no real survey
 *     to scope the server call to — matches every other DB-backed control
 *     in this panel, e.g. "Detect logo colors" needs a saved logo, "Save as
 *     workspace theme" needs a saved survey)
 *   - the route is wired into the SAME auth gate `themes`/`export` use —
 *     an unauthenticated request is refused, not silently allowed
 *   - none of this changed anything about the EXISTING theme system: the
 *     hex-generator and logo-detector buttons this feature sits beside
 *     still work exactly as scripts/desktop-layout-theming-test.mjs already
 *     proves (22 checks, re-run unmodified as part of this same brief's
 *     verification — not duplicated here)
 */
import { chromium } from "/home/claude/.npm-global/lib/node_modules/playwright/index.mjs";
import assert from "node:assert/strict";

const STUDIO = process.env.STUDIO_URL ?? "http://localhost:3000";
let passed = 0;
const ok = (m) => { console.log("  ok  ", m); passed++; };

/* ============================================================ auth gate */

{
  const res = await fetch(`${STUDIO}/api/surveys/sandbox/brand-scrape`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ url: "https://example.com" }),
  });
  assert.equal(res.status, 401, `an unauthenticated request must be refused, got ${res.status}`);
  const body = await res.json();
  assert.equal(body.code, "no_session");
  ok("the brand-scrape route refuses an unauthenticated request (same gate as /themes and /export)");
}

/* ============================================================ Studio UI */

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1700, height: 1200 } });
const errors = [];
page.on("pageerror", (e) => errors.push(e.message));

await page.goto(`${STUDIO}/sandbox`, { waitUntil: "networkidle" });
await page.waitForSelector(".leftnav");
await page.click(`.leftnav >> text=Branding`);
await page.waitForTimeout(200);
await page.waitForSelector('[data-testid="theme-generator"]');
ok("the theme generator card (URL import + logo detect + hex entry) renders in the sandbox");

const urlInput = page.locator('[data-testid="brand-url-input"]');
const analyzeBtn = page.locator('[data-testid="analyze-brand-url"]');
await page.waitForSelector('[data-testid="brand-url-input"]');
assert.equal(await urlInput.isDisabled(), true, "the URL input should be disabled in the sandbox (no real survey to scope the server call to)");
await urlInput.evaluate((el) => el.removeAttribute("disabled")); // prove the button ALSO gates it, not just the input's HTML attribute
await urlInput.fill("https://example.com");
assert.equal(await analyzeBtn.isDisabled(), true, "Analyze website must stay disabled in the sandbox even with a URL typed in");
ok('"Import brand from URL" is present and correctly disabled in the sandbox, with both the input and the button gated');

const note = await page.textContent("body");
assert.match(note, /Save the survey first — brand analysis needs a saved survey/, "the sandbox note explaining why should be visible");
ok("a clear explanation is shown for why the control is disabled here — not just a silently dead button");

// the sibling controls this feature sits beside are completely unaffected
await page.waitForSelector('[data-testid="generate-from-hex"]');
await page.click('[data-testid="generate-from-hex"]');
await page.waitForSelector('[data-testid="generated-palette"]');
ok("the pre-existing hex-based theme generator, right beside the new control, still works untouched");

assert.equal(errors.length, 0, `no page errors expected, got: ${errors.join("; ")}`);
ok("no console/page errors throughout");

await browser.close();
console.log(`\n${passed} checks passed.`);

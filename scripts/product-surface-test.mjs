/**
 * PRODUCT SURFACE — the chooser, the split, the selector, the collapse rules (Phase 5).
 *
 *   node scripts/product-surface-test.mjs
 */
import assert from "node:assert/strict";
import { chromium } from "/home/claude/.npm-global/lib/node_modules/playwright/index.mjs";
import { buildMasterDemoSurvey } from "../packages/templates/dist/index.js";

const STUDIO = process.env.STUDIO_URL ?? "http://localhost:3000";
let passed = 0;
const ok = (msg) => { passed++; console.log(`  ok   ${msg}`); };
const mod = process.platform === "darwin" ? "Meta" : "Control";

const browser = await chromium.launch();
const pageErrors = [];
const newPage = async (viewport = { width: 1600, height: 950 }) => {
  // a fresh context is a fresh browser: no remembered mode, no dismissed chooser
  const ctx = await browser.newContext({ viewport });
  const page = await ctx.newPage();
  page.on("pageerror", (e) => pageErrors.push(String(e)));
  page.on("console", (m) => { if (m.type() === "error" && !/401|501|ERR_TUNNEL|Failed to load resource/.test(m.text())) pageErrors.push(m.text().slice(0, 300)); });
  return page;
};
const goTab = async (page, name) => { await page.click(`.leftnav >> text=${name}`); await page.waitForTimeout(150); };
const loadDemo = async (page) => {
  await goTab(page, "JSON");
  await page.waitForSelector("textarea.code");
  await page.click('button:has-text("edit")');
  await page.$eval("textarea.code", (el, v) => {
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value").set.call(el, v);
    el.dispatchEvent(new Event("input", { bubbles: true }));
  }, JSON.stringify(buildMasterDemoSurvey("sandbox")));
  await page.click('button:has-text("validate & apply")');
  await page.waitForTimeout(800);
  await goTab(page, "Questions");
};
const storage = (page, key) => page.evaluate((k) => window.localStorage.getItem(k), key);

/* ------------------------------------------------------------ the chooser */
{
  const page = await newPage();
  // the sandbox is exempt from the unasked-for chooser (it is not a first project); ?chooser=1 is the first-run path
  await page.goto(`${STUDIO}/sandbox`, { waitUntil: "networkidle" });
  await page.waitForSelector(".block-badge");
  await page.waitForTimeout(300);
  assert.equal(await page.$('[data-testid="mode-chooser"]'), null);
  ok("the sandbox never puts the chooser in front of anyone unasked");
  await page.goto(`${STUDIO}/sandbox?chooser=1`, { waitUntil: "networkidle" });
  await page.waitForSelector('[data-testid="mode-chooser"]');
  assert.equal(await page.textContent("#chooser-title"), "How do you want to program your research?");
  const cards = await page.$$eval('[data-testid="mode-chooser"] .chooser-card', (els) => els.map((e) => ({ name: e.querySelector(".chooser-name").textContent, index: e.querySelector(".chooser-index").textContent, disabled: e.disabled })));
  assert.deepEqual(cards.map((c) => c.name), ["Studio", "Grid", "Architect", "Flow", "Intelligent"]);
  assert.deepEqual(cards.map((c) => c.index), ["01", "02", "03", "04", "05"]);
  assert.ok(cards.every((c) => !c.disabled));
  ok("first run: the chooser asks the brief's question with five numbered, enabled cards");
  await page.keyboard.press("Escape");
  await page.waitForSelector('[data-testid="mode-chooser"]', { state: "detached" });
  assert.equal(await storage(page, "rescript.modeChooserSeen"), "1");
  ok("Escape dismisses it and it is remembered as seen");
  await page.goto(`${STUDIO}/sandbox?chooser=1`, { waitUntil: "networkidle" });
  await page.waitForSelector('[data-testid="mode-chooser"]');
  await page.keyboard.press("Escape");
  await page.waitForSelector('[data-testid="mode-chooser"]', { state: "detached" });
  ok("?chooser=1 asks again on purpose (the way to see the first run again)");
  await page.click('[data-testid="open-chooser"]');
  await page.waitForSelector('[data-testid="mode-chooser"]');
  assert.equal(await page.$eval('[data-testid="chooser-studio"]', (e) => e.classList.contains("current")), true);
  ok("the ⓘ in the top bar reopens it, marking the current mode");
  await page.click('[data-testid="chooser-dismiss"]');
  await page.waitForSelector('[data-testid="mode-chooser"]', { state: "detached" });
  await page.keyboard.press(`${mod}+k`);
  await page.waitForSelector('[data-testid="command-palette"]');
  await page.fill('[data-testid="command-palette"] input', "choose how");
  await page.waitForSelector(".palette-item.active");
  await page.keyboard.press("Enter");
  await page.waitForSelector('[data-testid="mode-chooser"]');
  ok("⌘K → “Choose how to program…” reopens it too");
  await page.click('[data-testid="chooser-flow"]');
  await page.waitForSelector('[data-testid="flow-view"]');
  assert.match(page.url(), /mode=flow/);
  assert.equal(await storage(page, "rescript.programmingMode"), "flow");
  ok("a card picks the mode: Flow opens, the URL and memory follow");
  await page.context().close();
}
{
  const page = await newPage();
  await page.goto(`${STUDIO}/sandbox?mode=grid`, { waitUntil: "networkidle" });
  await page.waitForSelector('[data-testid="grid-view"]');
  await page.waitForTimeout(300);
  assert.equal(await page.$('[data-testid="mode-chooser"]'), null);
  ok("a shared ?mode= link is an answer already: no chooser");
  await page.context().close();
}

/* ------------------------------------------------------------ the selector */
{
  const page = await newPage();
  await page.goto(`${STUDIO}/sandbox?mode=grid`, { waitUntil: "networkidle" });
  await page.waitForSelector('[data-testid="grid-view"]');
  const idx = await page.$$eval('[data-testid="mode-selector"] .mode-index', (els) => els.map((e) => e.textContent));
  assert.deepEqual(idx, ["01", "02", "03", "04", "05"]);
  ok("the selector numbers the environments like an instrument's ranges");
  assert.equal(await page.$eval('[data-testid="focus-mode-toggle"]', (b) => b.disabled), false);
  await page.click('[data-testid="focus-mode-toggle"]');
  assert.equal(await page.getAttribute('[data-testid="focus-mode-toggle"]', "aria-pressed"), "true");
  await page.click('[data-testid="mode-flow"]');
  await page.waitForSelector('[data-testid="flow-view"]');
  assert.equal(await page.getAttribute('[data-testid="focus-toggle"]', "aria-pressed"), "true");
  ok("Focus from the top bar is the same flag Flow's own chip shows — one view-level switch");
  await page.click('[data-testid="focus-mode-toggle"]');
  await page.context().close();
}

/* ------------------------------------------------------------ the split */
{
  const page = await newPage();
  await page.goto(`${STUDIO}/sandbox?mode=grid`, { waitUntil: "networkidle" });
  await page.waitForSelector('[data-testid="grid-view"]');
  await loadDemo(page);
  await page.waitForSelector('[data-testid="grid-view"]');
  assert.equal(await page.$eval('[data-testid="flow-inspector"], [data-testid="grid-view"]', () => true), true);

  await page.click('[data-testid="split-toggle"]');
  await page.waitForSelector('[data-testid="split-menu"]');
  const offered = await page.$$eval('[data-testid="split-menu"] .mode-menu-item', (els) => els.map((e) => e.dataset.testid));
  assert.deepEqual(offered, ["split-studio", "split-architect", "split-flow", "split-intelligent"], "every mode but the current one");
  await page.click('[data-testid="split-flow"]');
  await page.waitForSelector('[data-testid="split-view"]');
  assert.equal(await page.getAttribute('[data-testid="split-view"]', "data-primary"), "grid");
  assert.equal(await page.getAttribute('[data-testid="split-view"]', "data-secondary"), "flow");
  assert.match(page.url(), /mode=grid&split=flow/);
  await page.waitForSelector('[data-testid="split-secondary"] [data-testid="flow-view"]');
  await page.waitForSelector('[data-testid="split-primary"] [data-testid="grid-view"]');
  ok("Split · Flow: Grid on the left, Flow on the right, the URL says so");
  assert.equal(await page.$eval(".rightpanel", (e) => e.classList.contains("rp-hidden")), true);
  ok("the outer property panel steps aside for two renderers");
  assert.equal(await page.$eval('[data-testid="mode-flow"]', (e) => e.classList.contains("paired")), true);
  ok("the selector marks the paired mode");
  const inspectorShown = await page.$eval('[data-testid="split-secondary"] [data-testid="flow-inspector"]', (e) => getComputedStyle(e).display !== "none").catch(() => false);
  assert.equal(inspectorShown, false);
  ok("in a narrow pane the Flow inspector folds (container query) — the canvas keeps the room");

  // LIVE CROSS-MODE SYNC: edit in Grid, see it in Flow on the same render
  await page.click('[data-testid="split-secondary"] [data-testid="flow-granularity"] [data-granularity="questions"]');
  await page.waitForTimeout(500);
  await page.fill('[data-testid="split-secondary"] [data-testid="flow-search"]', "Q3 ");
  await page.waitForTimeout(400);
  const before = await page.$eval('[data-testid="split-secondary"] [data-testid="flow-node"][data-node="q_age"]', (e) => e.textContent);
  assert.match(before, /Q3/);
  const textCell = await page.$('[data-testid="split-primary"] [data-testid="grid-row"][data-code="Q3"] .sg-cell[data-col="text"]');
  await textCell.dblclick();
  await page.waitForSelector('[data-testid="grid-edit-text"]');
  await page.fill('[data-testid="grid-edit-text"]', "Your age in years");
  await page.keyboard.press("Enter");
  await page.waitForFunction(() => /Your age in years/.test(document.querySelector('[data-testid="split-secondary"] [data-testid="flow-node"][data-node="q_age"]')?.textContent ?? ""));
  ok("an edit typed in Grid is on the Flow canvas at once — one store, two windows (§8)");
  // and the selection is one too
  await page.click('[data-testid="split-secondary"] [data-testid="flow-node"][data-node="q_age"]');
  await page.waitForFunction(() => document.querySelector('[data-testid="split-primary"] [data-testid="grid-row"][data-code="Q3"]')?.getAttribute("aria-selected") === "true");
  ok("selecting the node in Flow selects the row in Grid");

  // swap, resize, close
  await page.click('[data-testid="split-swap-primary"]');
  await page.waitForFunction(() => document.querySelector('[data-testid="split-view"]')?.dataset.primary === "flow");
  assert.equal(await page.getAttribute('[data-testid="split-view"]', "data-secondary"), "grid");
  assert.match(page.url(), /mode=flow&split=grid/);
  ok("swap: choosing the partner as primary flips the pair rather than doubling it");
  const box = await page.$eval('[data-testid="split-view"]', (e) => { const r = e.getBoundingClientRect(); return { x: r.left, w: r.width, y: r.top + 300 }; });
  const div = await page.$('[data-testid="split-divider"]');
  const d = await div.boundingBox();
  await page.mouse.move(d.x + 3, d.y + 300); await page.mouse.down(); await page.mouse.move(box.x + box.w * 0.35, box.y, { steps: 6 }); await page.mouse.up();
  const ratio = await page.$eval('[data-testid="split-view"]', (e) => e.style.gridTemplateColumns);
  assert.match(ratio, /0\.3[4-6]\d*fr/);
  ok(`the divider drags and the ratio is kept: ${ratio}`);
  await page.click('[data-testid="split-close-secondary"]');
  await page.waitForSelector('[data-testid="split-view"]', { state: "detached" });
  await page.waitForSelector('[data-testid="flow-view"]');
  assert.doesNotMatch(page.url(), /split=/);
  ok("closing the right pane keeps the left one — a single Flow, the URL cleared");

  // memory and URL precedence
  await page.click('[data-testid="split-toggle"]'); await page.click('[data-testid="split-grid"]');
  await page.waitForSelector('[data-testid="split-view"]');
  await page.goto(`${STUDIO}/sandbox`, { waitUntil: "networkidle" });
  await page.waitForSelector('[data-testid="split-view"]');
  ok("with no URL, the remembered pair (Flow + Grid) comes back");
  await page.goto(`${STUDIO}/sandbox?mode=grid`, { waitUntil: "networkidle" });
  await page.waitForSelector('[data-testid="grid-view"]');
  await page.waitForTimeout(200);
  assert.equal(await page.$('[data-testid="split-view"]'), null);
  ok("a URL that names a mode is a deliberate single view — memory does not add a split");
  await page.goto(`${STUDIO}/sandbox?mode=grid&split=grid`, { waitUntil: "networkidle" });
  await page.waitForSelector('[data-testid="grid-view"]');
  assert.equal(await page.$('[data-testid="split-view"]'), null);
  ok("a split of a mode with itself is refused");

  // closing the primary keeps the secondary
  await page.goto(`${STUDIO}/sandbox?mode=grid&split=architect`, { waitUntil: "networkidle" });
  await page.waitForSelector('[data-testid="split-view"]');
  await page.click('[data-testid="split-close-primary"]');
  await page.waitForSelector('[data-testid="split-view"]', { state: "detached" });
  await page.waitForSelector('[data-testid="architect-view"]');
  assert.match(page.url(), /mode=architect/);
  ok("closing the left pane keeps the right one as the mode");

  // ⌘K
  await page.keyboard.press(`${mod}+k`);
  await page.waitForSelector('[data-testid="command-palette"]');
  await page.fill('[data-testid="command-palette"] input', "split with intelligent");
  await page.waitForSelector(".palette-item.active");
  await page.keyboard.press("Enter");
  await page.waitForSelector('[data-testid="split-view"][data-secondary="intelligent"]');
  await page.waitForSelector('[data-testid="split-secondary"] [data-testid="intelligent-view"]');
  ok("⌘K “Split with Intelligent” — the split is a command like any other");
  await page.keyboard.press(`${mod}+k`);
  await page.waitForSelector('[data-testid="command-palette"]');
  await page.fill('[data-testid="command-palette"] input', "close split");
  await page.waitForSelector(".palette-item.active");
  await page.keyboard.press("Enter");
  await page.waitForSelector('[data-testid="split-view"]', { state: "detached" });
  ok("and “Close split view” ends it");
  await page.context().close();
}

/* ------------------------------------------------------------ responsive */
{
  const page = await newPage({ width: 1600, height: 950 });
  await page.goto(`${STUDIO}/sandbox?mode=grid&split=flow`, { waitUntil: "networkidle" });
  await page.waitForSelector('[data-testid="split-view"]');
  await page.setViewportSize({ width: 1000, height: 900 });
  await page.waitForSelector('[data-testid="split-view"]', { state: "detached" });
  await page.waitForSelector('[data-testid="grid-view"]');
  assert.equal(await page.$eval('[data-testid="split-toggle"]', (b) => b.disabled), true);
  ok("below 1100px the split folds to the primary and the Split control is disabled");
  await page.setViewportSize({ width: 1600, height: 950 });
  await page.waitForSelector('[data-testid="split-view"]');
  ok("widening the window brings the pair back — the split was kept, not dropped");
  await page.click('[data-testid="split-toggle"]'); await page.click('[data-testid="split-off"]');
  await page.waitForSelector('[data-testid="split-view"]', { state: "detached" });
  await page.click('[data-testid="mode-architect"]');
  await page.waitForSelector('[data-testid="architect-view"]');
  const wide = await page.$eval('[data-testid="architect-view"] .ar-inspector', (e) => getComputedStyle(e).display !== "none");
  assert.equal(wide, true);
  await page.setViewportSize({ width: 1150, height: 900 });
  await page.waitForTimeout(300);
  const narrow = await page.$eval('[data-testid="architect-view"] .ar-inspector', (e) => getComputedStyle(e).display !== "none");
  assert.equal(narrow, false);
  const map = await page.$eval('[data-testid="architect-view"] .ar-map', (e) => getComputedStyle(e).display !== "none");
  assert.equal(map, true);
  ok("Architect in a narrow centre folds its inspector and keeps the map (§17 collapse rules per mode)");
  // under 900px the shell itself folds to one column, so the centre is the whole window; the map goes at phone width
  await page.setViewportSize({ width: 620, height: 900 });
  await page.waitForTimeout(300);
  assert.equal(await page.$eval('[data-testid="architect-view"] .ar-map', (e) => getComputedStyle(e).display !== "none"), false);
  ok("narrower still, the map folds too — the workspace is what remains");
  await page.setViewportSize({ width: 880, height: 900 });
  await page.waitForTimeout(300);
  assert.equal(await page.$eval('[data-testid="mode-selector"]', (e) => getComputedStyle(e).display !== "none"), true);
  ok("the mode selector survives the mobile fold");
  await page.context().close();
}

assert.deepEqual(pageErrors, [], `page errors: ${pageErrors.join("\n")}`);
ok("no page errors");
await browser.close();
console.log(`\n  ${passed} checks passed`);

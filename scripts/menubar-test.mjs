/**
 * THE MENUBAR — the Studio's tools as a horizontal, hover-revealed command bar
 * (navigation redesign, 2026-09-25).
 *
 *   node scripts/menubar-test.mjs
 */
import assert from "node:assert/strict";
import { chromium } from "/home/claude/.npm-global/lib/node_modules/playwright/index.mjs";
import { openTab, openGroup, navLabels, switchMode, modeMenuClick } from "./lib/nav.mjs";
import { buildMasterDemoSurvey } from "../packages/templates/dist/index.js";

const STUDIO = process.env.STUDIO_URL ?? "http://localhost:3000";
let passed = 0;
const ok = (msg) => { passed++; console.log(`  ok   ${msg}`); };

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
const pageErrors = [];
page.on("pageerror", (e) => pageErrors.push(String(e)));
page.on("console", (m) => { if (m.type() === "error" && !/401|501|ERR_TUNNEL|Failed to load resource/.test(m.text())) pageErrors.push(m.text().slice(0, 300)); });

const panel = (id) => `[data-testid="menu-panel-${id}"]`;
const button = (id) => `[data-testid="menu-button-${id}"]`;
const rect = (sel) => page.$eval(sel, (e) => { const r = e.getBoundingClientRect(); return { x: r.left, y: r.top, w: r.width, h: r.height, b: r.bottom }; });

await page.goto(`${STUDIO}/sandbox?mode=studio`, { waitUntil: "networkidle" });
await page.waitForSelector(".menubar");

/* ------------------------------------------------------------ the shape */
{
  assert.equal(await page.$(".leftnav"), null);
  ok("there is no vertical sidebar");
  const groups = await page.$$eval(".menubar-groups [data-group-button]", (bs) => bs.map((b) => b.dataset.groupButton));
  assert.deepEqual(groups, ["programming", "research", "results", "management", "mode"]);
  ok("Programming · Research Tools · Results · Management · Mode, in that order");
  const m = await page.evaluate(() => { const r = (s) => document.querySelector(s)?.getBoundingClientRect(); const c = r(".center"), t = r(".topbar"), mb = r(".menubar"), rp = r(".rightpanel:not(.rp-hidden)"); return { topbar: t.height, menubar: mb.height, menubarTop: mb.top, centre: c.width, centreTop: c.top, right: rp?.width ?? 0, vw: innerWidth, vh: innerHeight }; });
  assert.ok(m.menubar <= 40 && m.topbar <= 60, JSON.stringify(m));
  assert.ok(m.centre + m.right >= m.vw - 2, `the body is the whole width: ${JSON.stringify(m)}`);
  assert.ok(m.centre >= 0.7 * m.vw, `the workspace is the dominant part of the screen: ${Math.round(m.centre / m.vw * 100)}%`);
  ok(`the workspace is ${Math.round(m.centre / m.vw * 100)}% of the width at 1440 with nothing selected (was 58% beside the sidebar and the properties panel)`);
  assert.equal(await page.$eval("[data-group-button='programming']", (b) => b.dataset.navItems), "Questions Survey_Settings Survey_Flow Logic Variables Calculations Quotas List_Fill");
  ok("a group button says what it holds without opening");
  const labels = await navLabels(page);
  assert.deepEqual(labels, ["Questions", "Survey Settings", "Survey Flow", "Logic", "Variables", "Calculations", "Quotas", "List Fill", "Design Generators", "Branding", "Assets", "Translation", "Scripts", "Tests", "Data", "Data Analytics", "Fieldwork", "Project", "Usage & Wallet", "Distribution", "Versions & Deploy", "JSON", "Collaborators", "Internal notes", "Activity"]);
  ok(`every one of the sidebar's ${labels.length} tools is in a menu, in the sidebar's order`);
  const topbar = await page.$$eval(".topbar .btn, .topbar [data-testid]", (els) => els.map((e) => e.textContent.trim()).filter(Boolean));
  for (const t of ["Preview", "Test Survey", "Variables .xlsx", "Export", "Data", "Save version"]) assert.ok(topbar.some((x) => x.includes(t)), `${t} still in the top bar: ${topbar.join(" | ")}`);
  const clipped = await page.$$eval(".topbar > *", (els) => els.filter((e) => e.getBoundingClientRect().right > innerWidth + 1).length);
  assert.equal(clipped, 0);
  ok("the top bar's actions all fit at 1440 — nothing runs off the edge any more");
}

/* ------------------------------------------------------------ hover → see → click */
{
  assert.equal(await page.$(panel("programming")), null, "closed menus are not in the DOM");
  await page.hover(button("programming"));
  await page.waitForSelector(panel("programming"));
  ok("hovering Programming opens its menu");
  const items = await page.$$eval(`${panel("programming")} .nav-item`, (els) => els.map((e) => ({ label: e.querySelector(".nav-label").childNodes[0].textContent, desc: e.querySelector(".nav-desc").textContent, active: e.classList.contains("active") })));
  assert.equal(items.length, 8);
  assert.ok(items.every((i) => i.desc.length > 8), "every tool has a one-line preview");
  assert.equal(items[0].active, true);
  ok("the menu previews each tool and marks the one on screen");
  // moving across the bar switches menus with no delay
  await page.hover(button("research"));
  await page.waitForSelector(panel("research"));
  assert.equal(await page.$(panel("programming")), null);
  ok("moving to Research Tools switches the open menu");
  await page.waitForTimeout(200); // the 120 ms slide-in
  const p = await rect(panel("research"));
  const bar = await rect(".menubar");
  assert.ok(p.y >= bar.b - 2, `the menu hangs from the bar: ${p.y} vs ${bar.b}`);
  // leaving closes
  await page.mouse.move(700, 600);
  await page.waitForSelector(panel("research"), { state: "detached" });
  ok("leaving the bar closes the menu — nothing stays over the workspace");
  // click also opens; click again closes
  await page.click(button("management"));
  await page.waitForSelector(panel("management"));
  await page.click(button("management"));
  await page.waitForSelector(panel("management"), { state: "detached" });
  ok("a click opens and a second click closes");
  // choose a tool
  await openTab(page, "JSON");
  await page.waitForSelector("textarea.code");
  assert.equal(await page.$(panel("management")), null);
  assert.equal(await page.$eval('[data-testid="where-am-i"]', (e) => e.dataset.tab), "json");
  assert.match(await page.textContent(".menubar-here"), /Management.*JSON/);
  assert.equal(await page.$eval("[data-group-button='management']", (b) => b.closest(".menubar-group").classList.contains("here")), true);
  ok("hover → see → move → click opens JSON; the crumb and the group say where you are");
}

/* ------------------------------------------------------------ the demo survey */
{
  await page.click('button:has-text("edit")');
  await page.$eval("textarea.code", (el, v) => {
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value").set.call(el, v);
    el.dispatchEvent(new Event("input", { bubbles: true }));
  }, JSON.stringify(buildMasterDemoSurvey("sandbox")));
  await page.click('button:has-text("validate & apply")');
  await page.waitForTimeout(800);
  ok("`button:has-text(\"edit\")` finds the JSON tab's button, not a menu item — closed menus are out of the DOM");
  await openTab(page, "Questions");
  await page.waitForSelector('[data-testid="qcard"]');
  assert.match(await page.textContent(".menubar-here"), /Questions160/);
  ok("the crumb carries the count the sidebar item used to");
}

/* ------------------------------------------------------------ keyboard */
{
  await page.focus(button("programming"));
  await page.keyboard.press("ArrowRight");
  assert.equal(await page.evaluate(() => document.activeElement?.dataset.groupButton), "research");
  await page.keyboard.press("ArrowDown");
  await page.waitForSelector(panel("research"));
  assert.equal(await page.evaluate(() => document.activeElement?.dataset.testid), "nav-designs");
  await page.keyboard.press("ArrowDown");
  assert.equal(await page.evaluate(() => document.activeElement?.dataset.testid), "nav-branding");
  await page.keyboard.press("End");
  assert.equal(await page.evaluate(() => document.activeElement?.dataset.testid), "nav-tests");
  await page.keyboard.press("ArrowRight");
  await page.waitForSelector(panel("results"));
  assert.equal(await page.evaluate(() => document.activeElement?.dataset.testid), "nav-data");
  ok("←/→ walk the groups, ↓ opens, ↑/↓ and End walk the items, → switches the open menu");
  await page.keyboard.press("Escape");
  await page.waitForSelector(panel("results"), { state: "detached" });
  assert.equal(await page.evaluate(() => document.activeElement?.dataset.groupButton), "results");
  ok("Escape closes and returns focus to the group");
  await page.keyboard.press("ArrowDown");
  await page.waitForSelector(panel("results"));
  await page.keyboard.press("ArrowDown");
  await page.keyboard.press("ArrowDown");
  await page.keyboard.press("Enter");
  await page.waitForSelector('[data-testid="where-am-i"][data-tab="fieldwork"]');
  ok("Enter on an item opens the tool (Fieldwork) — keyboard-only navigation works end to end");
  await openTab(page, "Questions");
}

/* ------------------------------------------------------------ never over the questionnaire */
{
  await page.waitForSelector('[data-testid="qcard"]');
  const card = await rect('[data-testid="qcard"]');
  const bar = await rect(".menubar");
  assert.ok(card.y >= bar.b, "the first question sits below the bar");
  const overlapping = await page.evaluate(() => {
    const q = document.querySelector('[data-testid="qcard"]').getBoundingClientRect();
    const hit = document.elementFromPoint(q.left + 20, q.top + 10);
    return !hit?.closest('[data-testid="qcard"]');
  });
  assert.equal(overlapping, false);
  ok("with no menu open, nothing covers the questionnaire");
  await page.hover(button("programming"));
  await page.waitForSelector(panel("programming"));
  await page.mouse.move(900, 600);
  await page.waitForSelector(panel("programming"), { state: "detached" });
  ok("a menu that was open is gone the moment the pointer leaves it");
}

/* ------------------------------------------------------------ mode menu */
{
  await switchMode(page, "grid");
  await page.waitForSelector('[data-testid="grid-view"]');
  assert.match(await page.textContent(button("mode")), /Mode02Grid/);
  assert.match(await page.textContent('[data-testid="here-mode"]'), /02Grid/);
  ok("Mode → Grid switches the environment; the Mode button and the crumb both say 02 Grid");
  await modeMenuClick(page, "focus-mode-toggle");
  assert.equal(await page.$eval('[data-testid="ide"]', (e) => e.classList.contains("is-focus")), true);
  await switchMode(page, "studio");
  await page.waitForSelector('[data-testid="qcard"]');
  assert.equal(await page.$eval('[data-testid="ide"]', (e) => e.classList.contains("focus-studio")), true);
  await page.mouse.move(700, 600);
  await page.waitForTimeout(300); // the 160 ms tuck
  const tucked = await page.$eval(".menubar", (e) => e.getBoundingClientRect().bottom);
  const top = await page.$eval(".topbar", (e) => e.getBoundingClientRect().bottom);
  assert.ok(tucked <= top + 6, `the menubar is tucked to a hairline in Focus: ${tucked} vs ${top}`);
  await page.click('[data-testid="qcard"] >> nth=1');
  await page.waitForTimeout(200);
  const dim = await page.$$eval('[data-testid="qcard"]', (els) => els.slice(0, 3).map((e) => Number(getComputedStyle(e).opacity)));
  assert.ok(dim[1] === 1 && dim[0] < 1 && dim[2] < 1, `only the selected card is lit: ${dim.join(",")}`);
  ok("Focus in Studio: the menubar tucks away and unselected questions go quiet");
  await page.mouse.move(400, top + 2);   // the hairline at the top edge of the workspace
  await page.waitForTimeout(300);
  const revealed = await page.$eval(".menubar", (e) => e.getBoundingClientRect().bottom);
  assert.ok(revealed > tucked + 20, "hovering the top edge reveals it");
  ok("and hovering the top edge brings it back");
  await modeMenuClick(page, "focus-mode-toggle");
  await page.waitForTimeout(200);
  assert.equal(await page.$eval('[data-testid="ide"]', (e) => e.classList.contains("focus-studio")), false);
}

/* ------------------------------------------------------------ responsive */
{
  await page.setViewportSize({ width: 1100, height: 800 });
  await page.waitForTimeout(400);
  let groups = await page.$$eval(".menubar-groups [data-group-button]", (bs) => bs.map((b) => b.dataset.groupButton));
  assert.ok(!groups.includes("more"), `everything fits at 1100: ${groups.join(",")}`);
  await page.setViewportSize({ width: 600, height: 800 });
  await page.waitForTimeout(400);
  groups = await page.$$eval(".menubar-groups [data-group-button]", (bs) => bs.map((b) => b.dataset.groupButton));
  assert.ok(groups.includes("more"), `narrow: the groups that do not fit fold into More/Menu: ${groups.join(",")}`);
  const folded = await page.$eval("[data-group-button='more']", (b) => b.dataset.navItems.split(" ").length);
  assert.ok(folded >= 8, `More holds at least one whole group (${folded} items)`);
  ok(`at 600px the bar folds ${folded} tools into ${groups.length === 2 ? "one Menu" : "More"} and keeps the hierarchy`);
  await openTab(page, "JSON");
  await page.waitForSelector("textarea.code");
  ok("a tool inside More opens the same way");
  const overlap = await page.evaluate(() => { const c = document.querySelector(".center").getBoundingClientRect(); const m = document.querySelector(".menubar").getBoundingClientRect(); return c.top < m.bottom - 1; });
  assert.equal(overlap, false);
  ok("the narrow bar does not overlap the workspace either");
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.waitForTimeout(400);
  groups = await page.$$eval(".menubar-groups [data-group-button]", (bs) => bs.map((b) => b.dataset.groupButton));
  assert.deepEqual(groups, ["programming", "research", "results", "management", "mode"]);
  ok("widening unfolds them again");
  await openTab(page, "Questions");
}

/* ------------------------------------------------------------ ⌘K still navigates */
{
  const mod = process.platform === "darwin" ? "Meta" : "Control";
  await page.keyboard.press(`${mod}+k`);
  await page.waitForSelector('[data-testid="command-palette"]');
  await page.fill('[data-testid="command-palette"] input', "open logic");
  await page.waitForSelector(".palette-item.active");
  await page.keyboard.press("Enter");
  await page.waitForSelector('[data-testid="where-am-i"][data-tab="logic"]');
  ok("⌘K “Open Logic” is the keyboard route to any tool, unchanged");
}

assert.deepEqual(pageErrors, [], `page errors: ${pageErrors.join("\n")}`);
ok("no page errors");
await browser.close();
console.log(`\n  ${passed} checks passed`);

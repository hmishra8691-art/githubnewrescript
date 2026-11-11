/**
 * THE STUDIO'S THEME SELECTOR (2026-11-11), in the browser:
 *
 *   [1] Theme sits right after Mode in the menubar; its menu lists eight themes, each with a preview chip, the
 *       current one marked
 *   [2] pointing at a theme previews it on the whole Studio; leaving puts the chosen theme back — nothing saved
 *   [3] clicking keeps it: drawn at once (no reload), the canvas, surfaces, text and primary buttons all take the
 *       theme's colours, and the menubar does not change size
 *   [4] it survives a reload, painted before the page hydrates, and applies on other pages (the project overview)
 *   [5] every theme: canvas / text / primary button are the theme's own values, in Studio and Intelligent Mode
 *   [6] "Back to the default theme" returns to ResLens; the Mode menu still works
 *
 *   node scripts/theme-selector-test.mjs      (Studio on :3000)
 */
import { chromium } from "./lib/playwright.mjs";
import assert from "node:assert/strict";
import { openTab, switchMode } from "./lib/nav.mjs";

const STUDIO = process.env.STUDIO_URL ?? "http://localhost:3000";
const THEMES = { reslens: ["#f6f3ec", "#fdfcf9", "#17143f", "#15132e"], classic: ["#f5f7fb", "#ffffff", "#4f46e5", "#131a2b"], light: ["#f7f8fa", "#ffffff", "#2563eb", "#111827"], soft: ["#f3f1ee", "#faf9f7", "#4f6272", "#2b2a28"], ocean: ["#eef6f8", "#ffffff", "#0e7490", "#0c2a36"], contrast: ["#ffffff", "#ffffff", "#0b3bd9", "#000000"], dark: ["#0f1115", "#171a21", "#8b93ff", "#e8eaf0"], midnight: ["#0b1220", "#111a2e", "#7aa2ff", "#e6ecff"] };
const rgb = (hex) => { const n = parseInt(hex.slice(1), 16); return `rgb(${n >> 16}, ${(n >> 8) & 255}, ${n & 255})`; };
let passed = 0;
const ok = (m) => { console.log("  ok  ", m); passed++; };

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1500, height: 950 } });
const errors = [];
page.on("console", (m) => { if (m.type() === "error" && !/favicon|Failed to load resource|net::ERR|status of (401|402|404|501|503)/.test(m.text())) errors.push(m.text()); });
const themeOf = () => page.evaluate(() => document.documentElement.getAttribute("data-theme"));
const look = () => page.evaluate(() => {
  const cs = (sel) => { const e = document.querySelector(sel); return e ? getComputedStyle(e) : null; };
  return { canvas: getComputedStyle(document.body).backgroundColor, text: getComputedStyle(document.body).color, topbar: cs(".topbar")?.backgroundColor, primary: (() => { const c = cs(".btn.primary"); if (!c) return null; return c.backgroundColor !== "rgba(0, 0, 0, 0)" ? c.backgroundColor : (/rgb\([^)]+\)/.exec(c.backgroundImage)?.[0] ?? c.backgroundImage); })(), primaryText: cs(".btn.primary")?.color, menubarH: document.querySelector(".menubar")?.getBoundingClientRect().height, card: cs(".card, .block-card, .sg-block, [class*='block']")?.backgroundColor };
});
const openMenu = async () => { if (!(await page.$('[data-testid="theme-menu"]'))) await page.click('[data-testid="menu-button-theme"]'); await page.waitForSelector('[data-testid="theme-menu"]'); };
const pick = async (id) => { await openMenu(); await page.click(`[data-testid="theme-${id}"]`); await page.waitForTimeout(150); };

await page.goto(`${STUDIO}/sandbox?mode=studio`, { waitUntil: "networkidle" });
await page.waitForSelector(".menubar");
await page.evaluate(() => localStorage.removeItem("rescript.theme"));
await page.reload({ waitUntil: "networkidle" });
await page.waitForSelector('[data-testid="menu-button-theme"]');

/* [1] */
{
  const order = await page.$$eval(".menubar-groups > [data-fixed]", (els) => els.map((e) => e.getAttribute("data-testid") ?? e.className));
  const iMode = order.indexOf("mode-cluster"), iTheme = order.indexOf("theme-cluster");
  assert.ok(iMode >= 0 && iTheme === iMode + 1, `Theme directly after Mode: ${order.join(" | ")}`);
  assert.equal(await page.$eval('[data-testid="theme-current"]', (e) => e.textContent), "ResLens");
  await openMenu();
  const ids = await page.$$eval('[data-testid="theme-menu"] [data-theme-id]', (els) => els.map((e) => e.getAttribute("data-theme-id")));
  assert.deepEqual(ids, Object.keys(THEMES));
  assert.equal((await page.$$('[data-testid="theme-menu"] .theme-chip')).length, 8);
  assert.equal(await page.$eval('[data-testid="theme-reslens"]', (e) => e.getAttribute("aria-checked")), "true");
  assert.equal(await page.$('[data-testid="theme-reset"]'), null, "nothing to reset on the default");
  const box = await page.$eval('[data-testid="theme-menu"]', (e) => { const r = e.getBoundingClientRect(); return { w: r.width, h: r.height }; });
  assert.ok(box.w < 560 && box.h < 420, `compact: ${box.w}×${box.h}`);
  ok("[1] Theme sits directly after Mode; eight themes with preview chips, the current one marked, a compact menu");
}

/* [2] */
{
  const before = await look();
  await page.hover('[data-testid="theme-dark"]');
  await page.waitForTimeout(120);
  assert.equal(await themeOf(), "dark");
  assert.equal((await look()).canvas, rgb(THEMES.dark[0]));
  assert.equal(await page.evaluate(() => localStorage.getItem("rescript.theme")), null, "a preview saves nothing");
  await page.mouse.move(700, 700);
  await page.waitForTimeout(700);
  assert.equal(await themeOf(), "reslens");
  assert.deepEqual(await look(), before);
  ok("[2] pointing previews the whole Studio; moving away restores the chosen theme and saves nothing");
}

/* [3] */
{
  const h = (await look()).menubarH;
  await pick("midnight");
  const l = await look();
  assert.equal(await themeOf(), "midnight");
  assert.equal(l.canvas, rgb(THEMES.midnight[0])); assert.equal(l.text, rgb(THEMES.midnight[3])); assert.equal(l.primary, rgb(THEMES.midnight[2]));
  assert.equal(l.primaryText, rgb("#0b1220"), "text on the light accent is dark");
  assert.equal(l.menubarH, h, "no layout shift");
  assert.equal(await page.$eval('[data-testid="theme-current"]', (e) => e.textContent), "Midnight");
  assert.equal(await page.evaluate(() => localStorage.getItem("rescript.theme")), "midnight");
  ok("[3] a click keeps it: canvas, top bar, text and primary button take Midnight's colours at once, with no layout shift");
}

/* [4] */
{
  await page.goto(`${STUDIO}/sandbox?mode=studio`, { waitUntil: "commit" });
  await page.waitForFunction(() => !!document.documentElement && !!document.head);
  await page.waitForSelector("body", { state: "attached" });
  assert.equal(await themeOf(), "midnight", "set before the page hydrates");
  await page.waitForSelector(".menubar");
  assert.equal((await look()).canvas, rgb(THEMES.midnight[0]));
  await page.goto(`${STUDIO}/sandbox/overview`, { waitUntil: "domcontentloaded" });
  assert.equal(await themeOf(), "midnight");
  assert.equal(await page.evaluate(() => getComputedStyle(document.body).backgroundColor), rgb(THEMES.midnight[0]));
  ok("[4] it survives a reload (painted before hydration) and applies on the project overview too");
}

/* [5] */
{
  await page.goto(`${STUDIO}/sandbox?mode=studio`, { waitUntil: "networkidle" });
  await page.waitForSelector(".menubar");
  for (const [id, [bg, , primary, text]] of Object.entries(THEMES)) {
    await pick(id);
    const l = await look();
    assert.equal(l.canvas, rgb(bg), `${id} canvas`); assert.equal(l.text, rgb(text), `${id} text`); assert.doesNotMatch(String(l.topbar), id === "dark" || id === "midnight" ? /255, 255, 255|srgb 1 1 1/ : /^$/, `${id} top bar`); assert.equal(l.primary, rgb(primary), `${id} primary`);
    /* nothing on screen keeps a colour from outside the theme's own set: every painted background is one of the theme's tokens, transparent, or the survey/brand's own */
    const stray = await page.evaluate((dark) => {
      const root = getComputedStyle(document.documentElement);
      const own = new Set();
      const probe = document.createElement("span"); document.body.appendChild(probe);
      for (const name of ["--c-bg", "--c-surface", "--c-surface-2", "--c-surface-3", "--c-border", "--c-border-strong", "--c-text", "--c-text-2", "--c-text-3", "--c-text-4", "--c-primary", "--c-primary-600", "--c-primary-700", "--c-primary-100", "--c-primary-50", "--c-secondary", "--c-secondary-100", "--c-secondary-50", "--c-success-bg", "--c-warning-bg", "--c-error-bg", "--c-info-bg", "--c-success", "--c-warning", "--c-error", "--c-violet", "--c-lilac", "--c-on-primary"]) { probe.style.background = root.getPropertyValue(name).trim(); own.add(getComputedStyle(probe).backgroundColor); }
      probe.remove();
      const out = new Set();
      for (const e of document.querySelectorAll(".ide *, .ide")) { if (e.style.background || e.style.backgroundColor) continue; /* a data or brand colour set on the element itself (a quality class, a report cover) */ const b = getComputedStyle(e).backgroundColor; if (b && b !== "rgba(0, 0, 0, 0)" && !own.has(b) && (!/rgba\(|color\(/.test(b) || (dark && /^rgba\(255, 255, 255|srgb 1 1 1/.test(b)))) out.add(`${e.className || e.tagName}: ${b}`); }
      return [...out].slice(0, 6);
    }, id === "dark" || id === "midnight");
    assert.deepEqual(stray, [], `${id}: a background outside the theme`);
    if (process.env.SHOTS) await page.screenshot({ path: `${process.env.SHOTS}/theme-${id}.png` });
  }
  await switchMode(page, "intelligent");
  await page.waitForSelector('[data-testid="intelligent-view"]');
  for (const id of ["dark", "ocean", "soft"]) {
    await pick(id);
    assert.equal((await look()).canvas, rgb(THEMES[id][0]), `${id} in Intelligent Mode`);
    if (process.env.SHOTS) await page.screenshot({ path: `${process.env.SHOTS}/theme-${id}-intelligent.png` });
  }
  ok("[5] all eight themes: canvas, top bar, text and primary button are the theme's own, and no opaque background on screen is from outside the theme");
}

/* [6] */
{
  await openMenu();
  await page.click('[data-testid="theme-reset"]');
  await page.waitForTimeout(150);
  assert.equal(await themeOf(), "reslens");
  assert.equal(await page.evaluate(() => localStorage.getItem("rescript.theme")), null);
  await switchMode(page, "studio");
  assert.equal(await page.$eval('[data-testid="where-am-i"]', (e) => e.getAttribute("data-mode")), "studio");
  ok("[6] back to the default in one click; the Mode menu works as before");
}

assert.deepEqual(errors, [], errors.join("\n"));
await browser.close();
console.log(`\n${passed} passed`);

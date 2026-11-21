/**
 * ACCESSIBILITY CHECKS OF THE RESPONDENT PORTAL IN A REAL BROWSER (phase 6, 2026-11-20 — runtime only, sandbox store).
 *
 * Automated checks of every portal page against the parts of WCAG 2.2 AA a script can decide. They do not replace
 * a person with a screen reader; they stop the regressions a script CAN see:
 *
 *   page       a language, a title, one h1, a <main>, headings that do not skip a level
 *   names      every field has a label; every button and link has a name; every picture-role element has one
 *   contrast   text against its background: 4.5:1 (3:1 for large text)                      (1.4.3)
 *   keyboard   every control is reachable with Tab, in page order, and shows where the focus is   (2.1.1, 2.4.7)
 *   targets    controls are at least 24 × 24 CSS pixels (links inside a sentence excepted)   (2.5.8)
 *   reflow     no sideways scrolling at 320 CSS pixels                                       (1.4.10)
 *   tables     data tables have header cells
 */
import assert from "node:assert/strict";
import { chromium } from "./lib/playwright.mjs";

const RUNTIME = process.env.RUNTIME_URL ?? "http://localhost:3001";
const PASSWORD = "sandbox portal password";
const INVITE = "sandbox-invitation-token-000000000000000000";
let passed = 0;
const problems = [];

const browser = await chromium.launch();
const context = await browser.newContext({ baseURL: RUNTIME });
const page = await context.newPage();
page.setDefaultTimeout(60_000);

/* runs in the page: everything a script can decide about what is on screen now */
const audit = () => {
  const out = [];
  const say = (rule, el, detail = "") => out.push(`${rule}: <${el.tagName.toLowerCase()}${el.getAttribute?.("data-testid") ? ` data-testid="${el.getAttribute("data-testid")}"` : ""}${el.className && typeof el.className === "string" ? ` class="${el.className}"` : ""}> ${String(el.textContent ?? "").trim().slice(0, 50)} ${detail}`.trim());
  const visible = (el) => { const r = el.getBoundingClientRect(); const s = getComputedStyle(el); return r.width > 0 && r.height > 0 && s.visibility !== "hidden" && s.display !== "none"; };
  const nameOf = (el) => {
    const by = el.getAttribute("aria-labelledby");
    if (by) return by.split(/\s+/).map((id) => document.getElementById(id)?.textContent ?? "").join(" ").trim();
    return (el.getAttribute("aria-label") ?? "").trim() || (el.id && document.querySelector(`label[for="${CSS.escape(el.id)}"]`)?.textContent?.trim()) || el.closest("label")?.textContent?.trim() || (el.getAttribute("title") ?? "").trim();
  };
  if (!document.documentElement.lang) out.push("page: <html> has no lang");
  if (!document.title.trim()) out.push("page: no <title>");
  if (document.querySelectorAll("h1").length !== 1) out.push(`page: ${document.querySelectorAll("h1").length} h1 elements`);
  if (!document.querySelector("main")) out.push("page: no <main>");
  let last = 0;
  for (const h of document.querySelectorAll("h1,h2,h3,h4,h5,h6")) { if (!visible(h)) continue; const n = Number(h.tagName[1]); if (last && n > last + 1) say("headings: a level is skipped", h, `(h${last} → h${n})`); last = n; }
  for (const el of document.querySelectorAll("input:not([type=hidden]), select, textarea")) if (visible(el) && !nameOf(el)) say("names: a field has no label", el);
  for (const el of document.querySelectorAll("button, a[href], [role=button]")) if (visible(el) && !(el.textContent ?? "").trim() && !nameOf(el)) say("names: a control has no name", el);
  for (const el of document.querySelectorAll("[role=img], svg[role=img]")) if (visible(el) && !(el.getAttribute("aria-label") ?? "").trim()) say("names: a picture has no description", el);
  for (const el of document.querySelectorAll("[tabindex]")) if (Number(el.getAttribute("tabindex")) > 0) say("keyboard: a positive tabindex", el);
  for (const t of document.querySelectorAll("table")) if (visible(t) && !t.querySelector("th")) say("tables: no header cells", t);

  /* contrast of every piece of text against the first opaque background behind it */
  const rgb = (s) => { const m = /rgba?\(([^)]+)\)/.exec(s); if (!m) return null; const p = m[1].split(",").map((x) => parseFloat(x)); return { r: p[0], g: p[1], b: p[2], a: p[3] === undefined ? 1 : p[3] }; };
  const lum = (c) => { const f = (v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; }; return 0.2126 * f(c.r) + 0.7152 * f(c.g) + 0.0722 * f(c.b); };
  const over = (top, under) => ({ r: top.r * top.a + under.r * (1 - top.a), g: top.g * top.a + under.g * (1 - top.a), b: top.b * top.a + under.b * (1 - top.a), a: 1 });
  const background = (el) => { const layers = []; for (let n = el; n; n = n.parentElement) { const c = rgb(getComputedStyle(n).backgroundColor); if (c && c.a > 0) { layers.push(c); if (c.a === 1) break; } } let bg = { r: 255, g: 255, b: 255, a: 1 }; for (const c of layers.reverse()) bg = over(c, bg); return bg; };
  const seen = new Set();
  const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
  for (let n = walker.nextNode(); n; n = walker.nextNode()) {
    if (!n.textContent.trim()) continue;
    const el = n.parentElement;
    if (!el || !visible(el) || el.closest("svg") || el.closest("[disabled]") || el.closest("[aria-hidden=true]")) continue;
    const s = getComputedStyle(el);
    const fg = rgb(s.color); if (!fg) continue;
    const bg = background(el);
    const c = over(fg, bg);
    const [a, b] = [lum(c), lum(bg)].sort((x, y) => y - x);
    const ratio = (a + 0.05) / (b + 0.05);
    const size = parseFloat(s.fontSize), bold = Number(s.fontWeight) >= 700;
    const need = size >= 24 || (bold && size >= 18.66) ? 3 : 4.5;
    const key = `${el.tagName}.${el.className}|${s.color}|${JSON.stringify(bg)}`;
    if (ratio < need && !seen.has(key)) { seen.add(key); say("contrast", el, `${ratio.toFixed(2)}:1, needs ${need}:1 (${s.color} on rgb(${Math.round(bg.r)},${Math.round(bg.g)},${Math.round(bg.b)}))`); }
  }
  /* SVG text: the chart's labels */
  for (const t of document.querySelectorAll("svg text")) {
    if (!visible(t)) continue;
    const fg = rgb(getComputedStyle(t).fill); if (!fg) continue;
    const bg = background(t.closest("svg"));
    const [a, b] = [lum(over(fg, bg)), lum(bg)].sort((x, y) => y - x);
    const ratio = (a + 0.05) / (b + 0.05);
    const key = `svgtext|${t.getAttribute("class")}`;
    if (ratio < 4.5 && !seen.has(key)) { seen.add(key); say("contrast", t, `${ratio.toFixed(2)}:1, needs 4.5:1`); }
  }
  /* target size: 24 × 24, except a link inside a line of text */
  for (const el of document.querySelectorAll("button, a[href], input, select, textarea, summary")) {
    if (!visible(el)) continue;
    const r = el.getBoundingClientRect();
    const inline = el.tagName === "A" && getComputedStyle(el).display === "inline";
    const box = el.matches("input[type=checkbox], input[type=radio]") ? (el.closest("label") ?? el).getBoundingClientRect() : r;
    if (!inline && (box.width < 24 || box.height < 24)) say("targets: smaller than 24 × 24", el, `(${Math.round(box.width)} × ${Math.round(box.height)})`);
  }
  if (document.documentElement.scrollWidth - document.documentElement.clientWidth > 1) out.push(`reflow: the page scrolls sideways by ${document.documentElement.scrollWidth - document.documentElement.clientWidth}px`);
  return out;
};

/* Tab through the page: every control is reached, in order, and each shows its focus */
async function keyboard(name) {
  const expected = await page.evaluate(() => [...document.querySelectorAll("a[href], button:not([disabled]), input:not([disabled]):not([type=hidden]), select:not([disabled]), textarea:not([disabled]), summary")].filter((el) => { const r = el.getBoundingClientRect(); return r.width > 0 && r.height > 0 && getComputedStyle(el).visibility !== "hidden"; }).length);
  /* start from the top of the document, wherever the focus was left */
  await page.evaluate(() => { const top = document.createElement("span"); top.tabIndex = -1; top.id = "a11y-top"; document.body.prepend(top); top.focus(); window.scrollTo(0, 0); });
  const out = [];
  let reached = 0;
  for (let i = 0; i < expected + 3; i++) {
    await page.keyboard.press("Tab");
    const f = await page.evaluate(() => { const el = document.activeElement; if (!el || el === document.body) return null; const s = getComputedStyle(el); return { tag: el.tagName, id: el.getAttribute("data-testid") ?? el.textContent?.trim().slice(0, 30) ?? "", ring: (s.outlineStyle !== "none" && parseFloat(s.outlineWidth) > 0) || s.boxShadow !== "none" }; });
    if (!f) break;
    reached++;
    if (!f.ring) out.push(`keyboard: no visible focus on <${f.tag.toLowerCase()}> ${f.id}`);
    if (reached >= expected) break;
  }
  await page.evaluate(() => document.getElementById("a11y-top")?.remove());
  if (reached < expected) out.push(`keyboard: Tab reached ${reached} of ${expected} controls`);
  return out.map((p) => `${name} — ${p}`);
}

async function check(name, { width = 1280 } = {}) {
  await page.setViewportSize({ width, height: 900 });
  await page.waitForTimeout(350);
  const found = (await page.evaluate(audit)).map((p) => `${name}${width !== 1280 ? ` @${width}px` : ""} — ${p}`);
  problems.push(...found);
  if (width === 1280) problems.push(...(await keyboard(name)));
}
const visit = async (name, path, ready) => {
  await page.goto(path);
  await page.waitForSelector(ready);
  await check(name);
  await check(name, { width: 320 });
  passed++;
  console.log(`  checked ${name}`);
};

/* THE CHECKER IS CHECKED FIRST: a page with one planted fault per rule must be reported for each, or "0 problems" means nothing */
{
  await page.setContent(`<html><head></head><body style="margin:0;background:#fff"><h1>One</h1><h1>Two</h1><h3>Skipped</h3>
    <p style="color:#aaa">Pale grey text on white</p><input type="text"><button style="width:16px;height:16px;padding:0;border:0"></button>
    <div role="img" style="width:10px;height:10px"></div><a href="#" tabindex="3">link</a><table><tr><td>cell</td></tr></table>
    <div style="width:2000px;height:1px"></div></body></html>`);
  const found = (await page.evaluate(audit)).join("\n");
  for (const want of [/no lang/, /no <title>/, /2 h1 elements/, /no <main>/, /a level is skipped/, /a field has no label/, /a control has no name/, /a picture has no description/, /a positive tabindex/, /no header cells/, /contrast: <p.*needs 4\.5:1/, /smaller than 24 × 24/, /scrolls sideways/]) {
    assert.match(found, want, `the checker missed a planted fault: ${want}`);
  }
  console.log("  the checker reports all 13 planted faults");
}

console.log("\nsigned out");
await visit("sign in", "/portal/login", '[data-testid="pt-login"]');
await visit("forgotten password", "/portal/reset", "h1");
await visit("invitation", `/portal/invitation#token=${INVITE}`, '[data-testid="pt-rid"]');

console.log("\nsigned in");
await page.goto("/portal/login");
await page.fill('[data-testid="pt-login"]', "RSP-SANDB0X1"); await page.fill('[data-testid="pt-password"]', PASSWORD); await page.click('[data-testid="pt-signin"]');
await page.waitForURL(/\/portal$/);
await visit("dashboard", "/portal", '[data-testid="pt-card-completed"]');
await visit("results", "/portal/assessments/e-index", '[data-testid="pt-messages"]');
await page.click('[data-testid="pt-explain"]'); await page.waitForSelector('[data-testid="pt-summary"]');
/* the button that was pressed is gone: the focus must go to what replaced it, not be lost */
if (!(await page.evaluate(() => document.activeElement?.getAttribute("data-testid") === "pt-summary"))) problems.push("results — focus: after asking for the paragraph, the focus is not on it");
await check("results, with the paragraph");
await visit("answers, with an editor open", "/portal/assessments/e-done", '[data-testid="pt-answers"]');
await page.click('[data-testid^="pt-change-"]'); await page.waitForSelector('[data-testid="pt-editor"]');
if (!(await page.evaluate(() => !!document.activeElement?.closest('[data-testid="pt-editor"]')))) problems.push("answer editor — focus: after pressing Change, the focus is not inside the editor");
await check("answer editor");
await page.locator('[data-testid="pt-editor"] input, [data-testid="pt-editor"] textarea').first().focus();
await page.keyboard.press("Escape");
if (await page.locator('[data-testid="pt-editor"]').count()) problems.push("answer editor — keyboard: Escape does not close the editor");
else if (!(await page.evaluate(() => /^pt-change-/.test(document.activeElement?.getAttribute("data-testid") ?? "")))) problems.push("answer editor — focus: after closing, the focus does not return to the Change button");
await visit("progress", "/portal/progress", '[data-testid="pt-track"]');
await visit("profile, security and privacy", "/portal/account", '[data-testid="pt-requests"]');

await browser.close();
if (problems.length) { console.log(`\n${problems.length} problem(s):`); for (const p of [...new Set(problems)]) console.log(`  ${p}`); }
assert.equal(problems.length, 0, `${problems.length} accessibility problem(s)`);
console.log(`\n${passed} pages checked, 0 problems`);

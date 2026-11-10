/**
 * DEVELOPER DOCS (2026-11-09) — browser suite. Studio on :3000 with AI_API_URL=fake: (the sandbox).
 *
 *   1  public, no session: the home (three views, categories A–G, reference), the navigation; llms.txt is gone
 *   2  search: words → ranked pages → Enter opens the page
 *   3  a guide page: breadcrumb, steps, the live example's three views (real builder screenshots load, the engine's
 *      expression with Copy, the stored JSON), Related, Previous / Next
 *   4  the respondent views behave like the survey: display logic on the same page, skip logic, piping, a loop, a
 *      screen-out, a redirect with embedded data, Back and Restart
 *   5  every A and B guide renders its example with no page error and its screenshots load
 *   6  Help → Help | Developer Docs, from the platform header and from the Studio
 *   7  phone width: no horizontal scroll, the example stacks
 */
import assert from "node:assert/strict";
import { chromium } from "./lib/playwright.mjs";

const STUDIO = process.env.STUDIO_URL ?? "http://localhost:3000";
let passed = 0;
const ok = (m) => { passed++; console.log(`  ok   ${m}`); };
const browser = await chromium.launch();
const errors = [];
const ctx = await browser.newContext({ viewport: { width: 1500, height: 1000 }, permissions: ["clipboard-read", "clipboard-write"] });
const p = await ctx.newPage();
p.on("pageerror", (e) => errors.push(`${p.url()}: ${e}`));
for (let i = 0; i < 20; i++) { try { const r = await fetch(`${STUDIO}/docs`); if (r.status < 500) break; } catch { /* starting */ } await new Promise((r) => setTimeout(r, 2000)); }
const go = async (path) => { const r = await p.goto(`${STUDIO}${path}`, { waitUntil: "load" }); await p.waitForSelector('[data-testid="docs"]'); return r; };
const live = (ex) => `[data-testid="docs-example"][data-example="${ex}"] [data-testid="docs-ex-respondent"]`;
const imagesLoaded = (sel) => p.$$eval(`${sel} img`, (imgs) => imgs.map((i) => i.complete && i.naturalWidth > 100));

console.log("\n1 — public home, navigation, llms.txt gone");
const home = await go("/docs");
assert.equal(home.status(), 200);
assert.ok(!p.url().includes("/login"));
assert.equal(await p.textContent('[data-testid="docs-home"] h1'), "ResLens.ai Developer Docs");
assert.equal((await p.$$('[data-testid="docs-three"] > div')).length, 3);
for (const k of ["fundamentals", "advanced", "intelligent", "actions", "designs", "branding", "platform", "reference"]) assert.ok(await p.$(`[data-testid="docs-home-cat-${k}"]`), k);
const navCats = await p.$$eval('[data-testid="docs-nav"] details', (d) => d.map((x) => x.getAttribute("data-testid")));
assert.equal(navCats.length, 9, navCats.join(","));
assert.ok(!(await p.content()).includes("llms.txt"), "no llms.txt link");
/* gone: nothing serves them — /docs/logic.md is a 404 inside the public docs; the old /llms*.txt addresses are not public any more, so they fall to the sign-in like any unknown page */
assert.equal((await fetch(`${STUDIO}/docs/logic.md`, { redirect: "manual" })).status, 404);
for (const u of ["/llms.txt", "/llms-full.txt"]) { const r = await fetch(`${STUDIO}${u}`, { redirect: "manual" }); assert.ok(r.status === 404 || (r.status === 307 && /\/login/.test(r.headers.get("location") ?? "")), `${u} ${r.status}`); }
const idx = await (await fetch(`${STUDIO}/docs/search-index.json`)).json();
assert.ok(idx.pages.length >= 50, `${idx.pages.length} pages indexed`);
ok(`/docs is public: three views, 8 category cards, ${navCats.length} navigation groups, ${idx.pages.length} pages indexed; /llms.txt and /llms-full.txt no longer served, .md is 404`);

console.log("\n2 — search");
await p.click('[data-testid="docs-search-input"]');
await p.keyboard.type("skip logic");
await p.waitForSelector('[data-testid="docs-search-hit"]');
const hits = await p.$$eval('[data-testid="docs-search-hit"] .docs-search-title', (h) => h.map((x) => x.textContent));
assert.match(hits[0], /^Skip logic/, hits.join(" | "));
await p.keyboard.press("Enter");
await p.waitForURL(/\/docs\/skip-logic$/);
/* the new page's shortcut listener is attached once it hydrates: press until it is (at most a few seconds) */
let focused = null;
for (let k = 0; k < 10 && focused !== "docs-search-input"; k++) {
  await p.evaluate(() => (document.activeElement)?.blur?.());
  await p.keyboard.press("/");
  focused = await p.evaluate(() => document.activeElement?.getAttribute("data-testid"));
  if (focused !== "docs-search-input") await p.waitForTimeout(400);
}
assert.equal(focused, "docs-search-input", "/ focuses search");
ok(`“skip logic” → ${hits.slice(0, 3).join(", ")}; Enter opens it; “/” focuses the box`);

console.log("\n3 — a guide page and its three views");
await go("/docs/display-logic");
assert.match(await p.textContent('[data-testid="docs-crumbs"]'), /B · Advanced programming.*Logic and flow/);
assert.ok((await p.$$('[data-testid="docs-steps"] li')).length >= 3);
const shots = await imagesLoaded('[data-testid="docs-ex-builder"]');
assert.ok(shots.length === 2 && shots.every(Boolean), `builder screenshots ${JSON.stringify(shots)}`);
assert.match(await p.textContent('[data-testid="docs-ex-expression"] .docs-ex-logic'), /Display Q2 if\s*Q1 = 1/);
await p.click('[data-testid="docs-ex-expression"] [data-testid="docs-copy"]');
assert.equal(await p.evaluate(() => navigator.clipboard.readText()), "Q1 = 1");
await p.click('[data-testid="docs-ex-json-toggle"]');
const json = JSON.parse(await p.textContent('[data-testid="docs-ex-expression"] pre'));
assert.equal(json.questions[1].displayLogic.operator, "eq");
await p.click('[data-testid="docs-ex-builder"] .docs-ex-shot');
await p.waitForSelector('[data-testid="docs-zoom"]'); await p.click('[data-testid="docs-zoom"]');
assert.ok((await p.$$('[data-testid="docs-related"] a')).length >= 3);
assert.match(await p.textContent('[data-testid="docs-prev"]'), /Loops/);
assert.match(await p.textContent('[data-testid="docs-next"]'), /Skip logic/);
assert.ok((await p.$$('.docs-article pre .tk-k, .docs-article pre .tk-n')).length > 0, "code is highlighted");
ok("breadcrumb, steps, two real screenshots (zoomable), the engine's “Q1 = 1” copied, stored JSON, Related, Previous: Loops / Next: Skip logic");

console.log("\n4 — the respondent views behave like the survey");
const R = live("display-logic");
assert.equal(await p.$$eval(`${R} .rs-question, ${R} [data-qid]`, (q) => q.length) > 0, true);
const countQs = () => p.$$eval(`${R} #rs-questions > *`, (q) => q.length);
const before = await countQs();
await p.click(`${R} label:has-text("Yes")`);
await p.waitForFunction((s) => document.querySelectorAll(`${s} #rs-questions > *`).length > 1, R);
assert.match(await p.textContent(R), /What fuel does your car use\?/);
await p.click(`${R} label:has-text("No")`);
await p.waitForFunction((s) => !document.querySelector(s).textContent.includes("What fuel"), R);
assert.equal(await countQs(), before);
ok("display logic: Yes shows Q2 on the same page, No removes it");

await go("/docs/skip-logic");
const S = live("skip-logic");
await p.click(`${S} label:has-text("No")`); await p.click(`${S} [data-testid="docs-live-next"]`);
await p.waitForFunction((s) => document.querySelector(s).textContent.includes("anything else"), S);
assert.ok(!(await p.textContent(S)).includes("How satisfied are you with the app"));
await p.click(`${S} [data-testid="docs-live-back"]`);
await p.waitForFunction((s) => document.querySelector(s).textContent.includes("used our app"), S);
await p.click(`${S} [data-testid="docs-live-restart"]`);
await p.click(`${S} label:has-text("Yes")`); await p.click(`${S} [data-testid="docs-live-next"]`);
await p.waitForFunction((s) => document.querySelector(s).textContent.includes("How satisfied are you with the app"), S);
ok("skip logic: No jumps to Q3, Back returns, Restart + Yes shows Q2");

await go("/docs/piping");
const P = live("piping");
await p.click(`${P} label:has-text("Samsung")`);
await p.click(`${P} [data-testid="docs-live-next"]`);
await p.waitForFunction((s) => document.querySelector(s).textContent.includes("your Samsung phone"), P);
assert.match(await p.textContent(`${P} [data-testid="docs-live-data"]`), /BRAND = 2/);
ok("piping: Samsung → “How satisfied are you with your Samsung phone?”; stored BRAND = 2");

await go("/docs/loops");
const L = live("loops");
await p.click(`${L} label:has-text("Apple")`); await p.click(`${L} label:has-text("Google")`);
await p.click(`${L} [data-testid="docs-live-next"]`);
await p.waitForFunction((s) => document.querySelector(s).textContent.includes("satisfied are you with Apple"), L);
await p.click(`${L} label:has-text("Very satisfied") >> nth=-1`).catch(async () => { await p.click(`${L} input[type=radio] >> nth=4`); });
await p.click(`${L} [data-testid="docs-live-next"]`);
await p.waitForFunction((s) => document.querySelector(s).textContent.includes("satisfied are you with Google"), L);
ok("loop: two brands selected → Q2 asked for Apple, then for Google");

await go("/docs/survey-termination");
const T = live("survey-termination");
await p.fill(`${T} input`, "16"); await p.click(`${T} [data-testid="docs-live-next"]`);
await p.waitForSelector(`${T} [data-testid="docs-live-end"][data-status="screened"]`);
ok("terminate: age 16 → end of survey, status screened");

await go("/docs/redirects");
const D = live("redirects");
await p.click(`${D} label:has-text("Yes")`); await p.click(`${D} [data-testid="docs-live-next"]`);
await p.waitForSelector(`${D} [data-testid="docs-live-redirect"]`);
assert.equal(await p.textContent(`${D} [data-testid="docs-live-redirect"]`), "https://panel.example.com/complete?pid=A123&status=1");
ok("redirect: the URL with PID=A123 from the link piped in");

await go("/docs/question-validation");
const V = live("question-validation");
await p.click(`${V} label:has-text("Battery")`); await p.click(`${V} [data-testid="docs-live-next"]`);
await p.waitForFunction((s) => /at least 2|Please pick/i.test(document.querySelector(s).textContent), V);
ok("validation: one of two features → the minimum-selections message, the page stays");

console.log("\n5 — every A and B guide");
const guides = idx.pages.filter((x) => /Survey programming fundamentals|Advanced programming/.test(x.category)).map((x) => x.slug);
assert.ok(guides.length >= 36);
for (const slug of guides) {
  await go(`/docs/${slug}`);
  await p.waitForSelector('[data-testid="docs-example"] [data-testid="docs-live"], [data-testid="docs-example"] [data-testid="docs-live-end"]', { timeout: 10000 });
  const imgs = await imagesLoaded('[data-testid="docs-ex-builder"]');
  assert.ok(imgs.length >= 1 && imgs.every(Boolean), `${slug}: screenshots ${JSON.stringify(imgs)}`);
}
ok(`${guides.length} guides: each draws its live survey and its builder screenshots`);

console.log("\n5b — phase 2: Intelligent Mode, actions and integrations, design generators");
await go("/docs/intelligent-mode-guide");
const said = await p.$$eval('[data-testid="docs-example"] [data-testid="docs-say"] > li', (l) => l.map((x) => x.getAttribute("data-kind")));
assert.deepEqual(said, ["actions", "actions", "actions"]);
assert.ok((await p.$$('.docs-flow .docs-flow-step')).length >= 4, "the flow draws its steps");
await p.click('[data-testid="docs-say-actions"] >> nth=0');
assert.ok(JSON.parse(await p.textContent('[data-testid="docs-say"] pre')).length >= 1, "the actions behind a sentence are real JSON");
ok("Intelligent Mode: three sentences read by the engine (all proposed), their actions, and the flow");

await go("/docs/intelligent-validation");
const kinds = await p.$$eval('[data-testid="docs-say"] > li', (l) => l.map((x) => x.getAttribute("data-kind")));
assert.ok(kinds.length >= 3 && kinds.every((k) => k === "refused"), JSON.stringify(kinds));
ok(`Intelligent validation: ${kinds.length} sentences refused with their reasons`);

await go("/docs/maxdiff");
await p.waitForSelector('[data-testid="docs-ex-design"]');
const outRows = await p.$$eval('[data-testid="docs-ex-results"] table tbody tr', (r) => r.length);
assert.equal(outRows, 10, `MaxDiff output rows ${outRows}`);
const M = live("maxdiff");
await p.waitForSelector(`${M} .rs-md`);
await p.click(`${M} .rs-md tbody tr:nth-child(1) .rs-md-pick >> nth=0`);
await p.click(`${M} .rs-md tbody tr:nth-child(2) .rs-md-pick >> nth=1`);
await p.click(`${M} [data-testid="docs-live-next"]`);
await p.waitForFunction((s) => /Task 2 of/.test(document.querySelector(s).textContent), M);
const wrapOk = await p.$$eval(`${M} .rs-md td.rowlabel`, (c) => c.every((x) => x.getBoundingClientRect().width >= 60));
assert.ok(wrapOk, "MaxDiff item labels keep whole words in the narrow pane");
ok("MaxDiff: the design preview, the 10-item output, and the respondent answers task 1 and reaches task 2");

await go("/docs/study-methodologies");
const stated = Number((await p.textContent(".docs-catalog")).match(/(\d+) study methodologies/)[1]);
const rows = await p.$$eval(".docs-catalog tbody tr", (r) => r.length);
assert.ok(stated >= 10 && rows === stated, `catalog ${rows} rows, states ${stated}`);
ok(`methodology catalogue: all ${rows} methodologies from the registry`);

await go("/docs/behaviours");
const B = live("behaviours");
await p.click(`${B} label:has-text("Other (please specify)")`);
await p.waitForFunction((s) => /please tell us where/.test(document.querySelector(s).textContent), B);
ok("behaviour: picking Other shows the message");

await go("/docs/auto-punch");
const AP = live("auto-punch");
await p.fill(`${AP} input`, "25"); await p.click(`${AP} [data-testid="docs-live-next"]`);
await p.waitForFunction((s) => /SEG\s*=\s*1/.test(document.querySelector(s).textContent), AP);
assert.match(await p.textContent('[data-testid="docs-ex-expression"]'), /IF Q1 < 35 THEN SELECT SEG\.1/);
ok("auto-punch: age 25 → SEG = 1, and the rule shows in the Programming view");

await go("/docs/panel-integrations");
const PN = live("panel-integration");
await p.fill(`${PN} input`, "30"); await p.click(`${PN} [data-testid="docs-live-next"]`);
await p.click(`${PN} label:has-text("Daily")`); await p.click(`${PN} [data-testid="docs-live-next"]`);
await p.waitForSelector(`${PN} [data-testid="docs-live-redirect"]`);
const back = await p.textContent(`${PN} [data-testid="docs-live-redirect"]`);
assert.match(back, /C1A2B3/);
ok(`panel: completing sends the respondent back with the completion code (${back})`);

const guides2 = idx.pages.filter((x) => /Intelligent Mode|Actions and integrations|Research design generators/.test(x.category)).map((x) => x.slug);
assert.ok(guides2.length >= 24, `C–E pages ${guides2.length}`);
let withEx = 0;
for (const slug of guides2) {
  await go(`/docs/${slug}`);
  if (!(await p.$('[data-testid="docs-example"]'))) continue;
  withEx++;
  await p.waitForSelector('[data-testid="docs-example"] [data-testid="docs-live"], [data-testid="docs-example"] [data-testid="docs-live-end"]', { timeout: 10000 });
  const imgs = await imagesLoaded('[data-testid="docs-ex-builder"]');
  assert.ok(imgs.length >= 1 && imgs.every(Boolean), `${slug}: screenshots ${JSON.stringify(imgs)}`);
}
ok(`${guides2.length} C–E pages load; the ${withEx} with examples draw their live survey and screenshots`);

console.log("\n5c — phase 3: branding and platform");
await go("/docs/branding-overview");
const PR = live("theme-preset");
assert.equal((await p.textContent(`${PR} [data-testid="docs-live-next"]`)).trim().replace(/\s*→$/, ""), "Continue");
assert.ok(await p.$(`${PR} .rs-shell[class*="peach"]`), "the peach motif is on the shell");
ok("preset: Premium Peach draws its motif and its own button label");

await go("/docs/buttons-and-navigation");
const BT = live("theme-buttons");
assert.equal((await p.textContent(`${BT} [data-testid="docs-live-back"]`)).trim(), "Previous");
await p.click(`${BT} label:has-text("Ready to buy")`); await p.click(`${BT} [data-testid="docs-live-next"]`);
await p.click(`${BT} label:has-text("Design")`); await p.click(`${BT} [data-testid="docs-live-next"]`);
await p.waitForFunction((s) => document.querySelector(`${s} [data-testid="docs-live-next"]`)?.textContent.includes("Send my answers"), BT);
ok("buttons: “Previous” / “Continue”, and “Send my answers” on the last page");

await go("/docs/respondent-experience");
const XP = live("theme-experience");
assert.match(await p.textContent(`${XP} #rs-questions`), /1\.\s*Which of these/);
assert.match(await p.textContent(`${XP} #rs-questions`), /A\.?\s*Just browsing/);
await p.click(`${XP} label:has-text("Ready to buy")`);
await p.waitForFunction((s) => /What do you enjoy/.test(document.querySelector(s).textContent), XP, { timeout: 5000 });
ok("experience: question numbered 1., answers lettered, and choosing an answer moves on by itself");

await go("/docs/page-layout-and-logo");
const PL = live("theme-page-logo");
await p.waitForFunction((s) => { const i = document.querySelector(`${s} [data-testid="docs-live-header"] img`); return i && i.complete && i.naturalWidth > 50; }, PL);
assert.match(await p.textContent(`${PL} [data-testid="docs-live-progress"]`), /1\D+3/);
ok("page & logo: the logo loads above the survey; step progress shows page 1 of 3");

await go("/docs/header-and-footer");
const HF = live("theme-header-footer");
assert.match(await p.textContent(`${HF} [data-testid="docs-live-header"]`), /Lumen Research/);
assert.equal(await p.getAttribute(`${HF} [data-testid="docs-live-footer"] a`, "href"), "https://example.com/privacy");
ok("header and footer HTML on the page");

await go("/docs/phone-and-tablet");
const DV = live("theme-devices");
const fs = await p.$eval(`${DV} [data-testid="docs-live-viewport"] .rs-shell`, (e) => parseFloat(getComputedStyle(e).fontSize));
assert.equal(fs, 18, `phone base size ${fs}`);
ok("phone sizes: the phone view draws 18px text");

await go("/docs/translation");
const TR = live("translation");
await p.selectOption(`${TR} [data-testid="docs-live-lang"]`, "fr");
await p.waitForFunction((s) => /Laquelle de ces propositions/.test(document.querySelector(s).textContent), TR);
await p.click(`${TR} label:has-text("Prêt(e) à acheter")`);
await p.waitForFunction((s) => /STAGE\s*=\s*2/.test(document.querySelector(s).textContent), TR);
ok("translation: French texts over the same codes — “Prêt(e) à acheter” stores STAGE = 2");

await go("/docs/projects-and-roles");
const roleRows = await p.$$eval('[data-testid="docs-roles"] tbody tr', (r) => r.length);
assert.ok(roleRows >= 12, `roles ${roleRows}`);
const deployCol = async (r) => p.$eval(`[data-testid="docs-role-${r}"] td:nth-child(6)`, (e) => e.textContent.trim());
assert.equal(await deployCol("editor"), "✓"); assert.equal(await deployCol("programmer"), "—");
ok(`roles: ${roleRows} roles from the access rules (editor deploys, programmer does not)`);

const guides3 = idx.pages.filter((x) => /Branding and survey customization|Project management and platform/.test(x.category)).map((x) => x.slug);
assert.ok(guides3.length >= 17, `F–G pages ${guides3.length}`);
let ex3 = 0, sc3 = 0;
for (const slug of guides3) {
  await go(`/docs/${slug}`);
  if (await p.$('[data-testid="docs-example"]')) {
    ex3++;
    await p.waitForSelector('[data-testid="docs-example"] [data-testid="docs-live"], [data-testid="docs-example"] [data-testid="docs-live-end"]', { timeout: 10000 });
    const imgs = await imagesLoaded('[data-testid="docs-ex-builder"]');
    assert.ok(imgs.length >= 1 && imgs.every(Boolean), `${slug}: screenshots ${JSON.stringify(imgs)}`);
  }
  for (const s of await p.$$('[data-testid="docs-screen"]')) {
    sc3++;
    await s.scrollIntoViewIfNeeded();
    await p.waitForFunction((el) => { const i = el.querySelector("img"); return i && i.complete && i.naturalWidth > 100; }, s, { timeout: 10000 });
  }
}
ok(`${guides3.length} F–G pages load; ${ex3} live examples with screenshots, ${sc3} Studio screens`);

console.log("\n6 — Help → Help | Developer Docs");
await p.goto(`${STUDIO}/sandbox?mode=studio`, { waitUntil: "load" });
await p.waitForSelector('[data-testid="studio-help-button"]', { timeout: 60000 });
await p.click('[data-testid="studio-help-button"]');
assert.equal(await p.getAttribute('[data-testid="studio-help-docs"]', "href"), "/docs");
assert.equal(await p.getAttribute('[data-testid="studio-help-docs"]', "target"), "_blank");
await p.click('[data-testid="studio-help-help"]');
await p.waitForSelector('[data-testid="studio-help-drawer"]');
const plat = await (await fetch(`${STUDIO}/help`, { redirect: "manual" })).status;
ok(`Studio: Help opens a menu — Help opens the drawer, Developer Docs opens /docs in a new tab (platform /help → ${plat})`);

console.log("\n7 — phone width");
const m = await browser.newPage({ viewport: { width: 390, height: 844 } });
m.on("pageerror", (e) => errors.push(`mobile: ${e}`));
await m.goto(`${STUDIO}/docs/carry-forward`, { waitUntil: "load" });
await m.waitForSelector('[data-testid="docs-live"]');
const over = await m.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
assert.ok(over <= 1, `horizontal overflow ${over}px`);
const stacked = await m.$eval('[data-testid="docs-ex-respondent"]', (e) => e.getBoundingClientRect().width > 300);
assert.ok(stacked);
ok(`390 px: no horizontal scroll (${over}px), the example stacks to full width`);

assert.deepEqual(errors, []);
ok("no page errors");
console.log(`\n${passed} passed`);
await browser.close();

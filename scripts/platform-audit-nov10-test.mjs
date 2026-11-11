/**
 * PLATFORM AUDIT 2026-11-10 — browser suite. Studio on :3000 with AI_API_URL=fake: (the sandbox).
 *
 *   1  topbar menus (Alerts; the wallet panel's class) paint ABOVE the Studio's menubar, at desktop and phone width,
 *      and stay inside the window
 *   2  Study design: the library on the left in five families, the chosen method's details on the right — changing
 *      at once, without the page scrolling; a nine-part guide for every method; planning cautions; workflow buttons
 *   3  Survey Settings → Quality checks in named, collapsible groups
 *   4  no page errors
 */
import assert from "node:assert/strict";
import { chromium } from "./lib/playwright.mjs";
import { openTab } from "./lib/nav.mjs";

const STUDIO = process.env.STUDIO_URL ?? "http://localhost:3000";
let passed = 0;
const ok = (m) => { passed++; console.log(`  ok   ${m}`); };
const browser = await chromium.launch();
const errors = [];
const p = await (await browser.newContext({ viewport: { width: 1500, height: 1000 } })).newPage();
p.on("pageerror", (e) => errors.push(String(e)));
p.on("dialog", (d) => d.accept());
for (let i = 0; i < 20; i++) { try { const r = await fetch(`${STUDIO}/sandbox?mode=studio`); if (r.status < 500) break; } catch { /* starting */ } await new Promise((r) => setTimeout(r, 2000)); }
/* the sandbox has no signed-in user, so its inbox answers 401 and the bell hides: give the REAL bell a realistic inbox */
const ALERTS = [
  { id: "a1", title: "Quota “Women 25–34” is 92% full", text: "Fieldwork for Brand Tracker Wave 7 will close this cell at the current pace in about three hours. Review the quota plan if you need more completes.", severity: "warning", read: false, createdAt: "2026-11-10T08:15:00.000Z", link: "#" },
  { id: "a2", title: "Wallet balance is low", text: "US$ 12.40 remains. AI features pause at zero.", severity: "critical", read: false, createdAt: "2026-11-10T07:02:00.000Z", link: "#" },
  ...Array.from({ length: 14 }, (_, i) => ({ id: `b${i}`, title: `Export ready: responses_${i + 1}.xlsx`, text: "Your export finished and is ready to download.", severity: "info", read: true, createdAt: "2026-11-09T10:00:00.000Z", link: "#" })),
];
await p.route("**/api/notify/inbox", (r) => r.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ ok: true, alerts: ALERTS, unread: 2 }) }));
await p.goto(`${STUDIO}/sandbox?mode=studio`, { waitUntil: "load" });
await p.waitForSelector(".block-badge", { timeout: 60000 });

/** is the element the top-most thing at several points across its box? (a panel painted under another layer is not) */
const onTop = (sel) => p.evaluate((s) => {
  const el = document.querySelector(s); if (!el) return { found: false };
  const r = el.getBoundingClientRect();
  const pts = [[0.5, 0.08], [0.5, 0.5], [0.15, 0.3], [0.85, 0.7], [0.5, 0.92]].map(([fx, fy]) => [r.left + r.width * fx, r.top + r.height * fy]);
  /* and three points in the menubar's own row — the strip that used to be painted over */
  const mb = document.querySelector(".menubar")?.getBoundingClientRect();
  if (mb && r.top < mb.bottom && r.bottom > mb.top) for (const fx of [0.2, 0.5, 0.8]) pts.push([r.left + r.width * fx, (Math.max(mb.top, r.top) + Math.min(mb.bottom, r.bottom)) / 2]);
  const covered = pts.filter(([x, y]) => { const top = document.elementFromPoint(x, y); return !(top && (top === el || el.contains(top))); }).map(([x, y]) => { const t = document.elementFromPoint(x, y); return `${Math.round(x)},${Math.round(y)} → ${t?.tagName}.${String(t?.className).slice(0, 40)}`; });
  return { found: true, covered, box: { left: r.left, right: r.right, top: r.top, bottom: r.bottom }, vw: innerWidth, vh: innerHeight };
}, sel);

console.log("\n1 — topbar menus paint above the menubar and stay inside the window");
{
  const menubar = await p.evaluate(() => document.querySelector(".menubar").getBoundingClientRect().toJSON());
  await p.waitForSelector('[data-testid="bell-button"]');
  await p.click('[data-testid="bell-button"]');
  await p.waitForSelector('[data-testid="bell-item"]');
  assert.equal(await p.$$eval('[data-testid="bell-item"]', (n) => n.length), 16);
  const bell = await onTop('[data-testid="bell-list"]');
  assert.ok(bell.box.top < menubar.bottom && bell.box.bottom > menubar.top, "the alerts panel does overlap the menubar's row — the case that used to be painted over");
  assert.deepEqual(bell.covered, [], "nothing is painted over the alerts panel");
  assert.ok(bell.box.right <= bell.vw && bell.box.left >= 0);
  /* the check is not vacuous: with the topbar back under the menubar (z-index 20, as it was) the panel is painted over */
  await p.addStyleTag({ content: ".topbar{z-index:20 !important}" }).then(async (tag) => {
    const before = await onTop('[data-testid="bell-list"]');
    assert.ok(before.covered.length > 0, "with the old stacking the menubar covers the panel");
    await tag.evaluate((n) => n.remove());
  });
  assert.deepEqual((await onTop('[data-testid="bell-list"]')).covered, []);
  ok("Alerts opens over the menubar, fully visible");
  /* at phone width it becomes a sheet under the topbar, inside the window, scrolling in itself */
  await p.setViewportSize({ width: 390, height: 740 });
  await p.waitForTimeout(200);
  const small = await onTop('[data-testid="bell-list"]');
  assert.ok(small.box.left >= 0 && small.box.right <= small.vw + 0.5 && small.box.bottom <= small.vh + 0.5, `the alerts panel stays inside a 390px window: ${JSON.stringify(small.box)}`);
  assert.ok(await p.$eval('[data-testid="bell-list"]', (e) => e.scrollHeight > e.clientHeight), "16 alerts scroll inside the panel instead of running off the screen");
  await p.setViewportSize({ width: 1500, height: 1000 });
  await p.keyboard.press("Escape");
  await p.waitForSelector('[data-testid="bell-list"]', { state: "detached" });
  /* the wallet panel is the same construction (.menu-anchor > .menu.wallet-menu-panel in the topbar); the sandbox has
     no wallet, so the panel's own classes are put where the wallet renders them and measured the same way */
  await p.evaluate(() => {
    const bellEl = document.querySelector('.topbar [data-testid="bell"]'), host = bellEl.parentElement;
    const a = document.createElement("div"); a.className = "menu-anchor wallet-menu"; a.id = "probe-wallet";
    a.innerHTML = `<button class="btn small">$ 1,250.00</button><div class="menu wallet-menu-panel" role="menu" id="probe-wallet-panel"><div class="wallet-menu-head"><div class="wallet-menu-balance">US$ 1,250,000.00 available balance across every project</div></div>${Array.from({ length: 6 }, (_, i) => `<a class="menu-item">Wallet row ${i + 1}</a>`).join("")}</div>`;
    host.insertBefore(a, bellEl); /* beside the bell, where the Studio renders the wallet */
  });
  const wallet = await onTop("#probe-wallet-panel");
  assert.ok(wallet.box.bottom > menubar.top, "the wallet panel reaches the menubar's row");
  assert.deepEqual(wallet.covered, [], "nothing is painted over the wallet panel");
  ok("the wallet panel's construction opens over the menubar, fully visible");
  await p.setViewportSize({ width: 390, height: 740 });
  await p.waitForTimeout(200);
  const w2 = await onTop("#probe-wallet-panel");
  assert.ok(w2.box.left >= 0 && w2.box.right <= w2.vw + 0.5 && w2.box.bottom <= w2.vh + 0.5, `the wallet panel stays inside a 390px window: ${JSON.stringify(w2.box)}`);
  ok("at 390px both panels fit the window");
  await p.setViewportSize({ width: 1500, height: 1000 });
  await p.evaluate(() => document.getElementById("probe-wallet")?.remove());
}

console.log("\n2 — Study design: list left, details right, a guide for every method");
{
  await openTab(p, "Study design");
  await p.waitForSelector('[data-testid="sd-cols"]');
  const box = (sel) => p.evaluate((s) => document.querySelector(s).getBoundingClientRect().toJSON(), sel);
  const list = await box(".sd-list"), detail = await box('[data-testid="sd-detail"]');
  assert.ok(detail.left >= list.right - 1, "the details are to the RIGHT of the list");
  assert.ok(Math.abs(detail.top - list.top) < 60, "and start level with it");
  assert.ok(detail.top < 600, "the details begin on the first screen");
  /* once the objective is scrolled away both columns pin under the header and fit the window: each scrolls on its own */
  await p.evaluate(() => { document.querySelector("main.center").scrollTop = 300; });
  await p.waitForTimeout(150);
  const pl = await box(".sd-list"), pd = await box('[data-testid="sd-detail"]');
  assert.ok(pd.top >= 96 && pd.bottom <= 1000 + 1, `the details panel fits the window when pinned (${Math.round(pd.top)}–${Math.round(pd.bottom)})`);
  assert.ok(pl.top >= 96, "the list is pinned beside it");
  assert.ok(await p.$eval(".sd-list", (e) => e.scrollHeight > e.clientHeight && e.getBoundingClientRect().bottom <= innerHeight + 1), "the list scrolls inside itself");
  const families = await p.$$eval('[data-testid="sd-method"] .ml-group-h', (h) => h.map((x) => x.textContent.trim()));
  assert.deepEqual(families, ["Market & consumer research", "Advanced quantitative research", "Academic & social science research", "Medical & healthcare research", "Qualitative research"]);
  const ids = await p.$$eval('[data-testid="sd-method"] .ml-item', (b) => b.map((x) => x.getAttribute("data-testid").replace("method-", "")));
  assert.ok(ids.length >= 85, `the library lists ${ids.length} methods`);
  ok(`five families, ${ids.length} methods, details beside the list`);

  /* every method: click → the right panel is that method at once, with all nine guide parts, and the page has not moved */
  const PARTS = ["what", "when", "solves", "data", "structure", "considerations", "analysis", "outputs", "example"];
  let cautions = 0, workflows = 0;
  const pageAt = await p.evaluate(() => document.querySelector("main.center").scrollTop);
  for (const id of ids) {
    await p.click(`[data-testid="sd-method"] [data-testid="method-${id}"]`);
    const seen = await p.evaluate(({ PARTS }) => {
      const d = document.querySelector('[data-testid="sd-detail"]');
      return { method: d.getAttribute("data-method"), scrollY: document.querySelector("main.center").scrollTop, detailTop: d.scrollTop, parts: PARTS.map((k) => (d.querySelector(`[data-part="${k}"]`)?.textContent ?? "").length), caution: !!d.querySelector('[data-testid="sd-caution"]'), workflow: !!d.querySelector('[data-testid="sd-workflow"]'), nameTop: d.querySelector('[data-testid="sd-chosen"]').getBoundingClientRect().top };
    }, { PARTS });
    assert.equal(seen.method, id, "the panel shows the method that was clicked");
    assert.equal(seen.scrollY, pageAt, `${id}: the page did not scroll`);
    assert.equal(seen.detailTop, 0, `${id}: the details open at their top`);
    assert.ok(seen.nameTop >= 0 && seen.nameTop < 1000, `${id}: its name is on screen`);
    assert.ok(seen.parts.every((n) => n > 30), `${id}: every guide part has content (${seen.parts.join(",")})`);
    if (seen.caution) cautions++;
    if (seen.workflow) workflows++;
  }
  assert.ok(cautions >= 11, `${cautions} methods carry the planning caution`);
  assert.ok(workflows >= 8, `${workflows} methods point to where their work continues`);
  ok(`all ${ids.length} methods answer the nine guide questions in place; ${cautions} cautions, ${workflows} workflow links`);

  await p.click('[data-testid="sd-method"] [data-testid="method-clinical_trial_design"]');
  assert.match(await p.textContent('[data-testid="sd-caution"]'), /not a regulated clinical-trial.*does not randomise treatment/s);
  await p.click('[data-testid="sd-method"] [data-testid="method-in_depth_interviews"]');
  assert.match(await p.textContent('[data-testid="sd-workflow"]'), /Research Tools → Qualitative/);
  ok("a clinical design says what the platform does not do; a qualitative method points to Qualitative");

  /* a new method builds through the real gate and can be added */
  await p.click('[data-testid="sd-method"] [data-testid="method-customer_journey"]');
  await p.fill('[data-testid="sd-in-product"]', "our mobile banking app");
  await p.click('[data-testid="sd-preview"]');
  await p.waitForSelector('[data-testid="sd-result"]', { timeout: 30000 });
  assert.equal(await p.getAttribute('[data-testid="sd-result"]', "data-ok"), "1", await p.textContent('[data-testid="sd-result"]'));
  assert.match(await p.textContent('[data-testid="sd-result"]'), /Ready to add: 6 questions/);
  await p.click('[data-testid="sd-add"]');
  await p.waitForSelector('[data-testid="sd-added"]');
  ok("Customer journey research builds 6 questions, simulates and is added");

  /* search narrows the list; the panel stacks on a narrow window */
  await p.fill('[data-testid="sd-method"] .ml-search', "cohort");
  assert.deepEqual(await p.$$eval('[data-testid="sd-method"] .ml-name', (n) => n.map((x) => x.textContent)), ["Cohort study"]);
  await p.fill('[data-testid="sd-method"] .ml-search', "");
  await p.setViewportSize({ width: 700, height: 900 });
  await p.waitForTimeout(200);
  const l2 = await box(".sd-list"), d2 = await box('[data-testid="sd-detail"]');
  assert.ok(d2.top >= l2.bottom - 1, "on a narrow window the details follow the list");
  const over = await p.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  assert.ok(over <= 1, `no sideways scroll at 700px (${over}px)`);
  await p.setViewportSize({ width: 1500, height: 1000 });
  ok("search finds a method; the layout stacks without sideways scroll at 700px");
}

console.log("\n2b — a study from a description: what was read, what is asked, how it is designed");
{
  await p.fill('[data-testid="sd-objective"]', "I need a conjoint study to find the best price and features for our new fitness app");
  await p.click('[data-testid="sd-recommend"]');
  await p.waitForSelector('[data-testid="sd-brief"]');
  assert.equal(await p.getAttribute('[data-testid="sd-brief"]', "data-ready"), "0");
  assert.match(await p.textContent('[data-testid="sd-questions"]'), /What are the attributes and their levels\?/);
  assert.equal(await p.inputValue('[data-testid="sd-in-attributes"]'), "", "no attributes were invented");
  assert.equal(await p.isDisabled('[data-testid="sd-preview"]'), true, "it cannot be built until they are given");
  ok("a conjoint without levels is asked for its levels — nothing is filled in for the researcher");
  await p.fill('[data-testid="sd-objective"]', "We are launching a premium subscription and need to know how much customers would pay and which features justify the price. Conjoint, 400 respondents, about 10 minutes.\nPrice: $9, $14, $19\nStorage: 50 GB, 200 GB, 1 TB\nSupport: Email, 24/7 chat");
  await p.click('[data-testid="sd-recommend"]');
  await p.waitForSelector('[data-testid="sd-brief"][data-ready="1"]');
  assert.match(await p.textContent('[data-testid="sd-understood"]'), /Price \(\$9, \$14, \$19\); Storage \(50 GB, 200 GB, 1 TB\); Support \(Email, 24\/7 chat\)/);
  assert.equal(await p.inputValue('[data-testid="sd-in-attributes"]'), "Price: $9, $14, $19\nStorage: 50 GB, 200 GB, 1 TB\nSupport: Email, 24/7 chat");
  assert.equal(await p.inputValue('[data-testid="sd-sample"]'), "400");
  assert.match(await p.textContent('[data-testid="sd-explanation"]'), /Method: Choice-based conjoint.*Design:.*tasks.*It will build:.*choice exercise.*3 attributes.*Analysis:/s);
  await p.click('[data-testid="sd-preview"]');
  await p.waitForSelector('[data-testid="sd-result"]', { timeout: 30000 });
  assert.equal(await p.getAttribute('[data-testid="sd-result"]', "data-ok"), "1", await p.textContent('[data-testid="sd-result"]'));
  assert.match(await p.textContent('[data-testid="sd-result"]'), /1 generated design file/);
  ok("a complete brief fills the inputs, explains the design and builds through the real generator");
}

console.log("\n2c — Survey Settings in five sections");
{
  await openTab(p, "Survey Settings");
  await p.waitForSelector('main.center [data-testid="ss-nav"]');
  const secs = await p.$$eval('main.center [data-testid^="ss-head-"]', (b) => b.map((x) => ({ title: x.querySelector("strong").textContent, desc: x.querySelector(".ss-desc").textContent.length, open: x.getAttribute("aria-expanded") })));
  assert.deepEqual(secs.map((x) => x.title), ["Survey and link", "Who can take this survey", "Response quality", "Assessment and rewards", "Research design"]);
  assert.ok(secs.every((x) => x.desc > 40 && x.open === "true"));
  await p.click('main.center [data-testid="ss-head-identity"]');
  assert.equal(await p.isVisible('main.center [data-testid="custom-domain"]'), false, "a folded section hides its fields");
  await p.click('main.center [data-testid="ss-nav"] button:has-text("Survey and link")');
  await p.waitForSelector('main.center [data-testid="custom-domain"]', { state: "visible" });
  ok("five titled sections with descriptions; fold one away, jump back to it from the bar");
}

console.log("\n3 — Survey Settings: quality checks in named groups");
{
  await openTab(p, "Survey Settings");
  await p.waitForSelector('main.center [data-testid="quality-settings"]');
  if (!(await p.isChecked('main.center [data-testid="quality-enabled"]'))) await p.click('main.center [data-testid="quality-enabled"]');
  await p.waitForSelector('main.center [data-testid="qs-group-scoring"]');
  const groups = await p.$$eval('main.center [data-testid^="qs-group-head-"]', (b) => b.map((x) => ({ id: x.getAttribute("data-testid").replace("qs-group-head-", ""), title: x.querySelector("strong").textContent, desc: x.querySelector(".qs-group-desc").textContent.length, open: x.getAttribute("aria-expanded") })));
  assert.deepEqual(groups.map((g) => g.title), ["Scoring", "Built-in rules", "Custom rules", "Attention checks", "Telemetry & privacy", "Preview rule impact"]);
  assert.ok(groups.every((g) => g.desc > 40), "every group says what it is for");
  assert.deepEqual(groups.map((g) => g.open), ["true", "true", "false", "false", "false", "false"]);
  assert.equal(await p.isVisible('main.center [data-testid="qcustom-add"]'), false);
  await p.click('main.center [data-testid="qs-group-head-custom"]');
  await p.click('main.center [data-testid="qcustom-add"]');
  await p.waitForSelector('main.center [data-testid="qcustom-rule"]');
  assert.match(await p.textContent('main.center [data-testid="qs-group-head-custom"]'), /1 of 1 on/);
  await p.click('main.center [data-testid="qs-group-head-custom"]');
  assert.equal(await p.isVisible('main.center [data-testid="qcustom-rule"]'), false, "closing a group hides its controls");
  await p.click('main.center [data-testid="qs-group-head-custom"]');
  assert.equal(await p.isVisible('main.center [data-testid="qcustom-rule"]'), true, "and the rule is still there when it is reopened");
  ok("six groups with descriptions and state; a closed group keeps what was entered");
}

assert.deepEqual(errors, [], "no page errors");
ok("no page errors");
console.log(`\n${passed} passed`);
await browser.close();

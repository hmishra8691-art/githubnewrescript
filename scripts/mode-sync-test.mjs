/**
 * MODES OF ONE SURVEY — permissions, splits and synchronisation (round 2).
 *
 *   node scripts/mode-sync-test.mjs
 *
 * §1  Studio + Intelligent keeps the Properties panel; a logic edit made
 *     there is on both panes at once.
 * §4  Flow → click Q → the Studio pane lands on Q; double-click opens Studio.
 * §11 Required set in Studio is Required in Grid, in the Intelligent context
 *     and in Flow's read-only inspector, on the same render.
 * §13 Studio + Flow: Studio edits, Flow only shows.
 */
import assert from "node:assert/strict";
import { chromium } from "/home/claude/.npm-global/lib/node_modules/playwright/index.mjs";
import { openTab, switchMode, modeMenuClick } from "./lib/nav.mjs";
import { buildMasterDemoSurvey } from "../packages/templates/dist/index.js";

const STUDIO = process.env.STUDIO_URL ?? "http://localhost:3000";
let passed = 0;
const ok = (msg) => { passed++; console.log(`  ok   ${msg}`); };

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1700, height: 950 } });
const pageErrors = [];
page.on("pageerror", (e) => pageErrors.push(String(e)));
page.on("console", (m) => { if (m.type() === "error" && !/401|501|ERR_TUNNEL|Failed to load resource/.test(m.text())) pageErrors.push(m.text().slice(0, 300)); });

const loadDef = async (def) => {
  await openTab(page, "JSON");
  await page.waitForSelector("textarea.code");
  await page.click('button:has-text("edit")');
  await page.$eval("textarea.code", (el, v) => { Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value").set.call(el, v); el.dispatchEvent(new Event("input", { bubbles: true })); }, JSON.stringify(def));
  await page.click('button:has-text("validate & apply")');
  await page.waitForTimeout(800);
  await openTab(page, "Questions");
};
const readDef = async () => {
  await openTab(page, "JSON");
  await page.waitForSelector("textarea.code");
  const json = await page.$eval("textarea.code", (e) => e.value);
  await openTab(page, "Questions");
  return JSON.parse(json);
};
const demo = buildMasterDemoSurvey("sandbox");
const q = (code) => demo.questions.find((x) => x.code === code);

await page.goto(`${STUDIO}/sandbox?mode=studio&split=intelligent`, { waitUntil: "networkidle" });
await page.waitForSelector(".menubar");
await loadDef(demo);
await page.waitForSelector('[data-testid="split-view"]');

/* ------------------------------------------------------------ §1 Studio + Intelligent keeps Properties */
{
  await page.click(`[data-testid="split-primary"] [data-testid="qcard"][data-qid="${q("Q6").id}"]`);
  await page.waitForTimeout(300);
  assert.equal(await page.$eval(".rightpanel", (e) => e.classList.contains("rp-hidden")), false);
  assert.match(await page.$eval(".rightpanel h2", (e) => e.textContent), /Q6/);
  ok("Studio + Intelligent: selecting Q6 in the Studio pane opens Q6's Properties beside the split (§1)");
  for (const sec of ["Display logic", "Skip logic"]) assert.ok(await page.$(`.rightpanel >> text=${sec}`), `${sec} section`);
  ok("Display logic and Skip logic are there to work with");
  // a display-logic change made in Intelligent lands in the same survey the Studio pane and the panel show
  await page.fill('[data-testid="split-secondary"] [data-testid="iq-input"]', "Show Q6 only when Q4 = United States");
  await page.keyboard.press("Enter");
  await page.waitForSelector('[data-testid="split-secondary"] [data-testid="iq-apply"]');
  await page.click('[data-testid="split-secondary"] [data-testid="iq-apply"]');
  await page.waitForFunction(() => document.querySelector('[data-testid="iq-turn"]:last-of-type')?.dataset.state === "applied");
  await page.waitForTimeout(200);
  const d = await readDef();
  assert.ok(d.questions.find((x) => x.code === "Q6").displayLogic, "the rule is on Q6");
  await page.waitForSelector('[data-testid="split-view"]');
  assert.match(await page.$eval(`[data-testid="split-primary"] [data-testid="qcard"][data-qid="${q("Q6").id}"]`, (e) => e.textContent), /DL|Shown when|display/i);
  ok("a rule applied in the Intelligent pane is on the Studio card and in the survey — one model, no reload");
}

/* ------------------------------------------------------------ §11 Required: Studio → Grid → Intelligent → Flow */
{
  const before = (await readDef()).questions.find((x) => x.code === "Q9");
  assert.equal(before.required, false, "Q9 starts optional");
  await page.waitForSelector('[data-testid="split-view"]');
  // closing Q6's open editor reflows the list under the pointer, so the first click may only close it — click until Q9 is the selection
  for (let i = 0; i < 3; i++) {
    await page.click(`[data-testid="split-primary"] [data-testid="qcard"][data-qid="${q("Q9").id}"]`);
    await page.waitForTimeout(300);
    if (await page.$eval(`[data-testid="split-primary"] [data-testid="qcard"][data-qid="${q("Q9").id}"]`, (e) => e.classList.contains("selected"))) break;
  }
  // the Required control in the Studio card (the Studio pane is the full editor)
  const selects = await page.$$(`[data-testid="split-primary"] [data-testid="qcard"][data-qid="${q("Q9").id}"] select`);
  let flipped = false;
  for (const sel of selects) {
    const texts = await sel.$$eval("option", (os) => os.map((o) => o.textContent));
    if (texts.includes("required") && texts.includes("optional")) { await sel.selectOption({ label: "required" }); flipped = true; break; }
  }
  assert.ok(flipped, "found the Required select on Q9's card");
  await page.waitForTimeout(300);
  assert.equal((await readDef()).questions.find((x) => x.code === "Q9").required, true);
  ok("Studio: Q9 → Required = Yes");
  await page.waitForSelector('[data-testid="split-view"]');
  await modeMenuClick(page, "split-off");
  await switchMode(page, "grid");
  await page.waitForSelector('[data-testid="grid-view"]');
  await page.fill('[data-testid="grid-search"], .sg-search input', "Q9");
  await page.waitForTimeout(300);
  const cell = await page.$('[data-testid="grid-row"][data-code="Q9"] .sg-cell[data-col="validation"]');
  assert.match(await cell.textContent(), /required/);
  ok("Grid: Q9's Validation cell reads required — the same render, no refresh");
  await page.fill('[data-testid="grid-search"], .sg-search input', "");
  await switchMode(page, "intelligent");
  await page.waitForSelector('[data-testid="intelligent-view"]');
  await page.fill('[data-testid="iq-input"]', "explain Q9");
  await page.keyboard.press("Enter");
  await page.waitForFunction(() => document.querySelectorAll('[data-testid="iq-turn"]').length >= 1);
  await page.waitForSelector('[data-testid="iq-thinking"]', { state: "detached" });
  const lines = await page.$$eval('[data-testid="iq-turn"]:last-of-type .iq-answer-list li', (els) => els.map((e) => e.textContent));
  assert.ok(lines.some((l) => /required\.$/.test(l)), lines.join(" | "));
  ok("Intelligent: “explain Q9” sees it required — the updated property is in the intelligent context");
  await switchMode(page, "flow");
  await page.waitForSelector('[data-testid="flow-view"]');
  await page.click('[data-testid="flow-granularity"] [data-granularity="questions"]');
  await page.waitForTimeout(500);
  await page.fill('[data-testid="flow-search"]', "Q9 ");
  await page.waitForTimeout(300);
  await page.click(`[data-testid="flow-node"][data-node="${q("Q9").id}"]`);
  await page.waitForSelector('[data-testid="inspector-summary"]');
  const summary = await page.textContent('[data-testid="inspector-summary"]');
  assert.match(summary, /Requiredyes/);
  ok("Flow: the read-only inspector shows Q9 required — and offers no editor, only Open in Studio");
  assert.equal(await page.$('[data-testid="inspector"] .ai-props'), null);
  await page.fill('[data-testid="flow-search"]', "");
}

/* ------------------------------------------------------------ §4/§13 Studio + Flow: click → Studio pane lands on it */
{
  await modeMenuClick(page, "split-studio");
  await page.waitForSelector('[data-testid="split-view"][data-primary="flow"][data-secondary="studio"]');
  assert.equal(await page.$eval(".rightpanel", (e) => e.classList.contains("rp-hidden")), false);
  ok("Flow + Studio: the Properties panel is there because Studio is a pane (§13)");
  assert.equal(await page.$('[data-testid="split-primary"] [data-testid="flow-add"]'), null);
  ok("the Flow pane has no creation controls");
  const target = q("Q12").id;
  await page.fill('[data-testid="split-primary"] [data-testid="flow-search"]', "Q12 ");
  await page.waitForTimeout(400);
  await page.click(`[data-testid="split-primary"] [data-testid="flow-node"][data-node="${target}"]`);
  await page.waitForFunction((id) => document.querySelector(`[data-testid="split-secondary"] [data-testid="qcard"][data-qid="${id}"]`)?.classList.contains("selected"), target);
  const inView = await page.$eval(`[data-testid="split-secondary"] [data-testid="qcard"][data-qid="${target}"]`, (e) => { const r = e.getBoundingClientRect(); const h = e.closest(".split-body").getBoundingClientRect(); return r.top >= h.top - 4 && r.top < h.bottom; });
  assert.equal(inView, true);
  assert.match(await page.$eval(".rightpanel h2", (e) => e.textContent), /Q12/);
  ok("Flow → click Q12 → the Studio pane scrolls to Q12, selected, with Q12's Properties open (§4)");
  await page.dblclick(`[data-testid="split-primary"] [data-testid="flow-node"][data-node="${target}"]`);
  await page.waitForTimeout(300);
  assert.ok(await page.$('[data-testid="split-view"][data-primary="flow"]'), "in a split that already shows Studio, a double-click changes nothing — Studio is already there");
  ok("double-click in a Studio split keeps the pair as it is");
  await modeMenuClick(page, "split-off");
  await page.waitForSelector('[data-testid="split-view"]', { state: "detached" });
  await page.dblclick(`[data-testid="flow-node"][data-node="${target}"]`);
  await page.waitForSelector('[data-testid="questions-panel"]');
  assert.equal(await page.$eval('[data-testid="where-am-i"]', (e) => e.dataset.mode), "studio");
  assert.equal(await page.$eval('[data-testid="qcard"].selected', (e) => e.dataset.qid), target);
  ok("alone, Flow → double-click Q12 → Studio opens on Q12");
}

assert.deepEqual(pageErrors, [], `page errors: ${pageErrors.join("\n")}`);
ok("no page errors");
await browser.close();
console.log(`\n  ${passed} checks passed`);

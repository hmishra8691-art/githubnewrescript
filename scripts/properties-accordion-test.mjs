/**
 * THE PROPERTIES PANEL ACCORDION, IN THE REAL STUDIO (Part B of the
 * universal auto-punch brief, §36-§46).
 *
 * `CollapsibleSection` itself has no unit tests — it is a thin, local-state
 * React component with nothing to unit test in isolation — so this is the
 * only place its actual contract gets checked against a real question:
 * a section already carrying configuration opens by default and one that
 * doesn't stays closed, toggling one section never touches another,
 * collapsing and reopening changes nothing about the survey (a UI
 * preference, never survey logic — §45), and the search box narrows which
 * sections are offered without touching any of their content.
 */
import { chromium } from "/home/claude/.npm-global/lib/node_modules/playwright/index.mjs";
import assert from "node:assert/strict";

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1700, height: 1150 } });
page.on("pageerror", (e) => console.error("PAGE ERROR:", e.message));
page.on("dialog", (d) => d.accept());

const FIXTURE = {
  meta: { id: "sandbox", code: "SANDBOX", title: "Accordion", version: "1.0" },
  questions: [
    {
      id: "q1", code: "Q1", variableName: "Q1", type: "numeric", text: "How many?",
    },
    {
      id: "q2", code: "Q2", variableName: "Q2", type: "single_select", text: "Pick one",
      options: [{ code: "a", label: "Alpha" }, { code: "b", label: "Beta" }],
      // pre-configured, so Display logic and Auto punch should open by
      // default; everything else on this question is untouched, so it
      // should not.
      displayLogic: { type: "rule", source: { kind: "question", ref: "q1" }, operator: "gte", value: 1 },
      // `priority` (not just a bare option-to-option rule) routes this through
      // the "auto-select from a set" editor's cell-capable cards
      // (`data-testid="punch-rule"`) rather than the simpler option DSL —
      // see `isOptionLevelPunch` in `@rescript/engine`.
      punches: [{
        id: "pr1", label: "seed rule", mode: "if", action: "select", ignoreUnmatched: true,
        recompute: "once", mapping: [], priority: 1, source: { kind: "codes", codes: ["a"] },
      }],
    },
  ],
  flow: [
    { type: "page", id: "p1", questionIds: ["q1", "q2"] },
    { type: "end", id: "e1", status: "complete" },
  ],
};

const readDef = async () => {
  await page.click(".leftnav >> text=JSON");
  await page.waitForSelector("textarea.code");
  const json = await page.$eval("textarea.code", (e) => e.value);
  return JSON.parse(json);
};
const goTab = async (name) => {
  await page.click(`.leftnav >> text=${name}`);
  await page.waitForTimeout(150);
};
const isOpen = async (id) =>
  (await page.getAttribute(`[data-testid="psec-head-${id}"]`, "aria-expanded")) === "true";
const toggle = async (id) => {
  await page.click(`[data-testid="psec-head-${id}"]`);
  await page.waitForTimeout(120);
};

await page.goto("http://localhost:3000/sandbox", { waitUntil: "networkidle" });
await page.waitForSelector(".leftnav");
await goTab("JSON");
await page.waitForSelector("textarea.code");
await page.click('button:has-text("edit")');
await page.fill("textarea.code", JSON.stringify(FIXTURE, null, 2));
await page.click('button:has-text("validate & apply")');
await page.waitForTimeout(400);
assert.equal((await readDef()).questions.length, 2);
console.log("✔ fixture loaded: Q2 already has display logic and an auto-punch rule; nothing else is configured");

await goTab("Questions");
await page.waitForSelector(".qcard");
const cards = await page.$$(".qcard");
await cards[cards.length - 1].click(); // Q2
await page.waitForSelector('[data-testid="psec-head-display-logic"]');

/* ===================================== §39: open only what is configured */

assert.equal(await isOpen("display-logic"), true, "Display logic already holds a rule — open by default");
assert.equal(await isOpen("auto-punch"), true, "Auto punch already holds a rule — open by default");
for (const id of ["skip-logic", "carry-forward", "randomization", "masking",
  "list-logic", "list-operations", "validation-rules", "state", "custom-code"]) {
  assert.equal(await isOpen(id), false, `${id} has nothing configured — collapsed by default`);
}
console.log("✔ §39: only sections that already carry configuration open by default; every empty section starts collapsed");

/* ==================================== toggling one section leaves others alone */

await toggle("skip-logic");
assert.equal(await isOpen("skip-logic"), true, "Skip logic opened");
assert.equal(await isOpen("display-logic"), true, "Display logic, opened by default, is untouched by an unrelated toggle");
assert.equal(await isOpen("validation-rules"), false, "an unrelated closed section stays closed");

await toggle("display-logic");
assert.equal(await isOpen("display-logic"), false, "Display logic collapsed");
assert.equal(await isOpen("skip-logic"), true, "Skip logic, just opened, is untouched by a DIFFERENT section's toggle");
console.log("✔ each section's expand state is independent — toggling one never opens or closes another");

/* ============================ §45: collapse/reopen is a UI preference only */

const beforePunches = JSON.stringify((await readDef()).questions[1].punches);
await toggle("auto-punch"); // collapse
assert.equal(await page.$('[data-testid="psec-body-auto-punch"]'), null, "collapsed body is not rendered");
const midPunches = JSON.stringify((await readDef()).questions[1].punches);
assert.equal(midPunches, beforePunches, "collapsing a section does not touch the survey definition");
await toggle("auto-punch"); // reopen
assert.ok(await page.$('[data-testid="punch-rule"]'), "the rule is exactly where it was");
const afterPunches = JSON.stringify((await readDef()).questions[1].punches);
assert.equal(afterPunches, beforePunches, "…and reopening it doesn't touch the definition either");
console.log("✔ §45: expand/collapse is a UI preference — the survey's auto-punch rule survives collapse and reopen byte for byte");

/* preserved values across collapse/reopen, for a section with live editing */
await toggle("custom-code");
await page.fill('[data-testid="psec-body-custom-code"] textarea.code', "// marker-xyz");
await page.waitForTimeout(300);
assert.equal((await readDef()).questions[1].customJs, "// marker-xyz", "typed value saved");
await toggle("custom-code"); // collapse
await toggle("custom-code"); // reopen
const restored = await page.inputValue('[data-testid="psec-body-custom-code"] textarea.code');
assert.equal(restored, "// marker-xyz", "the typed value is still there after a round trip through collapsed");
console.log("✔ a value typed into a section survives that section being collapsed and reopened");

/* now that Custom code has content, note it starts CLOSED until reselected — but
 * the ACTIVE dot should mark it as configured even while collapsed elsewhere. */
await goTab("Questions");
await page.waitForSelector(".qcard");
let freshCards = await page.$$(".qcard");
await freshCards[0].click(); // Q1
await page.waitForTimeout(150);
freshCards = await page.$$(".qcard");
await freshCards[freshCards.length - 1].click(); // back to Q2 — remounts the panel
await page.waitForSelector('[data-testid="psec-head-custom-code"]');
assert.ok(await page.$('[data-testid="psec-active-custom-code"]'),
  "Custom code is marked configured (●) now that it holds content");
assert.ok(await page.getAttribute('[data-testid="psec-active-custom-code"]', "aria-label"),
  "the configured marker carries a text label, not color alone (§40 accessibility)");
console.log("✔ §40: a configured section is marked with a non-color-only indicator, visible even before it is opened");

/* ============================================== §46: the search box filters */

await page.fill('[data-testid="properties-search"]', "punch");
await page.waitForTimeout(150);
assert.ok(await page.$('[data-testid="psec-auto-punch"]'), "Auto punch matches the search");
assert.equal(await page.$('[data-testid="psec-skip-logic"]'), null, "Skip logic does not match \"punch\" and is hidden");
assert.equal(await page.$('[data-testid="psec-validation-rules"]'), null, "neither does Validation rules");
console.log('✔ §46: typing "punch" into the search box narrows the panel to matching sections only');

await page.fill('[data-testid="properties-search"]', "");
await page.waitForTimeout(150);
assert.ok(await page.$('[data-testid="psec-skip-logic"]'), "clearing the search restores every section");
assert.ok(await page.$('[data-testid="psec-validation-rules"]'));
console.log("✔ clearing the search box restores the full section list");

/* the search filters sections, not content: Auto punch's rule survived the trip */
assert.deepEqual(JSON.parse(JSON.stringify((await readDef()).questions[1].punches)), JSON.parse(beforePunches),
  "filtering the panel via search never touches the underlying survey");
console.log("✔ the search box is purely a display filter — nothing it hides is altered");

/* ============================================= independent scroll (§43) */

const centerBefore = await page.$eval("main.center", (e) => {
  const r = e.getBoundingClientRect();
  return { left: r.left, width: r.width };
});
for (const id of ["skip-logic", "carry-forward", "randomization", "masking",
  "list-logic", "list-operations", "validation-rules", "state"]) {
  if (!(await isOpen(id))) await toggle(id);
}
const rightpanel = await page.$eval(".rightpanel", (e) => ({
  scrollHeight: e.scrollHeight, clientHeight: e.clientHeight,
}));
assert.ok(rightpanel.scrollHeight > rightpanel.clientHeight,
  `with every section open the panel actually overflows: ${JSON.stringify(rightpanel)}`);
const centerAfter = await page.$eval("main.center", (e) => {
  const r = e.getBoundingClientRect();
  return { left: r.left, width: r.width };
});
assert.deepEqual(centerAfter, centerBefore,
  "the canvas is completely unaffected by how much the properties panel has expanded");
console.log("✔ §43: the Properties panel scrolls on its own — opening every section does not resize or reflow the canvas");

await page.screenshot({ path: "/tmp/st-properties-accordion.png", fullPage: false });
await browser.close();
console.log("\nALL PROPERTIES ACCORDION CHECKS PASSED");

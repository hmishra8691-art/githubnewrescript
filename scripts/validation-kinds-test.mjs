/**
 * VALIDATION KINDS AND THE TWO NEW SCALAR VARIANTS, IN THE REAL STUDIO
 * (audit 2026-10-16: QT-08, QT-12).
 *
 * The engine checks `pattern`, `custom_script`, `custom_expression`,
 * `condition` and an "Other (specify)" box's format, and the action path is
 * unit-tested (`packages/engine/src/p3TypesAndPlan.test.ts`). What only a
 * browser can show is that each one is SETTABLE from the Properties panel's
 * validation editor (or, for the Other format, the question editor) and lands
 * in the definition — and that a Date & Time and a Duration question offer
 * their bounds in the unit the answer is stored in, and draw their inputs.
 *
 * Needs `next dev` on :3000 (the orchestrator runs it).
 */
import { chromium } from "./lib/playwright.mjs";
import { openTab, openTabKey } from "./lib/nav.mjs";
import assert from "node:assert/strict";
import { sendPreview } from "./lib/preview.mjs";
import { openSectionWorkspace, openWorkspace, saveWorkspace, workspaceOpen, reopenLastWorkspace, LD_BODY, LOGIC_SECTIONS } from "./lib/logicWorkspace.mjs";

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1700, height: 1150 } });
page.on("pageerror", (e) => console.error("PAGE ERROR:", e.message));
page.on("dialog", (d) => d.accept());

const FIXTURE = {
  meta: { id: "sandbox", code: "SANDBOX", title: "Validation kinds", version: "1.0" },
  questions: [
    { id: "q1", code: "Q1", variableName: "Q1", type: "open_text", variant: "text.single_line", text: "Your code?" },
    {
      id: "q2", code: "Q2", variableName: "Q2", type: "single_select", variant: "single_select.radio", text: "How many pets?",
      options: [{ code: 1, label: "None" }, { code: 2, label: "Other number", flags: ["other_specify"] }],
    },
    { id: "q3", code: "Q3", variableName: "Q3", type: "date", variant: "datetime.datetime", text: "When did it happen?" },
    { id: "q4", code: "Q4", variableName: "Q4", type: "numeric", variant: "numeric.duration", text: "How long?", settings: { readOnly: false, hidden: false, minValue: 0, durationParts: "hms" } },
  ],
  scripts: [{ id: "sc1", name: "evenOnly", scope: "survey", event: "on_validate", code: "if (Number(value) % 2) ctx.error('Even numbers only.');", enabled: true }],
  flow: [
    { type: "page", id: "p1", questionIds: ["q1", "q2", "q3", "q4"] },
    { type: "end", id: "e1", status: "complete" },
  ],
};

const readDef = async () => {
  const activeTab = await page.$eval(".menubar-here", (e) => e.dataset.tab).catch(() => null);
  // a peek at the JSON saves the open logic workspace (openTab does) and reopens it afterwards
  const wasEditing = await workspaceOpen(page);
  await openTab(page, "JSON");
  await page.waitForSelector("textarea.code");
  const json = await page.$eval("textarea.code", (e) => e.value);
  if (activeTab) await openTabKey(page, activeTab).catch(() => {});
  if (wasEditing) await reopenLastWorkspace(page);
  return JSON.parse(json);
};
const goTab = async (name) => { await openTab(page, name); await page.waitForTimeout(150); };
const selectCard = async (i) => {
  await goTab("Questions");
  await page.waitForSelector(".qcard");
  const cards = await page.$$(".qcard");
  await cards[i].click();
  await page.waitForTimeout(200);
};
const openSection = async (id) => {
  if (LOGIC_SECTIONS.has(id)) { await openSectionWorkspace(page, id); await page.waitForTimeout(150); return; } // edited in the centred logic workspace
  await page.waitForSelector(`[data-testid="psec-head-${id}"]`);
  if ((await page.getAttribute(`[data-testid="psec-head-${id}"]`, "aria-expanded")) !== "true") {
    await page.click(`[data-testid="psec-head-${id}"]`);
    await page.waitForTimeout(120);
  }
};
const rules = () => page.locator('[data-testid="logic-dialog-body"] [data-testid="validation-rule"]');
/** add a rule, pick its kind, and return its card */
const addRule = async (kind) => {
  const before = await rules().count();
  await page.click('[data-testid="logic-dialog-body"] button:has-text("+ rule")');
  await page.waitForTimeout(150);
  const card = rules().nth(before);
  const kindSelect = card.locator("select").first();
  const offered = await kindSelect.locator("option").evaluateAll((os) => os.map((o) => o.value));
  assert.ok(offered.includes(kind), `the validation editor offers “${kind}” (offered: ${offered.join(", ")})`);
  await kindSelect.selectOption(kind);
  await page.waitForTimeout(150);
  return card;
};

await page.goto("http://localhost:3000/sandbox", { waitUntil: "networkidle" });
await page.waitForSelector(".menubar");
await goTab("JSON");
await page.waitForSelector("textarea.code");
await page.click('button:has-text("edit")');
await page.fill("textarea.code", JSON.stringify(FIXTURE, null, 2));
await page.click('button:has-text("validate & apply")');
await page.waitForTimeout(400);
assert.equal((await readDef()).questions.length, 4);
console.log("✔ fixture loaded: a text, a single with an Other box, a Date & Time, a Duration, and one validation script");

/* ================================================ QT-08: the four rule kinds */

await selectCard(0);
await openSection("validation-rules");

let card = await addRule("pattern");
await card.locator('[data-testid="validation-value"]').fill("^[A-Z]{2}\\d{2}$");
await page.waitForTimeout(250);
card = await addRule("custom_script");
await card.locator('[data-testid="validation-value"]').fill("evenOnly");
await page.waitForTimeout(250);
card = await addRule("custom_expression");
await card.locator('[data-testid="validation-value"]').fill("value != \"XX00\"");
await page.waitForTimeout(250);
card = await addRule("condition");
assert.ok(await card.locator('[data-testid="validation-condition-editor"]').count(), "a condition rule opens the shared condition builder");

let q1 = (await readDef()).questions[0];
const kinds = q1.validation.map((v) => v.kind);
for (const k of ["pattern", "custom_script", "custom_expression", "condition"]) assert.ok(kinds.includes(k), `${k} saved (${kinds.join(", ")})`);
assert.equal(q1.validation.find((v) => v.kind === "pattern").value, "^[A-Z]{2}\\d{2}$");
assert.equal(q1.validation.find((v) => v.kind === "custom_script").value, "evenOnly");
assert.equal(q1.validation.find((v) => v.kind === "custom_expression").value, "value != \"XX00\"");
console.log("✔ QT-08: pattern, custom_script, custom_expression and condition are each offered and saved from the validation editor");

/* =============================================== QT-08: the Other box format */

await selectCard(1);
await page.waitForSelector('[data-testid="other-specify-format"]');
await page.selectOption('[data-testid="other-specify-format"]', "numeric");
await page.waitForTimeout(250);
assert.equal((await readDef()).questions[1].settings.otherSpecifyFormat, "numeric");
console.log("✔ QT-08: the “Other” box's format is set from the question editor and saved as otherSpecifyFormat");

/* ======================================= QT-12: Date & Time — bounds by date */

await selectCard(2);
await openSection("validation-rules");
card = await addRule("date_min");
const dtHint = await card.locator('[data-testid="validation-value"]').getAttribute("placeholder");
assert.match(dtHint ?? "", /T09:00/, `the bound hint shows a date-time (${dtHint})`);
await card.locator('[data-testid="validation-value"]').fill("2026-10-16T10:00");
await page.waitForTimeout(250);
assert.equal((await readDef()).questions[2].validation.find((v) => v.kind === "date_min").value, "2026-10-16T10:00");
console.log("✔ QT-12: a Date & Time question offers date bounds (with a time)");

/* ========================================= QT-12: Duration — bounds in seconds */

await selectCard(3);
await page.waitForSelector('[data-testid="duration-parts"]');
const minLabel = await page.$eval('[data-testid="min-value"]', (e) => e.closest("label")?.textContent ?? "");
assert.match(minLabel, /seconds/, `the Min field says its unit (${minLabel})`);
await page.selectOption('[data-testid="duration-parts"]', "hm");
await page.waitForTimeout(250);
assert.equal((await readDef()).questions[3].settings.durationParts, "hm");
await openSection("validation-rules");
card = await addRule("max_value");
assert.match((await card.locator('[data-testid="validation-value"]').getAttribute("placeholder")) ?? "", /seconds/);
console.log("✔ QT-12: a Duration question says its bounds are seconds and chooses its parts");

// the respondent's side: the runtime preview draws one date-and-time input and the hours/minutes input
{
  const def = await readDef();
  const rt = await browser.newPage({ viewport: { width: 1100, height: 900 } });
  await rt.goto(`${process.env.RUNTIME_URL ?? "http://localhost:3001"}/preview`, { waitUntil: "networkidle" });
  await sendPreview(rt, { definition: def }, { selector: '[data-qid="q3"] [data-testid="datetime-input"]' });
  assert.ok(await rt.$('[data-qid="q4"] [data-testid="duration-input"][data-parts="hm"]'), "the runtime draws hours and minutes");
  await rt.close();
}
console.log("✔ QT-12: the runtime draws the Date & Time input and the h/min Duration input");

await page.screenshot({ path: "/tmp/st-validation-kinds.png", fullPage: false });
await browser.close();
console.log("\nALL VALIDATION KIND CHECKS PASSED");

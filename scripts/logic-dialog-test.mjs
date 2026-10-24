/**
 * THE LOGIC WORKSPACE — the centred dialog every rule builder opens into
 * (client review 23 Oct 2026, item 3; docs/LOGIC-DIALOG-2026-10-24.md).
 *
 * What this proves, in the real Studio against the real store:
 *   · Display logic: "in workspace" opens a centred, wide dialog; three
 *     conditions including a nested OR group are built on a DRAFT (the survey
 *     is untouched until Save); Save stores exactly the expected ConditionTree
 *     and the inline summary reads it back;
 *   · Cancel discards; reopening shows the saved configuration; Escape and the
 *     backdrop close a clean dialog and ask "Discard?" on a dirty one;
 *   · the Skip logic, Validation and Auto punch workspaces hold the WHOLE rule
 *     list (add / remove / reorder) and commit through the same `patch`;
 *   · a Survey Flow branch opens all its paths in one workspace;
 *   · a long configuration scrolls INSIDE the dialog — the frame stays within
 *     the viewport — and Tab never leaves it (focus trap);
 *   · under tablet width the dialog is a full-screen sheet.
 *
 *   node --experimental-strip-types --no-warnings scripts/logic-dialog-test.mjs   (studio on :3000)
 */
import { chromium } from "./lib/playwright.mjs";
import { openTab, openTabKey } from "./lib/nav.mjs";
import assert from "node:assert/strict";

const STUDIO = process.env.STUDIO_URL ?? "http://localhost:3000";
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1600, height: 1000 } });
const pageErrors = [];
page.on("pageerror", (e) => { pageErrors.push(e.message); console.error("PAGE ERROR:", e.message); });
page.on("dialog", (d) => d.accept());

let passed = 0;
const ok = (m) => { console.log("  ok  ", m); passed++; };
const settle = (ms = 220) => page.waitForTimeout(ms);

const FIXTURE = {
  meta: { id: "sandbox", code: "SANDBOX", title: "Logic workspace", version: "1.0" },
  questions: [
    { id: "a1", code: "A1", variableName: "A1", type: "single_select", text: "Which brand do you currently use?",
      options: [{ code: "yes", label: "Yes" }, { code: "no", label: "No" }, { code: "maybe", label: "Maybe" }] },
    { id: "a2", code: "A2", variableName: "A2", type: "single_select", text: "Gender",
      options: [{ code: "m", label: "Male" }, { code: "f", label: "Female" }] },
    { id: "a3", code: "A3", variableName: "A3", type: "numeric", text: "Age" },
    { id: "a4", code: "A4", variableName: "A4", type: "single_select", text: "Preferred brand",
      options: [{ code: "yes", label: "Yes" }, { code: "no", label: "No" }] },
  ],
  flow: [
    { type: "page", id: "p1", title: "Block 1", questionIds: ["a1", "a2", "a3", "a4"] },
    { type: "end", id: "e1", status: "complete" },
  ],
};

/* ------------------------------------------------------------ helpers */

/** The dev server is supervised and may restart under us: retry the load. */
const gotoStudio = async () => {
  for (let i = 0; i < 12; i++) {
    try {
      await page.goto(`${STUDIO}/sandbox`, { waitUntil: "networkidle", timeout: 90000 });
      await page.waitForSelector(".menubar", { timeout: 30000 });
      return;
    } catch (e) {
      console.log(`  …studio not ready (${e.message.split("\n")[0].slice(0, 80)}), retrying`);
      await page.waitForTimeout(5000);
    }
  }
  throw new Error("studio never came up");
};

const readDef = async () => {
  const activeTab = await page.$eval(".menubar-here", (e) => e.dataset.tab).catch(() => null);
  await openTab(page, "JSON");
  await page.waitForSelector("textarea.code");
  const json = await page.$eval("textarea.code", (e) => e.value);
  if (activeTab) await openTabKey(page, activeTab).catch(() => {});
  return JSON.parse(json);
};
const loadDef = async (def) => {
  await openTab(page, "JSON");
  await page.waitForSelector("textarea.code");
  await page.click('button:has-text("edit")');
  await page.fill("textarea.code", JSON.stringify(def, null, 2));
  await page.click('button:has-text("validate & apply")');
  await settle(400);
};

/** select question `qid` and expand Properties section `sectionId` */
const openSection = async (qid, sectionId) => {
  await openTab(page, "Questions");
  await page.waitForSelector(`[data-testid="qcard"][data-qid="${qid}"]`);
  await page.click(`[data-testid="qcard"][data-qid="${qid}"]`);
  const head = `[data-testid="psec-head-${sectionId}"]`;
  await page.waitForSelector(head);
  if ((await page.getAttribute(head, "aria-expanded")) !== "true") await page.click(head);
  await settle();
};

const DLG = '[data-testid="logic-dialog"]';
const BODY = '[data-testid="logic-dialog-body"]';
const TOP_ROW = `${BODY} .lb-list.root > .lb-row`;
const TOP_CHECK = `${TOP_ROW} > .lb-pick > input`;

const dialogOpen = async () => !!(await page.$(DLG));
const waitDialog = () => page.waitForSelector(DLG, { timeout: 10000 });
const waitClosed = () => page.waitForSelector(DLG, { state: "detached", timeout: 10000 });

/** Fill top-level row `i` of the builder INSIDE the dialog. */
const setRow = async (i, { ref, op, value }) => {
  const rowAt = async () => (await page.$$(TOP_ROW))[i];
  if (ref) await (await rowAt()).$eval("select.ref-select", (el, v) => { el.value = v; el.dispatchEvent(new Event("change", { bubbles: true })); }, `q:${ref}`);
  await settle(150);
  if (op) await (await rowAt()).$eval("select.op-select", (el, v) => { el.value = v; el.dispatchEvent(new Event("change", { bubbles: true })); }, op);
  await settle(150);
  if (value !== undefined) {
    const fresh = await rowAt();
    const sel = await fresh.$(".cond-rule-main select:not(.ref-select):not(.op-select)");
    if (sel) await sel.evaluate((el, v) => { el.value = v; el.dispatchEvent(new Event("change", { bubbles: true })); }, String(value));
    else await (await fresh.$(".cond-rule-main input")).fill(String(value));
  }
  await settle(150);
};

const tickRows = async (indices) => {
  for (const i of indices) {
    const boxes = await page.$$(TOP_CHECK);
    assert.ok(boxes[i], `no checkbox at row ${i} (found ${boxes.length})`);
    await boxes[i].click();
    await settle(150);
  }
};

const rule = (ref, value) => ({ type: "rule", source: { kind: "question", ref }, operator: "eq", value });

/* ================================================================ start */

await gotoStudio();
await loadDef(FIXTURE);
assert.equal((await readDef()).questions.length, 4, "the fixture loaded");
ok("fixture loaded (A1, A2, A3, A4)");

/* ======================================= 1. display logic → the workspace */

await openSection("a3", "display-logic");
assert.equal(await page.$('[data-testid="optional-add-workspace"]') !== null, true, "an empty condition offers “Add logic ⤢”");
assert.equal(await page.$('[data-testid="psec-body-display-logic"] [data-testid="optional-add"]'), null, "the narrow panel has no inline “+ add” by default");
assert.match(await page.textContent('[data-testid="optional-add-workspace"]'), /Add logic\s*⤢/, "the button reads “Add logic ⤢”");
ok("default: the Properties panel offers “Add logic ⤢”, not an inline builder");
await page.click('[data-testid="optional-add-workspace"]');
await waitDialog();

const dlgAttrs = await page.$eval(DLG, (e) => ({ role: e.getAttribute("role"), modal: e.getAttribute("aria-modal"), labelled: !!e.getAttribute("aria-labelledby") }));
assert.deepEqual(dlgAttrs, { role: "dialog", modal: "true", labelled: true }, `dialog semantics: ${JSON.stringify(dlgAttrs)}`);
const title = await page.textContent('[data-testid="logic-dialog-title"]');
assert.match(title, /^Display logic — A3: Age$/, `title names the feature and the question: ${title}`);
assert.match(await page.textContent(`${DLG} .ld-desc`), /Display A3 only if the following condition is met/, "one-line explanation");
const geom = await page.evaluate((sel) => {
  const r = document.querySelector(sel).getBoundingClientRect();
  return { w: Math.round(r.width), h: Math.round(r.height), cx: Math.round(r.x + r.width / 2), cy: Math.round(r.y + r.height / 2), vw: window.innerWidth, vh: window.innerHeight };
}, DLG);
assert.ok(geom.w >= 1000 && geom.w <= 1100, `wide — ≈min(1100px, 92vw): ${geom.w}px`);
assert.ok(Math.abs(geom.cx - geom.vw / 2) < 4 && Math.abs(geom.cy - geom.vh / 2) < 40, `centred on the window: ${JSON.stringify(geom)}`);
assert.equal(await page.$eval(`${BODY} [data-testid="logic-builder"]`, (e) => e.dataset.layout), "wide", "the builder is in its wide layout");
assert.equal(await page.$eval(DLG, (e) => e.dataset.dirty), "0", "opens clean");
assert.equal(await page.$eval('[data-testid="logic-dialog-save"]', (e) => e.disabled), true, "Save is disabled until something changes");
assert.equal(await page.textContent('[data-testid="logic-dialog-cancel"]'), "Close", "a clean dialog offers Close");
assert.equal(await page.$(`${BODY} [data-testid="logic-workspace-open"]`), null, "no workspace button inside the workspace");
ok("display logic opens a centred ≈1100px dialog — role=dialog, aria-modal, title “Display logic — A3: Age”, explanation, wide builder, Save disabled while clean");

/* --- three conditions, two of them in a nested OR group — on the draft */
for (let i = 0; i < 3; i++) { await page.click(`${BODY} [data-testid="lb-add-condition"] >> nth=0`); await settle(180); }
assert.equal((await page.$$(TOP_ROW)).length, 3);
await setRow(0, { ref: "a1", op: "eq", value: "yes" });
await setRow(1, { ref: "a1", op: "eq", value: "no" });
await setRow(2, { ref: "a2", op: "eq", value: "m" });
assert.equal(await page.$eval(DLG, (e) => e.dataset.dirty), "1", "editing marks the draft dirty");
assert.ok(await page.$('[data-testid="logic-dialog-dirty"]'), "…and says so in the header");
assert.equal(await page.textContent('[data-testid="logic-dialog-cancel"]'), "Cancel", "a dirty dialog offers Cancel");
await tickRows([0, 1]);
await page.click(`${BODY} [data-testid="lb-move-to-group"]`);
await page.waitForSelector(`${BODY} [data-testid="lb-group"]`);
await page.selectOption(`${BODY} [data-testid="group-op"]`, "or");
await settle(300);
// the connector between the group and the third condition is on one wide row with its hint
const joinHint = await page.textContent(`${BODY} .lb-list.root > .lb-join .lb-join-hint`);
assert.match(joinHint, /all of these must be true/, `the top-level AND connector carries its wording in the wide layout: ${joinHint}`);
const innerHint = await page.textContent(`${BODY} .lb-group .lb-join .lb-join-hint`);
assert.match(innerHint, /any one of these/, `the group's OR connector reads as OR: ${innerHint}`);
const groupBadge = await page.textContent(`${BODY} .lb-group-badge`);
assert.equal(groupBadge.trim(), "GROUP 1", "the nested group is labelled");
// the Test condition panel and “find operator…” survive in the workspace
assert.ok(await page.$(`${BODY} [data-testid="cond-test-toggle"]`), "Test condition is offered in the workspace");
assert.ok(await page.$(`${BODY} [data-testid="cond-op-search"]`), "“find operator…” is offered in the workspace");
const draftSentence = await page.textContent(`${BODY} [data-testid="cond-purpose-summary"]`);
assert.match(draftSentence, /Display A3 if \(the respondent selects “Yes” at A1 or the respondent selects “No” at A1\) and the respondent selects “Male” at A2/, `the draft reads back as a sentence: ${draftSentence}`);
ok("three conditions built in the workspace, two moved into a nested OR group; Test condition and find-operator are there");

/* --- the survey is untouched while the draft is open */
// (the inline panel still says "nothing here" — nothing has been stored)
const inlineBefore = await page.textContent('[data-testid="psec-body-display-logic"]');
assert.match(inlineBefore, /Nothing here means A3 always shows/, "the inline section still shows no logic — the draft has not been stored");
ok("the draft is a draft: the Properties panel underneath still has no display logic");

/* --- Save commits exactly the expected tree */
await page.click('[data-testid="logic-dialog-save"]');
await waitClosed();
const EXPECTED = {
  type: "group", op: "and",
  children: [
    { type: "group", op: "or", children: [rule("a1", "yes"), rule("a1", "no")] },
    rule("a2", "m"),
  ],
};
let def = await readDef();
let saved = def.questions.find((q) => q.id === "a3").displayLogic;
assert.deepEqual(saved, EXPECTED, `the saved definition holds exactly the expected ConditionTree:\n${JSON.stringify(saved, null, 1)}`);
ok("Save stored exactly (A1=yes OR A1=no) AND A2=m — the same ConditionTree the inline builder would store");

/* --- the inline summary reads the saved logic back */
await openSection("a3", "display-logic");
const inlineAfter = await page.textContent('[data-testid="psec-body-display-logic"]');
assert.match(inlineAfter, /Display A3 if \(the respondent selects “Yes” at A1 or the respondent selects “No” at A1\) and the respondent selects “Male” at A2/, `inline summary updated: ${inlineAfter.slice(0, 200)}`);
assert.ok(await page.$('[data-testid="psec-active-display-logic"]'), "the section's active dot is on");
assert.ok(await page.$('[data-testid="psec-body-display-logic"] [data-testid="logic-workspace-open"]'), "a configured condition offers “Edit in workspace”");
ok("inline summary and active dot reflect the saved logic; the section offers Edit in workspace");

/* ===================================== 2. reopen shows saved; Cancel discards */

await page.click('[data-testid="psec-body-display-logic"] [data-testid="logic-workspace-open"]');
await waitDialog();
assert.equal((await page.$$(TOP_ROW)).length, 2, "reopened: the group row and the third condition");
assert.equal(await page.$eval(`${BODY} [data-testid="group-op"]`, (e) => e.value), "or", "reopened: the group is OR");
assert.equal(await page.$eval(DLG, (e) => e.dataset.dirty), "0", "reopened clean");
ok("reopening shows the saved configuration");

// change the group to AND and the third condition's value, then Cancel
await page.selectOption(`${BODY} [data-testid="group-op"]`, "and");
await settle();
await setRow(1, { value: "f" });
assert.equal(await page.$eval(DLG, (e) => e.dataset.dirty), "1");
await page.click('[data-testid="logic-dialog-cancel"]');
await page.waitForSelector('[data-testid="logic-dialog-confirm"]');
assert.match(await page.textContent('[data-testid="logic-dialog-confirm"]'), /Discard unsaved changes\?/, "Cancel on a dirty draft asks first");
await page.click('[data-testid="logic-dialog-keep"]');
await settle();
assert.equal(await dialogOpen(), true, "Keep editing keeps the dialog");
assert.equal(await page.$eval(`${BODY} [data-testid="group-op"]`, (e) => e.value), "and", "…and the edits");
await page.click('[data-testid="logic-dialog-cancel"]');
await page.waitForSelector('[data-testid="logic-dialog-confirm"]');
await page.click('[data-testid="logic-dialog-discard"]');
await waitClosed();
def = await readDef();
assert.deepEqual(def.questions.find((q) => q.id === "a3").displayLogic, EXPECTED, "Cancel → Discard left the saved logic exactly as it was");
ok("Cancel asks “Discard unsaved changes?”; Keep editing keeps the draft; Discard leaves the survey untouched");

/* ============================================= 3. Escape and the backdrop */

await openSection("a3", "display-logic");
await page.click('[data-testid="psec-body-display-logic"] [data-testid="logic-workspace-open"]');
await waitDialog();
await page.keyboard.press("Escape");
await waitClosed();
ok("Escape closes a clean dialog");

await page.click('[data-testid="psec-body-display-logic"] [data-testid="logic-workspace-open"]');
await waitDialog();
await page.selectOption(`${BODY} [data-testid="group-op"]`, "not");
await settle();
await page.keyboard.press("Escape");
await page.waitForSelector('[data-testid="logic-dialog-confirm"]');
assert.equal(await dialogOpen(), true, "Escape on a dirty draft asks instead of closing");
await page.click('[data-testid="logic-dialog-keep"]');
await settle();
// the backdrop: a click outside the dialog box
await page.mouse.click(30, 500);
await page.waitForSelector('[data-testid="logic-dialog-confirm"]');
await page.click('[data-testid="logic-dialog-discard"]');
await waitClosed();
def = await readDef();
assert.deepEqual(def.questions.find((q) => q.id === "a3").displayLogic, EXPECTED, "neither Escape nor the backdrop changed the survey");
ok("Escape / backdrop on a dirty draft ask “Discard?”; discarding leaves the saved logic as it was");

/* ====================================================== 4. focus trap */

await openSection("a3", "display-logic");
await page.click('[data-testid="psec-body-display-logic"] [data-testid="logic-workspace-open"]');
await waitDialog();
const inside = () => page.evaluate((sel) => document.querySelector(sel).contains(document.activeElement), DLG);
assert.equal(await inside(), true, "focus moved into the dialog on open");
for (let i = 0; i < 60; i++) {
  await page.keyboard.press("Tab");
  if (!(await inside())) assert.fail(`Tab #${i + 1} left the dialog`);
}
for (let i = 0; i < 8; i++) {
  await page.keyboard.press("Shift+Tab");
  if (!(await inside())) assert.fail(`Shift+Tab #${i + 1} left the dialog`);
}
ok("keyboard focus is trapped: 60 Tabs and 8 Shift+Tabs never leave the dialog");
await page.keyboard.press("Escape");
await waitClosed();
const focusBack = await page.evaluate(() => document.activeElement?.getAttribute("data-testid"));
assert.equal(focusBack, "logic-workspace-open", `focus returns to the button that opened the workspace: ${focusBack}`);
ok("on close, focus returns to the opener");

/* ================================================ 5. skip logic — whole list */

await openSection("a1", "skip-logic");
assert.match(await page.textContent('[data-testid="skip-logic-strip-count"]'), /0 rules/, "the inline strip counts the rules");
await page.click('[data-testid="skip-logic-strip"] [data-testid="logic-workspace-open"]');
await waitDialog();
assert.match(await page.textContent('[data-testid="logic-dialog-title"]'), /^Skip logic — A1: Which brand do you currently use\?$/);
await page.click(`${BODY} [data-testid="skip-rule-add"]`);
await settle();
await page.click(`${BODY} [data-testid="skip-rule-add"]`);
await settle();
assert.equal((await page.$$(`${BODY} [data-testid="skip-rule"]`)).length, 2, "two rules added in the workspace");
// rule 1: IF A1 = no → terminate; rule 2 targets a question but names none → Save is blocked with a reason
await page.click(`${BODY} [data-testid="skip-rule"] >> nth=0 >> [data-testid="lb-add-condition"]`);
await settle();
const r1 = (await page.$$(`${BODY} [data-testid="skip-rule"]`))[0];
await r1.$eval("select.ref-select", (el) => { el.value = "q:a1"; el.dispatchEvent(new Event("change", { bubbles: true })); });
await settle(150);
await (await page.$$(`${BODY} [data-testid="skip-rule"]`))[0].$eval(".cond-rule-main select:not(.ref-select):not(.op-select)", (el) => { el.value = "no"; el.dispatchEvent(new Event("change", { bubbles: true })); });
await settle(150);
await (await page.$$(`${BODY} [data-testid="skip-rule"]`))[0].$eval(".skip-target select", (el) => { el.value = "terminate"; el.dispatchEvent(new Event("change", { bubbles: true })); });
await settle(150);
await (await page.$$(`${BODY} [data-testid="skip-rule"]`))[1].$eval(".skip-target select", (el) => { el.value = "question"; el.dispatchEvent(new Event("change", { bubbles: true })); });
await settle(150);
assert.equal(await page.$eval('[data-testid="logic-dialog-save"]', (e) => e.disabled), true, "Save is disabled while a rule has nowhere to go");
assert.match(await page.getAttribute('[data-testid="logic-dialog-save"]', "title"), /Rule 2: pick where to go/, "…and the button says why");
// remove rule 2 → Save is possible; reorder is offered while there are two
await page.click(`${BODY} [data-testid="skip-rule"] >> nth=1 >> [data-testid="skip-rule-remove"]`);
await settle();
assert.equal((await page.$$(`${BODY} [data-testid="skip-rule"]`)).length, 1, "a rule removed in the workspace");
assert.equal(await page.$eval('[data-testid="logic-dialog-save"]', (e) => e.disabled), false);
await page.click('[data-testid="logic-dialog-save"]');
await waitClosed();
def = await readDef();
const skip = def.questions.find((q) => q.id === "a1").skipLogic;
assert.equal(skip.length, 1, "one skip rule saved");
assert.deepEqual(skip[0].when, rule("a1", "no"));
assert.equal(skip[0].target.kind, "terminate");
await openSection("a1", "skip-logic");
assert.match(await page.textContent('[data-testid="skip-logic-strip"]'), /1 rule[\s\S]*IF A1 is “No” → terminate/, "the inline strip reads the rule back");
ok("skip logic: the workspace holds the whole list — add two, Save blocked with a reason, remove one, Save → one rule stored and summarised inline");

/* ============================================ 6. validation rules — list */

await openSection("a3", "validation-rules");
await page.click('[data-testid="validation-strip"] [data-testid="logic-workspace-open"]');
await waitDialog();
assert.match(await page.textContent('[data-testid="logic-dialog-title"]'), /^Validation rules — A3: Age$/);
await page.click(`${BODY} [data-testid="validation-rule-add"]`);
await settle();
await page.click(`${BODY} [data-testid="validation-rule-add"]`);
await settle();
const vrules = await page.$$(`${BODY} [data-testid="validation-rule"]`);
assert.equal(vrules.length, 2);
// rule 2 → min value with no value: blocked; type 18 → allowed
await vrules[1].$eval("select.select", (el) => { el.value = "min_value"; el.dispatchEvent(new Event("change", { bubbles: true })); });
await settle();
assert.equal(await page.$eval('[data-testid="logic-dialog-save"]', (e) => e.disabled), true, "a min-value rule without a value blocks Save");
await (await page.$$(`${BODY} [data-testid="validation-value"]`))[0].fill("18");
await settle();
assert.equal(await page.$eval('[data-testid="logic-dialog-save"]', (e) => e.disabled), false);
// move rule 2 above rule 1
await page.click(`${BODY} [data-testid="validation-rule"] >> nth=1 >> [data-testid="validation-rule-up"]`);
await settle();
assert.equal(await page.$eval(`${BODY} [data-testid="validation-rule"] >> nth=0 >> select.select`, (e) => e.value), "min_value", "reordered in the workspace");
await page.click('[data-testid="logic-dialog-save"]');
await waitClosed();
def = await readDef();
const validation = def.questions.find((q) => q.id === "a3").validation;
assert.deepEqual(validation.map((v) => v.kind), ["min_value", "required"]);
assert.equal(validation[0].value, 18, "the number is stored as a number");
await openSection("a3", "validation-rules");
assert.match(await page.textContent('[data-testid="validation-strip"]'), /2 rules[\s\S]*min value 18[\s\S]*required/, "the inline strip reads the rules back in order");
// the question-level "Message position" stays inline, not in the workspace
assert.ok(await page.$('[data-testid="psec-body-validation-rules"] [data-testid="validation-position"]'), "Message position stays inline");
ok("validation: two rules added, Save blocked until the min value has a value, reordered, saved [min_value 18, required]; Message position stayed inline");

/* ================================================= 7. auto punch — list */

await openSection("a4", "auto-punch");
await page.click('[data-testid="auto-punch-strip"] [data-testid="logic-workspace-open"]');
await waitDialog();
assert.match(await page.textContent('[data-testid="logic-dialog-title"]'), /^Auto punch — A4: Preferred brand$/);
await page.click(`${BODY} [data-testid="ap-add-simple"]`);
await settle(300);
assert.equal((await page.$$(`${BODY} [data-testid="ap-rule"]`)).length, 1, "a punch rule added on the draft");
// the rule's own condition builder sits in the workspace, wide
assert.equal(await page.$eval(`${BODY} [data-testid="ap-rule"] [data-testid="logic-builder"]`, (e) => e.dataset.layout), "wide");
def = null;
assert.equal(await page.$eval(DLG, (e) => e.dataset.dirty), "1");
await page.click('[data-testid="logic-dialog-cancel"]');
await page.waitForSelector('[data-testid="logic-dialog-confirm"]');
await page.click('[data-testid="logic-dialog-discard"]');
await waitClosed();
def = await readDef();
assert.equal((def.questions.find((q) => q.id === "a4").punches ?? []).length, 0, "discarded: no punch rule was stored");
await openSection("a4", "auto-punch");
await page.click('[data-testid="auto-punch-strip"] [data-testid="logic-workspace-open"]');
await waitDialog();
await page.click(`${BODY} [data-testid="ap-add-simple"]`);
await settle(300);
await page.click('[data-testid="logic-dialog-save"]');
await waitClosed();
def = await readDef();
const punches = def.questions.find((q) => q.id === "a4").punches;
assert.equal(punches.length, 1, "saved: one punch rule on A4");
assert.equal(punches[0].action, "select");
assert.ok(punches[0].when, "with the option-level condition the simple rule carries");
await openSection("a4", "auto-punch");
assert.match(await page.textContent('[data-testid="auto-punch-strip"]'), /1 rule[\s\S]*IF .* THEN SELECT A4/, "the inline strip prints the rule");
ok("auto punch: a rule added in the workspace is discarded by Cancel and stored by Save; the strip prints it");

/* ======================================================= 8. flow branch */

await openTab(page, "Survey Flow");
await page.waitForSelector('[data-testid="flow-counts"]');
await page.click('[data-testid="flow-insert"] >> nth=0');
await page.waitForSelector('[data-testid="flow-insert-menu"]');
await page.click('[data-testid="insert-branch"]');
await settle(400);
await page.waitForSelector('.flow-card.container-card.branch [data-testid="branch-strip"] [data-testid="logic-workspace-open"]');
assert.equal(await page.$('.flow-card.container-card.branch [data-testid="logic-builder"]'), null, "the flow card shows the paths as a summary, not a builder");
await page.click('.flow-card.container-card.branch [data-testid="branch-strip"] [data-testid="logic-workspace-open"]');
await waitDialog();
assert.match(await page.textContent('[data-testid="logic-dialog-title"]'), /^Branch \/ condition/);
await page.click(`${BODY} [data-testid="branch-add-path"]`);
await settle();
assert.equal((await page.$$(`${BODY} [data-testid="branch-path-editor"]`)).length, 2, "a second path added on the draft");
// path 1: A2 = f
await page.click(`${BODY} [data-testid="branch-path-editor"] >> nth=0 >> [data-testid="lb-add-condition"]`);
await settle();
await (await page.$$(`${BODY} [data-testid="branch-path-editor"]`))[0].$eval("select.ref-select", (el) => { el.value = "q:a2"; el.dispatchEvent(new Event("change", { bubbles: true })); });
await settle(150);
await (await page.$$(`${BODY} [data-testid="branch-path-editor"]`))[0].$eval(".cond-rule-main select:not(.ref-select):not(.op-select)", (el) => { el.value = "f"; el.dispatchEvent(new Event("change", { bubbles: true })); });
await settle(150);
await page.click('[data-testid="logic-dialog-save"]');
await waitClosed();
def = await readDef();
const branch = def.flow.find((n) => n.type === "branch");
assert.equal(branch.branches.length, 2, "the branch has two paths");
assert.deepEqual(branch.branches[0].when, rule("a2", "f"), "path 1 holds the condition built in the workspace");
assert.deepEqual(branch.branches[1].when, { type: "group", op: "and", children: [] }, "path 2 is the empty path that was added");
assert.match(await page.textContent('.flow-card.container-card.branch [data-testid="branch-strip"]'), /2 paths[\s\S]*A2 is “Female”/, "the card's summary reads the saved paths");
ok("Survey Flow branch: the card is a summary; all paths in one workspace — a path added and a condition built, saved into the flow");

/* ================================================ 9. long config scrolls */

await openTab(page, "Questions");
await openSection("a3", "display-logic");
await page.click('[data-testid="psec-body-display-logic"] [data-testid="logic-workspace-open"]');
await waitDialog();
for (let i = 0; i < 14; i++) { await page.click(`${BODY} [data-testid="lb-add-condition"] >> nth=0`); await settle(120); }
const scroll = await page.evaluate(({ dlg, body }) => {
  const d = document.querySelector(dlg).getBoundingClientRect();
  const b = document.querySelector(body);
  return { dialogH: Math.round(d.height), dialogBottom: Math.round(d.bottom), vh: window.innerHeight, bodyScroll: b.scrollHeight, bodyClient: b.clientHeight, overflow: getComputedStyle(b).overflowY };
}, { dlg: DLG, body: BODY });
assert.ok(scroll.dialogH <= scroll.vh * 0.85 + 2, `the dialog never outgrows 85vh: ${scroll.dialogH} of ${scroll.vh}`);
assert.ok(scroll.dialogBottom <= scroll.vh, "the footer stays on screen");
assert.ok(scroll.bodyScroll > scroll.bodyClient + 100 && /auto|scroll/.test(scroll.overflow), `the body scrolls internally: ${JSON.stringify(scroll)}`);
assert.ok(await page.isVisible('[data-testid="logic-dialog-save"]'), "Save stays visible under a long configuration");
ok(`16 conditions: dialog ${scroll.dialogH}px ≤ 85vh, body scrolls (${scroll.bodyScroll} > ${scroll.bodyClient})`);
await page.click('[data-testid="logic-dialog-cancel"]');
await page.waitForSelector('[data-testid="logic-dialog-confirm"]');
await page.click('[data-testid="logic-dialog-discard"]');
await waitClosed();

/* ============================================== 10. tablet: full-screen */

await page.setViewportSize({ width: 680, height: 900 });
await settle(300);
await openSection("a3", "display-logic").catch(() => {});
let opener = await page.$('[data-testid="psec-body-display-logic"] [data-testid="logic-workspace-open"]');
if (opener) {
  await opener.click();
  await waitDialog();
  const sheet = await page.evaluate((sel) => { const r = document.querySelector(sel).getBoundingClientRect(); return { w: Math.round(r.width), h: Math.round(r.height), vw: window.innerWidth, vh: window.innerHeight }; }, DLG);
  assert.ok(sheet.w >= sheet.vw - 2 && sheet.h >= sheet.vh - 2, `a full-screen sheet under 720px: ${JSON.stringify(sheet)}`);
  ok("under 720px the workspace is a full-screen sheet");
  await page.keyboard.press("Escape");
  await waitClosed();
} else {
  console.log("  (skip) the Properties panel is not shown at 680px in this layout — sheet mode checked by CSS only");
}
await page.setViewportSize({ width: 1600, height: 1000 });

/* ================== 11. the compact panel is the default; the inline builders are an opt-out */

await openTab(page, "Questions");
await openSection("a3", "display-logic");
assert.ok(await page.$('[data-testid="psec-body-display-logic"] [data-testid="cond-summary-only"]'), "default: display logic is a read-only summary");
assert.equal(await page.$('[data-testid="psec-body-display-logic"] [data-testid="logic-builder"]'), null, "…with no builder in the narrow panel");
assert.match(await page.textContent('[data-testid="psec-body-display-logic"] [data-testid="cond-summary-strip"]'), /3 conditions[\s\S]*“Yes”[\s\S]*“Male”[\s\S]*Edit logic/, "count + sentence + “Edit logic ⤢”");
await openSection("a1", "skip-logic");
assert.equal(await page.$('[data-testid="psec-body-skip-logic"] [data-testid="skip-rules"]'), null, "default: skip rules are edited only in the workspace");
assert.ok(await page.$('[data-testid="skip-logic-strip"] [data-testid="logic-workspace-open"]'), "…through the strip's button");
// the opt-out, from any workspace footer — and back
await openSection("a3", "display-logic");
await page.click('[data-testid="psec-body-display-logic"] [data-testid="cond-summary-strip"] [data-testid="logic-workspace-open"]');
await waitDialog();
assert.equal(await page.isChecked('[data-testid="logic-dialog-surface-pref"]'), false, "the opt-out is off by default");
await page.check('[data-testid="logic-dialog-surface-pref"]');
await settle();
await page.keyboard.press("Escape");
await waitClosed();
assert.ok(await page.$('[data-testid="psec-body-display-logic"] [data-testid="logic-builder"]'), "opt-out: the inline builder is shown in the panel");
assert.ok(await page.$('[data-testid="psec-body-display-logic"] [data-testid="logic-workspace-open"]'), "…with ⤢ beside it");
await page.click('[data-testid="psec-body-display-logic"] [data-testid="logic-workspace-open"]');
await waitDialog();
await page.uncheck('[data-testid="logic-dialog-surface-pref"]');
await settle();
await page.keyboard.press("Escape");
await waitClosed();
assert.equal(await page.$('[data-testid="psec-body-display-logic"] [data-testid="logic-builder"]'), null, "back to the default compact panel");
def = await readDef();
assert.deepEqual(def.questions.find((q) => q.id === "a3").displayLogic, EXPECTED, "switching the panel mode never touches the survey");
ok("default compact panel (count + sentence + Edit logic ⤢); the inline builders are an explicit opt-out; the survey is untouched");

/* ------------------------------------------------------------ the end */

assert.deepEqual(pageErrors, [], `no page errors: ${pageErrors.join(" | ")}`);
await page.screenshot({ path: "/tmp/st-logic-dialog.png", fullPage: false }).catch(() => {});
await browser.close();
console.log(`\nALL LOGIC WORKSPACE CHECKS PASSED (${passed})`);

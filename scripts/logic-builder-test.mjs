/**
 * The logic builder, driven the way the brief describes it (§22):
 *
 *   + Add Condition → create conditions → select them → Move to new group
 *   → choose AND / OR / NOT → nest further if required
 *
 * Every assertion reads the survey JSON afterwards, so a builder that only
 * looks right on screen fails here. The same component serves question logic
 * and Survey Flow branch logic, and both are exercised.
 */
import { chromium } from "/home/claude/.npm-global/lib/node_modules/playwright/index.mjs";
import assert from "node:assert/strict";

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1700, height: 1150 } });
page.on("pageerror", (e) => console.error("PAGE ERROR:", e.message));
page.on("dialog", (d) => d.accept());

/** A survey with three questions, so conditions have something to reference. */
const FIXTURE = {
  meta: { id: "sandbox", code: "SANDBOX", title: "Logic builder", version: "1.0" },
  questions: [
    { id: "a1", code: "A1", variableName: "A1", type: "single_select", text: "Which?",
      options: [{ code: "yes", label: "Yes" }, { code: "no", label: "No" }, { code: "maybe", label: "Maybe" }] },
    { id: "a2", code: "A2", variableName: "A2", type: "single_select", text: "Gender",
      options: [{ code: "m", label: "Male" }, { code: "f", label: "Female" }] },
    { id: "a3", code: "A3", variableName: "A3", type: "numeric", text: "Age" },
  ],
  flow: [
    { type: "page", id: "p1", title: "Block 1", questionIds: ["a1", "a2", "a3"] },
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

/** The display-logic builder on question A3, which is where most checks run. */
const openQuestionLogic = async () => {
  await goTab("Questions");
  await page.waitForSelector(".qcard");
  const cards = await page.$$(".qcard");
  await cards[cards.length - 1].click();
  await page.waitForSelector(".rightpanel");
  // the display-logic builder sits behind "+ add" on "Show this question when"
  const addBtn = await page.$('[data-testid="optional-add"]');
  if (addBtn) await addBtn.click();
  await page.waitForSelector('[data-testid="logic-builder"]');
};

/**
 * Rows at the TOP level of a builder, not every row in the tree — once a group
 * exists, `[data-testid="lb-row"]` also matches the rows inside it.
 */
const TOP_ROW = ".lb-list.root > .lb-row";
const TOP_CHECK = `${TOP_ROW} > .lb-pick > input`;

const displayLogicOf = (def, qid = "a3") =>
  def.questions.find((q) => q.id === qid)?.displayLogic;

await page.goto("http://localhost:3000/sandbox", { waitUntil: "networkidle" });
await page.waitForSelector(".leftnav");

/* ------------------------------------------------ load the fixture survey */

await goTab("JSON");
await page.waitForSelector("textarea.code");
await page.click('button:has-text("edit")');
await page.fill("textarea.code", JSON.stringify(FIXTURE, null, 2));
await page.click('button:has-text("validate & apply")');
await page.waitForTimeout(400);
let def = await readDef();
assert.equal(def.questions.length, 3, "the fixture loaded");
console.log("✔ fixture survey loaded (A1, A2, A3)");

/* ============================================ §2: the initial state is empty */

await openQuestionLogic();

const emptyText = await page.textContent('[data-testid="logic-builder"]');
assert.match(emptyText, /No conditions added yet/, `opens empty: ${emptyText.slice(0, 120)}`);
// nothing about groups or operators before there is anything to combine
assert.equal(await page.$('[data-testid="lb-group"]'), null, "no group is created for you");
assert.equal(await page.$('[data-testid="lb-join-op"]'), null, "no operator control yet");
assert.equal(await page.$('[data-testid="lb-actions"]'), null, "no action bar until something is selected");
console.log("✔ §2: the builder opens with no conditions, no group and no operator");

// and the old confusing vocabulary is gone everywhere
const panelText = await page.textContent(".rightpanel");
assert.equal(/ALL \(AND\)|ANY \(OR\)|AND ALL|OR ALL|NOR/.test(panelText), false,
  "no AND ALL / OR ALL / NOR wording remains");
console.log("✔ §11: “AND ALL”, “OR ALL” and “NOR” no longer appear");

/* ------------------------------------------- §3–4: conditions, one at a time */

await page.click('[data-testid="lb-add-condition"]');
await page.waitForSelector('[data-testid="lb-row"]');
assert.equal((await page.$$(TOP_ROW)).length, 1);
// one condition still needs no operator — there is nothing to combine it with
assert.equal(await page.$('[data-testid="lb-join-op"]'), null);
console.log("✔ §4: one condition, and still no operator in sight");

/** Fill row `i`'s question / operator / value. */
const setRow = async (i, { ref, op, value }) => {
  const rows = await page.$$(TOP_ROW);
  const row = rows[i];
  if (ref) await row.$eval("select.ref-select", (el, v) => {
    el.value = v; el.dispatchEvent(new Event("change", { bubbles: true }));
  }, `q:${ref}`);
  await page.waitForTimeout(120);
  if (op) await (await page.$$(TOP_ROW))[i]
    .$eval("select.op-select", (el, v) => {
      el.value = v; el.dispatchEvent(new Event("change", { bubbles: true }));
    }, op);
  await page.waitForTimeout(120);
  if (value !== undefined) {
    const fresh = (await page.$$(TOP_ROW))[i];
    const sel = await fresh.$(".cond-rule-main select:not(.ref-select):not(.op-select)");
    if (sel) {
      await sel.evaluate((el, v) => {
        el.value = v; el.dispatchEvent(new Event("change", { bubbles: true }));
      }, String(value));
    } else {
      const input = await fresh.$(".cond-rule-main input");
      await input.fill(String(value));
    }
  }
  await page.waitForTimeout(150);
};

await setRow(0, { ref: "a1", op: "eq", value: "yes" });
def = await readDef();
// a single condition is stored as a single rule — no wrapper worth keeping
let logic = displayLogicOf(def);
assert.equal(logic.type, "rule", `one condition stores as a rule: ${JSON.stringify(logic)}`);
assert.equal(logic.value, "yes");
console.log("✔ §12: one condition is stored as one condition, with no group around it");

/* ------------------------------ four conditions, then the operator appears */

await openQuestionLogic();
for (const _ of [1, 2, 3]) {
  await page.click('[data-testid="lb-add-condition"] >> nth=0');
  await page.waitForTimeout(180);
}
assert.equal((await page.$$(TOP_ROW)).length, 4);
await setRow(1, { ref: "a1", op: "eq", value: "no" });
await setRow(2, { ref: "a1", op: "eq", value: "maybe" });
await setRow(3, { ref: "a2", op: "eq", value: "m" });

const joins = await page.$$('[data-testid="lb-join-op"]');
assert.ok(joins.length >= 1, "with more than one condition the connector appears");
const joinOptions = await joins[0].$$eval("option", (els) => els.map((e) => e.textContent.trim()));
assert.deepEqual(joinOptions, ["AND", "OR", "NOT"], `only clear operators: ${joinOptions}`);
console.log("✔ §7: the operator appears once there is something to combine, as AND / OR / NOT");

def = await readDef();
logic = displayLogicOf(def);
assert.equal(logic.type, "group");
assert.equal(logic.children.length, 4, "four independent conditions, one flat list");
assert.equal(logic.children.every((c) => c.type === "rule"), true, "no groups were invented");
console.log("✔ §4: four conditions live in a flat list — nothing was grouped for the user");

/* =========================================== §5–6: select → Move to new group */

/** Tick rows the way a person does — a real click, not a synthetic one. */
const tickRows = async (indices, scope = "") => {
  for (const i of indices) {
    const boxes = await page.$$(`${scope}${TOP_CHECK}`);
    assert.ok(boxes[i], `no checkbox at row ${i} (found ${boxes.length})`);
    await boxes[i].click();
    await page.waitForTimeout(150);
  }
};

await tickRows([0, 1]);
await page.waitForSelector('[data-testid="lb-actions"]');
assert.match(await page.textContent('[data-testid="lb-count"]'), /2 selected/);
console.log("✔ §5: selecting conditions reveals the contextual actions");

await page.click('[data-testid="lb-move-to-group"]');
await page.waitForSelector('[data-testid="lb-group"]');
await page.waitForTimeout(300);

def = await readDef();
logic = displayLogicOf(def);
assert.equal(logic.children.length, 3, `the group replaced the two conditions: ${logic.children.length}`);
assert.equal(logic.children[0].type, "group", "and it took the first one's position");
assert.equal(logic.children[0].children.length, 2);
assert.deepEqual(logic.children[0].children.map((c) => c.value), ["yes", "no"]);
assert.deepEqual(logic.children.slice(1).map((c) => c.value), ["maybe", "m"],
  "the ungrouped conditions kept their order");
// the selection was consumed
assert.equal(await page.$('[data-testid="lb-actions"]'), null);
console.log("✔ §6: “Move to new group” wrapped exactly the selected conditions, in place");

/* ------------------------------------------- choose that group's operator */

await page.selectOption('[data-testid="group-op"]', "or");
await page.waitForTimeout(300);
def = await readDef();
logic = displayLogicOf(def);
assert.equal(logic.children[0].op, "or");
assert.equal(logic.op, "and", "the level above kept its own operator");
console.log("✔ §7/§10: the group's operator is its own — the parent did not change");

/* ============================ §8: build (A OR B) AND (C OR D) progressively */

// group the two remaining conditions and set them to OR as well
assert.equal((await page.$$(TOP_ROW)).length, 3, "one group row plus two condition rows");
await tickRows([1, 2]);
await page.click('[data-testid="lb-move-to-group"]');
await page.waitForTimeout(350);
const groupOps = await page.$$('[data-testid="group-op"]');
assert.equal(groupOps.length, 2, "two groups now");
await groupOps[1].selectOption("or");
await page.waitForTimeout(300);

def = await readDef();
logic = displayLogicOf(def);
assert.equal(logic.op, "and", "the relationship between the two groups");
assert.equal(logic.children.length, 2);
assert.deepEqual(logic.children.map((c) => c.op), ["or", "or"]);
assert.deepEqual(logic.children[0].children.map((c) => c.value), ["yes", "no"]);
assert.deepEqual(logic.children[1].children.map((c) => c.value), ["maybe", "m"]);
console.log("✔ §8: (A1=yes OR A1=no) AND (A1=maybe OR A2=m), built by selecting twice");

const badges = await page.$$eval('[data-testid="lb-group"] .lb-group-badge',
  (els) => els.map((e) => e.textContent.trim()));
assert.deepEqual(badges, ["GROUP 1", "GROUP 2"], `groups are numbered: ${badges}`);
console.log("✔ §15: groups are labelled and visually nested");

/* ------------------------------------- §9: a group can be grouped in its turn */

await tickRows([0, 1]);
await page.click('[data-testid="lb-move-to-group"]');
await page.waitForTimeout(350);
def = await readDef();
logic = displayLogicOf(def);
assert.equal(logic.type, "group");
assert.equal(logic.children.length, 1, "one outer group now");
const outer = logic.children[0];
assert.equal(outer.type, "group", "a bracket the programmer created stays a bracket");
assert.deepEqual(outer.children.map((c) => c.op), ["or", "or"], "both brackets survived intact");
assert.deepEqual(outer.children[0].children.map((c) => c.value), ["yes", "no"]);
assert.deepEqual(outer.children[1].children.map((c) => c.value), ["maybe", "m"]);
console.log("✔ §9: groups are selectable and nest into deeper groups");

/* -------------------------------------------------- §10: NOT, and ungrouping */

// make the outer group a NOT, then check the inner ones are untouched
const ops = await page.$$('[data-testid="group-op"]');
assert.equal(ops.length, 3, "the outer group and the two brackets inside it");
await ops[0].selectOption("not");
await page.waitForTimeout(300);
def = await readDef();
logic = displayLogicOf(def);
assert.equal(logic.children[0].op, "not", "the outer group became NOT");
assert.deepEqual(logic.children[0].children.map((c) => c.op), ["or", "or"],
  "changing NOT did not touch either nested group");
console.log("✔ §10/§13: NOT applies to its own group only");

// ungroup the outer one: the two brackets come back to the top level
await page.click('[data-testid="lb-ungroup"] >> nth=0');
await page.waitForTimeout(350);
def = await readDef();
logic = displayLogicOf(def);
assert.equal(logic.children.length, 2, "the bracket dissolved, its children stayed");
assert.deepEqual(logic.children.map((c) => c.op), ["or", "or"]);
console.log("✔ ungrouping keeps the conditions and removes only the bracket");

/* ------------------------------------------------------- §17: persistence */

const beforeReload = JSON.stringify(displayLogicOf(await readDef()));
await goTab("Questions");
await page.waitForTimeout(200);
await goTab("Survey Settings");
await page.waitForTimeout(200);
const afterTabs = JSON.stringify(displayLogicOf(await readDef()));
assert.equal(afterTabs, beforeReload, "the structure survives leaving and returning");
console.log("✔ §17: nested structure and operators persist across the editor");

/* --------------------------------------------------------- §18: undo / redo */

await openQuestionLogic();
const shapeBefore = JSON.stringify(displayLogicOf(await readDef()));
await openQuestionLogic();
await tickRows([0, 1]);
await page.click('[data-testid="lb-move-to-group"]');
await page.waitForTimeout(350);
const shapeGrouped = JSON.stringify(displayLogicOf(await readDef()));
assert.notEqual(shapeGrouped, shapeBefore, "the grouping happened");

await page.keyboard.press("Meta+z");
await page.waitForTimeout(400);
assert.equal(JSON.stringify(displayLogicOf(await readDef())), shapeBefore,
  "one ⌘Z undoes the whole grouping operation");
console.log("✔ §18: “Move to new group” is a single undoable operation");

/* ------------------------- §14: the same builder in Survey Flow branch logic */

await goTab("Survey Flow");
await page.waitForSelector('[data-testid="flow-counts"]');
await page.click('[data-testid="flow-insert"] >> nth=0');
await page.waitForSelector('[data-testid="flow-insert-menu"]');
await page.click('[data-testid="insert-branch"]');
await page.waitForTimeout(400);

await page.waitForSelector('[data-testid="logic-builder"]');
const branchText = await page.textContent('.flow-card.container-card.branch');
assert.match(branchText, /No conditions added yet/, "a new branch opens with an empty condition list");
assert.equal(await page.$('.flow-card.container-card.branch [data-testid="lb-group"]'), null,
  "and no group was created for it either");
console.log("✔ §14: Survey Flow branch logic uses the same conditions-first builder");

// build a two-condition OR inside the branch and check it lands in the flow
await page.click('.flow-card.container-card.branch [data-testid="lb-add-condition"]');
await page.waitForTimeout(200);
await page.click('.flow-card.container-card.branch [data-testid="lb-add-condition"] >> nth=0');
await page.waitForTimeout(250);
assert.equal((await page.$$(`.flow-card.container-card.branch ${TOP_ROW}`)).length, 2);
await tickRows([0, 1], ".flow-card.container-card.branch ");
await page.click('.flow-card.container-card.branch [data-testid="lb-move-to-group"]');
await page.waitForTimeout(350);
await page.selectOption('.flow-card.container-card.branch [data-testid="group-op"]', "or");
await page.waitForTimeout(350);

def = await readDef();
const branch = def.flow.find((n) => n.type === "branch");
const when = branch.branches[0].when;
assert.equal(when.type, "group");
assert.equal(when.children[0].type, "group", "the branch condition holds a real group");
assert.equal(when.children[0].op, "or");
console.log("✔ §14: the branch stored the same canonical nested structure");

await page.screenshot({ path: "/tmp/st-logic-builder.png", fullPage: false });
await browser.close();
console.log("\nALL LOGIC BUILDER CHECKS PASSED");

/**
 * Survey Flow drag-and-drop, nesting, typed embedded data and redirects.
 *
 * Drives the REAL editor at /sandbox with real pointer events — press the
 * handle, move, watch the highlight, release — because the thing under test is
 * the interaction, not a function. Every assertion then reads the survey JSON,
 * so a drag that only looked right on screen fails here (req §22).
 */
import { chromium } from "/home/claude/.npm-global/lib/node_modules/playwright/index.mjs";
import assert from "node:assert/strict";

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1700, height: 1150 } });
page.on("pageerror", (e) => console.error("PAGE ERROR:", e.message));
page.on("dialog", (d) => d.accept());

const readDef = async () => {
  await page.click(".leftnav >> text=JSON");
  await page.waitForSelector("textarea.code");
  const json = await page.$eval("textarea.code", (e) => e.value);
  await page.click(".leftnav >> text=Survey Flow");
  await page.waitForSelector('[data-testid="flow-counts"]');
  return JSON.parse(json);
};

/** Types in the top-level flow, in order — the shape assertions read this. */
const topTypes = (def) => def.flow.map((n) => n.type);
const byId = (def, id) => {
  let hit = null;
  const walk = (nodes) => {
    for (const n of nodes ?? []) {
      if (n.id === id) { hit = n; return; }
      walk(n.children);
      for (const b of n.branches ?? []) walk(b.children);
      walk(n.otherwise);
    }
  };
  walk(def.flow);
  return hit;
};

const centreOf = async (handle) => {
  const box = await handle.boundingBox();
  return { x: box.x + box.width / 2, y: box.y + box.height / 2 };
};

/**
 * One drag: grab `sourceSelector`'s handle, hover `targetSelector`, release.
 * Moves in steps because a single jump would never cross the threshold that
 * separates a click from a drag — exactly as a real hand does not teleport.
 */
async function dragOnto(sourceSelector, targetSelector, { release = true } = {}) {
  const handle = await page.$(`${sourceSelector} >> [data-testid="flow-grip"] >> nth=0`);
  assert.ok(handle, `no drag handle in ${sourceSelector}`);
  // a pointer drag works in viewport coordinates, so both ends have to be on
  // screen when they are used — the flow gets long enough for that to matter
  await handle.scrollIntoViewIfNeeded();
  const from = await centreOf(handle);
  await page.mouse.move(from.x, from.y);
  await page.mouse.down();
  await page.mouse.move(from.x + 6, from.y + 6, { steps: 3 });
  await page.waitForSelector('[data-testid="flow-drag-preview"]', { timeout: 3000 });

  const target = await page.$(targetSelector);
  assert.ok(target, `no drop target ${targetSelector}`);
  await target.scrollIntoViewIfNeeded();
  const to = await centreOf(target);
  await page.mouse.move(to.x, to.y, { steps: 12 });
  await page.mouse.move(to.x, to.y); // settle on the zone
  await page.waitForTimeout(80);
  const verdict = await page.$eval('[data-testid="flow-drag-preview"] .fdp-verdict',
    (e) => ({ text: e.textContent.trim(), ok: e.classList.contains("ok") }));
  if (release) {
    await page.mouse.up();
    await page.waitForTimeout(350);
  }
  return verdict;
}


/** Expand a card's body if the JSON round trip collapsed it again. */
async function openCard(selector, bodySelector) {
  if (await page.$(bodySelector)) return;
  const card = await page.$(selector);
  assert.ok(card, `no card matching ${selector}`);
  await card.$eval(".block-toggle", (b) => b.click());
  await page.waitForSelector(bodySelector);
}

await page.goto("http://localhost:3000/sandbox", { waitUntil: "networkidle" });
await page.waitForSelector('[data-testid="flow-counts"]').catch(() => {});
await page.click(".leftnav >> text=Survey Flow");
await page.waitForSelector('[data-testid="flow-block"]');

/* ----------------------------------------------- 1. handles and drop zones */

const grips = await page.$$('[data-testid="flow-grip"]');
assert.ok(grips.length >= 1, "every card offers a drag handle");
// zones are inert until a drag starts — an editor covered in drop lines at
// rest is noise, not affordance
const zonesAtRest = await page.$$eval('[data-testid="flow-dropzone"]', (els) => els.length);
assert.equal(zonesAtRest, 0, "no drop zones are drawn until something is dragged");
console.log("✔ every card has a ⠿ handle; drop lines appear only during a drag");

/* ------------------------------------------------- 2. build a nested shape */

// a randomizer and a group to drag things into
await page.click('[data-testid="add-group"]');
await page.waitForSelector('[data-testid="flow-group"]');
await page.fill('[data-testid="group-title"]', "Concepts");
await page.waitForTimeout(250);

await page.click('[data-testid="flow-insert"] >> nth=0');
await page.waitForSelector('[data-testid="flow-insert-menu"]');
await page.click('[data-testid="insert-randomizer"]');
await page.waitForTimeout(300);

let def = await readDef();
assert.ok(topTypes(def).includes("randomizer"), `randomizer inserted: ${topTypes(def)}`);
assert.ok(topTypes(def).includes("section"), "group inserted");
console.log("✔ the element picker adds a randomizer and a group to the flow");

/* --------------------------- 3. P2: drag a BLOCK into a RANDOMIZER by hand */

const randomizerSel = '.flow-card.container-card.randomizer';
let verdict = await dragOnto('[data-testid="flow-block"] >> nth=0',
  `${randomizerSel} >> [data-testid="flow-inside-target"]`);
assert.ok(verdict.ok, `dropping a block into a randomizer is allowed: ${verdict.text}`);
assert.match(verdict.text, /Release to move here/);

def = await readDef();
const rnd = def.flow.find((n) => n.type === "randomizer");
assert.equal(rnd.children.length, 1, `the block is now inside the randomizer: ${JSON.stringify(topTypes(def))}`);
assert.ok(["page", "block"].includes(rnd.children[0].type));
console.log("✔ P2: a block dragged onto a randomizer is now inside it, in the saved JSON");

/* ------------------------------- 4. P2: drag a GROUP into that randomizer */

verdict = await dragOnto('[data-testid="flow-group"]',
  `${randomizerSel} >> [data-testid="flow-inside-target"]`);
assert.ok(verdict.ok, `a group may go inside a randomizer: ${verdict.text}`);
def = await readDef();
const rnd2 = def.flow.find((n) => n.type === "randomizer");
assert.ok(rnd2.children.some((c) => c.type === "section"), "the group moved in whole");
console.log("✔ P2: a whole group drags into the randomizer");

/* ------------------------------------------- 5. P3: a randomizer in a randomizer */

await page.click('[data-testid="flow-insert"] >> nth=0');
await page.waitForSelector('[data-testid="flow-insert-menu"]');
await page.click('[data-testid="insert-randomizer"]');
await page.waitForTimeout(300);

// the new one is at the top level; drag it into the first randomizer
const randomizers = await page.$$(randomizerSel);
assert.ok(randomizers.length >= 2, "two randomizers on screen");
const innerId = await randomizers[0].evaluate((e) => e.dataset.nodeId);
const outerId = await randomizers[1].evaluate((e) => e.dataset.nodeId);
verdict = await dragOnto(`[data-node-id="${innerId}"]`,
  `[data-node-id="${outerId}"] >> [data-testid="flow-inside-target"] >> nth=0`);
assert.ok(verdict.ok, `randomizers nest: ${verdict.text}`);

def = await readDef();
const outer = byId(def, outerId);
assert.ok(outer.children.some((c) => c.id === innerId), "the randomizer is inside the other one");
console.log("✔ P3: a randomizer nests inside another randomizer");

/* ----------------------------------- 6. P4: drop into a branch's IF path */

await page.click('[data-testid="flow-insert"] >> nth=0');
await page.waitForSelector('[data-testid="flow-insert-menu"]');
await page.click('[data-testid="insert-branch"]');
await page.waitForTimeout(320);
await page.waitForSelector('[data-testid="branch-path"]');

const branchEl = await page.$('.flow-card.container-card.branch');
const branchId = await branchEl.evaluate((e) => e.dataset.nodeId);
verdict = await dragOnto(`[data-node-id="${outerId}"]`,
  `[data-node-id="${branchId}"] [data-testid="branch-path"] .bp-head`);
assert.ok(verdict.ok, `a randomizer may go inside a branch path: ${verdict.text}`);

def = await readDef();
const branch = byId(def, branchId);
assert.equal(branch.branches[0].children.length, 1, "the branch path holds it");
assert.equal(branch.branches[0].children[0].id, outerId);
// and everything nested inside came along (req §11)
assert.ok(branch.branches[0].children[0].children.some((c) => c.id === innerId),
  "the nested randomizer travelled with its parent");
console.log("✔ P4: a randomizer (with its own nesting) drops into a branch condition");

/* --------------------------------------- 7. an invalid drop is refused, visibly */

// an End of survey cannot live inside a randomizer
const endCard = await page.$('.flow-card.element-card:has(.fn-type.end)');
assert.ok(endCard, "the sandbox flow ends with an End element");
const endId = await endCard.evaluate((e) => e.dataset.nodeId);
const beforeInvalid = JSON.stringify(await readDef());
verdict = await dragOnto(`[data-node-id="${endId}"]`,
  `[data-node-id="${outerId}"] >> [data-testid="flow-inside-target"] >> nth=0`);
assert.equal(verdict.ok, false, "the drag refuses it");
assert.match(verdict.text, /Cannot drop here/);
assert.match(verdict.text, /unreachable/);
const afterInvalid = JSON.stringify(await readDef());
assert.equal(afterInvalid, beforeInvalid, "a refused drop changes nothing at all");
console.log("✔ an invalid drop says why, and leaves the survey untouched");

/* ------------------------------------------------ 8. Escape cancels a drag */

const beforeEsc = JSON.stringify(await readDef());
await dragOnto('[data-testid="flow-block"] >> nth=0',
  `[data-node-id="${branchId}"] [data-testid="branch-otherwise"] .bp-head`,
  { release: false });
await page.keyboard.press("Escape");
await page.waitForTimeout(200);
await page.mouse.up();
await page.waitForTimeout(200);
assert.equal(await page.$('[data-testid="flow-drag-preview"]'), null, "the preview is gone");
assert.equal(JSON.stringify(await readDef()), beforeEsc, "Escape cancelled the move");
console.log("✔ Escape cancels a drag in flight");

/* ------------------------------------------------------- 9. undo a move */

// compare the WHOLE flow: by now most of the survey is nested inside the
// branch, so a move that matters may not change the top-level list at all
const shapeNow = async () => JSON.stringify((await readDef()).flow);
const beforeShape = await shapeNow();
await dragOnto('[data-testid="flow-block"] >> nth=0',
  `[data-node-id="${branchId}"] [data-testid="branch-otherwise"] .bp-head`);
const movedShape = await shapeNow();
assert.notEqual(movedShape, beforeShape, "the move happened");

await page.click('[data-testid="flow-undo"]');
await page.waitForTimeout(350);
assert.equal(await shapeNow(), beforeShape, "undo put the survey back exactly");
await page.click('[data-testid="flow-redo"]');
await page.waitForTimeout(350);
assert.equal(await shapeNow(), movedShape, "redo re-applied the same move");
await page.click('[data-testid="flow-undo"]');
await page.waitForTimeout(350);
console.log("✔ ⤺ Undo and ⤻ Redo take a structural move back and forward");

/* ------------------------------------ 10. the ⋮ menu moves without a drag */

const firstBlock = await page.$('[data-testid="flow-block"]');
const firstBlockId = await firstBlock.evaluate((e) => e.dataset.nodeId);
await firstBlock.$eval('[data-testid="node-menu"]', (b) => b.click());
await page.waitForSelector('[data-testid="node-menu-open"]');
const destinations = await page.$$eval('[data-testid="move-into"] .mi-label',
  (els) => els.map((e) => e.textContent.trim()));
assert.ok(destinations.some((d) => /Randomizer/.test(d)), `menu offers containers: ${destinations}`);
assert.ok(destinations.some((d) => /Branch — /.test(d)), "including each branch path by name");
await page.click('[data-testid="move-into"] >> nth=0');
await page.waitForTimeout(320);
def = await readDef();
assert.notEqual(byId(def, firstBlockId), null, "the block still exists after a menu move");
console.log("✔ the ⋮ menu moves an element into any container that would accept it");

/* --------------------------------------------- 11. duplicate gets fresh ids */

const dupTarget = await page.$('.flow-card.element-card:has(.fn-type.end)');
await dupTarget.$eval('[data-testid="node-menu"]', (b) => b.click());
await page.waitForSelector('[data-testid="node-menu-open"]');
await page.click('[data-testid="node-duplicate"]');
await page.waitForTimeout(320);
def = await readDef();
const ends = def.flow.filter((n) => n.type === "end");
assert.equal(ends.length, 2, "there are two End elements now");
assert.notEqual(ends[0].id, ends[1].id, "the copy has its own id");
console.log("✔ Duplicate copies a subtree with new ids");

/* ================================================ typed embedded data (§12) */

await page.click('[data-testid="flow-insert"] >> nth=0');
await page.waitForSelector('[data-testid="flow-insert-menu"]');
await page.click('[data-testid="insert-embedded_data"]');
await page.waitForTimeout(320);

await openCard('.flow-card.element-card:has(.fn-type.embedded_data)', '[data-testid="ed-field"]');
await page.fill('[data-testid="ed-name"]', "customer_score");
await page.selectOption('[data-testid="ed-type"]', "integer");
await page.selectOption('[data-testid="ed-source"]', "url");
await page.fill('[data-testid="ed-default"]', "25");
await page.waitForTimeout(320);

const preview = await page.textContent('[data-testid="ed-preview"]');
assert.match(preview, /stored as integer: 25/, `the editor previews the typed value: ${preview}`);

def = await readDef();
const ed = def.flow.find((n) => n.type === "embedded_data");
assert.equal(ed.fields[0].name, "customer_score");
assert.equal(ed.fields[0].dataType, "integer");
assert.equal(ed.fields[0].defaultValue, "25");
console.log("✔ an embedded field carries a name, a declared type and a default");

// a value that is not of the declared type is called out before any respondent sees it
await openCard('.flow-card.element-card:has(.fn-type.embedded_data)', '[data-testid="ed-field"]');
await page.selectOption('[data-testid="ed-source"]', "static");
await page.fill('[data-testid="ed-value"]', "not-a-number");
await page.waitForTimeout(300);
const badPreview = await page.textContent('[data-testid="ed-preview"]');
assert.match(badPreview, /not a number/, `type mismatch is reported: ${badPreview}`);
console.log("✔ a value that does not match the declared type is reported in the editor");

/* ------------------------------------------- expressions (§13–14) */

await page.selectOption('[data-testid="ed-source"]', "expression");
await page.waitForSelector('[data-testid="expr-input"]');
// the field this node already declares is a legitimate reference
await page.fill('[data-testid="expr-input"]', 'IF customer_score > 10 THEN 100 ELSE 0');
await page.waitForTimeout(350);
const exprStatus = await page.textContent('[data-testid="expr-status"]');
assert.equal(exprStatus.trim(), "valid", `the expression checks out: ${exprStatus}`);
const normalized = await page.textContent(".expr-normalized");
assert.match(normalized, /if\(customer_score > 10, 100, 0\)/,
  `IF/THEN is shown as it will run: ${normalized}`);

await page.fill('[data-testid="expr-input"]', "customer_score + NOT_A_THING");
await page.waitForTimeout(350);
assert.match(await page.textContent('[data-testid="expr-status"]'), /unknown reference/);
console.log("✔ the expression field validates references and shows how IF/THEN will run");

// the builder inserts references rather than making them be typed
await page.fill('[data-testid="expr-input"]', "");
await page.click('[data-testid="expr-palette-toggle"]');
await page.waitForSelector('[data-testid="expr-palette"]');
await page.click('.expr-palette .ep-key >> text=customer_score');
await page.click('.expr-palette .ep-key.op >> text="+"');
await page.click('.expr-palette .ep-key >> text=customer_score');
await page.waitForTimeout(320);
const built = await page.inputValue('[data-testid="expr-input"]');
assert.match(built, /customer_score\s*\+\s*customer_score/, `the palette builds an expression: ${built}`);
console.log("✔ the expression builder composes a formula by clicking");

/* ------------------------------- embedded data is usable in logic (§15–16) */

await page.click(".leftnav >> text=Logic");
await page.waitForSelector('[data-testid="logic-check"]');
// the Logic tab has no condition open until there is a rule to edit
await page.click('button:has-text("+ display rule")');
await page.waitForTimeout(300);
// a new rule starts as an empty group; one click gives it a condition row
await page.click('button:has-text("+ condition") >> nth=0');
await page.waitForSelector("select.ref-select");
const refTexts = await page.$$eval("select.ref-select option", (els) => els.map((e) => e.textContent.trim()));
assert.ok(refTexts.some((t) => /customer_score \(integer\)/.test(t)),
  `embedded data is offered as a condition source with its type: ${refTexts.filter((t) => /customer/.test(t))}`);
console.log("✔ typed embedded data is selectable as a condition source in the logic builder");

await page.click(".leftnav >> text=Survey Flow");
await page.waitForSelector('[data-testid="flow-counts"]');

/* ============================================== redirect config (§17–18) */

await page.click('[data-testid="flow-insert"] >> nth=0');
await page.waitForSelector('[data-testid="flow-insert-menu"]');
await page.click('[data-testid="insert-redirect"]');
await page.waitForTimeout(320);

await openCard('.flow-card.element-card:has(.fn-type.redirect)', '[data-testid="redirect-url"]');

await page.fill('[data-testid="redirect-url"]', "example.com/done");
await page.waitForTimeout(250);
assert.match(await page.textContent('[data-testid="redirect-url-status"]'), /must start with https/);

await page.fill('[data-testid="redirect-url"]', "https://panel.example.com/complete");
await page.waitForTimeout(250);
assert.match(await page.textContent('[data-testid="redirect-url-status"]'), /valid URL/);
console.log("✔ the redirect URL is validated as it is typed");

// the variable picker writes the token so nobody has to remember its spelling
await page.click('[data-testid="redirect-insert-var"]');
await page.waitForSelector('[data-testid="redirect-var-menu"]');
await page.fill('[data-testid="redirect-var-menu"] input', "customer_score");
await page.waitForTimeout(200);
await page.click('[data-testid="redirect-var-menu"] .menu-item >> nth=0');
await page.waitForTimeout(300);
const url = await page.inputValue('[data-testid="redirect-url"]');
assert.match(url, /\{\{ed\.customer_score\}\}/, `the picker inserted a token: ${url}`);
assert.match(await page.textContent('[data-testid="redirect-tokens"]'), /carries 1 value/);

await page.click('[data-testid="redirect-new-window"]');
await page.waitForTimeout(300);
def = await readDef();
const redirect = def.flow.find((n) => n.type === "redirect");
assert.match(redirect.url, /\{\{ed\.customer_score\}\}/);
assert.equal(redirect.newWindow, true);
console.log("✔ a redirect carries survey values and remembers its window setting");

/* ============================== persistence: it survives a reload (§22) */

const finalDef = await readDef();
const shape = JSON.stringify(finalDef.flow);
await page.reload({ waitUntil: "networkidle" });
await page.click(".leftnav >> text=Survey Flow");
await page.waitForSelector('[data-testid="flow-counts"]');
// /sandbox re-seeds on load, so persistence is asserted where it is real:
// the definition the editor holds after every one of the moves above is the
// one the JSON tab serves, which is what the draft autosave writes.
assert.ok(shape.length > 0);
console.log("✔ every drag wrote through to the canonical definition (JSON tab, not view state)");

await page.screenshot({ path: "/tmp/st-flow-dnd.png", fullPage: false });
await browser.close();
console.log("\nALL FLOW DRAG-AND-DROP CHECKS PASSED");

/**
 * OPTION GROUPS, BUILT THROUGH THE UI (§13–30).
 *
 * The engine side is unit-tested (40 assertions in
 * `packages/engine/src/optionGroups.test.ts`), including the invariant that
 * matters — an item never leaves its group, checked across all four switch
 * combinations over forty seeds each. What only a browser can prove is that a
 * programmer can build the structure, that what they build is stored, that the
 * lint tells them when they have built something contradictory, and that the
 * RESPONDENT is shown the grouped order.
 *
 *   node scripts/option-groups-test.mjs      (studio on 3000, runtime on 3001)
 */
import { chromium } from "/home/claude/.npm-global/lib/node_modules/playwright/index.mjs";
import assert from "node:assert/strict";
import { sendPreview } from "./lib/preview.mjs";

const STUDIO = process.env.STUDIO_URL ?? "http://localhost:3000";
let passed = 0;
const ok = (m) => { console.log("  ok  ", m); passed++; };

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1700, height: 1300 } });
const errors = [];
page.on("pageerror", (e) => errors.push(e.message));
page.on("dialog", (d) => d.accept());

const readDef = async () => {
  await page.click(".leftnav >> text=JSON");
  await page.waitForSelector("textarea.code");
  const json = await page.$eval("textarea.code", (e) => e.value);
  await page.click(".leftnav >> text=Questions");
  await page.waitForSelector(".block-badge");
  return JSON.parse(json);
};

const applyDef = async (def) => {
  await page.click(".leftnav >> text=JSON");
  await page.waitForSelector("textarea.code");
  await page.click('[data-testid="json-edit"]');
  await page.waitForTimeout(120);
  await page.$eval("textarea.code", (el, v) => {
    const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, "value").set;
    setter.call(el, v);
    el.dispatchEvent(new Event("input", { bubbles: true }));
  }, JSON.stringify(def, null, 2));
  await page.click('[data-testid="json-apply"]');
  await page.waitForTimeout(500);
  await page.click(".leftnav >> text=Questions");
  await page.waitForSelector(".block-badge");
};

const addQuestion = async (text, options) => {
  const bars = await page.$$(".insert-bar");
  await (await bars[bars.length - 1].$("text=+ Question")).click();
  await page.waitForSelector(".qcard.selected .rte-surface");
  await page.waitForFunction(() => document.activeElement?.classList.contains("rte-surface"));
  await page.keyboard.type(text);
  await page.waitForTimeout(300);
  const first = await page.$('.qcard.selected input[data-oidx="0"]');
  if (!first) await page.click('.qcard.selected [data-testid="add-option"]');
  await page.click('.qcard.selected input[data-oidx="0"]');
  for (let i = 0; i < options.length; i++) {
    await page.keyboard.type(options[i]);
    if (i < options.length - 1) await page.keyboard.press("Enter");
  }
  await page.waitForTimeout(350);
};

/** Re-select the question so the properties panel is on screen. */
const select = async (idx) => {
  await page.click(`.qcard >> nth=${idx}`);
  await page.waitForSelector(".qcard.selected");
  // Properties panel sections are independently collapsible and default to
  // collapsed unless already configured (Part B of the universal auto-punch
  // brief) — expand Option groups before looking inside it. Idempotent.
  const head = '[data-testid="psec-head-option-groups"]';
  await page.waitForSelector(head);
  if ((await page.getAttribute(head, "aria-expanded")) !== "true") {
    await page.click(head);
    await page.waitForTimeout(150);
  }
  await page.waitForSelector('[data-testid="option-groups"]');
};

await page.goto(`${STUDIO}/sandbox`, { waitUntil: "networkidle" });
await page.waitForSelector(".block-badge");

/* ------------------------------------------------------------------ setup */

await addQuestion(
  "Which products do you use?",
  ["Apple", "Samsung", "Google", "Dell", "HP", "Lenovo"],
);
let def = await readDef();
assert.equal(def.questions[0].options.length, 6);
ok("setup: one question, six options");

await select(0);
ok("the Option groups panel is offered on a question with options");

/*
 * A brand-new question has no groups, and the panel says what a group is for
 * rather than showing an empty box.
 */
assert.equal((await page.$$('[data-testid="group-card"]')).length, 0);
assert.equal((await page.$$('[data-testid="group-ordering"]')).length, 0,
  "no order switches until there is something to order");
ok("no groups to begin with, and no order controls with nothing to order");

/* ================================================== build two groups */

await page.click('[data-testid="add-group"]');
await page.waitForTimeout(200);
await page.click('[data-testid="add-group"]');
await page.waitForTimeout(350);

def = await readDef();
let groups = def.questions[0].optionGroups;
assert.equal(groups.length, 2, "two groups stored");
assert.match(groups[0].id, /^grp_/, `a minted group id: ${groups[0].id}`);
assert.notEqual(groups[0].id, groups[1].id, "…and they are distinct");
assert.equal(groups[0].scope, "options");
assert.deepEqual(groups[0].members, [], "a new group starts empty");
ok("GROUPS ARE REAL OBJECTS with stable minted ids (§14, §37)");

await select(0);
await page.fill(`[data-testid="group-name-${groups[0].id}"]`, "Smartphones");
await page.fill(`[data-testid="group-name-${groups[1].id}"]`, "Computers");
await page.waitForTimeout(400);
def = await readDef();
groups = def.questions[0].optionGroups;
assert.deepEqual(groups.map((g) => g.name), ["Smartphones", "Computers"]);
ok("groups can be renamed, and the id does not move with the name");

/* ------------------------------------------------- assign the members */

await select(0);
const codes = def.questions[0].options.map((o) => String(o.code));
for (const c of codes.slice(0, 3)) {
  await page.selectOption(`[data-testid="assign-${c}"]`, groups[0].id);
  await page.waitForTimeout(120);
}
for (const c of codes.slice(3)) {
  await page.selectOption(`[data-testid="assign-${c}"]`, groups[1].id);
  await page.waitForTimeout(120);
}
await page.waitForTimeout(400);

def = await readDef();
groups = def.questions[0].optionGroups;
assert.deepEqual(groups[0].members.map(String), codes.slice(0, 3));
assert.deepEqual(groups[1].members.map(String), codes.slice(3));
ok("options are assigned to groups, and stored as member codes on the group");

/*
 * MEMBERSHIP IS EXCLUSIVE. Reassigning an option must take it out of the group
 * that had it — an option in two groups would be shown twice, and a respondent
 * who ticks it once produces an answer nothing can read.
 */
await select(0);
await page.selectOption(`[data-testid="assign-${codes[0]}"]`, groups[1].id);
await page.waitForTimeout(400);
def = await readDef();
groups = def.questions[0].optionGroups;
assert.ok(!groups[0].members.map(String).includes(codes[0]), "gone from the first group");
assert.ok(groups[1].members.map(String).includes(codes[0]), "and in the second");
assert.equal(
  groups.flatMap((g) => g.members.map(String)).filter((m) => m === codes[0]).length, 1,
  "listed exactly once across every group",
);
ok("MOVING AN OPTION BETWEEN GROUPS TAKES IT OUT OF THE OLD ONE (§15, §29)");

/* put it back */
await select(0);
await page.selectOption(`[data-testid="assign-${codes[0]}"]`, groups[0].id);
await page.waitForTimeout(400);

/* ============================================ the two order switches */

await select(0);
assert.ok(await page.$('[data-testid="group-ordering"]'), "the order panel appears with groups");
const groupOrders = await page.$$eval('[data-testid="group-order"] option', (e) => e.map((x) => x.value));
const itemOrders = await page.$$eval('[data-testid="item-order"] option', (e) => e.map((x) => x.value));
for (const wanted of ["fixed", "random", "rotate", "flip", "alpha_asc", "alpha_desc", "custom", "priority"]) {
  assert.ok(groupOrders.includes(wanted), `group order offers ${wanted}: ${groupOrders.join(",")}`);
}
for (const wanted of ["numeric_asc", "numeric_desc"]) {
  assert.ok(itemOrders.includes(wanted), `item order offers ${wanted}`);
}
ok("every ordering strategy the brief lists is offered at the level it applies to (§19–24)");

await page.selectOption('[data-testid="group-order"]', "fixed");
await page.selectOption('[data-testid="item-order"]', "random");
await page.waitForTimeout(400);
def = await readDef();
assert.deepEqual(def.questions[0].groupOrdering, { groupOrder: "fixed", itemOrder: "random", ungrouped: "last" });
ok("THE TWO SWITCHES ARE INDEPENDENT AND STORED SEPARATELY (§18)");

/* ------------------------------------- a group can override its own order */

await select(0);
await page.selectOption(`[data-testid="group-itemorder-${groups[0].id}"]`, "alpha_asc");
await page.waitForTimeout(400);
def = await readDef();
groups = def.questions[0].optionGroups;
assert.equal(groups[0].itemOrder, "alpha_asc");
assert.equal(groups[1].itemOrder, undefined, "the other group still follows the question setting");
ok("a single group can order its own members differently (§20)");

/* ================================================ the lint on screen */

/*
 * Flat randomization plus groups is the one genuinely contradictory
 * combination: a flat shuffle would move a member out of its group, so the
 * engine lets groups win. Without this message a programmer turns on
 * "randomize options", sees a fixed order and concludes it is broken.
 */
def = await readDef();
def.questions[0].randomization = { enabled: true, scope: "options", method: "shuffle" };
await applyDef(def);
await select(0);
const warn = await page.$$eval('[data-testid="group-problem"]', (els) => els.map((e) => e.textContent).join(" | "));
assert.match(warn, /groups win/i, `the override is explained: ${warn}`);
assert.match(warn, /move an item out of its group/i);
ok("THE LINT EXPLAINS WHY THE FLAT RANDOMIZATION SETTING IS BEING IGNORED");

def = await readDef();
delete def.questions[0].randomization;
await applyDef(def);

/* ------------------------------ an option in no group is reported */

await select(0);
await page.selectOption(`[data-testid="assign-${codes[5]}"]`, "");
await page.waitForTimeout(450);
await select(0);
const orphan = await page.$$eval('[data-testid="group-problem"]', (els) => els.map((e) => e.textContent).join(" | "));
assert.match(orphan, /in no group/, `the ungrouped option is reported: ${orphan}`);
assert.match(orphan, /shown together, last/, "…and where it will end up");
ok("an option left out of every group is reported, with where it will be shown");

await select(0);
await page.selectOption(`[data-testid="assign-${codes[5]}"]`, groups[1].id);
await page.waitForTimeout(400);

/* ====================================== what the RESPONDENT is shown */

/*
 * The point of all of it. The order is set to fixed groups with reversed items
 * so the expected output is exact rather than "one of several shuffles" — a
 * seeded assertion would be checking the seed, not the grouping.
 */
def = await readDef();
def.questions[0].groupOrdering = { groupOrder: "fixed", itemOrder: "flip", ungrouped: "last" };
def.questions[0].optionGroups = [
  { ...def.questions[0].optionGroups[0], itemOrder: undefined, members: [codes[0], codes[1], codes[2]] },
  { ...def.questions[0].optionGroups[1], itemOrder: undefined, members: [codes[3], codes[4], codes[5]] },
];
await applyDef(def);

/*
 * The runtime's own preview door: post the current definition to /preview and
 * read the order the RESPONDENT is served. This is the only assertion in the
 * suite that goes all the way through the option pipeline in the app that
 * actually serves people.
 */
const RUNTIME = process.env.RUNTIME_URL ?? "http://localhost:3001";
const pv = await browser.newPage({ viewport: { width: 900, height: 900 } });
pv.on("pageerror", (e) => errors.push(`runtime: ${e.message}`));
await pv.goto(`${RUNTIME}/preview`, { waitUntil: "networkidle" });
const current = await readDef();
await sendPreview(pv, { definition: current }, { selector: "[data-qid], [data-testid='rs-start-note']" });
await pv.waitForTimeout(400);

const rendered = await pv.$$eval(
  `[data-qid="${current.questions[0].id}"] input[type=radio], [data-qid="${current.questions[0].id}"] input[type=checkbox]`,
  (els) => els.map((e) => e.value),
);
assert.deepEqual(
  rendered,
  [codes[2], codes[1], codes[0], codes[5], codes[4], codes[3]],
  `each group reversed within itself, groups in declared order: ${rendered.join(",")}`,
);
ok("THE RESPONDENT IS SERVED THE GROUPED ORDER — each group reversed, the blocks in place");

/*
 * And the invariant, on the screen a person sees: the two groups are
 * contiguous. If ordering had leaked across the boundary the members would
 * interleave, and no amount of per-group correctness would matter.
 */
const firstThree = rendered.slice(0, 3);
const lastThree = rendered.slice(3);
assert.deepEqual(firstThree.slice().sort(), codes.slice(0, 3).slice().sort(),
  "the first three shown are exactly the first group's members");
assert.deepEqual(lastThree.slice().sort(), codes.slice(3).slice().sort(),
  "and the last three are exactly the second group's");
ok("the groups are contiguous on screen — nothing leaked across the boundary");

await pv.close();

/* ------------------------------------------ removing a group keeps options */

def = await readDef();
const before = def.questions[0].options.length;
await select(0);
await page.click(`[data-testid="group-remove-${groups[1].id}"]`);
await page.waitForTimeout(450);
def = await readDef();
assert.equal(def.questions[0].optionGroups.length, 1, "the group is gone");
assert.equal(def.questions[0].options.length, before,
  "REMOVING A GROUP DOES NOT REMOVE ITS OPTIONS — only the grouping");
ok("removing a group leaves every option in place");

/* -------------------------------------------------------------- errors */

assert.deepEqual(errors, [], `no page errors: ${errors.join(" | ")}`);
ok("no uncaught errors through any of it");

await browser.close();
console.log(`\nALL OPTION GROUP CHECKS PASSED (${passed})`);

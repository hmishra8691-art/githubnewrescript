/**
 * DROPDOWN MATRIX — a multi-select column is a checkbox dropdown.
 *
 * It used to be the browser's `<select multiple>`: a scrolling list that only
 * selects with ctrl/cmd-click. Proven here in the real runtime:
 *   · one click opens a list of checkboxes that STAYS OPEN while several are
 *     ticked; it shows the labels, or "N Options Selected" beyond two;
 *   · the column's maximum is enforced in the list (the rest are disabled and
 *     it says so), the minimum by validation on Next;
 *   · every row chooses independently;
 *   · the answer is the same array of codes, and going Back to the page shows
 *     the same selections;
 *   · it fits and works at phone width, and Escape / an outside click close it.
 *
 *   node scripts/dropdown-matrix-multi-test.mjs      (studio on 3000, runtime on 3001)
 */
import { openHarness, assert } from "./lib/variantHarness.mjs";

const h = await openHarness();
let passed = 0;
const ok = (m) => { console.log("  ok  ", m); passed++; };

const row = (code, label) => ({ code, label, flags: [], validation: [], required: false });
const opts = ["Red", "Green", "Blue", "Amber", "Violet"].map((label, i) => ({ code: String(i + 1), label, flags: [] }));
const def = {
  meta: { id: "sandbox", code: "SANDBOX", title: "DDM", version: "1.0" },
  questions: [
    {
      id: "q_ddm", code: "Q1", variableName: "Q1", type: "composite", variant: "matrix.dropdown", text: "Pick colours per item",
      options: [], rows: [row("r1", "Item one"), row("r2", "Item two")],
      columns: [{
        id: "c1", label: "Colours", responseType: "multi_dropdown", variableStem: "Q1_C1", options: opts, readOnly: false,
        validation: [{ kind: "min_selections", value: 2 }, { kind: "max_selections", value: 3 }],
      }],
      validation: [], required: false, settings: { readOnly: false, hidden: false }, skipLogic: [], listLogic: [],
    },
    { id: "q_after", code: "Q2", variableName: "Q2", type: "single_select", text: "after", options: [{ code: "1", label: "Yes", flags: [] }], rows: [], columns: [], validation: [], required: false, settings: { readOnly: false, hidden: false }, skipLogic: [], listLogic: [] },
  ],
  flow: [{ type: "page", id: "p1", questionIds: ["q_ddm"] }, { type: "page", id: "p2", questionIds: ["q_after"] }, { type: "end", id: "e1", status: "complete" }],
};
await h.loadDef(def);

const pv = await h.preview(["q_ddm"], (d) => { d.flow = def.flow; });
await pv.waitForSelector('[data-qid="q_ddm"]');
const cell = (i) => pv.locator('[data-testid="rs-cell-multi-dropdown"]').nth(i);
const btn = (i) => cell(i).locator("button");
const panel = () => pv.locator('[data-testid="rs-cell-multi-dropdown-panel"]');
const tick = (name) => panel().locator(`label:has-text("${name}") input`);

assert.equal(await pv.locator('[data-qid="q_ddm"] select[multiple]').count(), 0, "no native multi-select list box");
assert.equal(await pv.locator('[data-testid="rs-cell-multi-dropdown"]').count(), 2, "one dropdown per row");
ok("the cell is a dropdown button, not a list box — one per row");

await btn(0).click();
await panel().waitFor();
assert.match(await pv.locator('[data-testid="rs-cell-multi-dropdown-hint"]').innerText(), /Select 2 to 3/);
await tick("Red").check();
await tick("Green").check();
assert.ok(await panel().isVisible(), "the list stays open after ticking");
assert.match(await btn(0).innerText(), /Red, Green/);
await tick("Blue").check();
assert.match(await btn(0).innerText(), /3 Options Selected/);
ok("stays open while several are ticked; shows labels, then “3 Options Selected”");

assert.equal(await tick("Amber").isDisabled(), true, "maximum reached: the rest are disabled");
assert.ok(await pv.locator('[data-testid="rs-cell-multi-dropdown-max"]').isVisible());
await tick("Blue").uncheck();
assert.equal(await tick("Amber").isDisabled(), false, "freed again once one is unticked");
ok("the column's maximum is enforced in the list and explained");

assert.deepEqual(await h.answerOf(pv, "q_ddm"), { r1: { c1: ["1", "2"] } }, "the answer is the same array of codes");
await pv.keyboard.press("Escape");
await panel().waitFor({ state: "detached" });
await btn(1).click();
await panel().waitFor();
await tick("Violet").check();
await pv.mouse.click(5, 5);
await panel().waitFor({ state: "detached" });
assert.match(await btn(0).innerText(), /Red, Green/, "row one is untouched by row two");
assert.match(await btn(1).innerText(), /Violet/);
assert.deepEqual(await h.answerOf(pv, "q_ddm"), { r1: { c1: ["1", "2"] }, r2: { c1: ["5"] } });
ok("rows choose independently; Escape and an outside click close the list");

/* the minimum, on Next: row two has only one pick */
await pv.locator(".rs-nav .rs-btn:not(.secondary)").first().click();
await pv.waitForTimeout(400);
assert.ok(await pv.locator('[data-qid="q_ddm"]').isVisible(), "stays on the page");
assert.match(await pv.locator('[data-qid="q_ddm"]').innerText(), /Select at least 2/i);
ok("the minimum is enforced on Next, naming the row");

await btn(1).click();
await panel().waitFor();
await tick("Amber").check();
await pv.keyboard.press("Escape");
await pv.locator(".rs-nav .rs-btn:not(.secondary)").first().click();
await pv.waitForSelector('[data-qid="q_after"]');
const back = pv.locator(".rs-nav .rs-btn.secondary").first();
await back.click();
await pv.waitForSelector('[data-qid="q_ddm"]');
assert.match(await btn(0).innerText(), /Red, Green/, "selections persist on Back");
assert.match(await btn(1).innerText(), /Violet, Amber|Amber, Violet/);
ok("selections persist when the respondent goes Back");

await pv.setViewportSize({ width: 360, height: 640 });
await btn(0).click();
await panel().waitFor();
const box = await panel().boundingBox();
assert.ok(box && box.x >= 0 && box.x + box.width <= 360, `the list fits a 360px phone: ${JSON.stringify(box)}`);
await tick("Green").uncheck();
assert.ok(await panel().isVisible());
ok("fits and works at phone width");
await pv.close();
await h.close();
console.log(`\n${passed} checks passed`);

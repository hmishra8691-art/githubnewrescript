/**
 * Grids / lists / forms variant families (8 variants): created from the
 * picker, rendered in the runtime, answered, and the answer checked against
 * the response model — plus the ordinary validators.
 *
 *   matrix.slider_matrix    matrix_numeric  per_row  slidermatrix (slider family)
 *   matrix.star_matrix      matrix_numeric  per_row  starmatrix
 *   matrix.constant_sum     composite       cells    summatrix
 *   matrix.dragdrop_matrix  matrix_single   per_row  dragmatrix
 *   list.dynamic_list       repeating_group fields   dynamiclist
 *   list.editable_table     custom_table    cells    spreadsheet
 *   form.repeating          repeating_group fields   repeatform
 *   form.conditional        text_list       fields   (ListInput)
 *
 * `slidermatrix` belongs to the slider family and is built on another branch,
 * so this suite proves only its picker half; the combined suite renders it.
 */
import { openHarness, assert } from "./lib/variantHarness.mjs";

const h = await openHarness();
const made = {};
let checks = 0;
const ok = (msg) => { checks++; console.log(`✔ ${msg}`); };

/* ------------------------------------------------------ create every variant */
const MATRIX = ["slider_matrix", "star_matrix", "constant_sum", "dragdrop_matrix"];
const LIST = ["dynamic_list", "editable_table"];
const FORM = ["repeating", "conditional"];
for (const k of MATRIX) made[k] = await h.createFromPicker("matrix", `matrix.${k}`);
for (const k of LIST) made[k] = await h.createFromPicker("list", `list.${k}`);
for (const k of FORM) made[k] = await h.createFromPicker("form", `form.${k}`);
ok("all 8 grid / list / form variants are offered as stable and create with their variant id");

/* base types */
assert.equal(made.slider_matrix.type, "matrix_numeric");
assert.equal(made.star_matrix.type, "matrix_numeric");
assert.equal(made.constant_sum.type, "composite");
assert.equal(made.dragdrop_matrix.type, "matrix_single");
assert.equal(made.dynamic_list.type, "repeating_group");
assert.equal(made.editable_table.type, "custom_table");
assert.equal(made.repeating.type, "repeating_group");
assert.equal(made.conditional.type, "text_list");
ok("every variant creates on the base type that owns its response model");

/* seeded defaults */
assert.equal(made.slider_matrix.settings.sliderLayout, "grid", "slider matrix defaults to the grid layout");
assert.equal(made.slider_matrix.settings.minValue, 0);
assert.equal(made.slider_matrix.settings.maxValue, 100);
assert.equal(made.slider_matrix.rows.length, 3, "row-driven base type seeds starter rows");

assert.equal(made.star_matrix.settings.minValue, 1);
assert.equal(made.star_matrix.settings.maxValue, 5);
assert.equal(made.star_matrix.rows.length, 3);

assert.equal(made.constant_sum.settings.rowSum, true, "the constant-sum rule is a setting, not a variant id");
assert.equal(made.constant_sum.settings.sumTarget, 100);
assert.equal(made.constant_sum.rows.length, 3, "composite is not row-driven, so the variant brings rows");

assert.equal(made.dragdrop_matrix.rows.length, 3);

assert.equal(made.dynamic_list.rows.length, 1, "a dynamic list is one field, repeated");
assert.equal(made.dynamic_list.rows[0].code, "item");
assert.equal(made.dynamic_list.rows[0].required, true);
assert.equal(made.dynamic_list.settings.minRepeats, 1);
assert.equal(made.dynamic_list.settings.maxRepeats, 10);

assert.equal(made.editable_table.rows.length, 3);

assert.deepEqual(made.repeating.rows.map((r) => r.code), ["name", "email", "relationship"]);
assert.equal(made.repeating.rows[0].required, true);
assert.equal(made.repeating.rows[1].fieldType, "email");
assert.equal(made.repeating.settings.minRepeats, 1);
assert.equal(made.repeating.settings.maxRepeats, 5);

assert.deepEqual(made.conditional.rows.map((r) => r.code), ["employed", "employer"]);
assert.match(made.conditional.instruction, /Show-when/);
ok("seeded defaults are right for all 8 (bounds, rows, field types, the rowSum flag)");

/* ---------------------------------------------- Studio: the settings blocks */
/**
 * Open one question's editor by its variant badge and wait for the settings
 * block to appear. Reading the definition goes through the JSON tab, which
 * unmounts the panel — so every UI edit happens before its assertion, and
 * anything that has to be put back is put back through the definition.
 */
const openEditor = async (variantKey, testid) => {
  await h.goTab("Questions");
  await h.page.click(`.qcard:has(.qtype-badge:text-is("${variantKey}"))`);
  await h.page.waitForSelector(`[data-testid="${testid}"]`);
  await h.page.waitForTimeout(400);
};

await openEditor("star_matrix", "starmatrix-max");
await h.page.fill('[data-testid="starmatrix-max"]', "7");
await h.page.waitForTimeout(350);
let def = await h.readDef();
assert.equal(def.questions[1].settings.maxValue, 7, "the star-count block writes settings.maxValue");
await h.setQuestion(made.star_matrix.id, (q) => { q.settings.maxValue = 5; });
ok("Studio: the Star Rating Matrix exposes its star count");

await openEditor("constant_sum", "summatrix-target");
assert.ok(await h.page.$('[data-testid="summatrix-no-columns"]'),
  "an unconfigured cell grid says so, and offers to create its columns");
await h.page.fill('[data-testid="summatrix-unit"]', "%");
await h.page.waitForTimeout(250);
await h.page.click('[data-testid="summatrix-seed-columns"]');
await h.page.waitForTimeout(350);
def = await h.readDef();
assert.equal(def.questions[2].settings.sumUnit, "%", "the sum block writes settings.sumUnit");
assert.equal(def.questions[2].columns.length, 3, "the starter columns are created for editing");
assert.deepEqual(def.questions[2].columns.map((c) => c.id), ["c1", "c2", "c3"],
  "with the same ids the runtime falls back to, so nothing already answered moves");
assert.equal(def.questions[2].columns[0].responseType, "numeric");
assert.equal(def.questions[2].columns[0].variableStem, `${def.questions[2].variableName}_C1`);
await h.setQuestion(made.constant_sum.id, (q) => { delete q.settings.sumUnit; });
ok("Studio: the Constant-Sum Matrix exposes its target + unit and materialises its columns");

await openEditor("dynamic_list", "repeat-max");
await h.page.fill('[data-testid="repeat-max"]', "4");
await h.page.waitForTimeout(350);
def = await h.readDef();
assert.equal(def.questions[4].settings.maxRepeats, 4, "the entry-bounds block writes settings.maxRepeats");
await h.setQuestion(made.dynamic_list.id, (q) => { q.settings.maxRepeats = 10; });
ok("Studio: the Dynamic List exposes its entry bounds");

// the editor's Fields section is wired to text_list / numeric_list only, so a
// repeating group's rows get a type and a required flag from the variant block
await openEditor("repeating", "repeat-fieldtype-1");
await h.page.selectOption('[data-testid="repeat-fieldtype-1"]', "phone");
await h.page.waitForTimeout(200);
await h.page.click('[data-testid="repeat-required-1"]');
await h.page.waitForTimeout(350);
def = await h.readDef();
assert.equal(def.questions[6].rows[1].fieldType, "phone", "a field's type is editable");
assert.equal(def.questions[6].rows[1].required, true, "and so is its required flag");
await h.setQuestion(made.repeating.id, (q) => {
  q.rows[1].fieldType = "email";
  q.rows[1].required = false;
});
ok("Studio: the Repeating Form exposes each field's type and required flag");

/* ------------------------------------------- configure the ones needing more */
await h.setQuestion(made.constant_sum.id, (q) => {
  q.rows = [
    { code: "speed", label: "Speed", flags: [], validation: [], required: false },
    { code: "price", label: "Price", flags: [], validation: [], required: false },
  ];
  q.columns = ["x", "y"].map((k, i) => ({
    id: `c${i + 1}`, label: `Brand ${k.toUpperCase()}`, responseType: "numeric",
    variableStem: `${q.variableName}_C${i + 1}`, options: [], validation: [], readOnly: false, min: 0,
  }));
});
await h.setQuestion(made.dragdrop_matrix.id, (q) => {
  q.rows = ["Apples", "Bananas", "Cherries"].map((l, i) => ({
    code: String(i + 1), label: l, flags: [], validation: [], required: false,
  }));
  q.options = [
    { code: "love", label: "Love it", flags: [] },
    { code: "meh", label: "Indifferent", flags: [] },
    { code: "hate", label: "Hate it", flags: [] },
  ];
});
await h.setQuestion(made.editable_table.id, (q) => {
  q.columns = [
    { id: "c1", label: "Item", responseType: "text", variableStem: `${q.variableName}_C1`, options: [], validation: [], readOnly: false },
    { id: "c2", label: "Detail", responseType: "text", variableStem: `${q.variableName}_C2`, options: [], validation: [], readOnly: false },
    { id: "c3", label: "Amount", responseType: "numeric", variableStem: `${q.variableName}_C3`, options: [], validation: [], readOnly: false },
  ];
});

/* ================================================= runtime: star matrix */
const ids = (...ks) => ks.map((k) => made[k].id);
let pv = await h.preview(ids("star_matrix"));
const sm = made.star_matrix.id;
assert.equal((await pv.$$(`[data-qid="${sm}"] .rs-starmatrix-row`)).length, 3, "one row of stars per item");
assert.equal((await pv.$$(`[data-qid="${sm}"] .rs-starmatrix-row[data-row="1"] button`)).length, 5, "five stars by default");
await pv.click(`[data-qid="${sm}"] .rs-starmatrix-row[data-row="1"] button[data-star="4"]`);
assert.deepEqual(await h.answerOf(pv, sm), { 1: 4 }, "a star stores the number under the row code");
await pv.click(`[data-qid="${sm}"] .rs-starmatrix-row[data-row="1"] button[data-star="4"]`);
assert.deepEqual(await h.answerOf(pv, sm), {}, "clicking the same star again clears the row");
await pv.click(`[data-qid="${sm}"] .rs-starmatrix-row[data-row="1"] button[data-star="3"]`);
await pv.click(`[data-qid="${sm}"] .rs-starmatrix-row[data-row="2"] button[data-star="5"]`);
assert.deepEqual(await h.answerOf(pv, sm), { 1: 3, 2: 5 }, "per_row shape: {rowCode: n}");
assert.match(await pv.textContent(`[data-qid="${sm}"] [data-testid="starmatrix-progress"]`), /2 \/ 3 rated/);
// keyboard: the stars are buttons, so Enter activates them
await pv.focus(`[data-qid="${sm}"] .rs-starmatrix-row[data-row="3"] button[data-star="2"]`);
await pv.keyboard.press("Enter");
assert.deepEqual(await h.answerOf(pv, sm), { 1: 3, 2: 5, 3: 2 }, "the keyboard rates a row too");
ok("star matrix: stars per row, keyboard-operable, stores {rowCode: n}");

await pv.close();
pv = await h.preview([sm], (d) => {
  const q = d.questions.find((x) => x.id === sm);
  q.required = true;
});
await pv.click(`[data-qid="${sm}"] .rs-starmatrix-row[data-row="1"] button[data-star="4"]`);
await h.next(pv);
assert.ok(await pv.$(`[data-qid="${sm}"]`), "a partly rated required matrix does not advance");
assert.match(await pv.textContent(`[data-qid="${sm}"]`), /Please answer for/, "the ordinary matrix validator names the missing rows");
await pv.click(`[data-qid="${sm}"] .rs-starmatrix-row[data-row="2"] button[data-star="4"]`);
await pv.click(`[data-qid="${sm}"] .rs-starmatrix-row[data-row="3"] button[data-star="4"]`);
await h.next(pv);
assert.ok(!(await pv.$(`[data-qid="${sm}"]`)), "every row rated, so Next advances");
ok("star matrix: required is the existing matrix rule — every visible row");
await pv.close();

/* ============================================ runtime: constant-sum matrix */
pv = await h.preview(ids("constant_sum"));
const cs = made.constant_sum.id;
const cell = (r, c) => `[data-qid="${cs}"] td[data-row="${r}"][data-col="${c}"] input`;
assert.equal((await pv.$$(`[data-qid="${cs}"] tbody tr`)).length, 2);
await pv.fill(cell("speed", "c1"), "60");
await pv.fill(cell("speed", "c2"), "40");
assert.deepEqual(await h.answerOf(pv, cs), { speed: { c1: 60, c2: 40 } }, "cells shape: {row: {colId: n}}");
assert.match(await pv.textContent(`[data-qid="${cs}"] [data-testid="summatrix-total-speed"]`), /100 \/ 100/);
assert.ok(await pv.$(`[data-qid="${cs}"] [data-testid="summatrix-total-speed"].ok`), "a row on target reads as ok");
await pv.fill(cell("price", "c1"), "70");
await pv.fill(cell("price", "c2"), "50");
assert.match(await pv.textContent(`[data-qid="${cs}"] [data-testid="summatrix-total-price"]`), /120 \/ 100/);
assert.ok(await pv.$(`[data-qid="${cs}"] [data-testid="summatrix-total-price"].over`), "a row over target reads as over");
await h.next(pv);
assert.ok(await pv.$(`[data-qid="${cs}"]`), "an over-total row blocks Next");
assert.match(await pv.textContent(`[data-qid="${cs}"]`), /Row “Price” must total 100\./);
await pv.fill(cell("price", "c2"), "30");
assert.match(await pv.textContent(`[data-qid="${cs}"] [data-testid="summatrix-total-price"]`), /100 \/ 100/);
await h.next(pv);
assert.ok(!(await pv.$(`[data-qid="${cs}"]`)), "both rows on target, so Next advances");
ok("constant-sum matrix: per-row totals, over-total blocks Next, correct totals advance");
await pv.close();

/* ============================================ runtime: drag-and-drop matrix */
pv = await h.preview(ids("dragdrop_matrix"));
const dm = made.dragdrop_matrix.id;
const chip = (r) => `[data-qid="${dm}"] .rs-dragchip[data-row="${r}"]`;
const col = (c) => `[data-qid="${dm}"] .rs-dragcol[data-code="${c}"]`;
assert.equal((await pv.$$(`[data-qid="${dm}"] .rs-dragpool .rs-dragchip`)).length, 3, "every row starts in the pool");
assert.equal((await pv.$$(`[data-qid="${dm}"] .rs-dragcol`)).length, 3, "the options are the columns");
// tap the chip, then tap a column
await pv.click(chip("1"));
assert.ok(await pv.$(`${chip("1")}.picked`), "a tapped chip is armed");
await pv.click(col("love"));
assert.deepEqual(await h.answerOf(pv, dm), { 1: "love" }, "per_row shape: {rowCode: optionCode}");
assert.ok(await pv.$(`${col("love")} .rs-dragchip[data-row="1"]`), "the chip now sits in its column");
// move it to another column
await pv.click(`${col("love")} .rs-dragchip[data-row="1"]`); // back to the pool
assert.deepEqual(await h.answerOf(pv, dm), {}, "tapping a placed chip returns it to the pool");
await pv.click(chip("1"));
await pv.click(col("hate"));
await pv.click(chip("2"));
await pv.click(col("meh"));
assert.deepEqual(await h.answerOf(pv, dm), { 1: "hate", 2: "meh" });
assert.match(await pv.textContent(`[data-qid="${dm}"] [data-testid="dragmatrix-progress"]`), /2 \/ 3 placed/);
// a real pointer drag: chip 3 onto the "love" column
const from = await (await pv.$(chip("3"))).boundingBox();
const to = await (await pv.$(col("love"))).boundingBox();
await pv.mouse.move(from.x + from.width / 2, from.y + from.height / 2);
await pv.mouse.down();
await pv.mouse.move(to.x + to.width / 2, to.y + to.height / 2, { steps: 8 });
await pv.mouse.up();
await pv.waitForTimeout(150);
assert.deepEqual(await h.answerOf(pv, dm), { 1: "hate", 2: "meh", 3: "love" }, "a pointer drag places a chip");
// keyboard: arm with Enter, place with Enter
await pv.focus(`${col("love")} .rs-dragchip[data-row="3"]`);
await pv.keyboard.press("Enter");
assert.deepEqual(await h.answerOf(pv, dm), { 1: "hate", 2: "meh" }, "Enter on a placed chip clears it");
await pv.focus(chip("3"));
await pv.keyboard.press("Enter");
await pv.focus(col("meh"));
await pv.keyboard.press("Enter");
assert.deepEqual(await h.answerOf(pv, dm), { 1: "hate", 2: "meh", 3: "meh" }, "the keyboard places a chip too");
ok("drag matrix: tap-to-place, pointer drag, keyboard, back-to-pool clears");

await pv.close();
pv = await h.preview([dm], (d) => { d.questions.find((x) => x.id === dm).required = true; });
await h.next(pv);
assert.ok(await pv.$(`[data-qid="${dm}"]`), "an unplaced required grid does not advance");
assert.match(await pv.textContent(`[data-qid="${dm}"]`), /required|Please answer/i);
ok("drag matrix: required applies like any matrix");
await pv.close();

/* ================================================== runtime: dynamic list */
pv = await h.preview(ids("dynamic_list"));
const dl = made.dynamic_list.id;
const line = (i) => `[data-qid="${dl}"] input[data-line="${i}"]`;
assert.equal((await pv.$$(`[data-qid="${dl}"] .rs-dynlist-line`)).length, 1, "starts at minRepeats lines");
await pv.fill(line(0), "Apples");
assert.deepEqual(await h.answerOf(pv, dl), [{ item: "Apples" }], "fields shape: an array of records");
await pv.click(`[data-qid="${dl}"] [data-testid="dynlist-add"]`);
await pv.fill(line(1), "Pears");
assert.deepEqual(await h.answerOf(pv, dl), [{ item: "Apples" }, { item: "Pears" }]);
// Enter in the last line adds another
await pv.focus(line(1));
await pv.keyboard.press("Enter");
assert.equal((await pv.$$(`[data-qid="${dl}"] .rs-dynlist-line`)).length, 3, "Enter in the last line adds a line");
assert.deepEqual(await h.answerOf(pv, dl), [{ item: "Apples" }, { item: "Pears" }],
  "an unused blank line never becomes an entry");
await pv.fill(line(2), "Plums");
assert.deepEqual(await h.answerOf(pv, dl), [{ item: "Apples" }, { item: "Pears" }, { item: "Plums" }]);
await pv.click(`[data-qid="${dl}"] .rs-dynlist-remove[data-line="1"]`);
assert.deepEqual(await h.answerOf(pv, dl), [{ item: "Apples" }, { item: "Plums" }], "✕ removes that line");
assert.match(await pv.textContent(`[data-qid="${dl}"] [data-testid="dynlist-count"]`), /2 of up to 10/);
ok("dynamic list: add / remove lines, Enter adds, trailing blanks never reach the data");

await pv.close();
pv = await h.preview([dl], (d) => {
  const q = d.questions.find((x) => x.id === dl);
  q.required = true;
  q.settings.minRepeats = 2;
});
await pv.fill(`[data-qid="${dl}"] input[data-line="0"]`, "Only one");
await h.next(pv);
assert.ok(await pv.$(`[data-qid="${dl}"]`), "one entry is not two");
assert.match(await pv.textContent(`[data-qid="${dl}"]`), /at least 2 entries/);
await pv.fill(`[data-qid="${dl}"] input[data-line="1"]`, "And two");
await h.next(pv);
assert.ok(!(await pv.$(`[data-qid="${dl}"]`)), "two entries advance");
ok("dynamic list: minRepeats is enforced by the repeating-group validator");
await pv.close();

/* ================================================= runtime: editable table */
pv = await h.preview(ids("editable_table"));
const et = made.editable_table.id;
const sheetCell = (r, c) => `[data-qid="${et}"] td[data-row="${r}"][data-col="${c}"] input`;
assert.equal((await pv.$$(`[data-qid="${et}"] tbody tr`)).length, 3);
assert.equal((await pv.$$(`[data-qid="${et}"] tbody tr[data-row="1"] td[data-col]`)).length, 3);
assert.equal(await pv.textContent(`[data-qid="${et}"] tbody tr[data-row="2"] th.rs-sheet-n`), "2",
  "row numbers run down the left");
await pv.fill(sheetCell("1", "c1"), "Widget");
await pv.fill(sheetCell("1", "c3"), "12");
assert.deepEqual(await h.answerOf(pv, et), { 1: { c1: "Widget", c3: 12 } },
  "cells shape, with the numeric column stored as a number");
// keyboard navigation: ArrowDown moves a row, Tab moves a cell
await pv.focus(sheetCell("1", "c1"));
await pv.keyboard.press("ArrowDown");
let where = await pv.evaluate(() => {
  const td = document.activeElement?.closest("td");
  return { row: td?.getAttribute("data-row"), col: td?.getAttribute("data-col") };
});
assert.deepEqual(where, { row: "2", col: "c1" }, "ArrowDown moves down a row, same column");
await pv.keyboard.press("Tab");
where = await pv.evaluate(() => {
  const td = document.activeElement?.closest("td");
  return { row: td?.getAttribute("data-row"), col: td?.getAttribute("data-col") };
});
assert.deepEqual(where, { row: "2", col: "c2" }, "Tab moves to the next cell");
await pv.keyboard.press("ArrowUp");
where = await pv.evaluate(() => {
  const td = document.activeElement?.closest("td");
  return { row: td?.getAttribute("data-row"), col: td?.getAttribute("data-col") };
});
assert.deepEqual(where, { row: "1", col: "c2" }, "ArrowUp moves back up");
await pv.keyboard.type("Blue");
await pv.keyboard.press("Enter");
where = await pv.evaluate(() => {
  const td = document.activeElement?.closest("td");
  return { row: td?.getAttribute("data-row"), col: td?.getAttribute("data-col") };
});
assert.deepEqual(where, { row: "2", col: "c2" }, "Enter moves down");
assert.deepEqual(await h.answerOf(pv, et), { 1: { c1: "Widget", c3: 12, c2: "Blue" } },
  "typing straight into a cell stores it");
ok("editable table: typed cells, row numbers, arrow / Tab / Enter navigation");

await pv.close();
pv = await h.preview([et], (d) => { d.questions.find((x) => x.id === et).required = true; });
await h.next(pv);
assert.ok(await pv.$(`[data-qid="${et}"]`), "an empty required table does not advance");
assert.match(await pv.textContent(`[data-qid="${et}"]`), /required/i);
ok("editable table: required applies");
await pv.close();

/* ================================================ runtime: repeating form */
pv = await h.preview(ids("repeating"));
const rf = made.repeating.id;
const entryField = (i, f) => `[data-qid="${rf}"] [data-entry="${i}"] [data-field="${f}"] input`;
assert.equal((await pv.$$(`[data-qid="${rf}"] .rs-entry`)).length, 1, "starts at minRepeats entries");
assert.equal((await pv.$$(`[data-qid="${rf}"] [data-entry="0"] .rs-entry-field`)).length, 3, "one field per row");
assert.equal(await pv.getAttribute(entryField(0, "email"), "type"), "email", "row.fieldType drives the input");
await pv.fill(entryField(0, "name"), "Ada");
await pv.fill(entryField(0, "email"), "ada@example.com");
assert.deepEqual(await h.answerOf(pv, rf), [{ name: "Ada", email: "ada@example.com" }]);
await pv.click(`[data-qid="${rf}"] [data-testid="repeatform-add"]`);
assert.equal((await pv.$$(`[data-qid="${rf}"] .rs-entry`)).length, 2);
await pv.fill(entryField(1, "relationship"), "Sister");
assert.deepEqual(await h.answerOf(pv, rf),
  [{ name: "Ada", email: "ada@example.com" }, { relationship: "Sister" }],
  "an array of records, one per entry");
assert.match(await pv.textContent(`[data-qid="${rf}"] [data-testid="repeatform-count"]`), /2 of up to 5/);
// the required field is enforced per entry
await h.next(pv);
assert.ok(await pv.$(`[data-qid="${rf}"]`), "entry 2 has no name, so Next is refused");
assert.match(await pv.textContent(`[data-qid="${rf}"] [data-entry="1"]`), /Name is required/,
  "the error is shown on the entry it belongs to");
await pv.fill(entryField(1, "name"), "Bob");
await h.next(pv);
assert.ok(!(await pv.$(`[data-qid="${rf}"]`)), "both entries complete, so Next advances");
ok("repeating form: a card per entry, typed fields, per-entry required enforcement");

await pv.close();
pv = await h.preview([rf]);
await pv.fill(`[data-qid="${rf}"] [data-entry="0"] [data-field="name"] input`, "Ada");
await pv.click(`[data-qid="${rf}"] [data-testid="repeatform-add"]`);
await pv.click(`[data-qid="${rf}"] .rs-entry-remove[data-entry="1"]`);
assert.equal((await pv.$$(`[data-qid="${rf}"] .rs-entry`)).length, 1, "an entry can be removed again");
assert.deepEqual(await h.answerOf(pv, rf), [{ name: "Ada" }]);
ok("repeating form: entries can be removed, and blank trailing entries never reach the data");
await pv.close();

/* =============================================== runtime: conditional form */
/**
 * The feature is the row's own `visibleIf`: a field appears only when the
 * condition holds, re-evaluated live as the source question is answered on
 * the same page. There is no per-row "show when" control in the Studio's
 * field editor (FieldRowsEditor) — reported, not worked around; here the
 * condition is set through the definition.
 */
const gate = await h.createFromPicker("single_select", "single_select.radio");
await h.setQuestion(gate.id, (q) => {
  q.text = "Are you employed?";
  q.options = [{ code: "yes", label: "Yes", flags: [] }, { code: "no", label: "No", flags: [] }];
});
const cf = made.conditional.id;
await h.setQuestion(cf, (q, d) => {
  q.rows = [
    { code: "employer", label: "Employer", fieldType: "text", flags: [], validation: [], required: false,
      visibleIf: { type: "rule", source: { kind: "question", ref: gate.id }, operator: "eq", value: "yes" } },
    { code: "reason", label: "Why not?", fieldType: "text", flags: [], validation: [], required: false,
      visibleIf: { type: "rule", source: { kind: "question", ref: gate.id }, operator: "eq", value: "no" } },
  ];
  void d;
});
pv = await h.preview([gate.id, cf]);
assert.equal((await pv.$$(`[data-qid="${cf}"] .rs-field-row`)).length, 0,
  "with the gate unanswered, neither conditional field is shown");
await pv.click(`[data-qid="${gate.id}"] .rs-option:has-text("Yes") input`);
await pv.waitForTimeout(150);
let labels = await pv.$$eval(`[data-qid="${cf}"] .rs-field-row .flab`, (es) => es.map((e) => e.textContent.trim()));
assert.deepEqual(labels, ["Employer"], "answering “Yes” reveals the Employer field, live");
await pv.fill(`[data-qid="${cf}"] .rs-field-row input`, "Acme");
assert.deepEqual(await h.answerOf(pv, cf), { employer: "Acme" }, "fields shape, keyed by row code");
await pv.click(`[data-qid="${gate.id}"] .rs-option:has-text("No") input`);
await pv.waitForTimeout(150);
labels = await pv.$$eval(`[data-qid="${cf}"] .rs-field-row .flab`, (es) => es.map((e) => e.textContent.trim()));
assert.deepEqual(labels, ["Why not?"], "changing the answer swaps which field is shown, live");
ok("conditional form: a row's visibleIf appears and disappears live as the other question is answered");

/* required only bites on the visible field */
await pv.close();
pv = await h.preview([gate.id, cf], (d) => {
  const q = d.questions.find((x) => x.id === cf);
  q.required = true;
  q.rows[0].required = true;
  q.rows[1].required = true;
});
await pv.click(`[data-qid="${gate.id}"] .rs-option:has-text("Yes") input`);
await h.next(pv);
assert.ok(await pv.$(`[data-qid="${cf}"]`), "the visible required field blocks Next");
assert.match(await pv.textContent(`[data-qid="${cf}"]`), /Employer: this field is required/);
assert.ok(!/Why not/.test(await pv.textContent(`[data-qid="${cf}"]`)),
  "the hidden field is not demanded — that is the whole point of the condition");
await pv.fill(`[data-qid="${cf}"] .rs-field-row input`, "Acme");
await h.next(pv);
assert.ok(!(await pv.$(`[data-qid="${cf}"]`)), "the visible field answered, so Next advances");
ok("conditional form: validation follows visibility — hidden fields are never demanded");
await pv.close();

/* ============================================= all together, for the eye */
pv = await h.preview(ids("star_matrix", "constant_sum", "dragdrop_matrix", "dynamic_list", "editable_table", "repeating"));
await pv.click(`[data-qid="${sm}"] .rs-starmatrix-row[data-row="1"] button[data-star="4"]`);
await pv.click(`[data-qid="${sm}"] .rs-starmatrix-row[data-row="2"] button[data-star="2"]`);
await pv.click(`[data-qid="${sm}"] .rs-starmatrix-row[data-row="3"] button[data-star="5"]`);
await pv.fill(cell("speed", "c1"), "60");
await pv.fill(cell("speed", "c2"), "40");
await pv.fill(cell("price", "c1"), "70");
await pv.fill(cell("price", "c2"), "50");
await pv.click(chip("1")); await pv.click(col("love"));
await pv.click(chip("2")); await pv.click(col("meh"));
await pv.fill(line(0), "Apples");
await pv.click(`[data-qid="${dl}"] [data-testid="dynlist-add"]`);
await pv.fill(line(1), "Pears");
await pv.fill(sheetCell("1", "c1"), "Widget");
await pv.fill(sheetCell("1", "c2"), "Blue");
await pv.fill(sheetCell("1", "c3"), "12");
await pv.fill(sheetCell("2", "c1"), "Gadget");
await pv.fill(entryField(0, "name"), "Ada");
await pv.fill(entryField(0, "email"), "ada@example.com");
await pv.click(`[data-qid="${rf}"] [data-testid="repeatform-add"]`);
await pv.fill(entryField(1, "name"), "Bob");
await pv.waitForTimeout(250);
await pv.screenshot({ path: "/tmp/variants-g2-variants.png", fullPage: true });
await pv.setViewportSize({ width: 380, height: 1000 });
await pv.waitForTimeout(400);
/**
 * Nothing a variant draws may spill out of the phone. Wide grids are
 * allowed to scroll inside their own `.rs-table-wrap` — the platform's own
 * pattern for a matrix — so anything inside one is not a spill; everything
 * else has to fit. (The preview toolbar's debug pill overflows at 380px on
 * its own account; scoping the check to the question cards keeps this suite
 * about the variants.)
 */
const overflow = await pv.evaluate(() => {
  const vw = window.innerWidth;
  let worst = 0;
  let who = "";
  for (const el of document.querySelectorAll("[data-qid], [data-qid] *")) {
    if (el.closest(".rs-table-wrap") && !el.classList.contains("rs-table-wrap")) continue;
    const r = el.getBoundingClientRect();
    if (r.width > 0 && r.right - vw > worst) {
      worst = r.right - vw;
      who = el.getAttribute("class") || el.tagName;
    }
  }
  // a text box whose content is longer than the box is not a layout fault
  const scrollers = [...document.querySelectorAll("[data-qid] *")].filter(
    (el) => el.scrollWidth > el.clientWidth + 1
      && !el.classList.contains("rs-table-wrap")
      && !["INPUT", "TEXTAREA", "SELECT"].includes(el.tagName),
  ).map((el) => el.getAttribute("class") || el.tagName);
  return { worst: Math.round(worst), who, scrollers };
});
await pv.screenshot({ path: "/tmp/variants-g2-mobile.png", fullPage: true });
assert.ok(overflow.worst <= 1,
  `nothing overflows horizontally at 380px (worst ${overflow.worst}px on ${overflow.who})`);
assert.deepEqual(overflow.scrollers, [],
  "only a .rs-table-wrap may scroll sideways; nothing else clips its own content");
ok("all six rendered variants answered together; no horizontal overflow at 380px");
await pv.close();

await h.close();
console.log(`\nALL GRID / LIST / FORM VARIANT CHECKS PASSED (${checks} groups)`);

/**
 * Sliders / numbers / rich text — the seven variants of group G1:
 *
 *   numeric.numeric_range         numeric_list   { from, to }
 *   slider.dual                   numeric_list   { from, to }
 *   slider.vertical               slider         number
 *   slider.multi_attribute        matrix_numeric { rowCode: number }
 *   slider.allocation_slider      allocation     { code: number }
 *   allocation.slider_allocation  allocation     { code: number }
 *   text.rich_text                long_text      sanitized HTML string
 *
 * Each is created from the picker, rendered in the runtime, answered with the
 * mouse and the keyboard, and checked against its response model and the
 * ordinary validators.
 */
import { openHarness, assert } from "./lib/variantHarness.mjs";

const h = await openHarness();
const made = {};

/* ------------------------------------------ driving native range inputs */

/** Press a horizontal track at a fraction of its length — the thumb jumps
 *  there, which is how a respondent aims a slider with one click. */
async function clickTrack(pv, sel, frac) {
  const b = await (await pv.$(sel)).boundingBox();
  await pv.mouse.click(b.x + 9 + frac * (b.width - 18), b.y + b.height / 2);
  await pv.waitForTimeout(140);
}
/** The same for the vertical track: `frac` is measured from the BOTTOM, so
 *  0.8 is near the maximum. */
async function clickTrackV(pv, sel, frac) {
  const b = await (await pv.$(sel)).boundingBox();
  await pv.mouse.click(b.x + b.width / 2, b.y + b.height - 9 - frac * (b.height - 18));
  await pv.waitForTimeout(140);
}
/** Drag a thumb from one fraction of the track to another (real pointer
 *  events — the dual slider's thumbs are the only pointer targets on it). */
async function dragThumb(pv, sel, fromFrac, toFrac) {
  const b = await (await pv.$(sel)).boundingBox();
  const at = (f) => b.x + 10 + f * (b.width - 20);
  const y = b.y + b.height / 2;
  await pv.mouse.move(at(fromFrac), y);
  await pv.mouse.down();
  await pv.mouse.move(at((fromFrac + toFrac) / 2), y, { steps: 5 });
  await pv.mouse.move(at(toFrac), y, { steps: 5 });
  await pv.mouse.up();
  await pv.waitForTimeout(160);
}
/** Set a range to an exact value the way the browser does on a drag: through
 *  the native value setter, so React's value tracker sees the change. */
async function setRange(pv, sel, v) {
  await pv.$eval(sel, (el, val) => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set.call(el, String(val));
    el.dispatchEvent(new Event("input", { bubbles: true }));
  }, v);
  await pv.waitForTimeout(120);
}

/* ------------------------------------------------ create every variant */
made.numeric_range = await h.createFromPicker("numeric", "numeric.numeric_range");
for (const k of ["dual", "vertical", "multi_attribute", "allocation_slider"]) {
  made[k] = await h.createFromPicker("slider", `slider.${k}`);
}
made.slider_allocation = await h.createFromPicker("allocation", "allocation.slider_allocation");
made.rich_text = await h.createFromPicker("text", "text.rich_text");
console.log("✔ all 7 G1 variants are stable in the picker and create with their variant id");

/* ------------------------------------------------ base types + seeded defaults */
assert.equal(made.numeric_range.type, "numeric_list");
assert.deepEqual(made.numeric_range.rows.map((r) => r.code), ["from", "to"]);
assert.equal(made.numeric_range.settings.rangePair, true);

assert.equal(made.dual.type, "numeric_list", "the dual slider IS the numeric range, dragged");
assert.deepEqual(made.dual.rows.map((r) => r.code), ["from", "to"]);
assert.equal(made.dual.settings.maxValue, 100);

assert.equal(made.vertical.type, "slider");
assert.equal(made.vertical.settings.orientation, "vertical");

assert.equal(made.multi_attribute.type, "matrix_numeric");
assert.equal(made.multi_attribute.rows.length, 3, "three starter attributes");
assert.equal(made.multi_attribute.settings.sliderLayout, "stack");

for (const k of ["allocation_slider", "slider_allocation"]) {
  assert.equal(made[k].type, "allocation");
  assert.equal(made[k].settings.sumTarget, 100);
  assert.equal(made[k].options.length, 3);
}

assert.equal(made.rich_text.type, "long_text");
console.log("✔ base types and seeded defaults are right");

/* ------------------------------------------------ Studio: the slidermatrix layout select */
await h.goTab("Questions");
const cards = await h.page.$$('[data-testid="qcard"]');
await cards[3].click(); // multi-attribute slider
await h.page.waitForSelector('[data-testid="slider-layout"]');
await h.page.selectOption('[data-testid="slider-layout"]', "grid");
await h.page.waitForTimeout(300);
// reading the definition leaves the Questions tab, so reopen the editor
let def = await h.readDef();
assert.equal(def.questions[3].settings.sliderLayout, "grid", "the editor writes settings.sliderLayout");
await h.goTab("Questions");
await (await h.page.$$('[data-testid="qcard"]'))[3].click();
await h.page.waitForSelector('[data-testid="slider-layout"]');
await h.page.selectOption('[data-testid="slider-layout"]', "stack");
await h.page.waitForTimeout(300);
def = await h.readDef();
assert.equal(def.questions[3].settings.sliderLayout, "stack");
await h.goTab("Questions");
await h.page.click('[data-testid="close-question"]').catch(() => {});
console.log("✔ Studio: the multi-slider layout select writes settings.sliderLayout");

/* ============================================================== runtime */
const id = (k) => made[k].id;
const q = (k) => `[data-qid="${id(k)}"]`;

let pv = await h.preview([
  id("numeric_range"), id("dual"), id("vertical"),
  id("multi_attribute"), id("allocation_slider"), id("rich_text"),
]);

// how they look before anyone has answered — no slider may read as answered
await pv.screenshot({ path: "/tmp/variants-g1-fresh.png", fullPage: true });

/* ---------------------------------------------------------- numeric range */
await pv.fill(`${q("numeric_range")} [data-row="from"] input`, "40");
await pv.fill(`${q("numeric_range")} [data-row="to"] input`, "10");
await pv.waitForTimeout(150);
assert.deepEqual(await h.answerOf(pv, id("numeric_range")), { from: 40, to: 10 },
  "the pair stores as a two-field object");
await h.next(pv);
assert.ok(await pv.$(q("numeric_range")), "still on the page: from > to is refused");
assert.match(await pv.textContent(q("numeric_range")), /must not be greater/,
  "the engine's rangePair rule shows on the question");
await pv.fill(`${q("numeric_range")} [data-row="to"] input`, "70");
await pv.waitForTimeout(150);
assert.deepEqual(await h.answerOf(pv, id("numeric_range")), { from: 40, to: 70 });
console.log("✔ numeric range: {from,to}, from > to blocked on Next, from <= to accepted");

/* -------------------------------------------------------------- dual slider */
const dualLo = `${q("dual")} .rs-rangeslider-input.lo`;
const dualHi = `${q("dual")} .rs-rangeslider-input.hi`;
assert.ok(await pv.$(`${q("dual")} [data-row="from"]`), "the lower handle is the 'from' row");
// keyboard: focus a handle and arrow it
await pv.focus(dualLo);
for (let i = 0; i < 5; i++) await pv.keyboard.press("ArrowRight");
await pv.waitForTimeout(150);
let dualVal = await h.answerOf(pv, id("dual"));
assert.equal(dualVal.from, 5, "ArrowRight moves the lower handle one step at a time");
assert.equal(dualVal.to, 100, "the upper handle keeps its position");
await pv.focus(dualHi);
for (let i = 0; i < 3; i++) await pv.keyboard.press("ArrowLeft");
await pv.waitForTimeout(150);
dualVal = await h.answerOf(pv, id("dual"));
assert.deepEqual(dualVal, { from: 5, to: 97 }, "both handles store into the same from–to pair");
assert.match(await pv.textContent(`${q("dual")} [data-testid="range-readout"]`), /5\s*–\s*97/,
  "the readout shows the live range");
// a real pointer drag of the upper handle, all the way past the lower one
await dragThumb(pv, dualHi, 0.97, 0);
dualVal = await h.answerOf(pv, id("dual"));
assert.equal(dualVal.to, 5, "dragging the upper handle past the lower one clamps at it");
assert.ok(dualVal.from <= dualVal.to, "from <= to always holds in the UI");
// and back out again, so the range is a range in the screenshot
await dragThumb(pv, dualHi, 0.05, 0.75);
dualVal = await h.answerOf(pv, id("dual"));
assert.ok(dualVal.to > 60 && dualVal.to <= 100, `dragging right widens the range (to=${dualVal.to})`);
console.log("✔ dual slider: keyboard + pointer handles, clamped, stores {from,to}");

/* ---------------------------------------------------------- vertical slider */
const vs = `${q("vertical")} .rs-vslider-input`;
assert.equal(await h.answerOf(pv, id("vertical")), undefined, "untouched: no answer yet");
assert.equal(await pv.textContent(`${q("vertical")} [data-testid="vslider-val"]`), "—");
await pv.focus(vs);
await pv.keyboard.press("ArrowUp");
await pv.waitForTimeout(150);
const vVal = await h.answerOf(pv, id("vertical"));
assert.equal(typeof vVal, "number", "a vertical slider stores a plain number");
assert.equal(vVal, 51, "ArrowUp increases the value — the maximum is at the top");
assert.equal(await pv.textContent(`${q("vertical")} [data-testid="vslider-val"]`), "51");
// clicking the upper part of the track jumps the handle up, not down
await clickTrackV(pv, vs, 0.8);
const vHigh = await h.answerOf(pv, id("vertical"));
assert.ok(vHigh > 65, `clicking near the top gives a high value (got ${vHigh})`);
// the track is taller than it is wide — it really is vertical
const vBox = await (await pv.$(vs)).boundingBox();
assert.ok(vBox.height > vBox.width * 3, `vertical track: ${vBox.width}x${vBox.height}`);
console.log("✔ vertical slider: numeric, min at the bottom, mouse and keyboard");

/* ------------------------------------------------------ multi-attribute */
const ma = q("multi_attribute");
assert.equal((await pv.$$(`${ma} .rs-slidermatrix-input`)).length, 3, "one slider per attribute");
assert.equal(await pv.textContent(`${ma} [data-value-for="r1"]`), "—", "untouched rows read —");
assert.equal(await h.answerOf(pv, id("multi_attribute")), undefined);
await clickTrack(pv, `${ma} [data-row="r1"]`, 0.8);
const maR1 = (await h.answerOf(pv, id("multi_attribute"))).r1;
assert.ok(maR1 > 70 && maR1 < 90, `clicking at 80% of the track sets ~80 (got ${maR1})`);
assert.equal(await pv.textContent(`${ma} [data-value-for="r1"]`), String(maR1),
  "the row's readout shows its own value");
await pv.focus(`${ma} [data-row="r2"]`);
await pv.keyboard.press("Home");
await pv.waitForTimeout(150);
await pv.focus(`${ma} [data-row="r3"]`);
await pv.keyboard.press("ArrowRight");
await pv.waitForTimeout(150);
assert.deepEqual(await h.answerOf(pv, id("multi_attribute")), { r1: maR1, r2: 0, r3: 51 },
  "one number per row, keyed by row code — 0 is an answer");
console.log("✔ multi-attribute slider: {row: number} per attribute, mouse and keyboard");

/* ------------------------------------------------------ allocation slider */
{
  const a = q("allocation_slider");
  const alloc = () => h.answerOf(pv, id("allocation_slider"));
  await clickTrack(pv, `${a} [data-code="1"]`, 0.6);
  const first = (await alloc())[1];
  assert.ok(first > 50 && first < 70, `clicking at 60% assigns ~60 (got ${first})`);
  await setRange(pv, `${a} [data-code="1"]`, 60);
  await setRange(pv, `${a} [data-code="2"]`, 30);
  assert.match(await pv.textContent(`${a} [data-testid="alloc-total"]`), /90 \/ 100/);
  assert.match(await pv.textContent(`${a} [data-testid="alloc-total"]`), /10 % left to assign/);
  // pushing the third past the remaining budget is clamped, not rebalanced
  await setRange(pv, `${a} [data-code="3"]`, 100);
  const final = await alloc();
  assert.deepEqual(final, { 1: 60, 2: 30, 3: 10 }, "the third slider stops at the remaining 10");
  assert.equal(Object.values(final).reduce((x, y) => x + y, 0), 100,
    "the total can never exceed the target");
  assert.match(await pv.textContent(`${a} [data-testid="alloc-total"]`), /100 \/ 100/);
  assert.match(await pv.getAttribute(`${a} [data-testid="alloc-total"]`, "class"), /ok/,
    "a met target reads as met");
  console.log("✔ allocation slider: {code: number}, clamped to the sum target");
}

/* ---------------------------------------------------------------- rich text */
const rt = q("rich_text");
assert.match(await pv.textContent(rt), /Type your answer/, "an empty surface shows its placeholder");
await pv.click(`${rt} [data-testid="richtext-surface"]`);
await pv.keyboard.type("plain and ");
await pv.click(`${rt} .rs-richtext-tool[data-cmd="bold"]`);
await pv.keyboard.type("bold");
await pv.waitForTimeout(200);
const html = await h.answerOf(pv, id("rich_text"));
assert.equal(typeof html, "string", "rich text stores a string, like any long_text");
assert.match(html, /<(b|strong)>/i, "the Bold button really formats");
assert.match(html, /plain and/);
assert.match(await pv.textContent(`${rt} [data-testid="char-counter"]`), /14 characters/,
  "the counter counts text, not markup");
await pv.click(`${rt} .rs-richtext-tool[data-cmd="insertUnorderedList"]`);
await pv.waitForTimeout(200);
assert.match(await h.answerOf(pv, id("rich_text")), /<(ul|li)>/i, "the list button makes a list");
console.log("✔ rich text: sanitized HTML in a long_text answer, toolbar works, counter counts text");

/* ----------------------------------------------- everything answered: screenshot */
await pv.waitForTimeout(250);
await pv.setViewportSize({ width: 1000, height: 1400 });
await pv.screenshot({ path: "/tmp/variants-g1-variants.png", fullPage: true });
// the preview's fixed toolbar sits over one card in a full-page shot, so the
// dual slider gets its own
await (await pv.$(q("dual"))).screenshot({ path: "/tmp/variants-g1-dual.png" });
await pv.setViewportSize({ width: 380, height: 1400 });
await pv.waitForTimeout(300);
// the questions themselves must fit — the preview's own debug toggle is a
// preview affordance and is deliberately parked off the right edge
const overflow = await pv.evaluate(() => {
  const w = document.documentElement.clientWidth;
  let worst = 0;
  for (const el of document.querySelectorAll("[data-qid], [data-qid] *")) {
    const r = el.getBoundingClientRect();
    worst = Math.max(worst, r.right - w, -r.left, el.scrollWidth - el.clientWidth);
  }
  return Math.round(worst);
});
await pv.screenshot({ path: "/tmp/variants-g1-mobile.png", fullPage: true });
assert.ok(overflow <= 0, `nothing overflows horizontally at 380px (overflow ${overflow}px)`);
console.log("✔ nothing overflows horizontally at 380px");
await pv.close();

/* ------------------------------------------- required blocks every variant */
const REQUIRED = [
  ["numeric_range", /required/i],
  ["dual", /required/i],
  ["vertical", /required/i],
  ["multi_attribute", /Please answer for/i],
  ["allocation_slider", /required/i],
  ["slider_allocation", /required/i],
  ["rich_text", /required/i],
];
for (const [k, re] of REQUIRED) {
  pv = await h.preview([id(k)], (d) => { d.questions.find((x) => x.id === id(k)).required = true; });
  await h.next(pv);
  assert.ok(await pv.$(q(k)), `${k}: an unanswered required question keeps the respondent on the page`);
  assert.match(await pv.textContent(".rs-shell"), re, `${k}: the ordinary required rule applies`);
  await pv.close();
}
console.log("✔ required blocks Next on all 7 — nothing here is special to the engine");

/* ------------------- the grid layout of slidermatrix (what matrix.slider_matrix uses) */
pv = await h.preview([id("multi_attribute")], (d) => {
  const target = d.questions.find((x) => x.id === id("multi_attribute"));
  target.settings.sliderLayout = "grid";
  target.settings.sliderLeftLabel = "Poor";
  target.settings.sliderRightLabel = "Excellent";
});
const gridQ = q("multi_attribute");
assert.equal(await pv.getAttribute(`${gridQ} [data-testid="slidermatrix"]`, "data-layout"), "grid");
assert.equal((await pv.$$(`${gridQ} .rs-slidermatrix-gridrow`)).length, 3, "one compact row per attribute");
assert.match(await pv.textContent(`${gridQ} .rs-slidermatrix-head`), /Poor[\s\S]*Excellent/,
  "the end labels head the grid once");
await setRange(pv, `${gridQ} [data-row="r2"]`, 42);
assert.deepEqual(await h.answerOf(pv, id("multi_attribute")), { r2: 42 },
  "the grid layout writes the same per-row model");
await pv.screenshot({ path: "/tmp/variants-g1-grid.png", fullPage: true });
await pv.close();
console.log("✔ slidermatrix renders both layouts — the Grid / Matrix family can reuse it");

/* ---------------------------------- the second allocation entry, same renderer */
pv = await h.preview([id("slider_allocation")]);
await setRange(pv, `${q("slider_allocation")} [data-code="1"]`, 100);
assert.deepEqual(await h.answerOf(pv, id("slider_allocation")), { 1: 100 });
await setRange(pv, `${q("slider_allocation")} [data-code="2"]`, 50);
assert.deepEqual(await h.answerOf(pv, id("slider_allocation")), { 1: 100, 2: 0 },
  "with the budget spent, the next slider cannot take any of it");
await pv.close();
console.log("✔ allocation.slider_allocation shares the renderer and the model with slider.allocation_slider");

await h.close();
console.log("\nALL G1 (SLIDER / NUMERIC / TEXT / ALLOCATION) VARIANT CHECKS PASSED");

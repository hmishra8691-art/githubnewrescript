/**
 * Carousel / Cards / Comparison variant families (6 variants): created from
 * the picker, rendered in the runtime, answered with mouse, keyboard and a
 * real pointer swipe, and the answer checked against the response model.
 *
 *   carousel.judge        matrix_single | matrix_numeric | matrix_text  → { rowCode: value }
 *   carousel.comparison   single_select                                → code
 *   card.rich             single_select                                → code
 *   card.flip             single_select                                → code
 *   card.sortable         matrix_single                                → { rowCode: optionCode }
 *   comparison.attributes single_select                                → code
 */
import { openHarness, assert } from "./lib/variantHarness.mjs";

const h = await openHarness();
const made = {};
const qid = (k) => made[k].id;

/* ------------------------------------------------ create every variant */
for (const k of ["judge", "comparison"]) made[k] = await h.createFromPicker("carousel", `carousel.${k}`);
for (const k of ["rich", "flip", "sortable"]) made[k] = await h.createFromPicker("card", `card.${k}`);
made.attributes = await h.createFromPicker("comparison", "comparison.attributes");
console.log("✔ all 6 carousel / card / comparison variants are stable in the picker and create with their variant id");

/* the tournament entry built in another batch is merged alongside: both stable */
await h.goTab("Questions");
await h.page.click('[data-testid="add-question-top"]');
await h.page.waitForSelector('[data-testid="picker-family-comparison"]');
await h.page.click('[data-testid="picker-family-comparison"]');
const tourn = await h.page.waitForSelector('[data-testid="picker-variant-comparison.tournament"]');
assert.equal(await tourn.getAttribute("data-status"), "stable", "the tournament comparison is stable too");
const attrCard = await h.page.$('[data-testid="picker-variant-comparison.attributes"]');
assert.ok(!!attrCard);
assert.equal(await attrCard.getAttribute("data-status"), "stable");
await h.page.click('.modal button:has-text("close")');
await h.page.waitForTimeout(200);
console.log("✔ comparison family: attribute comparison and tournament are both stable");

/* ------------------------------------------------ base types + seeded defaults */
assert.equal(made.judge.type, "matrix_single", "judge starts as a choice matrix");
assert.equal(made.judge.rows.length, 3, "judge seeds three carousel items");
assert.equal(made.judge.options.length, 3, "judge seeds a three-point scale");
assert.equal(made.judge.settings.maxValue, 10, "judge seeds slider bounds for the numeric mode");
assert.equal(made.comparison.type, "single_select");
assert.equal(made.comparison.options.length, 3);
assert.equal(made.rich.type, "single_select");
assert.equal(made.rich.settings.columnsLayout, 3, "rich cards default to a three-column grid");
assert.equal(made.flip.type, "single_select");
assert.equal(made.flip.options[0].meta.description.length > 0, true, "flip cards seed a description to reveal");
assert.equal(made.sortable.type, "matrix_single");
assert.equal(made.sortable.rows.length, 3, "the deck seeds three cards");
assert.equal(made.sortable.options.length, 2, "the sort seeds two piles");
assert.equal(made.attributes.type, "single_select");
assert.equal(made.attributes.rows.length, 3, "the comparison seeds Price / Warranty / Weight");
assert.equal(made.attributes.rows[0].code, "price");
assert.equal(made.attributes.options.length, 2);
assert.equal(made.attributes.options[0].meta.attributes.price, "$249", "seeded cells live in option.meta.attributes");
console.log("✔ base types and seeded defaults are right");

/* reading the definition switches to the JSON tab, so re-open the editor after each read */
const openQ = async (i, waitFor) => {
  await h.goTab("Questions");
  await h.page.click('[data-testid="close-question"]').catch(() => {});
  const qc = await h.page.$$('[data-testid="qcard"]');
  await qc[i].click();
  await h.page.waitForSelector(waitFor);
};

/* ------------------------------------------------ Studio: the attribute grid edits meta.attributes */
await openQ(5, '[data-testid="attr-grid"]'); // the attribute comparison
await h.page.fill('[data-testid="attr-cell-0-1"]', "$275");
await h.page.waitForTimeout(250);
let def = await h.readDef();
assert.equal(def.questions[5].options[1].meta.attributes.price, "$275", "a grid cell writes to option.meta.attributes[rowCode]");

await openQ(5, '[data-testid="attr-add"]');
await h.page.click('[data-testid="attr-add"]');
await h.page.waitForSelector('[data-testid="attr-label-3"]');
await h.page.fill('[data-testid="attr-label-3"]', "Colour");
await h.page.fill('[data-testid="attr-cell-3-0"]', "Graphite");
await h.page.waitForTimeout(250);
def = await h.readDef();
assert.equal(def.questions[5].rows.length, 4, "the grid adds an attribute row");
assert.equal(def.questions[5].rows[3].label, "Colour");
const newCode = def.questions[5].rows[3].code;
assert.equal(def.questions[5].options[0].meta.attributes[newCode], "Graphite", "a new attribute's cells are written under its code");

await openQ(5, '[data-testid="attr-remove-3"]');
await h.page.click('[data-testid="attr-remove-3"]');
await h.page.waitForTimeout(250);
def = await h.readDef();
assert.equal(def.questions[5].rows.length, 3, "removing an attribute removes its cells too");
assert.equal(def.questions[5].options[0].meta.attributes[newCode], undefined);
console.log("✔ Studio: the attribute grid edits rows and per-option attribute cells");

/* ------------------------------------------------ Studio: the judgement select rewrites the base type */
await openQ(0, '[data-testid="judge-cards"]'); // the judge carousel
await h.page.fill('[data-testid="judge-row-description-0"]', "First item on the belt");
await h.page.waitForTimeout(250);
def = await h.readDef();
assert.equal(def.questions[0].rows[0].meta.description, "First item on the belt", "per-card blurb writes to row.meta.description");
console.log("✔ Studio: the per-item card grid edits row.meta.image / description");

const setJudgement = async (mode) => {
  await openQ(0, '[data-testid="judge-mode"]');
  await h.page.selectOption('[data-testid="judge-mode"]', mode);
  await h.page.waitForTimeout(350);
  const d = await h.readDef();
  return d.questions[0];
};

/* ------------------------------------------------ runtime: judge in choice mode */
let pv = await h.preview([qid("judge")]);
const J = qid("judge");
assert.match(await pv.textContent(`[data-qid="${J}"] [data-testid="judge-position"]`), /Item 1 of 3/);
await pv.click(`[data-qid="${J}"] .rs-judge-btn[data-row="1"][data-code="3"]`);
assert.deepEqual(await h.answerOf(pv, J), { 1: 3 }, "a choice stores { rowCode: optionCode }");
assert.match(await pv.textContent(`[data-qid="${J}"] [data-testid="judge-position"]`), /Item 2 of 3/, "judging auto-advances to the next unjudged item");
assert.match(await pv.textContent(`[data-qid="${J}"] [data-testid="judge-progress"]`), /1 of 3 judged/);
assert.ok(await pv.$(`[data-qid="${J}"] .rs-carousel-dots .dot.picked[data-row="1"]`), "the judged item's dot is ticked");
// keyboard: the dots navigate, the scale buttons are real buttons
await pv.focus(`[data-qid="${J}"] .rs-carousel-dots .dot[data-row="3"]`);
await pv.keyboard.press("Enter");
assert.match(await pv.textContent(`[data-qid="${J}"] [data-testid="judge-position"]`), /Item 3 of 3/, "a dot jumps to that item from the keyboard");
await pv.focus(`[data-qid="${J}"] .rs-judge-btn[data-row="3"][data-code="1"]`);
await pv.keyboard.press("Enter");
assert.deepEqual(await h.answerOf(pv, J), { 1: 3, 3: 1 }, "the scale is keyboard-operable");
await pv.click(`[data-qid="${J}"] .rs-judge-btn[data-row="2"][data-code="2"]`);
assert.deepEqual(await h.answerOf(pv, J), { 1: 3, 3: 1, 2: 2 });
await pv.close();
console.log("✔ carousel judge (choice): stores { row: code }, auto-advances, dots tick, keyboard works");

/* required blocks until every item is judged */
pv = await h.preview([J], (d) => { d.questions.find((q) => q.id === J).required = true; });
await pv.click(`[data-qid="${J}"] .rs-judge-btn[data-row="1"][data-code="1"]`);
await h.next(pv);
assert.ok(await pv.$(`[data-qid="${J}"]`), "one item judged is not enough — still on the page");
assert.match(await pv.textContent(".rs-shell"), /Please answer for/i, "the ordinary matrix validator asks for the rest");
await pv.click(`[data-qid="${J}"] .rs-judge-btn[data-row="2"][data-code="1"]`);
await pv.click(`[data-qid="${J}"] .rs-judge-btn[data-row="3"][data-code="1"]`);
await h.next(pv);
assert.ok(!(await pv.$(`[data-qid="${J}"]`)), "with every item judged, Next advances");
await pv.close();
console.log("✔ carousel judge: required means every item judged — the existing matrix validator, unchanged");

/* ------------------------------------------------ runtime: judge as a slider */
let judgeQ = await setJudgement("slider");
assert.equal(judgeQ.type, "matrix_numeric", "Judgement → Slider switches the base type");
assert.equal(judgeQ.variant, "carousel.judge", "the variant id survives the switch");
pv = await h.preview([J]);
assert.ok(await pv.$(`[data-qid="${J}"] [data-testid="judge-slider-1"]`), "the slider mode renders a range input");
assert.ok(!(await pv.$(`[data-qid="${J}"] .rs-judge-btn`)), "no choice scale in slider mode");
// drive it as a respondent would: the handle is keyboard-operable, starting
// from the midpoint of 0–10 with nothing stored yet
await pv.focus(`[data-qid="${J}"] [data-testid="judge-slider-1"]`);
await pv.keyboard.press("ArrowRight");
await pv.waitForTimeout(120);
assert.deepEqual(await h.answerOf(pv, J), { 1: 6 }, "the slider stores { rowCode: number }");
await pv.keyboard.press("ArrowRight");
await pv.waitForTimeout(120);
assert.deepEqual(await h.answerOf(pv, J), { 1: 7 }, "and every step updates that row only");
assert.match(await pv.textContent(`[data-qid="${J}"] .rs-judge-val`), /7/);
assert.match(await pv.textContent(`[data-qid="${J}"] [data-testid="judge-position"]`), /Item 1 of 3/, "a slider does not auto-advance mid-drag");
await pv.close();
console.log("✔ carousel judge (slider): matrix_numeric, stores { row: number }, ends labelled");

/* ------------------------------------------------ runtime: judge as text */
judgeQ = await setJudgement("text");
assert.equal(judgeQ.type, "matrix_text", "Judgement → Text switches the base type");
assert.equal(judgeQ.variant, "carousel.judge");
pv = await h.preview([J]);
await pv.fill(`[data-qid="${J}"] [data-testid="judge-text-1"]`, "Bright, but too heavy");
await pv.waitForTimeout(150);
assert.deepEqual(await h.answerOf(pv, J), { 1: "Bright, but too heavy" }, "the comment stores { rowCode: string }");
assert.match(await pv.textContent(`[data-qid="${J}"] [data-testid="judge-position"]`), /Item 1 of 3/, "typing does not auto-advance");
await pv.close();
console.log("✔ carousel judge (text): matrix_text, stores { row: string }");

judgeQ = await setJudgement("choice");
assert.equal(judgeQ.type, "matrix_single", "and back to a choice matrix");

/* ------------------------------------------------ runtime: comparison carousel */
pv = await h.preview([qid("comparison")]);
const C = qid("comparison");
assert.match(await pv.textContent(`[data-qid="${C}"] [data-testid="comparecar-position"]`), /Pair 1 of 2/);
assert.ok(await pv.$(`[data-qid="${C}"] .rs-comparecar-side[data-code="1"]`), "the window starts on items 1 and 2");
assert.ok(await pv.$(`[data-qid="${C}"] .rs-comparecar-side[data-code="2"]`));
assert.ok(!(await pv.$(`[data-qid="${C}"] .rs-comparecar-side[data-code="3"]`)));
await pv.click(`[data-qid="${C}"] .rs-carousel-nav[aria-label="Next"]`);
assert.ok(await pv.$(`[data-qid="${C}"] .rs-comparecar-side[data-code="3"]`), "‹ › slides the window by one item");
assert.ok(await pv.$(`[data-qid="${C}"] .rs-comparecar-side[data-code="2"]`), "the second item carries over into the next pair");
assert.match(await pv.textContent(`[data-qid="${C}"] [data-testid="comparecar-position"]`), /Pair 2 of 2/);
await pv.click(`[data-qid="${C}"] .rs-comparecar-side[data-code="2"] .rs-richcard-select`);
assert.equal(await h.answerOf(pv, C), 2, "choosing a side stores that option's code");
assert.match(await pv.textContent(`[data-qid="${C}"] [data-testid="comparecar-pick"]`), /Your pick: *Item B/, "the pick is announced above the carousel");
await pv.click(`[data-qid="${C}"] .rs-carousel-nav[aria-label="Previous"]`);
assert.ok(await pv.$(`[data-qid="${C}"] .rs-comparecar-side.selected[data-code="2"]`), "the chosen item stays highlighted wherever it appears");
await pv.close();
console.log("✔ comparison carousel: sliding window of two, stores the code, announces the pick");

/* ------------------------------------------------ runtime: rich cards */
pv = await h.preview([qid("rich")], (d) => {
  d.questions.find((q) => q.id === qid("rich")).options = [
    { code: 1, label: "Alpha", flags: [], meta: { description: "First", price: "$10" } },
    { code: 2, label: "Beta", flags: [], meta: { description: "Second", price: "$20" } },
  ];
});
await pv.click(`[data-qid="${qid("rich")}"] .rs-richcard[data-code="2"]`);
assert.equal(await h.answerOf(pv, qid("rich")), 2, "rich cards store the code (the shared richcards renderer)");
await pv.close();
console.log("✔ card.rich: the existing rich-card grid, three columns by default");

/* ------------------------------------------------ runtime: flip cards */
pv = await h.preview([qid("flip")]);
const F = qid("flip");
assert.ok(!(await pv.$(`[data-qid="${F}"] .rs-flipcard[data-flipped]`)), "nothing is flipped to begin with");
await pv.click(`[data-qid="${F}"] [data-testid="flip-front-1"]`);
await pv.waitForTimeout(120);
assert.ok(await pv.$(`[data-qid="${F}"] .rs-flipcard[data-code="1"][data-flipped]`), "Details flips the card");
assert.match(await pv.textContent(`[data-qid="${F}"] .rs-flipcard[data-code="1"] .rs-flipface.back`), /respondent sees after flipping/, "the back shows meta.description");
await pv.click(`[data-qid="${F}"] [data-testid="flip-front-2"]`);
await pv.waitForTimeout(120);
assert.equal((await pv.$$(`[data-qid="${F}"] .rs-flipcard[data-flipped]`)).length, 1, "only one card is flipped at a time");
assert.ok(await pv.$(`[data-qid="${F}"] .rs-flipcard[data-code="2"][data-flipped]`));
await pv.click(`[data-qid="${F}"] [data-testid="flip-back-2"]`);
await pv.waitForTimeout(120);
assert.ok(!(await pv.$(`[data-qid="${F}"] .rs-flipcard[data-flipped]`)), "Back closes the flip");
await pv.focus(`[data-qid="${F}"] [data-testid="flip-front-3"]`);
await pv.keyboard.press("Enter");
await pv.waitForTimeout(120);
assert.ok(await pv.$(`[data-qid="${F}"] .rs-flipcard[data-code="3"][data-flipped]`), "Enter on a card flips it");
await pv.click(`[data-qid="${F}"] [data-testid="flip-select-3"]`);
await pv.waitForTimeout(150);
assert.equal(await h.answerOf(pv, F), 3, "Select stores the code");
assert.ok(!(await pv.$(`[data-qid="${F}"] .rs-flipcard[data-flipped]`)), "selecting closes the flip");
assert.ok(await pv.$(`[data-qid="${F}"] .rs-flipcard.selected[data-code="3"]`), "the selected card is marked");
assert.match(await pv.textContent(`[data-qid="${F}"] .rs-flipcard[data-code="3"] .rs-flipface.front`), /Selected/);
await pv.close();
console.log("✔ card.flip: flips on click and Enter, one at a time, Select stores the code and unflips");

/* ------------------------------------------------ runtime: card sort */
pv = await h.preview([qid("sortable")]);
const S = qid("sortable");
assert.match(await pv.textContent(`[data-qid="${S}"] [data-testid="cardsort-position"]`), /Card 1 of 3/);
// a real pointer swipe to the right pile
const card = await pv.$(`[data-qid="${S}"] [data-testid="cardsort-card"]`);
assert.ok(!!card);
const box = await card.boundingBox();
const cx = box.x + box.width / 2, cy = box.y + box.height / 2;
await pv.mouse.move(cx, cy);
await pv.mouse.down();
await pv.mouse.move(cx + 40, cy, { steps: 4 });
await pv.mouse.move(cx + 130, cy, { steps: 6 });
await pv.waitForTimeout(60);
assert.ok(await pv.$(`[data-qid="${S}"] .rs-cardsort-verdict.right`), "dragging past the threshold previews the pile it will land in");
await pv.mouse.up();
await pv.waitForTimeout(150);
assert.deepEqual(await h.answerOf(pv, S), { 1: 2 }, "a right swipe commits the card to the second pile");
assert.match(await pv.textContent(`[data-qid="${S}"] [data-testid="cardsort-position"]`), /Card 2 of 3/);
assert.equal(await pv.textContent(`[data-qid="${S}"] [data-testid="cardsort-count-2"]`), "1", "the pile shows its count");
// drag the next card onto a pile and release there — direction does not matter
const card2 = await pv.$(`[data-qid="${S}"] [data-testid="cardsort-card"]`);
assert.ok(!!card2);
const b2 = await card2.boundingBox();
const pileEl = await pv.$(`[data-qid="${S}"] [data-testid="cardsort-pile-1"]`);
assert.ok(!!pileEl);
const pb = await pileEl.boundingBox();
await pv.mouse.move(b2.x + b2.width / 2, b2.y + b2.height / 2);
await pv.mouse.down();
await pv.mouse.move(pb.x + pb.width / 2, pb.y + pb.height / 2, { steps: 8 });
await pv.mouse.up();
await pv.waitForTimeout(150);
assert.deepEqual(await h.answerOf(pv, S), { 1: 2, 2: 1 }, "a card dropped on a pile lands in that pile");
await pv.click(`[data-qid="${S}"] [data-testid="cardsort-undo"]`);
await pv.waitForTimeout(100);
assert.deepEqual(await h.answerOf(pv, S), { 1: 2 }, "Undo takes it back out again");
// tap a pile for the next card
await pv.click(`[data-qid="${S}"] [data-testid="cardsort-pile-1"]`);
await pv.waitForTimeout(100);
assert.deepEqual(await h.answerOf(pv, S), { 1: 2, 2: 1 }, "tapping a pile commits the current card");
// the count chip lists what a pile holds
await pv.click(`[data-qid="${S}"] [data-testid="cardsort-count-1"]`);
await pv.waitForTimeout(100);
assert.match(await pv.textContent(`[data-qid="${S}"] [data-testid="cardsort-held-1"]`), /Card two/, "the pile lists the cards it holds");
// undo takes the last card back
await pv.click(`[data-qid="${S}"] [data-testid="cardsort-undo"]`);
await pv.waitForTimeout(100);
assert.deepEqual(await h.answerOf(pv, S), { 1: 2 }, "Undo removes the last assignment");
await pv.click(`[data-qid="${S}"] [data-testid="cardsort-pile-1"]`);
await pv.click(`[data-qid="${S}"] [data-testid="cardsort-pile-1"]`);
await pv.waitForTimeout(120);
assert.deepEqual(await h.answerOf(pv, S), { 1: 2, 2: 1, 3: 1 }, "the deck empties into the piles");
assert.match(await pv.textContent(`[data-qid="${S}"] [data-testid="cardsort-position"]`), /All 3 cards sorted/);
await pv.close();
console.log("✔ card.sortable: pointer swipe, drop on a pile, pile taps, counts, Undo — stores { row: pile }");

/* ------------------------------------------------ runtime: attribute comparison */
pv = await h.preview([qid("attributes")]);
const A = qid("attributes");
assert.equal(await pv.textContent(`[data-qid="${A}"] td[data-row="price"][data-code="1"]`), "$249", "cells come from option.meta.attributes[rowCode]");
assert.equal(await pv.textContent(`[data-qid="${A}"] td[data-row="price"][data-code="2"]`), "$275", "including the cell edited in the Studio grid");
assert.equal(await pv.textContent(`[data-qid="${A}"] td[data-row="weight"][data-code="2"]`), "0.9 kg");
assert.equal((await pv.$$(`[data-qid="${A}"] .rs-attrtable tbody tr`)).length, 3, "one row per attribute");
await pv.click(`[data-qid="${A}"] [data-testid="attr-choose-2"]`);
assert.equal(await h.answerOf(pv, A), 2, "Choose stores the item's code");
assert.match(await pv.textContent(`[data-qid="${A}"] [data-testid="attr-pick"]`), /Your pick: *Model B/);
assert.ok(await pv.$(`[data-qid="${A}"] .rs-attrtable thead th.chosen[data-code="2"]`), "the chosen column is highlighted");
await pv.close();
console.log("✔ comparison.attributes: attribute table from meta, Choose stores the code");

/* ------------------------------------------------ every variant: required blocks Next */
for (const k of ["judge", "comparison", "rich", "flip", "sortable", "attributes"]) {
  const id = qid(k);
  const p2 = await h.preview([id], (d) => {
    const q = d.questions.find((x) => x.id === id);
    q.required = true;
    if (k === "rich") q.options = [{ code: 1, label: "Alpha", flags: [] }];
  });
  await h.next(p2);
  assert.ok(await p2.$(`[data-qid="${id}"]`), `${k}: unanswered + required stays on the page`);
  assert.match(await p2.textContent(".rs-shell"), /required|Please answer/i, `${k}: the ordinary required validator fires`);
  await p2.close();
}
console.log("✔ required blocks Next for all six — nothing about these variants is special to the engine");

/* ------------------------------------------------ screenshots: all six, answered */
const allIds = ["judge", "comparison", "rich", "flip", "sortable", "attributes"].map(qid);
const seed = async (d) => {
  const r = d.questions.find((q) => q.id === qid("rich"));
  r.options = [
    { code: 1, label: "Nimbus 500", flags: [], meta: { description: "Mid-range, long battery", price: "$249", badge: "Popular" } },
    { code: 2, label: "Vector X", flags: [], meta: { description: "Light, premium finish", price: "$319" } },
    { code: 3, label: "Atlas Pro", flags: [], meta: { description: "Rugged, water resistant", price: "$289" } },
  ];
};
for (const [w, file] of [[1000, "/tmp/variants-g4-variants.png"], [380, "/tmp/variants-g4-variants-380.png"]]) {
  const shot = await h.preview(allIds, seed);
  await shot.setViewportSize({ width: w, height: 1000 });
  await shot.waitForTimeout(250);
  // answer everything so the screenshot shows the answered state
  await shot.click(`[data-qid="${qid("judge")}"] .rs-judge-btn[data-row="1"][data-code="3"]`);
  await shot.click(`[data-qid="${qid("judge")}"] .rs-judge-btn[data-row="2"][data-code="2"]`);
  await shot.click(`[data-qid="${qid("comparison")}"] .rs-comparecar-side[data-code="1"] .rs-richcard-select`);
  await shot.click(`[data-qid="${qid("rich")}"] .rs-richcard[data-code="1"]`);
  await shot.click(`[data-qid="${qid("flip")}"] [data-testid="flip-front-2"]`);
  await shot.waitForTimeout(200);
  await shot.click(`[data-qid="${qid("sortable")}"] [data-testid="cardsort-pile-2"]`);
  await shot.click(`[data-qid="${qid("attributes")}"] [data-testid="attr-choose-1"]`);
  await shot.waitForTimeout(250);

  /**
   * Nothing in the survey may push the page sideways; wide content scrolls
   * inside its own wrapper. Measured on `.rs-shell` rather than the document
   * because the preview's own toolbar (the debug toggle) is 25px wider than a
   * 380px viewport for every question type, variant or not.
   */
  const overflow = await shot.evaluate(() => {
    const vw = window.innerWidth;
    const shell = document.querySelector(".rs-shell");
    const scrollers = [...shell.querySelectorAll("*")].filter((el) => {
      const ox = getComputedStyle(el).overflowX;
      return ox === "auto" || ox === "scroll";
    });
    const offenders = [...shell.querySelectorAll("*")]
      .filter((el) => !scrollers.some((s) => s !== el && s.contains(el)))
      .filter((el) => el.getBoundingClientRect().right > vw + 1)
      .map((el) => `${el.tagName}.${el.className}`);
    const wrapEl = document.querySelector('[data-testid="attr-scroll"]');
    return {
      shell: shell.scrollWidth - shell.clientWidth,
      offenders: offenders.slice(0, 6),
      wrap: wrapEl ? wrapEl.scrollWidth - wrapEl.clientWidth : -1,
    };
  });
  assert.deepEqual(overflow.offenders, [], `nothing overflows the viewport at ${w}px`);
  assert.ok(overflow.shell <= 1, `the survey column does not scroll sideways at ${w}px (was ${overflow.shell}px)`);
  if (w === 380) assert.ok(overflow.wrap > 0, "at 380px the comparison table scrolls inside its own wrapper");
  await shot.screenshot({ path: file, fullPage: true });
  await shot.close();
  console.log(`✔ screenshot at ${w}px → ${file} (shell overflow ${overflow.shell}px, table scrolls ${overflow.wrap}px internally)`);
}

await h.close();
console.log("\nALL CAROUSEL / CARD / COMPARISON VARIANT CHECKS PASSED");

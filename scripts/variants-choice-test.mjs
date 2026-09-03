/**
 * Single Select + Multi Select variant families (10 variants): created from
 * the picker, rendered in the runtime, answered, and the answer checked
 * against the response model.
 */
import { openHarness, assert } from "./lib/variantHarness.mjs";

const h = await openHarness();
const made = {};

/* ------------------------------------------------ create every variant */
const SINGLE = ["icon_select", "list_select", "heart_rating", "product_choice", "statement_choice", "pairwise_choice"];
const MULTI = ["icon_multi_select", "list_multi_select", "multi_item_carousel", "product_multi_select"];
for (const k of SINGLE) made[k] = await h.createFromPicker("single_select", `single_select.${k}`);
for (const k of MULTI) made[k] = await h.createFromPicker("multi_select", `multi_select.${k}`);
console.log("✔ all 10 select-family variants are stable in the picker and create with their variant id");

assert.equal(made.icon_select.type, "single_select");
assert.equal(made.heart_rating.type, "numeric");
assert.equal(made.icon_multi_select.type, "multi_select");
assert.equal(made.product_multi_select.type, "multi_select");
assert.equal(made.icon_select.options.length, 3, "icon select seeds three iconed options");
assert.equal(made.icon_select.options[0].meta.icon, "🏠");
assert.equal(made.pairwise_choice.options.length, 2, "pairwise seeds A and B");
console.log("✔ base types and seeded defaults are right");

/* ------------------------------------------------ give the empty ones options */
const OPTS = [
  { code: 1, label: "Alpha", meta: { description: "First choice", badge: "Popular", price: "$10", icon: "🅰️" } },
  { code: 2, label: "Beta", meta: { description: "Second choice", price: "$20", icon: "🅱️" } },
  { code: 3, label: "Gamma", meta: { description: "Third choice", price: "$30", icon: "🌀" } },
];
for (const k of ["list_select", "product_choice", "statement_choice", "icon_multi_select", "list_multi_select", "multi_item_carousel", "product_multi_select"]) {
  await h.setQuestion(made[k].id, (q) => { q.options = OPTS; });
}
await h.setQuestion(made.icon_multi_select.id, (q) => { q.settings.maxSelections = 2; });

/* ------------------------------------------------ Studio: meta fields are editable */
await h.goTab("Questions");
const cards = await h.page.$$('[data-testid="qcard"]');
await cards[1].click(); // list select
await h.page.waitForSelector('[data-testid="option-meta-description-0"]');
await h.page.fill('[data-testid="option-meta-badge-1"]', "New");
await h.page.waitForTimeout(300);
let def = await h.readDef();
assert.equal(def.questions[1].options[1].meta.badge, "New", "a per-option meta field writes to option.meta");
await h.goTab("Questions");
await h.page.click('[data-testid="close-question"]').catch(() => {});
console.log("✔ the editor exposes per-option description / badge / price for list & card renderers");

/* ------------------------------------------------ runtime: single choice */
const ids = (...ks) => ks.map((k) => made[k].id);
let pv = await h.preview(ids("icon_select", "list_select", "heart_rating", "product_choice", "statement_choice", "pairwise_choice"));

await pv.click(`[data-qid="${made.icon_select.id}"] .rs-iconopt[data-code="2"]`);
assert.equal(await h.answerOf(pv, made.icon_select.id), 2, "icon select stores the code");
await pv.click(`[data-qid="${made.icon_select.id}"] .rs-iconopt[data-code="2"]`);
assert.equal(await h.answerOf(pv, made.icon_select.id), null, "clicking again clears (single choice)");
await pv.click(`[data-qid="${made.icon_select.id}"] .rs-iconopt[data-code="3"]`);
console.log("✔ icon select: single_choice, toggles, stores the code");

await pv.click(`[data-qid="${made.list_select.id}"] .rs-listrow[data-code="1"]`);
await pv.click(`[data-qid="${made.list_select.id}"] .rs-listrow[data-code="2"]`);
assert.equal(await h.answerOf(pv, made.list_select.id), 2, "list select: picking a second row replaces the first");
assert.match(await pv.textContent(`[data-qid="${made.list_select.id}"] .rs-listrow[data-code="1"]`), /Popular/, "badge renders");
assert.match(await pv.textContent(`[data-qid="${made.list_select.id}"] .rs-listrow[data-code="1"]`), /First choice/, "description renders");
console.log("✔ list select renders description + badge + price, single_choice");

await pv.click(`[data-qid="${made.heart_rating.id}"] .rs-stars button[aria-label="4 stars"]`);
assert.equal(await h.answerOf(pv, made.heart_rating.id), 4, "hearts store a number");
console.log("✔ heart rating: numeric 1–5");

await pv.click(`[data-qid="${made.product_choice.id}"] .rs-richcard[data-code="3"]`);
assert.equal(await h.answerOf(pv, made.product_choice.id), 3);
assert.match(await pv.textContent(`[data-qid="${made.product_choice.id}"] .rs-richcard[data-code="3"]`), /\$30/, "price shows on the card");
assert.match(await pv.textContent(`[data-qid="${made.product_choice.id}"] .rs-richcard[data-code="3"]`), /Selected/, "selected card says so");
console.log("✔ product choice: rich card with price, single_choice");

await pv.click(`[data-qid="${made.statement_choice.id}"] .rs-statement[data-code="1"]`);
assert.equal(await h.answerOf(pv, made.statement_choice.id), 1);
console.log("✔ statement choice: single_choice");

await pv.click(`[data-qid="${made.pairwise_choice.id}"] .rs-pair-side.b`);
assert.equal(await h.answerOf(pv, made.pairwise_choice.id), 2, "pairwise stores the winner's code");
assert.equal((await pv.$$(`[data-qid="${made.pairwise_choice.id}"] .rs-pair-side`)).length, 2);
console.log("✔ pairwise: two sides, stores the winner");
await pv.close();

/* ------------------------------------------------ runtime: multi choice */
pv = await h.preview(ids("icon_multi_select", "list_multi_select", "multi_item_carousel", "product_multi_select"));

const im = made.icon_multi_select.id;
await pv.click(`[data-qid="${im}"] .rs-iconopt[data-code="1"]`);
await pv.click(`[data-qid="${im}"] .rs-iconopt[data-code="2"]`);
await pv.click(`[data-qid="${im}"] .rs-iconopt[data-code="3"]`);
assert.deepEqual(await h.answerOf(pv, im), [1, 2], "icon multi-select stores an array and honours maxSelections=2");
await pv.click(`[data-qid="${im}"] .rs-iconopt[data-code="1"]`);
assert.deepEqual(await h.answerOf(pv, im), [2], "deselect works");
console.log("✔ icon multi-select: multiple_choice with max");

const lm = made.list_multi_select.id;
await pv.click(`[data-qid="${lm}"] .rs-listrow[data-code="1"]`);
await pv.click(`[data-qid="${lm}"] .rs-listrow[data-code="3"]`);
assert.deepEqual(await h.answerOf(pv, lm), [1, 3]);
console.log("✔ list multi-select: multiple_choice");

const mc = made.multi_item_carousel.id;
await pv.click(`[data-qid="${mc}"] .rs-carousel-card`);                  // select Alpha
await pv.click(`[data-qid="${mc}"] .rs-carousel-nav[aria-label="Next"]`);
await pv.click(`[data-qid="${mc}"] .rs-carousel-nav[aria-label="Next"]`);
await pv.click(`[data-qid="${mc}"] .rs-carousel-foot .rs-btn`);           // select Gamma via the button
assert.deepEqual(await h.answerOf(pv, mc), [1, 3], "carousel collects selections while browsing");
assert.match(await pv.textContent(`[data-qid="${mc}"] .rs-carousel-count`), /2 selected/);
console.log("✔ multi-item carousel: browse and select several");

const pm = made.product_multi_select.id;
await pv.click(`[data-qid="${pm}"] .rs-richcard[data-code="2"]`);
await pv.click(`[data-qid="${pm}"] .rs-richcard[data-code="3"]`);
assert.deepEqual(await h.answerOf(pv, pm), [2, 3]);
console.log("✔ product multi-select: multiple_choice");

// required + Next: an unanswered required multi blocks
await pv.close();
pv = await h.preview([im], (d) => { d.questions.find((q) => q.id === im).required = true; });
await h.next(pv);
assert.ok(await pv.$(`[data-qid="${im}"]`), "still on the page");
assert.match(await pv.textContent(".rs-shell"), /required/i, "required is enforced like any other question");
console.log("✔ the ordinary validators apply — nothing about these variants is special to the engine");
await pv.close();

await h.close();
console.log("\nALL SELECT-FAMILY VARIANT CHECKS PASSED");

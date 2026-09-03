/**
 * Ranking / Drag & Drop / Swipe variant families (9 variants): created from
 * the picker, rendered in the runtime, answered with the mouse, the keyboard
 * and a real pointer drag, and the answer checked against the response model.
 *
 *   ranking.tournament     ranking         rank_order   tournament
 *   comparison.tournament  ranking         rank_order   tournament
 *   ranking.buckets        ranking         rank_order   rankbuckets
 *   dragdrop.buckets       matrix_single   per_row      dragbuckets
 *   dragdrop.scale         matrix_numeric  per_row      dragscale
 *   dragdrop.allocation    allocation      allocation   chipallocation
 *   allocation.drag        allocation      allocation   chipallocation
 *   swipe.rate             matrix_single   per_row      swiperate
 *   swipe.four_direction   matrix_single   per_row      swipe4
 */
import { openHarness, assert } from "./lib/variantHarness.mjs";

const h = await openHarness();
const made = {};
const ids = (...ks) => ks.map((k) => made[k].id);
const q = (k) => `[data-qid="${made[k].id}"]`;

/** Drag with the real pointer: down on `from`, move in steps, up on `to`. */
async function dragTo(pv, fromSel, toSel, { toDx = 0, toDy = 0 } = {}) {
  const a = await (await pv.waitForSelector(fromSel)).boundingBox();
  const b = await (await pv.waitForSelector(toSel)).boundingBox();
  const x1 = a.x + a.width / 2, y1 = a.y + a.height / 2;
  const x2 = b.x + b.width / 2 + toDx, y2 = b.y + b.height / 2 + toDy;
  await pv.mouse.move(x1, y1);
  await pv.mouse.down();
  for (let i = 1; i <= 6; i++) {
    await pv.mouse.move(x1 + ((x2 - x1) * i) / 6, y1 + ((y2 - y1) * i) / 6);
  }
  await pv.mouse.up();
  await pv.waitForTimeout(150);
}

/** Swipe a card by dx/dy from its centre. */
async function swipeCard(pv, sel, dx, dy = 0) {
  const box = await (await pv.waitForSelector(sel)).boundingBox();
  const x = box.x + box.width / 2, y = box.y + box.height / 2;
  await pv.mouse.move(x, y);
  await pv.mouse.down();
  for (let i = 1; i <= 5; i++) await pv.mouse.move(x + (dx * i) / 5, y + (dy * i) / 5);
  await pv.mouse.up();
  await pv.waitForTimeout(200);
}

/* ============================================== 1. the picker offers all nine */

made.tournament = await h.createFromPicker("ranking", "ranking.tournament");
made.buckets = await h.createFromPicker("ranking", "ranking.buckets");
made.cmp_tournament = await h.createFromPicker("comparison", "comparison.tournament");
made.dd_buckets = await h.createFromPicker("dragdrop", "dragdrop.buckets");
made.dd_scale = await h.createFromPicker("dragdrop", "dragdrop.scale");
made.dd_alloc = await h.createFromPicker("dragdrop", "dragdrop.allocation");
made.alloc_drag = await h.createFromPicker("allocation", "allocation.drag");
made.sw_rate = await h.createFromPicker("swipe", "swipe.rate");
made.sw_four = await h.createFromPicker("swipe", "swipe.four_direction");
console.log("✔ all 9 variants are stable in the picker and create with their variant id");

// the sibling entries built in other batches are merged alongside — all stable,
// and nothing in either family reads "coming soon" any more
await h.goTab("Questions");
await h.page.click('[data-testid="add-question-top"]');
await h.page.click('[data-testid="picker-family-comparison"]');
let other = await h.page.waitForSelector('[data-testid="picker-variant-comparison.attributes"]');
assert.equal(await other.getAttribute("data-status"), "stable", "Multi-Item Comparison is stable too");
await h.page.click('[data-testid="picker-family-allocation"]');
other = await h.page.waitForSelector('[data-testid="picker-variant-allocation.slider_allocation"]');
assert.equal(await other.getAttribute("data-status"), "stable", "Slider Allocation is stable too");
assert.equal((await h.page.$$('.modal [data-status="planned"]')).length, 0, "no allocation entry is still planned");
await h.page.click(".modal button:has-text('close')");
console.log("✔ the comparison / allocation families are complete — nothing left planned");

/* --------------------------------------------------- base types + defaults */
assert.equal(made.tournament.type, "ranking");
assert.equal(made.cmp_tournament.type, "ranking");
assert.equal(made.buckets.type, "ranking");
assert.equal(made.dd_buckets.type, "matrix_single");
assert.equal(made.dd_scale.type, "matrix_numeric");
assert.equal(made.dd_alloc.type, "allocation");
assert.equal(made.alloc_drag.type, "allocation");
assert.equal(made.sw_rate.type, "matrix_single");
assert.equal(made.sw_four.type, "matrix_single");

assert.equal(made.tournament.settings.rankMode, "top_n", "no cap yet, so top_n == rank everything");
assert.equal(made.tournament.options.length, 4);
assert.equal(made.buckets.settings.rankMode, "top_n");
assert.equal(made.dd_buckets.rows.length, 4, "drag buckets seeds items");
assert.equal(made.dd_buckets.options.length, 3, "and three named buckets");
assert.equal(made.dd_scale.rows.length, 4);
assert.equal(made.dd_scale.settings.maxValue, 100);
assert.equal(made.dd_alloc.settings.chipValue, 10);
assert.equal(made.dd_alloc.settings.sumTarget, 100);
assert.equal(made.sw_rate.options.length, 5, "swipe-to-rate seeds a 5-point scale");
assert.equal(made.sw_rate.rows.length, 3);
assert.equal(made.sw_four.options.length, 4, "four-direction seeds one option per direction");
console.log("✔ base types and seeded defaults are right — nothing is born empty");

/* ================================================ 2. Studio settings blocks */

await h.goTab("Questions");
let cards = await h.page.$$('[data-testid="qcard"]');
await cards[0].click(); // tournament
await h.page.waitForSelector('[data-testid="tournament-topn"]');
await h.page.fill('[data-testid="tournament-topn"]', "2");
await h.page.waitForTimeout(300);
let def = await h.readDef();
let tq = def.questions.find((x) => x.id === made.tournament.id);
assert.equal(tq.settings.tournamentTopN, 2, "the block writes settings.tournamentTopN");
assert.equal(tq.settings.maxSelections, 2, "and keeps the completeness rule in step with it");
await h.goTab("Questions");
await h.page.click('[data-testid="close-question"]').catch(() => {});

cards = await h.page.$$('[data-testid="qcard"]');
await cards[8].click(); // four-direction swipe
await h.page.waitForSelector('[data-testid="swipe4-dir-up"]');
await h.page.selectOption('[data-testid="swipe4-dir-up"]', "love");
await h.page.selectOption('[data-testid="swipe4-dir-down"]', "unknown");
await h.page.waitForTimeout(300);
def = await h.readDef();
const sq = def.questions.find((x) => x.id === made.sw_four.id);
assert.deepEqual(sq.settings.swipeDirections, { up: "love", down: "unknown" },
  "the mapping block writes settings.swipeDirections");
await h.goTab("Questions");
await h.page.click('[data-testid="close-question"]').catch(() => {});

cards = await h.page.$$('[data-testid="qcard"]');
await cards[5].click(); // drag allocation
await h.page.waitForSelector('[data-testid="chip-value"]');
await h.page.fill('[data-testid="chip-value"]', "25");
await h.page.waitForTimeout(300);
def = await h.readDef();
assert.equal(def.questions.find((x) => x.id === made.dd_alloc.id).settings.chipValue, 25);
await h.goTab("Questions");
await h.page.click('[data-testid="close-question"]').catch(() => {});
// back to ten-point chips for the runtime checks below
await h.setQuestion(made.dd_alloc.id, (x) => { x.settings.chipValue = 10; });
console.log("✔ the Studio blocks write tournamentTopN / swipeDirections / chipValue");

/* ==================================================== 3. tournament ranking */

// six items with a cap of two, so the early stop is observable
await h.setQuestion(made.tournament.id, (x) => {
  x.options = [1, 2, 3, 4, 5, 6].map((n) => ({ code: String(n), label: `Item ${n}`, flags: [] }));
});
await h.setQuestion(made.cmp_tournament.id, (x) => {
  x.options = ["a", "b", "c", "d"].map((c) => ({ code: c, label: c.toUpperCase(), flags: [] }));
  x.settings.rankMode = "top_n";
});

let pv = await h.preview(ids("tournament", "cmp_tournament"));

// answer every duel by always taking side A, and remember what that implied
const topn = q("tournament");
assert.match(await pv.textContent(`${topn} [data-testid="tournament-progress"]`), /Duel 1 of ~\d+/);
let progressSeen = new Set();
let guard = 0;
const winners = [];
while (await pv.$(`${topn} [data-testid="duel-a"]`)) {
  if (++guard > 40) throw new Error("the tournament never finished");
  progressSeen.add(await pv.textContent(`${topn} [data-testid="tournament-progress"]`));
  const a = await pv.getAttribute(`${topn} [data-testid="duel-a"]`, "data-code");
  const b = await pv.getAttribute(`${topn} [data-testid="duel-b"]`, "data-code");
  winners.push([a, b]);
  await pv.click(`${topn} [data-testid="duel-a"]`);
  await pv.waitForTimeout(90);
}
assert.ok(progressSeen.size > 1, "the progress text advances with each duel");
let answer = await h.answerOf(pv, made.tournament.id);
assert.ok(Array.isArray(answer), "rank_order: an array of codes");
assert.equal(answer.length, 2, "topN = 2 stores exactly the settled top 2");
assert.ok(guard < 12, `and stopped early — ${guard} duels for 6 items capped at 2`);
// always preferring the challenger means the last challenger to win a duel
// against the leader is the leader: every recorded winner beat everything
// above it, so the head of the answer must be a code that won its last duel
assert.ok(winners.some(([a]) => String(a) === String(answer[0])),
  "the stored first place is an item the respondent actually chose");
for (const [a, b] of winners) {
  // side A always won, so B can never be ranked above A
  const ia = answer.findIndex((c) => String(c) === String(a));
  const ib = answer.findIndex((c) => String(c) === String(b));
  if (ia >= 0 && ib >= 0) assert.ok(ia < ib, `${a} beat ${b}, so it ranks above it`);
}
assert.match(await pv.textContent(`${topn} [data-testid="tournament-progress"]`), /Done — your top 2/);
assert.equal((await pv.$$(`${topn} [data-testid="tournament-final"] .rs-tour-rank`)).length, 2);
console.log(`✔ tournament: ${guard} duels, progress advances, top-2 cap stops early and stores 2`);

// start over clears the answer and the recorded duels
await pv.click(`${topn} [data-testid="tournament-restart"]`);
await pv.waitForTimeout(150);
assert.equal(await h.answerOf(pv, made.tournament.id), null, "Start over clears the answer");
assert.ok(await pv.$(`${topn} [data-testid="duel-a"]`), "and asks the first duel again");
assert.match(await pv.textContent(`${topn} [data-testid="tournament-progress"]`), /Duel 1 of/);
console.log("✔ tournament: Start over resets the duels");

// the comparison-family entry is the same renderer and the same answer shape
const cmp = q("cmp_tournament");
guard = 0;
while (await pv.$(`${cmp} [data-testid="duel-b"]`)) {
  if (++guard > 40) throw new Error("comparison tournament never finished");
  await pv.click(`${cmp} [data-testid="duel-b"]`); // always the incumbent
  await pv.waitForTimeout(90);
}
answer = await h.answerOf(pv, made.cmp_tournament.id);
assert.ok(Array.isArray(answer) && answer.length === 4, "no cap: the full ranking is stored");
assert.deepEqual([...new Set(answer.map(String))].length, 4, "each item once");
console.log("✔ comparison.tournament: same renderer, full rank_order of 4");
await pv.close();

// required blocks while the duels are unfinished
pv = await h.preview(ids("tournament"), (d) => {
  d.questions.find((x) => x.id === made.tournament.id).required = true;
});
await h.next(pv);
assert.ok(await pv.$(`${topn} [data-testid="duel-a"]`), "still on the page");
assert.match(await pv.textContent(".rs-shell"), /required/i, "required is enforced");
await pv.close();
console.log("✔ tournament: required blocks Next until the duels are answered");

/* ======================================================== 4. bucket ranking */

pv = await h.preview(ids("buckets"));
const rb = q("buckets");
assert.match(await pv.textContent(`${rb} [data-testid="rankbuckets-progress"]`), /0 of 4 ranked/);

// click-then-click: item, then slot
await pv.click(`${rb} .rs-rb-pool .rs-dd-chip[data-code="3"]`);
await pv.click(`${rb} .rs-rb-slot[data-slot="0"]`);
await pv.waitForTimeout(120);
assert.deepEqual(await h.answerOf(pv, made.buckets.id), [3], "slot order is the stored order");
await pv.click(`${rb} .rs-rb-pool .rs-dd-chip[data-code="1"]`);
await pv.click(`${rb} .rs-rb-slot[data-slot="1"]`);
await pv.waitForTimeout(120);
assert.deepEqual(await h.answerOf(pv, made.buckets.id), [3, 1]);
assert.match(await pv.textContent(`${rb} [data-testid="rankbuckets-progress"]`), /2 of 4 ranked/);

// a real pointer drag into the third slot
await dragTo(pv, `${rb} .rs-rb-pool .rs-dd-chip[data-code="4"]`, `${rb} .rs-rb-slot[data-slot="2"]`);
assert.deepEqual(await h.answerOf(pv, made.buckets.id), [3, 1, 4], "pointer drag places into a slot");

// swap: hold the item in slot 0 and drop it on slot 2
await pv.click(`${rb} .rs-rb-slot[data-slot="0"] .rs-dd-chip[data-code="3"]`);
await pv.click(`${rb} .rs-rb-slot[data-slot="2"]`);
await pv.waitForTimeout(120);
assert.deepEqual(await h.answerOf(pv, made.buckets.id), [4, 1, 3], "occupants swap, nothing is evicted");

// and back to the pool
await pv.click(`${rb} .rs-rb-slot[data-slot="1"] .rs-dd-chip[data-code="1"]`);
await pv.click(`${rb} .rs-rb-pool`);
await pv.waitForTimeout(120);
assert.deepEqual(await h.answerOf(pv, made.buckets.id), [4, 3], "a slot emptied leaves a partial list");
assert.ok(await pv.$(`${rb} .rs-rb-pool .rs-dd-chip[data-code="1"]`), "the item is back in the pool");

// keyboard: focus a chip and hold it with Enter, then activate a slot
await pv.focus(`${rb} .rs-rb-pool .rs-dd-chip[data-code="1"]`);
await pv.keyboard.press("Enter");
await pv.waitForTimeout(80);
await pv.focus(`${rb} .rs-rb-slot[data-slot="1"]`);
await pv.keyboard.press("Enter");
await pv.waitForTimeout(120);
assert.deepEqual(await h.answerOf(pv, made.buckets.id), [4, 1, 3], "keyboard places an item too");
console.log("✔ bucket ranking: tap-then-tap, pointer drag, swap, back-to-pool, keyboard");
await pv.close();

// required: all four slots must be filled (rankMode top_n, no cap)
pv = await h.preview(ids("buckets"), (d) => {
  d.questions.find((x) => x.id === made.buckets.id).required = true;
});
await pv.click(`${rb} .rs-rb-pool .rs-dd-chip[data-code="1"]`);
await pv.click(`${rb} .rs-rb-slot[data-slot="0"]`);
await h.next(pv);
assert.ok(await pv.$(`${rb} .rs-rb-slot[data-slot="0"]`), "still on the page with one of four ranked");
assert.match(await pv.textContent(".rs-shell"), /rank/i, "and says so");
for (const [code, slot] of [["2", 1], ["3", 2], ["4", 3]]) {
  await pv.click(`${rb} .rs-rb-pool .rs-dd-chip[data-code="${code}"]`);
  await pv.click(`${rb} .rs-rb-slot[data-slot="${slot}"]`);
}
await pv.waitForTimeout(120);
assert.equal((await h.answerOf(pv, made.buckets.id)).length, 4);
await h.next(pv);
assert.ok(!(await pv.$(`${rb} .rs-rb-slot[data-slot="0"]`)), "a full set of slots passes");
await pv.close();
console.log("✔ bucket ranking: required blocks until every slot is filled");

/* =================================================== 5. drag into buckets */

pv = await h.preview(ids("dd_buckets"));
const db = q("dd_buckets");
assert.match(await pv.textContent(`${db} [data-testid="dragbuckets-progress"]`), /0 \/ 4 sorted/);

await pv.click(`${db} .rs-dd-pool .rs-dd-chip[data-row="1"]`);
await pv.click(`${db} .rs-dd-bucket[data-code="must"]`);
await pv.waitForTimeout(120);
assert.deepEqual(await h.answerOf(pv, made.dd_buckets.id), { 1: "must" }, "per_row: { rowCode: bucketCode }");

await dragTo(pv, `${db} .rs-dd-pool .rs-dd-chip[data-row="2"]`, `${db} .rs-dd-bucket[data-code="nice"]`);
assert.deepEqual(await h.answerOf(pv, made.dd_buckets.id), { 1: "must", 2: "nice" }, "pointer drag sorts an item");
assert.match(await pv.textContent(`${db} [data-testid="dragbuckets-progress"]`), /2 \/ 4 sorted/);

// move between buckets
await pv.click(`${db} .rs-dd-bucket[data-code="must"] .rs-dd-chip[data-row="1"]`);
await pv.click(`${db} .rs-dd-bucket[data-code="no"]`);
await pv.waitForTimeout(120);
assert.deepEqual(await h.answerOf(pv, made.dd_buckets.id), { 1: "no", 2: "nice" }, "an item moves between buckets");

// back to the pool by drag
await dragTo(pv, `${db} .rs-dd-bucket[data-code="no"] .rs-dd-chip[data-row="1"]`, `${db} .rs-dd-pool`);
assert.deepEqual(await h.answerOf(pv, made.dd_buckets.id), { 2: "nice" }, "and back out to the pool");

// keyboard
await pv.focus(`${db} .rs-dd-pool .rs-dd-chip[data-row="3"]`);
await pv.keyboard.press("Enter");
await pv.focus(`${db} .rs-dd-bucket[data-code="must"]`);
await pv.keyboard.press("Enter");
await pv.waitForTimeout(120);
assert.deepEqual(await h.answerOf(pv, made.dd_buckets.id), { 2: "nice", 3: "must" });
console.log("✔ drag buckets: tap-then-tap, pointer drag, move, back to pool, keyboard");
await pv.close();

pv = await h.preview(ids("dd_buckets"), (d) => {
  d.questions.find((x) => x.id === made.dd_buckets.id).required = true;
});
await h.next(pv);
assert.ok(await pv.$(`${db} .rs-dd-pool`), "still on the page");
assert.match(await pv.textContent(".rs-shell"), /required|answer for/i);
await pv.close();
console.log("✔ drag buckets: required needs every item sorted");

/* ======================================================= 6. drag onto scale */

pv = await h.preview(ids("dd_scale"));
const ds = q("dd_scale");
assert.match(await pv.textContent(`${ds} [data-testid="dragscale-progress"]`), /0 \/ 4 placed/);

// keyboard: the first arrow places at the midpoint, the next moves by a step
await pv.focus(`${ds} .rs-dd-pool .rs-dd-chip[data-row="1"]`);
await pv.keyboard.press("ArrowRight");
await pv.waitForTimeout(150);
assert.deepEqual(await h.answerOf(pv, made.dd_scale.id), { 1: 50 }, "unplaced + arrow = the midpoint");
await pv.keyboard.press("ArrowRight");
await pv.waitForTimeout(150);
assert.deepEqual(await h.answerOf(pv, made.dd_scale.id), { 1: 51 }, "then it moves by settings.step");
await pv.keyboard.press("ArrowLeft");
await pv.keyboard.press("ArrowLeft");
await pv.waitForTimeout(150);
assert.deepEqual(await h.answerOf(pv, made.dd_scale.id), { 1: 49 }, "and back the other way");
await pv.keyboard.press("Home");
await pv.waitForTimeout(150);
assert.deepEqual(await h.answerOf(pv, made.dd_scale.id), { 1: 0 }, "Home is the floor — zero is a real answer");
await pv.keyboard.press("End");
await pv.waitForTimeout(150);
assert.deepEqual(await h.answerOf(pv, made.dd_scale.id), { 1: 100 });
// an item at either end of the track must stay inside the card
for (const key of ["Home", "End"]) {
  await pv.keyboard.press(key);
  await pv.waitForTimeout(120);
  const spill = await pv.$$eval(`${ds} .rs-dd-chip.on-scale`, (els, w) =>
    els.map((e) => e.getBoundingClientRect())
      .filter((r) => r.left < -1 || r.right > w + 1).length, 1000);
  assert.equal(spill, 0, `a chip at the ${key === "Home" ? "left" : "right"} end does not hang off the page`);
}

// a real pointer drag onto a known point on the track
const trackBox = await (await pv.waitForSelector(`${ds} .rs-ds-track`)).boundingBox();
await dragTo(pv, `${ds} .rs-dd-pool .rs-dd-chip[data-row="2"]`, `${ds} .rs-ds-track`,
  { toDx: -trackBox.width / 4 });
let scaleAns = await h.answerOf(pv, made.dd_scale.id);
assert.equal(typeof scaleAns[2], "number", "per_row numeric: the position is the value");
assert.ok(Math.abs(scaleAns[2] - 25) <= 3, `dropped a quarter along the track → ${scaleAns[2]} ≈ 25`);

// click-then-click on the track
await pv.click(`${ds} .rs-dd-pool .rs-dd-chip[data-row="3"]`);
await pv.mouse.click(trackBox.x + trackBox.width * 0.75, trackBox.y + trackBox.height / 2);
await pv.waitForTimeout(150);
scaleAns = await h.answerOf(pv, made.dd_scale.id);
assert.ok(Math.abs(scaleAns[3] - 75) <= 3, `tap-then-tap on the track → ${scaleAns[3]} ≈ 75`);
assert.match(await pv.textContent(`${ds} [data-testid="dragscale-progress"]`), /3 \/ 4 placed/);

// items close together stack into lanes rather than hiding one another
await pv.click(`${ds} .rs-dd-pool .rs-dd-chip[data-row="4"]`);
await pv.mouse.click(trackBox.x + trackBox.width * 0.76, trackBox.y + trackBox.height / 2);
await pv.waitForTimeout(200);
const bottoms = await pv.$$eval(`${ds} .rs-dd-chip.on-scale`, (els) =>
  els.map((e) => Number(getComputedStyle(e).bottom.replace("px", ""))));
assert.ok(new Set(bottoms).size > 1, "overlapping items are stacked in separate lanes");

// tap a placed item to send it back
await pv.click(`${ds} .rs-dd-chip.on-scale[data-row="4"]`);
await pv.waitForTimeout(150);
assert.equal((await h.answerOf(pv, made.dd_scale.id))[4], undefined, "a tap on the scale returns it to the pool");
console.log("✔ drag scale: keyboard midpoint + step, pointer drop maps x → value, lanes, un-place");
await pv.close();

pv = await h.preview(ids("dd_scale"), (d) => {
  d.questions.find((x) => x.id === made.dd_scale.id).required = true;
});
await h.next(pv);
assert.ok(await pv.$(`${ds} .rs-ds-track`), "still on the page");
assert.match(await pv.textContent(".rs-shell"), /required|answer for/i);
await pv.close();
console.log("✔ drag scale: required needs every item placed");

/* ==================================================== 7. chip allocation ×2 */

pv = await h.preview(ids("dd_alloc", "alloc_drag"));
const ca = q("dd_alloc");
assert.match(await pv.textContent(`${ca} [data-testid="chipalloc-total"]`), /0 \/ 100 pts allocated/);

for (let i = 0; i < 4; i++) await pv.click(`${ca} [data-testid="chipalloc-plus-1"]`);
await pv.waitForTimeout(150);
assert.deepEqual(await h.answerOf(pv, made.dd_alloc.id), { 1: 40 }, "allocation: { code: chips × chipValue }");
assert.match(await pv.textContent(`${ca} [data-testid="chipalloc-total"]`), /40 \/ 100 pts allocated/);

// a real pointer drag of a chip from the pool onto an item
await dragTo(pv, `${ca} .rs-ca-pool .rs-ca-chip`, `${ca} .rs-ca-item[data-code="2"]`);
assert.deepEqual(await h.answerOf(pv, made.dd_alloc.id), { 1: 40, 2: 10 }, "a dragged chip lands on the item");

// and back to the pool
await dragTo(pv, `${ca} .rs-ca-item[data-code="2"] .rs-ca-chip`, `${ca} .rs-ca-pool`);
assert.deepEqual(await h.answerOf(pv, made.dd_alloc.id), { 1: 40 }, "and drags back off it");

// the pool is the budget: past it, + is disabled and nothing exceeds the target
for (let i = 0; i < 20; i++) await pv.click(`${ca} [data-testid="chipalloc-plus-2"]`).catch(() => {});
await pv.waitForTimeout(200);
let alloc = await h.answerOf(pv, made.dd_alloc.id);
const total = Object.values(alloc).reduce((a, b) => a + b, 0);
assert.equal(total, 100, `every chip is spent and none invented — total ${total}`);
assert.ok(Object.values(alloc).every((v) => v % 10 === 0), "values are always multiples of chipValue");
assert.equal(await pv.getAttribute(`${ca} [data-testid="chipalloc-plus-1"]`, "disabled"), "",
  "+ is disabled once the chips run out");
await pv.click(`${ca} [data-testid="chipalloc-minus-1"]`);
await pv.waitForTimeout(150);
alloc = await h.answerOf(pv, made.dd_alloc.id);
assert.equal(alloc[1], 30, "− gives a chip back");
assert.match(await pv.textContent(`${ca} [data-testid="chipalloc-total"]`), /90 \/ 100 pts allocated/);

// allocation.drag is the same renderer over the same model
const ad = q("alloc_drag");
await pv.click(`${ad} [data-testid="chipalloc-plus-3"]`);
await pv.waitForTimeout(150);
assert.deepEqual(await h.answerOf(pv, made.alloc_drag.id), { 3: 10 });
console.log("✔ chip allocation (both entries): +/−, pointer drag on and off, never over the target");
await pv.close();

pv = await h.preview(ids("dd_alloc"), (d) => {
  d.questions.find((x) => x.id === made.dd_alloc.id).required = true;
});
await h.next(pv);
assert.ok(await pv.$(`${ca} .rs-ca-pool`), "still on the page");
assert.match(await pv.textContent(".rs-shell"), /required/i);
await pv.close();
console.log("✔ chip allocation: required blocks an empty allocation");

/* ======================================================== 8. swipe to rate */

pv = await h.preview(ids("sw_rate"));
const sr = q("sw_rate");
assert.match(await pv.textContent(`${sr} [data-testid="swiperate-progress"]`), /Card 1 of 3/);

await pv.click(`${sr} .rs-swipex-step[data-code="4"]`);
await pv.waitForTimeout(180);
assert.deepEqual(await h.answerOf(pv, made.sw_rate.id), { 1: 4 }, "per_row: { rowCode: optionCode }");
assert.match(await pv.textContent(`${sr} [data-testid="swiperate-progress"]`), /Card 2 of 3/, "the next card slides in");

await pv.click(`${sr} .rs-swipex-step[data-code="2"]`);
await pv.waitForTimeout(180);
assert.deepEqual(await h.answerOf(pv, made.sw_rate.id), { 1: 4, 2: 2 });

// Undo steps back one card
await pv.click(`${sr} [data-testid="swiperate-undo"]`);
await pv.waitForTimeout(180);
assert.deepEqual(await h.answerOf(pv, made.sw_rate.id), { 1: 4 }, "Undo un-judges the last card");
assert.match(await pv.textContent(`${sr} [data-testid="swiperate-progress"]`), /Card 2 of 3/);
assert.equal(await pv.getAttribute(`${sr} .rs-swipex-card`, "data-row"), "2", "and shows that card again");

// a real swipe: right commits the top of the scale, left the bottom
await swipeCard(pv, `${sr} .rs-swipex-card`, 180);
assert.deepEqual(await h.answerOf(pv, made.sw_rate.id), { 1: 4, 2: 5 }, "swipe right = the highest point");
await swipeCard(pv, `${sr} .rs-swipex-card`, -180);
assert.deepEqual(await h.answerOf(pv, made.sw_rate.id), { 1: 4, 2: 5, 3: 1 }, "swipe left = the lowest");
assert.match(await pv.textContent(`${sr} [data-testid="swiperate-progress"]`), /All 3 cards judged/);
assert.equal((await pv.$$(`${sr} [data-testid="swiperate-summary"] .rs-swipex-chip`)).length, 3);
// a short drag is not a swipe
await pv.click(`${sr} [data-testid="swiperate-undo"]`);
await pv.waitForTimeout(180);
await swipeCard(pv, `${sr} .rs-swipex-card`, 30);
assert.equal((await h.answerOf(pv, made.sw_rate.id))[3], undefined, "a 30px nudge does not commit a verdict");
console.log("✔ swipe-to-rate: scale taps, Undo, real swipes both ways, threshold respected");
await pv.close();

pv = await h.preview(ids("sw_rate"), (d) => {
  d.questions.find((x) => x.id === made.sw_rate.id).required = true;
});
await h.next(pv);
assert.ok(await pv.$(`${sr} .rs-swipex-card`), "still on the page");
assert.match(await pv.textContent(".rs-shell"), /required|answer for/i);
await pv.close();
console.log("✔ swipe-to-rate: required needs every card judged");

/* =================================================== 9. four-direction swipe */

pv = await h.preview(ids("sw_four"));
const s4 = q("sw_four");
assert.match(await pv.textContent(`${s4} [data-testid="swipe4-progress"]`), /Card 1 of 3/);
// the Studio mapping set up earlier: up = love, down = unknown; left/right default
assert.equal(await pv.getAttribute(`${s4} [data-testid="swipe4-up"]`, "data-code"), "love");
assert.equal(await pv.getAttribute(`${s4} [data-testid="swipe4-down"]`, "data-code"), "unknown");
assert.equal(await pv.getAttribute(`${s4} [data-testid="swipe4-left"]`, "data-code"), "dislike");
assert.equal(await pv.getAttribute(`${s4} [data-testid="swipe4-right"]`, "data-code"), "like");

await pv.click(`${s4} [data-testid="swipe4-up"]`);
await pv.waitForTimeout(180);
assert.deepEqual(await h.answerOf(pv, made.sw_four.id), { 1: "love" }, "the arrow commits its mapped option");
await pv.click(`${s4} [data-testid="swipe4-left"]`);
await pv.waitForTimeout(180);
assert.deepEqual(await h.answerOf(pv, made.sw_four.id), { 1: "love", 2: "dislike" });

// a real swipe downwards
await swipeCard(pv, `${s4} .rs-swipex-card`, 0, 160);
assert.deepEqual(await h.answerOf(pv, made.sw_four.id), { 1: "love", 2: "dislike", 3: "unknown" },
  "swiping down commits the down mapping");
assert.match(await pv.textContent(`${s4} [data-testid="swipe4-progress"]`), /All 3 cards judged/);

await pv.click(`${s4} [data-testid="swipe4-undo"]`);
await pv.waitForTimeout(180);
assert.equal((await h.answerOf(pv, made.sw_four.id))[3], undefined, "Undo steps back a card");
// the dominant axis decides: a mostly-horizontal drag is a horizontal swipe
await swipeCard(pv, `${s4} .rs-swipex-card`, 160, 40);
assert.equal((await h.answerOf(pv, made.sw_four.id))[3], "like", "dx > dy → the right mapping");
console.log("✔ four-direction swipe: arrows, mapped settings, real swipes, dominant axis, Undo");
await pv.close();

pv = await h.preview(ids("sw_four"), (d) => {
  d.questions.find((x) => x.id === made.sw_four.id).required = true;
});
await h.next(pv);
assert.ok(await pv.$(`${s4} .rs-swipex-card`), "still on the page");
assert.match(await pv.textContent(".rs-shell"), /required|answer for/i);
await pv.close();
console.log("✔ four-direction swipe: required needs every card judged");

await h.close();
console.log("\nALL RANKING / DRAG & DROP / SWIPE VARIANT CHECKS PASSED");

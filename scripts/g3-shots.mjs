/** Screenshot every G3 variant, answered, at 1000px and 380px. */
import { openHarness } from "./lib/variantHarness.mjs";

const h = await openHarness();
const made = {};
made.tournament = await h.createFromPicker("ranking", "ranking.tournament");
made.buckets = await h.createFromPicker("ranking", "ranking.buckets");
made.cmp = await h.createFromPicker("comparison", "comparison.tournament");
made.dd_buckets = await h.createFromPicker("dragdrop", "dragdrop.buckets");
made.dd_scale = await h.createFromPicker("dragdrop", "dragdrop.scale");
made.dd_alloc = await h.createFromPicker("dragdrop", "dragdrop.allocation");
made.alloc = await h.createFromPicker("allocation", "allocation.drag");
made.rate = await h.createFromPicker("swipe", "swipe.rate");
made.four = await h.createFromPicker("swipe", "swipe.four_direction");

await h.setQuestion(made.tournament.id, (x) => {
  x.text = "Pairwise / Tournament Ranking — mid-duel";
  x.options = ["Price", "Quality", "Delivery speed", "Customer service", "Brand", "Warranty"]
    .map((l, i) => ({ code: String(i + 1), label: l, flags: [] }));
});
await h.setQuestion(made.cmp.id, (x) => { x.text = "Pairwise / Tournament Comparison — finished"; });
await h.setQuestion(made.buckets.id, (x) => { x.text = "Bucket Ranking"; });
await h.setQuestion(made.dd_buckets.id, (x) => {
  x.text = "Drag into Buckets / Categorization";
  x.rows = ["Free delivery", "Loyalty points", "Live chat", "Extended warranty"].map((l, i) => ({
    code: String(i + 1), label: l, flags: [], validation: [], required: false,
  }));
});
await h.setQuestion(made.dd_scale.id, (x) => {
  x.text = "Drag onto Scale";
  x.rows = ["Price", "Quality", "Speed", "Service"].map((l, i) => ({
    code: String(i + 1), label: l, flags: [], validation: [], required: false,
  }));
});
await h.setQuestion(made.dd_alloc.id, (x) => { x.text = "Drag-and-Drop Allocation"; });
await h.setQuestion(made.alloc.id, (x) => { x.text = "Drag Allocation (allocation family)"; });
await h.setQuestion(made.rate.id, (x) => {
  x.text = "Swipe-to-Rate";
  x.options = ["Awful", "Poor", "OK", "Good", "Great"].map((l, i) => ({ code: String(i + 1), label: l, flags: [] }));
  x.rows = ["Nike", "Adidas", "Puma"].map((l, i) => ({ code: String(i + 1), label: l, flags: [], validation: [], required: false }));
});
await h.setQuestion(made.four.id, (x) => {
  x.text = "Four-Direction Swipe";
  x.rows = ["Nike", "Adidas", "Puma"].map((l, i) => ({ code: String(i + 1), label: l, flags: [], validation: [], required: false }));
});

const all = Object.values(made).map((m) => m.id);

for (const [w, file] of [[1000, "/tmp/variants-g3-variants.png"], [380, "/tmp/variants-g3-mobile.png"]]) {
  const pv = await h.preview(all);
  await pv.setViewportSize({ width: w, height: 1100 });
  await pv.waitForTimeout(300);
  const Q = (id) => `[data-qid="${id}"]`;

  // tournament: answer three duels, leave it mid-way
  for (let i = 0; i < 3; i++) {
    if (!(await pv.$(`${Q(made.tournament.id)} [data-testid="duel-a"]`))) break;
    await pv.click(`${Q(made.tournament.id)} [data-testid="duel-a"]`);
    await pv.waitForTimeout(80);
  }
  // comparison tournament: finish it
  let g = 0;
  while ((await pv.$(`${Q(made.cmp.id)} [data-testid="duel-b"]`)) && g++ < 30) {
    await pv.click(`${Q(made.cmp.id)} [data-testid="duel-b"]`);
    await pv.waitForTimeout(70);
  }
  // buckets ranking: fill three of four
  for (const [code, slot] of [[2, 0], [4, 1], [1, 2]]) {
    await pv.click(`${Q(made.buckets.id)} .rs-rb-pool .rs-dd-chip[data-code="${code}"]`);
    await pv.click(`${Q(made.buckets.id)} .rs-rb-slot[data-slot="${slot}"]`);
    await pv.waitForTimeout(60);
  }
  // drag buckets: sort three of four
  for (const [row, b] of [[1, "must"], [2, "nice"], [3, "no"]]) {
    await pv.click(`${Q(made.dd_buckets.id)} .rs-dd-pool .rs-dd-chip[data-row="${row}"]`);
    await pv.click(`${Q(made.dd_buckets.id)} .rs-dd-bucket[data-code="${b}"]`);
    await pv.waitForTimeout(60);
  }
  // drag scale: place all four, two of them close together to show the lanes.
  // boundingBox() is viewport-relative and every click may scroll, so the
  // track is re-measured immediately before each drop.
  for (const [row, frac] of [[1, 0.12], [2, 0.55], [3, 0.78], [4, 0.82]]) {
    await pv.click(`${Q(made.dd_scale.id)} .rs-dd-pool .rs-dd-chip[data-row="${row}"]`);
    await pv.waitForTimeout(70);
    const tb = await (await pv.waitForSelector(`${Q(made.dd_scale.id)} .rs-ds-track`)).boundingBox();
    await pv.mouse.click(tb.x + tb.width * frac, tb.y + tb.height / 2);
    await pv.waitForTimeout(70);
  }
  // allocations
  for (const id of [made.dd_alloc.id, made.alloc.id]) {
    for (const [code, n] of [[1, 4], [2, 3], [3, 2]]) {
      for (let i = 0; i < n; i++) { await pv.click(`${Q(id)} [data-testid="chipalloc-plus-${code}"]`); await pv.waitForTimeout(25); }
    }
  }
  // swipe decks: judge one card each, leaving the deck visible
  await pv.click(`${Q(made.rate.id)} .rs-swipex-step[data-code="4"]`);
  await pv.waitForTimeout(120);
  await pv.click(`${Q(made.four.id)} [data-testid="swipe4-right"]`);
  await pv.waitForTimeout(200);

  const overflow = await pv.evaluate(() => ({
    doc: document.documentElement.scrollWidth,
    win: window.innerWidth,
    wide: [...document.querySelectorAll("[data-qid] *")]
      .filter((e) => e.getBoundingClientRect().right > window.innerWidth + 1)
      .slice(0, 6)
      .map((e) => `${e.className || e.tagName}@${Math.round(e.getBoundingClientRect().right)}`),
  }));
  console.log(`${w}px  scrollWidth=${overflow.doc} innerWidth=${overflow.win}`, overflow.wide);
  await pv.screenshot({ path: file, fullPage: true });
  await pv.close();
}

await h.close();
console.log("shots written");

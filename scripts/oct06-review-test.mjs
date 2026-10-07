/**
 * 06-10-2026 WORKBOOK + EMBEDDED DATA URL + ONE QUESTION CONTENT.
 *
 * Every check edits through the Studio's own controls where the requirement
 * is about the builder, reads the stored definition (save / JSON), and opens
 * a runtime preview (Test Survey / respondent view) where it is about what a
 * respondent sees. docs/OCT06-REVIEW-2026-10-07.md maps each check to its ID.
 */
import { openHarness, assert } from "./lib/variantHarness.mjs";
import { openPreview } from "./lib/preview.mjs";
import { openTab } from "./lib/nav.mjs";

const RUNTIME = process.env.RUNTIME_URL ?? "http://localhost:3001";
const h = await openHarness();
const { page } = h;
const errors = [];
page.on("console", (m) => { if (m.type() === "error" && !/favicon|Failed to load resource|net::ERR/.test(m.text())) errors.push(`studio: ${m.text()}`); });
const card = (id) => `[data-testid="qcard"][data-qid="${id}"]`;
const inQ = (id, sel) => `${card(id)} ${sel}`;
const openQ = async (id) => {
  await h.goTab("Questions");
  const c = await page.waitForSelector(card(id));
  await c.scrollIntoViewIfNeeded();
  if (!(await c.evaluate((e) => e.classList.contains("selected")))) {
    await c.click({ position: { x: 30, y: 12 } });
    await page.waitForTimeout(400);
  }
};
const qOf = (def, id) => def.questions.find((q) => q.id === id);
const preview = async (def, opts = {}) => {
  const pv = await openPreview(h.browser, RUNTIME, { definition: def }, opts);
  pv.on("console", (m) => { if (m.type() === "error" && !/favicon|Failed to load resource|net::ERR/.test(m.text())) errors.push(`runtime: ${m.text()}`); });
  return pv;
};
const survey = (questions, extraFlow = []) => ({
  meta: { id: "sandbox", code: "SANDBOX", title: "Oct 06", version: "1.0" },
  questions,
  flow: [...extraFlow, { type: "page", id: "p1", title: "Page 1", questionIds: questions.map((q) => q.id) }, { type: "end", id: "e1", status: "complete" }],
});

const BOARD = `<!DOCTYPE html>
<html lang="en"><head><meta charset="UTF-8"><title>Chess Board</title>
<style>
body { display: flex; justify-content: center; background: #f0f0f0; }
.chess-board { display: grid; grid-template-columns: repeat(8, 60px); border: 4px solid #333; }
.square { width: 60px; height: 60px; display: flex; align-items: center; justify-content: center; font-size: 32px; }
.square:nth-child(odd) { background: #eed7b5; }
</style></head><body><div class="chess-board">${Array.from({ length: 64 }, (_, i) => `<div class="square">${i < 8 ? "♜" : ""}</div>`).join("")}</div></body></html>`;

/** the first eight squares of a board share one row; the ninth starts the next */
const boardShape = (pv, scope) => pv.evaluate((sc) => {
  const sq = [...document.querySelectorAll(`${sc} .chess-board > .square`)];
  if (!sq.length) return null;
  const tops = sq.slice(0, 9).map((e) => Math.round(e.getBoundingClientRect().top));
  return { count: sq.length, row1: new Set(tops.slice(0, 8)).size, nextRow: tops[8] > tops[0], width: Math.round(sq[0].getBoundingClientRect().width) };
}, scope);

/* ============================================ ONE QUESTION CONTENT (R2) */
{
  // a survey saved before: a Text / HTML block with a label AND an HTML Content, a radio with Custom HTML above the input
  await h.loadDef(survey([
    { id: "blk", code: "Q38", variableName: "Q38", type: "html", variant: "content.html", text: "chess board in the content hidden html content", customHtml: BOARD },
    { id: "rad", code: "Q2", variableName: "Q2", type: "single_select", variant: "single_select.radio", text: "Pick one", instruction: "Select one.", customHtml: '<p class="note">Read this first</p>', options: [{ code: 1, label: "A" }, { code: 2, label: "B" }] },
  ]));
  let def = await h.readDef();
  const blk = qOf(def, "blk"), rad = qOf(def, "rad");
  assert.equal(blk.customHtml, undefined, "no rival HTML Content is left in the saved JSON");
  assert.match(blk.text, /class="chess-board"/, "the block's HTML is its text");
  assert.match(blk.notes ?? "", /Label before the HTML content was merged/, "the builder-only label is kept in notes, not lost");
  assert.equal(rad.customHtml, undefined);
  assert.equal(rad.instruction, 'Select one.<p class="note">Read this first</p>', "Custom HTML above the input joined the instruction");
  console.log("✔ legacy HTML Content / Custom HTML migrated into the one content on load");

  await openQ("blk");
  assert.equal(await page.$(inQ("blk", 'textarea.ta.code:not([data-testid])')), null, "no separate HTML Content box on a Text / HTML block");
  assert.ok(!(await page.textContent(card("blk"))).includes("HTML content\n"), "the HTML content label is gone");
  await page.click('[data-testid="close-question"]').catch(() => {});

  // the respondent sees the same board, laid out as 8 × 8, and the page around it untouched
  const pv = await preview(def);
  await pv.waitForSelector('[data-qid="blk"] .chess-board');
  const shape = await boardShape(pv, '[data-qid="blk"]');
  assert.deepEqual({ count: shape.count, row1: shape.row1, nextRow: shape.nextRow, width: shape.width }, { count: 64, row1: 1, nextRow: true, width: 60 }, `8 × 8 board: ${JSON.stringify(shape)}`);
  const pageBody = await pv.evaluate(() => getComputedStyle(document.body).display);
  assert.notEqual(pageBody, "flex", "the block's body{} rule does not re-lay the preview page");
  assert.match(await pv.textContent('[data-qid="rad"]'), /Select one\.\s*Read this first/);
  assert.ok(!(await pv.textContent('[data-qid="blk"]')).includes("Chess Board"), "the <title> is not printed");
  await pv.close();
  console.log("✔ preview: the block's board is 8 × 8, its CSS scoped to it; the radio shows its instruction note");
}

/* ------------------------- Question Text → Rich Text / HTML with its own CSS */
{
  const q = await h.createFromPicker("single_select", "single_select.radio");
  const other = await h.createFromPicker("single_select", "single_select.radio");
  await h.setQuestion(other.id, (x) => { x.text = 'Second <span class="square">question</span>'; });
  await openQ(q.id);
  // the author types HTML + CSS in the editor's HTML tab
  await page.click(inQ(q.id, '.rte .rte-mode:has-text("HTML") >> nth=0'));
  const ta = page.locator(inQ(q.id, ".rte textarea.ta.code")).first();
  await ta.fill(BOARD);
  await ta.blur();
  await page.waitForTimeout(500);
  await page.click(inQ(q.id, '.rte .rte-mode:has-text("Visual") >> nth=0'));
  await page.waitForTimeout(500);
  let def = await h.readDef();
  const saved = qOf(def, q.id).text;
  assert.match(saved, /<style>[\s\S]*grid-template-columns: repeat\(8, 60px\)[\s\S]*<\/style>/, "the <style> is saved with the markup");
  assert.doesNotMatch(saved, /data-rte-src|data-rte-scope/, "the editor's scoping never reaches the saved text");
  // in the Studio's visual editor the board is a grid, and the Studio itself is untouched
  await openQ(q.id);
  const studioBoard = await page.evaluate((sel) => {
    const sq = [...document.querySelectorAll(`${sel} .rte-surface .chess-board > .square`)].slice(0, 9).map((e) => Math.round(e.getBoundingClientRect().top));
    return { row1: new Set(sq.slice(0, 8)).size, n: sq.length };
  }, card(q.id));
  assert.equal(studioBoard.row1, 1, `the visual editor draws the 8 × 8 board: ${JSON.stringify(studioBoard)}`);
  assert.notEqual(await page.evaluate(() => getComputedStyle(document.body).display), "flex", "the Studio page is not re-laid by the question's CSS");

  const pv = await preview(def);
  await pv.waitForSelector(`[data-qid="${q.id}"] .chess-board`);
  const shape = await boardShape(pv, `[data-qid="${q.id}"]`);
  assert.deepEqual({ row1: shape.row1, nextRow: shape.nextRow, width: shape.width }, { row1: 1, nextRow: true, width: 60 }, `question text board is 8 × 8 like the block: ${JSON.stringify(shape)}`);
  const weight = await pv.evaluate((id) => { const t = document.querySelector(`[data-qid="${id}"] .rs-qtext`); return { doc: t.classList.contains("rs-qhtml"), w: getComputedStyle(t.querySelector(".chess-board")).fontWeight }; }, q.id);
  assert.deepEqual(weight, { doc: true, w: "400" }, "a text with its own stylesheet reads as the author styled it, not as the bold heading — as in the block");
  const otherSquare = await pv.evaluate((id) => Math.round(document.querySelector(`[data-qid="${id}"] .square`).getBoundingClientRect().width), other.id);
  assert.notEqual(otherSquare, 60, "the CSS stays in its question — another question's .square is untouched");
  // the same in the narrow device preview
  await pv.setViewportSize({ width: 390, height: 900 });
  await pv.waitForTimeout(200);
  const narrow = await boardShape(pv, `[data-qid="${q.id}"]`);
  assert.equal(narrow.row1, 1, "still 8 across on a phone width (the card scrolls it rather than breaking it)");
  await pv.close();

  // duplicate: the copy carries the same single content
  await openQ(q.id);
  const before = (await h.readDef()).questions.length;
  await openQ(q.id);
  await page.click(inQ(q.id, 'button[title="Duplicate"] >> nth=0'));
  await page.waitForTimeout(500);
  def = await h.readDef();
  assert.equal(def.questions.length, before + 1, "duplicated");
  const copy = def.questions.find((x) => x.id !== q.id && x.text === saved);
  assert.ok(copy, "the copy's text is the same HTML + CSS");
  assert.equal(copy.customHtml, undefined);
  console.log("✔ question text HTML + CSS: saved whole, scoped in the editor and the preview, 8 × 8 like the block; duplicate keeps it");
}

/* ------------------------------------------- the Custom code panel (R2) */
{
  const q = await h.createFromPicker("numeric", "numeric.open");
  await openQ(q.id);
  const prop = await page.$('[data-testid="custom-html-moved"]');
  if (!prop) {
    // the section is collapsed: open it
    await page.click('text=Custom code').catch(() => {});
    await page.waitForTimeout(250);
  }
  assert.ok(await page.$('[data-testid="custom-html-moved"]'), "Custom HTML (above the input) is replaced by a note pointing to the text / instruction");
  assert.equal(await page.$('[data-testid="component-html"]'), null, "only a Custom Component has a template field");
  console.log("✔ Custom code: no separate Custom HTML for ordinary questions");
}

/* ================================================ EMBEDDED DATA — URL (R1) */
const URL1 = "https://example.com/survey?id=123&src=panel&lang=en#part-2";
const ENC = "https://example.com/a%20b/c?q=caf%C3%A9&next=https%3A%2F%2Fo.org%2Fx%3Fa%3D1";
{
  await h.loadDef(survey([
    { id: "pq", code: "Q1", variableName: "Q1", type: "single_line", text: 'Go <a id="go" href="{{ed.redirect_url}}">there</a> — {{ed.redirect_url}} — from link: {{ed.from_link}}' },
  ], [{ type: "embedded_data", id: "ed1", fields: [{ name: "redirect_url", source: "static", dataType: "string", value: "" }, { name: "from_link", source: "url", dataType: "url" }] }]));
  await openTab(page, "Survey Flow");
  await page.waitForSelector(".flow-card.element-card:has(.fn-type.embedded_data)");
  const edCard = await page.$(".flow-card.element-card:has(.fn-type.embedded_data)");
  if (!(await page.$('[data-testid="ed-field"]'))) await edCard.$eval(".block-toggle", (b) => b.click());
  await page.waitForSelector('[data-testid="ed-field"]');
  const options = await page.locator('[data-testid="ed-field"]').first().locator('[data-testid="ed-type"] option').evaluateAll((os) => os.map((o) => o.value));
  assert.ok(options.includes("url"), `URL is a value type: ${options}`);
  const first = page.locator('[data-testid="ed-field"]').first();
  await first.locator('[data-testid="ed-type"]').selectOption("url");
  await first.locator('[data-testid="ed-value"]').fill(URL1);
  await page.waitForTimeout(400);
  assert.equal(await first.locator('[data-testid="ed-preview"]').textContent(), `stored as url: ${URL1}`, "previewed exactly as typed");
  let def = await h.readDef();
  let f = def.flow.find((n) => n.type === "embedded_data").fields[0];
  assert.deepEqual({ name: f.name, type: f.dataType, value: f.value }, { name: "redirect_url", type: "url", value: URL1 }, "name / type / value kept");
  // save → reload (the JSON round trip the Studio saves and reopens) changes nothing
  await h.loadDef(def);
  def = await h.readDef();
  f = def.flow.find((n) => n.type === "embedded_data").fields[0];
  assert.equal(f.value, URL1, "the value survives save and reload byte for byte");
  // invalid is reported
  await openTab(page, "Survey Flow");
  await page.waitForSelector(".flow-card.element-card:has(.fn-type.embedded_data)");
  if (!(await page.$('[data-testid="ed-field"]'))) await (await page.$(".flow-card.element-card:has(.fn-type.embedded_data)")).$eval(".block-toggle", (b) => b.click());
  await page.locator('[data-testid="ed-field"]').first().locator('[data-testid="ed-value"]').fill("example.com/x?id=1");
  await page.waitForTimeout(300);
  assert.match(await page.locator('[data-testid="ed-field"]').first().locator('[data-testid="ed-preview"]').textContent(), /not a URL — it must start with http:\/\/ or https:\/\//);
  await page.locator('[data-testid="ed-field"]').first().locator('[data-testid="ed-value"]').fill(URL1);
  await page.waitForTimeout(300);
  def = await h.readDef();

  // runtime: the fixed value and a URL arriving as a link parameter, piped into text and into a link
  const pv = await preview(def, { search: `?from_link=${encodeURIComponent(ENC)}` });
  await pv.waitForSelector("#go");
  assert.equal(await pv.getAttribute("#go", "href"), URL1, "the link goes exactly to the stored URL");
  const shown = await pv.textContent('[data-qid="pq"]');
  assert.ok(shown.includes(URL1), `the piped text shows the URL as written: ${shown}`);
  assert.ok(shown.includes(ENC), "a URL from the link keeps its own percent-encoding");
  const state = await pv.evaluate(() => (window.__rescriptState ?? {}).embedded);
  assert.equal(state.redirect_url, URL1);
  assert.equal(state.from_link, ENC);
  await pv.close();
  console.log("✔ embedded URL: typed, previewed, saved/reloaded, captured from a link and piped — byte for byte");
}

/* ============================================== LAYOUT — 1 column (A15) */
{
  const q = await h.createFromPicker("single_select", "single_select.radio");
  await h.setQuestion(q.id, (x) => { x.options = [1, 2, 3, 4, 5].map((n) => ({ code: n, label: `Option ${n}` })); });
  await openQ(q.id);
  const opts = await page.$$eval(inQ(q.id, '[data-testid="layout-columns"] option'), (os) => os.map((o) => o.textContent));
  assert.ok(!opts.some((o) => /auto/i.test(o)), `no Auto (Fit Width): ${opts}`);
  assert.ok(["1 column (default)", "2 columns", "3 columns", "4 columns", "5 columns"].every((o) => opts.includes(o)), `1–5 columns offered: ${opts}`);
  assert.equal(await page.$eval(inQ(q.id, '[data-testid="layout-columns"]'), (s) => s.value), "1", "a new question shows 1 column");
  let def = await h.readDef();
  let pv = await preview(def);
  const cls = await pv.getAttribute(`[data-qid="${q.id}"] .rs-options`, "class");
  assert.ok(!/cols-|auto/.test(cls), `5 options are one column in the preview: ${cls}`);
  const lefts = await pv.$$eval(`[data-qid="${q.id}"] .rs-option`, (os) => os.map((o) => Math.round(o.getBoundingClientRect().left)));
  assert.equal(new Set(lefts).size, 1, "all five in one column");
  await pv.close();
  await openQ(q.id);
  await page.selectOption(inQ(q.id, '[data-testid="layout-columns"]'), "3");
  await page.waitForTimeout(300);
  def = await h.readDef();
  assert.equal(qOf(def, q.id).settings.columnsLayout, 3);
  pv = await preview(def);
  assert.match(await pv.getAttribute(`[data-qid="${q.id}"] .rs-options`, "class"), /cols-3/);
  await pv.close();
  console.log("✔ layout: no Auto, 1 column by default, 1–5 offered, the choice reaches the preview");
}

/* ======================================== DATE/TIME RANGE (A111) */
{
  const q = await h.createFromPicker("datetime", "datetime.date_range");
  await openQ(q.id);
  assert.match(await page.textContent(card(q.id)), /Date\/Time Range/, "renamed");
  assert.equal(await page.$(inQ(q.id, 'input[placeholder="placeholder text"]')), null, "no Placeholder Text on From / To");
  assert.ok(await page.$(inQ(q.id, '[data-testid="range-type"]')));
  await page.selectOption(inQ(q.id, '[data-testid="range-date-format"]'), "DD/MM/YYYY");
  await page.waitForTimeout(300);
  let def = await h.readDef();
  let pv = await preview(def);
  const ph = await pv.$$eval(`[data-qid="${q.id}"] .rs-datefield input[type="text"]`, (is) => is.map((i) => i.placeholder));
  assert.deepEqual(ph, ["DD/MM/YYYY", "DD/MM/YYYY"], "From and To both show the chosen format, not mm/dd/yyyy");
  await pv.fill(`[data-qid="${q.id}"] [data-testid="range-date-from-text"]`, "15/01/2026");
  await pv.fill(`[data-qid="${q.id}"] [data-testid="range-date-to-text"]`, "30/01/2026");
  await pv.waitForTimeout(200);
  assert.deepEqual(await h.answerOf(pv, q.id), { from: "2026-01-15", to: "2026-01-30" });
  await pv.close();
  // Time, 24-hour with seconds: both ends switch together
  await openQ(q.id);
  await page.selectOption(inQ(q.id, '[data-testid="range-type"]'), "time");
  await page.waitForTimeout(300);
  await page.selectOption(inQ(q.id, '[data-testid="range-time-format"]'), "24s");
  await page.waitForTimeout(300);
  def = await h.readDef();
  assert.deepEqual(qOf(def, q.id).rows.map((r) => r.fieldType), ["time", "time"], "both ends are times");
  assert.equal(qOf(def, q.id).settings.timeFormat, "24");
  assert.equal(qOf(def, q.id).settings.showSeconds, true);
  pv = await preview(def);
  assert.equal(await pv.locator(`[data-qid="${q.id}"] select[data-part="second"]`).count(), 2, "seconds on both");
  assert.equal(await pv.locator(`[data-qid="${q.id}"] select[data-part="ampm"]`).count(), 0, "no AM/PM in 24-hour");
  await pv.close();
  console.log("✔ date/time range: renamed, no placeholders, one type and one format for both ends, in the preview");
}

/* ===================================== NUMERIC — custom text (A137, A124) */
{
  const cur = await h.createFromPicker("numeric", "numeric.currency");
  await openQ(cur.id);
  assert.equal(await page.$(inQ(cur.id, '[data-testid="currency-symbol"]')), null, "no 'or type a symbol'");
  await page.selectOption(inQ(cur.id, '[data-testid="currency-code"]'), "USD");
  await page.fill(inQ(cur.id, '[data-testid="affix-text"]'), "per month");
  await page.waitForTimeout(300);
  let def = await h.readDef();
  assert.equal(qOf(def, cur.id).settings.affixText, "per month");
  let pv = await preview(def);
  assert.match(await pv.textContent(`[data-qid="${cur.id}"] [data-testid="numeric-affixed"]`), /\$\s*per month/, "the selected $ and the custom text, in place");
  await pv.close();

  const qty = await h.createFromPicker("numeric", "numeric.quantity");
  await openQ(qty.id);
  await page.fill(inQ(qty.id, '[data-testid="affix-text"]'), "kg");
  await page.selectOption(inQ(qty.id, '[data-testid="affix-side"]'), "left");
  await page.waitForTimeout(300);
  def = await h.readDef();
  pv = await preview(def);
  assert.ok(await pv.$(`[data-qid="${qty.id}"] [data-testid="numeric-affix-left"]`), "kg on the left");
  await pv.close();

  const nl = await h.createFromPicker("list", "list.numeric_list");
  await h.setQuestion(nl.id, (x) => { x.rows = [1, 2, 3].map((n) => ({ code: String(n), label: `Statement ${n}`, fieldType: "number", flags: [], validation: [], required: false })); });
  await openQ(nl.id);
  await page.fill(inQ(nl.id, '[data-testid="field-affix-0"]'), "kg");
  await page.waitForTimeout(300);
  def = await h.readDef();
  assert.equal(qOf(def, nl.id).rows[0].meta.affixText, "kg");
  pv = await preview(def);
  const rc = qOf(def, nl.id).rows[0].code;
  assert.equal(await pv.textContent(`[data-qid="${nl.id}"] [data-testid="field-affix-right-${rc}"]`), "kg");
  const w = await pv.$eval(`[data-qid="${nl.id}"] input.rs-numbox`, (i) => i.getBoundingClientRect().width);
  assert.ok(w > 40 && w < 200, `a compact numeric box (${w}px), not the full width`);
  await pv.close();
  console.log("✔ numeric: custom text left/right in every subtype; currency's typed symbol gone; numeric list per-field text and compact boxes");
}

/* ========================================== INSERT MEDIA — layout (A98) */
{
  const q = await h.createFromPicker("single_select", "single_select.radio");
  await openQ(q.id);
  await page.click(inQ(q.id, '.rte [data-testid="rte-media"] >> nth=0'));
  await page.waitForSelector('[data-testid="media-insert"]');
  await page.fill('[data-testid="media-insert-url"]', `${RUNTIME}/test-media/stimulus.png?n=1`);
  await page.click('[data-testid="media-insert-add"]');
  await page.fill('[data-testid="media-insert-url"]', `${RUNTIME}/test-media/stimulus.png?n=2`);
  await page.click('[data-testid="media-insert-add"]');
  await page.fill('[data-testid="media-insert-url"]', `${RUNTIME}/test-media/stimulus.png?n=3`);
  await page.waitForSelector('[data-testid="media-layout"]');
  assert.ok(await page.isChecked('[data-testid="media-layout-vertical"]'), "Vertical is the default");
  await page.check('[data-testid="media-layout-grid"]');
  await page.selectOption('[data-testid="media-layout-columns"]', "3");
  assert.ok(await page.$('[data-testid="media-display-preview"] .rs-media-group[data-rs-layout="grid"][data-rs-cols="3"]'), "the dialog's preview shows the grid");
  await page.click('[data-testid="media-insert-ok"]');
  await page.waitForTimeout(600);
  let def = await h.readDef();
  assert.match(qOf(def, q.id).text, /data-rs-layout="grid" data-rs-cols="3"/);
  let pv = await preview(def);
  const tops = await pv.$$eval(`[data-qid="${q.id}"] .rs-media-group .rs-media-cell`, (cs) => cs.map((c) => Math.round(c.getBoundingClientRect().top)));
  assert.equal(new Set(tops).size, 1, "three items side by side in a 3-column grid");
  await pv.close();
  // carousel: ← → step through
  await h.setQuestion(q.id, (x) => { x.text = x.text.replace('data-rs-layout="grid" data-rs-cols="3"', 'data-rs-layout="carousel"'); });
  def = await h.readDef();
  pv = await preview(def);
  await pv.waitForSelector(`[data-qid="${q.id}"] [data-testid="media-carousel-next"]`);
  assert.equal(await pv.getAttribute(`[data-qid="${q.id}"] .rs-media-group`, "data-rs-index"), "0");
  await pv.click(`[data-qid="${q.id}"] [data-testid="media-carousel-next"]`);
  await pv.waitForTimeout(700);
  const car = await pv.evaluate((id) => { const g = document.querySelector(`[data-qid="${id}"] .rs-media-group`); return { idx: g.getAttribute("data-rs-index"), sl: g.scrollLeft, cw: g.clientWidth, sw: g.scrollWidth, n: document.querySelectorAll(`[data-qid="${id}"] .rs-media-group`).length, cells: [...g.children].map((c) => [Math.round(c.getBoundingClientRect().left), Math.round(c.getBoundingClientRect().top), Math.round(c.getBoundingClientRect().width)]), fd: getComputedStyle(g).flexDirection, wrap: getComputedStyle(g).flexWrap, gl: Math.round(g.getBoundingClientRect().left), ov: getComputedStyle(g).overflowX, disp: getComputedStyle(g).display, parent: g.parentElement.tagName + "." + g.parentElement.className + ":" + getComputedStyle(g.parentElement).display, navs: document.querySelectorAll(`[data-qid="${id}"] [data-testid="media-carousel-nav"]`).length, html: g.outerHTML.slice(0, 300) }; }, q.id);
  assert.equal(car.idx, "1", `Next shows the second item: ${JSON.stringify(car)}`);
  await pv.close();
  console.log("✔ insert media: several items get a layout (vertical default; grid with columns; carousel with ← →), the same in the preview");
}

assert.deepEqual(errors, [], `no console errors:\n${errors.join("\n")}`);
await h.close();
console.log("\nOCT 06 SUITE: all checks passed");

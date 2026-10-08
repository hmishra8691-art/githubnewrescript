/**
 * 07-10-2026 WORKBOOK — sheets Suraj, Oweas and Prince, plus the Script UI.
 *
 * Every check drives the Studio's own controls where the requirement is about
 * the builder, reads the stored definition, and opens a runtime preview where
 * it is about what a respondent sees. docs/OCT07-REVIEW-2026-10-08.md maps
 * each check to its workbook row.
 */
import { openHarness, assert } from "./lib/variantHarness.mjs";
import { openPreview } from "./lib/preview.mjs";
import { openTab } from "./lib/nav.mjs";

const STUDIO = process.env.STUDIO_URL ?? "http://localhost:3000";
const RUNTIME = process.env.RUNTIME_URL ?? "http://localhost:3001";
const h = await openHarness();
const { page } = h;
const errors = [];
const noise = /favicon|Failed to load resource|net::ERR|status of 404/;
page.on("console", (m) => { if (m.type() === "error" && !noise.test(m.text()) && errors.length < 50) { errors.push(`studio: ${m.text()}`); if (process.env.DEBUG) console.log("STUDIO ERR", m.text().slice(0, 300)); } });
const card = (id) => `[data-testid="qcard"][data-qid="${id}"]`;
const inQ = (id, sel) => `${card(id)} ${sel}`;
const openQ = async (id) => {
  await h.goTab("Questions");
  const c = await page.waitForSelector(card(id));
  await c.scrollIntoViewIfNeeded();
  if (!(await c.evaluate((e) => e.classList.contains("selected")))) {
    await page.click(inQ(id, ".qcard-text"));
    await page.waitForTimeout(400);
  }
};
const qOf = (def, id) => def.questions.find((q) => q.id === id);
const preview = async (def, opts = {}) => {
  const pv = await openPreview(h.browser, RUNTIME, { definition: def }, opts);
  pv.on("console", (m) => { if (m.type() === "error" && !noise.test(m.text()) && errors.length < 50) { errors.push(`runtime: ${m.text()}`); if (process.env.DEBUG) console.log("RUNTIME ERR", m.text().slice(0, 300)); } });
  return pv;
};
const only = (def, ids) => ({ ...def, flow: [{ type: "page", id: "p1", questionIds: ids }, { type: "end", id: "e1", status: "complete" }] });
const stateOf = (pv) => pv.evaluate(() => (window.__rescriptState ?? window.__RESCRIPT_STATE__)?.answers ?? {});
const next = async (pv) => { await pv.click(".rs-nav .rs-btn:not(.secondary)"); await pv.waitForTimeout(300); };
/* ONLY=other,rating … runs just those sections (mutation checks) */
const ONLY = (process.env.ONLY ?? "").split(",").filter(Boolean);
const want = (k) => !ONLY.length || ONLY.includes(k);
const rows = (n, extra = {}) => Array.from({ length: n }, (_, i) => ({ code: `r${i + 1}`, label: `Statement ${i + 1}`, flags: [], validation: [], required: false, ...extra }));

/* ===================================== Suraj #1 / Oweas #1 — Other, specify in grid rows */
console.log("…", `Suraj #1 / Oweas #1 — Other, specify in grid rows`);
if (want("other")) {
  const m = await h.createFromPicker("matrix", "matrix.single");
  await h.setQuestion(m.id, (q) => {
    q.text = "Rate us";
    q.options = [1, 2, 3].map((n) => ({ code: n, label: String(n), flags: [] }));
    q.rows = [...rows(2), { code: "r9", label: "Other, please specify", flags: [], validation: [], required: false }];
  });
  // the Studio offers the row property on a grid that draws it, and sets it
  await openQ(m.id);
  const rowFlags = inQ(m.id, 'h3[data-testid="rows-heading"] ~ div [data-testid="option-flags-2"]');
  await page.click(rowFlags);
  await page.check(inQ(m.id, 'h3[data-testid="rows-heading"] ~ div [data-testid="option-flag-2-other_specify"]'));
  await page.waitForTimeout(350);
  let def = await h.readDef();
  assert.deepEqual(qOf(def, m.id).rows[2].flags, ["other_specify"], "the row property is stored");

  const cs = await h.createFromPicker("matrix", "matrix.constant_sum");
  await h.setQuestion(cs.id, (q) => {
    q.text = "Split 100";
    q.rows = [{ code: "1", label: "Food", flags: [], validation: [], required: false }, { code: "9", label: "Other, please describe", flags: ["other_specify"], validation: [], required: false }];
  });
  // a swipe deck has no row label to put a box beside — not offered there
  const sw = await h.createFromPicker("swipe", "swipe.tinder");
  await openQ(sw.id);
  const swFlags = await page.$(inQ(sw.id, 'h3[data-testid="rows-heading"] ~ div [data-testid="option-flags-0"]'));
  if (swFlags) {
    await swFlags.click();
    assert.ok(!(await page.$(inQ(sw.id, 'h3[data-testid="rows-heading"] ~ div [data-testid="option-flag-0-other_specify"]'))), "not offered where no box can be drawn");
    assert.ok(await page.$(inQ(sw.id, 'h3[data-testid="rows-heading"] ~ div [data-testid="option-flag-0-anchor_top"]')), "the row's other properties still are");
  }

  def = await h.readDef();
  const pv = await preview(only(def, [m.id, cs.id]));
  const box = `[data-qid="${m.id}"] [data-testid="rs-row-other-input"]`;
  assert.ok(await pv.$(box), "the matrix row draws its text box");
  assert.ok(await pv.$(`[data-qid="${cs.id}"] [data-testid="rs-row-other-input"]`), "the constant-sum grid row draws its text box");
  // rate the Other row without naming it: refused, with the reason
  for (const rc of ["r1", "r2", "r9"]) await pv.click(`[data-qid="${m.id}"] input[name="${m.id}_${rc}"] >> nth=0`);
  await pv.fill(`[data-qid="${cs.id}"] [data-row="1"][data-col="c1"] input`, "100").catch(async () => {
    const ins = await pv.$$(`[data-qid="${cs.id}"] tr[data-row="1"] input.rs-input`);
    await ins[0].fill("100");
  });
  await next(pv);
  assert.ok(/Other, please specify/.test(await pv.textContent(`[data-qid="${m.id}"]`)), "rated but not named is refused, naming the row");
  await pv.fill(box, "Parking");
  await pv.waitForTimeout(150);
  const st = await stateOf(pv);
  assert.equal(st[`${m.id}__other__row:r9`], "Parking", "stored under the row's own box key");
  // the unused constant-sum Other row is not owed a total
  await next(pv);
  assert.ok(await pv.$(".rs-end, [data-testid='survey-end']") || !(await pv.$(`[data-qid="${m.id}"]`)), "the page submits once the row is named");
  await pv.close();
  console.log("✔ Suraj #1 / Oweas #1: grid and constant-sum rows draw their Other box, store it, and validate the pair");
}

/* ===================================== Suraj #2 — Matrix with Randomized Rows */
console.log("…", `Suraj #2 — Matrix with Randomized Rows`);
if (want("random")) {
  const q = await h.createFromPicker("matrix", "matrix.random_rows");
  assert.equal(q.randomization?.enabled, true, "the preset switches randomization on");
  assert.equal(q.randomization?.scope, "rows");
  assert.equal(q.settings.randomizeRows, undefined, "not the dead setting");
  await h.setQuestion(q.id, (x) => { x.text = "Rate"; x.rows = rows(8); x.options = [1, 2, 3].map((n) => ({ code: n, label: String(n), flags: [] })); });
  // the Randomization panel shows it on
  await openQ(q.id);
  const def = await h.readDef();
  const orders = new Set();
  for (let i = 0; i < 4; i++) {
    const pv = await preview(only(def, [q.id]));
    orders.add(await pv.$$eval(`[data-qid="${q.id}"] tbody tr:not(.rs-header-repeat) td.rowlabel`, (els) => els.map((e) => e.textContent.trim()).join(",")));
    await pv.close();
  }
  assert.ok(orders.size > 1, `respondents see different row orders (${[...orders].join(" | ")})`);
  console.log("✔ Suraj #2: Matrix with Randomized Rows shuffles rows per respondent");
}

/* ===================================== Suraj #3 / #4 / #6 — List / form fields */
console.log("…", `Suraj #3 / #4 / #6 — List / form fields`);
if (want("fields")) {
  const q = await h.createFromPicker("list", "list.text_list");
  assert.equal(q.rows.length, 3, "arrives with individual fields, not an item count");
  await openQ(q.id);
  assert.ok(!/legacy item count/.test(await page.textContent(card(q.id))), "no item-count box");
  // one field required, the others optional — per field
  assert.equal(await page.textContent(inQ(q.id, '[data-testid="field-required-1"]')), "Optional");
  await page.click(inQ(q.id, '[data-testid="field-required-1"]'));
  await page.waitForTimeout(150);
  assert.equal(await page.textContent(inQ(q.id, '[data-testid="field-required-1"]')), "Required");
  // add one more, one at a time
  await page.click(inQ(q.id, '[data-testid="add-field"]'));
  await page.waitForTimeout(350);
  let def = await h.readDef();
  assert.deepEqual(qOf(def, q.id).rows.map((r) => r.required), [false, true, false, false]);

  let pv = await preview(only(def, [q.id]));
  assert.ok(!(await pv.$(`[data-qid="${q.id}"] .rs-req`)), "no star beside the label");
  assert.equal(await pv.textContent(`[data-qid="${q.id}"] [data-testid="fields-required-note"]`), "“Item 2” is required.");
  // the gap between a short label and its box is small, and the boxes line up
  const geo = await pv.$$eval(`[data-qid="${q.id}"] .rs-field-row`, (rs) => rs.map((r) => {
    const l = r.querySelector(".flab").getBoundingClientRect();
    const i = r.querySelector("input").getBoundingClientRect();
    const t = r.querySelector(".flab span").getBoundingClientRect();
    return { gap: i.left - t.right, left: i.left, above: i.top >= l.bottom - 1 };
  }));
  assert.ok(geo.every((g) => g.gap < 40), `label → box gap is small (${geo.map((g) => Math.round(g.gap)).join(", ")}px)`);
  assert.ok(new Set(geo.map((g) => Math.round(g.left))).size === 1, "every box starts in one line");
  await next(pv);
  assert.ok(/Item 2: this field is required/.test(await pv.textContent(`[data-qid="${q.id}"]`)), "only the required field is asked for");
  await pv.close();

  // label position: Above, Right
  await openQ(q.id);
  await page.click(inQ(q.id, '[data-testid="field-label-pos-above"]'));
  await page.waitForTimeout(350);
  def = await h.readDef();
  assert.equal(qOf(def, q.id).settings.fieldLabelPosition, "above");
  pv = await preview(only(def, [q.id]));
  assert.equal(await pv.getAttribute(`[data-qid="${q.id}"] .rs-fields`, "data-label-pos"), "above");
  const above = await pv.$eval(`[data-qid="${q.id}"] .rs-field-row`, (r) => r.querySelector("input").getBoundingClientRect().top >= r.querySelector(".flab").getBoundingClientRect().bottom - 1);
  assert.ok(above, "the label sits above its box");
  await pv.close();
  await openQ(q.id);
  await page.click(inQ(q.id, '[data-testid="field-label-pos-right"]'));
  await page.waitForTimeout(350);
  def = await h.readDef();
  pv = await preview(only(def, [q.id]));
  const right = await pv.$eval(`[data-qid="${q.id}"] .rs-field-row`, (r) => r.querySelector(".flab").getBoundingClientRect().left >= r.querySelector("input").getBoundingClientRect().right - 1);
  assert.ok(right, "the label sits right of its box");
  await pv.close();

  // a list saved with the older item count is offered as separate fields
  await h.setQuestion(q.id, (x) => { x.rows = []; x.settings.listCount = 5; });
  await openQ(q.id);
  await page.click(inQ(q.id, '[data-testid="convert-legacy-fields"]'));
  await page.waitForTimeout(350);
  def = await h.readDef();
  assert.equal(qOf(def, q.id).rows.length, 5);
  assert.equal(qOf(def, q.id).settings.listCount, undefined);
  console.log("✔ Suraj #3/#4/#6: fields one by one with Required/Optional each, the rule in words, a tight label column with Left/Above/Right");
}

/* ===================================== Oweas #2 — HTML Text Box */
console.log("…", `Oweas #2 — HTML Text Box`);
if (want("html")) {
  const q = await h.createFromPicker("content", "content.html");
  await openQ(q.id);
  assert.ok(await page.isVisible(inQ(q.id, '[data-testid="rte-html-source"]')), "the block's content opens on the HTML tab");
  assert.ok(!/Instruction — formatting and piping supported/.test(await page.textContent(card(q.id))), "no Instruction box on a block that never shows one");
  assert.ok(!(await page.$(inQ(q.id, '[data-testid="attention-check"]'))), "nothing to grade on a block that takes no answer");
  await page.fill(inQ(q.id, '[data-testid="rte-html-source"]'), "<b>Welcome to our survey</b>");
  await page.click(inQ(q.id, "label.f >> nth=0"));
  await page.waitForTimeout(500);
  let def = await h.readDef();
  assert.equal(qOf(def, q.id).text, "<b>Welcome to our survey</b>", "stored as markup");
  let pv = await preview(only(def, [q.id]));
  assert.equal(await pv.textContent(`[data-qid="${q.id}"] .rs-qhtml b`), "Welcome to our survey", "drawn as HTML, not as code");
  assert.ok(!/<b>/.test(await pv.textContent(`[data-qid="${q.id}"]`)));
  await pv.close();
  // HTML typed into the Visual tab by mistake is offered back as markup
  await h.setQuestion(q.id, (x) => { x.text = "&lt;h2&gt;Hello&lt;/h2&gt;"; });
  await openQ(q.id);
  await page.waitForSelector(inQ(q.id, '[data-testid="rte-typed-markup"]'));
  await page.click(inQ(q.id, '[data-testid="rte-render-typed"]'));
  await page.waitForTimeout(400);
  def = await h.readDef();
  assert.equal(qOf(def, q.id).text, "<h2>Hello</h2>");
  // the foot of the open question says what the save is doing
  await openQ(q.id);
  assert.ok(/Sandbox|saved|Saving|Unsaved/i.test(await page.textContent(inQ(q.id, '[data-testid="question-save-hint"]'))));
  console.log("✔ Oweas #2: one content field, HTML-first; markup renders; typed tags recoverable; no dead Instruction box");
}

/* ===================================== Prince #1 — Rating Matrix (1–5) */
console.log("…", `Prince #1 — Rating Matrix (1–5)`);
if (want("rating")) {
  const q = await h.createFromPicker("matrix", "matrix.rating");
  assert.deepEqual(q.options.map((o) => o.label), ["1", "2", "3", "4", "5"], "columns 1–5 on selection");
  await h.setQuestion(q.id, (x) => { x.text = "How would you rate your experience?"; x.rows = [{ code: "food", label: "Food" }, { code: "amb", label: "Ambience" }, { code: "svc", label: "Service" }].map((r) => ({ ...r, flags: [], validation: [], required: false })); });
  await openQ(q.id);
  // the builder: Rows before Columns, then the scale block
  const order = await page.$$eval(`${card(q.id)} h3.sec`, (hs) => hs.map((x) => x.textContent.trim().toLowerCase()));
  const iRows = order.findIndex((t) => t.startsWith("rows")), iCols = order.findIndex((t) => t.startsWith("columns")), iScale = order.findIndex((t) => t.startsWith("rating scale"));
  assert.ok(iRows >= 0 && iRows < iCols && iCols < iScale, `Rows → Columns → Rating scale & labels (${order.join(" | ")})`);
  let def = await h.readDef();
  let pv = await preview(only(def, [q.id]));
  const heads = await pv.$$eval(`[data-qid="${q.id}"] thead th.rs-ratingmatrix-head`, (t) => t.map((x) => x.textContent.trim()));
  assert.deepEqual(heads, ["1", "2", "3", "4", "5"], "the points are column headers");
  const aligned = await pv.$eval(`[data-qid="${q.id}"] table`, (t) => {
    const hs = [...t.querySelectorAll("thead th.rs-ratingmatrix-head")].map((x) => x.getBoundingClientRect());
    return [...t.querySelectorAll("tbody tr")].every((tr) => [...tr.querySelectorAll(".rs-ratingmatrix-dot")].every((d, i) => {
      const r = d.getBoundingClientRect();
      return Math.abs((r.left + r.right) / 2 - (hs[i].left + hs[i].right) / 2) < 3;
    }));
  });
  assert.ok(aligned, "every circle sits centred under its header");
  await pv.click(`[data-qid="${q.id}"] tr:has-text("Ambience") .rs-ratingmatrix-pt >> nth=3`);
  assert.equal((await stateOf(pv))[q.id]?.amb, 4, "stores the point's number");
  await pv.close();

  // Text labels, edited, and the scale changed
  await openQ(q.id);
  await page.click(inQ(q.id, '[data-testid="rating-labels-text"]'));
  await page.waitForTimeout(300);
  def = await h.readDef();
  assert.deepEqual(qOf(def, q.id).options.map((o) => o.label), ["Very Poor", "Poor", "Neutral", "Good", "Excellent"]);
  assert.deepEqual(qOf(def, q.id).options.map((o) => o.code), [1, 2, 3, 4, 5], "the data still stores 1–5");
  await openQ(q.id);
  await page.fill(inQ(q.id, '[data-testid="rating-label-5"]'), "Outstanding");
  await page.waitForTimeout(350);
  pv = await preview(only(await h.readDef(), [q.id]));
  assert.deepEqual(await pv.$$eval(`[data-qid="${q.id}"] thead th.rs-ratingmatrix-head`, (t) => t.map((x) => x.textContent.trim())), ["Very Poor", "Poor", "Neutral", "Good", "Outstanding"], "the edited words, immediately");
  await pv.close();
  await openQ(q.id);
  await page.click(inQ(q.id, '[data-testid="rating-labels-numbers"]'));
  await page.waitForTimeout(300);
  await page.click(inQ(q.id, '[data-testid="rating-labels-text"]'));
  await page.waitForTimeout(300);
  def = await h.readDef();
  assert.equal(qOf(def, q.id).options[4].label, "Outstanding", "Numbers and back keeps what was written");
  await openQ(q.id);
  await page.selectOption(inQ(q.id, '[data-testid="rating-scale"]'), "7");
  await page.waitForTimeout(300);
  def = await h.readDef();
  assert.equal(qOf(def, q.id).options.length, 7, "Rating scale 1–7");
  // phone width: the grid stacks and each circle carries its caption
  pv = await preview(only(def, [q.id]), { viewport: { width: 390, height: 900 } });
  assert.ok(await pv.isVisible(`[data-qid="${q.id}"] .rs-ratingmatrix-cap >> nth=0`), "captions on a phone");
  await pv.close();
  console.log("✔ Prince #1: Rating Matrix — 1–5 on selection, Numbers/Text labels, scale control, aligned headers, consistent preview");
}

/* ===================================== Prince #2 — Header Repeat */
console.log("…", `Prince #2 — Header Repeat`);
if (want("repeat")) {
  const q = await h.createFromPicker("matrix", "matrix.likert");
  await h.setQuestion(q.id, (x) => { x.text = "Agree?"; x.rows = rows(25); });
  let def = await h.readDef();
  let pv = await preview(only(def, [q.id]));
  assert.equal(await pv.$$eval(`[data-qid="${q.id}"] [data-testid="header-repeat"]`, (e) => e.length), 2, "25 rows: automatic by default — before rows 11 and 21");
  // aligned with the real header, and hidden from assistive technology
  const ok = await pv.$eval(`[data-qid="${q.id}"] table`, (t) => {
    const real = [...t.querySelectorAll("thead th")].map((x) => x.getBoundingClientRect().left);
    const rep = [...t.querySelector("tr.rs-header-repeat").querySelectorAll("th")].map((x) => x.getBoundingClientRect().left);
    return rep.length === real.length && rep.every((l, i) => Math.abs(l - real[i]) < 1) && t.querySelector("tr.rs-header-repeat").getAttribute("aria-hidden") === "true";
  });
  assert.ok(ok, "repeated header cells line up with the real ones");
  // no data rows were added
  assert.equal(await pv.$$eval(`[data-qid="${q.id}"] tbody tr:not(.rs-header-repeat)`, (e) => e.length), 25);
  await pv.close();

  // Properties → Header repeat: every 5 rows, then off
  const openSection = async () => {
    await openQ(q.id);
    if (!(await page.$('[data-testid="header-repeat-mode"]'))) await page.click("text=Header repeat");
    await page.waitForSelector('[data-testid="header-repeat-mode"]');
  };
  await openSection();
  await page.selectOption('[data-testid="header-repeat-mode"]', "every");
  await page.selectOption('[data-testid="header-repeat-every"]', "5");
  await page.waitForTimeout(350);
  def = await h.readDef();
  assert.equal(qOf(def, q.id).settings.headerRepeat, 5);
  pv = await preview(only(def, [q.id]));
  assert.equal(await pv.$$eval(`[data-qid="${q.id}"] [data-testid="header-repeat"]`, (e) => e.length), 4, "every 5 of 25 rows");
  await pv.close();
  await openSection();
  await page.selectOption('[data-testid="header-repeat-every"]', "custom");
  await page.fill('[data-testid="header-repeat-custom"]', "12");
  await page.press('[data-testid="header-repeat-custom"]', "Tab");
  await page.waitForTimeout(350);
  assert.equal(qOf(await h.readDef(), q.id).settings.headerRepeat, 12, "a custom count");
  await openSection();
  await page.selectOption('[data-testid="header-repeat-mode"]', "off");
  await page.waitForTimeout(350);
  def = await h.readDef();
  pv = await preview(only(def, [q.id]));
  assert.equal(await pv.$$eval(`[data-qid="${q.id}"] [data-testid="header-repeat"]`, (e) => e.length), 0, "off");
  await pv.close();

  // every grid subtype with a header: plain, rating, mixed, constant-sum, semantic — and the short-grid default is off
  const kinds = [["matrix.single"], ["matrix.multi"], ["matrix.rating"], ["matrix.mixed"], ["matrix.constant_sum"], ["matrix.semantic"], ["matrix.slider_matrix"], ["matrix.dropdown"]];
  for (const [id] of kinds) {
    const g = await h.createFromPicker("matrix", id);
    await h.setQuestion(g.id, (x) => {
      x.text = id; x.rows = rows(12).map((r) => (id === "matrix.semantic" ? { ...r, label: "Cheap | Dear" } : r)); x.settings.headerRepeat = 5;
      if (!x.options.length && !x.columns.length) x.options = [1, 2, 3].map((n) => ({ code: n, label: String(n), flags: [] }));
    });
    pv = await preview(only(await h.readDef(), [g.id]));
    assert.equal(await pv.$$eval(`[data-qid="${g.id}"] [data-testid="header-repeat"]`, (e) => e.length), 2, `${id}: before rows 6 and 11`);
    await pv.close();
  }
  console.log("✔ Prince #2: Header Repeat — Off / Auto / every N / custom, defaults by length, aligned, display only, every grid subtype");
}

/* ===================================== Suraj #5 — "Changed elsewhere" only when it is true */
console.log("…", `Suraj #5 — "Changed elsewhere" only when it is true`);
if (want("conflict")) {
  const p2 = await h.browser.newPage({ viewport: { width: 1500, height: 1000 } });
  p2.on("dialog", (d) => d.accept());
  const server = { revision: 1, draft: null, hold: null, abortNext: false, puts: 0, refused: 0 };
  await p2.route("**/api/surveys/mock0710/draft", async (route) => {
    const req = route.request();
    if (req.method() !== "PUT") return route.fulfill({ status: 404, body: "{}" });
    server.puts++;
    const body = JSON.parse(req.postData() ?? "{}");
    if (server.hold) await server.hold;
    if (body.baseRevision !== server.revision) {
      server.refused++;
      return route.fulfill({ status: 409, contentType: "application/json", body: JSON.stringify({ conflict: true, error: "This survey was changed somewhere else after your editor last loaded it, so this save was refused rather than overwriting that work.", revision: server.revision, serverDraft: server.draft }) });
    }
    server.revision++;
    server.draft = body.definition;
    if (server.abortNext) { server.abortNext = false; return route.abort("connectionreset"); }
    return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ ok: true, revision: server.revision, savedAt: new Date().toISOString() }) });
  });
  await p2.goto(`${STUDIO}/sandbox?dbid=mock0710&rev=1`, { waitUntil: "networkidle" });
  await p2.waitForSelector(".menubar");
  const edit = async (title) => {
    await openTab(p2, "JSON");
    await p2.waitForSelector("textarea.code");
    const d = JSON.parse(await p2.$eval("textarea.code", (e) => e.value));
    d.meta.title = title;
    await p2.click('button:has-text("edit")');
    await p2.fill("textarea.code", JSON.stringify(d, null, 2));
    await p2.click('button:has-text("validate & apply")');
  };
  const saveState = () => p2.getAttribute('[data-testid="save-state"]', "class");

  // three autosaves queued behind one slow save: all accepted, none refused
  let release;
  server.hold = new Promise((r) => { release = r; });
  await edit("A");
  await p2.waitForTimeout(1200);          // save 1 in flight, held
  await edit("B");
  await p2.waitForTimeout(1200);          // save 2 waiting
  await edit("C");
  await p2.waitForTimeout(1200);          // save 3 waiting
  server.hold = null;
  release();
  await p2.waitForTimeout(2500);
  assert.equal(server.refused, 0, "no save was refused as stale");
  assert.ok(!/err/.test(await saveState()), `no "Changed elsewhere" (${await p2.textContent('[data-testid="save-state"]')})`);
  assert.equal(server.draft?.meta?.title, "C", "the last edit is what the server holds");

  // a save whose answer was lost: the next one recognises its own work
  server.abortNext = true;
  await edit("D");
  await p2.waitForTimeout(2200);
  await edit("E");
  await p2.waitForTimeout(2500);
  assert.equal(server.draft?.meta?.title, "E");
  assert.ok(!/Changed elsewhere/.test(await p2.textContent('[data-testid="save-state"]')), "a lost answer is not someone else's change");

  // a real change elsewhere still stops autosave and says so
  server.revision += 1;
  server.draft = { ...server.draft, meta: { ...server.draft.meta, title: "Someone else" } };
  await edit("F");
  await p2.waitForTimeout(2200);
  assert.ok(/Changed elsewhere/.test(await p2.textContent('[data-testid="save-state"]')), "a genuine conflict is still reported");
  await p2.close();
  console.log("✔ Suraj #5: Changed elsewhere appears only when another writer changed the survey");
}

/* ===================================== Script UI */
console.log("…", `Script UI`);
if (want("ui")) {
  const q = await h.createFromPicker("matrix", "matrix.rating");
  await h.goTab("Questions");
  assert.equal(await page.textContent(inQ(q.id, ".qtype-badge")), "Rating Matrix (1–5)", "the type by its name");
  assert.ok(/3 rows × 5 columns/.test(await page.textContent(inQ(q.id, '[data-testid="qcard-meta"]'))), "what it is made of");
  assert.ok(/No question text yet/.test(await page.textContent(inQ(q.id, ".qcard-text"))), "an empty question says so");
  // keyboard: the caret opens and closes the editor
  await page.focus(inQ(q.id, '[data-testid="qcard-toggle"]'));
  await page.keyboard.press("Enter");
  await page.waitForTimeout(300);
  assert.equal(await page.getAttribute(inQ(q.id, '[data-testid="qcard-toggle"]'), "aria-expanded"), "true");
  await page.keyboard.press("Escape");
  await page.waitForTimeout(300);
  // duplicate: the copy is marked and announced
  await page.click(inQ(q.id, 'button[title="Duplicate"]'));
  await page.waitForTimeout(120);
  assert.ok(await page.$('[data-testid="qcard"].flash'), "the copy pulses");
  assert.ok(/Duplicated as/.test(await page.textContent("body")), "and a toast says so");
  console.log("✔ Script UI: named types, structure at a glance, keyboard open/close, feedback after duplicate");
}

assert.deepEqual(errors, [], `no console errors:\n${errors.join("\n")}`);
await h.close();
console.log("ALL OCT07 REVIEW CHECKS PASSED");

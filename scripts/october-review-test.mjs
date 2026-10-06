/**
 * OCTOBER 2026 REVIEW — the builder sections and the respondent behaviour the
 * two review spreadsheets asked for (docs/OCTOBER-REVIEW-BUILDERS-2026-10-06.md
 * maps each check to its requirement ID).
 *
 * Each check edits the question the way a programmer would — through the
 * builder's own controls — then reads the stored definition, and where the
 * requirement is about the respondent, opens a runtime preview and answers.
 */
import { openHarness, assert } from "./lib/variantHarness.mjs";

const h = await openHarness();
const { page } = h;
const card = (id) => `[data-testid="qcard"][data-qid="${id}"]`;
const inQ = (id, sel) => `${card(id)} ${sel}`;
const openQ = async (id) => {
  await h.goTab("Questions");
  const c = await page.waitForSelector(card(id));
  await c.scrollIntoViewIfNeeded();
  /* a click on an open card closes it — open only when it is not already */
  if (!(await c.evaluate((e) => e.classList.contains("selected")))) {
    await c.click({ position: { x: 30, y: 12 } });
    await page.waitForTimeout(400);
  }
  assert.ok(await c.evaluate((e) => e.classList.contains("selected")), `question ${id} is open`);
};
const has = async (id, testid) => !!(await page.$(inQ(id, `[data-testid="${testid}"]`)));
const qOf = (def, id) => def.questions.find((q) => q.id === id);
const at = (id, sel) => `[data-qid="${id}"] ${sel}, #q-${id} ${sel}`;

/* ---------------------------------------------- S: the search box setting */
{
  const radio = await h.createFromPicker("single_select", "single_select.radio");
  const cards = await h.createFromPicker("single_select", "single_select.cards");
  const dd = await h.createFromPicker("single_select", "single_select.dropdown");
  await openQ(radio.id);
  assert.ok(await has(radio.id, "option-search"), "the plain radio list keeps its search box setting");
  await openQ(cards.id);
  assert.ok(!(await has(cards.id, "option-search")), "Card Select draws no search box, so offers no setting");
  await openQ(dd.id);
  assert.ok(!(await has(dd.id, "option-search")), "a Dropdown's search would duplicate the dropdown");
  console.log("✔ search box offered only where one is drawn");
}

/* -------------------------------------------------- N: numeric controls */
{
  const pct = await h.createFromPicker("numeric", "numeric.percentage");
  await openQ(pct.id);
  assert.ok(await has(pct.id, "fixed-symbol"), "Percentage shows its fixed % symbol");
  assert.ok(!(await has(pct.id, "currency-code")), "Percentage offers no currency");
  assert.ok(!(await has(pct.id, "stepper")), "Percentage offers no stepper");

  const open = await h.createFromPicker("numeric", "numeric.open");
  await openQ(open.id);
  assert.ok(await has(open.id, "number-sign"), "Numeric Open End can be held to positive / negative");
  await page.selectOption(inQ(open.id, '[data-testid="number-format"]'), "whole");
  await page.waitForTimeout(250);
  let def = await h.readDef();
  assert.ok(qOf(def, open.id).validation.some((r) => r.kind === "integer"), "whole numbers only is the integer rule");

  const pv = await h.preview([open.id]);
  const input = pv.locator(`[data-qid="${open.id}"] input`).first();
  await input.click();
  await pv.keyboard.type("2.5");
  await pv.waitForTimeout(150);
  const v = await h.answerOf(pv, open.id);
  assert.ok(Number.isInteger(Number(v)), `a whole-number field refuses the decimal point (got ${v})`);
  await pv.close();
  console.log("✔ numeric: per-subtype controls; whole numbers refuse a decimal keystroke");
}

/* ------------------------------------------------- P: pairwise + Field */
{
  const pw = await h.createFromPicker("single_select", "single_select.pairwise_set");
  await openQ(pw.id);
  assert.ok(await has(pw.id, "pair-0"), "the pair editor shows pair 1");
  await page.click(inQ(pw.id, '[data-testid="pair-add"]'));
  await page.waitForTimeout(250);
  const def = await h.readDef();
  const q = qOf(def, pw.id);
  assert.equal(q.rows.length, 2, "+ Field adds a whole pair");
  assert.equal(q.options.length, 4, "…with its two options");
  assert.deepEqual(q.rows[1].meta, { left: String(q.options[2].code), right: String(q.options[3].code) });
  console.log("✔ pairwise: + Field adds Option C / Option D as pair 2");
}

/* ------------------------------------------------------ W: swipe cards */
{
  const sw = await h.createFromPicker("swipe", "swipe.tinder");
  await openQ(sw.id);
  assert.equal((await page.textContent(inQ(sw.id, '[data-testid="rows-heading"]'))).trim(), "Cards");
  assert.match(await page.textContent(inQ(sw.id, '[data-testid="add-option"] >> nth=-1')), /\+ Add card/);
  await page.fill(inQ(sw.id, '[data-testid="card-0-subtitle"]'), "Premium wireless headphones");
  await page.fill(inQ(sw.id, '[data-testid="card-0-price"]'), "99");
  await page.selectOption(inQ(sw.id, '[data-testid="card-0-currency"]'), "USD");
  await page.click(inQ(sw.id, '[data-testid="card-0-add-field"]'));
  await page.fill(inQ(sw.id, '[data-testid="card-0-field-0-label"]'), "Location");
  await page.fill(inQ(sw.id, '[data-testid="card-0-field-0-value"]'), "Mumbai");
  await page.waitForTimeout(250);
  const def = await h.readDef();
  const m = qOf(def, sw.id).rows[0].meta;
  assert.equal(m.subtitle, "Premium wireless headphones");
  assert.deepEqual(m.price, { value: "99", currency: "USD" });
  assert.deepEqual(m.fields, [{ type: "text", label: "Location", value: "Mumbai" }]);

  const pv = await h.preview([sw.id]);
  await pv.waitForSelector('[data-testid="card-subtitle"]');
  assert.equal(await pv.textContent('[data-testid="card-subtitle"]'), "Premium wireless headphones");
  assert.equal(await pv.textContent('[data-testid="card-price"]'), "$99.00");
  assert.match(await pv.textContent('[data-testid="card-fields"]'), /Location\s*Mumbai/);
  await pv.close();
  console.log("✔ swipe cards: subtitle, price with currency and a custom field, drawn on the deck");

  const rate = await h.createFromPicker("swipe", "swipe.rate");
  await openQ(rate.id);
  await page.selectOption(inQ(rate.id, '[data-testid="swipe-response"]'), "rank");
  await page.waitForTimeout(400);
  let d2 = await h.readDef();
  let q = qOf(d2, rate.id);
  assert.equal(q.settings.swipeResponse, "rank");
  assert.deepEqual(q.options.map((o) => o.label), q.rows.map((_, i) => `Rank ${i + 1}`), "the ranks follow the cards");
  await openQ(rate.id);
  assert.ok(!(await has(rate.id, "options-heading")), "a ranked deck has no options to edit");
  await page.click(inQ(rate.id, '[data-testid="add-option"] >> nth=-1'));
  await page.waitForTimeout(500);
  d2 = await h.readDef();
  q = qOf(d2, rate.id);
  assert.equal(q.options.length, q.rows.length, "a card added → one more rank");

  const pv2 = await h.preview([rate.id]);
  await pv2.click('[data-testid="swiperate-rank"]');
  await pv2.waitForTimeout(400);
  const ans = await h.answerOf(pv2, rate.id);
  assert.equal(Object.values(ans ?? {})[0], 1, "the first card ranked is rank 1");
  await pv2.close();
  console.log("✔ swipe to rank: the options are Rank 1…N and a swipe stores the rank");
}

/* ---------------------------------------------------- T: editable table */
{
  const t = await h.createFromPicker("list", "list.editable_table");
  await openQ(t.id);
  assert.ok(await has(t.id, "add-column"), "the Editable Table has its Columns editor");
  await page.check(inQ(t.id, '[data-testid="sheet-allow-add"]'));
  await page.waitForTimeout(250);
  const def = await h.readDef();
  assert.equal(qOf(def, t.id).settings.allowAddRows, true);
  const pv = await h.preview([t.id], (d) => { qOf(d, t.id).settings.initialRows = 1; });
  await pv.waitForSelector('[data-testid="sheet-add-row"]');
  const before = Number(await pv.getAttribute('[data-testid="sheet-row-count"]', "data-count") ?? (await pv.textContent('[data-testid="sheet-row-count"]')).match(/\d+/)[0]);
  await pv.click('[data-testid="sheet-add-row"]');
  await pv.waitForTimeout(150);
  const after = Number(await pv.getAttribute('[data-testid="sheet-row-count"]', "data-count") ?? (await pv.textContent('[data-testid="sheet-row-count"]')).match(/\d+/)[0]);
  assert.equal(after, before + 1, "+ Add row shows one more row");
  await pv.close();
  console.log("✔ editable table: columns editor, + Add row");
}

/* ------------------------------------------------------- D: date format */
{
  const dq = await h.createFromPicker("datetime", "datetime.date");
  await openQ(dq.id);
  await page.selectOption(inQ(dq.id, '[data-testid="date-format"]'), "DD/MM/YYYY");
  await page.waitForTimeout(250);
  const pv = await h.preview([dq.id]);
  await pv.fill('[data-testid="date-text"]', "25/12/2026");
  await pv.waitForTimeout(150);
  assert.equal(await h.answerOf(pv, dq.id), "2026-12-25", "typed in the chosen format, stored as ISO");
  await pv.fill('[data-testid="date-text"]', "31/02/2026");
  await pv.locator('[data-testid="date-text"]').blur();
  await pv.waitForSelector('[data-testid="date-format-hint"]');
  assert.equal(await h.answerOf(pv, dq.id), null, "an impossible date is no answer");
  await pv.close();
  console.log("✔ date: DD/MM/YYYY typed and stored as YYYY-MM-DD; 31/02 refused");
}

/* ------------------------------------------------------ U: upload types */
{
  const up = await h.createFromPicker("upload", "upload.file");
  await openQ(up.id);
  await page.check(inQ(up.id, '[data-testid="upload-kind-pdf"]'));
  await page.waitForTimeout(250);
  const def = await h.readDef();
  assert.deepEqual(qOf(def, up.id).settings.acceptTypes, ["pdf"]);
  const pv = await h.preview([up.id]);
  const PNG = { name: "photo.png", mimeType: "image/png", buffer: Buffer.from("89504e470d0a1a0a", "hex") };
  await pv.setInputFiles('[data-testid="upload-input"]', PNG);
  await pv.waitForSelector('[data-testid="upload-error"]');
  assert.match(await pv.textContent('[data-testid="upload-error"]'), /Invalid file type\. Please upload/);
  assert.equal(await h.answerOf(pv, up.id), undefined, "a refused type never becomes the answer");
  await pv.close();
  console.log("✔ upload: a PNG is refused when only PDF is allowed");
}

/* ----------------------------------------------------- B: bucket rules */
{
  const b = await h.createFromPicker("dragdrop", "dragdrop.buckets");
  await openQ(b.id);
  await page.selectOption(inQ(b.id, '[data-testid="bucket-mode"]'), "one");
  await page.waitForTimeout(250);
  const def = await h.readDef();
  const q = qOf(def, b.id);
  assert.equal(q.settings.bucketMode, "one");
  const pv = await h.preview([b.id]);
  const bucket = `[data-drop="bucket-${q.options[0].code}"]`;
  for (const r of q.rows.slice(0, 2)) {
    await pv.focus(`[data-row="${r.code}"]`);
    await pv.keyboard.press("Enter");
    await pv.click(bucket);
    await pv.waitForTimeout(150);
  }
  await pv.waitForSelector('[data-testid="bucket-refusal"]');
  const ans = await h.answerOf(pv, b.id);
  assert.equal(Object.values(ans ?? {}).filter((v) => String(v) === String(q.options[0].code)).length, 1, "one item per bucket");
  await pv.close();
  console.log("✔ buckets: one per bucket refuses the second drop and says why");
}

/* --------------------------------------------------- V: video comment */
{
  const vr = await h.createFromPicker("media", "media.video_rating");
  await openQ(vr.id);
  await page.check(inQ(vr.id, '[data-testid="rating-allow-comment"]'));
  await page.waitForTimeout(250);
  const pv = await h.preview([vr.id], (d) => { qOf(d, vr.id).settings.requireComplete = false; });
  await pv.fill('[data-testid="rating-comment"] textarea', "Too long");
  await pv.waitForTimeout(150);
  assert.equal(await h.answerOf(pv, `${vr.id}__comment`), "Too long", "the comment is stored beside the rating");
  await pv.close();
  console.log("✔ video rating: the optional comment lands in <answer>__comment");
}

/* ------------------------------- P01/P02: Image Categorization sections */
{
  const ic = await h.createFromPicker("image", "image.categorization");
  await openQ(ic.id);
  assert.ok(!(await has(ic.id, "option-search")), "no search box on Image Categorization");
  assert.ok(!(await has(ic.id, "add-column")), "no Columns on Image Categorization");
  assert.equal((await page.textContent(inQ(ic.id, '[data-testid="rows-heading"]'))).trim(), "Images");
  assert.ok(await has(ic.id, "bucket-rules") && await has(ic.id, "randomize-images"), "bucket rules and display settings");
  console.log("✔ image categorization: Images → Buckets → Bucket rules → Display, no columns or search");
}

/* ----------------------------------- Q13: numeric range follows its type */
{
  const nr = await h.createFromPicker("numeric", "numeric.numeric_range");
  await openQ(nr.id);
  await page.selectOption(inQ(nr.id, '[data-testid="field-type-0"]'), "date");
  await page.waitForTimeout(300);
  const def = await h.readDef();
  assert.deepEqual(qOf(def, nr.id).rows.map((r) => r.fieldType), ["date", "date"], "From and To change together");
  const pv = await h.preview([nr.id]);
  await pv.waitForSelector('[data-testid="numrange"][data-kind="date"]');
  assert.equal(await pv.locator('[data-testid="numrange"] input[type="date"]').count(), 2, "two date pickers in the preview");
  await pv.close();
  console.log("✔ numeric range: a date range draws two date pickers");
}

/* --------------------------------------------------- P19: 12-hour time */
{
  const tq = await h.createFromPicker("datetime", "datetime.time");
  await openQ(tq.id);
  await page.selectOption(inQ(tq.id, '[data-testid="time-format"]'), "12");
  await page.waitForTimeout(250);
  const pv = await h.preview([tq.id]);
  await pv.waitForSelector('select[data-part="ampm"]');
  await pv.selectOption('select[data-part="hour"]', "3");
  await pv.selectOption('select[data-part="minute"]', "30");
  await pv.selectOption('select[data-part="ampm"]', "PM");
  await pv.waitForTimeout(150);
  assert.equal(await h.answerOf(pv, tq.id), "15:30", "3:30 PM is stored as 24-hour 15:30");
  await pv.close();
  console.log("✔ time: 12-hour selectors with AM/PM, stored as HH:MM");
}

/* ------------------------------------------------ P32: phone code list */
{
  const cf = await h.createFromPicker("form", "form.contact");
  const def = await h.readDef();
  const phoneRow = qOf(def, cf.id).rows.find((r) => r.fieldType === "phone");
  assert.ok(phoneRow, "the contact form has a phone field");
  assert.equal(phoneRow.meta?.phoneCountry, "pick", "a new contact form lets the respondent pick the code");
  const pv = await h.preview([cf.id]);
  await pv.waitForSelector('[data-testid="phone-country-code"]');
  await pv.selectOption(`[data-testid="phone-input-${phoneRow.code}"] [data-testid="phone-country-code"]`, "IN");
  await pv.fill(`[data-testid="phone-input-${phoneRow.code}"] input`, "98765 43210");
  await pv.waitForTimeout(150);
  const ans = await h.answerOf(pv, cf.id);
  assert.ok(Object.values(ans ?? {}).includes("+91 98765 43210"), `the number is stored with its code (${JSON.stringify(ans)})`);
  await pv.close();
  console.log("✔ phone: the respondent picks a country code; stored as +91 …");
}

/* ------------------------------------- P11: Next waits for the whole clip */
{
  const vt = await h.createFromPicker("media", "media.video_timeline");
  const pv = await h.preview([vt.id], (d) => {
    const q = qOf(d, vt.id);
    q.settings.videos = [{ url: `${process.env.RUNTIME_URL ?? "http://localhost:3001"}/test-media/tiny.webm` }];
    q.settings.mediaUrl = q.settings.videos[0].url;
    q.settings.requireComplete = true;
    q.required = false;
  });
  await pv.waitForSelector('[data-testid="rs-next-held"]', { timeout: 10000 });
  assert.ok(await pv.isDisabled(".rs-nav .rs-btn:not(.secondary)"), "Next is held while the clip has not ended, even though the question is optional");
  console.log("✔ video hotspot: require complete holds Next (independent of Required)");
  await pv.close();
}

await h.close();
console.log("\nOCTOBER REVIEW SUITE: all checks passed");

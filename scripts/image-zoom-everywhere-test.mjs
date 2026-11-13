/**
 * IMAGE ZOOM ON EVERY IMAGE (2026-11-15) — in the runtime preview.
 *
 * The Image zoom setting used to act on the stimulus, on images in the question text and on two image renderers.
 * It now acts on every image of the question, whatever the type and wherever the image was put:
 *
 *   TEXT        an image in the question text or the instruction: click / Enter opens the lightbox
 *   OPTIONS     an image in an option label, an option's own image (image grid, cards, product cards, tiles, list
 *               rows, ranking, carousel), a matrix row label: the click still selects — an Enlarge button opens it
 *   HOVER       "hover-magnifier": a lens follows the mouse over any of them; the click / button still opens
 *   SOURCES     an uploaded-style same-origin image and an externally hosted URL behave the same
 *   LIGHTBOX    covers the window, zooms, closes on Escape, returns focus; each opening counts in ZOOMED_<CODE>
 *   SAFE        off = nothing changes; a hotspot's image is never a zoom target; nothing scrolls sideways on a phone
 *
 *   node scripts/image-zoom-everywhere-test.mjs      (runtime on :3001; set RUNTIME_URL to override)
 */
import assert from "node:assert/strict";
import http from "node:http";
import { readFileSync } from "node:fs";
import { chromium } from "./lib/playwright.mjs";
import { sendPreview } from "./lib/preview.mjs";
import { SurveyDefinition } from "../packages/schema/dist/index.js";

const RUNTIME = process.env.RUNTIME_URL ?? "http://localhost:3001";
let passed = 0;
const ok = (m) => { passed++; console.log(`  ok   ${m}`); };
/* an "externally hosted" image: another origin, served here */
const png = readFileSync(new URL("../apps/runtime/public/test-media/stimulus.png", import.meta.url));
const ext = http.createServer((_, res) => { res.writeHead(200, { "content-type": "image/png", "access-control-allow-origin": "*" }); res.end(png); });
await new Promise((r) => ext.listen(0, "127.0.0.1", r));
const EXTERNAL = `http://127.0.0.1:${ext.address().port}/pack.png`;
const LOCAL = `${RUNTIME}/test-media/stimulus.png`;

const base = (id) => ({ meta: { id, code: id.toUpperCase(), title: id, version: "1.0", schemaVersion: 1, status: "draft" }, logicFlow: { nodes: [], edges: [] }, displayRules: [], calculations: [], quotas: [], variables: [], embeddedData: [], listFills: [], scripts: [], designs: [], deployment: { clientSlug: "c", studySlug: "s", languages: ["en"], access: { mode: "open" } } });
const inline = (src, alt, w = 110) => `<img src="${src}" alt="${alt}" style="width:${w}px">`;
const imgOpts = [{ code: 1, label: "Pack A", imageUrl: LOCAL, imageAlt: "Pack A photo" }, { code: 2, label: "Pack B", imageUrl: EXTERNAL, imageAlt: "Pack B photo" }];
const labelOpts = [{ code: 1, label: `Pack A ${inline(LOCAL, "A in label")}` }, { code: 2, label: `Pack B ${inline(EXTERNAL, "B in label")}` }];
const q = (id, type, variant, extra = {}) => ({ id, code: id.toUpperCase(), variableName: id.toUpperCase(), type, ...(variant ? { variant } : {}), required: false, text: `Question ${id}`, ...extra });
const survey = (id, questions) => { const def = { ...base(id), questions, flow: [...questions.map((x, i) => ({ type: "page", id: `p${i}`, questionIds: [x.id] })), { type: "end", id: "e", status: "complete" }] }; SurveyDefinition.parse(def); return def; };

const browser = await chromium.launch();
const pageErrors = [];
const open = async (def, first, viewport = { width: 1200, height: 800 }) => {
  const page = await (await browser.newContext({ viewport })).newPage();
  page.on("pageerror", (e) => pageErrors.push(String(e)));
  await page.goto(`${RUNTIME}/preview`, { waitUntil: "networkidle" });
  await sendPreview(page, { definition: def }, { selector: `[data-qid="${first}"]` });
  return page;
};
const next = async (page, qid) => { await page.click('[data-testid="rs-next"]'); await page.waitForSelector(`[data-qid="${qid}"]`); };
const ready = (page, qid, n) => page.waitForFunction(([qid, n]) => { const c = document.querySelector(`[data-qid="${qid}"]`); return c && c.querySelectorAll("img[data-rs-zoom]").length >= n; }, [qid, n], { timeout: 15000 });
const state = (page) => page.evaluate(() => JSON.parse(JSON.stringify({ a: window.__rescriptState.answers, e: window.__rescriptState.embedded ?? {} })));
const lightbox = async (page) => {
  await page.waitForSelector('[data-testid="rs-lightbox"]');
  const r = await page.evaluate(() => { const b = document.querySelector('[data-testid="rs-lightbox-backdrop"]').getBoundingClientRect(); const i = document.querySelector('[data-testid="rs-lightbox-img"]'); return { covers: b.left <= 0 && b.top <= 0 && b.right >= window.innerWidth && b.bottom >= window.innerHeight, src: i.src, loaded: i.complete && i.naturalWidth > 0, caption: document.querySelector('[data-testid="rs-lightbox-caption"]').textContent }; });
  return r;
};
const closeBox = async (page) => { await page.keyboard.press("Escape"); await page.waitForSelector('[data-testid="rs-lightbox"]', { state: "detached" }); };
/** every Enlarge button sits on its own image (inside the image's box) */
const buttonsOnImages = (page, qid) => page.evaluate((qid) => [...document.querySelectorAll(`[data-qid="${qid}"] .rs-zoom-btn`)].map((b) => { const img = b.previousElementSibling; const r = b.getBoundingClientRect(), i = img.getBoundingClientRect(); return img.tagName === "IMG" && r.left >= i.left - 1 && r.right <= i.right + 1 && r.top >= i.top - 1 && r.bottom <= i.bottom + 1 && r.width >= 20; }), qid);

console.log("\nTEXT, INSTRUCTION AND OPTION LABELS — click mode");
{
  const def = survey("z1", [
    q("q1", "single_select", null, { text: `Which pack? ${inline(LOCAL, "Shelf in text", 140)}`, instruction: `Look closely ${inline(EXTERNAL, "Detail in instruction", 90)}`, options: labelOpts, settings: { zoom: "click" } }),
    q("q2", "multi_select", null, { options: labelOpts, settings: { zoom: "click" } }),
    q("q3", "matrix_single", null, { rows: [{ code: 1, label: `Row one ${inline(LOCAL, "Row image", 70)}` }, { code: 2, label: "Row two" }], options: [{ code: 1, label: `Yes ${inline(EXTERNAL, "Column image", 50)}` }, { code: 2, label: "No" }], settings: { zoom: "click" } }),
    q("q4", "single_select", null, { text: `No zoom here ${inline(LOCAL, "plain")}`, options: labelOpts, settings: {} }),
  ]);
  const page = await open(def, "q1");
  await ready(page, "q1", 4);
  const t = await page.$$eval('[data-qid="q1"] img.rs-zoomable-inline', (els) => els.map((e) => [e.alt, e.getAttribute("role"), e.tabIndex]));
  assert.deepEqual(t, [["Shelf in text", "button", 0], ["Detail in instruction", "button", 0]]);
  await page.click('[data-qid="q1"] img[alt="Shelf in text"]');
  let lb = await lightbox(page);
  assert.ok(lb.covers, "the lightbox covers the window"); assert.ok(lb.loaded); assert.equal(lb.caption, "Shelf in text");
  await page.click('[data-testid="rs-lightbox-in"]');
  assert.equal(await page.textContent('[data-testid="rs-lightbox-pct"]'), "150%");
  await closeBox(page);
  await page.focus('[data-qid="q1"] img[alt="Detail in instruction"]');
  await page.keyboard.press("Enter");
  lb = await lightbox(page);
  assert.ok(lb.src.startsWith(EXTERNAL) && lb.loaded, "an externally hosted image opens the same way");
  await closeBox(page);
  await page.waitForFunction(() => document.activeElement?.getAttribute("alt") === "Detail in instruction", null, { timeout: 3000 });
  ok("an image in the question text (click) and in the instruction (keyboard, external URL) opens the lightbox: covers the window, zooms, Esc closes, focus returns");

  assert.equal(await page.locator('[data-qid="q1"] .rs-zoom-btn').count(), 2, "one Enlarge button per option-label image");
  assert.ok((await buttonsOnImages(page, "q1")).every(Boolean));
  await page.click('[data-qid="q1"] img[alt="A in label"]');
  assert.equal(await page.$('[data-testid="rs-lightbox"]'), null, "clicking an option's image selects, it does not zoom");
  assert.equal(String((await state(page)).a.q1), "1");
  await page.locator('[data-qid="q1"] .rs-zoom-btn').nth(1).click();
  lb = await lightbox(page);
  assert.equal(lb.caption, "B in label");
  await closeBox(page);
  assert.equal(String((await state(page)).a.q1), "1", "the Enlarge button does not change the answer");
  assert.equal((await state(page)).e.ZOOMED_Q1, 3, "three openings counted");
  ok("images in option labels: the click still selects the option; the Enlarge button on each opens it without touching the answer; ZOOMED_Q1 = 3");

  await next(page, "q2"); await ready(page, "q2", 2);
  assert.equal(await page.locator('[data-qid="q2"] .rs-zoom-btn').count(), 2);
  await page.locator('[data-qid="q2"] .rs-zoom-btn').first().click();
  await lightbox(page); await closeBox(page);
  assert.deepEqual((await state(page)).a.q2 ?? [], []);
  await next(page, "q3"); await ready(page, "q3", 2);
  assert.equal(await page.locator('[data-qid="q3"] .rs-zoom-btn').count(), 2, "row label and column label");
  await page.locator('[data-qid="q3"] .rs-zoom-btn').first().click();
  lb = await lightbox(page); assert.ok(lb.loaded); await closeBox(page);
  ok("multi-select option labels and a matrix's row and column labels: Enlarge buttons, the answer untouched");

  await next(page, "q4");
  await page.waitForTimeout(500);
  assert.equal(await page.locator('[data-qid="q4"] [data-rs-zoom], [data-qid="q4"] .rs-zoom-btn').count(), 0);
  await page.click('[data-qid="q4"] img[alt="plain"]');
  assert.equal(await page.$('[data-testid="rs-lightbox"]'), null);
  ok("zoom off (every existing survey): no zoom targets, no buttons, nothing opens");
  await page.close();
}

console.log("\nOPTION IMAGES ACROSS RENDERERS — click mode");
{
  const kinds = [
    ["image_select", "single_select.image"], ["image_select", "multi_select.image"], ["single_select", "single_select.cards"], ["single_select", "single_select.tiles"],
    ["single_select", "single_select.list_select"], ["single_select", "single_select.product_choice"], ["multi_select", "multi_select.product_multi_select"],
    ["single_select", "single_select.icon_select"], ["image_ranking", "ranking.image"], ["single_select", "single_select.carousel"],
  ];
  const def = survey("z2", kinds.map(([type, variant], i) => q(`k${i}`, type, variant, { options: imgOpts, settings: { zoom: "click" } })));
  const page = await open(def, "k0");
  const seen = [];
  for (let i = 0; i < kinds.length; i++) {
    const id = `k${i}`;
    if (i) await next(page, id);
    const imgs = await page.locator(`[data-qid="${id}"] img`).count();
    if (!imgs) { seen.push(`${kinds[i][1]}: draws no option image`); continue; }
    await ready(page, id, imgs);
    assert.equal(await page.locator(`[data-qid="${id}"] .rs-zoom-btn`).count(), imgs, `${kinds[i][1]}: one Enlarge button per image`);
    assert.ok((await buttonsOnImages(page, id)).every(Boolean), `${kinds[i][1]}: each button sits on its image`);
    const before = JSON.stringify((await state(page)).a[id] ?? null);
    await page.locator(`[data-qid="${id}"] .rs-zoom-btn`).last().click();
    const lb = await lightbox(page);
    assert.ok(lb.loaded && lb.covers, kinds[i][1]);
    await closeBox(page);
    assert.equal(JSON.stringify((await state(page)).a[id] ?? null), before, `${kinds[i][1]}: enlarging does not answer`);
    seen.push(`${kinds[i][1]} ✓`);
  }
  console.log(`       ${seen.join(" · ")}`);
  assert.ok(seen.filter((s) => s.endsWith("✓")).length >= 9, seen.join(" | "));
  ok(`option images zoom in ${seen.filter((s) => s.endsWith("✓")).length} renderers (image grids, cards, tiles, list rows, product cards, icons, image ranking, carousel) — uploaded-style and external URLs alike`);
  /* selecting by the image still works */
  await page.close();
  const p2 = await open(survey("z2b", [q("k0", "image_select", "single_select.image", { options: imgOpts, settings: { zoom: "click", maxSelections: 1 } })]), "k0");
  await ready(p2, "k0", 2);
  await p2.click('[data-qid="k0"] img[alt="Pack B photo"]');
  assert.equal(String((await state(p2)).a.k0), "2");
  assert.equal(await p2.$('[data-testid="rs-lightbox"]'), null);
  ok("in an image grid the image itself still selects the option");
  await p2.close();
}

console.log("\nHOVER MAGNIFIER");
{
  const def = survey("z3", [
    q("h1", "image_select", "single_select.image", { text: `Which? ${inline(LOCAL, "Text image", 160)}`, options: imgOpts, settings: { zoom: "hover-magnifier" } }),
    q("h2", "html", null, { text: `<p>Read this</p>${inline(EXTERNAL, "Content image", 300)}`, settings: { zoom: "hover-magnifier" } }),
    q("h3", "single_select", null, { options: labelOpts, settings: { zoom: "hover-magnifier" } }),
  ]);
  const page = await open(def, "h1");
  await ready(page, "h1", 3);
  const lensOver = async (sel) => {
    const box = await page.locator(sel).boundingBox();
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await page.waitForSelector('[data-testid="rs-magnifier"]');
    const l = await page.evaluate(() => { const e = document.querySelector('[data-testid="rs-magnifier"]'); const r = e.getBoundingClientRect(); return { cx: r.left + r.width / 2, cy: r.top + r.height / 2, bg: e.style.backgroundImage, size: e.style.backgroundSize }; });
    assert.ok(Math.abs(l.cx - (box.x + box.width / 2)) <= 3 && Math.abs(l.cy - (box.y + box.height / 2)) <= 3, "the lens is under the pointer");
    assert.ok(/url\(/.test(l.bg) && parseFloat(l.size) > box.width * 2, "the lens shows the image enlarged");
    await page.mouse.move(2, 2);
    await page.waitForSelector('[data-testid="rs-magnifier"]', { state: "detached" });
  };
  await lensOver('[data-qid="h1"] img[alt="Text image"]');
  await lensOver('[data-qid="h1"] img[alt="Pack B photo"]');
  assert.deepEqual((await state(page)).a.h1 ?? null, null, "hovering answers nothing");
  await page.click('[data-qid="h1"] img[alt="Text image"]');
  await lightbox(page); await closeBox(page);
  await page.locator('[data-qid="h1"] .rs-zoom-btn').first().click();
  await lightbox(page); await closeBox(page);
  ok("hover magnifier: a lens follows the mouse over the text image and over an option image (external URL); click / Enlarge still opens the lightbox");
  await next(page, "h2"); await ready(page, "h2", 1);
  await lensOver('[data-qid="h2"] img[alt="Content image"]');
  await page.click('[data-qid="h2"] img[alt="Content image"]');
  const lb = await lightbox(page); assert.ok(lb.covers); await closeBox(page);
  await next(page, "h3"); await ready(page, "h3", 2);
  await lensOver('[data-qid="h3"] img[alt="A in label"]');
  ok("the same on a text / content block and on images inside radio option labels");
  await page.close();
}

console.log("\nSAFE — answering surfaces, phone");
{
  const def = survey("z4", [
    q("s1", "hotspot", null, { settings: { zoom: "click", imageUrl: LOCAL, maxSelections: 2 } }),
    q("s2", "image_select", "multi_select.image", { text: `Pick ${inline(LOCAL, "Phone text image", 200)}`, options: imgOpts, settings: { zoom: "click" } }),
  ]);
  const page = await open(def, "s1", { width: 390, height: 844 });
  await page.waitForSelector('[data-qid="s1"] img');
  await page.waitForTimeout(600);
  assert.equal(await page.locator('[data-qid="s1"] .rs-zoom-btn, [data-qid="s1"] img[data-rs-zoom]').count(), 0, "a hotspot image is the answering surface");
  await page.click('[data-qid="s1"] img', { position: { x: 40, y: 40 } });
  assert.equal(await page.$('[data-testid="rs-lightbox"]'), null);
  assert.equal(((await state(page)).a.s1 ?? []).length, 1, "the click placed a point");
  ok("a hotspot's image is never a zoom target: the click still places a point");
  await next(page, "s2"); await ready(page, "s2", 3);
  assert.ok((await buttonsOnImages(page, "s2")).every(Boolean));
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth), 0, "no sideways scroll");
  await page.locator('[data-qid="s2"] .rs-zoom-btn').first().click();
  const lb = await lightbox(page);
  assert.ok(lb.covers);
  await page.click('[data-testid="rs-lightbox-close"]');
  await page.waitForSelector('[data-testid="rs-lightbox"]', { state: "detached" });
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth), 0);
  ok("phone 390: Enlarge buttons sit on their images, the lightbox covers the screen, no sideways scroll before or after");
  await page.close();
}

await browser.close();
ext.close();
assert.deepEqual(pageErrors, [], "no page errors");
console.log(`\nIMAGE ZOOM EVERYWHERE: ${passed} checks passed`);

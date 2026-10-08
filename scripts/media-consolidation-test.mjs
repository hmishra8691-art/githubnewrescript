/**
 * MEDIA, CONSOLIDATED (1-10-26 review) — Studio and runtime.
 *
 *   Oweas 1-2 / Prince 1-2   an option's Choose / Upload opens an image pop-up
 *                            (size, scale, alignment, padding, spacing, alt,
 *                            live preview); nothing reaches the option until
 *                            Apply; Cancel leaves it; "Customize" reopens it
 *   Oweas 3 / Prince 3       no separate "media under the question text" field;
 *                            Insert media has sources (library, upload, URL,
 *                            Drive + save to library), Above / Below / cursor,
 *                            several items each with its own settings, players
 *   Prince 4                 position and several items only in the question
 *                            text — never in an option label
 *   Oweas 4 / Prince 5       the dialog's preview follows every change, also
 *                            when an inserted picture is edited
 *   Prince 6                 clearing the source and pressing Apply removes it
 *   Prince 7                 left / center / right land the same in the
 *                            builder, Live View and the respondent preview
 *   Prince 8                 a URL parameter piped as an image URL shows the
 *                            picture (and an "&" in it survives)
 *   legacy                   a question with the old field keeps its media and
 *                            can move it into the text
 *
 *   node scripts/media-consolidation-test.mjs   (studio on 3000, runtime on 3001)
 */
import { chromium } from "/home/claude/.npm-global/lib/node_modules/playwright/index.mjs";
import { openTab, openTabKey } from "./lib/nav.mjs";
import { openPreview } from "./lib/preview.mjs";
import assert from "node:assert/strict";

const STUDIO = process.env.STUDIO_URL ?? "http://localhost:3000";
const RUNTIME = process.env.RUNTIME_URL ?? "http://localhost:3001";
const IMG = `${RUNTIME}/test-media/stimulus.png`;
const DB = "mockdb";
let passed = 0;
const ok = (m) => { console.log("  ok  ", m); passed++; };
const opts = (n, l = "Opt") => Array.from({ length: n }, (_, i) => ({ code: i + 1, label: `${l} ${i + 1}` }));

const FIXTURE = {
  meta: { id: "sandbox", code: "SANDBOX", title: "Media", version: "1.0" },
  embeddedData: [{ name: "ImageURL", source: "url" }],
  questions: [
    { id: "q1", code: "Q1", variableName: "Q1", type: "single_select", text: "Hello", options: opts(2) },
    { id: "q2", code: "Q2", variableName: "Q2", type: "image_select", text: "Pick a pack", options: opts(3, "Pack") },
    { id: "q3", code: "Q3", variableName: "Q3", type: "single_select", text: "Old media", options: opts(2),
      settings: { mediaUrl: IMG, mediaDisplay: { width: 90, align: "right" } } },
  ],
  flow: [{ type: "page", id: "p1", questionIds: ["q1", "q2", "q3"] }, { type: "end", id: "e", status: "complete" }],
};

const ASSET = (id, url, family = "image", mimeType = "image/png") => ({
  id, surveyId: DB, customerId: "c1", name: `${id}.png`, fileName: `${id}.png`, altText: `${id} alt`, mimeType, family,
  bytes: 1000, width: 400, height: 200, durationSeconds: null, sha256: null, shared: false, fromOtherSurvey: false,
  createdAt: "2026-10-01T00:00:00Z", url,
});
const LIB = [ASSET("pack", `${IMG}?asset=pack`)];
const imports = [];

const browser = await chromium.launch();
const ctx = await browser.newContext({ viewport: { width: 1700, height: 1150 } });
await ctx.addInitScript((seed) => { window.__rescriptSandboxSeed = seed; }, FIXTURE);
const page = await ctx.newPage();
const errors = [];
page.on("pageerror", (e) => errors.push(e.message));
page.on("dialog", (d) => d.accept());

/* a saved survey without a database: the library, a duplicate-upload hit, the Drive import and autosave */
let rev = 1;
await page.route(`**/api/surveys/${DB}/**`, async (route) => {
  const req = route.request();
  const path = new URL(req.url()).pathname.replace(`/api/surveys/${DB}`, "");
  const json = (body, status = 200) => route.fulfill({ status, contentType: "application/json", body: JSON.stringify(body) });
  if (path === "/media" && req.method() === "GET") return json({ ok: true, assets: LIB });
  if (path === "/media/lookup") return json({ ok: true, asset: ASSET("uploaded", `${IMG}?asset=uploaded`) });
  if (path === "/media/import") {
    imports.push(JSON.parse(req.postData() ?? "{}"));
    return json({ ok: true, asset: ASSET("fromdrive", `${IMG}?asset=drive`), duplicate: false });
  }
  if (path.startsWith("/draft")) return json({ ok: true, revision: ++rev });
  return route.continue();
});

const readDef = async () => {
  const activeTab = await page.$eval(".menubar-here", (e) => e.dataset.tab).catch(() => null);
  await openTab(page, "JSON");
  await page.waitForSelector("textarea.code");
  const json = await page.$eval("textarea.code", (e) => e.value);
  if (activeTab) await openTabKey(page, activeTab).catch(() => {});
  return JSON.parse(json);
};
const selectQuestion = async (code) => {
  await openTab(page, "Questions");
  await page.waitForSelector(".qcard");
  for (const c of await page.$$(".qcard")) if ((await c.textContent()).includes(code)) { await c.click(); await page.waitForTimeout(300); return; }
  throw new Error(`no card for ${code}`);
};
const q = (def, id) => def.questions.find((x) => x.id === id);
const previewStyle = (i = 0) => page.$eval(`[data-testid="media-display-preview"] img >> nth=${i}`, (e) => e.getAttribute("style") ?? "").catch(() => page.$$eval('[data-testid="media-display-preview"] img', (es, i) => es[i]?.getAttribute("style") ?? null, i));
const imgStyles = (html) => [...html.matchAll(/<img\b[^>]*>/g)].map((m) => /style="([^"]*)"/.exec(m[0])?.[1] ?? "");
const openInsert = async () => { await page.click('.rte [data-testid="rte-media"] >> nth=0'); await page.waitForSelector('[data-testid="media-insert"]'); };
const setWidth = async (v) => { await page.fill('[data-testid="media-insert"] [data-testid="mdisp-width"]', String(v)); };

await page.goto(`${STUDIO}/sandbox?dbid=${DB}`, { waitUntil: "networkidle" });
await page.waitForSelector(".menubar");
await selectQuestion("Q1");
ok("seeded survey opened as a saved survey (library available)");

/* ------------------------------------------------ Oweas 3 / Prince 3: the old field is gone */
assert.equal(await page.$('[data-testid="question-media"]'), null, "no separate media field on a question without old media");
assert.equal(await page.$('[data-testid="legacy-media"]'), null);
ok("Oweas 3 — no separate “Media shown under the question text” field");

/* ------------------------------------------------ several items, each with its own settings, below the text */
await openInsert();
assert.ok(await page.$('[data-testid="media-insert-position"]'), "position offered in the question text");
assert.equal(await page.isChecked('[data-testid="media-insert-position-above"]'), true, "Above question is the default");
assert.ok(await page.$('[data-testid="media-insert-items"]'), "several items offered in the question text");
for (const s of ["library", "upload", "url", "drive"]) assert.ok(await page.$(`[data-testid="media-insert-source-${s}"]`), `source ${s}`);
await page.fill('[data-testid="media-insert-url"]', IMG);
await page.click('[data-testid="media-insert"] [data-testid="mdisp-align-center"]');
assert.match(await previewStyle(0), /margin-left: auto; margin-right: auto/);
await page.click('[data-testid="media-insert-add"]');
await page.fill('[data-testid="media-insert-url"]', `${IMG}?n=2`);
await setWidth(50);
await page.click('[data-testid="media-insert"] [data-testid="mdisp-align-left"]');
await page.click('[data-testid="media-insert-add"]');
await page.fill('[data-testid="media-insert-url"]', `${IMG}?n=3`);
await setWidth(80);
await page.click('[data-testid="media-insert"] [data-testid="mdisp-align-right"]');
assert.equal((await page.$$('[data-testid="media-display-preview"] img')).length, 3, "the preview shows every item");
await page.click('[data-testid="media-insert-item-up-2"]');
assert.match(await previewStyle(1), /width: 80px/, "reordered: the 80px item is second");
await page.check('[data-testid="media-insert-position-below"]');
assert.match(await page.textContent('[data-testid="media-insert-ok"]'), /Insert 3 items/);
await page.click('[data-testid="media-insert-ok"]');
await page.waitForTimeout(500);
let text = q(await readDef(), "q1").text;
/* several items are one group with a layout (Vertical by default — 06-10-2026 workbook, "Insert Media – Multiple Media Layout") */
assert.match(text, /^Hello<div><div class="rs-media-group" data-rs-layout="vertical"[^>]*><div class="rs-media-cell"><img/, `below the text, as one vertical group: ${text}`);
let st = imgStyles(text);
assert.equal(st.length, 3);
assert.match(st[0], /margin-left: auto; margin-right: auto/, "item 1 centred");
assert.match(st[1], /width: 80px.*margin-left: auto; margin-right: 0/, "item 2: 80px, right");
assert.match(st[2], /width: 50px.*margin-left: 0; margin-right: auto/, "item 3: 50px, left");
ok("Oweas 3 / Prince 3 — three items, each with its own size and alignment, reordered, below the question");

/* ------------------------------------------------ Oweas 4 / Prince 5: editing an inserted picture — the preview is live */
await page.click('.rte-surface img >> nth=1');
await page.waitForSelector('[data-testid="media-insert"]');
assert.match(await page.textContent('[data-testid="media-insert"] h2'), /Edit media/);
assert.ok(await page.$('[data-testid="media-insert-alt"]'), "a picture is edited as a picture: alt text offered");
assert.equal(await page.$('[data-testid="media-insert"] [data-testid="mdisp-controls"]'), null, "no player controls for a picture");
assert.equal(await page.isChecked('[data-testid="media-insert-position-keep"]'), true, "edit keeps it where it is");
assert.equal(await page.$('[data-testid="media-insert-items"]'), null, "edit is one item");
assert.match(await previewStyle(0), /width: 80px/, "the preview opens on the current settings");
await setWidth(120);
await page.click('[data-testid="media-insert"] [data-testid="mdisp-align-center"]');
assert.match(await previewStyle(0), /width: 120px.*margin-left: auto; margin-right: auto/, "and follows the change at once");
await page.click('[data-testid="media-insert"] [data-testid="mdisp-align-left"]');
assert.match(await previewStyle(0), /margin-left: 0(px)?; margin-right: auto/);
await page.click('[data-testid="media-insert-ok"]');
await page.waitForTimeout(400);
text = q(await readDef(), "q1").text;
st = imgStyles(text);
assert.match(st[1], /width: 120px.*margin-left: 0; margin-right: auto/, `edited in place: ${st[1]}`);
assert.match(text, /<img[^>]*\?n=3"[^>]*data-rs-media="image"/, "still an image, not an `img` kind");
ok("Oweas 4 / Prince 5 — an edited picture's preview updates live; Apply writes it in place");

/* ------------------------------------------------ Prince 6: clear the source, Apply removes it */
await page.click('.rte-surface img >> nth=0');
await page.waitForSelector('[data-testid="media-insert"]');
await page.fill('[data-testid="media-insert-url"]', "");
await page.waitForSelector('[data-testid="media-insert-removing"]');
assert.equal(await page.isEnabled('[data-testid="media-insert-ok"]'), true, "Apply stays enabled");
await page.click('[data-testid="media-insert-ok"]');
await page.waitForTimeout(400);
text = q(await readDef(), "q1").text;
assert.equal(imgStyles(text).length, 2, `one fewer: ${text}`);
assert.ok(!text.includes(`src="${IMG}"`), "the cleared one is gone");
ok("Prince 6 — clearing the source and pressing Apply removes the media");

/* ------------------------------------------------ above the question; a player; a piped picture */
await openInsert();
await page.fill('[data-testid="media-insert-url"]', `${IMG}?top=1`);
await page.click('[data-testid="media-insert-ok"]');
await page.waitForTimeout(300);
await openInsert();
await page.fill('[data-testid="media-insert-url"]', "https://www.youtube.com/watch?v=dQw4w9WgXcQ");
assert.match(await page.textContent('[data-testid="media-insert-verdict"]'), /YouTube player/);
await page.waitForSelector('[data-testid="media-display-preview"] iframe');
await page.fill('[data-testid="media-insert"] [data-testid="mdisp-width"]', "480");
await page.check('[data-testid="media-insert-position-below"]');
await page.click('[data-testid="media-insert-ok"]');
await page.waitForTimeout(300);
await openInsert();
await page.fill('[data-testid="media-insert-url"]', "{{ImageURL}}");
assert.match(await page.textContent('[data-testid="media-insert-verdict"]'), /Piped/);
assert.equal(await page.isEnabled('[data-testid="media-insert-ok"]'), true, "a piped source can be inserted");
assert.ok(await page.$('[data-testid="media-display-preview"] img'), "a placeholder shows where it goes");
await page.check('[data-testid="media-insert-position-below"]');
await page.click('[data-testid="media-insert-ok"]');
await page.waitForTimeout(400);
text = q(await readDef(), "q1").text;
assert.match(text, /^<div><img[^>]*\?top=1/, `above the question: ${text.slice(0, 80)}`);
assert.match(text, /data-rs-media="embed"/);
assert.match(text, /data-rs-src="https:\/\/www\.youtube\.com\/watch\?v=dQw4w9WgXcQ"/);
assert.match(text, /<img src="\{\{ImageURL\}\}"/);
await page.click('.rte-surface [data-rs-media="embed"]');
await page.waitForSelector('[data-testid="media-insert"]');
assert.equal(await page.inputValue('[data-testid="media-insert-url"]'), "https://www.youtube.com/watch?v=dQw4w9WgXcQ", "a player reopens for editing");
await page.click('[data-testid="media-insert"] button:has-text("Cancel")');
ok("Oweas 3 / Prince 3 — above the question, a YouTube player and a piped picture, from the one dialog");

/* ------------------------------------------------ Drive: save to the asset library */
await openInsert();
await page.click('[data-testid="media-insert-source-drive"]');
await page.fill('[data-testid="media-insert-url"]', "https://drive.google.com/file/d/1AbCdEfGhIjKlMnOpQrStUv/view?usp=sharing");
assert.match(await page.textContent('[data-testid="media-insert-verdict"]'), /Google Drive player/);
await page.click('[data-testid="media-insert-drive-save"]');
await page.waitForFunction(() => document.querySelector('[data-testid="media-insert-url"]')?.value.includes("asset=drive"));
assert.equal(imports.at(-1)?.url, "https://drive.google.com/file/d/1AbCdEfGhIjKlMnOpQrStUv/view?usp=sharing");
assert.equal(await page.$eval('[data-testid="media-insert-kind-image"]', (e) => e.classList.contains("primary")), true, "now an ordinary picture from the library");
await page.click('[data-testid="media-insert"] button:has-text("Cancel")');
ok("Prince 3 — a Google Drive file is saved into the asset library and used from there");

/* ------------------------------------------------ Prince 4: an option label gets none of it */
await page.click('[data-testid="option-label"] >> nth=0');
await page.click('[data-testid="option-label-format"] >> nth=0');
await page.click('.rte-bar-compact [data-testid="rte-media"]');
await page.waitForSelector('[data-testid="media-insert"]');
assert.equal(await page.$('[data-testid="media-insert-position"]'), null, "no position in an option");
assert.equal(await page.$('[data-testid="media-insert-items"]'), null, "no several-items list in an option");
await page.fill('[data-testid="media-insert-url"]', "https://www.youtube.com/watch?v=dQw4w9WgXcQ");
assert.equal(await page.isEnabled('[data-testid="media-insert-ok"]'), false, "no player inside an option label");
await page.click('[data-testid="media-insert"] button:has-text("Cancel")');
ok("Prince 4 — position and several items only in the question text, not in an option");

/* ------------------------------------------------ Prince 7 + 8: the respondent's view */
const def = await readDef();
const measure = (p) => p.$$eval("[data-qid=q1] .rs-qtext img", (es) => es.map((e) => {
  const r = e.getBoundingClientRect(); const c = e.closest(".rs-qtext").getBoundingClientRect();
  return { left: Math.round(r.left - c.left), right: Math.round(c.right - r.right), w: Math.round(r.width), src: e.getAttribute("src"), loaded: e.naturalWidth > 0 };
}));
const pv = await openPreview(browser, RUNTIME, { definition: def }, { search: `?ImageURL=${encodeURIComponent("/test-media/stimulus.png?a=1&b=2")}`, viewport: { width: 1200, height: 900 } });
await pv.waitForTimeout(800);
let m = await measure(pv);
const piped = m.find((x) => x.src?.startsWith("/test-media/stimulus.png?a=1"));
assert.ok(piped, `the piped picture is drawn: ${JSON.stringify(m.map((x) => x.src))}`);
assert.equal(piped.src, "/test-media/stimulus.png?a=1&b=2", "the & survives");
assert.ok(piped.loaded);
const lefty = m.find((x) => x.src === `${IMG}?n=2`);
const edited = m.find((x) => x.src === `${IMG}?n=3`);
assert.ok(Math.abs(lefty.left) <= 1, `left-aligned sits at the left: ${JSON.stringify(lefty)}`);
assert.ok(Math.abs(edited.left) <= 1 && edited.w === 120, `the edited item is where and how big it was set: ${JSON.stringify(edited)}`);
const frame = await pv.$('[data-qid=q1] .rs-qtext iframe');
assert.ok(frame, "the player is a player");
assert.match(await frame.getAttribute("src"), /^https:\/\/www\.youtube-nocookie\.com\/embed\/dQw4w9WgXcQ/);
assert.equal(await pv.$eval('[data-qid=q1] .rs-embed-inline', (e) => Math.round(e.getBoundingClientRect().width)), 480, "at the width set");
await pv.close();
const pv2 = await openPreview(browser, RUNTIME, { definition: def }, { viewport: { width: 1200, height: 900 } });
await pv2.waitForTimeout(500);
m = await measure(pv2);
assert.ok(!m.some((x) => !x.src || x.src.includes("{{")), "no parameter → no broken picture");
await pv2.close();
ok("Prince 8 — a URL parameter piped as an image URL shows the picture; without one, nothing broken");

/* the same alignment in the builder's Live View as in the respondent preview */
const ALIGNED = { ...def, questions: [{ ...q(def, "q1"), text: `<p>T</p>${["left", "center", "right"].map((a) => `<img src="${IMG}?al=${a}" alt="" style="width: 100px; height: auto; max-width: 100%; display: block; margin-left: ${a === "left" ? "0" : "auto"}; margin-right: ${a === "right" ? "0" : "auto"}" data-rs-media="image">`).join("")}` }, ...def.questions.slice(1)] };
const pv3 = await openPreview(browser, RUNTIME, { definition: ALIGNED }, { viewport: { width: 1200, height: 900 } });
await pv3.waitForTimeout(500);
const al = Object.fromEntries((await measure(pv3)).map((x) => [x.src.split("al=")[1], x]));
assert.ok(al.left.left <= 1 && al.right.right <= 1 && Math.abs(al.center.left - al.center.right) <= 2, `preview: ${JSON.stringify(al)}`);
await pv3.close();
/* the builder: the question text editor and Live View put them in the same places */
await openTab(page, "JSON");
await page.waitForSelector("textarea.code");
await page.click('button:has-text("edit")');
await page.fill("textarea.code", JSON.stringify(ALIGNED, null, 2));
await page.click('button:has-text("validate & apply")');
await page.waitForTimeout(400);
await selectQuestion("Q1");
/*
 * `$$eval` finds the elements in one round trip and measures them in another;
 * a re-render in between (the Live View redraws once its media settle)
 * detaches the first set, and a detached image has no container to measure
 * against. Measure again until the set is the one on screen.
 */
const rel = async (sel, box) => {
  for (let i = 0; ; i++) {
    const out = await page.$$eval(sel, (es, box) => es.map((e) => { const c0 = e.closest(box); if (!c0) return null; const r = e.getBoundingClientRect(); const c = c0.getBoundingClientRect(); return { al: e.getAttribute("src").split("al=")[1], left: Math.round(r.left - c.left), right: Math.round(c.right - r.right) }; }), box);
    if (out.every(Boolean) || i >= 10) return out;
    await page.waitForTimeout(150);
  }
};
const inEditor = Object.fromEntries((await rel(".rte-surface img", ".rte-surface")).map((x) => [x.al, x]));
const pad = inEditor.left.left;
assert.ok(Math.abs(inEditor.right.right - pad) <= 2 && Math.abs(inEditor.center.left - inEditor.center.right) <= 2, `builder: ${JSON.stringify(inEditor)}`);
await page.click("text=Live View");
await page.waitForSelector(".rs-card[data-qid=q1] .rs-qtext img");
const live = Object.fromEntries((await rel(".rs-card[data-qid=q1] .rs-qtext img", ".rs-qtext")).map((x) => [x.al, x]));
assert.ok(live.left.left <= 1 && live.right.right <= 1 && Math.abs(live.center.left - live.center.right) <= 2, `Live View: ${JSON.stringify(live)}`);
await page.click("text=Standard").catch(() => {});
ok("Prince 7 — left / center / right land the same in the builder, Live View and the preview, each item its own");

/* ------------------------------------------------ legacy: the old field still works, and moves into the text */
await selectQuestion("Q3");
await page.waitForSelector('[data-testid="legacy-media"]');
assert.ok(await page.$('[data-testid="question-media"]'), "the old editor is still there for old data");
await page.click('[data-testid="legacy-media-move"]');
await page.waitForTimeout(400);
const q3 = q(await readDef(), "q3");
assert.equal(q3.settings.mediaUrl, undefined);
assert.equal(q3.settings.mediaDisplay, undefined);
assert.match(q3.text, /^Old media<div><img src="[^"]+stimulus\.png"[^>]*width: 90px[^>]*margin-left: auto; margin-right: 0/);
assert.equal(await page.$('[data-testid="legacy-media"]'), null, "the card goes once it is moved");
ok("legacy — a question with the old field keeps it, and moves it into the text with its size and alignment");

/* ------------------------------------------------ Oweas 1-2 / Prince 1-2: the option image pop-up */
await selectQuestion("Q2");
await page.click('[data-testid="option-image-0-choose"]');
await page.waitForSelector('[data-testid="asset-tile"]');
await page.click('[data-testid="asset-tile"] >> nth=0');
await page.click('[data-testid="asset-picker-use"]');
await page.waitForSelector('[data-testid="image-customize"]');
assert.equal(await page.inputValue('[data-testid="option-image-0"]'), "", "nothing reaches the option before Apply");
assert.equal(await page.$('[data-testid="image-customize"] [data-testid="media-insert-position"]'), null, "no position for an option image");
assert.equal(await page.inputValue('[data-testid="image-customize-alt"]'), "pack alt", "the asset's alt text comes along");
await page.fill('[data-testid="image-customize"] [data-testid="mdisp-width"]', "100");
await page.click('[data-testid="image-customize"] [data-testid="mdisp-align-center"]');
await page.fill('[data-testid="image-customize"] [data-testid="mdisp-padding"]', "4");
await page.fill('[data-testid="image-customize"] [data-testid="mdisp-spacing"]', "6");
const pst = await page.$eval('[data-testid="image-customize-preview"] img', (e) => { const c = getComputedStyle(e); return { w: c.width, p: c.paddingTop, mt: c.marginTop, mb: c.marginBottom, ml: c.marginLeft, mr: c.marginRight }; });
assert.equal(pst.w, "100px"); assert.equal(pst.p, "4px"); assert.equal(pst.mt, "6px"); assert.equal(pst.mb, "6px");
assert.equal(pst.ml, pst.mr, `the live preview is centred: ${JSON.stringify(pst)}`);
await page.click('[data-testid="image-customize-apply"]');
await page.waitForTimeout(300);
let o = q(await readDef(), "q2").options;
assert.equal(o[0].imageUrl, `${IMG}?asset=pack`);
assert.deepEqual(o[0].imageDisplay, { width: "100", align: "center", padding: "4", spacing: "6" });
assert.equal(o[0].imageAlt, "pack alt");
ok("Oweas 1 / Prince 1 — Choose opens the pop-up; the picture is added only on Apply, with its settings");

await page.click('[data-testid="option-image-1-choose"]');
await page.click('[data-testid="asset-tile"] >> nth=0');
await page.click('[data-testid="asset-picker-use"]');
await page.waitForSelector('[data-testid="image-customize"]');
await page.click('[data-testid="image-customize-cancel"]');
await page.waitForTimeout(200);
assert.equal(q(await readDef(), "q2").options[1].imageUrl, undefined, "Cancel adds nothing");
await page.setInputFiles('[data-testid="option-image-2-file"]', { name: "shot.png", mimeType: "image/png", buffer: Buffer.from("89504e470d0a1a0a", "hex") });
await page.waitForSelector('[data-testid="image-customize"]');
assert.equal(await page.inputValue('[data-testid="option-image-2"]'), "", "an upload waits for Apply too");
await page.click('[data-testid="image-customize-apply"]');
await page.waitForTimeout(300);
assert.equal(q(await readDef(), "q2").options[2].imageUrl, `${IMG}?asset=uploaded`);
await page.click('[data-testid="option-image-0-customize"]');
await page.waitForSelector('[data-testid="image-customize"]');
assert.equal(await page.inputValue('[data-testid="image-customize"] [data-testid="mdisp-width"]'), "100", "Customize reopens on the saved settings");
await page.fill('[data-testid="image-customize"] [data-testid="mdisp-width"]', "60");
await page.click('[data-testid="image-customize-apply"]');
await page.waitForTimeout(300);
o = q(await readDef(), "q2").options;
assert.equal(o[0].imageDisplay.width, "60");
ok("Prince 1-2 — Cancel adds nothing, Upload waits for Apply, Customize reopens and re-applies");

const pv4 = await openPreview(browser, RUNTIME, { definition: await readDef() }, { viewport: { width: 1200, height: 900 } });
await pv4.waitForSelector("[data-qid=q2] img");
const optImg = await pv4.$eval("[data-qid=q2] img", (e) => ({ w: Math.round(e.getBoundingClientRect().width), pad: getComputedStyle(e).paddingTop, style: e.getAttribute("style") }));
assert.equal(optImg.w, 60, `the respondent sees the width set: ${JSON.stringify(optImg)}`);
assert.equal(optImg.pad, "4px");
assert.match(optImg.style, /margin: 6px auto/, "centred, with its spacing");
await pv4.close();
ok("Oweas 2 — the option picture's settings reach the respondent");

assert.deepEqual(errors, [], `page errors: ${errors.join(" | ")}`);
await browser.close();
console.log(`\n${passed} checks passed`);

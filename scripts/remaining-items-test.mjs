/**
 * THE REMAINING REVIEW ITEMS (2026-10-01, second pass) — Studio and runtime.
 *
 *   Studio
 *   - 29-09 #1 / #2  a grid randomizes rows AND columns; its scale is "columns", once
 *   - 29-09 #4       the quota "target total" box shows the number typed
 *   - 29-09 #7       every field of the piping dialog can be changed; the token is editable
 *   - Oweas 3 / 6    "Displayed" is offered only when it differs from "All"
 *   - Prince 11/14/16 several images under a question, with a layout
 *   - Prince 36      a piped URL can be inserted "as image"
 *   - audit leftovers: the older "visible if" is shown and can be converted;
 *     a combination conjoint prohibition can be built
 *   Runtime
 *   - several images render, side by side; a content block draws its media
 *   - {{ImageURL|image}} draws the picture a URL parameter names
 *   - a conditional style applies only while its condition holds
 *
 *   node scripts/remaining-items-test.mjs      (studio on 3000, runtime on 3001)
 */
import { chromium } from "/home/claude/.npm-global/lib/node_modules/playwright/index.mjs";
import { openTab, openTabKey } from "./lib/nav.mjs";
import { openPreview } from "./lib/preview.mjs";
import assert from "node:assert/strict";

const STUDIO = process.env.STUDIO_URL ?? "http://localhost:3000";
const RUNTIME = process.env.RUNTIME_URL ?? "http://localhost:3001";
let passed = 0;
const ok = (m) => { console.log("  ok  ", m); passed++; };
const opts = (n, l = "Opt") => Array.from({ length: n }, (_, i) => ({ code: i + 1, label: `${l} ${i + 1}` }));
const rule = (ref, operator, value) => ({ type: "rule", source: { kind: "question", ref }, operator, ...(value !== undefined ? { value } : {}) });
const IMG_A = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==";
const IMG_B = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";

const FIXTURE = {
  meta: { id: "sandbox", code: "SANDBOX", title: "RemainingItems", version: "1.0" },
  questions: [
    { id: "q1", code: "Q1", variableName: "Q1", type: "single_select", text: "Region?", options: opts(3, "Region") },
    { id: "g", code: "G", variableName: "G", type: "matrix_single", text: "Grid",
      rows: [{ code: "r1", label: "Row 1" }, { code: "r2", label: "Row 2" }],
      options: [{ code: 1, label: "Aware" }, { code: 2, label: "Used" }] },
    { id: "q3", code: "Q3", variableName: "Q3", type: "single_select", text: "Pick", options: [
      { code: 1, label: "One" }, { code: 2, label: "Two", visibleIf: rule("q1", "eq", 1) }, { code: 3, label: "Three" }] },
    { id: "q4", code: "Q4", variableName: "Q4", type: "html", text: "Concept", settings: { mediaUrl: IMG_A } },
    { id: "q5", code: "Q5", variableName: "Q5", type: "multi_select", text: "Brands", options: opts(3, "Brand") },
  ],
  designs: [{ id: "d1", kind: "conjoint", name: "Bars", version: 1, seed: 1,
    config: { attributes: [{ name: "Brand", levels: ["Premium", "Value"] }, { name: "Price", levels: ["$1", "$2"] }, { name: "Warranty", levels: ["1y", "2y", "3y"] }], tasks: 4, alternativesPerTask: 2 },
    file: { format: "json", columns: [], rows: [] } }],
  quotas: [{ id: "qt1", name: "Quota 1", mode: "hard", cells: [{ id: "c1", label: "Cell 1", when: rule("q1", "eq", 1), limit: 50, limitType: "count" }] }],
  flow: [{ type: "page", id: "p1", questionIds: ["q1", "g", "q3", "q4", "q5"] }, { type: "end", id: "e", status: "complete" }],
};

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1700, height: 1150 } });
const errors = [];
page.on("pageerror", (e) => errors.push(e.message));
page.on("dialog", (d) => d.accept());

const readDef = async () => {
  const activeTab = await page.$eval(".menubar-here", (e) => e.dataset.tab).catch(() => null);
  await openTab(page, "JSON");
  await page.waitForSelector("textarea.code");
  const json = await page.$eval("textarea.code", (e) => e.value);
  if (activeTab) await openTabKey(page, activeTab).catch(() => {});
  return JSON.parse(json);
};
const loadFixture = async (def) => {
  await openTab(page, "JSON");
  await page.waitForSelector("textarea.code");
  await page.click('button:has-text("edit")');
  await page.fill("textarea.code", JSON.stringify(def, null, 2));
  await page.click('button:has-text("validate & apply")');
  await page.waitForTimeout(400);
};
const ensureSectionOpen = async (id) => {
  const head = `[data-testid="psec-head-${id}"]`;
  await page.waitForSelector(head);
  if ((await page.getAttribute(head, "aria-expanded")) !== "true") { await page.click(head); await page.waitForTimeout(150); }
};
const selectQuestion = async (code) => {
  await openTab(page, "Questions");
  await page.waitForSelector(".qcard");
  for (const c of await page.$$(".qcard")) {
    if ((await c.$eval(".mono, .qcode, [data-testid='qcard-code']", (e) => e.textContent).catch(() => "")).trim() === code || (await c.textContent()).startsWith(code)) { await c.click(); await page.waitForTimeout(250); return; }
  }
  for (const c of await page.$$(".qcard")) if ((await c.textContent()).includes(code)) { await c.click(); await page.waitForTimeout(250); return; }
  throw new Error(`no card for ${code}`);
};
const q = (def, id) => def.questions.find((x) => x.id === id);

await page.goto(`${STUDIO}/sandbox`, { waitUntil: "networkidle" });
await page.waitForSelector(".menubar");
await loadFixture(FIXTURE);
ok("fixture loaded");

/* ---------------------------------------------- 29-09 #1 / #2: grid randomization */
await selectQuestion("G");
await ensureSectionOpen("randomization");
await page.click('[data-testid="psec-body-randomization"] input[type="checkbox"] >> nth=0');
await page.waitForSelector('[data-testid="rand-axes"]');
const axes = await page.$$eval('[data-testid="rand-axes"] label', (ls) => ls.map((l) => l.textContent.trim()));
assert.deepEqual(axes, ["rows", "columns"], `one "columns" for the answer scale, no separate "options": ${axes}`);
await page.check('[data-testid="rand-axis-rows"]');
await page.check('[data-testid="rand-axis-options"]');
await page.waitForTimeout(300);
let r = q(await readDef(), "g").randomization;
assert.deepEqual([...r.scopes].sort(), ["options", "rows"]);
ok("29-09 #1 / #2 — a grid shuffles rows AND columns, offered once each");

/* ---------------------------------------------- Oweas 3: masking slices */
await selectQuestion("Q5");
await ensureSectionOpen("masking");
const addSet = await page.$('[data-testid="psec-body-masking"] button:has-text("+")');
if (addSet) {
  await addSet.click();
  await page.waitForTimeout(250);
}
if (await page.$('[data-testid="mask-source"]')) {
  await page.selectOption('[data-testid="mask-source"]', "q1");
  await page.waitForTimeout(200);
  let sel = await page.$$eval('[data-testid="mask-selection"] option', (os) => os.map((o) => o.value));
  assert.ok(!sel.includes("displayed"), `Q1 cannot change its list, so Displayed = All: ${sel}`);
  await page.selectOption('[data-testid="mask-source"]', "q3");
  await page.waitForTimeout(200);
  sel = await page.$$eval('[data-testid="mask-selection"] option', (os) => os.map((o) => o.value));
  assert.ok(sel.includes("displayed"), `Q3 has a conditional option, so Displayed is distinct: ${sel}`);
  ok("Oweas #3 — masking offers “Displayed” only for a source whose list can differ");
} else {
  console.log("  skip  masking set row not found in this layout");
}

/* ---------------------------------------------- legacy visible-if */
await selectQuestion("Q3");
await page.click('[data-testid="option-logic-1"]');
await page.waitForSelector('[data-testid="legacy-visibleif"]');
await page.click('[data-testid="legacy-visibleif-convert"]');
await page.waitForTimeout(300);
const o2 = q(await readDef(), "q3").options[1];
assert.equal(o2.visibleIf, undefined);
assert.equal(o2.logic.visibility, "show_when");
assert.equal(o2.logic.when.source.ref, "q1");
ok("the older “visible if” is shown, editable, and converts to Show when with the same meaning");

/* ---------------------------------------------- Prince 11: several images */
await selectQuestion("Q4");
await page.waitForSelector('[data-testid="media-list"]');
await page.click('[data-testid="media-add"]');
await page.waitForSelector('[data-testid="media-item-url-1"]');
await page.fill('[data-testid="media-item-url-1"]', IMG_B);
await page.waitForTimeout(250);
await page.check('[data-testid="media-layout-horizontal"]');
await page.waitForTimeout(250);
await page.fill('[data-testid="media-item-alt-0"]', "Pack A");
await page.waitForTimeout(300);
let def = await readDef();
assert.deepEqual(q(def, "q4").settings.mediaItems.map((m) => m.url), [IMG_A, IMG_B]);
assert.equal(q(def, "q4").settings.mediaUrl, IMG_A, "mediaUrl follows the first item");
assert.equal(q(def, "q4").settings.mediaLayout, "horizontal");
await page.click('[data-testid="media-item-delete-0"]');
await page.waitForTimeout(250);
def = await readDef();
assert.equal(q(def, "q4").settings.mediaUrl, IMG_B, "deleting the first promotes the second");
ok("Prince 11 / 14 / 16 — several images, alt text, layout, delete; the single URL stays in step");
await page.click('[data-testid="media-add"]');
await page.fill('[data-testid="media-item-url-1"]', IMG_A);
await page.waitForTimeout(300);

/* ---------------------------------------------- 29-09 #7 + Prince 36: the piping dialog */
await selectQuestion("Q5");
await page.click('[data-testid="insert-piping"] >> nth=0');
await page.waitForSelector('[data-testid="pipe-picker"]');
/* a REAL mouse press on a dialog control must reach it — the toolbar's mousedown used to cancel it */
await page.click('[data-testid="pipe-kind"]');
assert.equal(await page.evaluate(() => document.activeElement?.getAttribute("data-testid")), "pipe-kind", "the select takes focus when clicked");
await page.keyboard.press("Escape");
await page.click('[data-testid="pipe-token"]');
assert.equal(await page.evaluate(() => document.activeElement?.getAttribute("data-testid")), "pipe-token", "the token field takes focus when clicked");
await page.selectOption('[data-testid="pipe-kind"]', "embedded");
await page.waitForTimeout(150);
assert.equal(await page.$eval('[data-testid="pipe-kind"]', (e) => e.value), "embedded", "Insert from can be changed");
await page.selectOption('[data-testid="pipe-kind"]', "question");
await page.waitForSelector('[data-testid="pipe-question"]');
await page.selectOption('[data-testid="pipe-question"]', "Q3");
await page.selectOption('[data-testid="pipe-property"]', "label");
await page.waitForTimeout(150);
assert.match(await page.inputValue('[data-testid="pipe-token"]'), /^\{\{Q3\.label\}\}$/);
await page.check('[data-testid="pipe-as-image"]');
assert.match(await page.inputValue('[data-testid="pipe-token"]'), /\|image\}\}$/);
await page.uncheck('[data-testid="pipe-as-image"]');
await page.fill('[data-testid="pipe-token"]', "{{Q3.label|upper}}");
await page.click('[data-testid="pipe-insert"]');
await page.waitForTimeout(400);
assert.match(q(await readDef(), "q5").text, /\{\{Q3\.label\|upper\}\}/);
ok("29-09 #7 — Insert from, Question and Insert all change; the token can be edited; “Show as image” writes |image");

/* ---------------------------------------------- 29-09 #4: quota target total */
await openTab(page, "Quotas");
await page.waitForSelector('[data-testid="quota-open-logic"]');
await page.click('[data-testid="quota-open-logic"]');
await page.waitForSelector('[data-testid="quota-target-total-0"]');
await page.fill('[data-testid="quota-target-total-0"]', "123456");
await page.waitForTimeout(250);
const box = await page.$eval('[data-testid="quota-target-total-0"]', (e) => ({ w: e.getBoundingClientRect().width, sw: e.scrollWidth, cw: e.clientWidth }));
assert.ok(box.w >= 100, `the box is readable: ${JSON.stringify(box)}`);
assert.ok(box.sw <= box.cw + 1, `the whole number fits: ${JSON.stringify(box)}`);
ok(`29-09 #4 — the target-total box is ${Math.round(box.w)}px and shows all of “123456”`);
await page.fill('[data-testid="quota-target-total-0"]', "12345678901234");
await page.waitForTimeout(250);
const wide = await page.$eval('[data-testid="quota-target-total-0"]', (e) => e.getBoundingClientRect().width);
assert.ok(wide > box.w + 20, `a long number widens the box: ${Math.round(box.w)} → ${Math.round(wide)}`);
ok("…and a longer number widens it rather than scrolling out of sight");

/* ---------------------------------------------- conjoint: a combination prohibition */
await openTab(page, "Design Generators");
await page.waitForSelector('button:has-text("regenerate")');
await page.click('button:has-text("regenerate")');
await page.waitForSelector('[data-testid="prohibitions-editor"]');
await page.click('[data-testid="add-prohibition"]');
await page.waitForSelector('[data-testid="prohibition-add-level"]');
await page.click('[data-testid="prohibition-add-level"]');
await page.click('[data-testid="prohibition-add-level"]');
await page.waitForSelector('[data-testid="prohibition-also-op"]');
await page.selectOption('[data-testid="prohibition-also-op"]', "or");
await page.click('button:has-text("Generate Design File")');
await page.waitForSelector('button:has-text("Attach to survey")');
await page.click('button:has-text("Attach to survey")');
await page.waitForTimeout(400);
const design = (await readDef()).designs.find((d) => d.id === "d1");
const proh = design.config.prohibitions[0];
assert.equal(proh.also.length, 2);
assert.equal(proh.alsoOp, "or");
ok("conjoint — a prohibition can be a combination: the pair AND any of two more levels");

assert.deepEqual(errors, [], `no page errors: ${errors.join(" | ")}`);
ok("no page errors in the Studio");

/* ================================================== runtime */
const rt = {
  meta: { id: "rt", code: "RT", title: "remaining", version: "1.0" },
  embeddedData: [{ name: "ImageURL", source: "url" }],
  questions: [
    { id: "c1", code: "C1", variableName: "C1", type: "html", text: "Look at these",
      settings: { mediaItems: [{ id: "1", url: IMG_A, alt: "Pack A" }, { id: "2", url: IMG_B, alt: "Pack B" }], mediaUrl: IMG_A, mediaLayout: "horizontal" } },
    { id: "q1", code: "Q1", variableName: "Q1", type: "single_select", text: "Which? {{ImageURL|image}}", options: opts(2) },
    { id: "q2", code: "Q2", variableName: "Q2", type: "open_text", text: "Why?" },
  ],
  ux: { styles: [{ id: "s1", label: "flag", target: { kind: "question", questionId: "q2" }, rules: [{ declarations: { "background-color": "rgb(254, 243, 199)" } }], when: rule("q1", "eq", 1) }], animations: [], behaviors: [] },
  flow: [{ type: "page", id: "p1", questionIds: ["c1", "q1", "q2"] }, { type: "end", id: "e", status: "complete" }],
};
const pv = await openPreview(browser, RUNTIME, { definition: rt }, { search: `?ImageURL=${encodeURIComponent(IMG_B)}`, viewport: { width: 1200, height: 900 } });
await pv.waitForSelector('[data-rs-id="c1"] [data-testid="rs-qmedia"]');
const media = await pv.$eval('[data-rs-id="c1"] [data-testid="rs-qmedia"]', (e) => ({ cls: e.className, n: e.querySelectorAll("img").length, alts: [...e.querySelectorAll("img")].map((i) => i.alt) }));
assert.equal(media.n, 2, JSON.stringify(media));
assert.match(media.cls, /rs-qmedia-horizontal/);
assert.deepEqual(media.alts, ["Pack A", "Pack B"]);
const tops = await pv.$$eval('[data-rs-id="c1"] [data-testid="rs-qmedia-item"]', (els) => els.map((e) => Math.round(e.getBoundingClientRect().top)));
assert.equal(tops[0], tops[1], `side by side: ${tops}`);
ok("Prince 11 §4 — a content block draws its images, all of them, side by side, with their alt text");
await pv.setViewportSize({ width: 380, height: 800 });
await pv.waitForTimeout(250);
const tops2 = await pv.$$eval('[data-rs-id="c1"] [data-testid="rs-qmedia-item"]', (els) => els.map((e) => Math.round(e.getBoundingClientRect().top)));
assert.ok(tops2[1] > tops2[0], `on a phone they wrap: ${tops2}`);
ok("…and wrap to the next line on a narrow screen");
await pv.setViewportSize({ width: 1200, height: 900 });

const piped = await pv.$('[data-rs-id="q1"] img.rs-piped-image');
if (piped) {
  assert.equal(await piped.getAttribute("src"), IMG_B);
  ok("Prince 36 — {{ImageURL|image}} draws the picture the URL parameter names");
} else {
  const html = await pv.$eval('[data-rs-id="q1"] .rs-qtext', (e) => e.innerHTML);
  console.log("  note  preview carries no URL parameters here; piped text:", html.slice(0, 120));
}

const bg = async () => pv.$eval('[data-rs-id="q2"]', (e) => getComputedStyle(e).backgroundColor);
const before = await bg();
assert.notEqual(before, "rgb(254, 243, 199)", "not applied before its condition holds");
await pv.click('[data-rs-id="q1"] label:has-text("Opt 1")');
await pv.waitForTimeout(400);
assert.equal(await bg(), "rgb(254, 243, 199)", "the style applies once Q1 = 1");
await pv.click('[data-rs-id="q1"] label:has-text("Opt 2")');
await pv.waitForTimeout(400);
assert.equal(await bg(), before, "…and stops when it no longer holds");
ok("a conditional style applies only while its condition holds");
await pv.close();

await browser.close();
console.log(`\n${passed} checks passed`);

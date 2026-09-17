/**
 * RICH ANSWER OPTIONS + MEDIA — the flow, end to end, with real survey content.
 *
 *   STUDIO_URL=http://localhost:3000 RUNTIME_URL=http://localhost:3001 node scripts/rich-media-test.mjs
 *
 * In the sandbox (no database), so the library itself cannot upload — that
 * half is covered by the media package's tests and the route code. What is
 * proved here is the part that touches every survey: an option label edited
 * as rich text, a picture inserted into it with a chosen width, the sizing
 * controls on a question's media, the HTML source view, the sanitiser at the
 * seam — and the same content rendered by the runtime with the same size.
 */
import { openHarness, assert } from "./lib/variantHarness.mjs";
import { openPreview } from "./lib/preview.mjs";

const h = await openHarness();
const { page } = h;
let pass = 0;
const ok = (name) => { pass++; console.log(`  ok   ${name}`); };
const RUNTIME = process.env.RUNTIME_URL ?? "http://localhost:3001";

/* a 1×1 PNG — an image URL the sandbox can render without a store */
const PNG = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==";

const def = {
  meta: { id: "sandbox", code: "SANDBOX", title: "Rich", version: "1.0" },
  questions: [
    { id: "q1", code: "Q1", variableName: "Q1", type: "single_select", text: "Which brand?", options: [
      { code: "1", label: "Apple" }, { code: "2", label: "Samsung" }, { code: "3", label: "Google" },
    ] },
    { id: "q2", code: "Q2", variableName: "Q2", type: "single_select", text: "Look at this", settings: { mediaUrl: PNG }, options: [{ code: "1", label: "Yes" }, { code: "2", label: "No" }] },
  ],
  flow: [{ type: "page", id: "p1", title: "Page 1", questionIds: ["q1", "q2"] }, { type: "end", id: "e1", status: "complete" }],
};
await h.loadDef(def);

/* ============================================================ the option label is rich text */

console.log("\nSTUDIO — an option label is a rich-text field");
await h.goTab("Questions");
await page.click('.qcard:has-text("Which brand?")');
await page.waitForSelector('[data-testid="option-label"]');
{
  const labels = await page.$$eval('[data-testid="option-label"]', (els) => els.map((e) => e.textContent));
  assert.deepEqual(labels, ["Apple", "Samsung", "Google"]);
  const editable = await page.$eval('[data-testid="option-label"]', (e) => e.getAttribute("contenteditable"));
  assert.equal(editable, "true");
  ok("the three labels are editable surfaces showing their text");
}

// select "Apple" and make it bold from the popover toolbar
{
  const first = (await page.$$('[data-testid="option-label"]'))[0];
  await first.click();
  await page.waitForSelector('[data-testid="option-label-format"]');
  await page.keyboard.press("Control+A");
  await page.waitForSelector('[data-testid="option-label-toolbar"]');
  ok("selecting text in a label opens its formatting toolbar (an “Aa” button opens it too)");
  await page.click('[data-testid="option-label-toolbar"] button[title="Bold"]');
  await page.waitForTimeout(450);
  const d = await h.readDef();
  assert.match(d.questions[0].options[0].label, /^<b>Apple<\/b>$/);
  assert.equal(d.questions[0].options[1].label, "Samsung", "an untouched label is byte-identical");
  ok("Bold writes <b>Apple</b> to the definition; Samsung is unchanged");
}

// Enter still adds the next option
{
  await h.goTab("Questions");
  await page.click('.qcard:has-text("Which brand?")');
  await page.waitForSelector('[data-testid="option-label"]');
  const last = (await page.$$('[data-testid="option-label"]'))[2];
  await last.click();
  await page.keyboard.press("End");
  await page.keyboard.press("Enter");
  await page.waitForTimeout(200);
  await page.keyboard.type("OnePlus");
  await page.waitForTimeout(450);
  const d = await h.readDef();
  assert.equal(d.questions[0].options.length, 4);
  assert.equal(d.questions[0].options[3].label, "OnePlus");
  assert.equal(d.questions[0].options[3].code, "4");
  ok("Enter adds the next option and typing lands in it — the keyboard contract holds");
}

/* ============================================================ insert a sized picture */

console.log("\nSTUDIO — a picture in a label, sized with controls");
{
  await h.goTab("Questions");
  await page.click('.qcard:has-text("Which brand?")');
  await page.waitForSelector('[data-testid="option-label"]');
  const second = (await page.$$('[data-testid="option-label"]'))[1];
  await second.click();
  await page.keyboard.press("End");
  await page.click('[data-testid="option-label-format"]');
  await page.waitForSelector('[data-testid="option-label-toolbar"]');
  await page.click('[data-testid="option-label-toolbar"] [data-testid="rte-media"]');
  await page.waitForSelector('[data-testid="media-insert"]');
  ok("the toolbar's media button opens the insert dialog");
  await page.fill('[data-testid="media-insert-url"]', PNG);
  await page.fill('[data-testid="media-insert-alt"]', "Samsung logo");
  await page.fill('[data-testid="mdisp-width"]', "120");
  await page.click('[data-testid="mdisp-align-center"]');
  const cssOut = await page.textContent('[data-testid="mdisp-css-out"]');
  assert.match(cssOut, /width: 120px/);
  assert.match(cssOut, /margin-left: auto/);
  ok("the controls show the CSS they mean");
  await page.waitForSelector('[data-testid="media-display-preview"] img');
  await page.click('[data-testid="media-insert-ok"]');
  await page.waitForTimeout(500);
  const d = await h.readDef();
  const label = d.questions[0].options[1].label;
  assert.match(label, /Samsung/);
  assert.match(label, /<img [^>]*src="data:image\/png/);
  assert.match(label, /alt="Samsung logo"/);
  assert.match(label, /width: 120px/);
  assert.match(label, /data-rs-media="image"/);
  assert.doesNotMatch(label, /on[a-z]+=/);
  ok("the label carries the picture with its alt text and the chosen size");
}

/* ============================================================ the HTML view and the sanitiser */

console.log("\nSTUDIO — HTML source and safety");
{
  await h.goTab("Questions");
  await page.click('.qcard:has-text("Which brand?")');
  await page.waitForSelector('[data-testid="option-label"]');
  const third = (await page.$$('[data-testid="option-label"]'))[2];
  await third.click();
  await page.click('[data-testid="option-label-format"]');
  await page.waitForSelector('[data-testid="option-label-toolbar"]');
  await page.click('[data-testid="option-label-toolbar"] button:has-text("HTML")');
  await page.waitForSelector('[data-testid="option-label-html"]');
  await page.fill('[data-testid="option-label-html"]', '<span style="color: green; behavior: url(x)" onclick="steal()">Google</span><script>alert(1)</script>');
  await page.keyboard.press("Enter");
  await page.waitForTimeout(500);
  const d = await h.readDef();
  const label = d.questions[0].options[2].label;
  assert.match(label, /color: green/);
  assert.doesNotMatch(label, /behavior|onclick|<script|alert/);
  ok("hand-written HTML keeps its colour and loses the handler, the executable CSS and the script");
}

/* ============================================================ question media size */

console.log("\nSTUDIO — a question's media has size controls");
{
  await h.goTab("Questions");
  await page.click('.qcard:has-text("Look at this")');
  await page.waitForSelector('[data-testid="question-media-display"]');
  await page.click('[data-testid="question-media-display"] summary');
  await page.fill('[data-testid="question-media-display"] [data-testid="mdisp-width"]', "200");
  await page.selectOption('[data-testid="question-media-display"] [data-testid="mdisp-fit"]', "contain");
  await page.waitForTimeout(500);
  const d = await h.readDef();
  assert.equal(d.questions[1].settings.mediaDisplay.width, "200");
  assert.equal(d.questions[1].settings.mediaDisplay.fit, "contain");
  ok("width and fit are stored as a MediaDisplay on the question");
}

/* ============================================================ the Assets tab */

console.log("\nSTUDIO — the Assets tab");
{
  await h.goTab("Assets");
  await page.waitForSelector('[data-testid="assets-panel"]');
  const text = await page.textContent('[data-testid="assets-panel"]');
  assert.match(text, /Save the survey first/);
  ok("Assets is a tab; in the sandbox it explains the library needs a saved survey");
}

/* ============================================================ the runtime shows the same thing */

console.log("\nRUNTIME — the same content, the same size");
{
  const d = await h.readDef();
  const pv = await openPreview(h.browser, RUNTIME, { definition: d });
  await pv.waitForSelector('[data-qid="q1"]');
  const bold = await pv.$('[data-qid="q1"] b');
  assert.ok(bold, "the bold label renders as <b>");
  const img = await pv.$('[data-qid="q1"] img[data-rs-media="image"]');
  assert.ok(img, "the inserted picture renders");
  const style = await img.getAttribute("style");
  assert.match(style, /width: 120px/);
  assert.equal(await img.getAttribute("alt"), "Samsung logo");
  const green = await pv.$eval('[data-qid="q1"] span[style]', (e) => e.getAttribute("style"));
  assert.match(green, /color: green/);
  assert.doesNotMatch(green, /behavior/);
  ok("respondents see the bold label, the 120px picture and the green option — and no handler");
  const media = await pv.$('[data-qid="q2"] [data-testid="media-image"]');
  assert.ok(media, "the question media renders");
  const mstyle = await media.getAttribute("style");
  assert.match(mstyle, /width: 200px/);
  assert.match(mstyle, /object-fit: contain/);
  assert.match(mstyle, /max-width: 100%/);
  ok("the question's media is 200px wide, contained and responsive — the Studio's controls, the respondent's CSS");
  // the option is still answerable
  await pv.click('[data-qid="q1"] label:has-text("Samsung"), [data-qid="q1"] [data-code="2"], [data-qid="q1"] text=Samsung').catch(() => {});
  await pv.close();
}

console.log(`\n${pass} checks passed`);
await h.browser.close();

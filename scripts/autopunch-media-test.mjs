/**
 * Browser suite: paste Replace/Append, option-level auto punch (visual +
 * expression, cross-page and same-page), Preview block (entry point, seeded
 * dependencies, unreachable block), universal media URLs.
 *
 *   STUDIO_URL=http://localhost:3000 RUNTIME_URL=http://localhost:3001 node scripts/autopunch-media-test.mjs
 */
import { openHarness, assert } from "./lib/variantHarness.mjs";

const h = await openHarness();
const { page } = h;
const runtime = process.env.RUNTIME_URL ?? "http://localhost:3001";

const products = (id, code, type = "multi_select") => ({
  id, code, variableName: code, type, text: `${code}: which products?`,
  options: [
    { code: "A", label: "Product A" },
    { code: "B", label: "Product B" },
    { code: "C", label: "Product C" },
  ],
  settings: {},
});

const baseDef = () => ({
  meta: { id: "sandbox", code: "SANDBOX", title: "Auto punch", version: "1.0" },
  questions: [products("q1", "Q1"), products("q2", "Q2"), products("q3", "Q3", "single_select"),
    { id: "q4", code: "Q4", variableName: "Q4", type: "numeric", text: "Q4: how many?", settings: {} }],
  flow: [
    { type: "page", id: "p1", title: "Intro", questionIds: ["q1"] },
    { type: "block", id: "blk", title: "Products block", children: [
      { type: "page", id: "p2", questionIds: ["q2", "q3"] },
      { type: "page", id: "p3", questionIds: ["q4"] },
    ] },
    { type: "end", id: "e1", status: "complete" },
  ],
});

/** A runtime preview of the CURRENT definition (flow intact), optionally at a block with seeded answers. */
const openPreview = async (entry = {}) => {
  const def = await h.readDef();
  const pv = await h.browser.newPage({ viewport: { width: 1000, height: 1000 } });
  pv.on("pageerror", (e) => console.error("RUNTIME PAGE ERROR:", e.message));
  await pv.goto(`${runtime}/preview`, { waitUntil: "networkidle" });
  await pv.evaluate(([d, e]) => window.postMessage({ type: "rescript:preview", definition: d, ...e }, "*"), [def, entry]);
  await pv.waitForSelector("[data-qid], [data-testid='rs-start-note']");
  return pv;
};
const tick = async (pv, qid, code) => pv.click(`[data-qid="${qid}"] input[value="${code}"], [data-qid="${qid}"] [data-code="${code}"]`);

await h.loadDef(baseDef());

/** Open the first question's editor (a click on an already-open card would close it). */
const openFirstQuestion = async () => {
  await h.goTab("Questions");
  await page.waitForSelector('[data-testid="block"]');
  if (!(await page.$(".qcard.selected"))) await page.click('[data-testid="block"] >> nth=0 >> .qcard-text');
  await page.waitForSelector('.qcard.selected [data-testid="toggle-paste"], .qcard.selected [data-testid="question-media"]');
};

/* ================================================================ 1. paste */
await openFirstQuestion();
await page.click('.qcard.selected [data-testid="toggle-paste"]');
let box = await page.inputValue('.qcard.selected [data-testid="paste-box"]');
assert.equal(box, "A\tProduct A\nB\tProduct B\nC\tProduct C", "the paste box opens showing the existing options as code<TAB>label");
assert.ok(await page.isChecked('.qcard.selected [data-testid="paste-mode-replace"]'), "Replace is the default");
// replace: reorder, rename B by code, drop C, add a new one by label
await page.fill('.qcard.selected [data-testid="paste-box"]', "B\tProduct B+\nA\tProduct A\nProduct D");
assert.equal(await page.textContent('.qcard.selected [data-testid="paste-summary"]'), "keeps 2 · adds 1 · removes 1");
assert.ok(await page.$('.qcard.selected [data-testid="paste-removes"]'), "the removed code is called out");
await page.click('.qcard.selected [data-testid="import-options"]');
let def = await h.readDef();
assert.deepEqual(def.questions[0].options.map((o) => [o.code, o.label]).slice(0, 2), [["B", "Product B+"], ["A", "Product A"]],
  "Replace keeps identity by code and drops the unmentioned option");
assert.equal(def.questions[0].options[2].label, "Product D");
assert.ok(!["A", "B", "C"].includes(String(def.questions[0].options[2].code)), "the new option gets a fresh code");
console.log("✔ paste box: shows existing options, Replace keeps codes for kept options");

await openFirstQuestion();
if (!(await page.$('.qcard.selected [data-testid="paste-panel"]'))) await page.click('.qcard.selected [data-testid="toggle-paste"]');
await page.click('.qcard.selected [data-testid="paste-mode-append"]');
assert.equal(await page.inputValue('.qcard.selected [data-testid="paste-box"]'), "", "Append starts with an empty box");
await page.fill('.qcard.selected [data-testid="paste-box"]', "1. Product E\nA\tclashes");
await page.click('.qcard.selected [data-testid="import-options"]');
def = await h.readDef();
const codes = def.questions[0].options.map((o) => String(o.code));
assert.deepEqual(def.questions[0].options.slice(0, 3).map((o) => o.label), ["Product B+", "Product A", "Product D"], "Append leaves the list as it was");
assert.equal(new Set(codes).size, codes.length, "no duplicate codes after appending a clashing code");
assert.deepEqual(def.questions[0].options.slice(3).map((o) => o.label), ["Product E", "clashes"]);
console.log("✔ paste box: Append adds after, never duplicates a code");

/* ================================================== 2. auto punch — visual */
await h.loadDef(baseDef());
await h.goTab("Logic");
await page.waitForSelector('[data-testid="auto-punch-panel"]');
assert.ok(await page.$('[data-testid="ap-empty"]'));
await page.click('[data-testid="ap-add-simple"]');
await page.waitForSelector('[data-testid="ap-rule"]');
// default: Q1.A selected → select Q2.A ; make it Q2.B
await page.selectOption('[data-testid="ap-rule"] [data-testid="ap-target-opt"]', "B");
def = await h.readDef();
let q2 = def.questions.find((q) => q.id === "q2");
assert.equal(q2.punches.length, 1, "the rule is stored on the TARGET question");
assert.deepEqual(q2.punches[0].source, { kind: "codes", codes: ["B"] });
assert.equal(q2.punches[0].action, "select");
assert.deepEqual(q2.punches[0].when, { type: "rule", source: { kind: "question", ref: "q1" }, operator: "selected", value: "A" });
await h.goTab("Logic");
assert.equal(await page.textContent('[data-testid="ap-rule-text"]'), "IF Q1.A THEN SELECT Q2.B");
console.log("✔ visual auto punch: source Q / option → action → target Q / option, stored as a PunchRule with an ordinary Condition");

// same rule survives a round trip into the runtime: Q1.A → page 2 arrives with Q2.B ticked
let pv = await openPreview();
await tick(pv, "q1", "A");
await h.next(pv);
await pv.waitForSelector('[data-qid="q2"]');
assert.deepEqual(await h.answerOf(pv, "q2"), ["B"], "Q2.B is auto-selected on arrival");
assert.ok(await pv.isChecked('[data-qid="q2"] input[value="B"]'));
await pv.close();
pv = await openPreview();
await tick(pv, "q1", "C");
await h.next(pv);
await pv.waitForSelector('[data-qid="q2"]');
assert.equal(await h.answerOf(pv, "q2"), undefined, "nothing punched when the condition is false");
await pv.close();
console.log("✔ runtime: IF Q1.A THEN SELECT Q2.B — punched on arrival, only when true");

/* ============================================== 3. auto punch — expression */
await h.goTab("Logic");
await page.fill('[data-testid="ap-add-expression"]', "IF (Q1.A OR Q1.B) AND NOT Q1.C THEN SELECT Q3.C AND DESELECT Q2.B");
await page.click('[data-testid="ap-add-apply"]');
await page.waitForFunction(() => document.querySelectorAll('[data-testid="ap-rule"]').length === 3);
def = await h.readDef();
q2 = def.questions.find((q) => q.id === "q2");
const q3 = def.questions.find((q) => q.id === "q3");
assert.equal(q2.punches.length, 2);
assert.equal(q3.punches.length, 1);
assert.equal(q2.punches[1].action, "deselect");
assert.equal(q3.punches[0].when.type, "group", "the complex condition is the canonical AND/OR/NOT tree");
// the complex rule cannot be flattened into the simple row
await h.goTab("Logic");
const modes = await page.$$eval('[data-testid="ap-rule"] [data-testid="ap-mode-simple"]', (els) => els.map((e) => e.disabled));
assert.deepEqual(modes, [false, true, true], "the two rules born of the complex condition are edited as expressions only");
// bad expressions are explained, not stored
await page.fill('[data-testid="ap-add-expression"]', "IF Q1.A THEN SELECT Q9.B");
await page.click('[data-testid="ap-add-apply"]');
assert.match(await page.textContent('[data-testid="ap-add-error"]'), /Unknown question/);
console.log("✔ expression auto punch: complex AND/OR/NOT conditions via the existing parser; errors explained");

// runtime: Q1 = A → Q2 arrives with B selected then deselected by the second rule (net: nothing), Q3 = C
pv = await openPreview();
await tick(pv, "q1", "A");
await h.next(pv);
await pv.waitForSelector('[data-qid="q3"]');
assert.equal(await h.answerOf(pv, "q3"), "C", "single-select target takes the punched code");
assert.deepEqual(await h.answerOf(pv, "q2") ?? [], [], "select then deselect of the same option nets to none");
await pv.close();

/* ========================================= 4. same-page live re-punching */
await h.loadDef(baseDef());
await h.goTab("Logic");
await page.fill('[data-testid="ap-add-expression"]', "IF Q2.A IS SELECTED THEN SELECT Q3.C");
await page.click('[data-testid="ap-add-apply"]');
await page.waitForSelector('[data-testid="ap-rule"]');
pv = await openPreview({ startAt: "blk" });
await pv.waitForSelector('[data-qid="q2"]');
assert.equal(await h.answerOf(pv, "q3"), undefined);
await tick(pv, "q2", "A");
await pv.waitForFunction(() => window.__rescriptState?.answers?.q3 === "C");
assert.ok(await pv.isChecked('[data-qid="q3"] input[value="C"]'), "Q3.C ticks the moment Q2.A is clicked on the same page");
await pv.close();
console.log("✔ same-page auto punch reacts live");

/* ======================================== 5. list actions: hide / disable */
await h.loadDef(baseDef());
await h.goTab("Logic");
await page.fill('[data-testid="ap-add-expression"]', "IF Q1.A THEN HIDE Q2.C AND DISABLE Q3.A");
await page.click('[data-testid="ap-add-apply"]');
await page.waitForFunction(() => document.querySelectorAll('[data-testid="ap-rule"]').length === 2);
pv = await openPreview();
await tick(pv, "q1", "A");
await h.next(pv);
await pv.waitForSelector('[data-qid="q2"]');
assert.equal(await pv.$(`[data-qid="q2"] input[value="C"]`), null, "Q2.C is hidden");
assert.ok(await pv.$(`[data-qid="q2"] input[value="A"]`));
assert.ok(await pv.isDisabled('[data-qid="q3"] input[value="A"]'), "Q3.A is disabled");
assert.equal(await h.answerOf(pv, "q2"), undefined, "list actions never write answers");
await pv.close();
console.log("✔ HIDE / DISABLE act on the option list through the option pipeline");

/* ================================================= 6. preview block */
await h.loadDef(baseDef());
await h.goTab("Logic");
await page.fill('[data-testid="ap-add-expression"]', "IF Q1.A THEN SELECT Q2.B");
await page.click('[data-testid="ap-add-apply"]');
await page.waitForSelector('[data-testid="ap-rule"]');
await h.goTab("Questions");
const buttons = await page.$$('[data-testid="block-preview"]');
assert.equal(buttons.length, 2, "every block has a Preview block button");
// block 2 depends on Q1 → the dialog offers a test value
await buttons[1].click();
await page.waitForSelector('[data-testid="preview-block-dialog"]');
const deps = await page.$$eval('[data-testid="preview-dep"] .mono', (els) => els.map((e) => e.textContent));
assert.deepEqual(deps, ["Q1"], "the dialog lists exactly the earlier questions the block reads");
await page.click('[data-testid="preview-dep"] label:has-text("A: Product A") input');
const [popup] = await Promise.all([
  page.context().waitForEvent("page"),
  page.click('[data-testid="preview-block-go"]'),
]);
await popup.waitForSelector('[data-testid="preview-block"]');
assert.equal(await popup.textContent('[data-testid="preview-block"]'), "Products block", "the preview bar names the block");
await popup.waitForSelector('[data-qid="q2"]');
assert.equal(await popup.$('[data-qid="q1"]'), null, "the preview starts AT the block, not on page 1");
assert.deepEqual(await h.answerOf(popup, "q2"), ["B"], "seeded Q1 = A drives the block's punch rule");
assert.equal(await popup.textContent('[data-testid="preview-seeded"]'), "1 test value");
// the rest of the survey runs normally: page break inside the block, then the end
await popup.click('[data-qid="q3"] input[value="A"]');
await h.next(popup);
await popup.waitForSelector('[data-qid="q4"]');
await popup.fill('[data-qid="q4"] input', "3");
await h.next(popup);
await popup.waitForSelector(".rs-end");
await popup.close();
console.log("✔ Preview block: dependency dialog, seeded values, starts at the block, runs through the page break");

// block 1 has no dependencies → opens straight away, at page 1
const [popup2] = await Promise.all([page.context().waitForEvent("page"), buttons[0].click()]);
await popup2.waitForSelector('[data-qid="q1"]');
assert.equal(await popup2.textContent('[data-testid="preview-block"]'), "Intro");
await popup2.close();
// preview bar reports the revision after the draft flush (sandbox: null → omitted), and never crashes
console.log("✔ Preview block: a block without dependencies opens directly");

// unreachable block: display logic false with no answers → a clear note, the first page instead
pv = await openPreview({ startAt: "blk" });
await pv.waitForSelector('[data-qid="q2"]');
await pv.close();
const gated = baseDef();
gated.flow[1].visibleIf = { type: "rule", source: { kind: "question", ref: "q1" }, operator: "selected", value: "A" };
await h.loadDef(gated);
pv = await openPreview({ startAt: "blk" });
await pv.waitForSelector('[data-testid="rs-start-note"]');
assert.match(await pv.textContent('[data-testid="rs-start-note"]'), /not reachable/);
assert.ok(await pv.$('[data-qid="q1"]'), "falls back to the first page, visibly");
await pv.close();
pv = await openPreview({ startAt: "blk", answers: { q1: ["A"] } });
await pv.waitForSelector('[data-qid="q2"]');
assert.equal(await pv.$('[data-testid="rs-start-note"]'), null, "with the gating answer seeded the block is reachable");
await pv.close();
console.log("✔ Preview block: unreachable block is reported, never silently mis-started");

/* ===================================================== 7. media URLs */
const mediaDef = baseDef();
mediaDef.questions[0].settings.mediaUrl = "https://www.youtube.com/watch?v=dQw4w9WgXcQ&t=1m";
mediaDef.questions[1].settings.mediaUrl = "https://drive.google.com/file/d/1AbCdEfGhIjKlMnOpQrStUvWxYz/view?usp=sharing";
mediaDef.questions[1].options[0].imageUrl = "https://cdn.example.invalid/img/a.png?w=200&sig=x";
mediaDef.questions[1].options[1].imageUrl = "javascript:alert(1)";
mediaDef.questions[1].options[2].imageUrl = "https://media.example.invalid/clip.mp4";
mediaDef.questions[1].variant = "multi_select.image";
mediaDef.questions[1].type = "image_select";
mediaDef.questions[2].settings.mediaUrl = "data:text/html,<script>alert(1)</script>";
mediaDef.flow[1].mediaUrl = "https://youtu.be/dQw4w9WgXcQ";
await h.loadDef(mediaDef);
pv = await openPreview();
await pv.waitForSelector('[data-qid="q1"] [data-testid="media-embed"] iframe');
assert.equal(await pv.getAttribute('[data-qid="q1"] [data-testid="media-embed"] iframe', "src"),
  "https://www.youtube-nocookie.com/embed/dQw4w9WgXcQ?rel=0&start=60", "a watch URL becomes the embed player, timestamp kept");
assert.equal(await pv.$$eval("iframe", (els) => els.every((f) => /^https:\/\/(www\.youtube-nocookie\.com|drive\.google\.com)\//.test(f.src))), true,
  "only allow-listed hosts are ever framed");
await h.next(pv);
await pv.waitForSelector('[data-qid="q2"]');
assert.equal(await pv.getAttribute('[data-testid="rs-block-media"] iframe', "src"), "https://www.youtube-nocookie.com/embed/dQw4w9WgXcQ?rel=0", "block media renders under the block name");
assert.match(await pv.getAttribute('[data-qid="q2"] [data-testid="media-embed"] iframe', "src"), /drive\.google\.com\/file\/d\/1AbCdEfGhIjKlMnOpQrStUvWxYz\/preview/, "a Drive share link becomes a preview iframe");
assert.match(await pv.textContent('[data-qid="q2"] [data-testid="media-embed"]'), /Anyone with the link/, "…with the sharing note");
const q2Html = await pv.innerHTML('[data-qid="q2"]');
assert.ok(!/src="javascript/i.test(q2Html) && !/href="javascript/i.test(q2Html), "a javascript: image URL is never emitted as a src");
assert.ok(await pv.$('[data-qid="q2"] [data-testid="media-unsupported"]'), "…it renders as an explicit unsupported note");
assert.ok(await pv.$('[data-qid="q2"] [data-testid="media-video"], [data-qid="q2"] [data-testid="media-broken"]'), "an mp4 in an image slot renders as a video");
// the CDN image with a query string is an <img> (or the graceful note once it 404s — never a broken icon)
assert.ok(await pv.$('[data-qid="q2"] img[data-media-provider="direct"], [data-qid="q2"] [data-testid="media-broken"]'));
assert.ok(await pv.$('[data-qid="q3"] [data-testid="media-unsupported"]'), "non-image data: URL is refused");
assert.equal(await pv.$$eval('[data-qid="q3"] iframe, [data-qid="q3"] script', (els) => els.length), 0);
await pv.close();
console.log("✔ media: YouTube / Drive / CDN image / mp4 / javascript: / data:text — one resolver, allow-listed embeds");

// Studio: the media input explains itself as you type
await openFirstQuestion();
assert.match(await page.textContent('.qcard.selected [data-testid="question-media-verdict"]'), /YouTube · embedded player/);
await page.fill('.qcard.selected [data-testid="question-media"]', "javascript:alert(1)");
assert.match(await page.textContent('.qcard.selected [data-testid="question-media-verdict"]'), /not allowed/);
await page.fill('.qcard.selected [data-testid="question-media"]', "https://drive.google.com/open?id=1AbCdEfGhIjKlMnOpQrStUvWxYz");
assert.match(await page.textContent('.qcard.selected [data-testid="question-media-verdict"]'), /Google Drive.*shared/);
console.log("✔ Studio media input reports the resolver's verdict live");

await h.close();
console.log("\nALL AUTO PUNCH / PREVIEW BLOCK / MEDIA CHECKS PASSED");

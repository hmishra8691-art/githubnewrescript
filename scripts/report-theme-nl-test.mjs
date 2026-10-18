/**
 * REPORT THEMES IN WORDS, END TO END (2026-10-18, docs/ARTIFACTS-AND-REPORT-THEMES-2026-10-18.md).
 *
 *   §1 Research tab: “Apply our premium corporate theme with navy headings, subtle cyan accents, and clean
 *      white backgrounds” → Preview (navy headings, a darkened cyan accent, white page; nothing applied yet)
 *      → Apply → Save as “Board Pack”
 *   §2 a format export carries the theme: the kept research plan (made BEFORE the theme) now says
 *      “New version available”; the new version's styles.xml declares Heading 1 in navy, its runs are navy,
 *      and its words are byte-identical to the version made before the theme
 *   §3 RELOAD → “Board Pack” is offered under Saved, and the copilot reuses it by name (“apply the Board Pack
 *      theme to the report”) → preview → Apply
 *   §4 the copilot: “Healthcare research presentation, restrained colors, clear statistical annotations”
 *      → preview → Apply; “Apply the Healthcare Analytics theme” → the next research plan carries #1D4E6B
 *      and the card names the theme; an unknown name is asked about; the ambiguous “premium corporate…”
 *      sentence (survey or report?) is asked about with two choices
 *   §5 structure only when asked: “keep the content but reorganize around the main hypotheses and
 *      recommendations” → a structure card (no colours) → Apply
 *
 *   node scripts/report-theme-nl-test.mjs      (studio on 3000, fake AI provider; build @rescript/analytics first)
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { chromium } from "./lib/playwright.mjs";
import { openTab, switchMode } from "./lib/nav.mjs";
import { checkDocx, unzipEntries } from "../packages/analytics/dist/export/index.js";

const STUDIO = process.env.STUDIO_URL ?? "http://localhost:3000";
let passed = 0;
const ok = (m) => { console.log("  ok  ", m); passed++; };
const opts = (...ls) => ls.map((l, i) => ({ code: i + 1, label: l }));
const FIXTURE = {
  meta: { id: "sandbox", code: "THEME26", title: "Theme study", version: "1.0" },
  research: { objective: "What drives trust in Brand A", hypotheses: ["Trust increases purchase intention", "Women trust Brand A more than men do"], analysis: [], assumptions: [], sources: [] },
  questions: [
    { id: "gender", code: "S2", variableName: "GENDER", type: "single_select", text: "Gender", options: opts("Male", "Female") },
    { id: "trust", code: "Q1", variableName: "TRUST", type: "single_select", text: "Brand A keeps its promises", options: opts("Disagree", "Neutral", "Agree") },
  ],
  flow: [{ type: "block", id: "b1", title: "Main", children: [{ type: "page", id: "p1", questionIds: ["gender", "trust"] }] }, { type: "end", id: "e", status: "complete" }],
};
const NAVY = "1B2A4A";

const browser = await chromium.launch();
const context = await browser.newContext({ viewport: { width: 1700, height: 1150 }, acceptDownloads: true });
const page = await context.newPage();
const errors = [];
page.on("pageerror", (e) => { if (!/ChunkLoadError|Loading chunk .* failed/.test(String(e))) errors.push(String(e)); });
page.on("dialog", (d) => d.accept());
await page.addInitScript((d) => { window.__rescriptSandboxSeed = d; }, FIXTURE);
let outputs = 0;
page.on("request", (r) => { if (r.method() === "POST" && /\/api\/copilot\/output$/.test(r.url())) outputs++; });

const DOCS = '[data-testid="research-documents"]';
const THEME = `${DOCS} [data-testid="report-theme"]`;
const turns = () => page.$$('[data-testid="cp-turn"]');
const intelligent = async () => { await openTab(page, "Questions"); await switchMode(page, "intelligent"); await page.waitForSelector('[data-testid="intelligent-view"]'); };
const say = async (text) => {
  const n = (await turns()).length;
  await page.fill('[data-testid="iq-input"]', text);
  await page.keyboard.press("Enter");
  await page.waitForFunction((k) => { const t = document.querySelectorAll('[data-testid="cp-turn"]'); return t.length > k && t[t.length - 1].getAttribute("data-status") !== "thinking"; }, n, { timeout: 60000 });
  await page.waitForTimeout(300);
  return (await turns()).at(-1);
};
const textOf = async (h) => (await h.evaluate((e) => e.innerText)).replace(/\s+/g, " ");
const docx = async (click) => {
  const [dl] = await Promise.all([page.waitForEvent("download", { timeout: 60000 }), click()]);
  const buf = readFileSync(await dl.path());
  assert.deepEqual(checkDocx(buf).problems, [], `a valid .docx (${dl.suggestedFilename()})`);
  const parts = unzipEntries(buf);
  const doc = parts.get("word/document.xml").toString("utf8");
  return { name: dl.suggestedFilename(), styles: parts.get("word/styles.xml").toString("utf8"), doc, words: [...doc.matchAll(/<w:t(?:\s[^>]*)?>([^<]*)<\/w:t>/g)].map((m) => m[1]) };
};
const heading1 = (styles) => /<w:style[^>]*w:styleId="Heading1"[\s\S]*?<\/w:style>/.exec(styles)?.[0] ?? "";

await page.goto(`${STUDIO}/sandbox?mode=studio`, { waitUntil: "networkidle" });
await page.waitForSelector(".menubar");

console.log("\n§0 a research plan made BEFORE any theme (the comparison for §2)");
await openTab(page, "Survey Settings");
await page.waitForSelector(`${DOCS} [data-testid="doc-research_plan_docx"]`);
const plain = await docx(() => page.click(`${DOCS} [data-testid="doc-research_plan_docx"]`));
/* the docx library always declares Heading 1 (its own default, blue 2E74B5); without a theme the runs carry the standard ink and nothing is navy */
assert.ok(!heading1(plain.styles).includes(`w:val="${NAVY}"`) && !plain.doc.includes(`w:color w:val="${NAVY}"`), "no theme: the standard look, nothing navy");
assert.ok(plain.doc.includes('w:color w:val="16202E"'), "no theme: the documents' standard ink");
ok("the standard research plan, v1");

console.log("\n§1 A SENTENCE → PREVIEW → APPLY → SAVE AS");
await page.fill(`${THEME} [data-testid="report-theme-text"]`, "Apply our premium corporate theme with navy headings, subtle cyan accents, and clean white backgrounds");
await page.click(`${THEME} [data-testid="report-theme-preview"]`);
const pv = await page.waitForSelector(`${THEME} [data-testid="theme-preview"]`);
assert.equal(await pv.getAttribute("data-heading"), `#${NAVY}`, "navy headings");
assert.notEqual(await pv.getAttribute("data-accent"), "#06B6D4", "the cyan accent is darkened for contrast");
assert.match(await page.$eval(`${THEME} [data-testid="report-theme-understood"]`, (e) => e.textContent), /navy headings.*cyan accents.*white backgrounds/);
assert.equal(await page.$(`${DOCS} [data-testid="doc-stale-research_plan_docx"]`), null, "a preview changes nothing");
await page.click(`${THEME} [data-testid="report-theme-apply"]`);
await page.waitForSelector(`${THEME} [data-testid="report-theme-applied"]`);
await page.fill(`${THEME} [data-testid="report-theme-name"]`, "Board Pack");
await page.click(`${THEME} [data-testid="report-theme-save"]`);
await page.waitForSelector(`${THEME} [data-testid="report-theme-saved"]`);
assert.match(await page.$eval(`${THEME} [data-testid="report-theme-saved"]`, (e) => e.textContent), /Saved “Board Pack” v1/);
ok("the sentence previews navy headings, a contrast-safe cyan accent and white backgrounds; Apply; saved as “Board Pack” v1");

console.log("\n§2 THE WORD FILE CARRIES IT — the look changes, the words do not");
await page.waitForSelector(`${DOCS} [data-testid="doc-stale-research_plan_docx"]`, { timeout: 10000 });
const before = outputs;
const themed = await docx(() => page.click(`${DOCS} [data-testid="doc-regenerate-research_plan_docx"]`));
assert.equal(outputs, before + 1, "the new version was made once");
assert.ok(heading1(themed.styles).includes(`w:val="${NAVY}"`), "styles.xml: Heading 1 in navy");
assert.ok(themed.doc.includes(`w:color w:val="${NAVY}"`), "document.xml: the heading runs are navy");
assert.deepEqual(themed.words, plain.words, "every word and number is byte-identical to the version made before the theme");
await page.waitForSelector(`${DOCS} [data-testid="doc-line-research_plan_docx"][data-version="2"][data-state="current"]`, { timeout: 10000 });
ok("“New version available” after the theme; the new version (v2) declares Heading 1 navy in styles.xml and colours its runs; its words equal v1's exactly");

console.log("\n§3 RELOAD → REUSE BY NAME");
/* a reload on the shared dev server may land on a recompile or a supervisor restart: retried, as in artifact-persistence-test */
for (let attempt = 1; ; attempt++) {
  await page.reload({ waitUntil: "domcontentloaded", timeout: 120000 }).catch(() => null);
  try { await page.waitForSelector(".menubar", { timeout: 60000 }); break; }
  catch (e) { if (attempt >= 3) throw e; await page.waitForTimeout(5000); }
}
await openTab(page, "Survey Settings");
await page.waitForSelector(`${THEME} [data-testid="report-theme-pick"]`);
const savedNames = await page.$$eval(`${THEME} [data-testid="report-theme-pick"] optgroup[label="Saved"] option`, (os) => os.map((o) => o.textContent));
assert.ok(savedNames.some((t) => /^Board Pack/.test(t)), `“Board Pack” offered after the reload: ${savedNames}`);
await intelligent();
let turn = await say("apply the Board Pack theme to the report");
let card = await turn.$('[data-testid="cp-theme"]');
assert.ok(card, "a theme card");
assert.equal(await card.getAttribute("data-intent"), "apply_named");
assert.equal(await (await card.$('[data-testid="theme-preview"]')).getAttribute("data-heading"), `#${NAVY}`);
await (await card.$('[data-testid="cp-theme-apply"]')).click();
await page.waitForSelector('[data-testid="cp-theme-applied"]');
ok("after a reload “Board Pack” is listed under Saved, and “apply the Board Pack theme to the report” finds it by name, previews it and applies it");

console.log("\n§4 THE COPILOT — a description, a built-in by name, an unknown name, an ambiguous look");
turn = await say("Healthcare research presentation, restrained colors, clear statistical annotations");
card = await turn.$('[data-testid="cp-theme"]');
assert.equal(await card.getAttribute("data-intent"), "create");
assert.match(await textOf(turn), /clear statistical annotations/);
assert.equal(await (await card.$('[data-testid="theme-preview"]')).getAttribute("data-heading"), "#1D4E6B");
turn = await say("Apply the Healthcare Analytics theme");
card = await turn.$('[data-testid="cp-theme"]');
assert.equal(await card.getAttribute("data-intent"), "apply_named");
await (await card.$('[data-testid="cp-theme-apply"]')).click();
await page.waitForSelector('[data-testid="cp-theme"][data-status="applied"][data-intent="apply_named"]');
turn = await say("prepare a Word research plan");
assert.match(await textOf(turn), /Theme: Healthcare Analytics\./);
const hc = await docx(() => turn.$eval('[data-testid="cp-output-download"]', (a) => a.click()));
assert.ok(heading1(hc.styles).includes('w:val="1D4E6B"'), "the research plan's Heading 1 is the Healthcare Analytics blue");
assert.deepEqual(hc.words, plain.words, "the same words again");
turn = await say("apply the Sparkles theme to the report");
assert.equal(await (await turn.$('[data-testid="cp-theme"]')).getAttribute("data-status"), "asked");
assert.match(await textOf(turn), /no theme called “Sparkles”/);
turn = await say("Apply our premium corporate theme with navy headings, subtle cyan accents, and clean white backgrounds");
assert.match(await textOf(turn), /report documents and decks, or to the survey itself/);
ok("a description previews (Healthcare blue, clear annotations); the built-in applies and the next plan carries #1D4E6B with the same words; an unknown name is asked about; the survey-or-report sentence is asked about");

console.log("\n§5 STRUCTURE ONLY WHEN ASKED");
turn = await say("Keep the content but reorganize around the main hypotheses and recommendations");
card = await turn.$('[data-testid="cp-theme"]');
assert.equal(await card.getAttribute("data-intent"), "structure");
assert.equal(await card.$('[data-testid="theme-preview"]'), null, "no colours in a structure request");
assert.match(await page.$eval('[data-testid="cp-theme-structure"]', (e) => e.textContent), /summary → hypotheses → recommendations/);
await (await card.$('[data-testid="cp-theme-apply"]')).click();
await page.waitForSelector('[data-testid="cp-theme"][data-status="applied"][data-intent="structure"]');
ok("“reorganize around the main hypotheses and recommendations” is a structure card (no colours), applied on its own");

assert.deepEqual(errors, [], `page errors: ${errors.join(" | ")}`);
await browser.close();
console.log(`\n${passed} checks passed`);

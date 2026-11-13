/**
 * THE PASTE ENGINE IN THE STUDIO (2026-11-17) — real paste events into the real fields of the sandbox.
 *
 *   QUESTION TEXT   Word HTML with its own list number, a plain numbered line with invisible characters, piping kept
 *   NOTES           "[RANDOMIZE] [ASK ONLY IF Q1 = 1] [INSERT LOGO]" leave the text: two become settings, one goes
 *                   to Notes for review, and the notice says which
 *   OPTIONS         a numbered / bulleted list pasted into an option label becomes clean options; "(SPECIFY)" and
 *                   "[EXCLUSIVE]" become flags; numbers that are content stay
 *   SEVERAL         a paste of three questions into an empty question fills it and adds two after it
 *   OTHER BOXES     a plain input loses invisible characters only — its numbering is content
 *
 *   node scripts/paste-engine-test.mjs      (Studio on :3000; set STUDIO_URL to override)
 * The cleaning rules themselves are proved in packages/engine pasteClean.test.ts; this proves the fields use them.
 */
import assert from "node:assert/strict";
import { chromium } from "./lib/playwright.mjs";
import { openTab } from "./lib/nav.mjs";

const STUDIO = process.env.STUDIO_URL ?? "http://localhost:3000";
let passed = 0;
const ok = (m) => { passed++; console.log(`  ok   ${m}`); };
const seed = {
  meta: { id: "sandbox", code: "SBX", title: "Paste", version: "1.0" },
  questions: [
    { id: "q1", code: "Q1", variableName: "Q1", type: "single_select", text: "Do you own a phone?", options: [{ code: 1, label: "Yes" }, { code: 2, label: "No" }], required: true },
    { id: "q2", code: "Q2", variableName: "Q2", type: "multi_select", text: "", options: [{ code: 1, label: "" }], required: false },
    { id: "q3", code: "Q3", variableName: "Q3", type: "single_select", text: "", options: [{ code: 1, label: "Option 1" }, { code: 2, label: "Option 2" }], required: false },
    { id: "q9", code: "Q9", variableName: "Q9", type: "open_text", text: "Anything else?" },
  ],
  flow: [{ type: "page", id: "p1", title: "Main", questionIds: ["q1", "q2", "q3", "q9"] }, { type: "end", id: "e", status: "complete" }],
  deployment: { clientSlug: "acme", studySlug: "paste", languages: ["en"], access: { mode: "open" } },
};
const browser = await chromium.launch();
const ctx = await browser.newContext({ viewport: { width: 1500, height: 950 } });
await ctx.addInitScript((s) => { window.__rescriptSandboxSeed = s; }, seed);
const page = await ctx.newPage();
const pageErrors = [];
page.on("pageerror", (e) => pageErrors.push(String(e)));
await page.goto(`${STUDIO}/sandbox?mode=studio`, { waitUntil: "domcontentloaded", timeout: 150000 });
await page.waitForSelector('[data-testid="qcard"]', { timeout: 120000 });

const readDef = async () => {
  await openTab(page, "JSON");
  await page.waitForSelector("textarea.code");
  const json = await page.$eval("textarea.code", (e) => e.value);
  await openTab(page, "Questions");
  await page.waitForSelector('[data-testid="qcard"]');
  return JSON.parse(json);
};
const card = (id) => `[data-testid="qcard"][data-qid="${id}"]`;
const select = async (id) => { if (!(await page.$(`${card(id)}.selected`))) await page.click(`${card(id)} [data-testid="qcard-toggle"]`); await page.waitForSelector(`${card(id)}.selected`); };
/** a real paste event, with the clipboard the source application would have filled */
const paste = async (locator, data, { click = true } = {}) => {
  if (click) await locator.click();
  await locator.evaluate((el, data) => {
    const dt = new DataTransfer();
    for (const [type, value] of Object.entries(data)) dt.setData(type, value);
    el.dispatchEvent(new ClipboardEvent("paste", { clipboardData: dt, bubbles: true, cancelable: true }));
  }, data);
  await page.waitForTimeout(350);
};
const plain = (html) => String(html ?? "").replace(/<[^>]+>/g, "").replace(/&nbsp;/g, " ").replace(/&amp;/g, "&").trim();
const blur = async (id) => { await page.click(`${card(id)} [data-testid="question-code"]`); await page.waitForTimeout(250); };
const closeNotice = async () => { if (await page.$('[data-testid="paste-notice-close"]')) await page.click('[data-testid="paste-notice-close"]'); };

console.log("\nQUESTION TEXT");
await select("q2");
const qtext = page.locator(`${card("q2")} .rte-surface`).first();
const WORD = `<html><body><!--StartFragment--><p class=MsoListParagraph style='text-indent:-18.0pt;mso-list:l0 level1 lfo1'><![if !supportLists]><span style='mso-list:Ignore'>3.<span style='font:7.0pt "Times New Roman"'>&nbsp;&nbsp;&nbsp;&nbsp; </span></span><![endif]>Which of these brands have you <b>bought</b> since {{Q1}}?&nbsp; [RANDOMIZE] [ASK ONLY IF Q1 = 1] [INSERT LOGO]<o:p></o:p></p><!--EndFragment--></body></html>`;
await paste(qtext, { "text/html": WORD, "text/plain": "3.\tWhich of these brands have you bought since {{Q1}}?  [RANDOMIZE] [ASK ONLY IF Q1 = 1] [INSERT LOGO]" });
await blur("q2");
let d = await readDef();
let q2 = d.questions.find((q) => q.id === "q2");
assert.equal(plain(q2.text), "Which of these brands have you bought since {{Q1}}?", `the stored text: ${q2.text}`);
assert.match(q2.text, /<(b|strong)>bought<\/(b|strong)>/, "bold survives");
ok("Word HTML: the list number, the non-breaking spaces and the three notes are gone from the text; bold and {{Q1}} are kept");
assert.deepEqual(q2.displayLogic, { type: "rule", source: { kind: "question", ref: "q1" }, operator: "selected", value: 1 });
assert.match(q2.notes ?? "", /\[from paste — review\] INSERT LOGO/);
await page.waitForSelector('[data-testid="paste-notice"]');
assert.match(await page.innerText('[data-testid="paste-notice-applied"]'), /Shown only when Q1 = 1/);
assert.match(await page.innerText('[data-testid="paste-notice-review"]'), /INSERT LOGO/);
ok("[ASK ONLY IF Q1 = 1] became the display logic; [INSERT LOGO] is in Notes for review; the notice says which is which");
await closeNotice();

console.log("\nOPTIONS");
await select("q2");
const opt = page.locator(`${card("q2")} [data-testid="option-label"]`).first();
await paste(opt, { "text/plain": "1. Apple\n2) Samsung​\n\tOnePlus 12\n- 18-24 edition\na) Other (SPECIFY)\n• None of these [EXCLUSIVE]\n[RANDOMIZE]" });
await blur("q2");
d = await readDef();
q2 = d.questions.find((q) => q.id === "q2");
assert.deepEqual(q2.options.map((o) => plain(o.label)), ["Apple", "Samsung", "OnePlus 12", "18-24 edition", "Other", "None of these"]);
assert.equal(new Set(q2.options.map((o) => String(o.code))).size, 6, "six distinct codes");
assert.ok((q2.options[4].flags ?? []).includes("other_specify"), "Other (SPECIFY) → specify");
assert.ok((q2.options[5].flags ?? []).includes("exclusive"), "[EXCLUSIVE] → exclusive");
assert.equal(q2.randomization?.enabled, true, "[RANDOMIZE] → randomized");
ok("a pasted list becomes six clean options: numbering, bullets and invisible characters removed, “OnePlus 12” and “18-24” intact");
ok("(SPECIFY), [EXCLUSIVE] and [RANDOMIZE] became the option flags and the question's randomization, not labels");
await closeNotice();
/* one line into one label */
await select("q1");
const yes = page.locator(`${card("q1")} [data-testid="option-label"]`).nth(1);
await yes.click(); await page.keyboard.press("Control+a"); await page.keyboard.press("Delete");
await paste(yes, { "text/plain": "b)  Not​ yet — maybe in 2026" });
await blur("q1");
d = await readDef();
assert.equal(plain(d.questions[0].options[1].label), "Not yet — maybe in 2026");
ok("a single line pasted into a label loses its “b)” and its invisible characters and keeps its dash and its year");

console.log("\nSEVERAL QUESTIONS AT ONCE");
await select("q3");
const q3text = page.locator(`${card("q3")} .rte-surface`).first();
await paste(q3text, { "text/plain": "1. Which brand do you use most?\na) Apple\nb) Samsung\nc) Other\n2. Why did you choose it?\n3. Would you recommend it? [MULTI RESPONSE]\n• Yes\n• No" });
await page.waitForSelector('[data-testid="paste-notice"]');
assert.match(await page.innerText('[data-testid="paste-notice"]'), /3 questions pasted/);
d = await readDef();
const ids = d.flow[0].questionIds;
assert.equal(ids.length, 6, "two questions were added");
assert.deepEqual(ids.slice(0, 3).concat(ids.slice(5)), ["q1", "q2", "q3", "q9"], "they sit after the question pasted into, before what followed");
const [a, b, c] = [ids[2], ids[3], ids[4]].map((id) => d.questions.find((q) => q.id === id));
assert.equal(plain(a.text), "Which brand do you use most?"); assert.deepEqual(a.options.map((o) => plain(o.label)), ["Apple", "Samsung", "Other"]);
assert.equal(plain(b.text), "Why did you choose it?"); assert.equal(b.type, "open_text");
assert.equal(plain(c.text), "Would you recommend it?"); assert.equal(c.type, "multi_select"); assert.deepEqual(c.options.map((o) => plain(o.label)), ["Yes", "No"]);
assert.equal(new Set(d.questions.map((q) => q.code)).size, d.questions.length, "every question has its own code");
ok("three questions pasted into an empty question: it is filled (with its options), two more follow in order — an open end and a multi-select");
await page.click('[data-testid="paste-notice-undo"]');
await page.waitForFunction(() => document.querySelectorAll('[data-testid="qcard"]').length === 4);
d = await readDef();
assert.deepEqual(d.flow[0].questionIds, ["q1", "q2", "q3", "q9"]);
assert.equal(plain(d.questions.find((q) => q.id === "q3").text), "");
ok("“Undo the paste” takes the whole paste back in one step");

console.log("\nOTHER TEXT BOXES");
await select("q9");
const code = page.locator(`${card("q9")} [data-testid="question-code"]`);
await code.click(); await page.keyboard.press("Control+a");
await paste(code, { "text/plain": "Q​9 B" }, { click: false });
assert.equal(await code.inputValue(), "Q9 B", "invisible characters removed, the rest as typed");
await code.click(); await page.keyboard.press("Control+a"); await page.keyboard.type("Q9"); await blur("q9");
await openTab(page, "JSON");
await page.waitForSelector("textarea.code");
await page.click('button:has-text("edit")');
const ta = page.locator("textarea.code");
await ta.click(); await page.keyboard.press("Control+a");
await paste(ta, { "text/plain": "1. keep​ this\n2) and {{Q1}} too [RANDOMIZE]" }, { click: false });
assert.equal(await ta.inputValue(), "1. keep this\n2) and {{Q1}} too [RANDOMIZE]", "a code box keeps numbering and notes");
ok("a plain input and a code box lose invisible characters only: their numbering, brackets and piping are content");

await browser.close();
assert.deepEqual(pageErrors, [], "no page errors");
console.log(`\nPASTE ENGINE: ${passed} checks passed`);

/**
 * TRANSLATION INTELLIGENCE (research-intelligence Phase 3).
 *
 *   - the copilot's language actions, through the fake provider: a language
 *     is added, a block is translated, the glossary is set — as one proposal
 *     in Changes; an entry that drops the piping is refused by reason and
 *     the rest is written; Apply writes the real localization
 *   - Intelligent → Languages: the language's completion, the missing count,
 *     and "Approve" as a proposal that locks the translations
 *   - editing a translated question's text in Studio marks its translation
 *     OUTDATED; a copilot change to that text warns in Changes and offers
 *     the re-translation in the same proposal; "Confirm they still fit"
 *     clears the flag through Changes
 *   - routing: a country map and a fallback by action; the Localization
 *     panel and the runtime's language resolution reflect it
 *   - the review reports the missing and outdated translations
 *
 *   node scripts/translation-copilot-test.mjs      (studio on 3000)
 */
import assert from "node:assert/strict";
import { chromium } from "/home/claude/.npm-global/lib/node_modules/playwright/index.mjs";
import { openTab, switchMode } from "./lib/nav.mjs";

const STUDIO = process.env.STUDIO_URL ?? "http://localhost:3000";
let passed = 0;
const ok = (m) => { console.log("  ok  ", m); passed++; };
const opts = (...ls) => ls.map((l, i) => ({ code: i + 1, label: l }));

const FIXTURE = {
  meta: { id: "sandbox", code: "SANDBOX", title: "Brand A tracker", version: "1.0" },
  questions: [
    { id: "country", code: "S1", variableName: "COUNTRY", type: "single_select", text: "Which country do you live in?", options: opts("United States", "Mexico", "Germany") },
    { id: "freq", code: "Q1", variableName: "FREQ", type: "single_select", text: "How often do you buy Brand A?", options: opts("Weekly", "Monthly", "Rarely") },
    { id: "sat", code: "Q2", variableName: "SAT", type: "single_select", text: "How satisfied are you with Brand A?", options: opts("Very satisfied", "Satisfied", "Not satisfied") },
    { id: "why", code: "Q3", variableName: "WHY", type: "long_text", text: "Why do you say that about {{FREQ}}?" },
  ],
  flow: [
    { type: "block", id: "b0", title: "Screening", children: [{ type: "page", id: "p0", questionIds: ["country"] }] },
    { type: "block", id: "b1", title: "Brand", children: [{ type: "page", id: "p1", questionIds: ["freq", "sat", "why"] }] },
    { type: "end", id: "e", status: "complete", message: "Thank you!" },
  ],
};

const browser = await chromium.launch();
const context = await browser.newContext({ viewport: { width: 1700, height: 1100 } });
const page = await context.newPage();
const errors = [];
page.on("pageerror", (e) => errors.push(String(e)));
page.on("dialog", (d) => d.accept());

const loadDef = async (def) => {
  await openTab(page, "JSON");
  await page.waitForSelector("textarea.code");
  await page.click('button:has-text("edit")');
  await page.$eval("textarea.code", (el, v) => { Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value").set.call(el, v); el.dispatchEvent(new Event("input", { bubbles: true })); }, JSON.stringify(def));
  await page.click('button:has-text("validate & apply")');
  await page.waitForTimeout(600);
};
const readDef = async () => {
  await openTab(page, "JSON");
  await page.waitForSelector("textarea.code");
  return JSON.parse(await page.$eval("textarea.code", (e) => e.value));
};
const texts = (sel) => page.$$eval(sel, (els) => els.map((e) => e.textContent.replace(/\s+/g, " ").trim()));
const intelligent = async () => {
  await openTab(page, "Questions");
  await switchMode(page, "intelligent");
  await page.waitForSelector('[data-testid="intelligent-view"]');
};
/** one copilot turn through the fake provider: the reply the model would give, the message typed */
const turn = async (reply, message) => {
  await page.evaluate((r) => window.__rescriptCopilotFake(r), reply);
  const n = (await page.$$('[data-testid="cp-turn"]')).length;
  await page.fill('[data-testid="iq-input"]', message);
  await page.keyboard.press("Enter");
  await page.waitForFunction((k) => { const t = document.querySelectorAll('[data-testid="cp-turn"]'); return t.length > k && t[t.length - 1].getAttribute("data-status") !== "thinking"; }, n, { timeout: 30000 });
  await page.click('[data-testid="cp-tab-changes"]');
  await page.waitForSelector('[data-testid="cp-changes"]');
};
const apply = async () => { await page.click('[data-testid="cp-panel-apply"]'); await page.waitForTimeout(600); };
const tr = (def, lang, key) => def.localization?.translations?.[lang]?.[key];

await page.goto(`${STUDIO}/sandbox?mode=studio`, { waitUntil: "networkidle" });
await page.waitForSelector(".menubar");
await loadDef(FIXTURE);
ok("fixture loaded: an English survey with a Brand block, a piped question and an end message");

await intelligent();
const fake = await page.evaluate(() => typeof window.__rescriptCopilotFake === "function");
if (!fake) { console.log("  skip  no fake copilot provider in this build"); await browser.close(); process.exit(0); }

/* ------------------------------------------------ add a language + translate a block, with one refused entry */
await turn({
  kind: "proposal", reply: "I'll add German, keep “Brand A” untranslated, and translate the Brand block.",
  actions: [
    { op: "add_language", code: "de" },
    { op: "set_glossary", entries: [{ source: "Brand A", doNotTranslate: true }] },
    { op: "set_translations", language: "de", entries: [
      { target: "Q1", text: "Wie oft kaufen Sie Brand A?" },
      { target: "Q1.option:1", text: "Wöchentlich" }, { target: "Q1.option:2", text: "Monatlich" }, { target: "Q1.option:Rarely", text: "Selten" },
      { target: "Q2", text: "Wie zufrieden sind Sie mit Brand A?" },
      { target: "Q2.option:1", text: "Sehr zufrieden" }, { target: "Q2.option:2", text: "Zufrieden" }, { target: "Q2.option:3", text: "Nicht zufrieden" },
      { target: "Q3", text: "Warum sagen Sie das?" },
      { target: "end:complete", text: "Vielen Dank!" },
      { target: "Q9", text: "nichts" },
    ] },
  ],
}, "Translate the Brand block into German; never translate the brand name");
{
  const sm = await texts('[data-testid="cp-summary"] li');
  assert.ok(sm.some((t) => /Add Deutsch as a language/.test(t)), sm.join(" | "));
  assert.ok(sm.some((t) => /Translate 9 elements into Deutsch/.test(t)), sm.join(" | "));
  assert.ok(sm.some((t) => /Add 1 glossary term/.test(t)), sm.join(" | "));
  const problems = await page.textContent('[data-testid="cp-new-problems"]');
  assert.match(problems, /Not translated — Q3 · text: the piping \/ placeholders must be kept exactly/, problems);
  assert.match(problems, /Not translated — Q9: not a translatable element/, problems);
  assert.equal(await page.$('[data-testid="cp-destructive"]'), null, "adding a language and translations is not destructive");
}
await apply();
let def = await readDef();
assert.equal(def.localization.languages[0].code, "de");
assert.equal(def.localization.languages[0].locale, "de-DE", "the locale comes from the library");
assert.equal(def.localization.languages[0].status, "draft");
assert.equal(tr(def, "de", "q:freq:text").text, "Wie oft kaufen Sie Brand A?");
assert.equal(tr(def, "de", "q:freq:text").status, "ai");
assert.equal(tr(def, "de", "q:freq:opt:3").text, "Selten", "an option named by its label");
assert.equal(tr(def, "de", "flow:e:message").text, "Vielen Dank!");
assert.equal(tr(def, "de", "q:why:text"), undefined, "the entry that dropped the pipe was not written");
assert.deepEqual(def.localization.glossary.map((g) => [g.source, g.doNotTranslate]), [["Brand A", true]]);
assert.ok(def.deployment.languages.includes("de"), "the deployment offers the language");
ok("copilot: add_language + set_glossary + set_translations as one proposal; a dropped pipe and an unknown target are refused by reason, the rest is written");

/* ------------------------------------------------ Intelligent → Languages */
await intelligent();
await page.click('[data-testid="cp-tab-languages"]');
await page.waitForSelector('[data-testid="cp-languages"]');
{
  const card = await page.$('[data-testid="lg-language"][data-code="de"]');
  assert.ok(card, "the German card");
  const counts = await card.$eval('[data-testid="lg-counts"]', (e) => e.textContent);
  assert.match(counts, /9 of \d+ needed elements translated · 0 approved · 9 awaiting review · \d+ missing/, counts);
  assert.ok(await card.$('[data-testid="lg-translate-missing"]'), "the missing ones can be requested");
  assert.equal(await card.$('[data-testid="lg-retranslate"]'), null, "nothing outdated yet");
  await (await card.$('[data-testid="lg-approve"]')).click();
  await page.waitForSelector('[data-testid="cp-changes"]');
  const sm = await texts('[data-testid="cp-summary"] li');
  assert.ok(sm.some((t) => /Approve 9 Deutsch translations/.test(t)), sm.join(" | "));
  await apply();
  def = await readDef();
  assert.equal(tr(def, "de", "q:freq:text").status, "approved");
  assert.equal(tr(def, "de", "q:sat:opt:2").status, "approved");
}
ok("Intelligent → Languages: completion and counts per language; Approve is a proposal that locks the translations");

/* ------------------------------------------------ an approved translation is kept unless asked to overwrite */
await intelligent();
await turn({ kind: "proposal", reply: "Rewording the German.", actions: [{ op: "set_translations", language: "de", entries: [{ target: "Q1", text: "Wie häufig kaufen Sie Brand A?" }] }] }, "Reword Q1 in German");
{
  const body = await page.textContent('[data-testid="cp-changes"]');
  assert.ok(await page.$('[data-testid="cp-panel-apply"][disabled]') || /Nothing to apply|approved translation kept/.test(body), "an approved translation is kept, so there is nothing to write");
  await page.click('[data-testid="cp-panel-cancel"]');
}
await intelligent();
await turn({ kind: "proposal", reply: "Overwriting the approved German.", actions: [{ op: "set_translations", language: "de", overwriteApproved: true, entries: [{ target: "Q1", text: "Wie häufig kaufen Sie Brand A?" }] }] }, "Overwrite the approved German for Q1");
{
  const sm = await texts('[data-testid="cp-summary"] li');
  assert.ok(sm.some((t) => /Translate 1 element into Deutsch/.test(t)), sm.join(" | "));
  await apply();
  def = await readDef();
  assert.equal(tr(def, "de", "q:freq:text").text, "Wie häufig kaufen Sie Brand A?");
  assert.equal(tr(def, "de", "q:freq:text").status, "ai", "overwritten: back to machine translation, to be reviewed again");
}
ok("an approved translation is kept against a plain set_translations and overwritten only with overwriteApproved");

/* ------------------------------------------------ a source edit by the copilot → outdated, with the re-translate offer */
await intelligent();
await turn({ kind: "proposal", reply: "Rewording Q2.", actions: [{ op: "update_question", target: "Q2", text: "Overall, how satisfied are you with Brand A?" }] }, "Reword Q2 to start with Overall");
{
  const problems = await page.textContent('[data-testid="cp-new-problems"]');
  assert.match(problems, /1 translation is now outdated \(de\)/, problems);
  assert.ok(await page.$('[data-testid="cp-retranslate"]'), "the re-translation is offered in the same proposal");
  // the offer is a copilot turn: the fake answers it with the re-translation, chained onto the proposal
  await page.evaluate((r) => window.__rescriptCopilotFake(r), { kind: "proposal", reply: "Re-translated.", actions: [{ op: "set_translations", language: "de", overwriteApproved: true, entries: [{ target: "Q2", text: "Wie zufrieden sind Sie insgesamt mit Brand A?" }] }] });
  const n = (await page.$$('[data-testid="cp-turn"]')).length;
  await page.click('[data-testid="cp-retranslate"]');
  await page.waitForFunction((k) => { const t = document.querySelectorAll('[data-testid="cp-turn"]'); return t.length > k && t[t.length - 1].getAttribute("data-status") !== "thinking"; }, n, { timeout: 30000 });
  await page.click('[data-testid="cp-tab-changes"]');
  await page.waitForSelector('[data-testid="cp-changes"]');
  const sm = await texts('[data-testid="cp-summary"] li');
  assert.ok(sm.some((t) => /Change Q2: wording/.test(t)) && sm.some((t) => /Translate 1 element into Deutsch/.test(t)), sm.join(" | "));
  assert.equal(await page.$('[data-testid="cp-outdated-note"]'), null, "re-translated in the same proposal: nothing is outdated any more");
  await apply();
  def = await readDef();
  assert.equal(def.questions.find((x) => x.id === "sat").text, "Overall, how satisfied are you with Brand A?");
  assert.equal(tr(def, "de", "q:sat:text").text, "Wie zufrieden sind Sie insgesamt mit Brand A?");
  assert.equal(tr(def, "de", "q:sat:text").status, "ai");
}
ok("a copilot edit to translated text warns that the translation is outdated and re-translates it in the same proposal");

/* ------------------------------------------------ a source edit in Studio → outdated; Confirm through Changes */
def.questions.find((x) => x.id === "freq").text = "How often do you buy Brand A products?";
await loadDef(def);
await intelligent();
await page.click('[data-testid="cp-tab-languages"]');
await page.waitForSelector('[data-testid="cp-languages"]');
{
  const card = await page.$('[data-testid="lg-language"][data-code="de"]');
  const counts = await card.$eval('[data-testid="lg-counts"]', (e) => e.textContent);
  assert.match(counts, /1 outdated/, counts);
  assert.match(await card.$eval('[data-testid="lg-outdated"]', (e) => e.textContent), /Q1 · text/);
  await (await card.$('[data-testid="lg-confirm"]')).click();
  await page.waitForSelector('[data-testid="cp-changes"]');
  const sm = await texts('[data-testid="cp-summary"] li');
  assert.ok(sm.some((t) => /Confirm 1 outdated Deutsch translation/.test(t)), sm.join(" | "));
  await apply();
  def = await readDef();
  const t = tr(def, "de", "q:freq:text");
  assert.equal(t.status, "edited", "confirmed: the translation stands against the new source, as a human decision");
  assert.equal(t.text, "Wie häufig kaufen Sie Brand A?");
}
await intelligent();
await page.click('[data-testid="cp-tab-languages"]');
await page.waitForSelector('[data-testid="cp-languages"]');
assert.equal(await page.$('[data-testid="lg-outdated"]'), null, "nothing outdated after the confirmation");
ok("a source edit in Studio marks the translation outdated; Confirm through Changes keeps it against the new source");

/* ------------------------------------------------ routing by action */
await intelligent();
await turn({ kind: "proposal", reply: "German for Germany, English otherwise.", actions: [{ op: "set_language_routing", countryMap: { DE: "de", US: "en", MX: "en" }, urlParam: "language", fallback: "en", allowSwitch: true }] }, "German respondents get German, everyone else English; the URL parameter is language");
{
  const sm = await texts('[data-testid="cp-summary"] li');
  assert.ok(sm.some((t) => /Change the language routing/.test(t)), sm.join(" | "));
  const problems = (await page.$('[data-testid="cp-new-problems"]')) ? await page.textContent('[data-testid="cp-new-problems"]') : "";
  assert.match(problems, /Country routing was added to the precedence order, before browser detection/, `the country step is put into the routing order, and said so: ${problems}`);
  await apply();
  def = await readDef();
  assert.deepEqual(def.localization.routing.countryMap, { DE: "de", US: "en", MX: "en" });
  assert.equal(def.localization.routing.urlParam, "language");
  assert.equal(def.localization.routing.fallback, "en");
  assert.ok(def.localization.routing.order.indexOf("country") < def.localization.routing.order.indexOf("browser"));
}
await intelligent();
await page.click('[data-testid="cp-tab-languages"]');
await page.waitForSelector('[data-testid="lg-routing"]');
assert.match(await page.textContent('[data-testid="lg-routing"]'), /DE → Deutsch, US → English, MX → English/);
ok("routing: a country map, URL parameter and fallback by action; the country step joins the order ahead of the browser");

/* ------------------------------------------------ the Localization panel sees the same language */
await switchMode(page, "studio");
await openTab(page, "Translation");
await page.waitForSelector('[data-testid="localization-panel"]');
assert.ok(await page.$('[data-testid="loc-card-de"]'), "the Localization panel lists the language the copilot added");
{
  const c = Number(await page.getAttribute('[data-testid="loc-card-de"]', "data-completion"));
  assert.ok(c > 0 && c < 100, `partly translated: ${c}%`);
}
ok("the Localization panel shows the copilot's language — one localization, not two");

/* ------------------------------------------------ the review reports the languages */
await intelligent();
await page.click('[data-testid="cp-tab-review"]');
await page.click('[data-testid="cp-run-review"]');
await page.waitForTimeout(800);
{
  const review = await page.textContent('[data-testid="cp-panel"]');
  assert.match(review, /Deutsch: \d+ elements have no translation \(\d+% complete\)/, review.slice(0, 600));
}
ok("the review reports what the German version still lacks");

/* ------------------------------------------------ the route: a translation turn is recognised and gets the languages in its outline */
{
  const call = async (message) => {
    const r = await fetch(`${STUDIO}/api/copilot/turn`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ surveyId: "sandbox", message, definition: def, fake: { kind: "answer", reply: "ok" } }) });
    assert.equal(r.status, 200);
    return (await r.json()).context;
  };
  const t = await call("Translate the Brand block into German");
  const plain = await call("Reword the Brand block");
  assert.equal(t.translation, true); assert.equal(plain.translation, false);
  assert.ok(t.outlineChars > plain.outlineChars + 200, `the translation turn's outline carries the languages and the elements with their translations: ${t.outlineChars} vs ${plain.outlineChars}`);
  assert.ok(t.promptChars - t.outlineChars > plain.promptChars - plain.outlineChars + 1500, `and the prompt carries the guide beyond the outline: ${t.promptChars - t.outlineChars} vs ${plain.promptChars - plain.outlineChars}`);
}
ok("the turn route recognises a translation request and sends the languages with it");

assert.deepEqual(errors.filter((e) => !/ResizeObserver/.test(e)), [], errors.join("\n"));
await browser.close();
console.log(`\n${passed} checks passed`);

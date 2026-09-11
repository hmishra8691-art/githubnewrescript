/**
 * TRANSLATION & LOCALIZATION — a layer over the survey, end to end.
 *
 *   Studio → Translation: add languages (country → language → locale) from the
 *   library; Translate all (AI, fake provider) with progress; edit, approve,
 *   history; glossary applied; QA blocks "live" while a placeholder is broken;
 *   audio — external URL, AI voice generated + approved, outdated after a
 *   translation change; export CSV / import JSON
 *       ↓
 *   Runtime: ?lang=es serves Spanish — texts, options, buttons, validation;
 *   SURVEY_LANGUAGE stored; the respondent switches to Hindi mid-survey and
 *   keeps position and answers; Arabic is RTL; the Hindi audio button appears
 *   only where Hindi audio exists; the end message is translated with piping
 *   resolved — and the question ids, codes and flow never changed.
 *
 * Needs both servers with AI_API_URL=fake: (verify-browser does this).
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { openHarness, assert } from "./lib/variantHarness.mjs";
import { sendPreview } from "./lib/preview.mjs";

const RUNTIME = process.env.RUNTIME_URL ?? "http://localhost:3001";
const STUDIO = process.env.STUDIO_URL ?? "http://localhost:3000";
const h = await openHarness();
const page = h.page;
/** the Translation tab, on one of its views — readDef leaves the tab, so every section re-enters */
const toView = async (view) => { await h.goTab("Translation"); await page.waitForSelector('[data-testid="localization-panel"]'); await page.click(`[data-testid="loc-view-${view}"]`); await page.waitForTimeout(150); };

{
  const r = await fetch(`${STUDIO}/api/ai/translate`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ items: [{ key: "k", text: "Yes" }], targetLanguage: "es" }) });
  assert.equal(r.status, 200, `Studio must be started with AI_API_URL=fake: — got ${r.status}`);
}

const survey = () => ({
  meta: { id: "sandbox", code: "LOC", title: "Customer Satisfaction at Miures", version: "1.0" },
  questions: [
    { id: "q1", code: "Q1", variableName: "Q1", type: "single_select", text: "How was your visit to Miures?", required: true,
      options: [{ code: 1, label: "Great" }, { code: 2, label: "Fine" }, { code: 3, label: "Poor" }, { code: 99, label: "Other", flags: ["other_specify"] }] },
    { id: "q2", code: "Q2", variableName: "Q2", type: "long_text", text: "Why do you say {{Q1}}?" },
    { id: "q3", code: "Q3", variableName: "Q3", type: "numeric", text: "How many visits this year?", settings: { minValue: 0, maxValue: 50 } },
  ],
  flow: [
    { type: "page", id: "p1", title: "Your visit", questionIds: ["q1", "q2"] },
    { type: "page", id: "p2", questionIds: ["q3"] },
    { type: "end", id: "e1", status: "complete", message: "Thank you — you said {{Q1}}." },
  ],
});

console.log("\nSTUDIO — Languages: pick from the library by country, with a locale each");
await h.loadDef(survey());
await h.goTab("Translation");
await page.waitForSelector('[data-testid="localization-panel"]');
assert.ok(await page.$('[data-testid="loc-card-en"]'), "the source language card");
await page.click('[data-testid="loc-add-languages"]');
await page.fill('[data-testid="loc-lang-search"]', "india");
const indiaLangs = await page.$$eval('[data-testid^="loc-pick-"]:not([data-testid*="locale"])', (els) => els.map((e) => e.getAttribute("data-testid").replace("loc-pick-", "")));
assert.ok(indiaLangs.includes("hi") && indiaLangs.includes("gu") && indiaLangs.includes("mr") && indiaLangs.includes("ta"), `searching a country lists its languages: ${indiaLangs.join(",")}`);
await page.click('[data-testid="loc-pick-hi"] input');
await page.fill('[data-testid="loc-lang-search"]', "spanish");
await page.click('[data-testid="loc-pick-es"] input');
await page.selectOption('[data-testid="loc-pick-locale-es"]', "es-MX");
await page.fill('[data-testid="loc-lang-search"]', "arabic");
await page.click('[data-testid="loc-pick-ar"] input');
await page.click('[data-testid="loc-add-confirm"]');
await page.waitForSelector('[data-testid="loc-card-hi"]');
assert.ok(await page.$('[data-testid="loc-card-es"]') && await page.$('[data-testid="loc-card-ar"]'));
assert.equal(await page.getAttribute('[data-testid="loc-card-hi"]', "data-completion"), "0");
assert.equal(await page.inputValue('[data-testid="loc-locale-es"]'), "es-MX", "Mexico → Spanish kept its locale");
let def = await h.readDef();
assert.deepEqual(def.localization.languages.map((l) => [l.code, l.locale]), [["hi", "hi-IN"], ["es", "es-MX"], ["ar", "ar-SA"]]);
assert.equal(def.questions.length, 3, "no question changed");
console.log("  ok   hi (India), es (Mexico), ar added as drafts; the definition's questions are untouched");

console.log("\nSTUDIO — Translate all: AI in batches with progress; statuses, edit, approve, history; piping kept");
await h.goTab("Translation");
await page.click('[data-testid="loc-view-translate"]');
await page.waitForSelector('[data-testid="loc-table"]');
// show all three columns
for (const l of ["hi", "es", "ar"]) if (!(await page.isChecked(`[data-testid="loc-col-${l}"]`))) await page.click(`[data-testid="loc-col-${l}"]`);
await page.click('[data-testid="loc-translate-all"]');
await page.waitForFunction(() => { const chips = [...document.querySelectorAll('[data-testid^="loc-progress-"]')]; return chips.length === 3 && chips.every((c) => /100%|up to date/.test(c.textContent)); }, null, { timeout: 60000 });
await page.waitForTimeout(300);
def = await h.readDef();
const es = def.localization.translations.es, hi = def.localization.translations.hi;
assert.equal(es["q:q1:opt:1"].text, "Excelente", "the (fake) provider translated Great");
assert.equal(es["q:q1:opt:1"].status, "ai");
assert.equal(es["q:q1:opt:1"].origin, "ai");
assert.equal(hi["q:q1:opt:1"].text, "बहुत अच्छा");
assert.equal(es["q:q2:text"].text, "[es] Why do you say {{Q1}}?", "piping token preserved");
assert.equal(es["branding:buttons:next"].text, "Siguiente", "button labels translated");
assert.equal(es["ui:required"].text, "Esta pregunta es obligatoria.", "interface strings translated");
assert.equal(es["q:q1:text"].text, "[es] How was your visit to Miures?");
await toView("translate");
await page.waitForSelector('[data-testid="loc-table"]');
for (const l of ["hi", "es", "ar"]) if (!(await page.isChecked(`[data-testid="loc-col-${l}"]`))) await page.click(`[data-testid="loc-col-${l}"]`);
const rowCount = (await page.$$('[data-testid="loc-row"]')).length;
assert.ok(rowCount > 30, `every element has a row (${rowCount})`);
// edit hi Poor by hand, approve, edit again → history. The wording carries a per-run suffix: an approved wording is
// remembered by the server's translation memory, so the next run's "Translate all" would already return it and a
// same-text edit is (correctly) a no-op.
const RUN = Date.now().toString(36).slice(-4);
await page.selectOption('[data-testid="loc-filter-question"]', "q1");
const poorRow = page.locator('[data-testid="loc-row"][data-key="q:q1:opt:3"]');
await poorRow.locator('[data-testid="loc-input-hi"]').fill(`बुरा ${RUN}`);
await page.waitForTimeout(200);
assert.equal(await poorRow.locator('[data-testid="loc-status-hi"]').textContent(), "Manually edited");
await poorRow.locator('[data-testid="loc-approve-hi"]').click();
assert.equal(await poorRow.locator('[data-testid="loc-status-hi"]').textContent(), "Approved");
await poorRow.locator('[data-testid="loc-input-hi"]').fill("ख़राब");
await page.waitForTimeout(200);
assert.equal(await poorRow.locator('[data-testid="loc-status-hi"]').textContent(), "Manually edited", "an edit to an approved text drops the approval");
await poorRow.locator('[data-testid="loc-history-hi"]').click();
assert.match(await page.textContent('[data-testid="loc-history"]'), new RegExp(`बुरा ${RUN}`), "the previous version is kept");
def = await h.readDef();
assert.equal(def.localization.translations.hi["q:q1:opt:3"].version, 3);
assert.equal(def.localization.translations.hi["q:q1:opt:3"].history[0].text, `बुरा ${RUN}`);
console.log("  ok   3 languages translated; statuses AI → edited → approved → edited; history v3 with previous text");

console.log("\nSTUDIO — Provider settings: which provider is connected, never the key; cache backend");
await toView("settings");
await page.waitForSelector('[data-testid="loc-provider-card"][data-connected="1"]');
assert.equal(await page.getAttribute('[data-testid="loc-provider-card"]', "data-provider"), "fake", "the fake provider is what this Studio has (AI_API_URL=fake:)");
assert.equal(await page.textContent('[data-testid="loc-provider-connected"]'), "Connected");
await page.click('[data-testid="loc-provider-test"]');
await page.waitForSelector('[data-testid="loc-provider-probe"]');
assert.match(await page.textContent('[data-testid="loc-provider-probe"]'), /Connected — \d+ languages available/);
assert.ok(!/sk-|key=|AIza/.test(await page.textContent('[data-testid="loc-settings"]')), "no credential anywhere on the page");
{
  const st = await (await fetch(`${STUDIO}/api/translation/status`)).json();
  assert.equal(st.provider.id, "fake");
  assert.ok(!JSON.stringify(st).match(/AIza|sk-ant|api_key|apiKey/i), "the status route carries no secret");
}
console.log("  ok   provider card: fake · Connected · test connection; nothing secret");

console.log("\nSTUDIO — Translation memory: the same source text already reviewed is reused without the provider; an edited source becomes OUTDATED, re-translate clears it");
// Q2's Spanish "Other"-like reuse: add a question whose option repeats an approved source
await toView("translate");
if (!(await page.isChecked('[data-testid="loc-col-es"]'))) await page.click('[data-testid="loc-col-es"]');
await page.selectOption('[data-testid="loc-filter-question"]', "q1");
await page.locator('[data-testid="loc-row"][data-key="q:q1:opt:1"] [data-testid="loc-approve-es"]').click();
await page.waitForTimeout(150);
// a new question that says "Great" again
await h.setQuestion("q3", (q, d) => { d.questions.push({ id: "q4", code: "Q4", variableName: "Q4", type: "single_select", text: "Overall?", options: [{ code: 1, label: "Great" }, { code: 2, label: "Awful" }] }); d.flow[1].questionIds.push("q4"); });
await toView("translate");
if (!(await page.isChecked('[data-testid="loc-col-es"]'))) await page.click('[data-testid="loc-col-es"]');
await page.selectOption('[data-testid="loc-filter-question"]', "q4");
await page.waitForSelector('[data-testid="loc-row"][data-key="q:q4:opt:1"]');
await page.click('[data-testid="loc-translate-all"]');
await page.waitForFunction(() => [...document.querySelectorAll('[data-testid^="loc-progress-"]')].every((c) => /100%|up to date/.test(c.textContent)), null, { timeout: 60000 });
await page.waitForTimeout(200);
def = await h.readDef();
assert.equal(def.localization.translations.es["q:q4:opt:1"].text, "Excelente");
assert.equal(def.localization.translations.es["q:q4:opt:1"].origin, "memory", "the approved wording of Q1's 'Great' was reused for Q4 without asking the provider");
assert.equal(def.localization.translations.es["q:q4:opt:2"].origin, "ai", "the new string went to the provider");
// the source of Q1 changes → its translations are OUTDATED, kept and shown
await h.setQuestion("q1", (q) => { q.text = "How was your latest visit to Miures?"; });
await toView("translate");
await page.waitForTimeout(300);
def = await h.readDef();
assert.equal(def.localization.translations.es["q:q1:text"].status, "outdated");
assert.equal(def.localization.translations.hi["q:q1:text"].status, "outdated");
assert.equal(def.localization.translations.es["q:q1:text"].text, "[es] How was your visit to Miures?", "the old translation is kept, not deleted");
assert.equal(def.localization.translations.es["q:q1:opt:1"].status, "approved", "an approved option is untouched — only the edited element is outdated");
await toView("qa");
await page.waitForSelector('[data-testid="qa-es"]');
assert.ok(await page.$('[data-testid="qa-es"] [data-testid="qa-issue"][data-kind="stale_source"][data-blocking="1"]'), "QA lists the outdated element as blocking");
await toView("translate");
for (const l of ["hi", "es", "ar"]) if (!(await page.isChecked(`[data-testid="loc-col-${l}"]`))) await page.click(`[data-testid="loc-col-${l}"]`);
assert.match(await page.textContent('[data-testid="loc-retranslate-outdated"]'), /Re-translate outdated \(1\)/);
await page.click('[data-testid="loc-retranslate-outdated"]');
await page.waitForFunction(() => [...document.querySelectorAll('[data-testid^="loc-progress-"]')].every((c) => /100%|up to date/.test(c.textContent)), null, { timeout: 60000 });
await page.waitForTimeout(200);
def = await h.readDef();
assert.equal(def.localization.translations.es["q:q1:text"].status, "ai");
assert.equal(def.localization.translations.es["q:q1:text"].text, "[es] How was your latest visit to Miures?");
assert.equal(def.localization.translations.es["q:q1:text"].history[0].text, "[es] How was your visit to Miures?", "the outdated version is in the history");
console.log("  ok   memory reuse (origin: memory); source edit → OUTDATED (kept); QA blocks; Re-translate outdated → fresh machine translation with history");

console.log("\nSTUDIO — Glossary: a do-not-translate brand and a preferred term, enforced on existing translations");
await toView("glossary");
await page.fill('[data-testid="gl-source"]', "Miures");
await page.click('[data-testid="gl-add"]');
await page.locator('[data-testid="gl-row"][data-source="Miures"] [data-testid="gl-dnt"]').click();
await page.fill('[data-testid="gl-source"]', "visit");
await page.click('[data-testid="gl-add"]');
await page.locator('[data-testid="gl-row"][data-source="visit"] [data-testid="gl-target-hi"]').fill("यात्रा");
await page.click('[data-testid="gl-apply"]');
await page.waitForSelector('[data-testid="gl-note"]');
def = await h.readDef();
assert.equal(def.localization.translations.hi["q:q1:text"].text, "[hi] How was your latest यात्रा to Miures?", "the preferred term replaced the word; the brand stayed");
assert.equal(def.localization.translations.hi["q:q1:text"].origin, "glossary");
assert.equal(def.localization.glossary.length, 2);
console.log("  ok   glossary applied across the survey and recorded as versioned edits");

console.log("\nSTUDIO — QA: a broken piping token blocks readiness; live is refused until fixed");
await toView("translate");
for (const l of ["hi", "es", "ar"]) if (!(await page.isChecked(`[data-testid="loc-col-${l}"]`))) await page.click(`[data-testid="loc-col-${l}"]`);
await page.selectOption('[data-testid="loc-filter-question"]', "q2");
const q2Row = page.locator('[data-testid="loc-row"][data-key="q:q2:text"]');
await q2Row.locator('[data-testid="loc-input-es"]').fill("¿Por qué dice eso?");
await page.waitForTimeout(200);
await page.click('[data-testid="loc-view-qa"]');
await page.waitForSelector('[data-testid="qa-es"]');
assert.equal(await page.getAttribute('[data-testid="qa-es"]', "data-ready"), "0");
assert.ok(await page.$('[data-testid="qa-es"] [data-testid="qa-issue"][data-kind="placeholder_mismatch"][data-blocking="1"]'), "placeholder mismatch is a blocking issue");
assert.equal(await page.getAttribute('[data-testid="qa-hi"]', "data-ready"), "1", "Hindi has no blocking issue");
await page.click('[data-testid="loc-view-languages"]');
await page.selectOption('[data-testid="loc-status-es"]', "live");
await page.waitForTimeout(300);
def = await h.readDef();
assert.equal(def.localization.languages.find((l) => l.code === "es").status, "draft", "cannot be marked live with a blocking issue");
await toView("languages");
await page.selectOption('[data-testid="loc-status-hi"]', "live");
await page.selectOption('[data-testid="loc-status-ar"]', "live");
await page.waitForTimeout(200);
// fix via the QA "Fix" button → lands on the row
await page.click('[data-testid="loc-view-qa"]');
await page.locator('[data-testid="qa-es"] [data-testid="qa-issue"][data-kind="placeholder_mismatch"] [data-testid="qa-fix"]').click();
await page.waitForSelector('[data-testid="loc-table"]');
if (!(await page.isChecked('[data-testid="loc-col-es"]'))) await page.click('[data-testid="loc-col-es"]');
await page.locator('[data-testid="loc-row"][data-key="q:q2:text"] [data-testid="loc-input-es"]').fill("¿Por qué dice {{Q1}}?");
await page.waitForTimeout(200);
await page.click('[data-testid="loc-view-languages"]');
await page.selectOption('[data-testid="loc-status-es"]', "live");
await page.waitForTimeout(200);
def = await h.readDef();
assert.equal(def.localization.languages.find((l) => l.code === "es").status, "live");
console.log("  ok   QA blocked 'live' with a broken {{Q1}}; Fix → edit → live");

console.log("\nSTUDIO — Voice / Audio: external URL, AI voice generated + approved, priority, outdated after a translation change");
await toView("audio");
await page.click('[data-testid="au-lang-hi"]');
await page.selectOption('[data-testid="au-filter-question"]', "q1");
await page.click('[data-testid="au-el-q:q1:text"]');
await page.waitForSelector('[data-testid="au-element"][data-lang="hi"]');
await page.fill('[data-testid="au-url-input"]', "https://cdn.example.com/q1_hi.mp3");
await page.click('[data-testid="au-url-save"]');
await page.waitForSelector('[data-testid="au-asset-row"][data-kind="url"]');
await page.click('[data-testid="au-ai-generate"]');
await page.waitForSelector('[data-testid="au-ai-preview"]', { timeout: 20000 });
await page.click('[data-testid="au-ai-approve"]');
await page.waitForSelector('[data-testid="au-asset-row"][data-kind="ai"]');
assert.equal(await page.getAttribute('[data-testid="au-asset-row"][data-kind="ai"]', "data-plays"), "1", "approved AI audio outranks the URL by default priority");
assert.equal(await page.getAttribute('[data-testid="au-asset-row"][data-kind="url"]', "data-plays"), "0");
def = await h.readDef();
const aiAsset = def.localization.audio.find((a) => a.kind === "ai");
assert.ok(aiAsset.url.startsWith("data:audio/wav"), "the sandbox keeps the generated audio inline");
assert.equal(aiAsset.approved, true);
assert.equal(aiAsset.elementKey, "q:q1:text");
assert.equal(aiAsset.language, "hi");
// move URL above AI in the priority
await toView("audio");
await page.click('[data-testid="au-lang-hi"]');
await page.selectOption('[data-testid="au-filter-question"]', "q1");
await page.click('[data-testid="au-el-q:q1:text"]');
await page.waitForSelector('[data-testid="au-asset-row"][data-kind="ai"]');
await page.click('[data-testid="au-priority-up-url"]');
await page.click('[data-testid="au-priority-up-url"]');
await page.waitForTimeout(200);
assert.equal(await page.getAttribute('[data-testid="au-asset-row"][data-kind="url"]', "data-plays"), "1", "the programmer's priority order decides");
def = await h.readDef();
assert.deepEqual(def.localization.audioPriority, ["url", "human", "ai"]);
// change the Hindi translation → the audio is outdated
await toView("translate");
if (!(await page.isChecked('[data-testid="loc-col-hi"]'))) await page.click('[data-testid="loc-col-hi"]');
await page.selectOption('[data-testid="loc-filter-question"]', "q1");
await page.locator('[data-testid="loc-row"][data-key="q:q1:text"] [data-testid="loc-input-hi"]').fill("कृपया बताएं, Miures की आपकी यात्रा कैसी रही?");
await page.waitForTimeout(200);
await page.click('[data-testid="loc-view-audio"]');
await page.click('[data-testid="au-lang-hi"]');
await page.selectOption('[data-testid="au-filter-question"]', "q1");
await page.click('[data-testid="au-el-q:q1:text"]');
await page.waitForSelector('[data-testid="au-stale"]');
assert.equal((await page.$$('[data-testid="au-stale"]')).length, 2, "both Hindi assets are flagged outdated");
await page.locator('[data-testid="au-asset-row"][data-kind="ai"] [data-testid="au-keep"]').click();
await page.waitForTimeout(200);
assert.equal((await page.$$('[data-testid="au-stale"]')).length, 1, "'Keep existing' accepts the recording for the new words");
await page.click('[data-testid="au-library-tab"]');
assert.equal((await page.$$('[data-testid="au-asset"]')).length, 2, "the library lists every file");
console.log("  ok   URL + approved AI audio (labelled), priority reorder, outdated flag and Keep existing, library");

console.log("\nSTUDIO — Import / Export: CSV out; JSON in by Element ID");
await toView("files");
const [download] = await Promise.all([page.waitForEvent("download"), page.click('[data-testid="loc-export-csv"]')]);
const csvPath = await download.path();
const csv = fs.readFileSync(csvPath, "utf8");
assert.match(csv.split("\n")[0], /^﻿?Element ID,Question ID,Question,Element,Source Language,Target Language,Source Text,Translation,Status,Audio URL/);
assert.ok(csv.includes("q:q1:opt:1,q1,Q1,Q1 · option 1,en,es,Great,Excelente,approved,"), "a row per element and language, with status (approved in the memory section above)");
const tmp = path.join(os.tmpdir(), `loc-import-${Date.now()}.json`);
fs.writeFileSync(tmp, JSON.stringify({ rows: [
  { elementKey: "q:q1:opt:2", targetLanguage: "es", translation: "Regular", status: "reviewed" },
  { elementKey: "q:q1:opt:2", targetLanguage: "pt", translation: "Razoável" },
  { elementKey: "q:gone:opt:1", targetLanguage: "es", translation: "x" },
] }));
await page.setInputFiles('[data-testid="loc-import-file"]', tmp);
await page.waitForSelector('[data-testid="loc-import-note"]');
assert.match(await page.textContent('[data-testid="loc-import-note"]'), /2 translations imported, 1 row skipped/);
def = await h.readDef();
assert.equal(def.localization.translations.es["q:q1:opt:2"].text, "Regular");
assert.equal(def.localization.translations.es["q:q1:opt:2"].status, "reviewed");
assert.equal(def.localization.translations.es["q:q1:opt:2"].origin, "import");
assert.ok(def.localization.languages.some((l) => l.code === "pt"), "a language new to the survey arrives as a draft");
fs.unlinkSync(tmp);
console.log("  ok   CSV exported with the contract columns; JSON imported by key, unknown element skipped");

// ---------------------------------------------------------------- runtime
const studioDef = await h.readDef();
const openLang = async (lang, extra = {}) => {
  const pv = await h.browser.newPage({ viewport: { width: 1000, height: 1000 } });
  pv.on("pageerror", (e) => console.error("RUNTIME PAGE ERROR:", e.message));
  await pv.goto(`${RUNTIME}/preview?lang=${lang}`, { waitUntil: "networkidle" });
  await sendPreview(pv, { definition: { ...studioDef, ...extra } }, { selector: "[data-qid]" });
  return pv;
};
const state = (pv) => pv.evaluate(() => window.__rescriptState);
const text = (pv, sel) => pv.textContent(sel);

console.log("\nRUNTIME — ?lang=es serves Spanish: texts, options, buttons; SURVEY_LANGUAGE stored; ids and codes unchanged");
let pv = await openLang("es");
assert.equal(await pv.getAttribute('[data-testid="rs-language"]', "value") ?? await pv.inputValue('[data-testid="rs-language"]'), "es");
assert.match(await text(pv, '[data-qid="q1"]'), /\[es\] How was your latest visit to Miures\?/);
assert.match(await text(pv, '[data-qid="q1"]'), /Excelente/);
assert.match(await text(pv, '[data-qid="q1"]'), /Regular/, "the imported, reviewed translation");
assert.equal(await text(pv, '[data-testid="rs-next"]'), "Siguiente");
assert.equal((await state(pv)).embedded.SURVEY_LANGUAGE, "es");
assert.deepEqual(await pv.$$eval('[data-qid="q1"] input[type=radio]', (els) => els.map((e) => e.value)), ["1", "2", "3", "99"], "option CODES are the codes");
assert.equal(await pv.getAttribute('[data-testid="rs-language-bar"]', "dir") ?? "ltr", "ltr");
// required validation in Spanish
await h.next(pv);
await pv.waitForTimeout(200);
assert.match(await pv.evaluate(() => document.body.innerText), /Esta pregunta es obligatoria\./, "validation speaks Spanish");
console.log("  ok   Spanish everywhere; codes 1/2/3/99; SURVEY_LANGUAGE = es; validation translated");

console.log("\nRUNTIME — switching to Hindi mid-survey keeps position, answers and logic; piping resolves to the Hindi label");
await pv.click('[data-qid="q1"] input[value="3"]');
await pv.fill('[data-qid="q2"] textarea', "Demasiado caro");
await pv.selectOption('[data-testid="rs-language"]', "hi");
await pv.waitForFunction(() => document.querySelector('[data-qid="q1"]')?.textContent.includes("ख़राब"));
assert.ok(await pv.isChecked('[data-qid="q1"] input[value="3"]'), "the answer is still there");
assert.equal(await pv.inputValue('[data-qid="q2"] textarea'), "Demasiado caro");
assert.equal((await state(pv)).stepIndex, 0, "same page");
assert.equal((await state(pv)).embedded.SURVEY_LANGUAGE, "hi");
assert.match(await text(pv, '[data-qid="q2"]'), /आप ख़राब क्यों कहते हैं\?|\[hi\] Why do you say ख़राब\?/, "piping in Hindi resolves to the Hindi option label");
assert.match(await text(pv, '[data-qid="q1"]'), /कृपया बताएं, Miures की आपकी यात्रा कैसी रही\?/, "the edited Hindi question text");
assert.ok(await pv.$('[data-testid="rs-question-audio"][data-question="q1"]'), "Hindi audio exists for Q1 → a Listen button");
assert.equal(await pv.getAttribute('[data-testid="rs-question-audio"][data-question="q1"]', "data-kind"), "url", "the URL plays first — the survey's priority");
assert.ok(!(await pv.$('[data-testid="rs-question-audio"][data-question="q2"]')), "no audio for Q2 → no button");
assert.equal(await text(pv, '[data-testid="rs-next"]'), "आगे");
await h.next(pv);
await pv.waitForSelector('[data-qid="q3"]');
await pv.fill('[data-qid="q3"] input', "99");
await h.next(pv);
await pv.waitForTimeout(200);
assert.match(await pv.evaluate(() => document.body.innerText), /\[hi\] Value must be at most 50\./, "a parameterised validation message, translated then filled");
await pv.fill('[data-qid="q3"] input', "4");
await h.next(pv);
await pv.waitForSelector('[data-testid="rs-ended"]');
assert.match(await text(pv, '[data-testid="rs-ended"]'), /\[hi\] Thank you — you said ख़राब\./, "the end message in Hindi, piping resolved to the Hindi label");
const st = await state(pv);
assert.equal(st.answers.q1, 3, "the stored value is the code");
assert.equal(st.embedded.SURVEY_LANGUAGE, "hi");
await pv.close();
console.log("  ok   position, answers, seed kept; Hindi piping, validation, end message; SURVEY_LANGUAGE = hi; stored value is the code");

console.log("\nRUNTIME — Arabic is right-to-left; an unknown language falls back; no localization → no selector");
pv = await openLang("ar");
assert.equal(await pv.getAttribute('[data-testid="rs-language-bar"] ~ *, .rs-shell', "dir").catch(() => null) ?? await pv.getAttribute(".rs-shell", "dir"), "rtl");
assert.equal(await pv.getAttribute(".rs-shell", "data-language"), "ar");
await pv.close();
pv = await openLang("xx");
assert.equal(await pv.getAttribute(".rs-shell", "data-language"), "en", "unknown → the source language");
await pv.close();
pv = await openLang("es", { localization: undefined });
assert.ok(!(await pv.$('[data-testid="rs-language"]')), "a single-language survey shows no selector");
assert.equal((await state(pv)).embedded.SURVEY_LANGUAGE, undefined, "…and stores no language column");
await pv.close();
console.log("  ok   RTL; fallback; unchanged default");

await h.close();
console.log("\nALL LOCALIZATION CHECKS PASSED");

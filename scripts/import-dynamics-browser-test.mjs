#!/usr/bin/env node
/**
 * IMPORTED DYNAMIC LISTS, LOOPS AND PIPING IN THE RESPONDENT'S BROWSER (2026-11-02).
 *
 *   node scripts/import-dynamics-browser-test.mjs      (runtime on :3001 — RUNTIME_URL to change; after `pnpm -r build`)
 *
 * Imports two Word questionnaires with the real importer, sends each resulting definition to the runtime preview
 * (the Runner used by test and live links) and answers it as a respondent, checking what the page SHOWS:
 *
 *   08  Q2 lists exactly the brands ticked at Q1, with Q1's codes; Q3 lists the ones NOT ticked at Q2; Q4 lists the
 *       ones ticked at Q2; Q5 lists Q1's whole list; going back and changing Q1 changes Q2
 *   09  ticking two brands at Q1 asks Q2 and Q3 once per brand, the brand's name in the text, in order, with the
 *       answers stored per brand; Q4 pipes the brands and lists only them; Q6 and Q7 pipe the age and the favourite
 */
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "./lib/playwright.mjs";
import { sendPreview } from "./lib/preview.mjs";
import { analyzeImport } from "../packages/import/dist/index.js";

const RUNTIME = process.env.RUNTIME_URL ?? "http://localhost:3001";
const CORPUS = join(dirname(fileURLToPath(import.meta.url)), "..", "packages", "import", "corpus", "word");
let bad = 0, good = 0;
const ok = (c, m) => { console.log(`${c ? "  ok  " : "  FAIL"} ${m}`); if (c) good++; else bad++; };
let n = 0;
const uid = (p) => `${p}_${(++n).toString(36)}`;
const load = async (f) => (await analyzeImport(new Uint8Array(readFileSync(join(CORPUS, f))), f, { surveyId: "00000000-0000-4000-8000-00000000d1a0", uid })).result.def;

const browser = await chromium.launch();
const open = async (def) => {
  const page = await browser.newPage({ viewport: { width: 1100, height: 1000 } });
  page.on("pageerror", (e) => { console.log("  !! page error:", e.message); bad++; });
  await page.goto(`${RUNTIME}/preview`, { waitUntil: "domcontentloaded" });
  await sendPreview(page, { definition: def });
  return page;
};
const idOf = (def, code) => def.questions.find((q) => q.code === code).id;
/* what the page shows for a question: its text and its options' codes, in order */
const shown = (page, id) => page.evaluate((id) => {
  const el = document.querySelector(`[data-qid="${id}"]`);
  if (!el) return null;
  const codes = [...el.querySelectorAll("[data-rs-id]")].map((o) => o.getAttribute("data-rs-id"));
  const text = (el.querySelector(".rs-question-text, .rs-qtext, h2, legend, label")?.textContent ?? el.textContent ?? "").replace(/\s+/g, " ").trim();
  return { codes, text };
}, id);
const visibleIds = (page) => page.$$eval("[data-qid]", (els) => els.map((e) => e.getAttribute("data-qid")));
const tick = async (page, id, code) => { await page.click(`[data-qid="${id}"] [data-rs-id="${code}"] input`); await page.waitForTimeout(80); };
const next = async (page) => { const before = (await visibleIds(page)).join(); await page.click('[data-testid="rs-next"]'); for (let i = 0; i < 30; i++) { await page.waitForTimeout(100); if ((await visibleIds(page)).join() !== before || (await state(page))?.status === "complete") return; } };
const state = (page) => page.evaluate(() => { const s = window.__rescriptState ?? window.rescriptState; return s ? JSON.parse(JSON.stringify({ answers: s.answers, status: s.status })) : null; });
const waitFor = async (page, id) => { for (let i = 0; i < 40; i++) { if ((await visibleIds(page)).includes(id)) return true; await page.waitForTimeout(100); } return false; };

/* ------------------------------------------------------------ 08 carry forward and masking */
{
  console.log("\n=== 08-carry-forward-masking.docx");
  const def = await load("08-carry-forward-masking.docx");
  const [Q1, Q2, Q3, Q4, Q5, Q6] = ["Q1", "Q2", "Q3", "Q4", "Q5", "Q6"].map((c) => idOf(def, c));
  const page = await open(def);
  await waitFor(page, Q1);
  ok(JSON.stringify((await shown(page, Q1)).codes) === JSON.stringify(["1", "2", "3", "4", "99"]), `Q1 lists the source's codes → ${(await shown(page, Q1)).codes}`);
  await tick(page, Q1, 1); await tick(page, Q1, 3);
  await next(page);
  ok(await waitFor(page, Q2), "Q2 is shown");
  let s = await shown(page, Q2);
  ok(JSON.stringify(s.codes) === JSON.stringify(["1", "3"]), `Q2 carries exactly Brand A and Brand C, codes kept → ${s.codes}`);
  await tick(page, Q2, 1);
  await next(page);
  ok(await waitFor(page, Q3), "Q3 is shown");
  s = await shown(page, Q3);
  ok(JSON.stringify(s.codes) === JSON.stringify(["3"]), `Q3 (masking) lists what was NOT ticked at Q2: Brand C → ${s.codes}`);
  await tick(page, Q3, 3);
  await next(page);
  ok(await waitFor(page, Q4), "Q4 is shown");
  s = await shown(page, Q4);
  ok(JSON.stringify(s.codes) === JSON.stringify(["1"]), `Q4 lists what was ticked at Q2: Brand A → ${s.codes}`);
  ok(await page.$(`[data-qid="${Q4}"] input[type="radio"]`) !== null, "Q4 is single choice");
  await tick(page, Q4, 1);
  await next(page);
  ok(await waitFor(page, Q5), "Q5 is shown");
  s = await shown(page, Q5);
  ok(JSON.stringify(s.codes) === JSON.stringify(["1", "2", "3", "4", "99"]), `Q5 (same list as Q1) lists every brand → ${s.codes}`);
  await tick(page, Q5, 2);
  await next(page);
  ok(await waitFor(page, Q6), "Q6 is shown");
  s = await shown(page, Q6);
  ok(JSON.stringify(s.codes) === JSON.stringify(["1", "3"]), `Q6 lists Q1's ticked brands once — the written copy is not shown twice → ${s.codes}`);
  const a = (await state(page)).answers;
  ok(JSON.stringify(a[Q2]) === "[1]" && JSON.stringify(a[Q3]) === "[3]" && a[Q4] === 1, `answers stored with the source's codes → Q2 ${JSON.stringify(a[Q2])} Q3 ${JSON.stringify(a[Q3])} Q4 ${JSON.stringify(a[Q4])}`);

  /* the changed answer: back to Q1, untick C, tick D */
  const back = async () => { await page.click('[data-testid="rs-back"]'); await page.waitForTimeout(250); };
  if (await page.$('[data-testid="rs-back"]')) {
    for (let i = 0; i < 6 && !(await visibleIds(page)).includes(Q1); i++) await back();
    ok((await visibleIds(page)).includes(Q1), "back at Q1");
    await tick(page, Q1, 3); await tick(page, Q1, 4);
    await next(page);
    await waitFor(page, Q2);
    s = await shown(page, Q2);
    ok(JSON.stringify(s.codes) === JSON.stringify(["1", "4"]), `after changing Q1 to A and D, Q2 lists A and D → ${s.codes}`);
  } else console.log("  --   no Back button in this survey's navigation: the changed-answer case is covered by the engine's synthetic respondents only");
  await page.close();
}

/* ------------------------------------------------------------ 09 loop and piping */
{
  console.log("\n=== 09-loops-piping.docx");
  const def = await load("09-loops-piping.docx");
  const [Q1, Q2, Q3, Q4, Q5, Q6, Q7] = ["Q1", "Q2", "Q3", "Q4", "Q5", "Q6", "Q7"].map((c) => idOf(def, c));
  const page = await open(def);
  await waitFor(page, Q1);
  await tick(page, Q1, 1); await tick(page, Q1, 3);
  await next(page);
  const seen = [];
  for (let i = 0; i < 6; i++) {
    const ids = await visibleIds(page);
    if (!ids.includes(Q2) && !ids.includes(Q3)) break;
    for (const id of ids) {
      const t = await page.$eval(`[data-qid="${id}"]`, (e) => e.textContent.replace(/\s+/g, " ").trim());
      seen.push(`${id === Q2 ? "Q2" : id === Q3 ? "Q3" : id}:${/Alpha/.test(t) ? "Alpha" : /Gamma/.test(t) ? "Gamma" : /Beta|Delta/.test(t) ? "other" : "none"}`);
      if (id === Q2) await page.click(`[data-qid="${Q2}"] [data-rs-id] input >> nth=0`);
      if (id === Q3) await page.fill(`[data-qid="${Q3}"] textarea, [data-qid="${Q3}"] input`, `because ${seen.length}`);
    }
    await next(page);
  }
  ok(JSON.stringify(seen) === JSON.stringify(["Q2:Alpha", "Q3:Alpha", "Q2:Gamma", "Q3:Gamma"]) || JSON.stringify(seen) === JSON.stringify(["Q2:Alpha", "Q2:Gamma", "Q3:Alpha", "Q3:Gamma"]), `the loop asks Q2 and Q3 for Alpha, then Gamma — the brand piped → ${seen.join(", ")}`);
  let a = (await state(page)).answers;
  const keys = Object.keys(a).filter((k) => k.startsWith(`${Q2}@`) || k.startsWith(`${Q3}@`));
  ok(keys.length === 4 && keys.some((k) => k.includes("@1")) && keys.some((k) => k.includes("@3")), `answers stored per brand → ${keys.join(", ")}`);
  ok(await waitFor(page, Q4), "Q4 is shown after the loop");
  const s4 = await shown(page, Q4);
  ok(/Alpha, Gamma|Alpha and Gamma|Alpha; Gamma/.test(s4.text) || (/Alpha/.test(s4.text) && /Gamma/.test(s4.text)), `Q4 pipes the brands used → “${s4.text.slice(0, 80)}”`);
  ok(JSON.stringify(s4.codes) === JSON.stringify(["1", "3"]), `Q4 lists only them → ${s4.codes}`);
  await tick(page, Q4, 3);
  await next(page);
  await waitFor(page, Q5);
  await page.fill(`[data-qid="${Q5}"] input`, "34");
  await next(page);
  await waitFor(page, Q6);
  const t6 = await page.$eval(`[data-qid="${Q6}"]`, (e) => e.textContent.replace(/\s+/g, " "));
  ok(/At 34 years old/.test(t6) && /buy Gamma/.test(t6), `Q6 pipes the age and the favourite → “${t6.slice(0, 70)}”`);
  await page.click(`[data-qid="${Q6}"] [data-rs-id] input >> nth=0`);
  await next(page);
  await waitFor(page, Q7);
  const t7 = await page.$eval(`[data-qid="${Q7}"]`, (e) => e.textContent.replace(/\s+/g, " "));
  ok(/about Gamma/.test(t7), `Q7 pipes the favourite → “${t7.slice(0, 60)}”`);
  ok(!/\[|\{\{|\{Q/.test(t6 + t7 + s4.text), "no placeholder or token shown to the respondent");
  await page.fill(`[data-qid="${Q7}"] textarea, [data-qid="${Q7}"] input`, "Nothing else");
  await next(page);
  ok((await state(page)).status === "complete", "the interview completes");
  await page.close();
}

await browser.close();
console.log(`\nimport-dynamics-browser: ${good} passed, ${bad} failed`);
process.exit(bad ? 1 : 0);

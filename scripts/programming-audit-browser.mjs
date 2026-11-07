/**
 * SURVEY PROGRAMMING AUDIT — THE REAL RUNTIME IN A BROWSER (2026-11-07).
 *
 *   1. every selectable question variant, created as the Studio picker creates it, rendered by the runtime's
 *      /preview at desktop (1280) and phone (390) widths: no error boundary, an answerable control in every
 *      question, no console errors, no horizontal overflow on the phone;
 *   2. a multi-block survey (screener, quota, carry forward, loop, display logic, randomizer, branch, dynamic
 *      text, redirect) walked through the real Runner by clicking, and its page sequence compared with the engine's
 *      prediction for the same seed — preview and engine must agree.
 *
 *   RUNTIME_URL=http://localhost:3001 node scripts/programming-audit-browser.mjs
 */
import { chromium } from "./lib/playwright.mjs";
import { sendPreview } from "./lib/preview.mjs";
import { SurveyDefinition, QUESTION_VARIANTS, isSelectableVariant } from "../packages/schema/dist/index.js";
import * as E from "../packages/engine/dist/index.js";
import { simulateRespondent } from "../packages/templates/dist/index.js";

const RUNTIME = process.env.RUNTIME_URL ?? "http://localhost:3001";
const results = [];
const check = (area, name, ok, detail = "") => { results.push({ area, name, ok: !!ok, detail }); console.log(`${ok ? "PASS" : "FAIL"}  [${area}] ${name}${detail ? ` — ${detail}` : ""}`); };
let n = 0; const ids = (p) => `${p}_${++n}`;

const browser = await chromium.launch();

/* ------------------------------------------------------------ 1. every variant renders */
const variants = QUESTION_VARIANTS.filter((v) => v.status === "stable" && isSelectableVariant(v));
const qs = variants.map((v, i) => { const q = E.withStarterOptions(E.createQuestionFromVariant(v, { code: `V${i + 1}`, variableName: `V${i + 1}` }, ids), ids); q.text = q.text || `${v.label} (${v.id})`; return q; });
/* not drawn for respondents (filled by the engine) / drawn only once their content exists (a design, an image, a video) */
const NOT_DRAWN = new Set(["calculated", "hidden", "embedded_data"]);
const NEEDS_CONTENT = new Set(["maxdiff_task", "conjoint_task", "acbc_task", "annotation", "media_timeline", "hotspot", "html", "experiment"]); // a design, an image or video, display-only content, an A/B stimulus
const drawnIds = () => qs.filter((q) => !NOT_DRAWN.has(q.type) && !/^ai\.(classification|sentiment)$/.test(q.variant ?? "")).map((q) => q.id);
const controlIds = () => qs.filter((q) => drawnIds().includes(q.id) && !NEEDS_CONTENT.has(q.type) && !["media.watch_time", "comparison.before_after", "hotspot.regions", "hotspot.shelf"].includes(q.variant ?? "")).map((q) => q.id);
const all = SurveyDefinition.parse({ meta: { id: "types", code: "TY", title: "All types", version: "1" }, questions: qs, flow: [{ type: "page", id: "p", questionIds: qs.map((q) => q.id) }] });

for (const [label, viewport] of [["desktop", { width: 1280, height: 900 }], ["phone", { width: 390, height: 844 }]]) {
  const ctx = await browser.newContext({ viewport, ...(label === "phone" ? { isMobile: true, hasTouch: true, deviceScaleFactor: 1 } : {}) });
  const page = await ctx.newPage();
  const errors = [];
  page.on("console", (m) => { if (m.type() === "error") errors.push(m.text().slice(0, 160)); });
  page.on("pageerror", (e) => errors.push(`pageerror: ${e.message.slice(0, 160)}`));
  await page.goto(`${RUNTIME}/preview`, { waitUntil: "networkidle" });
  await sendPreview(page, { definition: all }, { selector: "[data-qid]", timeout: 60000 });
  await page.waitForTimeout(2500);
  const report = await page.evaluate(([expected, needControl]) => {
    const out = { rendered: 0, missing: [], noControl: [], boundary: [], overflow: document.documentElement.scrollWidth > window.innerWidth + 2 };
    for (const id of expected) {
      const el = document.querySelector(`[data-qid="${id}"]`);
      if (!el) { out.missing.push(id); continue; }
      out.rendered++;
      const text = el.textContent ?? "";
      if (/something went wrong|could not be (shown|displayed)|failed to render/i.test(text)) out.boundary.push(id);
      const control = el.querySelector("input, select, textarea, button, [role=radio], [role=checkbox], [role=slider], [role=listbox], [role=option], [draggable=true], canvas, [contenteditable=true], [tabindex='0']");
      if (!control && needControl.includes(id)) out.noControl.push(id);
    }
    return out;
  }, [drawnIds(), controlIds()]);
  const name = (id) => { const q = qs.find((x) => x.id === id); return `${q.code} ${q.variant}`; };
  check("Render", `${label}: every respondent-facing variant renders (${drawnIds().length})`, report.missing.length === 0 && report.boundary.length === 0, `${report.rendered} rendered${report.missing.length ? `; missing ${report.missing.map(name).slice(0, 8).join(", ")}` : ""}${report.boundary.length ? `; error boundary ${report.boundary.map(name).join(", ")}` : ""}`);
  check("Render", `${label}: every rendered question has an answerable control`, report.noControl.length === 0, report.noControl.map(name).slice(0, 12).join(", ") || "all");
  check("Render", `${label}: no console errors while rendering`, errors.length === 0, errors.slice(0, 4).join(" | ") || "none");
  if (label === "phone") check("Render", "phone: no horizontal page overflow", !report.overflow, report.overflow ? "page wider than the viewport" : "fits");
  await ctx.close();
}

/* ------------------------------------------------------------ 2. a multi-block survey walked by clicking */
const rule = (ref, operator, value) => ({ type: "rule", source: { kind: "question", ref }, operator, value });
const opts = (labels) => labels.map((l, i) => typeof l === "object" ? l : ({ code: i + 1, label: l }));
const study = SurveyDefinition.parse({
  meta: { id: "walk", code: "WALK", title: "Walk", version: "1" },
  questions: [
    { id: "s1", code: "S1", variableName: "S1", type: "single_select", text: "Your age band?", required: true, options: opts(["18–34", "35–54", { code: 9, label: "Under 18" }]), skipLogic: [{ id: "k", when: rule("s1", "selected", 9), target: { kind: "terminate", status: "screened" } }] },
    { id: "q1", code: "Q1", variableName: "Q1", type: "multi_select", text: "Which brands do you know?", required: true, options: opts(["Apple", "Samsung", "Google", { code: 99, label: "None of these", flags: ["exclusive"] }]) },
    { id: "q2", code: "Q2", variableName: "Q2", type: "single_select", text: "Which do you use most?", required: true, options: [], carryForward: { sourceQuestionId: "q1", filter: "selected", into: "options" } },
    { id: "q3", code: "Q3", variableName: "Q3", type: "single_select", text: "How do you rate {{loop.label}}?", required: true, options: opts(["Poor", "Good"]) },
    { id: "q4", code: "Q4", variableName: "Q4", type: "open_text", text: "Why Apple?", displayLogic: rule("q2", "selected", 1) },
    { id: "q6", code: "Q6", variableName: "Q6", type: "open_text", text: "x", dynamicText: { expression: 'Q2 == "Apple" ? "Tell us about your iPhone" : "Tell us about your {{Q2}}"' } },
    { id: "c1", code: "C1", variableName: "C1", type: "single_select", text: "Concept A — buy?", options: opts(["Yes", "No"]) },
    { id: "c2", code: "C2", variableName: "C2", type: "single_select", text: "Concept B — buy?", options: opts(["Yes", "No"]) },
    { id: "a1", code: "A1", variableName: "A1", type: "open_text", text: "Apple path question" },
    { id: "b1", code: "B1", variableName: "B1", type: "open_text", text: "Other path question" },
  ],
  flow: [
    { type: "page", id: "pS", questionIds: ["s1"] },
    { type: "page", id: "pQ1", questionIds: ["q1"] },
    { type: "page", id: "pQ2", questionIds: ["q2"] },
    { type: "loop", id: "lp", loopVar: "brand", source: { kind: "question", questionId: "q1", filter: "selected" }, children: [{ type: "page", id: "pQ3", questionIds: ["q3"] }] },
    { type: "page", id: "pQ4", questionIds: ["q4", "q6"] },
    { type: "randomizer", id: "rz", show: 1, evenPresentation: true, children: [{ type: "page", id: "pC1", questionIds: ["c1"] }, { type: "page", id: "pC2", questionIds: ["c2"] }] },
    { type: "branch", id: "br", title: "By brand", branches: [{ id: "arm", label: "Apple", when: rule("q2", "selected", 1), children: [{ type: "page", id: "pA", questionIds: ["a1"] }] }], otherwise: [{ type: "page", id: "pB", questionIds: ["b1"] }] },
    { type: "end", id: "end", status: "complete" },
  ],
});
const answers = { s1: "18–34", q1: ["Apple", "Google"], q2: "Apple", q3: "Good", c1: "Yes", c2: "Yes" };
for (const [label, viewport] of [["desktop", { width: 1280, height: 900 }], ["phone", { width: 390, height: 844 }]]) {
  const ctx = await browser.newContext({ viewport });
  const page = await ctx.newPage();
  await page.goto(`${RUNTIME}/preview`, { waitUntil: "networkidle" });
  await sendPreview(page, { definition: study }, { selector: "[data-qid]" });
  const seen = []; const texts = {};
  for (let guard = 0; guard < 15; guard++) {
    const qids = await page.$$eval("#rs-questions [data-qid], [data-qid]", (els) => [...new Set(els.map((e) => e.getAttribute("data-qid")))]);
    if (!qids.length) break;
    seen.push(qids.join("+"));
    for (const qid of qids) {
      const q = study.questions.find((x) => x.id === qid);
      texts[qid] = `${texts[qid] ? `${texts[qid]} / ` : ""}${(await page.textContent(`[data-qid="${qid}"]`))?.replace(/\s+/g, " ").slice(0, 60)}`;
      const box = page.locator(`[data-qid="${qid}"]`);
      if (q.type === "open_text") { await box.locator("input, textarea").first().fill("because"); continue; }
      const want = answers[qid];
      for (const lbl of Array.isArray(want) ? want : [want ?? "Yes"]) await box.getByText(lbl, { exact: true }).first().click();
    }
    const step0 = await page.evaluate(() => window.__rescriptState?.stepIndex);
    await page.click('[data-testid="rs-next"]');
    await page.waitForTimeout(700);
    const done = await page.$('[data-qid]') === null;
    if (done) break;
    const again = await page.$$eval("[data-qid]", (els) => [...new Set(els.map((e) => e.getAttribute("data-qid")))].join("+"));
    if (again === qids.join("+") && (await page.evaluate(() => window.__rescriptState?.stepIndex)) === step0) { seen.push("(stuck)"); break; }
  }
  const st = await page.evaluate(() => window.__rescriptState);
  const sim = simulateRespondent(study, { answers: { s1: 1, q1: [1, 3], q2: 1, q3: 2, q4: "because", q6: "because", c1: 1, c2: 1, a1: "because", b1: "because" }, seed: st?.seed });
  const predicted = sim.pages.map((p) => p.questionIds.join("+"));
  check("Preview = engine", `${label}: the page sequence clicked in the runtime equals the engine's prediction for the same seed`, JSON.stringify(seen) === JSON.stringify(predicted), `runtime ${seen.join(" → ")} | engine ${predicted.join(" → ")}`);
  check("Preview = engine", `${label}: loop label piping and dynamic text render in the runtime`, /Apple.* \/ .*Google/.test(texts.q3 ?? "") && /iPhone/.test(texts.q6 ?? ""), `Q3 “${texts.q3}”, Q6 “${texts.q6}”`);
  check("Preview = engine", `${label}: the runtime ends complete`, st?.status === "complete", `status ${st?.status}`);
  await ctx.close();
}

/* ------------------------------------------------------------ 3. numbering, lettering, auto-advance */
{
  const d = SurveyDefinition.parse({ meta: { id: "num", code: "NUM", title: "n", version: "1" },
    branding: { layout: { questionNumbers: "sequence", optionNumbering: "letters", autoAdvance: true } },
    questions: [
      { id: "a", code: "QA", variableName: "QA", type: "single_select", text: "First question", required: true, options: opts(["Red", "Blue"]) },
      { id: "b", code: "QB", variableName: "QB", type: "single_select", text: "Second question", options: opts(["Yes", "No"]) },
      { id: "c", code: "QC", variableName: "QC", type: "open_text", text: "Third question" },
    ],
    flow: [{ type: "page", id: "p1", questionIds: ["a"] }, { type: "page", id: "p2", questionIds: ["b", "c"] }, { type: "end", id: "e", status: "complete" }] });
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  const page = await ctx.newPage();
  await page.goto(`${RUNTIME}/preview`, { waitUntil: "networkidle" });
  await sendPreview(page, { definition: d }, { selector: "[data-qid]" });
  const num = await page.textContent('[data-qid="a"] [data-testid="rs-qnum"]').catch(() => null);
  const letters = await page.$$eval('[data-qid="a"] .rs-optnum', (els) => els.map((e) => e.textContent?.trim()));
  check("Properties", "question numbers and option letters are shown when switched on", num?.trim() === "1." && letters.join() === "A.,B.", `number “${num?.trim()}”, letters ${letters.join(" ")}`);
  await page.locator('[data-qid="a"]').getByText("Blue", { exact: true }).click();
  await page.waitForTimeout(1500);
  const now = await page.$$eval("[data-qid]", (els) => els.map((e) => e.getAttribute("data-qid")).join("+"));
  const second = await page.textContent('[data-qid="b"] [data-testid="rs-qnum"]').catch(() => null);
  check("Properties", "auto-advance: choosing an answer on a single-choice page moves on without Next", now === "b+c", `now on ${now}`);
  check("Properties", "auto-advance does not fire on a page with more than one question; numbering continues (2.)", second?.trim() === "2." && now === "b+c", `QB number “${second?.trim()}”`);
  await page.locator('[data-qid="b"]').getByText("Yes", { exact: true }).click();
  await page.waitForTimeout(1200);
  const still = await page.$$eval("[data-qid]", (els) => els.map((e) => e.getAttribute("data-qid")).join("+"));
  check("Properties", "a two-question page stays put after a choice", still === "b+c", `still ${still}`);
  await ctx.close();
}

await browser.close();
const fails = results.filter((r) => !r.ok).length;
console.log(`\n${results.length - fails}/${results.length} browser checks passed`);
if (process.env.AUDIT_JSON) (await import("node:fs")).writeFileSync(process.env.AUDIT_JSON, JSON.stringify(results, null, 2));
process.exit(fails ? 1 : 0);

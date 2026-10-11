/**
 * RESEARCH ENGINE PHASE 8 — the project brief, the language corpus, waves across runs.
 *
 *   1. the brief by sentence and by hand: each field one change, merged, read
 *      back, named in Changes/History; the editor's Brief section
 *   2. the language corpus: the History tab's language line counts the
 *      sentences said in this tab and the model's backlog; the export route
 *      returns the corpus with the readings and a replay
 *   3. waves across runs: the Findings tab's KPI table and "Since the last
 *      wave" from a run with a comparison; the deck and the report from the
 *      output route with a previous run — the wave slide and section present,
 *      absent without a previous run
 *
 *   node scripts/phase8-waves-corpus-brief-test.mjs      (studio on 3000, fake AI provider)
 */
import { chromium } from "/home/claude/.npm-global/lib/node_modules/playwright/index.mjs";
import assert from "node:assert/strict";
import { openTab, switchMode } from "./lib/nav.mjs";
import { def as synthDef, synthRows, spec } from "/home/claude/rescript/packages/analytics/dist/analyses/fixture.js";
import { buildDataset } from "/home/claude/rescript/packages/analytics/dist/dataset.js";
import { runPlan, compactRun } from "/home/claude/rescript/packages/analytics/dist/findings.js";
import { compareRuns } from "/home/claude/rescript/packages/analytics/dist/waves.js";

const STUDIO = process.env.STUDIO_URL ?? "http://localhost:3000";
let passed = 0;
const ok = (m) => { console.log("  ok  ", m); passed++; };

/* the synthetic tracker: KPIs on satisfaction and NPS, a gender hypothesis, a plan */
const FIXTURE = structuredClone(synthDef);
FIXTURE.meta = { ...FIXTURE.meta, id: "sandbox", code: "SANDBOX", title: "Satisfaction tracker" };
FIXTURE.research = {
  objective: "Track satisfaction and recommendation", population: "Adults 18+", methodology: "Online panel",
  hypotheses: ["Women are more satisfied than men", "Satisfaction differs by region"], hypothesisDetails: [], researchQuestions: [],
  kpis: [{ name: "Satisfaction", variable: "SAT", measure: "top-2-box share", target: "60%", direction: "higher" }, { name: "NPS", variable: "NPS", measure: "NPS" }],
  constructs: [{ name: "Satisfaction", role: "dependent", questionIds: ["q_sat"] }], analysis: [], assumptions: [], sources: [],
  analysisPlan: {
    crosstabs: [{ id: "x1", rows: ["SAT"], columns: ["GENDER"], priority: 1, hypotheses: ["H1"] }],
    tests: [{ id: "t1", method: "t_test", outcome: "SAT", variables: ["SAT"], groupBy: "GENDER", priority: 1, hypotheses: ["H1"] }, { id: "t2", method: "anova", outcome: "SAT", variables: ["SAT"], groupBy: "REGION", priority: 1, hypotheses: ["H2"] }],
    derived: [], segments: [],
  },
};
const ROWS1 = synthRows(400, 11);
const ROWS2 = ROWS1.map((r) => { const a = r.answers; const sat = Math.min(5, Number(a.q_sat) + (a.q_gender === 1 ? 1 : 0) + (a.q_region === 1 ? 1 : 0)); return { ...r, answers: { ...a, q_sat: sat, q_nps: Math.min(10, Number(a.q_nps) + 1) } }; });
const RUN1 = compactRun(runPlan(FIXTURE, buildDataset(FIXTURE, ROWS1, { spec }), { trigger: "first_results", now: "2026-09-01T10:00:00Z" }));
const run2full = runPlan(FIXTURE, buildDataset(FIXTURE, ROWS2, { spec }), { trigger: "halfway", now: "2026-10-01T10:00:00Z" });
run2full.since = compareRuns({ ...run2full, id: "r2" }, { ...RUN1, id: "r1" });
const RUN2 = compactRun(run2full);

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1700, height: 1150 } });
page.on("dialog", (d) => d.accept());
const errors = [];
page.on("console", (m) => { if (m.type() === "error" && !/favicon|Failed to load resource|net::ERR|status of (404|501|502|402|409|401|400)/.test(m.text())) errors.push(m.text()); });

const loadDef = async (def) => {
  await openTab(page, "JSON");
  await page.waitForSelector("textarea.code");
  await page.click('button:has-text("edit")');
  await page.$eval("textarea.code", (el, v) => { Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value").set.call(el, v); el.dispatchEvent(new Event("input", { bubbles: true })); }, JSON.stringify(def));
  await page.click('button:has-text("validate & apply")');
  await page.waitForTimeout(600);
};
const readDef = async () => { await openTab(page, "JSON"); await page.waitForSelector("textarea.code"); const json = await page.$eval("textarea.code", (e) => e.value); await intelligent(); return JSON.parse(json); };
const intelligent = async () => { await openTab(page, "Questions"); await switchMode(page, "intelligent"); await page.waitForSelector('[data-testid="intelligent-view"]'); };
const turns = () => page.$$('[data-testid="cp-turn"]');
const settled = async (n) => {
  await page.waitForFunction((k) => { const t = document.querySelectorAll('[data-testid="cp-turn"]'); return t.length > k && t[t.length - 1].getAttribute("data-status") !== "thinking"; }, n, { timeout: 60000 });
  await page.waitForTimeout(300);
  return (await turns()).at(-1);
};
const say = async (text) => { const n = (await turns()).length; await page.fill('[data-testid="iq-input"]', text); await page.keyboard.press("Enter"); return settled(n); };
const textOf = async (h) => (await h.evaluate((e) => e.innerText)).replace(/\s+/g, " ");
const apply = async () => { if (await page.$('[data-testid="cp-confirm"]')) await page.check('[data-testid="cp-confirm"]'); await page.click('[data-testid="cp-apply"]'); await page.waitForTimeout(600); };
const tab = async (id) => { if (!(await page.$(`[data-testid="cp-tab-${id}"]`))) await page.click('[data-testid="iq-toggle-inspector"]'); await page.click(`[data-testid="cp-tab-${id}"]`); await page.waitForTimeout(150); };
const RD = '.settings-wrap [data-testid="research-design"]';

await page.goto(`${STUDIO}/sandbox?mode=studio`, { waitUntil: "networkidle" });
await page.waitForSelector(".menubar");
await loadDef(FIXTURE);
await intelligent();
if (!(await page.evaluate(() => typeof window.__rescriptCopilotFake === "function"))) { console.log("  skip  no fake copilot provider in this build"); await browser.close(); process.exit(0); }

/* ------------------------------------------------ 1. the brief */
{
  let t = await say("the client is Acme Foods");
  assert.equal(await (await t.$('[data-testid="cp-engine-detail"]')).getAttribute("data-kind"), "actions");
  assert.match(await textOf(t), /Set the brief's client to “Acme Foods”/);
  await apply();
  t = await say("set the business question to Should we keep investing in service?");
  await apply();
  t = await say("this study informs the decision to fund the 2027 service programme");
  assert.match(await textOf(t), /Set the brief's decision to “whether to fund the 2027 service programme”/);
  await apply();
  t = await say("the stakeholders are the CMO and the brand team");
  await apply();
  t = await say("add stakeholder: the CFO");
  assert.match(await textOf(t), /Add the CFO to the brief's stakeholders/);
  await apply();
  t = await say("the findings are due by 30 November 2026");
  await apply();
  t = await say("the client is Acme Foods");
  assert.equal(await (await t.$('[data-testid="cp-engine-detail"]')).getAttribute("data-kind"), "refused");
  assert.match(await textOf(t), /already the client/);
  t = await say("what is the brief?");
  assert.equal(await (await t.$('[data-testid="cp-engine-detail"]')).getAttribute("data-kind"), "answer");
  assert.match(await textOf(t), /client — Acme Foods; business question — Should we keep investing in service\?; decision it informs — whether to fund the 2027 service programme; stakeholders — the CMO, the brand team, the CFO; deadline — 30 November 2026/);
  const def = await readDef();
  assert.deepEqual(def.research.brief, { client: "Acme Foods", businessQuestion: "Should we keep investing in service?", decision: "whether to fund the 2027 service programme", stakeholders: ["the CMO", "the brand team", "the CFO"], deadline: "30 November 2026", deliverables: [] });
  assert.equal(def.research.objective, "Track satisfaction and recommendation", "the rest of the design untouched");
  // History names the field; the editor shows and edits the brief
  await tab("history");
  const prompts = await page.$$eval('[data-testid="cp-op-prompt"]', (es) => es.map((e) => e.textContent));
  assert.ok(prompts.some((p) => /add stakeholder: the CFO/.test(p)), prompts.join(" | "));
  await openTab(page, "Survey Settings");
  await page.waitForSelector(`${RD} [data-testid="rd-brief"]`);
  assert.equal(await page.inputValue(`${RD} [data-testid="rd-brief-client"]`), "Acme Foods");
  assert.equal(await page.inputValue(`${RD} [data-testid="rd-brief-decision"]`), "whether to fund the 2027 service programme");
  assert.equal((await page.$$(`${RD} [data-testid="rd-stakeholder"]`)).length, 3);
  assert.equal(await page.$(`${RD} [data-testid="rd-brief-copy"]`), null, "the sandbox has no other projects to copy from");
  await page.fill(`${RD} [data-testid="rd-brief-background"]`, "Satisfaction fell in 2025");
  await page.fill(`${RD} [data-testid="rd-deliverable-new"]`, "a findings report");
  await page.click(`${RD} [data-testid="rd-deliverable-add"]`);
  await page.waitForTimeout(200);
  const def2 = await readDef();
  assert.equal(def2.research.brief.background, "Satisfaction fell in 2025");
  assert.deepEqual(def2.research.brief.deliverables, ["a findings report"]);
  assert.equal(def2.research.brief.client, "Acme Foods");
  // the proposal from the output route carries it
  const proposal = await page.evaluate(async (definition) => {
    const r = await fetch("/api/copilot/output", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ surveyId: "sandbox", output: { type: "proposal_docx", audience: "client" }, definition }) });
    return { status: r.status, size: (await r.arrayBuffer()).byteLength, disposition: r.headers.get("content-disposition") };
  }, def2);
  assert.equal(proposal.status, 200); assert.ok(proposal.size > 5000);
  ok("the brief: each sentence one field, merged, refused when already so, read back; History names it; the editor shows and edits it; the proposal is produced from it");
}

/* ------------------------------------------------ 2. the language corpus */
{
  await say("rewrite Q4 in a friendlier tone");
  await say("rewrite Q4 in a friendlier tone");
  await say("make Q2 required");
  await tab("history");
  await page.waitForSelector('[data-testid="cp-language"]');
  const total = Number(await page.getAttribute('[data-testid="cp-language"]', "data-total"));
  const engine = Number(await page.getAttribute('[data-testid="cp-language"]', "data-engine"));
  const backlog = Number(await page.getAttribute('[data-testid="cp-language"]', "data-backlog"));
  assert.ok(total >= 9, `${total} sentences`);
  assert.equal(backlog, 1, `the one sentence the engine hands to the model, said twice but counted once (total ${total}, engine ${engine}, backlog ${backlog}: ${await page.textContent('[data-testid="cp-language"] summary')})`);
  assert.equal(engine, total - 1);
  await page.click('[data-testid="cp-language"] summary');
  const sentences = await page.$$eval('[data-testid="cp-language-sentence"]', (es) => es.map((e) => e.textContent));
  assert.deepEqual(sentences, ["2× “rewrite Q4 in a friendlier tone”"]);
  // the route: the corpus with the readings, replayed
  const scope = await page.evaluate(() => window.sessionStorage.getItem("rescript.sandboxHistory"));
  const def = await readDef();
  const out = await page.evaluate(async ({ definition, scope }) => {
    const r = await fetch("/api/copilot/corpus", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ surveyId: "sandbox", scope, definition, replay: true }) });
    return { status: r.status, body: await r.json() };
  }, { definition: def, scope });
  assert.equal(out.status, 200, JSON.stringify(out.body).slice(0, 200));
  const { corpus, replay } = out.body;
  assert.equal(corpus.version, 1);
  assert.equal(corpus.entries.length, total);
  const rewrite = corpus.entries.find((e) => e.text === "rewrite Q4 in a friendlier tone");
  assert.deepEqual([rewrite.kind, rewrite.count, rewrite.category], ["model", 2, "question_modification"]);
  const required = corpus.entries.find((e) => e.text === "make Q2 required");
  assert.deepEqual([required.kind, required.ops], ["actions", ["update_question"]]);
  const client = corpus.entries.find((e) => e.text === "the client is Acme Foods");
  assert.deepEqual([client.kind, client.count, client.ops], ["refused", 2, undefined], "the last reading of a sentence said twice — the second was refused as already so");
  assert.equal(replay.counts.worse, 0);
  assert.deepEqual(replay.backlog.map((e) => e.text), ["rewrite Q4 in a friendlier tone"]);
  // the brief's sentences were actions when said and are "already so" against the survey as it is now: changed, honestly, and nothing worse
  assert.ok(replay.results.every((r) => r.verdict === "same" || r.why === "was actions, now refused"), JSON.stringify(replay.results.filter((r) => r.verdict !== "same")));
  assert.ok(replay.results.some((r) => r.verdict === "changed"));
  // the download
  const dl = await page.evaluate(async ({ definition, scope }) => {
    const r = await fetch("/api/copilot/corpus", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ surveyId: "sandbox", scope, definition, download: true }) });
    return { disposition: r.headers.get("content-disposition"), type: r.headers.get("content-type"), ok: (await r.json()).version === 1 };
  }, { definition: def, scope });
  assert.equal(dl.disposition, 'attachment; filename="satisfaction-tracker-language-corpus.json"');
  assert.ok(dl.ok);
  ok("the language corpus: History counts the sentences and the model's backlog; the route gives the corpus with every reading and replays it; the file downloads");
}

/* ------------------------------------------------ 3. waves across runs */
{
  await intelligent();
  await page.evaluate((rows) => window.__rescriptAnalyticsRows(rows), ROWS2);
  await page.evaluate((r) => window.__rescriptAnalysisRun(r), RUN2);
  await tab("findings");
  await page.waitForSelector('[data-testid="fd-kpis"]');
  const rows = await page.$$eval('[data-testid="fd-kpi"]', (es) => es.map((e) => [e.getAttribute("data-name"), e.getAttribute("data-verdict"), e.getAttribute("data-significant")]));
  assert.deepEqual(rows[0], ["Satisfaction", "better", "true"], JSON.stringify(rows));
  assert.equal(rows[1][0], "NPS");
  assert.match(await page.textContent('[data-testid="fd-kpi"] >> nth=0 >> [data-testid="fd-kpi-delta"]'), /^\+[\d.]+ pts ● better$/);
  await page.waitForSelector('[data-testid="fd-since"]');
  assert.match(await page.textContent('[data-testid="fd-since-summary"]'), /^Since the previous run \(2026-09-01, 400 completes → 400\) · \d of 2 KPIs moved/);
  assert.ok(Number(await page.getAttribute('[data-testid="fd-since"]', "data-changed")) >= 1);
  assert.ok((await page.$$('[data-testid="fd-since-verdict"]')).length >= 1, "a verdict changed (the region effect was planted in the second wave)");
  // the deck and the report from the output route: with the previous run, the wave slide and section; without, none
  const def = await readDef();
  const outputs = await page.evaluate(async ({ definition, rows, previous }) => {
    const get = async (type, prev) => {
      const r = await fetch("/api/copilot/output", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ surveyId: "sandbox", output: { type, audience: "client" }, definition, rows, narrative: false, ...(prev ? { previous: prev } : {}) }) });
      const buf = new Uint8Array(await r.arrayBuffer());
      let s = ""; for (let i = 0; i < buf.length; i++) s += String.fromCharCode(buf[i]);
      return { status: r.status, what: r.headers.get("x-rescript-output"), slides: (s.match(/ppt\/slides\/slide\d+\.xml/g) ?? []).filter((v, i, a) => a.indexOf(v) === i).length };
    };
    return { deckWith: await get("findings_pptx", previous), deckWithout: await get("findings_pptx", null), reportWith: await get("findings_docx", previous), reportWithout: await get("findings_docx", null) };
  }, { definition: def, rows: ROWS2, previous: RUN1 });
  assert.equal(outputs.deckWith.status, 200);
  assert.match(outputs.deckWith.what, /wave change/, outputs.deckWith.what);
  assert.doesNotMatch(outputs.deckWithout.what, /wave change/);
  assert.equal(outputs.deckWith.slides, outputs.deckWithout.slides + 1, "one slide more: since the last wave");
  assert.match(outputs.reportWith.what, /since the last wave \(2026-09-01\)/);
  assert.doesNotMatch(outputs.reportWithout.what, /since the last wave/);
  ok("waves across runs: the KPI table with the move and its significance, 'since the last wave' with the changed findings and verdicts; the deck gets its slide and the report its section only with a previous run");
}

assert.deepEqual(errors, [], `console errors: ${errors.join("\n")}`);
await browser.close();
console.log(`\n${passed} passed`);

/**
 * ASSESSMENTS IN THE STUDIO — END TO END IN A BROWSER (K4's suite ported to the current UI, step 4B 2026-10-29;
 * docs/ASSESSMENTS-2026-10-29.md part B).
 *
 *   1. An ordinary survey sees nothing new: no Assessment section in Properties, one unticked checkbox in Settings.
 *   2. Survey Settings → Assessment: "This survey is a test or quiz" → marking (+2 / −0.66), pass mark; the
 *      "per question during the paper" policy shows the visible key-in-the-browser warning; back to after submit.
 *   3. Properties → Assessment on every question: correct option, topic, explanation, a mistake note, one per-question
 *      mark override — written into question.assessment (read back from the JSON tab); the Settings chip says valid.
 *   4. Take the test (sandbox runtime, /x/<token>, the respondent's view): NO runtime payload and not the page source
 *      carries a key, an explanation or a mistake note before submission; answer (some right, some wrong) → submit →
 *      the results page: score = the marking, every question with selected / correct / explanation, topics, weak
 *      areas; reload → re-scored on the server, identical.
 *   5. Data Analytics → Assessment results (the analytics page's survey list and workspace endpoints are faked as in
 *      analytics-test.mjs — there is no database here; the card and /api/surveys/sandbox/assessment are real):
 *      n = 1, pass rate, distribution, topic table, item analysis per question; "Download Word" → a .docx.
 *
 *   cd /home/claude/rescript && flock /tmp/p0/heavy.lock /tmp/p0/fresh.sh assessment-test.mjs
 *   (studio :3000 and runtime :3001 with AI_API_URL=fake: and no database)
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { chromium } from "./lib/playwright.mjs";
import { openTab } from "./lib/nav.mjs";

const STUDIO = process.env.STUDIO_URL ?? "http://localhost:3000";
const RUNTIME = process.env.RUNTIME_URL ?? "http://localhost:3001";
let passed = 0;
let step = 0;
const ok = (m) => { console.log("  ok  ", m); passed++; };
const errors = [];
const at = (n, what) => { step = n; console.log(`\n§${n} ${what}`); };

const OPTS = ["Article 14", "Article 19", "Article 21", "Article 32"];
const TOPICS = ["Polity", "Polity", "Polity", "Economy", "Economy", "Economy"];
const KEY = [3, 2, 4, 1, 2, 3];          // the correct option code per question
const FIXTURE = {
  meta: { id: "sandbox", code: "GSQ", title: "GS practice quiz", version: "1.0" },
  questions: KEY.map((_, i) => ({ id: `q${i + 1}`, code: `Q${i + 1}`, variableName: `Q${i + 1}`, type: "single_select", text: `General Studies question ${i + 1}`, required: true, options: OPTS.map((label, j) => ({ code: j + 1, label: `${label} (${i + 1})` })) })),
  flow: [{ type: "page", id: "p1", questionIds: ["q1", "q2", "q3"] }, { type: "page", id: "p2", questionIds: ["q4", "q5", "q6"] }, { type: "end", id: "e1", status: "complete" }],
};
const EXPL = (i) => `Explanation-${i + 1}: option ${KEY[i]} is the right one because of the constitutional text ${i + 1}.`;
const MISTAKE = "Mistake-note-Q1: Article 14 is about equality before law, not life and liberty.";

async function retry(what, fn, { tries = 6, wait = 4000 } = {}) {
  let last;
  for (let i = 0; i < tries; i++) {
    try { return await fn(); } catch (e) { last = e; console.log(`  …  ${what}: ${String(e.message ?? e).slice(0, 160)} — retrying`); await new Promise((r) => setTimeout(r, wait)); }
  }
  throw last;
}
async function waitUp(url) { await retry(`waiting for ${url}`, async () => { const r = await fetch(url); if (r.status >= 500) throw new Error(`${r.status}`); }, { tries: 40, wait: 3000 }); }

await waitUp(`${STUDIO}/sandbox`);
await waitUp(`${RUNTIME}/preview`);

const browser = await chromium.launch();
const context = await browser.newContext({ viewport: { width: 1600, height: 1100 }, acceptDownloads: true });
const page = await context.newPage();
page.on("pageerror", (e) => errors.push(`studio: ${e.message}`));
page.on("dialog", (d) => d.accept());

try {
  const readDef = async () => {
    await openTab(page, "JSON");
    await page.waitForSelector("textarea.code");
    return JSON.parse(await page.$eval("textarea.code", (e) => e.value));
  };
  const selectQuestion = async (i) => {
    await openTab(page, "Questions").catch(() => undefined);
    await page.waitForSelector(".qcard");
    const cards = await page.$$(".qcard");
    await cards[i].click();
    await page.waitForSelector(`h2:has-text("Q${i + 1} properties")`, { timeout: 15000 });
  };
  const openSection = async () => {
    await page.waitForSelector('[data-testid="psec-head-assessment"]', { timeout: 15000 });
    if (!(await page.$('[data-testid="assessment-section"]'))) await page.click('[data-testid="psec-head-assessment"]');
    await page.waitForSelector('[data-testid="assessment-section"]');
  };

  /* ====================================================== 1. an ordinary survey */
  at(1, "an ordinary survey sees nothing new");
  await retry("open the Studio sandbox", async () => {
    await page.goto(`${STUDIO}/sandbox`, { waitUntil: "load", timeout: 90000 });
    await page.waitForSelector(".menubar", { timeout: 90000 });
  });
  await openTab(page, "JSON");
  await page.waitForSelector("textarea.code");
  await page.click('button:has-text("edit")');
  await page.fill("textarea.code", JSON.stringify(FIXTURE, null, 2));
  await page.click('button:has-text("validate & apply")');
  await page.waitForTimeout(400);
  assert.equal((await readDef()).questions.length, 6);
  await selectQuestion(0);
  assert.equal(await page.$('[data-testid="psec-head-assessment"]'), null, "no Assessment section on a choice question of an ordinary survey");
  await openTab(page, "Survey Settings");
  await page.waitForSelector('[data-testid="assessment-settings"]');
  assert.equal(await page.isChecked('[data-testid="assessment-enabled"]'), false);
  assert.equal(await page.$('[data-testid="assessment-default-marks"]'), null, "nothing but the checkbox until it is ticked");
  ok("ordinary survey: no Properties → Assessment section; Survey Settings shows one unticked “This survey is a test or quiz” checkbox and nothing else");

  /* ====================================================== 2. settings */
  at(2, "Survey Settings → Assessment");
  await page.check('[data-testid="assessment-enabled"]');
  await page.waitForSelector('[data-testid="assessment-default-marks"]');
  await page.fill('[data-testid="assessment-default-marks"]', "2");
  await page.fill('[data-testid="assessment-default-negative"]', "0.66");
  await page.fill('[data-testid="assessment-pass-percent"]', "50");
  assert.equal(await page.$('[data-testid="assessment-per-question-warning"]'), null, "no warning under after-submit");
  await page.selectOption('[data-testid="assessment-show"]', "per_question");
  await page.waitForSelector('[data-testid="assessment-per-question-warning"]');
  assert.match(await page.textContent('[data-testid="assessment-per-question-warning"]'), /answer key in the respondent.s browser/);
  await page.selectOption('[data-testid="assessment-show"]', "after_submit");
  await page.waitForSelector('[data-testid="assessment-per-question-warning"]', { state: "detached" });
  for (const k of ["summary", "perQuestion", "explanations", "topicBreakdown", "weakAreas", "recommendations"]) assert.equal(await page.isChecked(`[data-testid="assessment-sec-${k}"]`), true, `report section ${k} on by default`);
  let def = await readDef();
  assert.equal(def.assessment.enabled, true);
  assert.equal(def.assessment.defaultMarks, 2);
  assert.equal(def.assessment.defaultNegativeMarks, 0.66);
  assert.equal(def.assessment.passPercent, 50);
  assert.equal(def.assessment.showResults, "after_submit");
  ok("ticked: marking +2 / −0.66, pass 50 %; “per question during the paper” shows the visible key-in-the-browser warning, gone again on “after submitting”; six report sections on");

  /* ====================================================== 3. the key editor */
  at(3, "Properties → Assessment on every question");
  for (let i = 0; i < 6; i++) {
    await selectQuestion(i);
    await openSection();
    await page.click('[data-testid="assessment-enable-q"]');
    await page.waitForSelector(`[data-testid="assessment-correct-${KEY[i]}"]`);
    await page.check(`[data-testid="assessment-correct-${KEY[i]}"]`);
    await page.fill('[data-testid="assessment-topic"]', TOPICS[i]);
    await page.fill('[data-testid="assessment-explanation"]', EXPL(i));
    if (i === 0) {
      await page.click('[data-testid="assessment-optexp-toggle"]');
      await page.fill('[data-testid="assessment-optexp-1"]', MISTAKE);
    }
    if (i === 5) await page.fill('[data-testid="assessment-marks"]', "4");
    await page.waitForTimeout(150);
  }
  def = await readDef();
  for (let i = 0; i < 6; i++) {
    const a = def.questions[i].assessment;
    assert.ok(a, `Q${i + 1} keyed`);
    assert.deepEqual(a.correct.map(String), [String(KEY[i])], `Q${i + 1}: key`);
    assert.equal(a.topic, TOPICS[i]);
    assert.equal(a.explanation, EXPL(i));
  }
  assert.equal(def.questions[0].assessment.optionExplanations["1"], MISTAKE);
  assert.equal(def.questions[5].assessment.marks, 4);
  await openTab(page, "Survey Settings");
  await page.waitForSelector('[data-testid="assessment-validation"]');
  assert.equal(await page.getAttribute('[data-testid="assessment-validation"]', "data-ok"), "1");
  assert.equal(await page.getAttribute('[data-testid="assessment-validation"]', "data-graded"), "6");
  ok("six questions keyed through Properties → Assessment (key, topic, explanation; a mistake note on Q1; Q6 worth 4) — in question.assessment; Settings says “6 scored questions — the paper is valid”");

  /* ====================================================== 4. take the test as a respondent */
  at(4, "take the test (/x/<token>): no key before submit, the report after");
  const payloads = [];
  context.on("response", async (r) => {
    if (!r.url().startsWith(RUNTIME) || /\/_next\/static\//.test(r.url())) return;
    try { payloads.push({ url: r.url(), body: await r.text() }); } catch { /* a redirect / aborted */ }
  });
  const secrets = [MISTAKE, ...KEY.map((_, i) => EXPL(i))];
  const leaks = (text) => secrets.filter((s) => text.includes(s)).length + (/\\?"correct\\?":\[\s*[^\]\s]/.test(text) ? 1 : 0) + (/\\?"optionExplanations\\?":\{/.test(text) ? 1 : 0);
  const [tk] = await Promise.all([context.waitForEvent("page", { timeout: 60000 }), page.click('[data-testid="assessment-take"]')]);
  tk.on("pageerror", (e) => errors.push(`runtime: ${e.message}`));
  await tk.waitForURL(/\/x\/[0-9a-f]{24}/, { timeout: 120000 });
  await tk.waitForSelector('[data-rs-el="question"]', { timeout: 120000 });
  assert.equal(leaks(await tk.content()), 0, "no key, explanation or mistake note in the page source");
  // Q1, Q3, Q5 right; Q2, Q4, Q6 wrong
  const choice = (i) => (i % 2 === 0 ? KEY[i] : (KEY[i] % 4) + 1);
  let pages = 0;
  while (!(await tk.$('[data-testid="rs-ended"]')) && pages < 6) {
    pages++;
    const ids = await tk.$$eval('[data-rs-el="question"]', (qs) => qs.map((q) => q.getAttribute("data-rs-id")));
    for (const id of ids) {
      const i = Number(id.slice(1)) - 1;
      await tk.click(`[data-rs-el="question"][data-rs-id="${id}"] [data-rs-el="option"][data-rs-id="${choice(i)}"]`);
    }
    const leaked = payloads.filter((p) => leaks(p.body) > 0).map((p) => p.url);
    assert.deepEqual(leaked, [], `no key / explanation in any runtime payload before submission (page ${pages})`);
    await tk.click('[data-testid="rs-next"]');
    await tk.waitForFunction((first) => document.querySelector('[data-testid="rs-ended"]') || (document.querySelector('[data-rs-el="question"]') && document.querySelector('[data-rs-el="question"]').getAttribute("data-rs-id") !== first), ids[0], { timeout: 30000 });
  }
  const before = payloads.length;
  await tk.waitForFunction(() => document.querySelector('[data-testid="assessment-report"]') || document.querySelector('[data-testid="assessment-error"]'), null, { timeout: 60000 });
  const err = await tk.$('[data-testid="assessment-error"]');
  if (err) throw new Error(`results: ${await err.textContent()}`);
  ok(`answered ${pages} pages as a respondent; ${before} runtime payloads and the page source carried no key, explanation or mistake note before submission`);

  const rows = await tk.$$eval('[data-testid="assessment-q"]', (es) => es.map((e) => ({ status: e.getAttribute("data-status"), selected: e.querySelector('[data-testid="assessment-q-selected"]')?.textContent ?? "", correct: e.querySelector('[data-testid="assessment-q-correct"]')?.textContent ?? "", explanation: e.querySelector('[data-testid="assessment-q-explanation"]')?.textContent ?? "", mistake: e.querySelector('[data-testid="assessment-q-mistake"]')?.textContent ?? "" })));
  assert.equal(rows.length, 6, "every question in the report");
  rows.forEach((r, i) => {
    assert.equal(r.status, i % 2 === 0 ? "correct" : "incorrect", `Q${i + 1} status`);
    assert.ok(r.correct.includes(`${OPTS[KEY[i] - 1]} (${i + 1})`), `Q${i + 1}: the correct answer is shown`);
    assert.ok(r.selected.includes(`${OPTS[choice(i) - 1]} (${i + 1})`), `Q${i + 1}: what was selected is shown`);
    assert.ok(r.explanation.includes(`Explanation-${i + 1}`), `Q${i + 1}: the explanation is shown`);
  });
  // right: Q1 Q3 Q5 = 3 × 2 = 6; wrong: Q2 Q4 −0.66 each, Q6 (worth 4) −0.66 → 6 − 1.98 = 4.02 of 14
  const expectMarks = 4.02;
  const shown = Number((await tk.textContent('[data-testid="assessment-score"]')).replace(/[^\d.−-]/g, "").replace("−", "-"));
  assert.equal(shown, expectMarks, `score ${shown} = 3×2 − 3×0.66`);
  assert.ok((await tk.$$('[data-testid="assessment-topics"] tbody tr')).length >= 2, "topic breakdown");
  assert.ok(await tk.$('[data-testid="assessment-weak"]'), "weak areas");
  assert.ok(await tk.$('[data-testid="assessment-verdict"]'), "pass / fail verdict");
  ok(`results page: 6 questions — 3 correct, 3 incorrect — each with the selected and the correct answer and the explanation; topic table; weak areas; score ${shown} = +2 / −0.66 marking`);

  if (/[?&]attempt=/.test(tk.url())) {
    await tk.reload({ waitUntil: "load" });
    await tk.waitForSelector('[data-testid="assessment-attempt"]', { timeout: 30000 });
    assert.equal(await tk.getAttribute('[data-testid="assessment-attempt"]', "data-reproduced"), "1");
    assert.equal(Number(await tk.getAttribute('[data-testid="assessment-attempt"]', "data-score")), expectMarks);
    ok("reload: re-scored on the server from the stored answers, identical (data-reproduced=1, same score)");
  } else {
    throw new Error("the take page did not record the attempt in its URL");
  }
  await tk.close();

  /* ====================================================== 5. Data Analytics → Assessment results */
  at(5, "Data Analytics → Assessment results card, Word download");
  const json = (route, body, status = 200) => route.fulfill({ status, contentType: "application/json", body: JSON.stringify(body) });
  await context.addCookies([{ name: "rescript_session", value: "fake", url: STUDIO }]);
  const user = { userId: "u1", userCode: "U-0001", name: "Ana Lyst", email: "ana@example.com", platformRole: "user", isPlatformAdmin: false, sessionId: "s1", unread: 0, policies: { heartbeatSeconds: 600 } };
  await page.route("**/api/auth/me", (r) => json(r, user));
  await page.route("**/api/auth/heartbeat**", (r) => json(r, { ok: true }));
  await page.route("**/api/surveys", (r) => json(r, { surveys: [{ id: "sandbox", code: "GSQ", title: "GS practice quiz", status: "draft", myRole: "owner", roleSource: "owner", updated_at: new Date().toISOString(), version: null }] }));
  const fakeAnalytics = (r) => {
    const path = new URL(r.request().url()).pathname.replace("/api/surveys/sandbox/analytics", "").replace(/^\//, "");
    if (path === "variables") return json(r, { variables: [], counts: { LIVE: 0, TEST: 0 }, surveyVersion: null, revision: null });
    if (path === "home") return json(r, { analyses: [], charts: [], reports: [], shares: [] });
    if (path === "access") return json(r, { capabilities: null });
    if (path === "report-templates") return json(r, { templates: [], available: true });
    return json(r, { items: [] });
  };
  await page.route("**/api/surveys/sandbox/analytics/**", fakeAnalytics);
  await page.route("**/api/surveys/sandbox/analytics", fakeAnalytics);
  await page.goto(`${STUDIO}/analytics?survey=sandbox`, { waitUntil: "load", timeout: 90000 });
  await page.waitForSelector('[data-testid="ax-assessment"]', { timeout: 60000 });
  await page.waitForSelector('[data-testid="assessment-analytics"]', { timeout: 30000 });
  assert.equal(await page.getAttribute('[data-testid="assessment-analytics"]', "data-n"), "1");
  assert.match(await page.textContent('[data-testid="assessment-an-pass"]'), /^0%$/, "4.02 of 14 = 28.7 % < 50 %: pass rate 0 %");
  const bars = await page.$$eval('[data-testid="assessment-distribution"] > div', (es) => es.map((e) => Number(e.getAttribute("data-count"))));
  assert.equal(bars.length, 10); assert.equal(bars.reduce((a, b) => a + b, 0), 1); assert.equal(bars[2], 1, "28.7 % in the 20–30 band");
  assert.equal((await page.$$('[data-testid="assessment-topic-table"] tbody tr')).length, 2, "topic table: Polity, Economy");
  assert.equal((await page.$$('[data-testid="assessment-items"] tbody tr')).length, 6, "item analysis per question");
  const [dl] = await Promise.all([page.waitForEvent("download", { timeout: 60000 }), page.click('[data-testid="ax-assessment-docx"]')]);
  const buf = readFileSync(await dl.path());
  assert.equal(buf.subarray(0, 2).toString(), "PK", "a Word file");
  assert.match(dl.suggestedFilename(), /\.docx$/);
  ok(`Data Analytics → Assessment results: n = 1, pass rate 0 %, distribution (20–30 % band), topic table (2), item analysis (6); Download Word → ${dl.suggestedFilename()} (${buf.length} bytes)`);

  const real = errors.filter((e) => !/ResizeObserver|hydrat/i.test(e));
  assert.deepEqual(real, [], "no page errors");
  console.log(`\nassessment-test: ${passed} checks passed`);
} catch (e) {
  console.error(`\nFAILED at step ${step}: ${e.stack ?? e}`);
  await page.screenshot({ path: `/tmp/p0/assessment-fail-${step}.png` }).catch(() => undefined);
  process.exitCode = 1;
} finally {
  await browser.close();
}

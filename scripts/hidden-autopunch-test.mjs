/**
 * HIDDEN QUESTIONS, AUTO-PUNCH VISUALISATION AND THE STALE PREVIEW (client
 * brief 19/10/2026, items A15 and A66 — docs/HIDDEN-AUTOPUNCH-2026-10-24.md).
 *
 *   1. Properties → State has Hidden and no Read Only; ticking Hidden stores
 *      `settings.hidden`.
 *   2. The Studio's Preview (the real popup, pushed by postMessage) shows the
 *      hidden Q2 on its own page in the purple hidden-question theme: banner,
 *      "HIDDEN QUESTION — PREVIEW MODE", "Q2 — HIDDEN", footer; Q3 is plain.
 *   3. Auto punch from Q1: the punched option is painted green with an
 *      AUTO-PUNCHED badge, the status line reads Applied, the details say
 *      TRUE; it follows the source answer (Nike → No Matching Condition, the
 *      stale punch withdrawn); a manual pick is not green; a required hidden
 *      question never blocks Next.
 *   4. Stale preview (A66): changing the punch target in the builder while the
 *      preview is open re-punches Q2 (Puma) and keeps Q1 / Q3 / Q4; reopening
 *      Preview (the tab reloads and resumes from sessionStorage) shows the
 *      new value, keeps the unrelated answers, stays on the same page; a
 *      reload with no change clears nothing.
 *   5. "As a respondent" (what a live link renders): Q2's page is skipped —
 *      no text, no options, no banner, no empty page — while the response
 *      data still carries the punched value.
 *
 * The /t and /s routes set the mode server-side from a deployment row and
 * need a database, which this environment does not have; the engine unit
 * test (hiddenPreview.test.ts) covers `revealsHiddenQuestions("test")`, and
 * the Runner takes the same `reveal` path for test and preview.
 *
 *   STUDIO_URL=http://localhost:3000 RUNTIME_URL=http://localhost:3001 node scripts/hidden-autopunch-test.mjs
 */
import { openHarness, assert } from "./lib/variantHarness.mjs";

const h = await openHarness();
const { page } = h;
const runtime = process.env.RUNTIME_URL ?? "http://localhost:3001";
let passed = 0;
const ok = (m) => { console.log("  ok  ", m); passed++; };

const brands = (id, code, type = "single_select", extra = {}) => ({
  id, code, variableName: code, type, text: `${code}: which brand?`,
  options: [{ code: "nike", label: "Nike" }, { code: "adidas", label: "Adidas" }, { code: "puma", label: "Puma" }],
  settings: {}, ...extra,
});
const punch = (codes) => ({
  id: "p_q2", source: { kind: "codes", codes }, action: "select", mapping: [], ignoreUnmatched: true, recompute: "always",
  when: { type: "rule", source: { kind: "question", ref: "q1" }, operator: "selected", value: "adidas" },
});
const fixture = () => ({
  meta: { id: "sandbox", code: "SANDBOX", title: "Hidden + auto punch", version: "1.0" },
  questions: [
    brands("q1", "Q1"),
    brands("q2", "Q2", "single_select", { required: true, punches: [punch(["adidas"])] }),
    brands("q3", "Q3", "multi_select"),
    { id: "q4", code: "Q4", variableName: "Q4", type: "open_text", text: "Q4: anything else?", settings: {} },
  ],
  flow: [
    { type: "page", id: "p1", questionIds: ["q1"] },
    { type: "page", id: "p2", questionIds: ["q2"] },
    { type: "page", id: "p3", questionIds: ["q3", "q4"] },
    { type: "end", id: "e1", status: "complete" },
  ],
});

/* ---------------------------------------------------------------- helpers */
const retry = async (fn, { tries = 6, wait = 1500 } = {}) => {
  let last;
  for (let i = 0; i < tries; i++) {
    try { return await fn(); } catch (e) { last = e; await page.waitForTimeout(wait); }
  }
  throw last;
};
const state = (pv) => pv.evaluate(() => (window.__rescriptState ? { answers: { ...window.__rescriptState.answers }, stepIndex: window.__rescriptState.stepIndex } : null));
const tick = (pv, qid, code) => pv.click(`[data-qid="${qid}"] input[value="${code}"]`);
const next = async (pv) => { await pv.click('[data-testid="rs-next"]'); await pv.waitForTimeout(450); };
const back = async (pv) => { await pv.click('[data-testid="rs-back"]'); await pv.waitForTimeout(450); };
const bg = (pv, sel) => pv.$eval(sel, (el) => getComputedStyle(el).backgroundColor);
const after = (pv, sel) => pv.$eval(sel, (el) => getComputedStyle(el, "::after").content);
const waitPreviewPage = async (pv, qid) => {
  await pv.waitForSelector(`[data-qid="${qid}"]`, { timeout: 30000 });
};
/** the Studio's own Preview button; the popup is the real /preview tab the Studio pushes into */
const clickPreview = () => page.click('button[title^="Full-page preview"]');

/* ====================================================== 1. State: Hidden only */
await h.loadDef(fixture());
await h.goTab("Questions");
await page.waitForSelector('[data-testid="qcard"][data-qid="q2"]');
await page.click('[data-testid="qcard"][data-qid="q2"] .qcard-text');
await page.waitForSelector('[data-testid="psec-head-state"]');
if ((await page.getAttribute('[data-testid="psec-head-state"]', "aria-expanded")) !== "true") await page.click('[data-testid="psec-head-state"]');
await page.waitForSelector('[data-testid="state-hidden"]');
const stateText = await page.textContent('[data-testid="psec-state"]');
assert.doesNotMatch(stateText, /read-only|read only|readOnly/i, "Read Only is gone from the State section");
assert.match(stateText, /hidden/i);
assert.equal(await page.isChecked('[data-testid="state-hidden"]'), false);
await page.check('[data-testid="state-hidden"]');
await page.waitForSelector('[data-testid="state-hidden-note"]');
let def = await h.readDef();
assert.equal(def.questions.find((q) => q.id === "q2").settings.hidden, true, "ticking Hidden stores settings.hidden");
assert.equal(def.questions.find((q) => q.id === "q2").settings.readOnly ?? false, false, "nothing else in settings changed");
ok("Properties → State: only Hidden (Read Only removed); the tick stores settings.hidden and nothing else");

/* an older definition carrying readOnly: true still loads, says so, and can be cleared */
await h.setQuestion("q4", (q) => { q.settings = { ...q.settings, readOnly: true }; });
await h.goTab("Questions");
await page.click('[data-testid="qcard"][data-qid="q4"] .qcard-text');
await page.waitForSelector('[data-testid="psec-head-state"]');
if ((await page.getAttribute('[data-testid="psec-head-state"]', "aria-expanded")) !== "true") await page.click('[data-testid="psec-head-state"]');
await page.waitForSelector('[data-testid="state-legacy-readonly"]');
await page.click('[data-testid="state-clear-readonly"]');
def = await h.readDef();
assert.equal(def.questions.find((q) => q.id === "q4").settings.readOnly, false, "the legacy flag is cleared");
assert.equal(def.questions.find((q) => q.id === "q2").settings.hidden, true, "Q2 is still hidden");
ok("A legacy readOnly: true is tolerated, shown as legacy in State, and cleared with one click");

/* ============================================ 2 + 3. the Studio preview popup */
await h.goTab("Questions");
const [pv] = await Promise.all([page.context().waitForEvent("page"), clickPreview()]);
pv.on("pageerror", (e) => console.error("RUNTIME PAGE ERROR:", e.message));
await waitPreviewPage(pv, "q1");
assert.equal(await pv.$('[data-qid="q2"]'), null, "page one is Q1 alone");
assert.equal(await pv.$(".rs-hidden-q"), null, "a visible question carries no hidden theme");
await tick(pv, "q1", "adidas");
await next(pv);
await waitPreviewPage(pv, "q2");
const card = '[data-qid="q2"]';
assert.ok(await pv.$(`${card}.rs-hidden-q`), "Q2's page is shown in the programmer's preview, in the hidden theme");
assert.equal(await pv.getAttribute(card, "data-rs-hidden"), "1");
assert.equal(await bg(pv, card), "rgb(243, 238, 255)", "light purple #F3EEFF background");
assert.match(await pv.$eval(card, (el) => getComputedStyle(el).borderTopStyle + " " + getComputedStyle(el).borderTopColor), /dashed rgb\(155, 123, 234\)/, "dashed purple #9B7BEA border");
assert.match(await pv.textContent(`${card} [data-testid="rs-hidden-banner"]`), /Hidden Question: This question is not visible to respondents in the live survey\. It is displayed here for testing purposes only\./);
assert.equal(await pv.textContent(`${card} [data-testid="rs-hidden-badge"]`), "HIDDEN QUESTION — PREVIEW MODE");
assert.match(await pv.textContent(`${card} [data-testid="rs-hidden-qnum"]`), /^Q2 — .*HIDDEN$/);
assert.ok(await pv.$(`${card} svg.rs-hidden-eye`), "eye-slash icon");
assert.equal(await pv.textContent(`${card} [data-testid="rs-hidden-foot"]`).then((t) => t.trim()), "Visibility: Hidden from live respondents");
assert.ok(await pv.$(`${card} input[value="nike"]`), "the question's options are drawn (it is the real question type)");
ok("Preview: the hidden Q2 is shown on its own page — purple background, dashed border, banner, badge, Q2 — HIDDEN, eye-slash, footer");

/* auto punch applied from Q1 = Adidas */
const opt = (code) => `${card} [data-rs-el="option"][data-rs-id="${code}"]`;
assert.equal(await pv.getAttribute(card, "data-rs-autopunch"), "applied");
assert.match(await pv.textContent(`${card} [data-testid="rs-autopunch-status"]`), /Auto-Punch Status:.*Auto-Punch Applied/);
assert.match(await pv.textContent(`${card} [data-testid="rs-autopunch-selected"]`), /Selected Answer:\s*Adidas/);
assert.ok(await pv.isChecked(`${card} input[value="adidas"]`), "the punched radio is selected");
assert.equal(await bg(pv, opt("adidas")), "rgb(220, 252, 231)", "the punched option is light green");
assert.equal(await after(pv, opt("adidas")), '"AUTO-PUNCHED"', "…with an AUTO-PUNCHED badge");
assert.notEqual(await bg(pv, opt("nike")), "rgb(220, 252, 231)", "the other options keep the theme");
assert.equal(await after(pv, opt("nike")), "none");
assert.equal(await pv.$eval(`${card} input[value="adidas"]`, (el) => getComputedStyle(el).accentColor), "rgb(22, 163, 74)", "green radio");
await pv.click(`${card} [data-testid="rs-autopunch-details"] summary`);
const details = await pv.textContent(`${card} [data-testid="rs-autopunch-details"]`);
assert.match(details, /Source Question\s*Q1/);
assert.match(details, /Condition\s*.*Q1.*Adidas/);
assert.match(details, /Target Question\s*Q2/);
assert.match(details, /Selected Option\s*Adidas/);
assert.match(details, /Execution Result\s*TRUE/);
assert.match(details, /Status\s*Successfully Applied/);
assert.deepEqual((await state(pv)).answers.q2, "adidas", "stored in the response data exactly as before");
ok("Auto punch: green option + AUTO-PUNCHED badge, Applied status, Selected Answer, details (source, condition, target, option, TRUE, status)");

/* it follows the source: Nike → no matching condition, the stale punch withdrawn; a manual pick is not green; required does not block */
await back(pv);
await waitPreviewPage(pv, "q1");
await tick(pv, "q1", "nike");
await next(pv);
await waitPreviewPage(pv, "q2");
assert.equal(await pv.getAttribute(card, "data-rs-autopunch"), "none");
assert.match(await pv.textContent(`${card} [data-testid="rs-autopunch-status"]`), /No Matching Condition/);
assert.equal((await state(pv)).answers.q2, undefined, "the old punch was withdrawn");
assert.equal(await after(pv, opt("adidas")), "none", "nothing is marked auto-punched");
assert.match(await pv.textContent(`${card} [data-testid="rs-autopunch-details"]`), /Execution Result\s*FALSE/);
await next(pv); // required + unanswered, but hidden: must not block
await waitPreviewPage(pv, "q3");
assert.equal(await pv.$('[data-testid="rs-errors"]'), null, "a required hidden question never blocks Next");
await back(pv);
await waitPreviewPage(pv, "q2");
await tick(pv, "q2", "puma"); // a manual pick on the hidden question (testing)
assert.equal(await after(pv, opt("puma")), "none", "a manual selection keeps the theme colour — it is not AUTO-PUNCHED");
assert.equal(await pv.$eval(`${card} input[value="puma"]`, (el) => getComputedStyle(el).accentColor === "rgb(22, 163, 74)"), false);
await back(pv);
await waitPreviewPage(pv, "q1");
await tick(pv, "q1", "adidas");
await next(pv);
await waitPreviewPage(pv, "q2");
assert.equal(await pv.getAttribute(card, "data-rs-autopunch"), "applied", "back to Adidas: applied again");
assert.ok(await pv.isChecked(`${card} input[value="adidas"]`), "the always-recompute rule overrides the manual pick");
ok("Auto punch follows the source answer (waiting / none / applied); the withdrawn punch leaves no green; required hidden does not block Next");

/* on to page 3 and answer the unrelated questions — these must survive every invalidation below */
await next(pv);
await waitPreviewPage(pv, "q3");
await tick(pv, "q3", "nike");
await pv.fill('[data-qid="q4"] input, [data-qid="q4"] textarea', "keep me");
await next(pv); // reaches the end page → clears the preview state; go back instead to keep the checkpoint
await pv.waitForSelector('[data-testid="rs-ended"], [data-qid="q3"]');
if (await pv.$('[data-testid="rs-ended"]')) {
  // the survey ended: restart the walk so a checkpoint with every answer exists on page 3
  await pv.click('button:has-text("Restart")').catch(() => {});
}
await waitPreviewPage(pv, "q1").catch(() => {});
if (await pv.$('[data-qid="q1"]')) {
  await tick(pv, "q1", "adidas"); await next(pv);
  await waitPreviewPage(pv, "q2"); await next(pv);
  await waitPreviewPage(pv, "q3");
  await tick(pv, "q3", "nike");
  await pv.fill('[data-qid="q4"] input, [data-qid="q4"] textarea', "keep me");
  // Back then Next writes a checkpoint carrying page 3's answers and the fingerprints
  await back(pv); await waitPreviewPage(pv, "q2"); await next(pv); await waitPreviewPage(pv, "q3");
}
let st = await state(pv);
assert.equal(st.answers.q1, "adidas"); assert.equal(st.answers.q2, "adidas"); assert.deepEqual(st.answers.q3, ["nike"]); assert.equal(st.answers.q4, "keep me");

/* ========================================================= 4. stale preview */
// the programmer changes the punch target in the builder: the open preview is pushed the new definition
await h.setQuestion("q2", (q) => { q.punches = [punch(["puma"])]; });
await pv.waitForFunction(() => window.__rescriptState?.answers?.q2 === "puma", null, { timeout: 15000 });
st = await state(pv);
assert.equal(st.answers.q2, "puma", "the live push re-punched Q2 from the new rule");
assert.equal(st.answers.q1, "adidas", "Q1 kept"); assert.deepEqual(st.answers.q3, ["nike"], "Q3 kept"); assert.equal(st.answers.q4, "keep me", "Q4 kept");
assert.ok(await pv.$('[data-qid="q3"]'), "still on page 3 — navigation untouched");
ok("Stale preview, live edit: changing the punch target re-punches Q2 (Puma) and keeps Q1 / Q3 / Q4");

// Back onto Q2's page: the new value is the green one
await back(pv);
await waitPreviewPage(pv, "q2");
assert.ok(await pv.isChecked(`${card} input[value="puma"]`));
assert.equal(await after(pv, opt("puma")), '"AUTO-PUNCHED"');
assert.equal(await after(pv, opt("adidas")), "none");
await next(pv);
await waitPreviewPage(pv, "q3");

// reopen Preview from the Studio: the same tab reloads and resumes from the stored snapshot (now written against the new rule)
// first make the stored snapshot STALE again: change the target once more without the push being able to reach the tab's storage
await h.setQuestion("q2", (q) => { q.punches = [punch(["nike"])]; });
await pv.waitForFunction(() => window.__rescriptState?.answers?.q2 === "nike", null, { timeout: 15000 });
// the tab's checkpoint still says q2 = puma under the OLD fingerprint (it was written on the last navigation);
// reopening Preview reloads the tab, which must drop that stored q2 and re-punch from the current rule
const snapshotBefore = await pv.evaluate(() => Object.keys(sessionStorage).filter((k) => k.startsWith("rescript:preview-state")).map((k) => JSON.parse(sessionStorage.getItem(k))));
assert.ok(snapshotBefore.length >= 1 && snapshotBefore[0].fingerprints && typeof snapshotBefore[0].fingerprints.q2 === "string", "the preview checkpoint carries configuration fingerprints");
assert.equal(snapshotBefore[0].answers.q2, "puma", "…and the stored (stale) value");
await Promise.all([pv.waitForNavigation({ waitUntil: "load" }).catch(() => {}), clickPreview()]);
await retry(async () => { await pv.waitForSelector('[data-testid="preview-bar"]', { timeout: 10000 }); await pv.waitForSelector("[data-qid]", { timeout: 20000 }); });
st = await state(pv);
assert.equal(st.answers.q2, "nike", "reopened preview: the obsolete auto-punch value is gone and the new one is in place");
assert.equal(st.answers.q1, "adidas", "Q1 kept"); assert.deepEqual(st.answers.q3, ["nike"], "Q3 kept"); assert.equal(st.answers.q4, "keep me", "Q4 kept");
assert.ok(await pv.$('[data-qid="q3"]'), "resumed on the same page");
assert.equal(await pv.inputValue('[data-qid="q4"] input, [data-qid="q4"] textarea'), "keep me");
ok("Stale preview, reopen: the stored Q2 is invalidated by its fingerprint and re-punched (Nike); unrelated answers and the position are kept");

// a reload with NO change keeps everything
await pv.reload({ waitUntil: "load" });
await retry(async () => { await pv.waitForSelector("[data-qid]", { timeout: 20000 }); });
st = await state(pv);
assert.deepEqual([st.answers.q1, st.answers.q2, st.answers.q3, st.answers.q4], ["adidas", "nike", ["nike"], "keep me"], "plain navigation / reload clears nothing");
ok("Plain reload without a configuration change keeps every preview answer");

/* ================================================== 5. as a respondent (live) */
await back(pv);
await waitPreviewPage(pv, "q2");
await pv.check('[data-testid="preview-respondent-view"] input');
await pv.waitForFunction(() => !document.querySelector('[data-qid="q2"]'), null, { timeout: 10000 });
// the respondent's view: Q2's page does not exist, so the preview is on an adjacent page, never a blank one
assert.ok((await pv.$('[data-qid="q1"]')) || (await pv.$('[data-qid="q3"]')), "no empty page where the hidden question was");
assert.equal(await pv.$(".rs-hidden-q, [data-testid='rs-hidden-banner'], [data-testid='rs-autopunch']"), null, "no theme, no banner, no auto-punch chrome anywhere");
if (await pv.$('[data-qid="q3"]')) { await back(pv); await waitPreviewPage(pv, "q1"); }
assert.ok(await pv.$('[data-qid="q1"]'));
await next(pv);
await waitPreviewPage(pv, "q3");
assert.equal(await pv.$('[data-qid="q2"]'), null, "Q1 → Q3 directly: the hidden-only page is skipped");
st = await state(pv);
assert.equal(st.answers.q2, "nike", "…while the response data carries the punched value");
assert.equal(await pv.textContent("body").then((t) => /HIDDEN QUESTION|AUTO-PUNCHED|Hidden from live respondents/.test(t)), false, "not a word of the programmer chrome");
await pv.uncheck('[data-testid="preview-respondent-view"] input');
await pv.waitForFunction(() => !!document.querySelector('[data-testid="rs-next"]'), null, { timeout: 10000 });
ok("As a respondent (what the live link renders): Q2's page is skipped with no empty space, no text, no options, no banner — the punched value is still stored");

await pv.close();
console.log(`\n${passed} checks passed — hidden questions, auto-punch visualisation and stale-preview invalidation`);
await h.close();

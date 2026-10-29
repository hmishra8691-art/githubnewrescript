/**
 * Browser suite — NATIVE SECTION NAVIGATION (2026-10-30, docs/SECTION-NAVIGATION-2026-10-30.md).
 *
 * The runtime preview (the real Runner, engine and renderer; no database), a 3-section paper
 * (History: 2 pages, Geography, Polity):
 *
 *   A  visited mode   navigator landmark + aria-current; a forward jump to an unvisited section is
 *                     refused with the reason; after Next×2 a backward jump; a visited forward jump;
 *                     Back after the jump returns to the previous page on the path
 *   B  reload         the preview resumes on the same page and the navigator still knows Geography
 *                     was visited (the trail kept in the tab)
 *   C  free mode      a forward jump skips unanswered pages (keyboard too); Back returns to the page
 *                     jumped from; Submit lists the missing required questions per section with
 *                     links, refuses, and completes once they are answered; telemetry records jumps
 *   D  assessment     free mode + def.assessment: Submit asks "N questions unanswered — submit anyway?"
 *   E  script         rs.goToSection from a survey script: refused with the reason in the console
 *                     when the rule says no, navigates when it says yes
 *   F  RTL            an Arabic survey: the navigator runs right to left
 *
 *   RUNTIME_URL=http://localhost:3001 node scripts/section-nav-test.mjs
 *   SECTIONS=A,B,C,D,E,F (default all)
 */
import assert from "node:assert/strict";
import { chromium } from "./lib/playwright.mjs";
import { sendPreview } from "./lib/preview.mjs";

const RUNTIME = process.env.RUNTIME_URL ?? "http://localhost:3001";
const SECTIONS = new Set((process.env.SECTIONS ?? "A,B,C,D,E,F").split(",").map((s) => s.trim()));
let passed = 0;
const ok = (m) => { passed++; console.log(`  ok   ${m}`); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const browser = await chromium.launch();
const allErrors = [];

const yesNo = [{ code: "1", label: "Yes" }, { code: "2", label: "No" }];
const q = (id, text) => ({ id, code: id.toUpperCase(), variableName: id.toUpperCase(), type: "single_select", text, options: yesNo, required: true, settings: {} });
const paper = (id, navigation, extra = {}) => ({
  meta: { id, code: id.toUpperCase(), title: "Paper", version: "1" },
  questions: [q("h1", "History one"), q("h2", "History two"), q("g1", "Geography one"), q("p1", "Polity one")],
  flow: [
    { type: "block", id: "b_hist", title: "History", children: [{ type: "page", id: "ph1", questionIds: ["h1"] }, { type: "page", id: "ph2", questionIds: ["h2"] }] },
    { type: "block", id: "b_geo", title: "Geography", children: [{ type: "page", id: "pg1", questionIds: ["g1"] }] },
    { type: "block", id: "b_pol", title: "Polity", children: [{ type: "page", id: "pp1", questionIds: ["p1"] }] },
    { type: "end", id: "e", status: "complete" },
  ],
  navigation,
  ...extra,
});

async function goto(page, url) {
  for (let i = 0; ; i++) {
    try { await page.goto(url, { waitUntil: "networkidle", timeout: 120000 }); return; }
    catch (e) { if (i >= 4 || /crash/i.test(String(e))) throw e; await sleep(8000); }
  }
}
async function open(def, query = "") {
  const pv = await browser.newPage({ viewport: { width: 1100, height: 900 } });
  pv.on("pageerror", (e) => { if (!/ChunkLoadError|Loading chunk .* failed|ResizeObserver loop/.test(String(e))) allErrors.push(`${def.meta.id}: ${e.message}`); });
  pv.consoleLines = [];
  pv.on("console", (m) => pv.consoleLines.push(m.text()));
  await goto(pv, `${RUNTIME}/preview${query}`);
  await sendPreview(pv, { definition: def });
  return pv;
}
const onPage = async (pv, qid) => { await pv.waitForSelector(`[data-qid="${qid}"]`, { timeout: 30000 }); };
const shownQid = (pv) => pv.evaluate(() => [...document.querySelectorAll("[data-qid]")].map((e) => e.getAttribute("data-qid"))[0]);
const answer = (pv, qid) => pv.click(`[data-qid="${qid}"] label:has-text("Yes")`);
const next = (pv) => pv.click('[data-testid="rs-next"]');
const navItem = (pv, section) => `[data-testid="rs-section-nav-item"][data-section="${section}"]`;
const stateOf = (pv, section) => pv.getAttribute(navItem(pv, section), "data-state");
// force: Playwright treats aria-disabled as "not enabled"; a respondent can still click a locked section (and is told why)
const jump = (pv, section) => pv.click(navItem(pv, section), { force: true });

/* ================================================================================================ A + B */
if (SECTIONS.has("A") || SECTIONS.has("B")) {
  console.log("\nA visited mode");
  const pv = await open(paper("navv", { sectionNav: "visited", position: "top" }));
  await onPage(pv, "h1");
  assert.equal(await pv.getAttribute('nav[data-testid="rs-section-nav"]', "aria-label"), "Sections");
  assert.equal(await pv.locator('[data-testid="rs-section-nav-item"]').count(), 3);
  assert.equal(await pv.getAttribute(navItem(pv, "b_hist"), "aria-current"), "step");
  assert.equal(await pv.evaluate(() => document.querySelector('[data-testid="rs-section-nav-item"]').tagName), "BUTTON");
  assert.equal(await stateOf(pv, "b_pol"), "locked");
  assert.equal(await pv.getAttribute(navItem(pv, "b_pol"), "aria-disabled"), "true");
  ok("a nav landmark of 3 buttons; History aria-current=step; Polity locked (aria-disabled, still focusable)");

  await jump(pv, "b_pol");
  await pv.waitForSelector('[data-testid="rs-section-nav-note"]');
  assert.match(await pv.textContent('[data-testid="rs-section-nav-note"]'), /only jump to sections you have already visited/);
  assert.equal(await shownQid(pv), "h1");
  ok("a forward jump to an unvisited section is refused with the reason; the respondent stays on h1");

  await answer(pv, "h1"); await next(pv); await onPage(pv, "h2");
  await answer(pv, "h2"); await next(pv); await onPage(pv, "g1");
  assert.equal(await pv.getAttribute(navItem(pv, "b_geo"), "aria-current"), "step");
  assert.match(await pv.textContent(`${navItem(pv, "b_hist")} [data-testid="rs-section-nav-count"]`), /2 of 2 answered/);
  await jump(pv, "b_hist"); await onPage(pv, "h1");
  ok("Next×2 then a backward jump to History lands on its first page (h1); History shows 2 of 2 answered");

  assert.equal(await stateOf(pv, "b_geo"), "visited");
  await jump(pv, "b_geo"); await onPage(pv, "g1");
  ok("a visited forward jump to Geography walks the (valid) pages between and lands on g1");
  await pv.click('[data-testid="rs-back"]'); await onPage(pv, "h2");
  ok("Back after the jump returns to h2 — the previous page on the path");

  if (SECTIONS.has("B")) {
    console.log("\nB reload / resume");
    await pv.reload({ waitUntil: "networkidle" });
    await sendPreview(pv, { definition: paper("navv", { sectionNav: "visited", position: "top" }) });
    await onPage(pv, "h2");
    assert.equal(await stateOf(pv, "b_geo"), "visited", "the navigator still knows Geography was visited");
    await jump(pv, "b_geo"); await onPage(pv, "g1");
    ok("a reload resumes on h2 with the trail kept: Geography is still visited and reachable");
  }
  await pv.close();
}

/* ================================================================================================ C */
if (SECTIONS.has("C")) {
  console.log("\nC free mode + the Submit gate");
  const pv = await open(paper("navf", { sectionNav: "free", position: "side" }));
  await onPage(pv, "h1");
  assert.equal(await pv.getAttribute('nav[data-testid="rs-section-nav"]', "data-position"), "side");
  assert.equal(await stateOf(pv, "b_pol"), "open");
  await pv.focus(navItem(pv, "b_pol"));
  await pv.keyboard.press("Enter");
  await onPage(pv, "p1");
  ok("free mode: Polity is open; Enter on its button (keyboard) jumps over 3 unanswered pages to p1");
  await pv.click('[data-testid="rs-back"]'); await onPage(pv, "h1");
  ok("Back after the free jump returns to h1, the page jumped from");
  await jump(pv, "b_pol"); await onPage(pv, "p1");
  await answer(pv, "p1");
  assert.equal(await pv.getAttribute('[data-testid="rs-next"]', "data-rs-button"), "submit");
  await next(pv);
  await pv.waitForSelector('[data-testid="rs-submit-gate"]');
  assert.equal(await pv.getAttribute('[data-testid="rs-submit-gate"]', "data-kind"), "refuse");
  assert.match(await pv.textContent('[data-testid="rs-submit-gate"]'), /3 required questions are unanswered/);
  const links = await pv.$$eval('[data-testid="rs-submit-gate-go"]', (els) => els.map((e) => e.textContent.trim()));
  assert.deepEqual(links, ["History: 2 unanswered", "Geography: 1 unanswered"]);
  assert.equal(await pv.locator('[data-testid="rs-ended"]').count(), 0);
  ok(`Submit refuses and lists the missing required questions per section (${links.join(" · ")})`);
  await pv.click('[data-testid="rs-submit-gate-go"][data-section="b_geo"]'); await onPage(pv, "g1");
  await answer(pv, "g1");
  await jump(pv, "b_hist"); await onPage(pv, "h1");
  await answer(pv, "h1"); await next(pv); await onPage(pv, "h2"); await answer(pv, "h2");
  await jump(pv, "b_pol"); await onPage(pv, "p1");
  await next(pv);
  await pv.waitForSelector('[data-testid="rs-ended"]', { timeout: 30000 });
  ok("the gate's Geography link goes there; once everything is answered Submit completes");
  const tel = await pv.evaluate(() => window.__rescriptTelemetry?.navigation ?? null);
  assert.ok(tel && tel.jumps >= 4, JSON.stringify(tel));
  ok(`telemetry records the jumps (navigation.jumps = ${tel.jumps})`);
  await pv.close();
}

/* ================================================================================================ D */
if (SECTIONS.has("D")) {
  console.log("\nD assessment: unanswered = unattempted");
  const pv = await open(paper("nava", { sectionNav: "free", position: "top" }, { assessment: { enabled: true } }));
  await onPage(pv, "h1");
  await jump(pv, "b_pol"); await onPage(pv, "p1");
  await answer(pv, "p1");
  await next(pv);
  await pv.waitForSelector('[data-testid="rs-submit-gate"]');
  assert.equal(await pv.getAttribute('[data-testid="rs-submit-gate"]', "data-kind"), "confirm");
  assert.match(await pv.textContent('[data-testid="rs-submit-gate"]'), /3 questions unanswered — submit anyway\?/);
  ok("Submit asks “3 questions unanswered — submit anyway?” instead of refusing");
  await pv.click('[data-testid="rs-submit-gate-confirm"]');
  await pv.waitForSelector('[data-testid="rs-ended"]', { timeout: 30000 });
  ok("Submit anyway completes the paper");
  await pv.close();
}

/* ================================================================================================ E */
if (SECTIONS.has("E")) {
  console.log("\nE rs.goToSection from a survey script");
  const script = `
    for (const [id, to] of [["go-geo", "Geography"], ["go-pol", "Polity"]]) {
      const b = document.createElement("button");
      b.setAttribute("data-go", id);
      b.textContent = "Go to " + to;
      b.addEventListener("click", () => rs.goToSection(to));
      document.querySelector('[data-qid="h1"]').appendChild(b);
    }`;
  const def = paper("navs", { sectionNav: "visited", position: "top" }, {
    ux: { styles: [], animations: [], behaviors: [{ id: "uxb_nav", label: "Jump buttons", target: { kind: "question", questionId: "h1" }, effects: [], script, createdAt: new Date().toISOString() }] },
  });
  const pv = await open(def);
  await onPage(pv, "h1");
  await pv.waitForSelector('[data-go="go-pol"]', { timeout: 30000 });
  await pv.click('[data-go="go-pol"]');
  for (let i = 0; i < 40 && !pv.consoleLines.some((l) => /goToSection\("Polity"\) refused/.test(l)); i++) await sleep(250);
  const line = pv.consoleLines.find((l) => /goToSection\("Polity"\) refused/.test(l));
  assert.ok(line, pv.consoleLines.join("\n"));
  assert.match(line, /only jump to sections you have already visited/);
  assert.equal(await shownQid(pv), "h1");
  ok(`refused, never silently: ${line.replace(/^.*?(rs\.goToSection)/, "$1")}`);
  await answer(pv, "h1"); await next(pv); await onPage(pv, "h2");
  await answer(pv, "h2"); await next(pv); await onPage(pv, "g1");
  await jump(pv, "b_hist"); await onPage(pv, "h1");
  await pv.waitForSelector('[data-go="go-geo"]', { timeout: 30000 });
  await pv.click('[data-go="go-geo"]');
  await onPage(pv, "g1");
  ok("the same script call navigates once Geography has been visited (the host applied the engine rule)");
  await pv.close();
}

/* ================================================================================================ F */
if (SECTIONS.has("F")) {
  console.log("\nF right to left");
  const def = paper("navr", { sectionNav: "free", position: "top" }, { localization: { sourceLanguage: "ar", languages: [{ code: "ar", name: "العربية" }] } });
  const pv = await open(def);
  await onPage(pv, "h1");
  assert.equal(await pv.getAttribute(".rs-shell", "dir"), "rtl");
  const dir = await pv.evaluate(() => getComputedStyle(document.querySelector('[data-testid="rs-section-nav"]')).direction);
  assert.equal(dir, "rtl");
  const [a, b] = await Promise.all([pv.locator(navItem(pv, "b_hist")).boundingBox(), pv.locator(navItem(pv, "b_geo")).boundingBox()]);
  assert.ok(a.x > b.x, `History (first) sits to the right of Geography: ${a.x} vs ${b.x}`);
  await jump(pv, "b_geo"); await onPage(pv, "g1");
  ok("an Arabic survey: dir=rtl, the navigator runs right to left, a jump works");
  await pv.close();
}

await browser.close();
assert.deepEqual(allErrors, [], allErrors.join("\n"));
console.log(`\nsection-nav-test: ${passed} passed`);

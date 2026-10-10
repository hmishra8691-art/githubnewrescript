/**
 * RESEARCH ENGINE — PHASE 7 (the semantic tier, research blockers, the
 * public documentation), in the browser.
 *
 *   - a sentence the recognisers miss by shape is read by meaning: the card
 *     says what it was read as, the Changes panel holds the action
 *   - a bare object is asked what should happen to it; the choice applies
 *   - "enforce the research design": a change that opens a research gap is
 *     refused in Changes with the gap named; Review lists the blockers; the
 *     Survey Settings switch reflects and relaxes it
 *   - the public documentation: /docs without a session, the navigation,
 *     a page's headings, the markdown at .md, llms.txt, robots, a 404
 *
 *   node scripts/phase7-engine-docs-test.mjs      (studio on 3000, fake AI provider)
 */
import { chromium } from "/home/claude/.npm-global/lib/node_modules/playwright/index.mjs";
import assert from "node:assert/strict";
import { openTab, switchMode } from "./lib/nav.mjs";

const STUDIO = process.env.STUDIO_URL ?? "http://localhost:3000";
let passed = 0;
const ok = (m) => { console.log("  ok  ", m); passed++; };
const opts = (...ls) => ls.map((l, i) => ({ code: i + 1, label: l }));
const FIXTURE = {
  meta: { id: "sandbox", code: "SANDBOX", title: "Brand switching" },
  research: { objective: "Understand why customers switch", hypotheses: ["Women are more satisfied than men"], hypothesisDetails: [{ type: "difference", direction: "positive", group: "women", lower: "men", dependent: "Satisfaction" }],
    constructs: [{ name: "Satisfaction", role: "dependent", questionIds: ["q7"] }, { name: "Gender", role: "control", questionIds: ["q2"] }], kpis: [{ name: "Satisfaction", variable: "SAT", measure: "top-2-box share" }], analysis: [], assumptions: [], sources: [] },
  questions: [
    { id: "q1", code: "Q1", variableName: "AGE", type: "numeric", text: "How old are you?" },
    { id: "q2", code: "Q2", variableName: "GENDER", type: "single_select", text: "What is your gender?", options: opts("Male", "Female") },
    { id: "q3", code: "Q3", variableName: "BRAND_PREF", type: "single_select", text: "Which brand do you prefer?", options: opts("Brand A", "Brand B") },
    { id: "q7", code: "Q7", variableName: "SAT", type: "single_select", text: "Overall, how satisfied are you with your current brand?", options: opts("1", "2", "3", "4", "5") },
    { id: "q9", code: "Q9", variableName: "REGION", type: "single_select", text: "Which region do you live in?", options: opts("North", "South") },
  ],
  flow: [
    { type: "block", id: "b1", title: "Screener", children: [{ type: "page", id: "p1", title: "Screener", questionIds: ["q1", "q2"] }] },
    { type: "block", id: "b2", title: "Brands", children: [{ type: "page", id: "p2", title: "Brands", questionIds: ["q3", "q7", "q9"] }] },
    { type: "end", id: "e", status: "complete" },
  ],
};

const browser = await chromium.launch();
const errors = [];

/* ------------------------------------------------ 1. the public documentation, with no session at all */
{
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  page.on("console", (m) => { if (m.type() === "error" && !/favicon|Failed to load resource|net::ERR|status of (404|501|502|402|409|401|400)/.test(m.text())) errors.push(m.text()); });
  const r = await page.goto(`${STUDIO}/docs`, { waitUntil: "networkidle" });
  assert.equal(r.status(), 200, "the docs need no session");
  assert.ok(!page.url().includes("/login"), "not bounced to the login");
  await page.waitForSelector('[data-testid="docs"]');
  const nav = await page.$$eval('[data-testid="docs-nav"] a', (as) => as.map((a) => [a.textContent, a.getAttribute("href")]));
  assert.equal(nav.length, 14, `14 pages in the navigation: ${nav.map((n) => n[1]).join(", ")}`);
  assert.deepEqual(nav.slice(0, 3).map((n) => n[1]), ["/docs", "/docs/getting-started", "/docs/survey-definition"]);
  assert.match(await page.textContent('[data-testid="docs-main"] h1'), /developer documentation/);
  await page.click('[data-testid="docs-nav"] a[href="/docs/logic"]');
  await page.waitForSelector('h1:has-text("Logic and expressions")');
  const h2 = await page.$$eval('[data-testid="docs-main"] h2', (hs) => hs.map((h) => h.id));
  assert.ok(h2.includes("conditions-in-text") && h2.includes("auto-punch"), h2.join(","));
  assert.ok((await page.$$('[data-testid="docs-main"] pre code')).length >= 5, "code examples render");
  assert.match(await page.title(), /^Logic and expressions — ReScript Studio docs$/);
  // the generated page is marked, and current
  await page.goto(`${STUDIO}/docs/actions-reference`, { waitUntil: "networkidle" });
  assert.match(await page.textContent('[data-testid="docs-main"]'), /set_research.*strict\?: boolean/s);
  // markdown, llms.txt, robots, a 404
  const md = await page.evaluate(async () => { const r = await fetch("/docs/logic.md"); return [r.status, r.headers.get("content-type"), (await r.text()).slice(0, 40)]; });
  assert.equal(md[0], 200); assert.match(md[1], /text\/markdown/); assert.equal(md[2], "# Logic and expressions\n\nEverything cond");
  const llms = await page.evaluate(async () => { const r = await fetch("/llms.txt"); return [r.status, await r.text()]; });
  assert.equal(llms[0], 200);
  assert.ok(llms[1].startsWith("# ReScript Studio\n"));
  assert.equal((llms[1].match(/^- \[/gm) ?? []).length, 15, "14 pages and the full file");
  assert.ok(llms[1].includes("/docs/intelligent-mode.md): Programming in sentences"));
  const full = await page.evaluate(async () => { const r = await fetch("/llms-full.txt"); const t = await r.text(); return [r.status, t.length, (t.match(/<!-- page: /g) ?? []).length]; });
  assert.equal(full[0], 200); assert.equal(full[2], 14); assert.ok(full[1] > 100000, `${full[1]} chars`);
  const robots = await page.evaluate(async () => (await fetch("/robots.txt")).text());
  assert.match(robots, /Allow: \/docs\n/); assert.match(robots, /Disallow: \/api\//);
  assert.equal((await page.goto(`${STUDIO}/docs/nope`)).status(), 404);
  assert.equal((await page.goto(`${STUDIO}/docs/nope.md`)).status(), 404);
  await ctx.close();
  ok("the public documentation: no session needed, 14 pages, headings and examples rendered, markdown at .md, llms.txt and llms-full.txt, robots, a 404 for what is not there");
}

/* ------------------------------------------------ the sandbox for the rest */
const page = await browser.newPage({ viewport: { width: 1700, height: 1150 } });
page.on("dialog", (d) => d.accept());
page.on("console", (m) => { if (m.type() === "error" && !/favicon|Failed to load resource|net::ERR|status of (404|501|502|402|409|401|400)/.test(m.text())) errors.push(m.text()); });
const loadDef = async (def) => {
  await openTab(page, "JSON");
  await page.waitForSelector("textarea.code");
  await page.click('button:has-text("edit")');
  await page.$eval("textarea.code", (el, v) => { Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value").set.call(el, v); el.dispatchEvent(new Event("input", { bubbles: true })); }, JSON.stringify(def));
  await page.click('button:has-text("validate & apply")');
  await page.waitForTimeout(600);
};
const intelligent = async () => { await openTab(page, "Questions"); await switchMode(page, "intelligent"); await page.waitForSelector('[data-testid="intelligent-view"]'); };
const readDef = async () => { await openTab(page, "JSON"); await page.waitForSelector("textarea.code"); const json = await page.$eval("textarea.code", (e) => e.value); await intelligent(); return JSON.parse(json); };
const turns = () => page.$$('[data-testid="cp-turn"]');
const settled = async (n) => {
  await page.waitForFunction((k) => { const t = document.querySelectorAll('[data-testid="cp-turn"]'); return t.length > k && t[t.length - 1].getAttribute("data-status") !== "thinking"; }, n, { timeout: 60000 });
  await page.waitForTimeout(300);
  return (await turns()).at(-1);
};
const say = async (text) => { const n = (await turns()).length; await page.fill('[data-testid="iq-input"]', text); await page.keyboard.press("Enter"); return settled(n); };
const textOf = async (h) => (await h.evaluate((e) => e.innerText)).replace(/\s+/g, " ");
const apply = async () => { if (await page.$('[data-testid="cp-confirm"]')) await page.check('[data-testid="cp-confirm"]'); await page.click('[data-testid="cp-apply"]'); await page.waitForTimeout(600); };
const cancel = async () => { if (await page.$('[data-testid="cp-panel-cancel"]')) { await page.click('[data-testid="cp-panel-cancel"]'); await page.waitForTimeout(200); } };
const tab = async (id) => { await page.click(`[data-testid="cp-tab-${id}"]`); await page.waitForTimeout(150); };

await page.goto(`${STUDIO}/sandbox?mode=studio`, { waitUntil: "networkidle" });
await page.waitForSelector(".menubar");
await loadDef(FIXTURE);
await intelligent();

/* ------------------------------------------------ 2. the semantic tier */
{
  let t = await say("the gender question must be answered");
  assert.equal(await t.getAttribute("data-status"), "ready");
  assert.match(await textOf(t), /Read “the gender question must be answered” as “Make Q2 required” — make Q2 required\./);
  assert.equal(await page.getAttribute('[data-testid="cp-panel"]', "data-tab"), "changes");
  assert.match(await page.textContent('[data-testid="cp-summary"]'), /Q2/);
  await apply();
  assert.equal((await readDef()).questions.find((q) => q.code === "Q2").required, true, "applied");
  t = await say("nobody under 18 should continue");
  assert.match(await textOf(t), /as “Terminate if AGE < 18”/);
  await cancel();
  // a bare object: asked what should happen to it; the choice is a sentence the engine reads
  t = await say("Q7");
  assert.equal(await t.getAttribute("data-status"), "ready");
  assert.match(await textOf(t), /The engine read Q7 but not what should happen to it/);
  const choices = await t.$$eval('[data-testid="cp-engine-choice"] .iq-example-about', (es) => es.map((e) => e.textContent));
  assert.deepEqual(choices, ["Make Q7 required", "Make Q7 optional", "Randomize the options of Q7", "Put Q7 on its own page", "Delete Q7", "What depends on Q7?"]);
  const n = (await turns()).length;
  await t.$eval('[data-testid="cp-engine-choice"] >> nth=2', (b) => b.click());
  t = await settled(n);
  assert.match(await textOf(t), /Randomize the options of Q7/);
  await cancel();
  // several readings: one question with the readings as choices
  t = await say("add 'Other' to the brand question");
  assert.match(await textOf(t), /This could mean more than one thing/);
  assert.deepEqual((await t.$$eval('[data-testid="cp-engine-choice"] .iq-example-about', (es) => es.map((e) => e.textContent))).sort(), ['Add option "Other" to Q3', 'Add option "Other" to Q7']);
  ok("the semantic tier: a sentence read by meaning, said on the card and applied; a bare object asked what should happen to it; several readings as choices");
}

/* ------------------------------------------------ 3. the research design enforced */
{
  let t = await say("enforce the research design");
  assert.match(await textOf(t), /Enforce the research design: from now on a change that opens a research gap/);
  await apply();
  assert.equal((await readDef()).research.strict, true);
  // a change that opens a gap is refused at the change — the engine's dry run meets the enforced design and the card says which gap
  t = await say("delete Q7");
  assert.equal(await (await t.$('[data-testid="cp-engine-detail"]')).getAttribute("data-kind"), "refused");
  const refused = await textOf(t);
  assert.match(refused, /Blocked by the research design \(enforced\): The dependent construct “Satisfaction” is measured by no question/);
  assert.match(refused, /Ask “stop enforcing the research design” to make this a warning instead/);
  assert.equal(await page.$('[data-testid="cp-apply"]'), null, "nothing proposed");
  // a change that opens no gap goes through
  t = await say("delete Q9");
  assert.equal(await (await t.$('[data-testid="cp-engine-detail"]')).getAttribute("data-kind"), "actions");
  await cancel();
  // Review: no gaps now — said as enforced and clean; with a gap in the design, listed as blockers
  await say("review my survey");
  await tab("review");
  await page.waitForSelector('[data-testid="cp-review-blockers"]');
  assert.equal(await page.getAttribute('[data-testid="cp-review-blockers"]', "data-count"), "0");
  assert.match(await page.textContent('[data-testid="cp-review-blockers"]'), /The research design is enforced: no research gaps/);
  // the Survey Settings switch reflects it and relaxes it
  await openTab(page, "Survey Settings");
  await page.waitForSelector('[data-testid="rd-strict-box"]');
  assert.equal(await page.isChecked('[data-testid="rd-strict-box"]'), true);
  await page.uncheck('[data-testid="rd-strict-box"]');
  await page.waitForTimeout(300);
  await intelligent();
  t = await say("delete Q7");
  assert.equal(await (await t.$('[data-testid="cp-engine-detail"]')).getAttribute("data-kind"), "actions", "not enforced: the delete is proposed");
  await apply();
  // enforce again with the gap present: allowed, and Review lists the blockers
  await say("enforce the research design");
  await apply();
  await say("review my survey");
  await tab("review");
  await page.waitForFunction(() => document.querySelector('[data-testid="cp-review-blockers"]')?.getAttribute("data-count") === "3");
  assert.match(await page.textContent('[data-testid="cp-review-blockers"]'), /3 research gaps are blockers/);
  assert.equal((await page.$$('[data-testid="cp-finding"][data-blocks="true"]')).length, 3);
  assert.match(await page.textContent('[data-testid="cp-finding"][data-blocks="true"] >> nth=0'), /blocker/);
  ok("enforcement: a change that opens a research gap is refused in Changes with the gap named, one that opens none goes through, Review counts and marks the blockers, the Settings switch reflects and relaxes it");
}

/* ------------------------------------------------ 4. a review asked for in a sentence (consolidation) */
{
  await intelligent();
  // the engine's card comes at once; with the (fake) model present its review-mode turn follows as a second card, so the engine's is found by its text
  const engineCard = async (re) => { for (const h of await turns()) { if (re.test(await textOf(h))) return h; } return null; };
  await tab("changes");
  assert.equal(await page.getAttribute('[data-testid="cp-tab-review"]', "aria-selected"), "false");
  const n0 = (await turns()).length;
  await say("Review the entire survey and identify problems with the logic.");
  await page.waitForFunction((k) => document.querySelectorAll('[data-testid="cp-turn"]').length >= k + 1, n0);
  const t = await engineCard(/Reviewed the logic: \d+ finding|Reviewed the logic: nothing to report/);
  assert.ok(t, "the engine's review is the card");
  assert.equal(await (await t.$('[data-testid="cp-engine-detail"]')).getAttribute("data-kind"), "answer", "the engine's review is the answer, not a model hand-off");
  // the Review tab is filled by the same sentence
  await page.waitForFunction(() => document.querySelector('[data-testid="cp-tab-review"]')?.getAttribute("aria-selected") === "true", null, { timeout: 10000 });
  await page.waitForSelector('[data-testid="cp-review-blockers"]');
  await settled(n0);
  const n1 = (await turns()).length;
  await say("What is wrong with the wording?");
  const w = await engineCard(/Reviewed the wording/);
  assert.ok(w, "the wording review is the card");
  assert.equal(await (await w.$('[data-testid="cp-engine-detail"]')).getAttribute("data-kind"), "answer");
  await settled(n1);
  ok("a review asked for in a sentence: the engine's review as the card, narrowed to the area named, and the Review tab filled");
}

assert.deepEqual(errors, [], `console errors: ${errors.join("\n")}`);
await browser.close();
console.log(`\n${passed} passed`);

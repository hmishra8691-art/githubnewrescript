/**
 * FINDINGS (research-intelligence Phase 5).
 *
 *   - Intelligent → Findings: no run yet (the plan runs by itself at the
 *     fieldwork milestones, or now); a run handed in through the test seam
 *     (computed here with the real analytics package on the synthetic data)
 *     → each hypothesis with its verdict and reason, the findings strongest
 *     first with their evidence, the significant-only toggle, the badge
 *   - an untested hypothesis → "Plan a test" asks the copilot, whose analysis
 *     action lands in Changes
 *   - the turn route recognises a findings question and carries the run's
 *     brief (verdicts, findings) with it — and says "none yet" without one
 *   - the analytics plan routes refuse without a session
 *
 *   node scripts/findings-copilot-test.mjs      (studio on 3000)
 */
import assert from "node:assert/strict";
import { chromium } from "/home/claude/.npm-global/lib/node_modules/playwright/index.mjs";
import { openTab, switchMode } from "./lib/nav.mjs";
import { def as synthDef, synthDataset } from "/home/claude/rescript/packages/analytics/dist/analyses/fixture.js";
import { runPlan, compactRun } from "/home/claude/rescript/packages/analytics/dist/findings.js";

const STUDIO = process.env.STUDIO_URL ?? "http://localhost:3000";
let passed = 0;
const ok = (m) => { console.log("  ok  ", m); passed++; };

/* the synthetic survey with a research design and a plan: a gender effect and satisfaction → recommendation are planted; region is not */
const FIXTURE = structuredClone(synthDef);
FIXTURE.meta = { ...FIXTURE.meta, id: "sandbox", code: "SANDBOX" };
FIXTURE.research = {
  objective: "What drives satisfaction and recommendation", population: "adults",
  hypotheses: ["Women are more satisfied than men", "Region affects satisfaction", "Satisfaction drives recommendation", "Awareness of Gamma raises consideration of Gamma"],
  constructs: [{ name: "Satisfaction", role: "dependent", questionIds: ["q_sat"] }, { name: "Recommendation", role: "dependent", questionIds: ["q_nps"] }],
  analysis: [], assumptions: [], sources: [],
  analysisPlan: {
    crosstabs: [{ id: "x1", rows: ["SAT"], columns: ["GENDER"], priority: 1, hypotheses: ["H1"], reason: "satisfaction by gender" }],
    tests: [
      { id: "t1", method: "t_test", outcome: "SAT", variables: [], groupBy: "GENDER", priority: 1, hypotheses: ["H1"] },
      { id: "t2", method: "anova", outcome: "SAT", variables: [], groupBy: "REGION", priority: 1, hypotheses: ["H2"] },
      { id: "t3", method: "regression", outcome: "NPS", variables: ["SAT", "AGE"], priority: 1, hypotheses: ["H3"] },
      { id: "t4", method: "nps", variables: ["NPS"], priority: 2, hypotheses: [] },
    ],
    derived: [], segments: [], source: "researcher",
  },
};
const RUN = compactRun(runPlan(FIXTURE, synthDataset(400), { trigger: "halfway", now: "2026-10-05T09:00:00Z" }));
assert.equal(RUN.verdicts.map((v) => v.verdict).join(), "supported,not_supported,mixed,untested", "the planted structure comes out as expected before the browser is even opened");

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
  await page.waitForTimeout(800);
};
const texts = (sel) => page.$$eval(sel, (els) => els.map((e) => e.textContent.replace(/\s+/g, " ").trim()));
const intelligent = async () => {
  await openTab(page, "Questions");
  await switchMode(page, "intelligent");
  await page.waitForSelector('[data-testid="intelligent-view"]');
};

await page.goto(`${STUDIO}/sandbox?mode=studio`, { waitUntil: "networkidle" });
await page.waitForSelector(".menubar");
await loadDef(FIXTURE);
ok("fixture loaded: the synthetic survey with four hypotheses and a plan");

await intelligent();
if (!(await page.evaluate(() => typeof window.__rescriptCopilotFake === "function"))) { console.log("  skip  no fake copilot provider in this build"); await browser.close(); process.exit(0); }

/* ------------------------------------------------ no run yet */
await page.click('[data-testid="cp-tab-findings"]');
await page.waitForSelector('[data-testid="cp-findings"]');
assert.ok(await page.$('[data-testid="fd-no-run"]'), "the plan has not run");
assert.match(await page.textContent('[data-testid="fd-no-run"]'), /runs by itself at the first 30 completes, halfway to target, at target and at the end of fieldwork/);
assert.ok(await page.$('[data-testid="fd-run"][disabled]'), "the sandbox cannot run it (no responses)");
assert.equal(await page.$('[data-testid="fd-verdict"]'), null);
ok("Findings: without a run the tab says when the plan runs by itself, and offers to run it");

/* ------------------------------------------------ a run through the seam */
await page.evaluate((r) => window.__rescriptAnalysisRun(r), RUN);
await page.waitForSelector('[data-testid="fd-verdict"]');
{
  const verdicts = await page.$$eval('[data-testid="fd-verdict"]', (es) => es.map((e) => [e.getAttribute("data-label"), e.getAttribute("data-verdict"), e.textContent]));
  assert.deepEqual(verdicts.map((v) => [v[0], v[1]]), [["H1", "supported"], ["H2", "not_supported"], ["H3", "mixed"], ["H4", "untested"]]);
  assert.match(verdicts[0][2], /All 2 planned tests are significant: Overall satisfaction (across|by) Gender/);
  assert.match(verdicts[1][2], /The planned test is significant|None of the|The planned test is not/i);
  assert.match(verdicts[3][2], /No analysis in the plan serves this hypothesis/);
  const meta = await page.textContent('[data-testid="fd-run-meta"]');
  assert.match(meta, /Run halfway to target · .* · 400 live completes · 5 analyses/);
  const findings = await page.$$eval('[data-testid="fd-finding"]', (es) => es.map((e) => ({ kind: e.getAttribute("data-kind"), strength: e.getAttribute("data-strength"), sig: e.getAttribute("data-significant"), t: e.textContent })));
  assert.ok(findings.length >= 3 && findings.every((f) => f.sig === "1" || /nps/.test(f.kind)), `significant only by default: ${JSON.stringify(findings.map((f) => [f.kind, f.sig]))}`);
  assert.equal(findings[0].strength, "strong");
  assert.match(findings[0].t, /Cohen's d|β/);
  assert.ok(findings.some((f) => f.kind === "nps" && /NPS for Recommend\? is -?\d+ on 400 responses/.test(f.t)));
  /* the badge counts the significant findings */
  const badge = await page.textContent('[data-testid="cp-tab-findings"]');
  assert.match(badge, new RegExp(`Findings${RUN.findings.filter((f) => f.significant).length}`));
  /* untick: the null results appear */
  await page.click('[data-testid="fd-only-sig"]');
  await page.waitForTimeout(150);
  const all = await page.$$eval('[data-testid="fd-finding"]', (es) => es.map((e) => e.getAttribute("data-significant")));
  assert.ok(all.includes("0") && all.length > findings.length, "the null results are shown when asked");
  assert.ok((await texts('[data-testid="fd-finding"]')).some((t) => /Overall satisfaction across Region: no significant difference \(ANOVA, p = \.\d{3}\)/.test(t)));
}
ok("Findings: each hypothesis with its verdict and reason; the findings strongest first with their evidence; significant-only toggle; the badge");

/* ------------------------------------------------ an untested hypothesis → plan a test, through the copilot */
{
  await page.evaluate((r) => window.__rescriptCopilotFake(r), { kind: "proposal", reply: "Adding the test for H4.", actions: [{ op: "add_crosstab", rows: ["CONSIDER"], columns: ["AWARE"], priority: 1, hypotheses: ["H4"], reason: "consideration by awareness" }, { op: "add_analysis_test", method: "chi_square", outcome: "CONSIDER", variables: ["AWARE"], priority: 1, hypotheses: ["H4"] }] });
  const n = (await page.$$('[data-testid="cp-turn"]')).length;
  await page.click('[data-testid="fd-verdict"][data-label="H4"] [data-testid="fd-plan-test"]');
  await page.waitForFunction((k) => { const t = document.querySelectorAll('[data-testid="cp-turn"]'); return t.length > k && t[t.length - 1].getAttribute("data-status") !== "thinking"; }, n, { timeout: 30000 });
  await page.click('[data-testid="cp-tab-changes"]');
  await page.waitForSelector('[data-testid="cp-changes"]');
  const sm = await texts('[data-testid="cp-summary"] li');
  assert.ok(sm.some((t) => /Plan crosstab: CONSIDER by AWARE/.test(t)) && sm.some((t) => /Plan chi.square on CONSIDER/.test(t)), sm.join(" | "));
  await page.click('[data-testid="cp-panel-apply"]');
  await page.waitForTimeout(600);
}
ok("an untested hypothesis: “Plan a test” asks the copilot, whose crosstab and chi-square land in Changes and apply to the plan");

/* ------------------------------------------------ the turn route: a findings question carries the run */
{
  const call = async (message, run) => {
    const r = await fetch(`${STUDIO}/api/copilot/turn`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ surveyId: "sandbox", message, definition: FIXTURE, fake: { kind: "answer", reply: "ok" }, ...(run ? { analysisRun: run } : {}) }) });
    assert.equal(r.status, 200);
    return (await r.json()).context;
  };
  const brief = { computedAt: RUN.computedAt, n: RUN.n, trigger: RUN.trigger, environment: RUN.environment, verdicts: RUN.verdicts, warnings: RUN.warnings, findings: RUN.findings };
  // a findings question that is not also an analysis-planning one, so the run and the guide travel on the findings intent alone
  const withRun = await call("What did we find? Give me the headline results.", brief);
  const noRun = await call("What did we find? Give me the headline results.");
  const plain = await call("Reword Q4", brief);
  assert.equal(withRun.findings, true); assert.equal(withRun.hasRun, true);
  assert.equal(noRun.findings, true); assert.equal(noRun.hasRun, false);
  assert.equal(plain.findings, false);
  assert.ok(withRun.outlineChars > noRun.outlineChars + 300, `the run's brief is in the outline: ${withRun.outlineChars} vs ${noRun.outlineChars}`);
  assert.ok(withRun.outlineChars > plain.outlineChars + 300, "and not on a wording edit");
  assert.ok(withRun.promptChars - withRun.outlineChars > plain.promptChars - plain.outlineChars + 800, "the findings guide goes with it");
}
ok("the turn route recognises a findings question and sends the run's verdicts and findings with it — or says none yet");

/* ------------------------------------------------ the plan routes refuse without a session */
{
  // the analytics route opens its database client before the gate (as every analytics branch does), so a Studio without Supabase answers 500 and one with it 401 — never 200
  const r1 = await fetch(`${STUDIO}/api/surveys/00000000-0000-0000-0000-000000000000/analytics/plan/latest`);
  assert.ok([401, 500].includes(r1.status), String(r1.status));
  const r2 = await fetch(`${STUDIO}/api/surveys/00000000-0000-0000-0000-000000000000/analytics/plan/run`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
  assert.ok([401, 500].includes(r2.status), String(r2.status));
  const r3 = await fetch(`${STUDIO}/api/cron/analysis-runs`);
  assert.equal(r3.status, 401, "the cron needs its secret");
}
ok("the plan routes and the cron refuse without a session or the secret");

assert.deepEqual(errors.filter((e) => !/ResizeObserver/.test(e)), [], errors.join("\n"));
await browser.close();
console.log(`\n${passed} checks passed`);

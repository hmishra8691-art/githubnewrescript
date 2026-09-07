/**
 * THE TESTS PANEL (§55, §56).
 *
 * The engine side is unit-tested in `packages/templates` (30 assertions on
 * the four verdicts) and the history in `scripts/test-cases-sql-test.sql`
 * (13). What only a browser can prove is the thing the whole feature rests
 * on: that a CHANGED case reads differently from a FAILING one, and offers
 * the one control that resolves it.
 *
 * The API is intercepted. The container's dev servers hold no Supabase
 * credentials, so a real run is impossible here — and what is under test is
 * the panel's contract with the route, not the route's with Postgres.
 *
 *   node scripts/test-cases-test.mjs      (studio on 3000)
 */
import { chromium } from "/home/claude/.npm-global/lib/node_modules/playwright/index.mjs";
import assert from "node:assert/strict";

const STUDIO = process.env.STUDIO_URL ?? "http://localhost:3000";
let passed = 0;
const ok = (m) => { console.log("  ok  ", m); passed++; };

const QUESTIONS = [
  { id: "q_age", code: "Q1", variableName: "AGE", type: "numeric", text: "How old are you?", options: [] },
  { id: "q_use", code: "Q2", variableName: "USE", type: "single_select", text: "Do you use it?",
    options: [{ code: "1", label: "Yes" }, { code: "2", label: "No" }] },
];
const PAGES = [{ id: "p_screen", label: "Q1, Q2" }, { id: "p_often", label: "Q3" }];

/* one of each verdict that matters, so the panel has to tell them apart */
const SUITE = [
  {
    test_case_id: "tc1", name: "A 17-year-old is screened out", enabled: true,
    has_baseline: true, baseline_at: "2026-09-06T10:00:00Z",
    last_verdict: "pass", last_run_at: "2026-09-07T09:00:00Z", last_version_label: "draft r12",
    last_failures: [], last_changes: [], run_count: 4,
  },
  {
    test_case_id: "tc2", name: "A non-user skips the usage block", enabled: true,
    has_baseline: true, baseline_at: "2026-09-06T10:00:00Z",
    last_verdict: "changed", last_run_at: "2026-09-07T09:00:00Z", last_version_label: "draft r12",
    last_failures: [],
    last_changes: [{ kind: "path", detail: "After 1 page(s) the path diverges: p_often instead of p_why." }],
    run_count: 3,
  },
  {
    test_case_id: "tc3", name: "A user completes", enabled: true,
    has_baseline: false, baseline_at: null,
    last_verdict: "fail", last_run_at: "2026-09-07T09:00:00Z", last_version_label: "draft r12",
    last_failures: ["Expected to end as complete, ended as screened."],
    last_changes: [], run_count: 2,
  },
  {
    test_case_id: "tc4", name: "An old case nobody fixed", enabled: false,
    has_baseline: false, baseline_at: null,
    last_verdict: null, last_run_at: null, last_version_label: null,
    last_failures: [], last_changes: [], run_count: 0,
  },
];

const CASES = SUITE.map((r, i) => ({
  id: r.test_case_id, name: r.name, notes: i === 0 ? "The one a client always asks about" : null,
  enabled: r.enabled,
  input: { answers: i === 0 ? { q_age: 17 } : { q_use: 2 }, seed: 7 },
  expectations: i === 2 ? { endStatus: "complete" } : {},
  baseline: r.has_baseline ? { path: ["p_screen"], fingerprint: "abc" } : null,
  baseline_at: r.baseline_at,
}));

const PAYLOAD = {
  suite: SUITE, cases: CASES, questions: QUESTIONS, pages: PAGES,
  runsAgainst: { source: "draft", version: "1.4", revision: 12 },
  definitionError: null,
};

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1500, height: 1150 } });
const errors = [];
page.on("pageerror", (e) => errors.push(String(e)));
page.on("dialog", (d) => d.accept());

let lastPost = null;
let payload = PAYLOAD;
await page.route("**/api/surveys/*/tests**", async (route) => {
  const req = route.request();
  if (req.method() === "POST") {
    lastPost = JSON.parse(req.postData() ?? "{}");
    if (lastPost.action === "run_all") {
      return route.fulfill({
        status: 200, contentType: "application/json",
        body: JSON.stringify({
          ok: true, batchId: "b1", ranAgainst: { source: "draft", label: "draft r12" },
          summary: { total: 4, pass: 1, changed: 1, fail: 1, stale: 0, skipped: 1, clean: false, releasable: false },
          note: "1 of 4 pass, 1 failed, 1 changed and need review, 1 disabled.",
          results: [
            { caseId: "tc2", name: SUITE[1].name, verdict: "changed", failures: [],
              changes: SUITE[1].last_changes,
              outcome: { path: ["p_screen", "p_often"], endStatus: "complete", fingerprint: "z" } },
          ],
        }),
      });
    }
    return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ ok: true, note: "Done." }) });
  }
  return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(payload) });
});

await page.goto(`${STUDIO}/sandbox`, { waitUntil: "networkidle" });
await page.waitForSelector(".leftnav");

/* ============================================================= the tab */

const navLabels = await page.$$eval(".leftnav .nav-item", (es) =>
  es.map((e) => [...e.childNodes].filter((n) => n.nodeType === 3).map((n) => n.textContent).join("").trim()));
assert.equal(navLabels[navLabels.indexOf("Scripts") + 1], "Tests",
  `Tests sits in Research tools after Scripts: ${navLabels.join(" | ")}`);
ok("the suite has its own tab, beside Scripts in Research tools");

await page.click(".leftnav >> text=Tests");
await page.waitForSelector('[data-testid="tests-panel"]');

/* ===================================================== what it grades */

const grading = await page.textContent('[data-testid="tests-grading"]');
assert.match(grading, /autosaved draft \(revision 12\)/);
ok("the panel says which build a run would grade, before the button is pressed");

/* ======================================== the four verdicts, told apart */

const cards = await page.$$eval('[data-testid="test-case"]', (els) =>
  els.map((e) => ({
    id: e.getAttribute("data-case-id"),
    verdict: e.getAttribute("data-verdict"),
    text: e.textContent.replace(/\s+/g, " ").trim(),
  })));
assert.deepEqual(cards.map((c) => c.id), ["tc1", "tc2", "tc3", "tc4"]);
assert.deepEqual(cards.map((c) => c.verdict), ["pass", "changed", "fail", "unrun"]);
ok("every case is listed with its own verdict, including one that has never run");

assert.match(cards[0].text, /Passing/);
assert.match(cards[1].text, /Changed — needs a decision/);
assert.match(cards[2].text, /Failing/);
assert.match(cards[3].text, /Never run/);
ok("a changed case is worded as a DECISION, not as a failure");

/* the sentence, not a diff fragment */
const change = await page.textContent('[data-testid="test-case"][data-case-id="tc2"] [data-testid="tc-change"]');
assert.match(change, /After 1 page\(s\) the path diverges: p_often instead of p_why/);
ok("what moved is stated in a sentence a programmer can act on");

const failure = await page.textContent('[data-testid="test-case"][data-case-id="tc3"] [data-testid="tc-failure"]');
assert.match(failure, /Expected to end as complete, ended as screened/);
ok("a failure quotes the expectation it broke");

/* ============================================ accept is offered where it helps */

assert.ok(await page.$('[data-testid="test-case"][data-case-id="tc2"] [data-testid="tc-bless"]'),
  "the changed case offers Accept");
const blessLabel = await page.textContent('[data-testid="test-case"][data-case-id="tc2"] [data-testid="tc-bless"]');
assert.match(blessLabel, /This is correct — accept it/);
assert.equal(await page.$('[data-testid="test-case"][data-case-id="tc1"] [data-testid="tc-bless"]'), null,
  "a passing case with a baseline has nothing to accept");
ok("Accept appears exactly where a decision is needed, and says what it means");

await page.click('[data-testid="test-case"][data-case-id="tc2"] [data-testid="tc-bless"]');
await page.waitForTimeout(250);
assert.deepEqual(lastPost, { action: "bless", caseId: "tc2" });
ok("accepting sends the case, not a re-run — it blesses the outcome you just read");

/* ==================================================== “no baseline” is honest */

assert.match(cards[2].text, /No baseline/, "a case nobody has blessed says so rather than showing green");
ok("“no baseline” is stated, so a pass is not mistaken for a proof");

/* ============================================================ running */

await page.click('[data-testid="tests-run-all"]');
await page.waitForSelector('[data-testid="tests-summary"]');
assert.deepEqual(lastPost, { action: "run_all" });

const verdict = await page.textContent('[data-testid="tests-verdict"]');
assert.match(verdict, /Not ready to release/);
const summaryText = await page.textContent('[data-testid="tests-summary"]');
assert.match(summaryText, /1 passing/);
assert.match(summaryText, /1 changed/);
assert.match(summaryText, /1 failing/);
assert.match(summaryText, /1 disabled/);
assert.match(summaryText, /against draft r12/);
ok("a suite run reports each verdict separately, and what it ran against");

/*
 * The amber explanation is deliberately ABSENT while something is failing:
 * next to a real break, "this may be the change you meant" is a distraction.
 * It appears in the changed-only run below, which is where it belongs.
 */
assert.doesNotMatch(summaryText, /A changed case is not a failure/);
ok("the amber advice stays out of the way while something is actually broken");

/* ========================================== a release verdict that discriminates */

payload = {
  ...PAYLOAD,
  suite: SUITE.map((r) => r.test_case_id === "tc3" ? { ...r, last_verdict: "changed", last_failures: [], last_changes: SUITE[1].last_changes } : r),
};
await page.reload({ waitUntil: "networkidle" });
await page.click(".leftnav >> text=Tests");
await page.waitForSelector('[data-testid="tests-panel"]');
await page.route("**/api/surveys/*/tests**", async (route) => {
  if (route.request().method() === "POST") {
    /* this handler now shadows the first one, so it has to keep recording */
    lastPost = JSON.parse(route.request().postData() ?? "{}");
    if (lastPost.action !== "run_all") {
      return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ ok: true, note: "Done." }) });
    }
    return route.fulfill({
      status: 200, contentType: "application/json",
      body: JSON.stringify({
        ok: true, ranAgainst: { source: "draft", label: "draft r13" },
        summary: { total: 4, pass: 1, changed: 2, fail: 0, stale: 0, skipped: 1, clean: false, releasable: true },
        note: "1 of 4 pass, 2 changed and need review, 1 disabled.", results: [],
      }),
    });
  }
  return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(payload) });
});
await page.click('[data-testid="tests-run-all"]');
await page.waitForSelector('[data-testid="tests-verdict"]');
assert.match(await page.textContent('[data-testid="tests-verdict"]'), /Nothing broken/);
ok("CHANGED cases alone do not block a release — only a failure or a stale case does");

const amber = await page.textContent('[data-testid="tests-summary"]');
assert.match(amber, /A changed case is not a failure/);
assert.match(amber, /Read what moved, then accept it or fix it/);
ok("and NOW the amber advice appears, because a decision is all that is left");

/* =========================================================== writing one */

await page.click('[data-testid="tests-new"]');
await page.waitForSelector('[data-testid="tc-editor"]');
await page.fill('[data-testid="tc-name"]', "A 17-year-old is screened out");
await page.fill('[data-testid="tc-seed"]', "7");
await page.fill('[data-testid="tc-answer-Q1"]', "17");
await page.selectOption('[data-testid="tc-answer-Q2"]', "1");
await page.selectOption('[data-testid="tc-end-status"]', "screened");
await page.selectOption('[data-testid="tc-not-visits"]', "p_often");
await page.fill('[data-testid="tc-variables"]', "AGE=17");
await page.click('[data-testid="tc-save"]');
await page.waitForTimeout(300);

assert.equal(lastPost.action, "create");
assert.equal(lastPost.name, "A 17-year-old is screened out");
assert.equal(lastPost.input.seed, 7);
assert.equal(lastPost.input.answers.q_age, 17, "a numeric answer is stored as a NUMBER, not a string");
assert.equal(lastPost.input.answers.q_use, 1, "an option code is stored as the engine sees it");
assert.deepEqual(lastPost.expectations, {
  endStatus: "screened", notVisits: ["p_often"], variables: { AGE: 17 },
});
ok("a case is written by picking answers and pages, and typed values reach the engine's shape");

/* a page chosen by mistake can be taken back */
await page.click('[data-testid="tests-new"]');
await page.waitForSelector('[data-testid="tc-editor"]');
await page.selectOption('[data-testid="tc-not-visits"]', "p_often");
await page.waitForSelector('[data-testid="tc-not-visits-chosen"]');
await page.click('[data-testid="tc-not-visits-chosen"] .chip');
assert.equal(await page.$('[data-testid="tc-not-visits-chosen"]'), null);
ok("a page picked by mistake can be removed, so a wrong click is not permanent");

assert.deepEqual(errors, [], `no page errors: ${errors.join(" | ")}`);
console.log(`\nALL ${passed} TEST-CASE PANEL CHECKS PASSED`);
await browser.close();

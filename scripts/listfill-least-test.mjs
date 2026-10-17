/**
 * Browser suite — LEAST FILL and Back/change consistency (audit 2026-10-17,
 * docs/LIST-FILL-LEAST-AUDIT-2026-10-17.md).
 *
 *   STUDIO   the panel offers "Least filled" with its two settings (what is
 *            counted, how ties break), hides the controls that did nothing
 *            (equal-priority rule for methods that ignore it, "when nothing
 *            is left", "store the decision trace"), offers "on a changed
 *            answer", and its simulator balances 60 respondents against the
 *            (intercepted) counters; a circular List Fill shows its lint
 *   RUNTIME  the runtime preview, carrying the counters across six simulated
 *            respondents (`listFillCounts` on the preview message — the harness
 *            plays the database's claim): each gets the least-filled item;
 *            only eligible (selected) items are ever shown; Back + change
 *            re-decides consistently (the destination, the variables and the
 *            stored answers agree), Back + no change keeps the item; an empty
 *            source hides the destination; and the EXPORT row built from the
 *            browser's real state by the engine's own `flattenVariables`
 *            carries the final allocation
 *
 *   STUDIO_URL=http://localhost:3000 RUNTIME_URL=http://localhost:3001 node scripts/listfill-least-test.mjs
 */
import assert from "node:assert/strict";
import { openHarness } from "./lib/variantHarness.mjs";
import { openPreview } from "./lib/preview.mjs";
import { SurveyDefinition } from "../packages/schema/dist/index.js";
import { flattenVariables } from "../packages/engine/dist/index.js";

const RUNTIME = process.env.RUNTIME_URL ?? "http://localhost:3001";
const h = await openHarness();
const { page } = h;
let pass = 0;
const ok = (name) => { pass++; console.log(`  ok   ${name}`); };

/* ============================================================ the survey */

const BRANDS = [["A", "Apple"], ["B", "Beta"], ["C", "Gamma"]];
const LF = (over = {}) => ({
  id: "lf1", name: "LF", enabled: true,
  source: { kind: "question", questionId: "q1", take: "selected" },
  selection: {
    count: { kind: "fixed", n: 1 }, method: "least_filled", equalPriority: "random",
    afterTarget: "continue", afterMaximum: "next_priority", fallback: "random_eligible",
    weighted: false, allowDuplicates: false, fillToCount: true,
    leastFilled: { basis: "auto", tieBreak: "sequential" },
  },
  tracking: { sampleLevel: true, respectQuotas: false, quotaIds: [], separateTestCounts: true, countOnCompleteOnly: false },
  options: BRANDS.map(([code, label]) => ({ code, label, eligible: true })),
  destinations: [{ questionId: "q2", position: 1, write: "piping_only", whenUnused: "hide" }],
  storeTrace: false,
  ...over,
});
const DEF = (listFills = [LF()]) => ({
  meta: { id: "lfleast", code: "LFLEAST", title: "Least fill", version: "1.0" },
  questions: [
    { id: "q1", code: "Q1", variableName: "USE", type: "multi_select", text: "Which brands do you use?", options: BRANDS.map(([code, label]) => ({ code, label })), settings: {} },
    {
      id: "q2", code: "Q2", variableName: "RECO", type: "multi_select", text: "Tell us about {{LISTFILL_LF_1}} — would you recommend it?",
      options: BRANDS.map(([code, label]) => ({ code, label })), settings: {},
      mask: { expr: { kind: "listFill", listFillId: "lf1" }, action: "display" },
    },
    { id: "q3", code: "Q3", variableName: "LAST", type: "open_text", text: "Anything else?", settings: {} },
  ],
  listFills,
  flow: [
    { type: "page", id: "p1", questionIds: ["q1"] },
    { type: "page", id: "p2", questionIds: ["q2"] },
    { type: "page", id: "p3", questionIds: ["q3"] },
    { type: "end", id: "e", status: "complete" },
  ],
});

/* ============================================================ STUDIO */

console.log("\nSTUDIO — the panel and its simulator");
let COUNTS = {};
await page.route("**/api/surveys/**/listfill*", async (route) => {
  if (route.request().method() === "POST") return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ ok: true, results: { TEST: 3 } }) });
  return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ counts: COUNTS, completed: {}, environment: "TEST", available: true }) });
});
await h.loadDef(DEF());
await h.goTab("List Fill");
await page.waitForSelector('[data-testid="lf-lf1"]');
await page.click('[data-testid="lf-open-lf1"]');
await page.waitForSelector('[data-testid="lf-method-lf1"]');
{
  const method = await page.$eval('[data-testid="lf-method-lf1"]', (s) => s.options[s.selectedIndex].textContent);
  assert.equal(method, "Least filled");
  assert.ok(await page.$('[data-testid="lf-least-basis-lf1"]'), "what is counted");
  assert.equal(await page.$eval('[data-testid="lf-least-tie-lf1"]', (s) => s.value), "sequential");
  const panel = await page.$eval('[data-testid="lf-lf1"]', (el) => el.textContent);
  assert.doesNotMatch(panel, /equal priority/, "the equal-priority rule is not shown for a method that ignores it");
  assert.doesNotMatch(panel, /when nothing is left/, "the fallback control is gone");
  assert.doesNotMatch(panel, /store the decision trace/, "the storeTrace control is gone");
  assert.equal(await page.$eval('[data-testid="lf-onchange-lf1"]', (s) => s.value), "keep_valid");
  ok("Least filled is a method with its own settings; controls that changed nothing are not offered; “on a changed answer” defaults to keep what still qualifies");
}
{
  COUNTS = { lf1: { A: 10, B: 0, C: 5 } };
  await page.click('[data-testid="lf-env-LIVE"]');
  await page.click('[data-testid="lf-env-TEST"]');
  await page.waitForTimeout(300);
  for (const [code] of BRANDS) {
    const box = await page.$(`[data-testid="lf-sim-pick-lf1-${code}"]`);
    if (box && !(await box.isChecked())) await box.click();
  }
  await page.fill('[data-testid="lf-lf1"] input[value="100"]', "60").catch(() => {});
  await page.click('[data-testid="lf-sim-many-lf1"]');
  await page.waitForSelector('[data-testid="lf-sim-result-lf1"]');
  const rows = await page.$$eval('[data-testid="lf-sim-result-lf1"] tbody tr', (trs) =>
    Object.fromEntries(trs.map((tr) => [tr.getAttribute("data-code"), Number(tr.querySelectorAll("td")[1].textContent)])));
  const total = rows.A + rows.B + rows.C;
  const even = Math.floor(total / 3);
  for (const c of ["A", "B", "C"]) assert.ok(Math.abs(rows[c] - even) <= 1, `${c} ends at ${rows[c]}, expected ≈${even}: ${JSON.stringify(rows)}`);
  ok(`simulating from A=10 B=0 C=5: least filled levels every brand (${JSON.stringify(rows)})`);
}
{
  // a List Fill whose source is its own destination is circular
  const circular = DEF([LF({ source: { kind: "question", questionId: "q2", take: "selected" }, destinations: [{ questionId: "q2", write: "answer" }] })]);
  await h.loadDef(circular);
  await h.goTab("List Fill");
  await page.waitForSelector('[data-testid="lf-lint-lf1"]');
  assert.match(await page.$eval('[data-testid="lf-lint-lf1"]', (el) => el.textContent), /Circular List Fill/);
  ok("a circular List Fill (source = its own destination) is flagged on the panel");
  await h.loadDef(DEF());
}

/* ============================================================ RUNTIME */

console.log("\nRUNTIME — six simulated respondents, the counters carried between them");
const parsed = SurveyDefinition.parse(DEF());
const counter = { A: 2, B: 0, C: 1 }; // the "database"
const stateOf = (pv) => pv.evaluate(() => {
  const st = window.__rescriptState;
  return JSON.parse(JSON.stringify({ answers: st.answers, calculated: st.calculated, embedded: st.embedded, seed: st.seed, stepIndex: st.stepIndex }));
});
const respondent = async (codes) => {
  const pv = await openPreview(h.browser, RUNTIME, { definition: DEF(), listFillCounts: { lf1: { ...counter } } }, { selector: '[data-qid="q1"]' });
  for (const c of codes) await pv.click(`[data-qid="q1"] input[value="${c}"]`);
  await h.next(pv);
  return pv;
};
const shownInQ2 = (pv) => pv.$$eval('[data-qid="q2"] input', (els) => els.map((e) => e.value));

{
  const got = [];
  for (let i = 0; i < 6; i++) {
    const pv = await respondent(["A", "B", "C"]);
    await pv.waitForSelector('[data-qid="q2"]');
    const st = await stateOf(pv);
    const code = st.calculated.LISTFILL_LF_1_CODE;
    got.push(code);
    assert.deepEqual(await shownInQ2(pv), [code], "Q2 shows exactly the allocated item");
    counter[code]++; // the claim
    await pv.close();
  }
  assert.deepEqual(got, ["B", "B", "C", "A", "B", "C"], `least filled, ties in source order: ${got.join(",")}`);
  assert.deepEqual(counter, { A: 3, B: 3, C: 3 });
  ok(`from A=2 B=0 C=1, six respondents get ${got.join(", ")} → every brand at 3`);
}
{
  // B is the least filled, but this respondent did not select it: only eligible items are allocated / shown
  Object.assign(counter, { A: 5, B: 0, C: 4 });
  const pv = await respondent(["A", "C"]);
  await pv.waitForSelector('[data-qid="q2"]');
  assert.deepEqual(await shownInQ2(pv), ["C"]);
  const text = await pv.$eval('[data-qid="q2"]', (el) => el.textContent);
  assert.match(text, /Tell us about Gamma/, "the piped label is the allocated item's");
  ok("only eligible items: B (least filled) was not selected, so C (4 < 5) is allocated, shown and piped");

  // Back + no change → the same item (no churn)
  await pv.click('[data-testid="rs-back"]');
  await pv.waitForSelector('[data-qid="q1"]');
  await h.next(pv);
  await pv.waitForSelector('[data-qid="q2"]');
  assert.deepEqual(await shownInQ2(pv), ["C"]);
  ok("Back + Next with nothing changed keeps the item");

  // answer Q2, then Back + change: C de-selected → re-decided to A; Q2, its answer, the variables agree
  await pv.click('[data-qid="q2"] input[value="C"]');
  await pv.click('[data-testid="rs-back"]');
  await pv.waitForSelector('[data-qid="q1"]');
  await pv.click('[data-qid="q1"] input[value="C"]'); // un-select C
  await h.next(pv);
  await pv.waitForSelector('[data-qid="q2"]');
  assert.deepEqual(await shownInQ2(pv), ["A"]);
  const st = await stateOf(pv);
  assert.equal(st.calculated.LISTFILL_LF_CODES, "A");
  assert.equal(st.calculated.LISTFILL_LF_COUNT, 1);
  assert.ok(!(st.answers.q2 ?? []).includes("C"), `the answer about C is gone: ${JSON.stringify(st.answers.q2)}`);
  ok("Back + change: C de-selected → A; Q2 shows A only, the stale answer about C is pruned, the variables agree");

  // the export row, built by the engine from this browser's real state
  const row = flattenVariables(parsed, { ...st, surveyId: "lfleast", surveyVersion: "1.0", sessionId: "pv", startedAt: "", status: "in_progress", flags: [] });
  assert.equal(row.LISTFILL_LF_1_CODE, "A");
  assert.equal(row.LISTFILL_LF_CODES, "A");
  assert.ok(!String(row.RECO ?? "").includes("C"), `RECO: ${row.RECO}`);
  ok("the export row carries the FINAL allocation (A), not the first one (C)");
  await pv.close();
}
{
  // nothing selected → the list runs to nothing and Q2 is hidden
  const pv = await respondent([]);
  await pv.waitForSelector('[data-qid="q3"]');
  assert.equal(await pv.$('[data-qid="q2"]'), null);
  assert.equal((await stateOf(pv)).calculated.LISTFILL_LF_COUNT, 0);
  // Back, select B → Q2 returns with B
  await pv.click('[data-testid="rs-back"]');
  await pv.waitForSelector('[data-qid="q1"]');
  await pv.click('[data-qid="q1"] input[value="B"]');
  await h.next(pv);
  await pv.waitForSelector('[data-qid="q2"]');
  assert.deepEqual(await shownInQ2(pv), ["B"]);
  ok("empty source → Q2 hidden; Back + select B → Q2 back with B");
  await pv.close();
}

console.log(`\n${pass} passed`);
await h.close();

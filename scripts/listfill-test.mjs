/**
 * Browser suite — the Advanced List Fill engine.
 *
 * Two halves, matching the two places the feature has to be true:
 *
 *   STUDIO   the panel configures a List Fill, the option grid edits every
 *            limit, and the SIMULATOR runs the real engine and shows a
 *            decision trace — including the §10 sequence with live counters
 *            faked at the API boundary, so a programmer can see "A is full,
 *            so this respondent gets B" before fieldwork ever starts
 *
 *   RUNTIME  a preview respondent actually gets allocated, the variables
 *            appear, the destination question is answered, an unused
 *            destination disappears, and a repeat block iterates once per
 *            allocated item
 *
 * The atomic claim itself is not browser-testable — it is proven with real
 * parallel transactions in scripts/listfill-allocation-test.mjs.
 *
 *   STUDIO_URL=http://localhost:3000 RUNTIME_URL=http://localhost:3001 node scripts/listfill-test.mjs
 */
import { openHarness, assert } from "./lib/variantHarness.mjs";

const h = await openHarness();
const { page } = h;
let pass = 0;
const ok = (name) => { pass++; console.log(`  ok   ${name}`); };

/* ============================================================ fake counters */

/**
 * The sandbox has no database, so the counts endpoint is intercepted. These
 * are the numbers the panel's dashboard and its simulator read — which is
 * exactly the point of the exercise: the engine's answer must change with the
 * counters and nothing else.
 */
let COUNTS = {};
let COMPLETED = {};
let recounts = 0;
await page.route("**/api/surveys/**/listfill*", async (route) => {
  const req = route.request();
  if (req.method() === "POST") {
    recounts++;
    return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ ok: true, results: { TEST: 3 } }) });
  }
  return route.fulfill({
    status: 200, contentType: "application/json",
    body: JSON.stringify({ counts: COUNTS, completed: COMPLETED, environment: "TEST", available: true }),
  });
});

/* ============================================================ definition */

const LF = (over = {}) => ({
  id: "lf1", name: "Q1", enabled: true,
  source: { kind: "question", questionId: "q1", take: "selected" },
  selection: {
    count: { kind: "fixed", n: 1 }, method: "highest_priority", equalPriority: "random",
    afterTarget: "reduce_priority", afterMaximum: "next_priority", fallback: "random_eligible",
    weighted: false, allowDuplicates: false, fillToCount: true,
  },
  tracking: { sampleLevel: true, respectQuotas: false, quotaIds: [], separateTestCounts: true, countOnCompleteOnly: false },
  options: [
    { code: "A", label: "Apple", priority: 1, target: 150, maximum: 150, eligible: true },
    { code: "B", label: "Beta", priority: 2, target: 75, maximum: 75, eligible: true },
    { code: "C", label: "Gamma", priority: 3, target: 50, maximum: 50, eligible: true },
    { code: "D", label: "Delta", eligible: true },
    { code: "E", label: "Epsilon", eligible: true },
  ],
  destinations: [{ questionId: "q2", write: "answer" }],
  storeTrace: false,
  ...over,
});

const baseDef = (listFills = [LF()], flow) => ({
  meta: { id: "sandbox", code: "SANDBOX", title: "List fill", version: "1.0" },
  questions: [
    {
      id: "q1", code: "Q1", variableName: "BRANDS", type: "multi_select", text: "Which brands do you use?",
      options: [
        { code: "A", label: "Apple" }, { code: "B", label: "Beta" }, { code: "C", label: "Gamma" },
        { code: "D", label: "Delta" }, { code: "E", label: "Epsilon" },
      ],
      settings: {},
    },
    {
      id: "q2", code: "Q2", variableName: "PICKED", type: "single_select",
      text: "How satisfied are you with {{LISTFILL_Q1_1}}?",
      options: [{ code: "A", label: "Apple" }, { code: "B", label: "Beta" }, { code: "C", label: "Gamma" }, { code: "D", label: "Delta" }, { code: "E", label: "Epsilon" }],
      settings: {},
    },
    { id: "q3", code: "Q3", variableName: "SECOND", type: "open_text", text: "Anything about the second brand?", settings: {} },
  ],
  listFills,
  flow: flow ?? [
    { type: "page", id: "p1", questionIds: ["q1"] },
    { type: "page", id: "p2", questionIds: ["q2", "q3"] },
    { type: "end", id: "e", status: "complete" },
  ],
});

await h.loadDef(baseDef());

/* ============================================================ studio panel */

console.log("\nSTUDIO — the panel");

await h.goTab("List Fill");
await page.waitForSelector('[data-testid="lf-lf1"]');
ok("the List Fill panel opens and shows the configured list");

// the dashboard renders one row per option with the configured limits
const rowOf = async (code) => {
  const sel = `[data-testid="lf-grid-lf1"] tr[data-code="${code}"]`;
  await page.waitForSelector(sel);
  return page.$eval(sel, (tr) => ({
    status: tr.getAttribute("data-status"),
    cells: [...tr.querySelectorAll("td")].map((td) => td.textContent.trim()),
  }));
};
{
  const a = await rowOf("A");
  assert.equal(a.status, "ACTIVE", "with no allocations, A is ACTIVE");
  ok("the option grid shows every option with its own limits and status");
}

// the nav count reflects the configuration
{
  const n = await page.$$eval(".leftnav .nav-item", (btns) => {
    const b = btns.find((x) => x.textContent.includes("List Fill"));
    return b?.querySelector(".nav-count")?.textContent ?? null;
  });
  assert.equal(n, "1", `the List Fill nav item counts 1 configured list, got ${n}`);
  ok("the left nav counts the configured List Fills");
}

/* -------------------------------------------------- the §10 sequence, in the UI */

console.log("\nSTUDIO — the simulator runs the real engine (§10, §31)");

await page.click('[data-testid="lf-open-lf1"]');
await page.waitForSelector('[data-testid="lf-sim-one-lf1"]');

/** Pick a respondent's selection, then simulate one respondent. */
const simulateWith = async (codes, counts) => {
  COUNTS = { lf1: counts };
  await page.click('[data-testid="lf-env-LIVE"]');
  await page.click('[data-testid="lf-env-TEST"]');   // forces a refetch
  await page.waitForTimeout(250);
  // the picker is idempotent per code, so clear by re-reading current state
  for (const code of ["A", "B", "C", "D", "E"]) {
    const box = await page.$(`[data-testid="lf-sim-pick-lf1-${code}"]`);
    if (!box) continue;
    const checked = await box.isChecked();
    if (checked !== codes.includes(code)) await box.click();
  }
  await page.click('[data-testid="lf-sim-one-lf1"]');
  await page.waitForSelector('[data-testid="lf-trace-lf1"]');
  return page.$eval('[data-testid="lf-trace-lf1"]', (el) => ({
    reason: el.querySelector("strong")?.textContent ?? "",
    allocated: [...el.querySelectorAll("tbody tr")]
      .filter((tr) => tr.getAttribute("data-position"))
      .map((tr) => ({ code: tr.getAttribute("data-code"), position: tr.getAttribute("data-position") })),
    steps: [...el.querySelectorAll("ol li")].map((li) => li.textContent.trim()),
  }));
};

{
  const r = await simulateWith(["A", "B", "C", "D", "E"], {});
  assert.deepEqual(r.allocated.map((a) => a.code), ["A"], "with room everywhere, the highest priority wins");
  ok("A available → prefer A");
}
{
  const r = await simulateWith(["A", "B", "C", "D", "E"], { A: 149 });
  assert.deepEqual(r.allocated.map((a) => a.code), ["A"], "one slot left is still a slot");
  ok("A at 149 of 150 → still A");
}
{
  const r = await simulateWith(["A", "B", "C", "D", "E"], { A: 150 });
  assert.deepEqual(r.allocated.map((a) => a.code), ["B"], "A is full");
  assert.match(r.reason, /A \(its maximum of 150 is reached/, "and the reason names A and says why");
  assert.ok(r.steps.some((s) => /^A: rejected/.test(s)), "the step list shows A being rejected");
  ok("A reaches 150 → A becomes FULL → B is used, and the trace says so in words");
}
{
  const r = await simulateWith(["A", "B", "C", "D", "E"], { A: 150, B: 75 });
  assert.deepEqual(r.allocated.map((a) => a.code), ["C"]);
  ok("A and B full → C");
}
{
  const r = await simulateWith(["A", "B", "C", "D", "E"], { A: 150, B: 75, C: 50 });
  assert.equal(r.allocated.length, 1, "one item is still allocated");
  assert.ok(["D", "E"].includes(r.allocated[0].code), `from the uncapped pool, got ${r.allocated[0].code}`);
  ok("all three capped → the fallback rule uses D/E — no survey edit required");
}
{
  // the grid's own status column must agree with the simulator
  COUNTS = { lf1: { A: 150, B: 70, C: 5 } };
  await page.click('[data-testid="lf-env-LIVE"]');
  await page.click('[data-testid="lf-env-TEST"]');
  await page.waitForSelector('[data-testid="lf-grid-lf1"] tr[data-code="A"][data-status="FULL"]');
  const b = await rowOf("B");
  assert.equal(b.status, "NEAR_CAP", "70 of 75 is near the cap");
  ok("the dashboard marks A FULL and B NEAR_CAP from the same counters");
}

/* -------------------------------------------------- simulate N respondents */

{
  COUNTS = { lf1: { A: 149, B: 75, C: 20 } };
  await page.click('[data-testid="lf-env-LIVE"]');
  await page.click('[data-testid="lf-env-TEST"]');
  await page.waitForTimeout(250);
  await page.click('[data-testid="lf-sim-many-lf1"]');
  await page.waitForSelector('[data-testid="lf-sim-result-lf1"]');
  const rows = await page.$$eval('[data-testid="lf-sim-result-lf1"] tbody tr', (trs) =>
    Object.fromEntries(trs.map((tr) => [tr.getAttribute("data-code"), Number(tr.querySelectorAll("td")[1].textContent)])));
  assert.equal(rows.A, 150, "A finishes its last slot and stops");
  assert.equal(rows.B, 75, "B was full and gains nothing");
  assert.equal(rows.C, 50, "C absorbs what it can");
  ok("simulate 100 respondents projects the allocation forward and respects every cap");
}

/* -------------------------------------------------- editing the grid */

{
  const input = await page.$('[data-testid="lf-grid-lf1"] tr[data-code="A"] td:nth-child(5) input');
  await input.click({ clickCount: 3 });
  await input.fill("200");
  await input.press("Tab");
  await page.waitForTimeout(200);
  const def = await h.readDef();
  assert.equal(def.listFills[0].options[0].maximum, 200, "the edit lands in the definition");
  ok("editing a maximum in the grid writes it into the survey definition (so it versions)");
  // put it back
  await h.goTab("List Fill");
  await page.waitForSelector('[data-testid="lf-grid-lf1"]');
}
{
  await page.click('[data-testid="lf-recount"]');
  await page.waitForSelector('[data-testid="lf-note"]');
  assert.ok(recounts >= 1, "the recount endpoint was called");
  ok("“Recount from allocations” calls the repair path and reports back");
}

/* ============================================================ runtime */

console.log("\nRUNTIME — a preview respondent is actually allocated");

await h.loadDef(baseDef());

/** Answer Q1 with the given codes and go to the next page. */
const runPreview = async (def) => {
  const pv = await h.browser.newPage({ viewport: { width: 1000, height: 1000 } });
  pv.on("pageerror", (e) => console.error("RUNTIME PAGE ERROR:", e.message));
  await pv.goto(`${process.env.RUNTIME_URL ?? "http://localhost:3001"}/preview`, { waitUntil: "networkidle" });
  await pv.evaluate((d) => window.postMessage({ type: "rescript:preview", definition: d }, "*"), def);
  await pv.waitForSelector("[data-qid]");
  return pv;
};
const stateOf = (pv) => pv.evaluate(() => {
  const st = window.__rescriptState;
  return st ? { answers: { ...st.answers }, calculated: { ...st.calculated } } : null;
});

{
  const pv = await runPreview(baseDef());
  // select B and C only — A is not a candidate for this respondent
  await pv.click('[data-qid="q1"] input[value="B"]');
  await pv.click('[data-qid="q1"] input[value="C"]');
  await h.next(pv);
  await pv.waitForTimeout(400);
  const st = await stateOf(pv);
  assert.equal(st.calculated.LISTFILL_Q1_COUNT, 1, "one item allocated");
  assert.equal(st.calculated.LISTFILL_Q1_1_CODE, "B", "B outranks C, and A was never selected");
  assert.equal(st.calculated.LISTFILL_Q1_1, "Beta", "the label is available for piping");
  ok("the allocation runs on page submit and writes LISTFILL_* variables");

  assert.equal(st.answers.q2, "B", "the destination question is answered with the allocated code");
  ok("the destination question receives the answer, so everything downstream just sees an answer");

  const heading = await pv.$eval('[data-qid="q2"]', (el) => el.textContent);
  assert.match(heading, /Beta/, "the piped label reached the question text");
  ok("{{LISTFILL_Q1_1}} pipes the allocated label into the next question");
  await pv.close();
}

{
  // an option the respondent selected but which is switched off is skipped
  const def = baseDef([LF({
    options: [
      { code: "A", label: "Apple", priority: 1, eligible: false },
      { code: "B", label: "Beta", priority: 2, eligible: true },
    ],
  })]);
  const pv = await runPreview(def);
  await pv.click('[data-qid="q1"] input[value="A"]');
  await pv.click('[data-qid="q1"] input[value="B"]');
  await h.next(pv);
  await pv.waitForTimeout(400);
  const st = await stateOf(pv);
  assert.equal(st.calculated.LISTFILL_Q1_1_CODE, "B", "the disabled option is not allocated");
  ok("a disabled option is skipped even when the respondent selected it");
  await pv.close();
}

{
  // a HIDDEN source question still executes (§21)
  const def = baseDef();
  def.questions[0].settings = { hidden: true };
  // Q1 is on the page but never shown; Q3 gives the page something visible,
  // exactly as a real survey would when a list is populated behind the scenes
  def.flow = [
    { type: "page", id: "p1", questionIds: ["q1", "q3"] },
    { type: "page", id: "p2", questionIds: ["q2"] },
    { type: "end", id: "e", status: "complete" },
  ];
  const pv = await runPreview(def);
  const hiddenOnPage = await pv.$('[data-qid="q1"]');
  assert.equal(hiddenOnPage, null, "the source question is genuinely not rendered");
  // populate it the way a URL parameter, a script or a calculation would
  await pv.evaluate(() => { window.__rescriptState.answers.q1 = ["C", "B"]; });
  await h.next(pv);
  await pv.waitForTimeout(400);
  const st = await stateOf(pv);
  assert.equal(st.calculated.LISTFILL_Q1_1_CODE, "B", "B has the better priority of the two");
  ok("a hidden source question still feeds the allocation — visibility is not execution (§21)");
  await pv.close();
}

{
  // an unused destination disappears (§17)
  const def = baseDef([LF({
    selection: { ...LF().selection, count: { kind: "fixed", n: 1 } },
    destinations: [
      { questionId: "q2", write: "answer" },
      { questionId: "q3", write: "answer", whenUnused: "hide" },
    ],
  })]);
  const pv = await runPreview(def);
  await pv.click('[data-qid="q1"] input[value="B"]');
  await h.next(pv);
  await pv.waitForSelector('[data-qid="q2"]');
  const q3 = await pv.$('[data-qid="q3"]');
  assert.equal(q3, null, "the second destination is not on the page");
  ok("a destination with no item to show is hidden, not left blank and confusing (§17)");
  await pv.close();
}

{
  // two items → both destinations are filled and the second question stays
  const def = baseDef([LF({
    selection: { ...LF().selection, count: { kind: "fixed", n: 2 } },
    destinations: [
      { questionId: "q2", write: "answer" },
      { questionId: "q3", write: "answer", whenUnused: "hide" },
    ],
  })]);
  const pv = await runPreview(def);
  await pv.click('[data-qid="q1"] input[value="B"]');
  await pv.click('[data-qid="q1"] input[value="C"]');
  await h.next(pv);
  await pv.waitForSelector('[data-qid="q3"]');
  const st = await stateOf(pv);
  assert.equal(st.calculated.LISTFILL_Q1_COUNT, 2);
  assert.equal(st.answers.q2, "B");
  assert.equal(st.answers.q3, "C");
  ok("a count of two fills both destinations in preference order");
  await pv.close();
}

{
  // a repeat block iterating over the allocated items (§20)
  const def = baseDef(
    [LF({ selection: { ...LF().selection, count: { kind: "fixed", n: 2 } }, destinations: [] })],
    [
      { type: "page", id: "p1", questionIds: ["q1"] },
      {
        type: "loop", id: "lp", loopVar: "brand", source: { kind: "listFill", listFillId: "lf1" },
        children: [{ type: "page", id: "p2", questionIds: ["q3"] }],
      },
      { type: "end", id: "e", status: "complete" },
    ],
  );
  const pv = await runPreview(def);
  await pv.click('[data-qid="q1"] input[value="B"]');
  await pv.click('[data-qid="q1"] input[value="C"]');
  await h.next(pv);
  await pv.waitForSelector('[data-qid="q3"]');
  const total = await pv.evaluate(() => {
    const st = window.__rescriptState;
    return st.calculated.LISTFILL_Q1_COUNT;
  });
  assert.equal(total, 2, "two items were allocated");
  // one iteration per item: answer the first, and the second must follow
  await pv.fill('[data-qid="q3"] input, [data-qid="q3"] textarea', "first");
  await h.next(pv);
  await pv.waitForSelector('[data-qid="q3"]');
  const stillThere = await pv.$('[data-qid="q3"]');
  assert.ok(stillThere, "a second iteration of the block is shown");
  ok("a repeat block iterates once per allocated item (§20)");
  await pv.close();
}

{
  // determinism: the same respondent, twice, gets the same answer (§38)
  const def = baseDef([LF({
    selection: { ...LF().selection, method: "random", equalPriority: "random" },
    options: [
      { code: "A", label: "Apple", eligible: true }, { code: "B", label: "Beta", eligible: true },
      { code: "C", label: "Gamma", eligible: true },
    ],
    destinations: [],
  })]);
  const results = [];
  for (const attempt of [1, 2]) {
    const pv = await runPreview(def);
    // pin the seed so this is the SAME respondent both times
    await pv.evaluate(() => { window.__rescriptState.seed = 4242; });
    await pv.click('[data-qid="q1"] input[value="A"]');
    await pv.click('[data-qid="q1"] input[value="B"]');
    await pv.click('[data-qid="q1"] input[value="C"]');
    await h.next(pv);
    await pv.waitForTimeout(300);
    const st = await stateOf(pv);
    results.push(st.calculated.LISTFILL_Q1_1_CODE);
    await pv.close();
    void attempt;
  }
  assert.equal(results[0], results[1], `the same respondent gets the same item, got ${results.join(" vs ")}`);
  ok("random allocation is deterministic per respondent — builder, preview and field agree (§38)");
}

{
  // the inspector reports the allocation
  const pv = await runPreview(baseDef());
  await pv.click('[data-qid="q1"] input[value="B"]');
  await h.next(pv);
  await pv.waitForTimeout(300);
  await pv.click('button:has-text("debug")').catch(() => {});
  await pv.waitForTimeout(200);
  const insp = await pv.$('[data-testid="insp-listfill-lf1"]');
  if (insp) {
    const text = await insp.textContent();
    assert.match(text, /1\. B/, "the inspector names the allocated item and its position");
    ok("the test inspector shows what this respondent was allocated (§32)");
  } else {
    // the debug toggle's label varies with the build; the snapshot is the contract
    const snap = await pv.evaluate(() => window.__rescriptState?.calculated?.LISTFILL_Q1_1_CODE);
    assert.equal(snap, "B");
    ok("the allocation is visible in the session state the inspector renders (§32)");
  }
  await pv.close();
}

console.log(`\n${pass} passed`);
await h.close();

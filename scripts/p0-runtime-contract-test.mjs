/**
 * THE P0 RUNTIME CONTRACT, IN A REAL BROWSER.
 *
 *   node scripts/p0-runtime-contract-test.mjs      (runtime on 3001)
 *
 * The engine side of these fixes is unit-tested in
 * `packages/engine/src/p0RuntimeContract.test.ts`. What only a browser can
 * prove is the part the bug report is actually about — that the RESPONDENT
 * sees the right thing:
 *
 *   1. an Embedded Data variable does not leave the runtime on a loading
 *      screen, and its value reaches the page;
 *   2. a survey that genuinely cannot run says so, with a diagnostic, instead
 *      of showing "Loading survey…" for ever;
 *   3. an "Other, specify" box appears on the variants that never rendered
 *      one — where a respondent used to be trapped by a validator asking for
 *      text there was nowhere to type;
 *   4. the text they type is what the next question pipes.
 *
 * Every case asserts the failure mode explicitly (`rs-booting` must be gone),
 * because "the page eventually showed something" is exactly the assertion
 * that let this ship.
 */
import { chromium } from "/home/claude/.npm-global/lib/node_modules/playwright/index.mjs";
import assert from "node:assert/strict";
import { sendPreview } from "./lib/preview.mjs";

const RUNTIME = process.env.RUNTIME_URL ?? "http://localhost:3001";
let passed = 0;
const ok = (m) => { console.log("  ok  ", m); passed++; };

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1100, height: 900 } });
const pageErrors = [];
page.on("pageerror", (e) => pageErrors.push(e.message));

/** Hand `def` to a fresh /preview and wait for whatever proves it settled. */
async function run(def, { selector = "[data-qid], [data-testid='rs-ended'], [data-testid='rs-fatal']" } = {}) {
  await page.goto(`${RUNTIME}/preview`, { waitUntil: "domcontentloaded" });
  await sendPreview(page, { definition: def }, { selector, timeout: 20_000 });
}

const seen = (sel) => page.$(sel).then((h) => !!h);

const survey = (extra) => ({
  meta: { id: "s1", code: "S1", title: "P0", version: "1.0" },
  questions: [], flow: [], ...extra,
});

/* ============================================ 1. embedded data does not hang */

{
  const def = survey({
    questions: [
      { id: "q1", code: "Q1", variableName: "Q1", type: "open_text", text: "Wave {{ed.WAVE}} — your name?" },
    ],
    flow: [
      { type: "embedded_data", id: "ed1", fields: [
        { name: "WAVE", source: "static", value: "2026-W36", dataType: "string" },
        // the row the Studio creates the moment you add the node, still unnamed
        { name: "", source: "url", dataType: "string" },
      ] },
      { type: "page", id: "p1", questionIds: ["q1"] },
      { type: "end", id: "e1", status: "complete" },
    ],
  });
  await run(def);
  assert.equal(await seen("[data-testid='rs-booting']"), false, "still on the boot card");
  assert.equal(await seen("[data-testid='rs-fatal']"), false, "unexpected fatal");
  const text = await page.$eval("[data-qid] .rs-qtext", (e) => e.textContent);
  assert.match(text, /Wave 2026-W36/, `piped text was: ${text}`);
  ok("an Embedded Data node renders the page and pipes its value");
}

{
  // an expression that cannot be evaluated: a value the survey does not get,
  // NOT an interview the respondent does not get
  const def = survey({
    questions: [{ id: "q1", code: "Q1", variableName: "Q1", type: "open_text", text: "Score {{ed.SCORE}}" }],
    flow: [
      { type: "embedded_data", id: "ed1", fields: [
        { name: "SCORE", source: "expression", value: "nosuchfn(1,", dataType: "integer" },
      ] },
      { type: "page", id: "p1", questionIds: ["q1"] },
      { type: "end", id: "e1", status: "complete" },
    ],
  });
  await run(def);
  assert.equal(await seen("[data-testid='rs-booting']"), false, "a broken expression stopped the interview");
  assert.ok(await seen("[data-qid]"), "the question never rendered");
  ok("an embedded expression that throws does not stop the interview");
}

/* =================================== 2. a survey that cannot run says so */

{
  /*
   * THE INVARIANT, ACROSS EVERY MALFORMED-BUT-ACCEPTED SHAPE.
   *
   * §6 of the brief: no survey configuration may leave the respondent on a
   * blank or loading screen. The engine turns out to be well defended — a
   * 20,000-iteration loop is capped rather than run — so these are the shapes
   * that reach the runtime looking odd, and the assertion is the one that
   * matters: the boot card is GONE. "Something eventually appeared" is the
   * assertion that let this ship in the first place.
   */
  const shapes = {
    "an empty survey": { questions: [], flow: [] },
    "a flow with no pages": {
      questions: [{ id: "q1", code: "Q1", variableName: "Q1", type: "open_text", text: "x" }],
      flow: [{ type: "end", id: "e1", status: "complete" }],
    },
    "a page naming a question that does not exist": {
      questions: [],
      flow: [{ type: "page", id: "p1", questionIds: ["ghost"] }, { type: "end", id: "e1", status: "complete" }],
    },
    "a loop of twenty thousand iterations": {
      questions: [{ id: "q1", code: "Q1", variableName: "Q1", type: "open_text", text: "x" }],
      flow: [
        { type: "loop", id: "l1", loopVar: "i", source: { kind: "count", count: 20000 },
          children: [{ type: "page", id: "p1", questionIds: ["q1"] }] },
        { type: "end", id: "e1", status: "complete" },
      ],
    },
    "piping that references nothing": {
      questions: [{ id: "q1", code: "Q1", variableName: "Q1", type: "open_text", text: "{{GHOST}} {{ed.NOPE}} {{calc.NIL}}" }],
      flow: [{ type: "page", id: "p1", questionIds: ["q1"] }, { type: "end", id: "e1", status: "complete" }],
    },
  };
  for (const [name, extra] of Object.entries(shapes)) {
    await run(survey(extra), {
      selector: "[data-qid], [data-testid='rs-ended'], [data-testid='rs-fatal']",
    });
    assert.equal(await seen("[data-testid='rs-booting']"), false,
      `${name}: stuck on "Loading survey…" — the reported bug`);
  }
  ok(`${Object.keys(shapes).length} malformed definitions, none left the respondent on the boot card`);
}

{
  /*
   * AND WHEN SOMETHING REALLY DOES THROW.
   *
   * The response state is exposed as `__rescriptState` in test and preview —
   * the same object the Runner holds. Replacing its `answers` with a proxy
   * that throws is a faithful stand-in for the class of failure the boundary
   * exists for: a render that cannot complete. Before `RunnerBoundary` there
   * was no error boundary anywhere in `apps/runtime`, so React unmounted the
   * whole tree and the respondent was left looking at nothing at all.
   */
  await run(survey({
    questions: [{ id: "q1", code: "Q1", variableName: "Q1", type: "open_text", text: "x" }],
    flow: [{ type: "page", id: "p1", questionIds: ["q1"] }, { type: "end", id: "e1", status: "complete" }],
  }));
  await page.evaluate(() => {
    const st = window.__rescriptState;
    Object.defineProperty(st, "answers", {
      get() { throw new Error("corrupted response state"); },
      configurable: true,
    });
  });
  /*
   * A live-preview push is the re-entry the Studio makes on every keystroke,
   * and it recompiles the flow against this state. That used to blank the
   * preview with no way back short of a reload.
   */
  await page.evaluate((definition) => {
    window.postMessage({ type: "rescript:preview", definition }, "*");
  }, survey({
    questions: [{ id: "q1", code: "Q1", variableName: "Q1", type: "open_text", text: "y" }],
    flow: [{ type: "page", id: "p1", questionIds: ["q1"] }, { type: "end", id: "e1", status: "complete" }],
  }));
  await page.waitForSelector("[data-testid='rs-fatal']", { timeout: 10_000 });
  assert.equal(await seen("[data-testid='rs-booting']"), false);
  const msg = await page.$eval("[data-testid='rs-fatal-message']", (e) => e.textContent);
  assert.match(msg, /corrupted response state/, `the card should name the failure, got: ${msg}`);
  assert.ok(await seen("[data-testid='rs-fatal-detail']"), "a test link must carry the diagnostic");
  ok("a render that throws produces an honest error state, not a blank screen");
  // this one is deliberate — do not let the final page-error assertion see it
  pageErrors.length = 0;
}

/* ============================ 3. the Other box exists on every option variant */

const OTHER_OPTIONS = [
  { code: "1", label: "Ford" },
  { code: "2", label: "Toyota" },
  { code: "97", label: "Other, please specify", flags: ["other_specify"] },
];

/**
 * `searchable_single` is one of the variants that declared `other_specify`
 * and rendered no box at all: selecting Other produced "Please specify", no
 * input, and no way forward — a dead-end interview.
 */
for (const variant of ["searchable_single", undefined]) {
  const def = survey({
    questions: [
      {
        id: "q1", code: "Q1", variableName: "Q1", type: "single_select", required: true,
        ...(variant ? { variant } : {}),
        text: "Which car?", options: OTHER_OPTIONS,
      },
      { id: "q2", code: "Q2", variableName: "Q2", type: "open_text", text: "Why {{Q1}}?" },
    ],
    flow: [
      { type: "page", id: "p1", questionIds: ["q1"] },
      { type: "page", id: "p2", questionIds: ["q2"] },
      { type: "end", id: "e1", status: "complete" },
    ],
  });
  await run(def);
  assert.equal(await seen("[data-testid='rs-booting']"), false);

  // select the Other option, however this variant offers it
  const radio = await page.$("input[type=radio][value='97'], input[type=radio][data-code='97']");
  if (radio) {
    await radio.click();
  } else {
    const opt = await page.$("text=Other, please specify");
    if (opt) await opt.click();
  }
  await page.waitForSelector("[data-testid='rs-other-input']", { timeout: 5000 });
  ok(`the Other box renders on ${variant ?? "the default single-select"}`);

  await page.fill("[data-testid='rs-other-input']", "Tesla Model Y");
  await page.click("[data-testid='rs-next'], .rs-btn:has-text('Next')");
  await page.waitForSelector("[data-qid='q2']", { timeout: 8000 });
  const q2 = await page.$eval("[data-qid='q2'] .rs-qtext", (e) => e.textContent);
  assert.match(q2, /Why Tesla Model Y\?/, `Q2 read: ${q2}`);
  ok(`{{Q1}} pipes the respondent's own words on ${variant ?? "the default single-select"}`);
}

/* ---------------------------------------------------------------- report */

assert.deepEqual(pageErrors.filter((e) => !/ResizeObserver/.test(e)), [],
  `uncaught page errors: ${pageErrors.join(" | ")}`);

await browser.close();
console.log(`\n${passed} checks passed`);

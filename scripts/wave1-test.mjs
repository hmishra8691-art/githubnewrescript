/**
 * WAVE 1 — the inert features, in a real browser.
 *
 * The engine tests prove the rules; this proves the RUNTIME actually invokes
 * them, which is where every one of these features was lost. A validation
 * script that the engine can run but the Runner never calls is exactly as
 * useless as one that does not exist, so each check below drives the
 * respondent experience end to end:
 *
 *   §21  survey-level custom JavaScript executes
 *        on_validate blocks the page; on_complete writes into the response
 *        a question's own customJs runs on an ordinary question type
 *   §9   a warning is shown and then lets the respondent through
 *        a date outside minDate/maxDate is refused by the engine, not the picker
 *   §12  a piped image URL resolves per respondent
 *   §11  a url embedded field declared inside a block is captured
 *
 *   node scripts/wave1-test.mjs        (runtime dev server on 3001)
 */
import { chromium } from "/home/claude/.npm-global/lib/node_modules/playwright/index.mjs";
import assert from "node:assert/strict";
import { sendPreview } from "./lib/preview.mjs";

const RUNTIME = process.env.RUNTIME_URL ?? "http://localhost:3001";
let passed = 0;
const ok = (m) => { console.log("  ok  ", m); passed++; };

/* ------------------------------------------------------------------ fixture */

const def = {
  meta: { id: "wave1", code: "WAVE1", title: "Wave 1", version: "1.0", schemaVersion: 1, status: "draft" },
  branding: {
    // §21 — stored, edited, and never executed until now
    customJs: 'document.documentElement.setAttribute("data-survey-js", "ran");',
  },
  questions: [
    {
      id: "q_pack", code: "Q1", variableName: "PACK", type: "single_select",
      text: "Which pack?",
      // §12 — the stimulus is per respondent
      settings: { mediaUrl: "https://cdn.example.com/{{ed.REGION}}/hero.png" },
      options: [{ code: 1, label: "Blue" }, { code: 2, label: "Red" }],
      required: true,
    },
    {
      id: "q_spend", code: "Q2", variableName: "SPEND", type: "numeric",
      text: "Monthly spend?",
      // §9 — a soft check that must not make a legitimate answer impossible
      validation: [{ kind: "max_value", value: 500, severity: "warning", message: "Unusually high — sure?" }],
    },
    {
      id: "q_when", code: "Q3", variableName: "WHEN", type: "date",
      text: "Start date?",
      settings: { minDate: "2026-01-01", maxDate: "2026-12-31" },
    },
    {
      id: "q_note", code: "Q4", variableName: "NOTE", type: "open_text",
      text: "Anything else?",
      // §21 — customJs on an ordinary question, not a custom_component
      customJs: 'el.setAttribute("data-question-js", "ran");',
    },
  ],
  flow: [
    {
      type: "block", id: "b1", children: [
        // §11 — declared INSIDE a block, which the runtime used to walk past
        { type: "embedded_data", id: "ed1", fields: [{ name: "REGION", source: "url" }] },
        { type: "page", id: "p1", questionIds: ["q_pack", "q_spend", "q_when", "q_note"] },
      ],
    },
    { type: "end", id: "e1", status: "complete", message: "Done." },
  ],
  scripts: [
    {
      id: "sv", name: "gate", scope: "survey", event: "on_validate", enabled: true,
      // blocks until the note says something
      code: 'if (!get("Q4")) error("Please add a note before continuing.", "q_note");',
    },
    {
      id: "sc", name: "stamp", scope: "survey", event: "on_complete", enabled: true,
      code: 'setCalc("FINISHED_AT", "yes");',
    },
  ],
  logicFlow: { nodes: [], edges: [] },
  displayRules: [], calculations: [], quotas: [], designs: [], variables: [],
  embeddedData: [], listFills: [],
  deployment: { clientSlug: "c", studySlug: "s", languages: ["en"], access: { mode: "open" } },
};

const browser = await chromium.launch();
const ctx = await browser.newContext({ viewport: { width: 1200, height: 900 } });
const page = await ctx.newPage();
const errors = [];
page.on("pageerror", (e) => errors.push(String(e)));

/** Load the preview harness with this definition and a REGION url parameter. */
const load = async (params = "REGION=uk") => {
  await page.goto(`${RUNTIME}/preview?${params}`, { waitUntil: "networkidle" });
  await sendPreview(page, { definition: def }, { selector: '[data-qid="q_pack"]' });
};

await load();

/* ---------------------------------------------------------------- §21 §11 §12 */

console.log("\nTHE INERT FEATURES, IN A LIVE INTERVIEW");

assert.equal(await page.getAttribute("html", "data-survey-js"), "ran",
  "the survey's own custom JavaScript never ran");
ok("survey-level custom JavaScript executes (§21)");

const img = await page.getAttribute('[data-testid="rs-qmedia"] img', "src");
assert.equal(img, "https://cdn.example.com/uk/hero.png",
  `the stimulus URL was not piped — got ${img}`);
ok("a piped stimulus resolves per respondent, from a url parameter (§12, §11)");

assert.ok(await page.$('[data-qid="q_note"] [data-testid="rs-question-script"]'));
assert.equal(
  await page.getAttribute('[data-qid="q_note"]', "data-question-js"), "ran",
  "a question's own customJs did not run on an ordinary question type",
);
ok("a question's customJs runs on an ordinary question type (§21)");

/* --------------------------------------------------------------------- §9 §21 */

console.log("\nVALIDATION: WHAT BLOCKS, WHAT ONLY WARNS");

await page.fill('[data-qid="q_spend"] input', "900");
await page.fill('[data-qid="q_when"] input', "2027-06-01");
await page.click('[data-qid="q_pack"] label:has-text("Blue")');
await page.click('[data-testid="rs-next"]');
await page.waitForTimeout(400);

let messages = await page.$$eval(".rs-error-msg", (es) => es.map((e) => e.textContent.trim()));
assert.ok(messages.some((m) => /on or before 2026-12-31/.test(m)),
  `the engine did not refuse an out-of-range date: ${JSON.stringify(messages)}`);
ok("a date outside minDate/maxDate is refused by the engine, not only the picker (§9)");

assert.ok(messages.some((m) => /Please add a note/.test(m)),
  `the on_validate script did not run: ${JSON.stringify(messages)}`);
ok("an on_validate script blocks the page (§21)");

assert.ok(await page.$('[data-qid="q_pack"]'), "the page must not advance while blocked");

await page.fill('[data-qid="q_when"] input', "2026-06-01");
await page.fill('[data-qid="q_note"] input, [data-qid="q_note"] textarea', "all good");
await page.click('[data-testid="rs-next"]');
await page.waitForTimeout(400);

messages = await page.$$eval(".rs-error-msg", (es) => es.map((e) => e.textContent.trim()));
assert.deepEqual(messages, ["Unusually high — sure?"],
  `only the warning should remain: ${JSON.stringify(messages)}`);
assert.ok(await page.$('[data-qid="q_pack"]'), "the warning is shown before the page is left");
ok("a warning is surfaced once, and does not read as an error (§9)");

await page.click('[data-testid="rs-next"]');
await page.waitForTimeout(600);
assert.equal(await page.$('[data-qid="q_pack"]'), null,
  "the second Next must proceed — a warning may never trap a respondent");
ok("the same answer goes through on the next click (§9)");

/* ------------------------------------------------------------------- §21 end */

const finished = await page.evaluate(() => window.__rescriptState?.calculated?.FINISHED_AT ?? null);
assert.equal(finished, "yes", "the on_complete script did not run before the response was finished");
ok("an on_complete script runs, and its write is part of the response (§21)");

assert.deepEqual(errors, [], `uncaught errors: ${errors.join("\n")}`);
ok("no uncaught errors anywhere in the session");

await browser.close();
console.log(`\nALL ${passed} WAVE 1 CHECKS PASSED\n`);

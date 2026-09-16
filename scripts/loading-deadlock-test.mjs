/**
 * "LOADING…" MUST NEVER BE A DESTINATION.
 *
 *   node scripts/loading-deadlock-test.mjs        (runtime on 3001)
 *
 * ## The bug this suite exists for
 *
 * A survey sat on a loading screen and never rendered. Nothing threw, no
 * request failed, no promise was pending. The runtime had finished loading and
 * was parked on a step it could not draw:
 *
 *   - the flow began with an `embedded_data` node, the ordinary way to capture
 *     URL parameters, so compiled step 0 was not a page;
 *   - the resume path restored `responses.step_index` with a bare
 *     `Math.max(0, Math.min(saved, len - 1))`, and a row created when the
 *     session started but never advanced holds `step_index = 0`;
 *   - so the runtime resumed onto the embedded-data step, `pageStep` was null,
 *     and the Runner's `!pageStep` branch rendered "Loading…";
 *   - and it could never leave, because the only callers of `advance()` are
 *     the Next and Back handlers and both begin `if (!pageStep) return;`.
 *
 * The index arithmetic is fixed in `resumeAt` and unit-tested in
 * `packages/engine/src/resumeStep.test.ts`, which is where the root cause
 * belongs: it is pure, so it can be tested exhaustively without a browser.
 *
 * What only a browser can prove is the SECOND defect, the one that turned a
 * deterministic dead end into a spinner and hid the first: a state with no
 * page to show must announce itself. That is what this suite asserts, and it
 * asserts it the way the bug presented — by looking for the word on screen.
 *
 * `/preview` has no saved session, so the resume path itself is not reachable
 * from here. These cases cover the shapes that produce an unrenderable step
 * and the contract that they are never silent.
 */
import { chromium } from "/home/claude/.npm-global/lib/node_modules/playwright/index.mjs";
import assert from "node:assert/strict";
import { sendPreview } from "./lib/preview.mjs";

const RUNTIME = process.env.RUNTIME_URL ?? "http://localhost:3001";
let passed = 0;
const failures = [];
const ok = (m) => { console.log("  ok   ", m); passed++; };
const bad = (m, d = "") => { console.log(`  FAIL  ${m}${d ? ` — ${d}` : ""}`); failures.push(m); };

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1100, height: 900 } });
const pageErrors = [];
page.on("pageerror", (e) => pageErrors.push(e.message));

/** Anything that proves the runtime has SETTLED — a page, an end, or an honest failure. */
const SETTLED = [
  "[data-qid]",
  "[data-testid='rs-ended']",
  "[data-testid='rs-fatal']",
  "[data-testid='rs-no-page']",
  "[data-testid='rs-boot-error']",
].join(", ");

async function run(def) {
  await page.goto(`${RUNTIME}/preview`, { waitUntil: "domcontentloaded" });
  await sendPreview(page, { definition: def }, { selector: SETTLED, timeout: 20_000 });
}

/**
 * The assertion the whole suite is built around.
 *
 * Not "something appeared" — that is exactly the assertion that let this ship.
 * The runtime must have settled AND must not be showing a loading word, in any
 * of its spellings.
 */
async function settledWithoutSpinner(label) {
  const text = (await page.textContent(".rs-shell").catch(() => null)) ?? (await page.textContent("body")) ?? "";
  const spinning = /Loading\s*(survey)?\s*[.…]/i.test(text);
  const booting = await page.$("[data-testid='rs-booting']");
  if (spinning || booting) {
    bad(label, `still showing a loading state: ${text.trim().slice(0, 120)}`);
    return false;
  }
  ok(label);
  return true;
}

const survey = (extra) => ({
  meta: { id: "s1", code: "S1", title: "Loading deadlock", version: "1.0" },
  questions: [], flow: [],
  calculations: [], displayRules: [], variables: [], listFills: [],
  quotas: [], scripts: [], namedExpressions: [],
  ...extra,
});

const q = (id, text, extra = {}) => ({
  id, code: id.toUpperCase(), variableName: id.toUpperCase(),
  type: "single_select", text, required: false,
  options: [{ id: `${id}_a`, code: "1", label: "A" }, { id: `${id}_b`, code: "2", label: "B" }],
  settings: {}, ...extra,
});

const edNode = (fields) => ({ type: "embedded_data", id: "ed_capture", fields });
const ed = (name, value) => ({ id: `ed_${name}`, name, source: "static", defaultValue: value });

console.log("\n1. a flow that BEGINS with embedded data still renders its first question");
{
  await run(survey({
    questions: [q("q1", "First question")],
    embeddedData: [ed("WAVE", "2026-W37"), ed("PANEL", "DEMO-PANEL")],
    flow: [
      edNode([ed("WAVE", "2026-W37"), ed("PANEL", "DEMO-PANEL")]),
      { type: "page", id: "p1", questionIds: ["q1"] },
      { type: "end", id: "end", status: "complete" },
    ],
  }));
  await settledWithoutSpinner("the leading embedded-data node does not park the runtime");
  assert.ok(await page.$("[data-qid]"), "the first question should be on screen");
  ok("the question rendered");
}

console.log("\n2. the embedded values captured on the way past actually reach the page");
{
  await run(survey({
    questions: [q("q1", "Welcome {{WAVE}} on {{PANEL}}")],
    embeddedData: [ed("WAVE", "2026-W37"), ed("PANEL", "DEMO-PANEL")],
    flow: [
      edNode([ed("WAVE", "2026-W37"), ed("PANEL", "DEMO-PANEL")]),
      { type: "page", id: "p1", questionIds: ["q1"] },
      { type: "end", id: "end", status: "complete" },
    ],
  }));
  const text = (await page.textContent(".rs-shell")) ?? "";
  if (text.includes("2026-W37") && text.includes("DEMO-PANEL")) ok("both embedded values piped");
  else bad("both embedded values piped", text.slice(0, 160));
}

console.log("\n3. empty, missing and multiple embedded values all still render");
for (const [label, fields] of [
  ["one empty value", [ed("COUNTRY", "")]],
  ["a field with no default at all", [{ id: "ed_c", name: "COUNTRY", source: "url", key: "country" }]],
  ["several fields at once", [ed("COUNTRY", "India"), ed("LANGUAGE", "English"), ed("AGE", "30")]],
  ["no fields on the node", []],
]) {
  await run(survey({
    questions: [q("q1", "Hello {{COUNTRY}}")],
    embeddedData: fields,
    flow: [
      edNode(fields),
      { type: "page", id: "p1", questionIds: ["q1"] },
      { type: "end", id: "end", status: "complete" },
    ],
  }));
  await settledWithoutSpinner(label);
}

console.log("\n4. embedded data driving display logic does not deadlock either way");
for (const [label, value, expectVisible] of [
  ["the condition matches", "India", true],
  ["the condition does not match", "Japan", false],
]) {
  await run(survey({
    questions: [
      q("q1", "Always shown"),
      q("q2", "Only for India", {
        displayLogic: { type: "rule", source: { kind: "embedded", ref: "COUNTRY" }, operator: "eq", value: "India" },
      }),
    ],
    embeddedData: [ed("COUNTRY", value)],
    flow: [
      edNode([ed("COUNTRY", value)]),
      { type: "page", id: "p1", questionIds: ["q1", "q2"] },
      { type: "end", id: "end", status: "complete" },
    ],
  }));
  if (await settledWithoutSpinner(`display logic on embedded data — ${label}`)) {
    const n = (await page.$$("[data-qid]")).length;
    if (expectVisible ? n === 2 : n === 1) ok(`  and showed ${n} question${n === 1 ? "" : "s"}`);
    else bad(`  expected ${expectVisible ? 2 : 1} questions, saw ${n}`);
  }
}

console.log("\n5. A SURVEY WITH NOTHING TO SHOW SAYS SO — it does not spin");
{
  /*
   * Every page hidden. Before the fix this was indistinguishable from the
   * resume deadlock: both rendered the same "Loading…" for ever.
   */
  await run(survey({
    questions: [q("q1", "Never visible", {
      displayLogic: { type: "rule", source: { kind: "embedded", ref: "NOPE" }, operator: "eq", value: "never-matches" },
    })],
    embeddedData: [],
    flow: [
      edNode([]),
      { type: "page", id: "p1", questionIds: ["q1"] },
    ],
  }));
  await settledWithoutSpinner("a survey with no visible page settles");

  const noPage = await page.$("[data-testid='rs-no-page']");
  const ended = await page.$("[data-testid='rs-ended']");
  const fatal = await page.$("[data-testid='rs-fatal']");
  if (noPage || ended || fatal) ok("and it says which — a card, not a spinner");
  else bad("and it says which — a card, not a spinner", "no explanatory card found");

  if (noPage) {
    const t = (await page.textContent("[data-testid='rs-no-page']")) ?? "";
    if (/step|flow|display/i.test(t)) ok("the preview diagnostic explains what to look at");
    else bad("the preview diagnostic explains what to look at", t.slice(0, 120));
  }
}

console.log("\n6. an empty flow is a finished survey, not a pending one");
{
  await run(survey({ questions: [], flow: [edNode([])] }));
  await settledWithoutSpinner("a flow with only an embedded-data node settles");
}

console.log("\n7. nothing above threw in the page");
if (pageErrors.length === 0) ok("no uncaught page errors");
else bad("no uncaught page errors", pageErrors.slice(0, 3).join(" | "));

await browser.close();
console.log(`\n${failures.length ? "FAILURES" : "all checks passed"} — ${passed} ok, ${failures.length} failed`);
for (const f of failures) console.log(`  · ${f}`);
process.exit(failures.length ? 1 : 0);

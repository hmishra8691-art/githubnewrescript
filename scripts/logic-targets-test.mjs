/**
 * DISPLAY RULES ON EVERY TARGET, AND THE DERIVED DECISION GRAPH.
 *
 *   §6  a named rule can point at a page, block, section, option, row or
 *       column — not only a question, which is all the panel could ever write
 *   §8  the logic flow is generated from the programming rather than stored,
 *       so it cannot describe a survey that has since changed
 *
 * The engine side is unit-tested (displayRules.test.ts, logicGraph.test.ts).
 * What only a browser can prove is the part that was actually broken: the
 * panel wrote `kind: "question"` and nothing else, so six of the seven target
 * kinds were unreachable from the product even though the schema offered them.
 *
 *   node scripts/logic-targets-test.mjs      (studio on 3000)
 */
import { chromium } from "/home/claude/.npm-global/lib/node_modules/playwright/index.mjs";
import assert from "node:assert/strict";

const STUDIO = process.env.STUDIO_URL ?? "http://localhost:3000";
let passed = 0;
const ok = (m) => { console.log("  ok  ", m); passed++; };

const def = {
  meta: { id: "lt", code: "LT", title: "Logic targets", version: "1.0" },
  questions: [
    {
      id: "q_use", code: "Q1", variableName: "USE", type: "single_select", text: "Do you use it?",
      options: [{ code: 1, label: "Yes" }, { code: 2, label: "No" }],
      skipLogic: [{ id: "sk", when: { type: "rule", source: { kind: "question", ref: "q_use" }, operator: "eq", value: 2 }, target: { kind: "terminate", status: "screened" } }],
    },
    {
      id: "q_brand", code: "Q2", variableName: "BRAND", type: "multi_select", text: "Which brands?",
      options: [{ code: 1, label: "Alpha" }, { code: 2, label: "Beta" }, { code: 3, label: "Gamma" }],
    },
    {
      id: "q_rate", code: "Q3", variableName: "RATE", type: "grid_single", text: "Rate each",
      rows: [{ code: "r1", label: "Taste" }, { code: "r2", label: "Price" }],
      options: [{ code: 1, label: "Good" }, { code: 2, label: "Bad" }],
    },
    { id: "q_price", code: "Q4", variableName: "PRICE", type: "numeric", text: "What would you pay?" },
  ],
  flow: [
    { type: "page", id: "p_gate", questionIds: ["q_use"] },
    {
      type: "block", id: "b_main", title: "Main section", children: [
        { type: "page", id: "p_brand", questionIds: ["q_brand"] },
        { type: "page", id: "p_rate", questionIds: ["q_rate"] },
      ],
    },
    { type: "section", id: "s_price", title: "Pricing", children: [
      { type: "page", id: "p_price", questionIds: ["q_price"] },
    ] },
    { type: "end", id: "e_done", status: "complete" },
    { type: "end", id: "e_screen", status: "screened" },
  ],
  deployment: { clientSlug: "c", studySlug: "s" },
};

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1500, height: 1000 } });
const errors = [];
page.on("pageerror", (e) => errors.push(String(e)));
page.on("dialog", (d) => d.accept());

const goTab = async (name) => { await page.click(`.leftnav >> text=${name}`); await page.waitForTimeout(180); };
const readDef = async () => {
  await goTab("JSON");
  await page.waitForSelector("textarea.code");
  return JSON.parse(await page.$eval("textarea.code", (e) => e.value));
};
const loadDef = async (d) => {
  await goTab("JSON");
  await page.waitForSelector("textarea.code");
  await page.click('button:has-text("edit")');
  await page.fill("textarea.code", JSON.stringify(d, null, 2));
  await page.click('button:has-text("validate & apply")');
  await page.waitForTimeout(450);
};

await page.goto(`${STUDIO}/sandbox`, { waitUntil: "networkidle" });
await page.waitForSelector(".leftnav");
await loadDef(def);

/* ================================================== the picker, kind by kind */

console.log("\nA RULE CAN POINT AT SOMETHING OTHER THAN A QUESTION (§6)");

await goTab("Logic");
await page.waitForSelector('[data-testid="logic-check"]');
await page.click('button:has-text("+ display rule")');
await page.waitForSelector('[data-testid="dr-kind-0"]');

const kinds = await page.$$eval('[data-testid="dr-kind-0"] option', (els) => els.map((e) => e.value));
assert.deepEqual(
  kinds,
  ["question", "page", "block", "section", "option", "row", "column"],
  "every kind the schema declares is offered",
);
ok("all seven target kinds are selectable, not just “question”");

/* a block */
await page.selectOption('[data-testid="dr-kind-0"]', "block");
await page.waitForTimeout(150);
let refs = await page.$$eval('[data-testid="dr-ref-0"] option', (els) =>
  els.map((e) => ({ value: e.value, text: e.textContent.trim() })).filter((o) => o.value));
assert.deepEqual(refs.map((r) => r.value), ["b_main"]);
assert.equal(refs[0].text, "Main section", "a container is offered by its name, not its id");
await page.selectOption('[data-testid="dr-ref-0"]', "b_main");
await page.waitForTimeout(150);
let saved = (await readDef()).displayRules[0];
assert.deepEqual(saved.target, { kind: "block", ref: "b_main" });
ok("a BLOCK rule is written to the definition with kind: \"block\"");

/* a page, offered by the question codes on it */
await goTab("Logic");
await page.selectOption('[data-testid="dr-kind-0"]', "page");
await page.waitForTimeout(150);
refs = await page.$$eval('[data-testid="dr-ref-0"] option', (els) =>
  els.map((e) => ({ value: e.value, text: e.textContent.trim() })).filter((o) => o.value));
assert.deepEqual(refs.map((r) => r.value).sort(), ["p_brand", "p_gate", "p_price", "p_rate"]);
assert.ok(refs.find((r) => r.value === "p_gate").text.includes("Q1"),
  "an untitled page is identified by what is on it");
ok("PAGE targets are listed, labelled by the questions they carry");

/* changing the kind must not leave a stale ref behind */
saved = (await readDef()).displayRules[0];
assert.equal(saved.target.kind, "page");
assert.equal(saved.target.ref, "", "the block id did not survive the kind change");
ok("switching kind clears the ref, so a rule cannot claim a page id is a block");

/* an option, narrowed to one code */
await goTab("Logic");
await page.selectOption('[data-testid="dr-kind-0"]', "option");
await page.waitForTimeout(150);
await page.selectOption('[data-testid="dr-ref-0"]', "q_brand");
await page.waitForTimeout(150);
const subs = await page.$$eval('[data-testid="dr-sub-0"] option', (els) =>
  els.map((e) => ({ value: e.value, text: e.textContent.trim() })));
assert.equal(subs[0].value, "", "the empty choice says the rule is ignored");
assert.match(subs[0].text, /ignored/i);
assert.deepEqual(subs.slice(1).map((o) => o.value), ["1", "2", "3"]);
assert.match(subs[1].text, /Alpha/);
await page.selectOption('[data-testid="dr-sub-0"]', "2");
await page.waitForTimeout(150);
saved = (await readDef()).displayRules[0];
assert.deepEqual(saved.target, { kind: "option", ref: "q_brand", subRef: "2" });
ok("an OPTION rule carries the option code in subRef");

/* a grid row */
await goTab("Logic");
await page.selectOption('[data-testid="dr-kind-0"]', "row");
await page.waitForTimeout(150);
await page.selectOption('[data-testid="dr-ref-0"]', "q_rate");
await page.waitForTimeout(150);
const rowSubs = await page.$$eval('[data-testid="dr-sub-0"] option', (els) => els.map((e) => e.value));
assert.deepEqual(rowSubs, ["", "r1", "r2"]);
ok("ROW targets offer the grid's rows");

/* a question with no options offers no option list to narrow */
await goTab("Logic");
await page.selectOption('[data-testid="dr-kind-0"]', "option");
await page.waitForTimeout(150);
refs = await page.$$eval('[data-testid="dr-ref-0"] option', (els) => els.map((e) => e.value).filter(Boolean));
assert.ok(!refs.includes("q_price"), "a numeric question is not offered as an option target");
ok("only questions that HAVE options are offered for an option rule");

/* ============================================================ dead rules */

console.log("\nA RULE THAT CANNOT FIRE SAYS SO");

const withDead = JSON.parse(JSON.stringify(def));
withDead.displayRules = [
  { id: "dr_dead", label: "hide the old block", action: "hide",
    target: { kind: "block", ref: "b_deleted" },
    when: { type: "rule", source: { kind: "question", ref: "q_use" }, operator: "eq", value: 2 } },
];
await loadDef(withDead);
await goTab("Logic");
await page.waitForSelector('[data-testid="dr-dead"]');
const deadText = await page.textContent('[data-testid="dr-dead"]');
assert.match(deadText, /hide the old block/);
assert.match(deadText, /not in the flow/);
ok("a rule pointing at something the survey no longer has is named in the panel");

await page.click('[data-testid="run-quality-check"]');
await page.waitForSelector('[data-testid="qc-verdict"]');
const logicArea = await page.$('[data-testid="qc-area"][data-area="logic"]');
assert.equal(await logicArea.getAttribute("data-status"), "fail",
  "and the quality check refuses to call the survey ready");
ok("the quality check reports it too, so a release cannot walk past it");

/* ======================================================= decision graph */

console.log("\nTHE DECISION GRAPH IS DERIVED, NOT STORED (§8)");

const withStale = JSON.parse(JSON.stringify(def));
withStale.logicFlow = {
  nodes: [{ id: "q_use", kind: "question", x: 42, y: 7, label: "A LABEL FROM LAST MONTH" }],
  edges: [{ id: "stale", from: "q_use", to: "nowhere" }],
};
await loadDef(withStale);
await goTab("Logic");
await page.waitForSelector('[data-testid="decision-graph"]');

const graphText = await page.textContent('[data-testid="decision-graph"] pre.logic-pre');
assert.ok(!graphText.includes("A LABEL FROM LAST MONTH"),
  "a stored label cannot describe a survey that has changed");
assert.match(graphText, /Q1/);
assert.match(graphText, /Screened out/, "the skip rule's destination is drawn");
ok("the graph is regenerated, so a stale stored label cannot survive");

const counts = await page.textContent('[data-testid="dg-counts"]');
assert.match(counts, /\d+ nodes · \d+ paths/);
/*
 * Four questions plus the two Ends the survey declares. Pinned as a number
 * because the first version of this graph invented a THIRD terminal for the
 * skip rule's `{ kind: "terminate", status: "screened" }` instead of landing on
 * the screened-out End already in the flow — two boxes for one destination.
 */
assert.match(counts, /^6 nodes/, `the skip rule reuses the declared End: ${counts.trim()}`);
ok(`the graph reports its own size (${counts.trim()})`);

/* the skip rule is an edge — the thing the nested tree cannot draw */
assert.match(graphText, /Q1[\s\S]*?→[\s\S]*?Screened out/);
ok("a jump appears as a path out of the question that carries it");

/* the page-level view drops the questions */
await page.uncheck('[data-testid="dg-per-question"]');
await page.waitForTimeout(200);
const pageLevel = await page.textContent('[data-testid="decision-graph"] pre.logic-pre');
assert.ok(!/▢ Q2 /.test(pageLevel), "per-question nodes are gone");
assert.match(pageLevel, /Q2/, "but the page still names what is on it");
ok("the per-question toggle switches between the programmer's map and the client's");

/* ============================================================ behaviour */

console.log("\nAND THE RULE ACTUALLY ACTS");

const acting = JSON.parse(JSON.stringify(def));
acting.displayRules = [
  { id: "dr_block", label: "skip the main section for non-users", action: "hide",
    target: { kind: "block", ref: "b_main" },
    when: { type: "rule", source: { kind: "question", ref: "q_use" }, operator: "eq", value: 2 } },
];
await loadDef(acting);
await goTab("Logic");
const graph2 = await page.textContent('[data-testid="decision-graph"] pre.logic-pre');
assert.ok(graph2.includes("Q2"), "the block is still in the graph — it is conditional, not gone");
ok("a conditional block stays on the map (the rule is a condition, not a deletion)");

assert.deepEqual(errors, [], `no page errors: ${errors.join(" | ")}`);
console.log(`\nALL ${passed} LOGIC TARGET CHECKS PASSED`);
await browser.close();

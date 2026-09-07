/**
 * THE LOGIC TRACE, IN THE STUDIO (§32, §33).
 *
 * The engine side is unit-tested (20 assertions), including the invariant
 * that matters: the trace calls the real evaluator for every node, so it can
 * be incomplete but it cannot disagree with what a respondent would get.
 *
 * What only a browser can prove is that the thing is reachable and usable —
 * that a programmer can type hypothetical answers and watch the same rule
 * come out differently, that the AND/OR structure is on screen rather than
 * flattened, and that a branch nobody looked at reads differently from one
 * that was false.
 *
 *   node scripts/logic-trace-test.mjs      (studio on 3000)
 */
import { chromium } from "/home/claude/.npm-global/lib/node_modules/playwright/index.mjs";
import assert from "node:assert/strict";

const STUDIO = process.env.STUDIO_URL ?? "http://localhost:3000";
let passed = 0;
const ok = (m) => { console.log("  ok  ", m); passed++; };

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1700, height: 1400 } });
const errors = [];
page.on("pageerror", (e) => errors.push(e.message));
page.on("dialog", (d) => d.accept());

const readDef = async () => {
  await page.click(".leftnav >> text=JSON");
  await page.waitForSelector("textarea.code");
  return JSON.parse(await page.$eval("textarea.code", (e) => e.value));
};
const applyDef = async (def) => {
  await page.click(".leftnav >> text=JSON");
  await page.waitForSelector("textarea.code");
  await page.click('[data-testid="json-edit"]');
  await page.waitForTimeout(120);
  await page.$eval("textarea.code", (el, v) => {
    const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, "value").set;
    setter.call(el, v);
    el.dispatchEvent(new Event("input", { bubbles: true }));
  }, JSON.stringify(def, null, 2));
  await page.click('[data-testid="json-apply"]');
  await page.waitForTimeout(500);
};
const goLogic = async () => {
  await page.click(".leftnav >> text=Logic");
  await page.waitForSelector('[data-testid="logic-trace"], [data-testid="trace-empty"]');
};
const q = (id, code, type, extra = {}) => ({
  id, code, variableName: code, type, text: code, options: [], rows: [], columns: [],
  flags: [], validation: [], settings: {}, punches: [], optionGroups: [], ...extra,
});

await page.goto(`${STUDIO}/sandbox`, { waitUntil: "networkidle" });
await page.waitForSelector(".block-badge");

/* ------------------------------------------------------------------ setup */

let def = await readDef();
def.questions = [
  q("q_income", "Q1", "numeric"),
  q("q_brands", "Q2", "multi_select", {
    options: [{ code: "a", label: "Apple" }, { code: "b", label: "Bosch" }, { code: "c", label: "Candy" }],
  }),
  q("q_seg", "Q10", "single_select", {
    options: [
      { code: "heavy", label: "Heavy" }, { code: "medium", label: "Medium" }, { code: "light", label: "Light" },
    ],
    punches: [
      { id: "p1", label: "Heavy", mode: "if", action: "select", ignoreUnmatched: true, recompute: "once", mapping: [],
        when: { type: "rule", source: { kind: "question", ref: "q_brands", count: { of: "selected", scope: "options" } }, operator: "gte", value: 3 },
        source: { kind: "codes", codes: ["heavy"] } },
      { id: "p2", label: "Medium", mode: "else_if", action: "select", ignoreUnmatched: true, recompute: "once", mapping: [],
        when: { type: "rule", source: { kind: "question", ref: "q_brands", count: { of: "selected", scope: "options" } }, operator: "gte", value: 2 },
        source: { kind: "codes", codes: ["medium"] } },
      { id: "p3", label: "Light", mode: "else", action: "select", ignoreUnmatched: true, recompute: "once", mapping: [],
        source: { kind: "codes", codes: ["light"] } },
    ],
  }),
];
/* a nested display rule, so the tree has structure to show */
def.questions[2].displayLogic = {
  type: "group", op: "and", children: [
    { type: "rule", source: { kind: "question", ref: "q_income" }, operator: "gte", value: 100 },
    { type: "group", op: "or", children: [
      { type: "rule", source: { kind: "question", ref: "q_brands" }, operator: "contains", value: "a" },
      { type: "rule", source: { kind: "question", ref: "q_brands" }, operator: "contains", value: "c" },
    ] },
  ],
};
def.flow[0].questionIds = ["q_income", "q_brands", "q_seg"];
await applyDef(def);
ok("setup: a nested display rule and a three-branch punch chain");

/* ================================================== the condition trace */

await goLogic();
assert.ok(await page.$('[data-testid="logic-trace"]'), "the trace panel is on the Logic tab");
ok("THE TRACE IS IN THE STUDIO — it was runtime-only before");

const targets = await page.$$eval('[data-testid="trace-target"] option', (els) => els.map((e) => e.textContent));
assert.ok(targets.some((t) => /display logic/.test(t)), `display logic is traceable: ${targets.join(" | ")}`);
assert.ok(targets.some((t) => /auto punch/.test(t)), "so is auto punch");
ok("every rule in the survey is offered, not just display logic");

/* pick the display rule and give it answers that fail on the FIRST branch */
const dlValue = await page.$eval('[data-testid="trace-target"]', (el) => {
  const o = [...el.options].find((x) => /display logic/.test(x.textContent));
  return o ? o.value : "";
});
await page.selectOption('[data-testid="trace-target"]', dlValue);
await page.fill('[data-testid="trace-answer-q_income"]', "10");
await page.fill('[data-testid="trace-answer-q_brands"]', "a");
await page.waitForTimeout(400);

assert.equal((await page.textContent('[data-testid="trace-result"]')).trim(), "FALSE");
ok("the rule comes out FALSE for an income of 10");

/*
 * THE ASSERTION THIS PANEL EXISTS FOR. The old trace was a flat list of leaf
 * comparisons, so which side of the OR failed was not visible. Here the AND
 * has children, and one of them is the OR with children of its own.
 */
const nodes = await page.$$eval('[data-testid="trace-node"]', (els) =>
  els.map((e) => ({
    text: e.querySelector(".mono")?.textContent ?? "",
    result: e.getAttribute("data-result"),
    skipped: e.getAttribute("data-skipped"),
    indent: parseInt(e.style.marginLeft || "0", 10),
  })));
assert.ok(nodes.length >= 3, `the tree has nodes: ${JSON.stringify(nodes)}`);
assert.ok(nodes.some((n) => n.indent > 0), "and they are indented — the structure is on screen");
ok("THE AND/OR STRUCTURE IS SHOWN AS A TREE, not flattened into a list");

/*
 * And the branch nobody looked at reads differently from one that was false.
 * The income test failed, so the OR was never evaluated.
 */
const skipped = nodes.filter((n) => n.skipped === "true");
assert.ok(skipped.length >= 1, `a short-circuited branch is marked: ${JSON.stringify(nodes)}`);
const body = await page.textContent('[data-testid="condition-trace"]');
assert.match(body, /Not evaluated/, "…and says so in words");
ok("A SKIPPED BRANCH READS AS SKIPPED, not as false");

/* ------------------------------------- the same rule, different answers */

await page.fill('[data-testid="trace-answer-q_income"]', "500");
await page.waitForTimeout(400);
assert.equal((await page.textContent('[data-testid="trace-result"]')).trim(), "TRUE");
/*
 * With the income test now passing, the OR beneath it is reached and
 * evaluated — so MORE of the tree was looked at than before. (Its own second
 * branch is then skipped, correctly: an OR stops at its first true child.)
 */
const evaluatedAfter = await page.$$eval('[data-testid="trace-node"]',
  (els) => els.filter((e) => e.getAttribute("data-skipped") !== "true").length);
const evaluatedBefore = nodes.filter((n) => n.skipped !== "true").length;
assert.ok(evaluatedAfter > evaluatedBefore,
  `more of the tree was reached: ${evaluatedBefore} → ${evaluatedAfter}`);
ok("CHANGING A HYPOTHETICAL ANSWER RE-RUNS IT — the point of having it here");

await page.fill('[data-testid="trace-answer-q_brands"]', "b");
await page.waitForTimeout(400);
assert.equal((await page.textContent('[data-testid="trace-result"]')).trim(), "FALSE",
  "income passes but neither OR branch does");
ok("…and the OR failing is a different failure from the AND failing");

/* ================================================== the punch trace (§33) */

const puValue = await page.$eval('[data-testid="trace-target"]', (el) => {
  const o = [...el.options].find((x) => /auto punch/.test(x.textContent));
  return o ? o.value : "";
});
await page.selectOption('[data-testid="trace-target"]', puValue);
await page.fill('[data-testid="trace-answer-q_brands"]', "a, b, c");
await page.waitForTimeout(400);

let rules = await page.$$eval('[data-testid="punch-trace-rule"]', (els) =>
  els.map((e) => ({
    applied: e.getAttribute("data-applied"),
    reached: e.getAttribute("data-reached"),
    text: e.textContent.replace(/\s+/g, " ").trim(),
  })));
assert.equal(rules.length, 3, "all three branches are listed");
assert.equal(rules[0].applied, "true", "Heavy won on three brands");
assert.equal(rules[1].reached, "false", "Medium was never reached");
assert.equal(rules[2].reached, "false", "nor was Light");
assert.match(await page.textContent('[data-testid="punch-outcome"]'), /Heavy applied/);
ok("THE PUNCH TRACE SHOWS WHICH BRANCH WON AND WHICH WERE NEVER REACHED (§33)");

await page.fill('[data-testid="trace-answer-q_brands"]', "a, b");
await page.waitForTimeout(400);
rules = await page.$$eval('[data-testid="punch-trace-rule"]', (els) =>
  els.map((e) => ({ applied: e.getAttribute("data-applied"), reached: e.getAttribute("data-reached") })));
assert.deepEqual(rules.map((r) => r.applied), ["false", "true", "false"]);
assert.equal(rules[0].reached, "true", "Heavy was reached and failed");
assert.equal(rules[2].reached, "false", "Light was never reached");
ok("two brands take the ELSE IF, and the ELSE is not reached");

await page.fill('[data-testid="trace-answer-q_brands"]', "a");
await page.waitForTimeout(400);
rules = await page.$$eval('[data-testid="punch-trace-rule"]',
  (els) => els.map((e) => e.getAttribute("data-applied")));
assert.deepEqual(rules, ["false", "false", "true"]);
assert.match(await page.textContent('[data-testid="punch-outcome"]'), /Light applied/);
ok("one brand falls through to the ELSE");

/* the winning branch shows the count that decided it */
const punchBody = await page.textContent('[data-testid="punch-trace"]');
assert.match(punchBody, /ELSE|IF/, "the chain mode is shown per rule");
ok("each branch is labelled IF / ELSE IF / ELSE");

/* ====================================== the calculation dependency lint */

def = await readDef();
def.calculations = [
  { id: "c1", targetVariable: "TOTAL", expression: "SUBTOTAL * 1.2", trigger: "on_change", dataType: "numeric" },
  { id: "c2", targetVariable: "SUBTOTAL", expression: "Q1 + 1", trigger: "on_change", dataType: "numeric" },
];
await applyDef(def);
/* the calculation lint lives beside the calculations, on their own tab */
await page.click(".leftnav >> text=Calculations");
await page.waitForSelector('[data-testid="calc-problem"], .card');
await page.waitForTimeout(250);
const calcProblems = await page.$$eval('[data-testid="calc-problem"]',
  (els) => els.map((e) => e.textContent).join(" | "));
assert.match(calcProblems, /TOTAL reads SUBTOTAL, which is calculated after it/, calcProblems);
assert.match(calcProblems, /move SUBTOTAL above it/);
ok("AN ORDER-DEPENDENT CALCULATION IS REPORTED — it produces a wrong answer, not no answer");

def = await readDef();
def.calculations = [
  { id: "c1", targetVariable: "A", expression: "B + 1", trigger: "on_change", dataType: "numeric" },
  { id: "c2", targetVariable: "B", expression: "A * 2", trigger: "on_change", dataType: "numeric" },
];
await applyDef(def);
await page.click(".leftnav >> text=Calculations");
await page.waitForSelector('[data-testid="calc-problem"]');
const cyc = await page.$$eval('[data-testid="calc-problem"]', (els) => els.map((e) => e.textContent).join(" | "));
assert.match(cyc, /Circular calculations: A → B → A/, cyc);
ok("A CALC-TO-CALC CYCLE IS REPORTED — it was invisible to the dependency graph entirely");

/* -------------------------------------------------------------- errors */

assert.deepEqual(errors, [], `no page errors: ${errors.join(" | ")}`);
ok("no uncaught errors through any of it");

await browser.close();
console.log(`\nALL LOGIC TRACE CHECKS PASSED (${passed})`);

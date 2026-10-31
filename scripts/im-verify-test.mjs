/**
 * S2c (2026-10-30) — THE EXECUTION AND VERIFICATION LAYER, in the Studio's browser.
 *
 * Intelligent Mode's proposals that contain code are RUN in a test session (the real QuestionRenderer, UxLayer,
 * script sandbox and logic frame, off-screen, nothing saved) before they are offered as ready. The fake provider
 * stands in for the model with scripted replies (the first answer, then the automatic repair's answer).
 *
 *   (a) a correct highlight script                 → ran-ok, the effect named ("added class rs-highlight to Q5 on “Brand B”")
 *   (b) a script whose condition never matches     → ran-no-effect → automatic repair (scripted) → ran-ok
 *   (c) a script that throws                       → ran-error (message, line) → repair → ran-ok
 *   (d) a logic script that sets a hidden variable → ran-ok, the value in the state and in the save payload
 *   (e) a script that writes an on-screen question → blocked, with the engine's reason; the repair answers in words → "Apply anyway"
 *   (f) an endless promise loop                    → timeout (the sandbox's limit), the Studio stays responsive
 *   (g) the owner's sentence #7 end to end         → a live total warning script, ran-ok, Apply, stored
 *
 *   node scripts/im-verify-test.mjs     (studio :3000 with AI_API_URL=fake:; no runtime needed)
 */
import assert from "node:assert/strict";
import { chromium } from "./lib/playwright.mjs";
import { watchServerDrops } from "./lib/serverDrops.mjs";
import { openTab, switchMode } from "./lib/nav.mjs";

const STUDIO = process.env.STUDIO_URL ?? "http://localhost:3000";
let passed = 0;
const ok = (m) => { passed++; console.log(`  ok   ${m}`); };

const SURVEY = {
  meta: { id: "sandbox", code: "VER", title: "Verification", version: "1.0", schemaVersion: 1, status: "draft" },
  questions: [
    { id: "q1", code: "Q1", variableName: "BRAND", type: "single_select", text: "Which brand do you use most?", required: true, options: [{ code: 1, label: "Brand A" }, { code: 2, label: "Brand B" }, { code: 3, label: "Brand C" }] },
    { id: "q5", code: "Q5", variableName: "WHY", type: "text", text: "Why that brand?", required: false },
    { id: "q6", code: "Q6", variableName: "SHARE_A", type: "numeric", text: "Share of spend on Brand A (%)", required: false, validation: [{ kind: "min_value", value: 0 }, { kind: "max_value", value: 150 }] },
    { id: "q7", code: "Q7", variableName: "SHARE_B", type: "numeric", text: "Share of spend on Brand B (%)", required: false },
    { id: "q9", code: "Q9", variableName: "H_SEG", type: "hidden", text: "Segment", required: false, options: [{ code: 1, label: "Other" }, { code: 2, label: "Brand B user" }] },
  ],
  flow: [{ type: "page", id: "p1", questionIds: ["q1", "q5"] }, { type: "page", id: "p2", questionIds: ["q6", "q7"] }, { type: "page", id: "p3", questionIds: ["q9"] }, { type: "end", id: "e1", status: "complete" }],
  logicFlow: { nodes: [], edges: [] }, displayRules: [], calculations: [], quotas: [], designs: [], variables: [], embeddedData: [], listFills: [], scripts: [],
  deployment: { clientSlug: "c", studySlug: "s", languages: ["en"], access: { mode: "open" } },
};

const HIGHLIGHT = `rs.listen("select", "Q1", function (e) {
  if (e.option == 2) rs.addClass("Q5", "rs-highlight");
  else rs.removeClass("Q5", "rs-highlight");
});`;
const NEVER = `rs.listen("select", "Q1", function (e) {
  if (e.option === "Brand B") rs.addClass("Q5", "rs-highlight");
});`;
const THROWS = `rs.listen("select", "Q1", function (e) {
  var box = null;
  box.classList.add("x");
});`;
const REFUSED_WRITE = `rs.listen("select", "Q1", function (e) {
  rs.setAnswer("Q5", "Chose option " + e.option);
});`;
const ENDLESS = `function spin() { return Promise.resolve().then(spin); }
spin();`;
const LIVE_TOTAL = `function total() { return (Number(rs.getAnswer("Q6")) || 0) + (Number(rs.getAnswer("Q7")) || 0); }
function show() {
  var t = total();
  rs.showMessage("Q7", t > 100 ? "Warning: the total is " + t + "% — more than 100%" : "Total so far: " + t + "%");
}
rs.listen("change", "Q6", show);
rs.listen("change", "Q7", show);
show();`;

const browser = await chromium.launch();
const page = await (await browser.newContext({ viewport: { width: 1600, height: 1000 } })).newPage();
watchServerDrops(page);
const pageErrors = [];
page.on("pageerror", (e) => pageErrors.push(String(e)));
const goTab = async (name) => { await openTab(page, name); await page.waitForTimeout(150); };
const loadDef = async (def) => {
  await goTab("JSON");
  await page.waitForSelector("textarea.code");
  await page.click('button:has-text("edit")');
  await page.$eval("textarea.code", (el, v) => { Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value").set.call(el, v); el.dispatchEvent(new Event("input", { bubbles: true })); }, JSON.stringify(def));
  await page.click('button:has-text("validate & apply")');
  await page.waitForTimeout(1200);
  await goTab("Questions");
};
const readDef = async () => {
  await goTab("JSON");
  await page.waitForSelector("textarea.code");
  return JSON.parse(await page.$eval("textarea.code", (e) => e.value));
};

await page.goto(`${STUDIO}/sandbox?mode=studio`, { waitUntil: "networkidle" });
await page.waitForSelector(".block-badge");
await loadDef(SURVEY);
await switchMode(page, "intelligent");
await page.waitForSelector('[data-testid="intelligent-view"]');

/** one request with scripted model replies (one per turn: the first answer, then the repair's); resolves once the test session settled */
async function turn(text, replies, { repaired = false, timeout = 90000 } = {}) {
  await page.evaluate(() => window.__rescriptCopilotFakeReset?.());
  for (const r of replies) await page.evaluate((x) => window.__rescriptCopilotFake(x), r);
  const k = (await page.$$('[data-testid="cp-turn"]')).length;
  const [res] = await Promise.all([
    page.waitForResponse((r) => r.url().includes("/api/copilot/turn") && r.request().method() === "POST", { timeout: 120000 }),
    (async () => { await page.fill('[data-testid="iq-input"]', text); await page.keyboard.press("Enter"); })(),
  ]);
  const body = await res.json();
  await page.waitForFunction((c) => { const t = document.querySelectorAll('[data-testid="cp-turn"]'); return t.length > c && t[c].getAttribute("data-status") !== "thinking"; }, k, { timeout: 60000 });
  await page.waitForFunction((rep) => {
    const v = document.querySelector('[data-testid="cp-verify"]');
    if (!v) return false;
    const st = v.getAttribute("data-status");
    return (st === "ok" || st === "failed") && (!rep || v.getAttribute("data-repaired") === "1") && !document.querySelector('[data-testid="cp-turn"][data-status="thinking"]');
  }, repaired, { timeout });
  return { body, verify: await verifyState() };
}
const verifyState = () => page.$eval('[data-testid="cp-verify"]', (v) => ({
  status: v.getAttribute("data-status"), repaired: v.getAttribute("data-repaired"), text: v.textContent ?? "",
  items: [...v.querySelectorAll('[data-testid="cp-verify-item"]')].map((li) => ({ verdict: li.getAttribute("data-verdict"), key: li.getAttribute("data-key"), text: li.textContent ?? "" })),
}));
const cancelOpen = async () => {
  const c = await page.$('[data-testid="cp-panel-cancel"]') ?? await page.$('[data-testid="cp-turn"][data-proposal="open"] [data-testid="cp-cancel"]');
  if (c) { await c.click(); await page.waitForTimeout(300); }
  assert.equal(await page.$('[data-testid="cp-verify"]'), null, "the test session goes with the proposal");
};
const applyDisabled = () => page.$eval('[data-testid="cp-panel-apply"]', (b) => b.disabled).catch(() => page.$eval('[data-testid="cp-turn"][data-proposal="open"] [data-testid="cp-apply"]', (b) => b.disabled));
const turnsWith = (re) => page.$$eval('[data-testid="cp-turn"]', (ts, src) => ts.filter((t) => new RegExp(src).test(t.textContent ?? "")).length, re.source);

/* ------------------------------------------------------------ (a) */
console.log("\n(a) a correct highlight script");
{
  const { verify } = await turn("Add a script on Q1: when Brand B is picked, highlight the Why question (Q5)", [
    { kind: "proposal", reply: "Q5 is highlighted while Brand B is the answer.", actions: [{ op: "create_behavior", label: "Q5 highlight", target: "Q1", script: HIGHLIGHT, expect: { on: "select Q1=2", effect: "class rs-highlight on Q5" } }] },
  ]);
  assert.equal(verify.status, "ok", verify.text);
  assert.equal(verify.items.length, 1);
  assert.equal(verify.items[0].verdict, "ran-ok", verify.items[0].text);
  assert.match(verify.items[0].text, /Ran in a test session: 5 scenarios, added class rs-highlight to Q5 on “Brand B”, no errors/);
  assert.equal(await applyDisabled(), false, "a passed test session: Apply is open");
  const notes = await page.textContent('[data-testid="cp-ux-items"]').catch(() => "");
  assert.match(notes, /checked and run in a test session/, "the gate's sentence is accurate now");
  assert.doesNotMatch(notes, /not run yet/);
  assert.equal(await turnsWith(/Repair the script/), 0, "no repair asked");
  ok("ran-ok with the effect named (“added class rs-highlight to Q5 on “Brand B””), the expect hint met, Apply open, “checked and run in a test session”");
  await cancelOpen();
}

/* ------------------------------------------------------------ (b) */
console.log("\n(b) a script that does nothing → automatic repair");
{
  const { verify, body } = await turn("Add a script on Q1 that highlights Q5 for Brand B users", [
    { kind: "proposal", reply: "Highlight added.", actions: [{ op: "create_behavior", label: "Q5 mark", target: "Q1", script: NEVER }] },
    { kind: "proposal", reply: "Fixed: the option is compared by its code.", actions: [{ op: "update_behavior", id: "Q5 mark", edits: [{ find: `e.option === "Brand B"`, replace: "e.option == 2" }], expect: { on: "select Q1=2", effect: "class rs-highlight on Q5" } }] },
  ], { repaired: true });
  assert.equal(body.context?.repairReason, undefined, "the first turn is an ordinary turn");
  assert.equal(verify.status, "ok", verify.text);
  assert.equal(verify.items[0].verdict, "ran-ok", verify.items[0].text);
  const repairTurn = await page.$$eval('[data-testid="cp-turn"]', (ts) => ts.map((t) => t.textContent ?? "").find((x) => /Repair the script that did not pass the test session: “Q5 mark”/.test(x)) ?? "");
  assert.ok(repairTurn, "the repair turn is in the conversation");
  ok("ran-no-effect (“did nothing visible”) → one repair turn with the execution report → the revision runs again → ran-ok");
  await cancelOpen();
}

/* ------------------------------------------------------------ (c) */
console.log("\n(c) a script that throws → repair");
{
  const { verify } = await turn("Add a script on Q1 that marks the Q5 box when a brand is chosen", [
    { kind: "proposal", reply: "Done.", actions: [{ op: "create_behavior", label: "Q5 box mark", target: "Q1", script: THROWS }] },
    { kind: "proposal", reply: "Fixed the null element.", actions: [{ op: "update_behavior", id: "Q5 box mark", script: `rs.listen("select", "Q1", function (e) { rs.addClass("Q5", "rs-picked"); });`, expect: { effect: "class rs-picked on Q5" } }] },
  ], { repaired: true });
  assert.equal(verify.items[0].verdict, "ran-ok", verify.items[0].text);
  const hist = await page.$$eval('[data-testid="cp-turn"]', (ts) => ts.map((t) => t.textContent ?? "").join("\n"));
  assert.match(hist, /Repair the script that did not pass the test session: “Q5 box mark”/);
  ok("ran-error (the null element, with its scenario) → repair → ran-ok");
  await cancelOpen();
}

/* ------------------------------------------------------------ (d) */
console.log("\n(d) a logic script that sets a hidden variable");
{
  const { verify } = await turn("Add a logic script: when Q1 changes, set the hidden segment H_SEG to 2 for Brand B and 1 otherwise", [
    { kind: "proposal", reply: "The segment follows Q1.", actions: [{ op: "create_logic_script", name: "Segment", scope: "question", ref: "Q1", event: "on_change", code: "set('H_SEG', get('Q1') == 2 ? 2 : 1);", expect: { on: "select Q1=2", effect: "write Q9" } }] },
  ]);
  assert.equal(verify.status, "ok", verify.text);
  assert.equal(verify.items[0].verdict, "ran-ok", verify.items[0].text);
  assert.match(verify.items[0].text, /wrote Q9 = 1/);
  assert.match(verify.items[0].text, /written values? in the save payload/, "the payload check ran");
  ok(`ran-ok: “${verify.items[0].text.replace(/^Segment: /, "").slice(0, 140)}” — every written value in the state and in the Runner's save payload`);
  await cancelOpen();
}

/* ------------------------------------------------------------ (e) */
console.log("\n(e) a refused write");
{
  const { verify } = await turn("Add a script on Q1 that fills in Q5 with the chosen option", [
    { kind: "proposal", reply: "Q5 is filled in from Q1.", actions: [{ op: "create_behavior", label: "Fill Q5", target: "Q1", script: REFUSED_WRITE }] },
    { kind: "answer", reply: "A script cannot fill in a question the respondent is looking at; use a hidden variable or a default value instead.", actions: [] },
  ], { repaired: true });
  assert.equal(verify.status, "failed", verify.text);
  assert.equal(verify.items[0].verdict, "blocked", verify.items[0].text);
  assert.match(verify.items[0].text, /setAnswer\("Q5"\) refused: .*on screen/i);
  assert.match(verify.text, /Still failing after one repair/);
  assert.equal(await applyDisabled(), true, "Apply waits for an explicit choice");
  assert.ok(await page.$('[data-testid="cp-apply-anyway"]'), "“Apply anyway” is offered");
  ok("blocked, with the engine's reason (Q5 is on screen); the repair answered in words → “Still failing after one repair”, Apply needs “Apply anyway”");
  await cancelOpen();
}

/* ------------------------------------------------------------ (f) */
console.log("\n(f) an endless promise loop");
{
  const t0 = Date.now();
  const { verify } = await turn("Add a script on Q1 that keeps checking the answers", [
    { kind: "proposal", reply: "Added.", actions: [{ op: "create_behavior", label: "Spinner", target: "Q1", script: ENDLESS }] },
    { kind: "answer", reply: "That script loops forever; it cannot be fixed as written.", actions: [] },
  ], { repaired: true });
  assert.equal(verify.items[0].verdict, "timeout", verify.items[0].text);
  assert.match(verify.items[0].text, /promise chain ran more than|time limit|stopped/);
  const t1 = Date.now();
  assert.equal(await page.evaluate(() => 1 + 1), 2, "the Studio answers");
  assert.ok(Date.now() - t1 < 2000, "and quickly");
  await page.click('[data-testid="cp-apply-anyway"]');
  await page.waitForTimeout(800);
  assert.equal(await page.$('[data-testid="cp-verify"]'), null, "applied anyway: the proposal is closed");
  ok(`timeout (“${verify.items[0].text.replace(/^Spinner: /, "").slice(0, 110)}…”), the Studio responsive (${Math.round((t1 - t0) / 1000)} s incl. the repair turn); “Apply anyway” applies it`);
}

/* ------------------------------------------------------------ (g) */
console.log("\n(g) the owner's sentence #7, end to end");
{
  const { verify } = await turn("Show a warning when the total of Q6 and Q7 exceeds 100%", [
    { kind: "proposal", reply: "A live total under Q7 that warns above 100%.", actions: [{ op: "create_behavior", label: "Live total", target: "Q7", script: LIVE_TOTAL, expect: { effect: "message" } }] },
  ]);
  assert.equal(verify.status, "ok", verify.text);
  assert.equal(verify.items[0].verdict, "ran-ok", verify.items[0].text);
  assert.match(verify.items[0].text, /showed a message on Q7/);
  await page.click('[data-testid="cp-panel-apply"]').catch(() => page.click('[data-testid="cp-turn"][data-proposal="open"] [data-testid="cp-apply"]'));
  await page.waitForTimeout(900);
  const d = await readDef();
  const live = d.ux.behaviors.find((b) => b.label === "Live total");
  assert.ok(live && live.script === LIVE_TOTAL && live.target.questionId === "q7", "stored as proposed");
  assert.ok(!d.ux.behaviors.some((b) => "expect" in b), "the expect hint is never stored");
  assert.ok(d.ux.behaviors.some((b) => b.label === "Spinner"), "(f) was applied anyway");
  ok(`ran-ok (“${verify.items[0].text.replace(/^Live total: /, "").slice(0, 120)}”), applied and stored on Q7 (no expect field stored)`);
}

const relevant = pageErrors.filter((e) => !/ResizeObserver/.test(e));
assert.deepEqual(relevant, [], relevant.join("\n"));
ok("no page errors in the Studio");
await browser.close();
console.log(`\n${passed} passed`);

/**
 * “I AM NOT ABLE TO APPLY JAVASCRIPT CHANGES” — the bug, and what fixed it.
 *
 *   node scripts/default-value-test.mjs      (studio :3000 with AI_API_URL=fake:, runtime :3001)
 *
 * The researcher asked for Q2 to start at 19. The model proposed a sandboxed
 * script that set the input's value and dispatched DOM events; the Studio
 * refused it (scripts cannot touch the page or fill in answers), so the
 * proposal had nothing left to apply — and the card showed a greyed-out
 * Apply with no reason. Now:
 *
 *  1. a refused proposal says why, in the card, and Apply's tooltip says so too
 *  2. the refusals go back to the model once; its corrected answer is used —
 *     here set_default_value, the question's real "Default value" setting
 *  3. applied, it is Properties → State → Default value, and the runtime fills
 *     it in (only when empty, never over the respondent's answer)
 *  4. typed by hand in Properties, the runtime uses it too
 *  5. a script listening for "page_enter" (the behaviour spelling) runs
 */
import assert from "node:assert/strict";
import { chromium } from "/home/claude/.npm-global/lib/node_modules/playwright/index.mjs";
import { openTab, switchMode } from "./lib/nav.mjs";
import { openPreview } from "./lib/preview.mjs";

const STUDIO = process.env.STUDIO_URL ?? "http://localhost:3000";
const RUNTIME = process.env.RUNTIME_URL ?? "http://localhost:3001";
let passed = 0;
const ok = (m) => { passed++; console.log(`  ok   ${m}`); };

const FIXTURE = {
  meta: { id: "sandbox", code: "S", title: "Defaults" },
  questions: [
    { id: "q1", code: "Q1", variableName: "NAME", type: "open_text", text: "Your name?" },
    { id: "q2", code: "Q2", variableName: "AGE", type: "numeric", text: "How old are you?", validation: [{ kind: "min_value", value: 16 }, { kind: "max_value", value: 99 }] },
    { id: "q3", code: "Q3", variableName: "AGREE", type: "single_select", text: "Do you agree?", options: [{ code: 1, label: "Yes" }, { code: 2, label: "No" }] },
  ],
  flow: [
    { type: "page", id: "p1", questionIds: ["q1"] },
    { type: "page", id: "p2", questionIds: ["q2", "q3"] },
    { type: "end", id: "e1", status: "complete" },
  ],
  deployment: { clientSlug: "c", studySlug: "s" },
};
// what the model answered in the screenshot: a script that sets the input and dispatches DOM events
const SCRIPT_REPLY = {
  kind: "proposal",
  reply: "I'll add a behaviour on Q2 that fires on page_enter and sets the input's default value to 19 — but only if the field is currently empty.",
  assumptions: ["The default of 19 should only be applied when the field is empty."],
  actions: [{ op: "create_behavior", label: "Default age 19", target: "Q2", script: `rs.listen("page_enter", "self", () => { const el = rs.getQuestion("Q2"); if (!rs.getAnswer("Q2")) { el.value = 19; el.dispatchEvent("input"); } });` }],
};
const FIXED_REPLY = { kind: "proposal", reply: "Q2 starts at 19 — filled in only while it has no answer.", actions: [{ op: "set_default_value", target: "Q2", value: 19 }] };

const browser = await chromium.launch();
const page = await (await browser.newContext({ viewport: { width: 1600, height: 1050 } })).newPage();
const pageErrors = [];
page.on("pageerror", (e) => pageErrors.push(String(e)));
page.on("dialog", (d) => d.accept());
const goTab = async (n) => { await openTab(page, n); await page.waitForTimeout(200); };
const loadDef = async (def) => {
  await goTab("JSON");
  await page.waitForSelector("textarea.code");
  await page.click('button:has-text("edit")');
  await page.$eval("textarea.code", (el, v) => { Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value").set.call(el, v); el.dispatchEvent(new Event("input", { bubbles: true })); }, JSON.stringify(def));
  await page.click('button:has-text("validate & apply")');
  await page.waitForTimeout(700);
};
const readDef = async () => { await goTab("JSON"); await page.waitForSelector("textarea.code"); return JSON.parse(await page.$eval("textarea.code", (e) => e.value)); };
const q = (d, id) => d.questions.find((x) => x.id === id);
const say = async (text, reply) => {
  await page.evaluate((r) => window.__rescriptCopilotFake(r), reply);
  const k = (await page.$$('[data-testid="cp-turn"]')).length;
  await page.fill('[data-testid="iq-input"]', text);
  await page.keyboard.press("Enter");
  await page.waitForFunction((c) => { const t = document.querySelectorAll('[data-testid="cp-turn"]'); return t.length > c && t[t.length - 1].getAttribute("data-status") !== "thinking"; }, k, { timeout: 30000 });
  return (await page.$$('[data-testid="cp-turn"]')).at(-1);
};
const intelligent = async () => { await goTab("Questions"); await switchMode(page, "intelligent"); await page.waitForSelector('[data-testid="intelligent-view"]'); };
const runtimeAnswers = async (def, before) => {
  const pv = await openPreview(browser, RUNTIME, { definition: def }, { viewport: { width: 1200, height: 900 } });
  await pv.fill('[data-rs-el="question"][data-rs-id="q1"] input, [data-rs-el="question"][data-rs-id="q1"] textarea', "Ann");
  if (before) await pv.evaluate(before);
  await pv.click('[data-testid="rs-next"]');
  await pv.waitForSelector('[data-rs-el="question"][data-rs-id="q2"]');
  await pv.waitForTimeout(300);
  return pv;
};

await page.goto(`${STUDIO}/sandbox?mode=studio`, { waitUntil: "networkidle" });
await page.waitForSelector(".menubar");
await loadDef(FIXTURE);

/* 1: a refused proposal says why */
{
  await intelligent();
  const turn = await say("Set the default value of Q2 to 19", SCRIPT_REPLY);
  assert.equal(await turn.getAttribute("data-proposal"), "open");
  const refused = await page.textContent('[data-testid="cp-card-refused"]');
  assert.match(refused, /Nothing can be applied — the Studio refused this proposal/);
  assert.match(refused, /Behaviour “Default age 19”: scripts cannot fill in or change answers — to start a question with an answer, set its default value/);
  assert.equal(await page.$eval('[data-testid="cp-apply"]', (b) => b.disabled), true);
  assert.match(await page.getAttribute('[data-testid="cp-apply"]', "title"), /Nothing to apply — the Studio refused every change/);
  assert.ok(!(await page.getAttribute('[data-testid="cp-apply"]', "title")).includes("undoable"), "the tooltip no longer claims Apply would work");
  await page.click('[data-testid="cp-cancel"]');
  ok("1: a proposal the Studio refuses says why in the card — Apply is disabled and its tooltip says there is nothing to apply");
}

/* 2–3: the refusal goes back to the model; the corrected answer applies as the real Default value */
{
  const turn = await say("Set the default value of Q2 to 19", [SCRIPT_REPLY, FIXED_REPLY]);
  assert.equal(await turn.getAttribute("data-proposal"), "open");
  assert.match(await page.textContent('[data-testid="cp-repaired"]'), /The first answer had a change the Studio could not accept; the copilot corrected it\./);
  assert.equal(await page.$('[data-testid="cp-card-refused"]'), null, "nothing left refused");
  assert.match(await turn.$eval('[data-testid="cp-reply"]', (e) => e.textContent), /Q2 starts at 19/);
  assert.equal(await page.$eval('[data-testid="cp-apply"]', (b) => b.disabled), false);
  assert.equal(await page.getAttribute('[data-testid="cp-apply"]', "title"), "Apply as one undoable change");
  await page.click('[data-testid="cp-apply"]');
  await page.waitForSelector('[data-testid="cp-applied-note"]');
  assert.match(await page.textContent('[data-testid="cp-applied-note"]'), /Done\. The look and behaviour of Q2 \(default value\) has been updated without changing the survey's questions, codes or logic\./);
  const def = await readDef();
  assert.equal(q(def, "q2").settings.defaultValue, 19);
  assert.equal(def.ux?.behaviors?.length ?? 0, 0, "no script was stored");
  // Properties shows it
  await goTab("Questions"); await switchMode(page, "studio").catch(() => {});
  await page.waitForSelector(".qcard");
  for (const c of await page.$$(".qcard")) if ((await c.textContent()).includes("How old")) { await c.click(); break; }
  const head = '[data-testid="psec-head-state"]';
  await page.waitForSelector(head);
  if ((await page.getAttribute(head, "aria-expanded")) !== "true") await page.click(head);
  assert.equal(await page.locator('label:has-text("Default / piped value") input').inputValue(), "19");
  // the runtime fills it in when empty — and leaves an answer alone
  let pv = await runtimeAnswers(def);
  assert.equal(await pv.inputValue('[data-rs-el="question"][data-rs-id="q2"] input'), "19");
  assert.equal(await pv.evaluate(() => window.__rescriptState.answers.q2), 19, "a real answer, not just text in the box");
  await pv.close();
  // the respondent's own answer survives going back and forward; so does clearing it
  pv = await runtimeAnswers(def);
  const box = '[data-rs-el="question"][data-rs-id="q2"] input';
  const backAndForth = async () => { await pv.click('[data-testid="rs-back"]'); await pv.waitForSelector('[data-rs-el="question"][data-rs-id="q1"]'); await pv.click('[data-testid="rs-next"]'); await pv.waitForSelector(box); await pv.waitForTimeout(300); };
  await pv.fill(box, "42");
  await backAndForth();
  assert.equal(await pv.inputValue(box), "42", "never over the respondent's answer");
  await pv.fill(box, "");
  await pv.click('[data-testid="rs-back"]'); await pv.waitForSelector('[data-rs-el="question"][data-rs-id="q1"]');
  await pv.click('[data-testid="rs-next"]'); await pv.waitForTimeout(500);
  await pv.waitForSelector(box);
  assert.equal(await pv.inputValue(box), "", "a cleared default is not filled in again");
  await pv.close();
  ok("2–3: the refusal went back to the model once; its correction (set_default_value) applies — Properties → Default value shows 19, the runtime starts Q2 at 19");
}

/* 4: typed by hand in Properties */
{
  await page.fill('label:has-text("Default / piped value") input', "33");
  await page.waitForTimeout(300);
  const def = await readDef();
  assert.equal(q(def, "q2").settings.defaultValue, "33");
  const pv = await runtimeAnswers(def);
  assert.equal(await pv.inputValue('[data-rs-el="question"][data-rs-id="q2"] input'), "33");
  assert.equal(await pv.evaluate(() => window.__rescriptState.answers.q2), 33, "stored as a number for a numeric question");
  await pv.close();
  ok("4: a default typed by hand in Properties is the one the runtime uses");
}

/* 5: page_enter in a script is the page event */
{
  const def = structuredClone(FIXTURE);
  def.ux = { styles: [], animations: [], behaviors: [{ id: "uxb_1", label: "Mark on arrival", target: { kind: "question", questionId: "q2" }, effects: [], script: `rs.listen("page_enter", "self", () => rs.addClass("self", "arrived"));`, createdAt: new Date().toISOString() }] };
  const pv = await runtimeAnswers(def);
  await pv.waitForFunction(() => (document.querySelector('[data-rs-el="question"][data-rs-id="q2"]')?.getAttribute("data-rs-ux-on") ?? "").includes("arrived"), null, { timeout: 5000 });
  await pv.close();
  ok("5: a script listening for “page_enter” runs when the page opens");
}

assert.deepEqual(pageErrors.filter((e) => !/401|402|422|501|Failed to load resource/.test(e)), [], pageErrors.join("\n"));
await browser.close();
console.log(`\n${passed} passed`);

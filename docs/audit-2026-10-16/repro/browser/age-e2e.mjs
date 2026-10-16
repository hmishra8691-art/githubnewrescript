// Age decimal defect, end to end: Intelligent mode creates the age question (fake provider, the model's reply supplied
// as the copilot suites do), Apply, then the runtime preview takes 25.5.
import { chromium } from "/home/claude/.npm-global/lib/node_modules/playwright/index.mjs";
import { sendPreview } from "/home/claude/rescript/scripts/lib/preview.mjs";
import { openTab, switchMode } from "/home/claude/rescript/scripts/lib/nav.mjs";
const STUDIO = "http://localhost:3000", RUNTIME = "http://localhost:3001";
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1600, height: 1000 } });
await page.goto(`${STUDIO}/sandbox?mode=studio`, { waitUntil: "networkidle" });
await page.waitForSelector(".block-badge");
const goTab = async (n) => { await openTab(page, n); await page.waitForTimeout(150); };
const readDef = async () => { await goTab("JSON"); await page.waitForSelector("textarea.code"); const j = await page.$eval("textarea.code", (e) => e.value); await goTab("Questions"); return JSON.parse(j); };
await switchMode(page, "intelligent");
await page.waitForSelector('[data-testid="intelligent-view"]');
const turns = () => page.$$('[data-testid="cp-turn"]');
const say = async (text, reply) => {
  await page.evaluate((r) => window.__rescriptCopilotFake(r), reply);
  const k = (await turns()).length;
  await page.fill('[data-testid="iq-input"]', text);
  await page.keyboard.press("Enter");
  await page.waitForFunction((c) => { const t = document.querySelectorAll('[data-testid="cp-turn"]'); return t.length > c && t[t.length - 1].getAttribute("data-status") !== "thinking"; }, k, { timeout: 40000 });
};
for (const [label, actions] of [
  ["AI emits type numeric + min/max (prompt example shape)", [{ op: "create_question", ref: "AGE", type: "numeric", text: "What is your age?", required: true, validation: [{ kind: "min_value", value: 1 }, { kind: "max_value", value: 100 }] }]],
  ["AI emits type integer + min/max", [{ op: "create_question", ref: "AGE2", type: "integer", text: "And your age again?", required: true, validation: [{ kind: "min_value", value: 1 }, { kind: "max_value", value: 100 }] }]],
]) {
  await say("Add an age question, whole numbers 1 to 100", { kind: "proposal", reply: "Adding an age question.", actions });
  await page.waitForSelector('[data-testid="cp-panel-apply"]');
  await page.click('[data-testid="cp-panel-apply"]');
  await page.waitForTimeout(600);
  console.log("applied:", label);
}
const def = await readDef();
for (const q of def.questions) console.log(q.code, q.type, q.variant, JSON.stringify(q.validation.map((v) => v.kind)), JSON.stringify(q.settings));
// runtime preview
const pv = await browser.newPage({ viewport: { width: 1200, height: 900 } });
await pv.goto(`${RUNTIME}/preview`, { waitUntil: "networkidle" });
await sendPreview(pv, { definition: def }, { selector: "[data-qid]" });
for (const q of def.questions) {
  const inp = await pv.$(`[data-qid="${q.id}"] input`);
  console.log(q.code, "input type=", await inp.getAttribute("type"), "inputmode=", await inp.getAttribute("inputmode"), "step=", await inp.getAttribute("step"), "data-step=", await inp.getAttribute("data-step"));
}
for (const v of ["25.5", "abc", "1e2", "42"]) {
  for (const q of def.questions) { await pv.fill(`[data-qid="${q.id}"] input`, v); }
  await pv.click('[data-testid="rs-next"]');
  await pv.waitForTimeout(500);
  const errs = await pv.$$eval(".rs-error-msg", (es) => es.map((e) => e.textContent.trim()));
  const advanced = !(await pv.$('[data-qid]')) || (await pv.$$eval("[data-qid]", (es) => es.length)) === 0;
  console.log(`typed ${v} → errors: ${JSON.stringify(errs)} advanced: ${advanced}`);
  if (advanced) break;
}
await browser.close();

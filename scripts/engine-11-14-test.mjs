/**
 * ENGINE ITEMS 11–14 (2026-10-22, docs/ENGINE-11-14-2026-10-22.md), END TO END against the running Studio and runtime.
 *
 *   #11  a staged build through /api/copilot/turn: each item is SENT only the guides it needs (context.itemGuides
 *        and the fake provider's record of every call: guide ids and system blocks); the core block is the same
 *        bytes on every item; an item that proposes a MaxDiff it was not given the guide for → a logged miss, the
 *        gate refuses the bad design, the repair (with the methods guide) fixes it, it is applied
 *   #12  an ANOVA with no grouping is refused at action time naming the grouping variable; the repair adds it
 *   #13  5 items per task from 5 → corrected by the Studio (no second call); prohibitions that rule out every
 *        concept → refused, sent back once, repaired, applied; a one-level attribute twice → said plainly
 *   #14  (a) the same popup as an effect and as a script → the second refused, "Update <id>"; a renamed copy of a
 *        script → refused as a near-duplicate; (b) an overlay built with bracket access and a style alias →
 *        refused, steered to show_popup / rs.popup; (c) RUNTIME: an Urdu survey's popup — close button labelled
 *        "بند کریں", the dialog right-to-left, the close button on the left; an English survey answered in Hindi
 *        (language selector) — the popup's text translated and its close button "बंद करें"; and the Studio's
 *        Intelligent Mode card shows the duplicate refusal
 *
 *   node scripts/engine-11-14-test.mjs     (Studio :3000 with AI_API_URL=fake:, runtime :3001 — never start servers here)
 */
import assert from "node:assert/strict";
import { chromium } from "./lib/playwright.mjs";
import { sendPreview } from "./lib/preview.mjs";
import { switchMode, openTab } from "./lib/nav.mjs";

const STUDIO = process.env.STUDIO_URL ?? "http://localhost:3000";
const RUNTIME = process.env.RUNTIME_URL ?? "http://localhost:3001";
let passed = 0;
const ok = (m) => { passed++; console.log(`  ok   ${m}`); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** one turn of the copilot route — resilient to a server restart: a dropped connection or a non-JSON page waits and retries the same request */
async function turn(body) {
  for (let attempt = 1; ; attempt++) {
    try {
      const r = await fetch(`${STUDIO}/api/copilot/turn`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
      const text = await r.text();
      try { return { status: r.status, d: JSON.parse(text) }; } catch { throw new Error(`non-JSON ${r.status}: ${text.slice(0, 120)}`); }
    } catch (e) {
      if (attempt >= 14) throw e;
      console.log(`  …   the Studio did not answer (${String(e.message ?? e).slice(0, 80)}) — waiting for it (${attempt})`);
      await sleep(6000);
    }
  }
}

const base = (questions, flow) => ({
  meta: { id: "sandbox", code: "E1114", title: "Engine 11–14", version: "1.0", schemaVersion: 1, status: "draft" },
  questions, flow: flow ?? [{ type: "page", id: "p1", questionIds: questions.map((q) => q.id) }, { type: "end", id: "e1", status: "complete" }],
  logicFlow: { nodes: [], edges: [] }, displayRules: [], calculations: [], quotas: [], designs: [], variables: [], embeddedData: [], listFills: [], scripts: [],
  deployment: { clientSlug: "c", studySlug: "s", languages: ["en"], access: { mode: "open" } },
});
const BLANK = base([], [{ type: "end", id: "e1", status: "complete" }]);
const NPS = base([
  { id: "q1", code: "Q1", variableName: "NPS", type: "nps", text: "How likely are you to recommend us?", settings: { minValue: 0, maxValue: 10 } },
  { id: "q6", code: "Q6", variableName: "CONTACT_OK", type: "single_select", text: "May we contact you?", options: [{ code: 1, label: "Yes" }, { code: 2, label: "No" }] },
  { id: "q3", code: "Q3", variableName: "VOTE", type: "single_select", text: "Will you vote?", options: [{ code: 1, label: "Definitely" }, { code: 2, label: "Maybe" }, { code: 3, label: "No" }] },
]);
const ATTRS = [{ name: "Brand", levels: ["Alpha", "Beta", "Gamma"] }, { name: "Storage", levels: ["64 GB", "128 GB", "256 GB"] }, { name: "Price", levels: ["₹14,999", "₹19,999", "₹24,999"] }];

/* ============================================================ #11 */
console.log("\n#11 — per-item guide selection in a staged build");
{
  const message = "Create a survey of smartphone buyers in India with quotas by region (50/50 north–south), a MaxDiff of eight phone features and a Hindi version";
  const plan = { summary: "Smartphone buyers", items: [
    { id: "p1", title: "Record the research objective and hypotheses", kind: "design", objects: ["Research design"], reason: "Anchor the study." },
    { id: "p2", title: "Add the screener with the regional quotas", kind: "create", objects: ["Screener"], reason: "50/50 north–south." },
    { id: "p3", title: "Add the MaxDiff of eight phone features", kind: "create", objects: ["Features MaxDiff"], reason: "Rank what matters." },
    { id: "p4", title: "Add the closing questions", kind: "create", objects: ["Close"], reason: "Thank and close." },
  ], questions: [], assumptions: [] };
  const fake = [
    { kind: "edit", reply: "Objective.", actions: [{ op: "set_research", objective: "Which phone features drive choice.", hypotheses: ["Battery matters more than camera outside metros."] }] },
    { kind: "edit", reply: "Screener.", actions: [{ op: "create_question", ref: "REGION", type: "single", text: "Where do you live?", options: ["North", "South"], required: true }, { op: "create_quota", name: "Region", total: 400, dimensions: [{ question: "REGION" }] }] },
    { kind: "edit", reply: "MaxDiff.", actions: [{ op: "create_maxdiff", ref: "FEAT_MD", items: ["Battery", "Camera", "Price", "Screen", "Storage", "Durability", "Weight", "Warranty"] }] },
    { kind: "edit", reply: "Close.", actions: [{ op: "create_question", ref: "AGE", type: "numeric", text: "How old are you?" }] },
  ];
  const { status, d } = await turn({ surveyId: "sandbox", message, definition: BLANK, mode: "generate", stage: "execute", plan, items: plan.items.map((i) => i.id), done: [], fake });
  assert.equal(status, 200, JSON.stringify(d).slice(0, 300));
  assert.equal(d.stage, "executed");
  const g = d.context.itemGuides;
  assert.ok(g && g.p1 && g.p4, `itemGuides reported: ${JSON.stringify(g)}`);
  const has = (id, x) => g[id].guides.includes(x);
  assert.ok(has("p1", "research") && !has("p1", "methods") && !has("p1", "translation"), `p1 ${g.p1.guides}`);
  assert.ok(has("p2", "quota") && !has("p2", "methods") && !has("p2", "ux"), `p2 ${g.p2.guides}`);
  assert.ok(has("p3", "methods") && !has("p3", "quota"), `p3 ${g.p3.guides}`);
  assert.ok(!has("p4", "methods") && !has("p4", "quota") && !has("p4", "research"), `p4 ${g.p4.guides}`);
  for (const id of ["p1", "p2", "p3", "p4"]) assert.ok(has(id, "analysis"), `${id} has the core`);
  const items = d.context.sent.filter((s) => /_item$/.test(s.operation));
  assert.equal(items.length, 4, "one call per item");
  /* the system blocks: [system prompt, …, the core (analysis) guide, the item's own] — the core is the same bytes on every item */
  const cores = items.map((s) => s.blocks.slice(1).find((n) => n === items[3].blocks.at(-1)));
  assert.ok(cores.every((n) => n && n === cores[0]), `the core block is the same on every item: ${JSON.stringify(items.map((s) => s.blocks))}`);
  assert.ok(items.every((s) => s.blocks.length <= 4), "within four cache breakpoints");
  assert.deepEqual(items.map((s) => s.guides), ["p1", "p2", "p3", "p4"].map((id) => g[id].guides), "what the calls sent is what the context reports");
  assert.ok(Math.max(...Object.values(g).map((x) => x.chars)) < 30000, "no item carries the brief's whole set");
  assert.ok(d.validation.results.every((r) => r.ok), JSON.stringify(d.validation.errors));
  ok(`each item got the guides it needs (p1 ${g.p1.guides.join("+")}, p2 ${g.p2.guides.join("+")}, p3 ${g.p3.guides.join("+")}, p4 ${g.p4.guides.join("+")}); the core block is identical across items; applied`);
}
{
  const message = "Create a short brand survey with a MaxDiff of what matters in a brand";
  const plan = { summary: "Brand survey", items: [
    { id: "p1", title: "Add the brand questions", kind: "create", objects: ["Brands"], reason: "What matters." },
    { id: "p2", title: "Add the closing question", kind: "create", objects: ["Close"], reason: "Close." },
  ], questions: [], assumptions: [] };
  const fake = [
    { kind: "edit", reply: "Brand MaxDiff.", actions: [{ op: "create_maxdiff", ref: "BRAND_MD", items: ["Price", "Quality", "Trust"] }] },
    { kind: "edit", reply: "Close.", actions: [{ op: "create_question", ref: "THANKS", type: "long_text", text: "Anything else?" }] },
  ];
  const fakeRepair = { kind: "edit", reply: "Corrected the MaxDiff.", actions: [{ op: "create_maxdiff", ref: "BRAND_MD", items: ["Price", "Quality", "Trust", "Design", "Service", "Availability"] }] };
  const { status, d } = await turn({ surveyId: "sandbox", message, definition: BLANK, mode: "generate", stage: "execute", plan, items: ["p1", "p2"], done: [], fake, fakeRepair });
  assert.equal(status, 200);
  assert.deepEqual(d.context.guideMisses, [{ item: "p1", guides: ["methods"], ops: ["create_maxdiff"] }]);
  assert.equal(d.context.itemGuides.p1.guides.includes("methods"), false);
  assert.ok(d.context.repair && d.context.repair.fixed === true, JSON.stringify(d.context.repair));
  assert.deepEqual(d.context.repair.guides, ["methods"]);
  const repairCall = d.context.sent.find((s) => /_repair$/.test(s.operation));
  assert.ok(repairCall, "a repair call was made");
  assert.ok(d.validation.results.some((r) => r.ok && r.op === "create_maxdiff"), JSON.stringify(d.validation.results));
  ok("an item proposed a MaxDiff it had no guide for: logged as a miss, refused by the gate (3 items), repaired once with the methods guide, applied");
}

/* ============================================================ #12 */
console.log("\n#12 — analysis-plan items judged by the one readiness rule at action time");
{
  const { d } = await turn({ surveyId: "sandbox", message: "Plan an ANOVA of the NPS score", definition: NPS, fake: [
    { kind: "edit", reply: "Planned.", actions: [{ op: "add_analysis_test", method: "anova", outcome: "Q1", priority: 1 }] },
    { kind: "edit", reply: "Planned across contact permission.", actions: [{ op: "add_analysis_test", method: "anova", outcome: "Q1", groupBy: "Q6", priority: 1 }] },
  ] });
  assert.match(d.context.repair.refused.join(" "), /not ready to run.*choose the grouping variable/);
  assert.equal(d.context.repair.fixed, true);
  assert.ok(d.validation.results.every((r) => r.ok));
  const only = await turn({ surveyId: "sandbox", message: "Plan an ANOVA of the NPS score", definition: NPS, fake: { kind: "edit", reply: "Planned.", actions: [{ op: "add_analysis_test", method: "anova", outcome: "Q1", priority: 1 }] } });
  assert.equal(only.d.validation.results[0].ok, false);
  assert.match(only.d.validation.results[0].error, /An ANOVA compares groups — choose the grouping variable/);
  ok("an ANOVA with no grouping is refused when it is proposed (naming the grouping variable), never stored; the repair adds it and it applies");
}

/* ============================================================ #13 */
console.log("\n#13 — refused MaxDiff / conjoint designs");
{
  const { d } = await turn({ surveyId: "sandbox", message: "Add a MaxDiff of battery, camera, price, screen and storage, 5 per task", definition: NPS, fake: { kind: "edit", reply: "Added.", actions: [{ op: "create_maxdiff", ref: "MD5", items: ["Battery", "Camera", "Price", "Screen", "Storage"], perTask: 5 }] } });
  assert.equal(d.context.methodFixes?.length, 1, JSON.stringify(d.context.methodFixes));
  assert.match(d.context.methodFixes[0].note, /4 items per task instead of 5/);
  assert.equal(d.context.repair, undefined, "no second model call");
  assert.ok(d.validation.results.every((r) => r.ok));
  assert.ok(d.reply.assumptions.some((a) => /Corrected by the Studio/.test(a)));
  ok("5 items per task from 5 items: corrected to 4 by the Studio, said in the assumptions, no second call");
}
{
  const all = ["Alpha", "Beta", "Gamma"].flatMap((b) => ["₹14,999", "₹19,999", "₹24,999"].map((p) => ({ Brand: b, Price: p })));
  const { d } = await turn({ surveyId: "sandbox", message: "Add a choice-based conjoint of brand, storage and price; never show Alpha at ₹14,999", definition: NPS, fake: [
    { kind: "edit", reply: "Added.", actions: [{ op: "create_conjoint", ref: "PRO_CBC", method: "cbc", attributes: ATTRS, prohibitions: all }] },
    { kind: "edit", reply: "Added; Alpha never at ₹14,999.", actions: [{ op: "create_conjoint", ref: "PRO_CBC", method: "cbc", attributes: ATTRS, prohibitions: [{ Brand: "Alpha", Price: "₹14,999" }] }] },
  ] });
  assert.match(d.context.repair.refused.join(" "), /rule out every possible concept.*The prohibitions given were: Brand Alpha with Price ₹14,999/);
  assert.equal(d.context.repair.fixed, true);
  assert.ok(d.validation.results.some((r) => r.ok && r.op === "create_conjoint"));
  const again = await turn({ surveyId: "sandbox", message: "Add a choice-based conjoint of brand and price", definition: NPS, fake: [
    { kind: "edit", reply: "Added the CBC.", actions: [{ op: "create_conjoint", ref: "BAD", method: "cbc", attributes: [{ name: "Brand", levels: ["Alpha"] }, { name: "Price", levels: ["₹1", "₹2"] }] }] },
    { kind: "edit", reply: "Added the CBC.", actions: [{ op: "create_conjoint", ref: "BAD", method: "cbc", attributes: [{ name: "Brand", levels: ["Alpha"] }, { name: "Price", levels: ["₹1", "₹3"] }] }] },
  ] });
  assert.match(again.d.reply.reply, /could not be made \(it was sent back once for correction and was refused again\).*at least 2 levels/);
  assert.equal(again.d.validation.results.filter((r) => r.ok).length, 0);
  ok("prohibitions that rule out every concept: refused with the prohibitions named, repaired, applied; a one-level attribute twice: the reply says so plainly");
}

/* ============================================================ #14 (a) (b) at the route */
console.log("\n#14 — script checks beyond patterns");
const POPUP_1 = { op: "create_behavior", label: "Q3 option 1 popup", target: "Q3", on: "select_option", options: ["1"], effects: [{ do: "show_popup", title: "Thank you", text: "Thanks — your vote matters.", placement: "center" }] };
const SCRIPT_POPUP_1 = { op: "create_behavior", label: "Thanks popup (script)", target: "Q3", script: `rs.listen("select", "self", function (e) {\n  if (String(e.option) === "1") rs.popup("Thank you for voting!", { placement: "center" });\n  else rs.closePopup();\n});` };
{
  const { d } = await turn({ surveyId: "sandbox", message: "When Q3 option 1 is selected show a thank-you popup, and also write it as JavaScript", definition: NPS, fake: { kind: "proposal", reply: "Two popups.", actions: [POPUP_1, SCRIPT_POPUP_1] } });
  assert.deepEqual(d.validation.results.map((r) => r.ok), [true, false]);
  assert.match(d.validation.results[1].error, /repeats a behaviour that is already there — (uxb_\S+) “Q3 option 1 popup”.*both open a popup on the same question.*Update \1/);
  const renamed = `// eligibility\nrs.listen('change','self',function(ev){ var years = Number(rs.getAnswer('Q1')); if (years >= 7) rs.showMessage('self','High'); });`;
  const original = `rs.listen("change", "self", function (e) {\n  var score = Number(rs.getAnswer("Q1"));\n  if (score >= 7) rs.showMessage("self", "High");\n});`;
  const two = await turn({ surveyId: "sandbox", message: "On Q1 use JavaScript to show High from 7", definition: NPS, fake: { kind: "proposal", reply: "Two scripts.", actions: [{ op: "create_behavior", label: "High", target: "Q1", script: original }, { op: "create_behavior", label: "High again", target: "Q1", script: renamed }] } });
  assert.deepEqual(two.d.validation.results.map((r) => r.ok), [true, false]);
  assert.match(two.d.validation.results[1].error, /script is 100 % the same/);
  ok("the same popup as an effect and as a script → the second refused with “Update <id>”; a renamed, re-quoted copy of a script → refused as a near-duplicate");
}
{
  const overlay = `var o = document["createElement"]("div"); const s = o.style; s.position = "fixed"; Object.assign(s, { zIndex: 99999, inset: 0 }); o["style"]["background"] = "rgba(0,0,0,.6)"; document.body.appendChild(o);`;
  const { d } = await turn({ surveyId: "sandbox", message: "On Q3 use JavaScript to show an overlay when option 2 is selected", definition: NPS, fake: { kind: "proposal", reply: "Overlay.", actions: [{ op: "create_behavior", label: "Q3 overlay", target: "Q3", on: "select_option", options: ["2"], script: overlay }] } });
  assert.equal(d.validation.results[0].ok, false);
  assert.match(d.validation.results[0].error, /builds its own popup \(a position: fixed element appended to document\.body that covers the whole screen\).*z-index 99999.*show_popup.*rs\.popup/);
  ok("an overlay built with bracket access, a style alias and Object.assign is refused and steered to show_popup / rs.popup");
}

/* ============================================================ #14 (c) in the runtime, and the card in the Studio */
console.log("\n#14c — the popup's words in the respondent's language (runtime), the duplicate on the Studio card");
const browser = await chromium.launch();
async function preview(def, viewport = { width: 1280, height: 800 }) {
  for (let attempt = 1; ; attempt++) {
    const ctx = await browser.newContext({ viewport });
    const rt = await ctx.newPage();
    const errors = [];
    rt.on("pageerror", (e) => errors.push(String(e)));
    try {
      await rt.goto(`${RUNTIME}/preview`, { waitUntil: "networkidle", timeout: 60000 });
      await sendPreview(rt, { definition: def }, { selector: '[data-qid="q3"]' });
      return { rt, ctx, errors };
    } catch (e) {
      await ctx.close();
      if (attempt >= 6) throw e;
      console.log(`  …   the runtime did not answer (${String(e.message ?? e).slice(0, 80)}) — waiting (${attempt})`);
      await sleep(8000);
    }
  }
}
const withPopup = (lang, extra = {}) => ({ ...NPS, meta: { ...NPS.meta, id: `e1114${lang}` }, ux: { styles: [], animations: [], behaviors: [{ id: "uxb_pop", label: "Q3 option 1 popup", target: { kind: "question", questionId: "q3" }, on: "select_option", options: ["1"], effects: [{ do: "show_popup", text: "Thanks — your vote matters.", placement: "center" }], createdAt: "2026-10-22T00:00:00Z" }] }, ...extra });
{
  const def = withPopup("ur", { localization: { sourceLanguage: "ur", languages: [], translations: {} } });
  const { rt, ctx, errors } = await preview(def);
  await rt.click('[data-qid="q3"] [data-rs-el="option"][data-rs-id="1"]');
  await rt.waitForSelector("[data-rs-ux-popup]", { timeout: 8000 });
  const info = await rt.$eval("[data-rs-ux-popup]", (e) => { const box = e.querySelector(".rs-ux-popup").getBoundingClientRect(); const c = e.querySelector('[data-testid="rs-ux-popup-close"]'); const cb = c.getBoundingClientRect(); return { dir: e.getAttribute("dir"), close: c.getAttribute("aria-label"), closeCenter: cb.left + cb.width / 2, boxCenter: box.left + box.width / 2, label: e.querySelector('[role="dialog"]').getAttribute("aria-label") }; });
  assert.equal(info.dir, "rtl");
  assert.equal(info.close, "بند کریں");
  assert.equal(info.label, "پیغام", "a popup with no title is announced in Urdu");
  assert.ok(info.closeCenter < info.boxCenter, `the close button sits on the left in a right-to-left survey (${info.closeCenter} < ${info.boxCenter})`);
  assert.deepEqual(errors, []);
  await ctx.close();
  ok("an Urdu survey's popup: right to left, its close button labelled “بند کریں” and placed on the left, announced as “پیغام”");
}
{
  const def = withPopup("hi", { localization: { sourceLanguage: "en", languages: [{ code: "hi", status: "live", enabled: true, format: {} }], translations: { hi: { "ux:uxb_pop:0:text": { text: "धन्यवाद — आपका वोट मायने रखता है।", status: "approved" }, "q:q3:text": { text: "क्या आप वोट देंगे?", status: "approved" } } }, routing: { allowSwitch: true } } });
  const { rt, ctx, errors } = await preview(def);
  await rt.waitForSelector('[data-testid="rs-language"]', { timeout: 10000 });
  await rt.selectOption('[data-testid="rs-language"]', "hi");
  await rt.waitForFunction(() => document.querySelector('[data-qid="q3"]')?.textContent?.includes("वोट"), null, { timeout: 10000 });
  await rt.click('[data-qid="q3"] [data-rs-el="option"][data-rs-id="1"]');
  await rt.waitForSelector("[data-rs-ux-popup]", { timeout: 8000 });
  const info = await rt.$eval("[data-rs-ux-popup]", (e) => ({ dir: e.getAttribute("dir"), close: e.querySelector('[data-testid="rs-ux-popup-close"]').getAttribute("aria-label"), text: e.querySelector(".rs-ux-popup-text").textContent }));
  assert.deepEqual(info, { dir: "ltr", close: "बंद करें", text: "धन्यवाद — आपका वोट मायने रखता है।" });
  assert.deepEqual(errors, []);
  await ctx.close();
  ok("an English survey answered in Hindi: the popup's text comes from the translation, its close button is “बंद करें” (built in), left to right");
}
{
  const page = await (await browser.newContext({ viewport: { width: 1600, height: 1000 } })).newPage();
  const pageErrors = [];
  page.on("pageerror", (e) => pageErrors.push(String(e)));
  for (let attempt = 1; ; attempt++) {
    try {
      await page.goto(`${STUDIO}/sandbox?mode=studio`, { waitUntil: "networkidle", timeout: 90000 });
      await page.waitForSelector(".block-badge", { timeout: 60000 });
      await page.waitForTimeout(1500);
      /* the dev server recompiling under the page ("Loading chunk … failed") is the server's, not the product's: load again */
      if (pageErrors.some((x) => /ChunkLoadError|Loading chunk|error while hydrating/.test(x))) throw new Error(pageErrors[0]);
      break;
    } catch (e) {
      if (attempt >= 6) throw e;
      pageErrors.length = 0;
      console.log(`  …   the Studio page did not load (${String(e.message ?? e).slice(0, 60)}) — waiting (${attempt})`);
      await sleep(10000);
    }
  }
  await openTab(page, "JSON"); await page.waitForSelector("textarea.code");
  await page.click('button:has-text("edit")');
  const def = withPopup("en");
  await page.$eval("textarea.code", (el, v) => { Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value").set.call(el, v); el.dispatchEvent(new Event("input", { bubbles: true })); }, JSON.stringify({ ...def, meta: { ...def.meta, id: "sandbox" } }));
  await page.click('button:has-text("validate & apply")'); await page.waitForTimeout(1200);
  await openTab(page, "Questions");
  await switchMode(page, "intelligent");
  await page.waitForSelector('[data-testid="intelligent-view"]');
  await page.evaluate((r) => window.__rescriptCopilotFake(r), { kind: "proposal", reply: "Added the popup as JavaScript.", actions: [SCRIPT_POPUP_1] });
  const [res] = await Promise.all([
    page.waitForResponse((r) => r.url().includes("/api/copilot/turn") && r.request().method() === "POST", { timeout: 90000 }),
    (async () => { await page.fill('[data-testid="iq-input"]', "On Q3 add JavaScript that shows a thank-you popup when option 1 is chosen"); await page.keyboard.press("Enter"); })(),
  ]);
  const body = await res.json();
  assert.equal(body.validation.results[0].ok, false);
  await page.waitForSelector('[data-testid="cp-refused"]', { timeout: 20000 });
  assert.match(await page.textContent('[data-testid="cp-refused"]'), /repeats a behaviour that is already there.*uxb_pop.*Update uxb_pop/);
  assert.deepEqual(pageErrors, [], pageErrors.join("\n"));
  ok("in Intelligent Mode the duplicate popup script is shown refused on the card, naming the behaviour to update");
}
await browser.close();
console.log(`\n${passed} passed`);

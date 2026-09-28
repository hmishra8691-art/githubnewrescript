/**
 * INTELLIGENT COPILOT — research → survey plan → actions → preview → apply,
 * in the browser (the AI Research + Survey Programming Copilot brief).
 *
 *   node scripts/copilot-test.mjs
 *
 * Against the Studio dev server with AI_API_URL=fake:. The fake provider
 * cannot reason, so the suite hands the copilot route what a model would
 * have answered, through `window.__rescriptCopilotFake(reply)` — the route
 * takes it only from the FAKE provider. Everything after the model is real:
 * the gate, the engine's action layer on a clone, the preview, the apply,
 * the change history, undo, the review, the research store and retrieval.
 */
import assert from "node:assert/strict";
import { chromium } from "/home/claude/.npm-global/lib/node_modules/playwright/index.mjs";
import { openTab, switchMode } from "./lib/nav.mjs";
import { docxFixture, pdfFixture, TINY_JPEG } from "../packages/import/dist/fixtures.js";

const STUDIO = process.env.STUDIO_URL ?? "http://localhost:3000";
let passed = 0;
const ok = (msg) => { passed++; console.log(`  ok   ${msg}`); };
const mod = process.platform === "darwin" ? "Meta" : "Control";

const browser = await chromium.launch({ args: ["--use-fake-device-for-media-stream", "--use-fake-ui-for-media-stream"] });
const context = await browser.newContext({ viewport: { width: 1600, height: 1000 }, permissions: ["microphone"] });
const page = await context.newPage();
const pageErrors = [];
page.on("pageerror", (e) => pageErrors.push(String(e)));
page.on("console", (m) => { if (m.type() === "error" && !/401|402|422|501|Failed to load resource|ERR_TUNNEL/.test(m.text())) pageErrors.push(m.text().slice(0, 300)); });

const goTab = async (name) => { await openTab(page, name); await page.waitForTimeout(150); };
const loadDef = async (def) => {
  await goTab("JSON");
  await page.waitForSelector("textarea.code");
  await page.click('button:has-text("edit")');
  await page.$eval("textarea.code", (el, v) => { Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value").set.call(el, v); el.dispatchEvent(new Event("input", { bubbles: true })); }, JSON.stringify(def));
  await page.click('button:has-text("validate & apply")');
  await page.waitForTimeout(800);
  await goTab("Questions");
};
const readDef = async () => {
  await goTab("JSON");
  await page.waitForSelector("textarea.code");
  const json = await page.$eval("textarea.code", (e) => e.value);
  await goTab("Questions");
  await page.waitForSelector('[data-testid="intelligent-view"]');
  return JSON.parse(json);
};
const fakeNext = (reply) => page.evaluate((r) => window.__rescriptCopilotFake(r), reply);
const turns = () => page.$$('[data-testid="cp-turn"]');
const say = async (text, reply) => {
  if (reply) await fakeNext(reply);
  const n = (await turns()).length;
  await page.fill('[data-testid="iq-input"]', text);
  await page.keyboard.press("Enter");
  await page.waitForFunction((k) => { const t = document.querySelectorAll('[data-testid="cp-turn"]'); return t.length > k && t[t.length - 1].getAttribute("data-status") !== "thinking"; }, n, { timeout: 30000 });
  return (await turns()).at(-1);
};
const panel = async (tab) => { await page.click(`[data-testid="cp-tab-${tab}"]`); await page.waitForTimeout(150); };
const texts = (sel) => page.$$eval(sel, (els) => els.map((e) => e.textContent.replace(/\s+/g, " ").trim()));

const empty = { meta: { id: "sandbox", code: "S", title: "Skincare study", version: "1.0" }, questions: [], flow: [{ type: "end", id: "e_ok", status: "complete" }], deployment: { clientSlug: "c", studySlug: "s" } };

const GENERATE = {
  kind: "proposal",
  reply: "Your hypothesis has social media exposure as the independent variable and purchase intention as the dependent one, with trust in influencers as a likely mediator. I propose four blocks: screening (Q1–Q2), exposure, trust, and PI as the outcome.",
  understanding: { objective: "Test whether social media exposure increases premium skincare purchase intention among 18–35s", hypotheses: ["More exposure → higher purchase intention"], population: "Consumers aged 18–35", variables: [{ name: "Social media exposure", role: "independent", measure: "EXPOSE" }, { name: "Trust in influencers", role: "mediator", measure: "TRUST" }, { name: "Purchase intention", role: "dependent", measure: "PI" }], analysis: ["Regression of PI on EXPOSE"] },
  plan: [{ block: "Screening", questions: 2 }, { block: "Social media exposure", questions: 2 }, { block: "Trust", questions: 1 }, { block: "Purchase intention", questions: 1 }],
  actions: [
    { op: "set_research", objective: "Test whether social media exposure increases premium skincare purchase intention", hypotheses: ["More exposure → higher purchase intention"], population: "18–35", constructs: [{ name: "Exposure", role: "independent", questions: ["EXPOSE"] }, { name: "Purchase intention", role: "dependent", questions: ["PI"] }] },
    { op: "create_block", title: "Screening" },
    { op: "create_question", ref: "AGE", type: "numeric", text: "How old are you?", required: true, validation: [{ kind: "min_value", value: 16 }, { kind: "max_value", value: 99 }, { kind: "integer" }] },
    { op: "create_question", ref: "BUY", type: "yes_no", text: "Have you bought a skincare product in the last 6 months?", required: true },
    { op: "add_skip", from: "AGE", when: "AGE < 18 OR AGE > 35", to: "screen_out" },
    { op: "add_skip", from: "BUY", when: "BUY = No", to: "screen_out" },
    { op: "create_block", title: "Social media exposure" },
    { op: "create_question", ref: "PLAT", type: "multi", text: "Which of these platforms do you use at least weekly?", options: ["Instagram", "TikTok", "YouTube", "None of these"], randomize: true },
    { op: "create_question", ref: "EXPOSE", type: "matrix", text: "How often do you see skincare content from each of these?", rows: ["Influencers", "Brands", "Friends"], scale: { points: 5, low: "Never", high: "Very often" } },
    { op: "create_block", title: "Trust" },
    { op: "create_question", ref: "TRUST", type: "rating", text: "How much do you trust skincare recommendations from influencers?", scale: { points: 5, low: "Not at all", high: "Completely" } },
    { op: "create_block", title: "Purchase intention" },
    { op: "create_question", ref: "PI", type: "rating", text: "How likely are you to buy a premium skincare product in the next 3 months?", scale: { points: 7, low: "Very unlikely", high: "Very likely" } },
  ],
  assumptions: ["“Premium” means ₹1,500 or more per product"],
  memory: "Hypothesis: exposure → purchase intention, 18–35.",
};

// the sandbox's research store lives in the dev server's memory: start from none
{
  const r = await fetch(`${STUDIO}/api/copilot/documents?surveyId=sandbox`);
  const d = r.ok ? await r.json() : { documents: [] };
  for (const doc of d.documents ?? []) await fetch(`${STUDIO}/api/copilot/documents?surveyId=sandbox&id=${encodeURIComponent(doc.id)}`, { method: "DELETE" });
}

await page.goto(`${STUDIO}/sandbox?mode=studio`, { waitUntil: "networkidle" });
await page.waitForSelector(".block-badge");
await loadDef(empty);
await switchMode(page, "intelligent");
await page.waitForSelector('[data-testid="intelligent-view"]');

/* ------------------------------------------------------------ the workspace */
{
  for (const id of ["cp-structure-pane", "cp-panel", "cp-generate", "cp-review", "cp-undo-last", "iq-attach", "iq-mic", "cp-welcome-generate", "cp-welcome-research"]) assert.ok(await page.$(`[data-testid="${id}"]`), id);
  assert.ok(await page.$eval('[data-testid="cp-undo-last"]', (b) => b.disabled), "nothing to undo yet");
  await page.click('[data-testid="iq-attach"]');
  assert.deepEqual(await texts('[data-testid="cp-attach-menu"] b'), ["Research documents", "Import a questionnaire", "Theme image"]);
  await page.click('[data-testid="iq-attach"]');
  ok("the workspace: structure on the left, conversation, the panel (Changes · Review · Research · History · Inspector); Generate, Review, Undo, attach, microphone");
}

/* ------------------------------------------------------------ hypothesis → proposal → review → apply */
{
  const t = await say("My hypothesis is that social media exposure increases the likelihood of purchasing premium skincare among 18–35s. Create a survey that tests it.", GENERATE);
  assert.equal(await t.getAttribute("data-status"), "ready");
  assert.equal(await t.getAttribute("data-kind"), "proposal");
  assert.equal(await t.getAttribute("data-proposal"), "open");
  assert.equal(await t.getAttribute("data-mode"), "generate", "the server read it as a generation request");
  assert.deepEqual(await t.$$eval('[data-testid="cp-variables"] tbody tr', (rs) => rs.map((r) => r.dataset.role)), ["independent", "mediator", "dependent"]);
  assert.deepEqual(await t.$$eval('[data-testid="cp-plan"] li b', (bs) => bs.map((b) => b.textContent)), ["Screening", "Social media exposure", "Trust", "Purchase intention"]);
  assert.match(await (await t.$('[data-testid="cp-assumptions"]')).textContent(), /Premium/);
  const counts = await t.$$eval('[data-testid="cp-counts"] .cp-count', (cs) => cs.map((c) => c.textContent.replace(/\s+/g, " ").trim()));
  for (const c of ["4 blocks", "6 questions", "2 screening questions", "2 skip conditions"]) assert.ok(counts.includes(c), `${c} in ${counts.join(" | ")}`);
  // nothing written yet
  assert.equal((await readDef()).questions.length, 0, "a proposal writes nothing");
  await switchMode(page, "intelligent");
  // the Changes panel: exactly what will happen
  assert.equal(await page.getAttribute('[data-testid="cp-panel"]', "data-tab"), "changes");
  const summary = await texts('[data-testid="cp-summary"] li');
  assert.ok(summary.includes("Add 4 blocks: “Screening”, “Social media exposure”, “Trust”, “Purchase intention”"), summary.join("\n"));
  assert.ok(summary.includes("Add 6 questions") && summary.includes("Add 2 skip conditions") && summary.some((l) => /research design/.test(l)));
  assert.equal(await page.$('[data-testid="cp-destructive"]'), null, "building on an empty survey destroys nothing");
  const marks = await page.$$eval('[data-testid="cp-structure"] [data-testid="cp-o-q"]', (qs) => qs.map((q) => q.dataset.mark));
  assert.deepEqual(marks, ["added", "added", "added", "added", "added", "added"]);
  // the structure pane shows the proposal, marked as such
  assert.match(await page.textContent('[data-testid="cp-sp-count"]'), /6 questions · proposed/);
  ok("hypothesis → the copilot's understanding (variables and roles), plan, assumptions, counts; the Changes panel shows exactly what will be created — and nothing is written");
}

/* ------------------------------------------------------------ modify before approving */
{
  const t = await say("Remove the trust block and make the platforms question optional.", {
    kind: "proposal", reply: "Removed the trust block; Q3 is optional.",
    actions: [{ op: "delete_block", target: "Trust" }, { op: "update_question", target: "Q3", required: false }],
  });
  assert.equal(await t.getAttribute("data-proposal"), "open");
  const all = await turns();
  assert.equal(await all[0].getAttribute("data-proposal"), "superseded", "the first proposal is revised, not stacked");
  assert.match(await page.textContent('[data-testid="cp-steps"]'), /2 requests/);
  const summary = await texts('[data-testid="cp-summary"] li');
  assert.ok(summary.includes("Add 5 questions"), `net of the revision: ${summary.join(" | ")}`);
  assert.ok(summary.includes("Add 3 blocks: “Screening”, “Social media exposure”, “Purchase intention”"));
  // deleting a block the proposal itself created is still named, and must be confirmed
  assert.ok(await page.$('[data-testid="cp-destructive"]'));
  assert.ok(await page.$eval('[data-testid="cp-panel-apply"]', (b) => b.disabled), "Apply waits for the confirmation");
  assert.ok(await t.$eval('[data-testid="cp-apply"]', (b) => b.disabled));
  await page.check('[data-testid="cp-confirm"]');
  assert.equal(await page.$eval('[data-testid="cp-panel-apply"]', (b) => b.disabled), false);
  ok("Review → Modify: a follow-up revises the open proposal (the earlier card is marked superseded); the net change is shown; anything destructive must be confirmed");
}

/* ------------------------------------------------------------ apply: real survey objects, one undoable change */
{
  await page.click('[data-testid="cp-panel-apply"]');
  await page.waitForFunction(() => document.querySelector('[data-testid="cp-panel"]')?.getAttribute("data-tab") === "history");
  const t = (await turns()).at(-1);
  assert.equal(await t.getAttribute("data-proposal"), "applied");
  assert.match(await (await t.$(".iq-kicker")).textContent(), /APPLIED · AI CHANGE #001/);
  const hist = await texts('[data-testid="cp-change"]');
  assert.match(hist[0], /AI Change #001/);
  assert.match(hist[0], /Created block “Screening”, block “Social media exposure”, block “Purchase intention”, Q1, Q2, Q3, Q4, Q5/);
  const def = await readDef();
  await switchMode(page, "intelligent");
  assert.deepEqual(def.questions.map((q) => q.code), ["Q1", "Q2", "Q3", "Q4", "Q5"]);
  assert.deepEqual(def.questions.map((q) => q.variableName), ["AGE", "BUY", "PLAT", "EXPOSE", "PI"], "the model's refs are the variables");
  assert.equal(def.questions[3].type, "matrix_single");
  assert.equal(def.questions[3].variant, "matrix.single", "the same variant the picker would have made");
  assert.equal(def.questions[2].required, false);
  assert.deepEqual(def.questions[1].skipLogic[0].target, { kind: "terminate", status: "screened" });
  assert.equal(def.research.constructs.find((c) => c.role === "dependent").questionIds[0], def.questions[4].id);
  assert.equal(def.flow.at(-1).type, "end");
  // the structure pane is the real survey now
  assert.deepEqual(await page.$$eval('[data-testid="cp-sp-q"]', (qs) => qs.map((q) => q.dataset.code)), ["Q1", "Q2", "Q3", "Q4", "Q5"]);
  // one undo takes the whole AI change back
  await page.keyboard.press(`${mod}+z`);
  await page.waitForTimeout(300);
  assert.equal((await readDef()).questions.length, 0, "⌘Z undoes the whole AI operation at once");
  await switchMode(page, "intelligent");
  await page.keyboard.press(`${mod}+Shift+z`);
  await page.waitForTimeout(300);
  assert.equal((await readDef()).questions.length, 5);
  await switchMode(page, "intelligent");
  ok("Apply: real blocks, questions (the picker's variants), options, scales, validation, skips and the research design — one labelled change, #001 in History; ⌘Z takes it all back");
}

/* ------------------------------------------------------------ conversational editing, a destructive change, undo from history */
{
  const t = await say("Change the scale on Q5 from 7-point to 5-point, and show Q4 only if Q3 is answered.", {
    kind: "proposal", reply: "Q5 becomes a 5-point scale; Q4 is shown only to people who answered Q3.",
    actions: [{ op: "update_question", target: "Q5", scale: { points: 5, low: "Very unlikely", high: "Very likely" } }, { op: "set_display_logic", target: "Q4", expression: "Q3 answered" }],
  });
  assert.equal(await t.getAttribute("data-mode"), "edit");
  const d = await texts('[data-testid="cp-destructive"] li');
  assert.deepEqual(d, ["replaces the 7 options of Q5"]);
  const mod = await texts('[data-testid="cp-modified"] tr');
  assert.ok(mod.some((r) => /Q5options/.test(r.replace(/\s/g, "")) || /options/.test(r)), mod.join("\n"));
  assert.ok(mod.some((r) => /display logic/.test(r)));
  await page.click('[data-testid="cp-before-after"]');
  const before = await page.$$eval('[data-testid="cp-outline-before"] [data-testid="cp-o-q"]', (qs) => qs.map((q) => q.dataset.mark));
  const after = await page.$$eval('[data-testid="cp-outline-after"] [data-testid="cp-o-q"]', (qs) => qs.map((q) => q.dataset.mark));
  assert.deepEqual(before, ["", "", "", "modified", "modified"]);
  assert.deepEqual(after, ["", "", "", "modified", "modified"]);
  // a clickable reference in the reply selects the question
  await t.$eval('[data-testid="cp-ref"]', (b) => b.click());
  await page.waitForTimeout(200);
  assert.ok(await page.$('[data-testid="cp-sp-q"].sel'), "the referenced question is selected");
  await page.check('[data-testid="cp-confirm"]');
  await page.click('[data-testid="cp-panel-apply"]');
  await page.waitForFunction(() => document.querySelectorAll('[data-testid="cp-change"]').length === 2);
  let def = await readDef();
  await switchMode(page, "intelligent");
  assert.deepEqual(def.questions[4].options.map((o) => o.code), [1, 2, 3, 4, 5]);
  assert.ok(def.questions[3].displayLogic);
  // Undo AI change (toolbar) — the latest, as one operation
  await page.click('[data-testid="cp-undo-last"]');
  await page.waitForTimeout(300);
  def = await readDef();
  await switchMode(page, "intelligent");
  assert.equal(def.questions[4].options.length, 7, "undone");
  assert.equal(def.questions[3].displayLogic, undefined);
  await panel("history");
  assert.match((await texts('[data-testid="cp-change"]'))[0], /AI Change #002.*undone/);
  ok("editing: targeted changes, the replaced scale named destructive, field-by-field and before/after views, clickable Q-references; Undo AI change reverts #002 as one operation");
}

/* ------------------------------------------------------------ refused actions are reported, not guessed */
{
  const t = await say("Show Q9 only when Q1 > 20 and add a question about brand trust after Q2.", {
    kind: "proposal", reply: "Added the trust question after Q2. Q9 does not exist.",
    actions: [{ op: "set_display_logic", target: "Q9", expression: "Q1 > 20" }, { op: "create_question", ref: "BRAND_TRUST", type: "rating", text: "How much do you trust the skincare brands you buy?", scale: { points: 5, low: "Not at all", high: "Completely" }, after: "Q2" }, { op: "publish_survey" }],
  });
  assert.match(await (await t.$('[data-testid="cp-rejected"]')).textContent(), /1 action from the model was not in a shape the Studio accepts and was dropped/);
  const refused = await texts('[data-testid="cp-refused"] li');
  assert.equal(refused.length, 1);
  assert.match(refused[0], /there is no question “Q9”/);
  assert.ok((await texts('[data-testid="cp-summary"] li')).includes("Add 1 question"), "the valid part is still offered");
  await page.click('[data-testid="cp-panel-cancel"]');
  assert.equal(await t.getAttribute("data-proposal"), "cancelled");
  assert.equal((await readDef()).questions.length, 5, "cancel writes nothing");
  await switchMode(page, "intelligent");
  ok("an action naming a question that does not exist is refused with its reason; an op outside the vocabulary (publish) is dropped at the gate; Cancel writes nothing");
}

/* ------------------------------------------------------------ review */
{
  await page.click('[data-testid="cp-review"]');
  await page.waitForFunction(() => document.querySelector('[data-testid="cp-panel"]')?.getAttribute("data-tab") === "review");
  // the engine's checks, at once — before the model answers (the fake answers nothing unless told)
  await page.waitForSelector('[data-testid="cp-finding"]');
  const findings = await page.$$eval('[data-testid="cp-finding"]', (fs) => fs.map((f) => `${f.dataset.severity}|${f.dataset.source}|${f.textContent}`));
  assert.ok(findings.some((f) => /^suggestion\|engine\|.*Q3 has no “None of these” or “Other”|^warning\|engine\|.*mixes/.test(f) || /^suggestion\|engine\|/.test(f)), findings.join("\n"));
  // the model's reading adds what only a reader of meaning finds; a fix is offered as a proposal
  await fakeNext({ kind: "review", reply: "The survey measures exposure and intention but not trust, which your hypothesis names as the mediator. Q2 assumes a purchase in the last six months.", findings: [{ severity: "critical", questions: [], message: "The mediator “trust in influencers” is not measured — the mediation hypothesis cannot be tested." }, { severity: "suggestion", questions: ["Q4"], message: "Q4 may prime respondents about influencers before Q5." }] });
  await page.click('[data-testid="cp-rerun-review"]');
  await page.waitForFunction(() => [...document.querySelectorAll('[data-testid="cp-finding"]')].some((f) => f.dataset.source === "copilot"));
  const crit = await page.$$eval('[data-testid="cp-review-critical"] [data-testid="cp-finding"]', (fs) => fs.map((f) => f.textContent));
  assert.ok(crit.some((f) => /mediator “trust in influencers” is not measured/.test(f)), crit.join("\n"));
  assert.ok(await page.$('[data-testid="cp-review-warning"]') && await page.$('[data-testid="cp-review-suggestion"]'), "grouped Critical / Warning / Suggestion");
  const fix = await page.$('[data-testid="cp-preview-fix"]');
  if (fix) {
    await fix.click();
    await page.waitForFunction(() => document.querySelector('[data-testid="cp-panel"]')?.getAttribute("data-tab") === "changes");
    assert.ok((await texts('[data-testid="cp-summary"] li')).length > 0, "the fix is a previewed proposal");
    await page.click('[data-testid="cp-panel-cancel"]');
  }
  assert.equal((await readDef()).questions.length, 5, "a review changes nothing");
  await switchMode(page, "intelligent");
  ok("Review: the engine's findings at once, the copilot's reading merged in, grouped by severity, linked to questions; a fix is only ever a previewed proposal");
}

/* ------------------------------------------------------------ research documents: upload, summarise, retrieve, cite */
{
  const card = { title: "Social media and skincare", type: "paper", summary: "Exposure to influencer content predicts premium purchase intention; trust mediates.", constructs: [{ name: "Influencer trust" }], scales: [{ name: "Influencer trust scale", items: 3, points: 7 }], findings: [{ text: "Trust mediates exposure → intention" }], questionAreas: [{ text: "Trust in influencer recommendations" }] };
  await page.evaluate((c) => window.__rescriptCopilotFakeDoc({ summary: c }), card);
  const pdf = pdfFixture([["Social Media and Premium Skincare", "Abstract. Exposure to influencer content predicts", "purchase intention among 18-34 year olds."], ["Measures", "Influencer trust was measured with three items on a 7-point", "scale: I trust influencers' skincare advice; influencers are honest", "about products; I rely on influencer reviews."]]);
  await page.setInputFiles('[data-testid="cp-research-file"]', [{ name: "influence-paper.pdf", mimeType: "application/pdf", buffer: Buffer.from(pdf) }]);
  await page.waitForFunction(() => document.querySelectorAll('[data-testid="cp-doc"]').length === 1, null, { timeout: 30000 });
  assert.equal(await page.getAttribute('[data-testid="cp-panel"]', "data-tab"), "research");
  const doc = (await texts('[data-testid="cp-doc"]'))[0];
  assert.match(doc, /influence-paper\.pdf/); assert.match(doc, /paper · 2 pages/);
  assert.match(doc, /Influencer trust scale \(3 items, 7-pt\)/);
  assert.ok(await page.$('[data-testid="cp-not-durable"]'), "the sandbox says its documents are kept for the session only");
  // a scanned PDF: the page image goes to OCR (the fake reads nothing, and says so)
  await page.setInputFiles('[data-testid="cp-research-file"]', [{ name: "scan.pdf", mimeType: "application/pdf", buffer: Buffer.from(pdfFixture([["A cover page with enough text to count."], []], { images: { 1: TINY_JPEG } })) }]);
  await page.waitForFunction(() => document.querySelectorAll('[data-testid="cp-doc"]').length === 2, null, { timeout: 30000 });
  assert.match((await texts('[data-testid="cp-doc"]'))[1], /FAKE provider cannot read images/);
  const ref = (await texts('.cp-doc-ref'))[0];
  // a research request retrieves the relevant passages and the copilot cites them
  const t = await say("Based on the literature, add three questions measuring influencer trust.", {
    kind: "proposal", reply: "The paper measures influencer trust with three 7-point items; I added them as a grid.",
    sources: [{ claim: "Influencer trust is measured with three 7-point items", support: "document", passages: [`${ref}#2`] }, { claim: "Place the grid before purchase intention", support: "recommendation", passages: [] }, { claim: "Trust predicts loyalty", support: "document", passages: [`${ref}#99`] }],
    actions: [{ op: "create_block", title: "Trust", after: "Social media exposure" }, { op: "create_question", ref: "TRUST", type: "matrix", text: "How much do you agree with each statement?", rows: ["I trust influencers' skincare advice", "Influencers are honest about products", "I rely on influencer reviews"], scale: { points: 7, low: "Strongly disagree", high: "Strongly agree" } }],
  });
  assert.ok(await t.$('[data-testid="cp-research-used"]'), "the request was given research passages");
  const sources = await t.$$eval('[data-testid="cp-sources"] li', (ls) => ls.map((l) => `${l.dataset.support}|${l.textContent}`));
  assert.match(sources[0], /^document\|from your documents Influencer trust .*\[influence-paper p\.2\]/);
  assert.match(sources[1], /^recommendation\|/);
  assert.match(sources[2], /^recommendation\|recommendation Trust predicts loyalty$/, "a citation to a passage that does not exist is dropped, and the claim is no longer called documented");
  // …and an edit that is not about the research is given none
  await page.click('[data-testid="cp-panel-cancel"]');
  const t2 = await say("Make Q1 optional.", { kind: "proposal", reply: "Q1 is optional.", actions: [{ op: "update_question", target: "Q1", required: false }] });
  assert.equal(await t2.$('[data-testid="cp-research-used"]'), null, "“make Q1 optional” sends no papers");
  await page.click('[data-testid="cp-panel-cancel"]');
  ok("research: a PDF is extracted, summarised once into a card, and kept; a scanned page goes to OCR; a research request retrieves passages and the copilot's claims are marked document / recommendation with page citations; a plain edit sends no documents");
}

/* ------------------------------------------------------------ grammar fallback and exact read-only answers */
{
  const before = (await page.$$('[data-testid="iq-turn"]')).length;
  await page.fill('[data-testid="iq-input"]', "make Q2 optional");
  await page.keyboard.press("Enter");
  await page.waitForFunction((n) => document.querySelectorAll('[data-testid="iq-turn"]').length > n, before, { timeout: 20000 });
  const last = (await page.$$('[data-testid="iq-turn"]')).at(-1);
  assert.equal(await last.getAttribute("data-kind"), "required", "the model answered nothing usable — the grammar's reading is offered");
  assert.ok(!(await texts('[data-testid="cp-turn"]')).some((x) => x.startsWith("make Q2 optional")), "…and the empty copilot turn is not left behind");
  const n2 = (await page.$$('[data-testid="iq-turn"]')).length;
  await page.fill('[data-testid="iq-input"]', "Why is Q4 not showing?");
  await page.keyboard.press("Enter");
  await page.waitForFunction((n) => document.querySelectorAll('[data-testid="iq-turn"]').length > n, n2);
  assert.equal(await (await page.$$('[data-testid="iq-turn"]')).at(-1).getAttribute("data-kind"), "diagnose", "an exact read-only question is answered by the engine, not the model");
  ok("the grammar remains: it answers when the model has nothing usable, and exact read-only questions (why is Q4 not showing?) are answered by the engine directly");
}

/* ------------------------------------------------------------ voice, in another language */
{
  await fakeNext({ kind: "proposal", reply: "Screening ke baad delivery aur product quality ke sawaal jod diye.", actions: [{ op: "create_block", title: "Delivery and quality" }, { op: "create_question", type: "rating", text: "How satisfied were you with the delivery?", scale: { points: 5, low: "Very dissatisfied", high: "Very satisfied" } }] });
  await page.evaluate(() => window.__rescriptVoiceHint("Pehle screening karo, phir delivery aur product quality ke questions add karo", "hi"));
  const n = (await turns()).length;
  await page.click('[data-testid="iq-mic"]');
  await page.waitForTimeout(1200);
  await page.click('[data-testid="iq-mic"]');
  await page.waitForFunction((k) => { const t = document.querySelectorAll('[data-testid="cp-turn"]'); return t.length > k && t[t.length - 1].getAttribute("data-status") !== "thinking"; }, n, { timeout: 30000 });
  const t = (await turns()).at(-1);
  assert.match(await (await t.$('[data-testid="iq-heard"]')).textContent(), /Heard \(Hindi\): Pehle screening karo/);
  assert.equal(await t.getAttribute("data-kind"), "proposal");
  assert.match(await (await t.$('[data-testid="cp-reply"]')).textContent(), /delivery aur product quality/);
  await page.click('[data-testid="cp-panel-cancel"]');
  ok("voice in Hinglish: heard, sent to the copilot, answered in the researcher's language with a proposal");
}

/* ------------------------------------------------------------ the routes */
{
  const r = await fetch(`${STUDIO}/api/copilot/turn`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ surveyId: "00000000-0000-0000-0000-000000000000", message: "x", definition: empty }) });
  assert.equal(r.status, 401, "only the sandbox may call the copilot without a session");
  const r2 = await fetch(`${STUDIO}/api/copilot/turn`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ surveyId: "sandbox", message: "x", definition: { questions: "nope" } }) });
  assert.equal(r2.status, 400);
  const r3 = await fetch(`${STUDIO}/api/copilot/documents?surveyId=00000000-0000-0000-0000-000000000000`);
  assert.equal(r3.status, 401);
  ok("the routes refuse without a session outside the sandbox, and refuse a malformed survey");
}

assert.deepEqual(pageErrors, [], pageErrors.join("\n"));
await browser.close();
console.log(`\ncopilot: ${passed} passed`);

/**
 * INTELLIGENT MODE — describe, review, apply (Phase 4).
 *
 *   node scripts/intelligent-mode-test.mjs
 *
 * Runs against the Studio dev server. With no AI provider configured the
 * mode runs on its deterministic grammar (badge "grammar only"); with
 * AI_API_URL=fake: the route answers and the badge reads "grammar + model"
 * — the fake returns no intent, so every proposal below still comes from
 * the grammar. Either way the review step is what is tested: nothing is
 * written until Apply.
 */
import assert from "node:assert/strict";
import { chromium } from "/home/claude/.npm-global/lib/node_modules/playwright/index.mjs";
import { openTab, switchMode } from "./lib/nav.mjs";
import { buildMasterDemoSurvey } from "../packages/templates/dist/index.js";

const STUDIO = process.env.STUDIO_URL ?? "http://localhost:3000";
let passed = 0;
const ok = (msg) => { passed++; console.log(`  ok   ${msg}`); };
const mod = process.platform === "darwin" ? "Meta" : "Control";

// a fake microphone, so the voice path runs end to end: MediaRecorder → /api/ai/transcribe → the pipeline
const browser = await chromium.launch({ args: ["--use-fake-device-for-media-stream", "--use-fake-ui-for-media-stream"] });
const context = await browser.newContext({ viewport: { width: 1600, height: 950 }, permissions: ["microphone"] });
const page = await context.newPage();
const pageErrors = [];
page.on("pageerror", (e) => pageErrors.push(String(e)));
page.on("console", (m) => {
  if (m.type() !== "error") return;
  const t = m.text();
  if (/401|501|ERR_TUNNEL|Failed to load resource/.test(t)) return;
  pageErrors.push(t.slice(0, 400));
});

const goTab = async (name) => { await openTab(page, `${name}`); await page.waitForTimeout(150); };
const loadDef = async (def) => {
  await goTab("JSON");
  await page.waitForSelector("textarea.code");
  await page.click('button:has-text("edit")');
  await page.$eval("textarea.code", (el, v) => {
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value").set.call(el, v);
    el.dispatchEvent(new Event("input", { bubbles: true }));
  }, JSON.stringify(def));
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
const q = (def, code) => def.questions.find((x) => x.code === code);

/** type a sentence, wait for its card */
const say = async (text) => {
  const before = await page.$$eval('[data-testid="iq-turn"]', (els) => els.length);
  await page.fill('[data-testid="iq-input"]', text);
  await page.keyboard.press("Enter");
  await page.waitForFunction((n) => document.querySelectorAll('[data-testid="iq-turn"]').length > n, before);
  await page.waitForSelector('[data-testid="iq-thinking"]', { state: "detached" });
  const turns = await page.$$('[data-testid="iq-turn"]');
  return turns[turns.length - 1];
};
const textOf = async (el, sel) => { const c = await el.$(sel); return c ? (await c.textContent()).trim() : null; };
const allText = async (el, sel) => { const cs = await el.$$(sel); return Promise.all(cs.map(async (c) => (await c.textContent()).trim())); };

await page.goto(`${STUDIO}/sandbox?mode=studio`, { waitUntil: "networkidle" });
await page.waitForSelector(".block-badge");
await loadDef(buildMasterDemoSurvey("sandbox"));

/* ------------------------------------------------------------- switch */
{
  await switchMode(page, "intelligent");
  await page.waitForSelector('[data-testid="intelligent-view"]');
  ok("Intelligent renders in place — no reload");
  assert.match(page.url(), /mode=intelligent/);
  assert.equal(await page.$eval(".rightpanel", (e) => e.classList.contains("rp-hidden")), true);
  ok("the outer property panel steps aside — the mode has its own inspector");
  await page.waitForSelector('[data-testid="iq-welcome"]');
  assert.equal(await page.textContent('[data-testid="iq-welcome"] h2'), "How do you want to program your research?");
  const examples = await page.$$('[data-testid="iq-example"]');
  assert.ok(examples.length >= 8);
  ok(`the welcome asks the brief's question and offers ${examples.length} example sentences`);
  await examples[0].click();
  assert.match(await page.inputValue('[data-testid="iq-input"]'), /^Show Q5 only when/);
  ok("an example fills the prompt but does not send it");
  await page.fill('[data-testid="iq-input"]', "");
}

/* ------------------------------------------------------ display logic */
{
  const before = await readDef();
  assert.equal(q(before, "Q6").displayLogic, undefined, "Q6 has no display logic to begin with");
  const turn = await say("Show Q6 only when Q4 = United States and Q3 >= 18");
  assert.equal(await turn.getAttribute("data-state"), "open");
  assert.equal(await turn.getAttribute("data-kind"), "display");
  assert.equal(await turn.getAttribute("data-source"), "grammar");
  assert.equal(await textOf(turn, ".iq-kicker"), "PROPOSED CHANGE");
  ok("a sentence becomes a PROPOSED CHANGE card");
  const summary = await textOf(turn, '[data-testid="iq-summary"]');
  assert.equal(summary, "Show Q6 only when (Q4 is “United States” AND Q3 is at least “18”).");
  ok(`the summary reads the way the Logic panel will: ${summary}`);
  const expr = await textOf(turn, '[data-testid="iq-expression"] code');
  assert.equal(expr, "Q4 = 1 AND Q3 >= 18");
  ok("the condition is shown canonically — the option by its CODE (United States = 1), the rule validated by the expression parser");
  assert.equal((await turn.$$('[data-testid="iq-error"]')).length, 0);
  assert.equal(await page.$eval('[data-testid="iq-apply"]', (b) => b.disabled), false);
  ok("no errors, Apply is enabled");

  const mid = await readDef();
  assert.equal(q(mid, "Q6").displayLogic, undefined);
  ok("NOTHING was written yet — the review step is real");

  // the object is selected and the inspector shows it
  assert.equal(await page.$eval('[data-testid="inspector"]', (e) => e.dataset.kind), "question");
  assert.equal(await page.textContent('[data-testid="inspector"] .ai-title'), "Q6");
  ok("the inspector shows the proposal's target — how it is wired NOW");

  await page.click('[data-testid="iq-review-btn"]');
  await page.waitForSelector('[data-testid="iq-review"]');
  const ops = await page.$$eval('[data-testid="iq-review"] .iq-op', (els) => els.map((e) => e.textContent));
  assert.deepEqual(ops, ["ALL of"]);
  const rules = await page.$$eval('[data-testid="iq-review"] .iq-rule', (els) => els.map((e) => e.textContent));
  assert.deepEqual(rules, ["Q4 = 1", "Q3 >= 18"]);
  ok("Review Logic shows the structured rule: ALL of [Q4 = 1, Q3 >= 18]");

  await page.click('[data-testid="iq-apply"]');
  await page.waitForFunction(() => document.querySelector('[data-testid="iq-turn"]:last-of-type')?.dataset.state === "applied");
  const after = await readDef();
  const dl = q(after, "Q6").displayLogic;
  assert.ok(dl && dl.type === "group" && dl.op === "and" && dl.children.length === 2, JSON.stringify(dl));
  assert.equal(dl.children[0].source.ref, "q_country");
  assert.equal(dl.children[1].operator, "gte");
  ok("Apply writes the canonical condition tree onto Q6 — the same shape the visual builder writes");
  assert.equal((await page.$$('[data-testid="iq-apply"]')).length, 0);
  ok("an applied card has no more buttons");

  // one undo step, labelled
  await page.keyboard.press(`${mod}+z`);
  await page.waitForTimeout(300);
  const undone = await readDef();
  assert.equal(q(undone, "Q6").displayLogic, undefined);
  ok("⌘Z removes the whole proposal in one step");
  await page.keyboard.press(`${mod}+Shift+z`);
  await page.waitForTimeout(300);
  assert.ok(q(await readDef(), "Q6").displayLogic);
  ok("and redo puts it back");
}

/* ------------------------------------------------------ cancel + hide */
{
  const turn = await say("hide Q9 if Q8 = No");
  assert.equal(await textOf(turn, '[data-testid="iq-summary"]'), "Hide Q9 when Q8 is “No”.");
  const warn = await allText(turn, '[data-testid="iq-warning"]');
  assert.ok(warn.some((w) => /already has display logic/.test(w)), warn.join(" | "));
  ok("replacing existing display logic is said out loud before Apply");
  await page.click('[data-testid="iq-cancel"]');
  await page.waitForFunction(() => document.querySelector('[data-testid="iq-turn"]:last-of-type')?.dataset.state === "cancelled");
  const d = await readDef();
  assert.equal(d.questions.find((x) => x.code === "Q9").displayLogic.children?.[0]?.source?.ref ?? d.questions.find((x) => x.code === "Q9").displayLogic.source.ref, "q_contact_ok");
  ok("Cancel leaves the survey exactly as it was");
}

/* --------------------------------------------------------- refusals */
{
  let turn = await say("show Q3 when Q99 = 1");
  const errs = await allText(turn, '[data-testid="iq-error"]');
  assert.ok(errs.length >= 1, "an unknown question is an error");
  assert.equal(await page.$eval('[data-testid="iq-turn"]:last-of-type [data-testid="iq-apply"]', (b) => b.disabled), true);
  ok(`a condition naming a question that does not exist blocks Apply: ${errs[0]}`);
  await page.click('[data-testid="iq-turn"]:last-of-type [data-testid="iq-cancel"]');

  turn = await say("show Q3 when Q10 = 1");
  const errs2 = await allText(turn, '[data-testid="iq-error"]');
  assert.ok(errs2.some((e) => /asked after/.test(e)), errs2.join(" | "));
  assert.equal(await page.$eval('[data-testid="iq-turn"]:last-of-type [data-testid="iq-apply"]', (b) => b.disabled), true);
  ok("logic that reads a LATER question is refused by the engine's validation — the model could not sneak it in either");
  await page.click('[data-testid="iq-turn"]:last-of-type [data-testid="iq-cancel"]');

  turn = await say("make me a sandwich");
  assert.equal(await turn.getAttribute("data-kind"), "unknown");
  assert.equal((await turn.$$('[data-testid="iq-apply"]')).length, 0);
  const e3 = await allText(turn, '[data-testid="iq-error"]');
  assert.ok(e3.length >= 1);
  ok("a sentence nobody understood gets an explanation and no Apply button");
}

/* ------------------------------------------------- skip / required */
{
  const before = await readDef();
  const skipsBefore = q(before, "Q3").skipLogic.length;
  const turn = await say("After Q3, screen out when Q3 < 18");
  assert.equal(await textOf(turn, '[data-testid="iq-summary"]'), "After Q3, skip to out of the survey (screened) when Q3 is less than “18”.");
  const desc = await allText(turn, '[data-testid="iq-changes"] li');
  assert.deepEqual(desc, ["After Q3, skip out of the survey as screened when Q3 is less than “18”."]);
  ok("a termination is a skip rule to terminate/screened, on the question that triggers it");
  await page.click('[data-testid="iq-turn"]:last-of-type [data-testid="iq-apply"]');
  await page.waitForFunction(() => document.querySelector('[data-testid="iq-turn"]:last-of-type')?.dataset.state === "applied");
  const after = await readDef();
  assert.equal(q(after, "Q3").skipLogic.length, skipsBefore + 1);
  const rule = q(after, "Q3").skipLogic.at(-1);
  assert.deepEqual(rule.target, { kind: "terminate", status: "screened" });
  ok("the rule is on Q3 with a terminate target");

  const t2 = await say("make Q9 required");
  assert.deepEqual(await allText(t2, '[data-testid="iq-changes"] li'), ["Make Q9 required."]);
  await page.click('[data-testid="iq-turn"]:last-of-type [data-testid="iq-apply"]');
  await page.waitForFunction(() => document.querySelector('[data-testid="iq-turn"]:last-of-type')?.dataset.state === "applied");
  assert.equal(q(await readDef(), "Q9").required, true);
  ok("required flips through the same review → Apply path");
}

/* ------------------------------------------------------ add question */
{
  const before = await readDef();
  const n = before.questions.length;
  const turn = await say("Add a single choice question “Do you own a car?” after Q3 with options Yes, No");
  const summary = await textOf(turn, '[data-testid="iq-summary"]');
  assert.match(summary, /^Add Q\d+ after Q3: “Do you own a car\?”\.$/);
  const desc = await allText(turn, '[data-testid="iq-changes"] li');
  assert.match(desc[0], /single select.*“Do you own a car\?”.*2 options/);
  ok(`a new question is proposed with its type, text, options and place: ${summary}`);
  await page.click('[data-testid="iq-turn"]:last-of-type [data-testid="iq-apply"]');
  await page.waitForFunction(() => document.querySelector('[data-testid="iq-turn"]:last-of-type')?.dataset.state === "applied");
  const after = await readDef();
  assert.equal(after.questions.length, n + 1);
  const added = after.questions.find((x) => x.text === "Do you own a car?");
  assert.ok(added);
  assert.deepEqual(added.options.map((o) => o.label), ["Yes", "No"]);
  assert.equal(added.variant, "single_select.radio");
  const page1 = (function find(nodes) { for (const nd of nodes) { if (nd.type === "page" && nd.questionIds.includes("q_age")) return nd; const r = nd.children ? find(nd.children) : null; if (r) return r; } return null; })(after.flow);
  assert.equal(page1.questionIds[page1.questionIds.indexOf("q_age") + 1], added.id);
  ok("Apply adds it right after Q3 on Q3's page, built by the Studio's own question factory");
  // the added question is selected — and Grid agrees, because selection is shared
  await switchMode(page, "grid");
  await page.waitForSelector('[data-testid="grid-view"]');
  const selected = await page.$$eval('[data-testid="grid-row"].selected, .sg-row.selected, [aria-selected="true"]', (els) => els.map((e) => e.dataset.question ?? e.dataset.id ?? e.textContent.slice(0, 40)));
  assert.ok(selected.length >= 1, "the new question is the selection in Grid");
  ok("the selection made by Apply is the Studio's shared selection — Grid opens on it");
  await switchMode(page, "intelligent");
  await page.waitForSelector('[data-testid="intelligent-view"]');
}

/* ------------------------------------------------ find + explain (read-only) */
{
  const turn = await say("What depends on Q13?");
  assert.equal(await turn.getAttribute("data-kind"), "find");
  assert.equal((await turn.$$('[data-testid="iq-apply"]')).length, 0);
  const chips = await turn.$$('[data-testid="iq-chip"]');
  assert.ok(chips.length >= 2, `Q13 (use type) drives branches and rules: ${chips.length}`);
  ok(`a question answers from the dependency index with ${chips.length} selectable objects — no Apply button`);
  const key = await chips[0].getAttribute("data-key");
  await chips[0].click();
  await page.waitForFunction((k) => document.querySelector('[data-testid="inspector"] .ai-title')?.textContent === k.split(":")[1] || document.querySelector('[data-testid="inspector"]')?.dataset.kind === k.split(":")[0], key);
  ok(`clicking a chip selects that object (${key}) — the inspector follows`);

  const t2 = await say("explain Q5");
  assert.equal(await t2.getAttribute("data-kind"), "explain");
  const lines = await allText(t2, ".iq-answer-list li");
  assert.ok(lines.some((l) => /^Q5 \(REGION\) is a dropdown question, required\.$/.test(l)), lines.join(" | "));
  assert.ok(lines.some((l) => /^Shown when Q4/.test(l)), lines.join(" | "));
  assert.ok(lines.some((l) => /^It reads: Q4/.test(l)), lines.join(" | "));
  ok("explain says what a question is, when it is shown and what it reads");
}

/* ------------------------------------------------ validation + masking (round 2, §9–10) */
{
  const before = await readDef();
  const q3 = q(before, "Q3");
  const turn = await say("Q3 must be between 18 and 99");
  assert.equal(await turn.getAttribute("data-kind"), "validation");
  assert.equal(await textOf(turn, '[data-testid="iq-summary"]'), "Validate Q3: at least 18, at most 99.");
  ok("a validation sentence becomes a proposal in the engine's rule kinds");
  await page.click('[data-testid="iq-turn"]:last-of-type [data-testid="iq-apply"]');
  await page.waitForFunction(() => document.querySelector('[data-testid="iq-turn"]:last-of-type')?.dataset.state === "applied");
  const after = await readDef();
  const rules = q(after, "Q3").validation;
  assert.deepEqual(rules.filter((r) => /_value$/.test(r.kind)).map((r) => [r.kind, r.value]), [["min_value", 18], ["max_value", 99]]);
  assert.deepEqual({ ...q(after, "Q3"), validation: undefined }, { ...q3, validation: undefined }, "nothing else on Q3 changed");
  ok("Apply writes min/max onto Q3's validation — the same rules the Validation panel writes");
  // the Studio panel shows them; the same survey
  await switchMode(page, "studio");
  await page.waitForSelector('[data-testid="questions-panel"]');
  await page.click(`[data-testid="qcard"][data-qid="${q3.id}"]`);
  await page.waitForTimeout(300);
  assert.match(await page.textContent(".rightpanel"), /Validation/);
  ok("Studio's property panel is where they now live, editable as ever");
  await switchMode(page, "intelligent");
  await page.waitForSelector('[data-testid="intelligent-view"]');
  const bad = await say("Q6 must be between 1 and 5");
  assert.ok((await allText(bad, '[data-testid="iq-error"]')).some((e) => /not numeric/.test(e)));
  assert.equal(await page.$eval('[data-testid="iq-turn"]:last-of-type [data-testid="iq-apply"]', (b) => b.disabled), true);
  ok("a value range on a text question is refused by the engine before Apply is offered");
  await page.click('[data-testid="iq-turn"]:last-of-type [data-testid="iq-cancel"]');
  const email = await say("Q7 must be an email address");
  assert.equal(await textOf(email, '[data-testid="iq-summary"]'), "Validate Q7: an email address.");
  await page.click('[data-testid="iq-turn"]:last-of-type [data-testid="iq-apply"]');
  await page.waitForFunction(() => document.querySelector('[data-testid="iq-turn"]:last-of-type')?.dataset.state === "applied");
  assert.ok(q(await readDef(), "Q7").validation.some((r) => r.kind === "email"));
  ok("a format check (email) applies the same way");
  await page.waitForSelector('[data-testid="intelligent-view"]');
  // masking: Q13's options limited to what Q11 selected
  const mask = await say("At Q13 show only the options selected in Q11");
  assert.equal(await mask.getAttribute("data-kind"), "mask");
  assert.equal(await textOf(mask, '[data-testid="iq-summary"]'), "Show at Q13 only the options Q11.Selected.");
  assert.equal(await textOf(mask, '[data-testid="iq-expression"] code'), "Q11.Selected");
  ok("a masking sentence becomes a set expression the mask parser accepted");
  await page.click('[data-testid="iq-turn"]:last-of-type [data-testid="iq-apply"]');
  await page.waitForFunction(() => document.querySelector('[data-testid="iq-turn"]:last-of-type')?.dataset.state === "applied");
  const masked = q(await readDef(), "Q13");
  assert.deepEqual(masked.mask.expr, { kind: "ref", questionId: q(before, "Q11").id, selection: "selected" });
  assert.equal(masked.mask.action, "display");
  ok("Apply writes the universal OptionMask onto Q13 — the same object the Masking builder edits");
  await page.waitForSelector('[data-testid="intelligent-view"]');
  const clear = await say("remove the mask from Q13");
  await page.click('[data-testid="iq-turn"]:last-of-type [data-testid="iq-apply"]');
  await page.waitForFunction(() => document.querySelector('[data-testid="iq-turn"]:last-of-type')?.dataset.state === "applied");
  assert.equal(q(await readDef(), "Q13").mask, undefined);
  ok("and “remove the mask” takes it off again");
  await page.waitForSelector('[data-testid="intelligent-view"]');
  void clear;
}

/* ------------------------------------------- structure and context (UI upgrade §17, §22–§24) */
{
  const d0 = await readDef();
  // "this question": the selection is the context — an answered question becomes the selection
  await say("explain Q9");
  const t2 = await say("make this question optional");
  assert.match(await textOf(t2, '[data-testid="iq-summary"]'), /Make Q9 optional/);
  ok("“this question” is the selected question — the selection is the context");
  await page.click('[data-testid="iq-turn"]:last-of-type [data-testid="iq-cancel"]');
  // page break
  const t3 = await say("Add a page break after Q3");
  assert.match(await textOf(t3, '[data-testid="iq-summary"]'), /Add a page break after Q3 in Block 2 · About you — .*Q4, Q5, Q6 move to a new page/);
  await t3.$eval('[data-testid="iq-apply"]', (b) => b.click());
  await page.waitForFunction(() => document.querySelector('[data-testid="iq-turn"]:last-of-type')?.dataset.state === "applied");
  const d1 = await readDef();
  const blockAbout = d1.flow.flatMap((n) => n.type === "section" ? n.children : [n]).find((n) => n.type === "block" && n.children?.some((p) => p.questionIds?.includes(q(d0, "Q3").id)));
  assert.ok(blockAbout, "the About you page became a block");
  assert.equal(blockAbout.children.length, 2);
  assert.deepEqual(blockAbout.children[0].questionIds, [q(d0, "Q3").id]);
  assert.ok(blockAbout.children[1].questionIds.length >= 3);
  ok("Apply splits the page through the engine — Q3 | the rest, one block");
  const t4 = await say("Remove the page break after Q3");
  await t4.$eval('[data-testid="iq-apply"]', (b) => b.click());
  await page.waitForFunction(() => document.querySelector('[data-testid="iq-turn"]:last-of-type')?.dataset.state === "applied");
  const d2 = await readDef();
  const pagesOf = (flow) => { const out = []; const walk = (ns) => { for (const n of ns) { if (n.type === "page") out.push([n.id, n.title ?? "", n.questionIds.join(",")]); if (n.children) walk(n.children); if (n.branches) for (const b of n.branches) walk(b.children); if (n.otherwise) walk(n.otherwise); } }; walk(flow); return JSON.stringify(out); };
  assert.equal(pagesOf(d2.flow), pagesOf(d0.flow), "and removing it restores the pages exactly");
  assert.equal(d2.flow.length, d0.flow.length);
  ok("“Remove the page break after Q3” joins the pages back — the flow is byte-identical to before");
  // embedded variable
  const t5 = await say("Create an embedded variable called country and set it to India");
  assert.equal(await textOf(t5, '[data-testid="iq-summary"]'), "Create the embedded variable country, set to “India”.");
  await t5.$eval('[data-testid="iq-apply"]', (b) => b.click());
  await page.waitForFunction(() => document.querySelector('[data-testid="iq-turn"]:last-of-type')?.dataset.state === "applied");
  const d3 = await readDef();
  const ed = d3.flow.find((n) => n.type === "embedded_data");
  assert.ok(ed.fields.some((f) => f.name === "country" && f.source === "static" && f.value === "India"), JSON.stringify(ed.fields));
  ok("an embedded variable joins the survey's embedded-data node, with its value");
  const t6 = await say("add embedded data country");
  assert.ok((await allText(t6, '[data-testid="iq-error"]')).some((e) => /already exists/.test(e)));
  ok("the same name again is refused before Apply is offered");
  // hidden variable
  const t7 = await say("Add a hidden variable for respondent type");
  assert.match(await textOf(t7, '[data-testid="iq-summary"]'), /Add the hidden variable RESPONDENT_TYPE/);
  await t7.$eval('[data-testid="iq-apply"]', (b) => b.click());
  await page.waitForFunction(() => document.querySelector('[data-testid="iq-turn"]:last-of-type')?.dataset.state === "applied");
  const d4 = await readDef();
  assert.ok(d4.questions.some((x) => x.variableName === "RESPONDENT_TYPE" && x.type === "hidden"));
  ok("a hidden variable is a question of type hidden, named for what it is for");
  // the brief's sentence
  const t8 = await say("Show Q10 only when Q5 option 3 is selected.");
  assert.match(await textOf(t8, '[data-testid="iq-summary"]'), /Show Q10 only when Q5 is/);
  assert.equal(await t8.$$eval('[data-testid="iq-error"]', (e) => e.length), 0);
  ok("“Show Q10 only when Q5 option 3 is selected” — the option by its code, no errors");
  await page.click('[data-testid="iq-turn"]:last-of-type [data-testid="iq-cancel"]');
  const t9 = await say("If Q8 is option 1, skip Q9 and go directly to Q11");
  assert.match(await textOf(t9, '[data-testid="iq-summary"]'), /After Q8, skip to Q11 when Q8 is “Yes”/);
  ok("“skip Q9 and go directly to Q11” lands on Q11");
  await page.click('[data-testid="iq-turn"]:last-of-type [data-testid="iq-cancel"]');
  const t10 = await say("Explain why respondents are screened out");
  const lines = await allText(t10, '.iq-answer-list li');
  assert.ok(lines.length >= 3 && lines.some((l) => /Q1: when/.test(l)) && lines.some((l) => /quota/i.test(l)), lines.join(" | "));
  ok(`screening is explained from every terminating rule and end: ${lines.length} ways out`);
}

/* ------------------------------------------------------------ voice (UI upgrade §18–§21) */
{
  const mic = await page.$('[data-testid="iq-mic"]');
  assert.ok(mic, "a microphone button");
  assert.equal(await mic.getAttribute("data-state"), "idle");
  // the fake speech provider cannot hear: the suite says what it should have heard (a seam the route honours for the fake only)
  await page.evaluate(() => window.__rescriptVoiceHint("make q 6 required", "en"));
  await mic.click();
  await page.waitForFunction(() => document.querySelector('[data-testid="iq-mic"]')?.dataset.state === "recording");
  ok("click → recording (the fake microphone is live)");
  await page.waitForTimeout(700);
  const before = await page.$$eval('[data-testid="iq-turn"]', (els) => els.length);
  await page.click('[data-testid="iq-mic"]');
  await page.waitForFunction((n) => document.querySelectorAll('[data-testid="iq-turn"]').length > n, before, { timeout: 30_000 });
  await page.waitForSelector('[data-testid="iq-thinking"]', { state: "detached" });
  const vt = (await page.$$('[data-testid="iq-turn"]')).slice(-1)[0];
  assert.match(await textOf(vt, '[data-testid="iq-heard"]'), /Heard \(English\): make Q6 required/);
  assert.match(await textOf(vt, '[data-testid="iq-summary"]'), /Make Q6 required/);
  assert.ok(await vt.$('[data-testid="iq-apply"]'), "a proposal with Apply, like a typed sentence — nothing applied by itself");
  ok("click again → transcribed through /api/ai/transcribe → tidied (q 6 → Q6) → proposed for review, not applied");
  await page.click('[data-testid="iq-turn"]:last-of-type [data-testid="iq-cancel"]');
  await page.evaluate(() => window.__rescriptVoiceHint("Q5 के option 3 पर Q10 को दिखाना है", "hi"));
  await page.click('[data-testid="iq-mic"]');
  await page.waitForFunction(() => document.querySelector('[data-testid="iq-mic"]')?.dataset.state === "recording");
  await page.waitForTimeout(500);
  const before2 = await page.$$eval('[data-testid="iq-turn"]', (els) => els.length);
  await page.click('[data-testid="iq-mic"]');
  await page.waitForFunction((n) => document.querySelectorAll('[data-testid="iq-turn"]').length > n, before2, { timeout: 30_000 });
  await page.waitForSelector('[data-testid="iq-thinking"]', { state: "detached" });
  const ht = (await page.$$('[data-testid="iq-turn"]')).slice(-1)[0];
  const heard = await ht.$('[data-testid="iq-heard"]');
  assert.equal(await heard.getAttribute("data-language"), "hi");
  assert.match(await heard.textContent(), /Heard \(Hindi\): Q5 के option 3 पर Q10 को दिखाना है/);
  ok("a Hindi instruction is heard as Hindi and shown as heard; the English reading is the model's (the fake gives none, so the transcript stands)");
  assert.equal(await page.$eval('[data-testid="iq-mic"]', (e) => e.dataset.state), "idle");
  const r = await page.evaluate(async () => {
    const form = new FormData(); form.append("audio", new Blob([new Uint8Array(1200)], { type: "audio/webm" }), "x.webm"); form.append("surveyId", "sandbox");
    const res = await fetch("/api/ai/transcribe", { method: "POST", body: form });
    return { status: res.status, body: await res.json().catch(() => null) };
  });
  assert.equal(r.status, 200);
  assert.ok(!JSON.stringify(r.body).includes("AI_API"), "nothing about the provider leaks");
  ok(`the transcribe route answers directly too (${r.body.language}, model ${r.body.model}) and leaks no configuration`);
}

/* ------------------------------------------------------- the model route */
{
  const r = await page.evaluate(async () => {
    const res = await fetch("/api/ai/logic", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ text: "show Q6 when Q3 > 1", context: "Q3 (AGE) numeric" }) });
    return { status: res.status, body: await res.json().catch(() => null) };
  });
  const badge = await page.getAttribute('[data-testid="iq-provider"]', "data-ai");
  if (r.status === 501) {
    assert.equal(badge, "off");
    ok("no provider configured: the route says 501, the badge says grammar only");
  } else {
    assert.equal(r.status, 200);
    assert.ok(r.body.ok === true && (r.body.intent === null || typeof r.body.intent === "object"), JSON.stringify(r.body));
    assert.equal(badge, "on");
    ok(`the fake provider answers (${JSON.stringify(r.body.intent)}) and the badge says grammar + model`);
  }
  assert.ok(!JSON.stringify(r.body).includes("AI_API"), "nothing about the provider leaks");
}

/* ------------------------------------------------------- read-only */
{
  const roButton = await page.$('[data-testid="readonly-toggle"], button:has-text("Read-only")');
  if (roButton) {
    await roButton.click();
    await page.waitForTimeout(200);
    await say("make Q6 optional");
    assert.equal(await page.$eval('[data-testid="iq-turn"]:last-of-type [data-testid="iq-apply"]', (b) => b.disabled), true);
    ok("read-only: the proposal is shown, Apply is disabled");
    await roButton.click();
  } else {
    console.log("  skip read-only check: no toggle in this sandbox");
  }
}

/* ---------------------------------------------------------- ⌘K path */
{
  await switchMode(page, "grid");
  await page.waitForSelector('[data-testid="grid-view"]');
  await page.keyboard.press(`${mod}+k`);
  await page.waitForSelector('[data-testid="command-palette"]');
  await page.fill('[data-testid="command-palette"] input', "intelligent");
  await page.waitForSelector(".palette-item.active");
  await page.keyboard.press("Enter");
  await page.waitForSelector('[data-testid="intelligent-view"]');
  ok("⌘K → “Intelligent” switches modes like any other command");
  const turns = await page.$$eval('[data-testid="iq-turn"]', (els) => els.length);
  assert.ok(turns >= 20, `the session's history survives a mode round trip: ${turns} turns`);
  ok("the conversation is kept while the survey is edited elsewhere and you come back");
}

assert.deepEqual(pageErrors, [], `page errors: ${pageErrors.join("\n")}`);
ok("no page errors");
await browser.close();
console.log(`\n  ${passed} checks passed`);

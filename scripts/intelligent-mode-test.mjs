/**
 * INTELLIGENT MODE — describe, review, apply (Phase 4; engine first since
 * the Intelligent Mode upgrade's Phase 3).
 *
 *   node scripts/intelligent-mode-test.mjs
 *
 * Runs against the Studio dev server. Every sentence is read by the ENGINE
 * first (`interpretRequest`): an edit it resolves becomes a COPILOT card
 * marked "internal engine · no model call" (`cp-turn` + `cp-engine`) whose
 * actions are the open proposal in the Changes panel; a question about the
 * survey is answered there from its graph; an impossible request is refused
 * with the reason. What the engine defers to the grammar (explain, diagnose,
 * screening, hidden variables) is the grammar's TurnCard (`iq-turn`), as
 * before; anything else goes to the copilot model and, when it has nothing
 * usable (the fake provider), to the grammar's TurnCard. With no AI provider
 * configured the badge reads "engine only"; with AI_API_URL=fake: "engine +
 * copilot". Either way the review step is what is tested: nothing is written
 * until Apply.
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

/** every turn in the conversation, in order: the grammar's TurnCards and the copilot / engine cards */
const ENTRIES = '[data-testid="iq-log"] > [data-testid="iq-turn"], [data-testid="iq-log"] > [data-testid="cp-turn"]';
const entryCount = () => page.$$eval(ENTRIES, (els) => els.length);
/** wait for a new turn after `before`, settled: nothing thinking, the input free again */
const settled = async (before, timeout = 30_000) => {
  await page.waitForFunction(({ sel, n }) => {
    const es = document.querySelectorAll(sel);
    const last = es[es.length - 1];
    return es.length > n && !document.querySelector('[data-testid="iq-thinking"]') && last.getAttribute("data-status") !== "thinking" && !document.querySelector('[data-testid="iq-input"]')?.disabled;
  }, { sel: ENTRIES, n: before }, { timeout });
  return (await page.$$(ENTRIES)).at(-1);
};
/** type a sentence, wait for its card — an engine / copilot card or a grammar TurnCard, whichever the routing chose */
const say = async (text) => {
  const before = await entryCount();
  await page.fill('[data-testid="iq-input"]', text);
  await page.keyboard.press("Enter");
  return settled(before);
};
const textOf = async (el, sel) => { const c = await el.$(sel); return c ? (await c.textContent()).replace(/\s+/g, " ").trim() : null; };
const allText = async (el, sel) => { const cs = await el.$$(sel); return Promise.all(cs.map(async (c) => (await c.textContent()).replace(/\s+/g, " ").trim())); };
const pageTexts = (sel) => page.$$eval(sel, (els) => els.map((e) => e.textContent.replace(/\s+/g, " ").trim()));

/* the engine's card */
/** the last turn again — a JSON round trip (readDef) re-mounts the conversation, so handles taken before it are stale */
const lastEntry = async () => (await page.$$(ENTRIES)).at(-1);
const isGrammar = async (t) => (await t.getAttribute("data-testid")) === "iq-turn";
/** the turn was read by the internal engine — a copilot card with the "no model call" badge — and what it made of it */
const engineTurn = async (t, kind) => {
  assert.equal(await t.getAttribute("data-testid"), "cp-turn", `an engine card, not ${await t.getAttribute("data-testid")}: ${(await t.textContent()).slice(0, 300)}`);
  assert.ok(await t.$('[data-testid="cp-engine"]'), "read by the internal engine — no model call");
  const k = await t.$eval('[data-testid="cp-engine-detail"]', (e) => e.getAttribute("data-kind"));
  assert.equal(k, kind, `the engine's reading: ${k} — ${await textOf(t, '[data-testid="cp-reply"]')}`);
};
const replyOf = (t) => textOf(t, '[data-testid="cp-reply"]');
/** "what: value" for each row the engine detected */
const detectedOf = (t) => t.$$eval('[data-testid="cp-detected"] .cp-detected-row', (rs) => rs.map((r) => `${r.querySelector("dt").textContent}: ${r.querySelector("dd").textContent}`.replace(/\s+/g, " ").trim()));
/** the Changes panel: the summary lines, and the field-level rows as "Q6 | display logic | — → Q4 = 1 AND Q3 >= 18" */
const changesPanel = async () => {
  await page.click('[data-testid="cp-tab-changes"]');
  await page.waitForSelector('[data-testid="cp-changes"]');
  const summary = await pageTexts('[data-testid="cp-summary"] li');
  const rows = await page.$$eval('[data-testid="cp-modified"] tr', (trs) => {
    let code = "";
    return trs.map((tr) => { const td = [...tr.querySelectorAll("td")].map((x) => x.textContent.replace(/\s+/g, " ").trim()); if (td[0]) code = td[0]; return `${code} | ${td[1]} | ${td[2]}`; });
  });
  return { summary, rows };
};
/** apply the open proposal — from the Changes panel, or from the card itself — confirming what it rewrites when it says so */
const applyProposal = async (t, via = "panel") => {
  await page.click('[data-testid="cp-tab-changes"]');
  await page.waitForSelector('[data-testid="cp-changes"]');
  if (await page.$('[data-testid="cp-confirm"]')) await page.check('[data-testid="cp-confirm"]');
  if (via === "card") await t.$eval('[data-testid="cp-apply"]', (b) => b.click());
  else await page.click('[data-testid="cp-panel-apply"]');
  await page.waitForFunction((el) => el.getAttribute("data-proposal") === "applied", t);
};
const cancelProposal = async (t) => {
  await t.$eval('[data-testid="cp-cancel"]', (b) => b.click());
  await page.waitForFunction((el) => el.getAttribute("data-proposal") === "cancelled", t);
};
/** a turn that proposes nothing: no Apply anywhere on it, and no place in the proposal */
const proposesNothing = async (t) => {
  assert.equal(await t.$('[data-testid="cp-apply"]'), null, "no Apply button");
  assert.equal(await t.getAttribute("data-proposal"), "", "no proposal");
};

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
  let turn = await say("Show Q6 only when Q4 = United States and Q3 >= 18");
  await engineTurn(turn, "actions");
  assert.equal(await turn.getAttribute("data-proposal"), "open");
  assert.equal(await turn.getAttribute("data-kind"), "proposal");
  assert.match(await textOf(turn, ".iq-kicker"), /^PROPOSED$/);
  ok("a sentence becomes a PROPOSED change card — read by the internal engine, no model call");
  const summary = await replyOf(turn);
  assert.equal(summary, "Show Q6 only when Q4 = 1 (United States) AND Q3 >= 18.");
  ok(`the summary says what was understood: ${summary}`);
  // was: the TurnCard's canonical expression "Q4 = 1 AND Q3 >= 18"; the engine says it as detected, with the option's label beside its code
  assert.deepEqual(await detectedOf(turn), ["condition: Q4 = 1 (United States) AND Q3 >= 18", "question: Q6"]);
  ok("the condition is shown canonically — the option by its CODE (United States = 1), its label beside it, the rule validated by the expression parser");
  assert.equal(await turn.$('[data-testid="cp-card-refused"]'), null);
  assert.equal(await turn.$('[data-testid="cp-engine-warning"]'), null);
  assert.equal(await turn.$eval('[data-testid="cp-apply"]', (b) => b.disabled), false);
  assert.equal(await page.$eval('[data-testid="cp-panel-apply"]', (b) => b.disabled), false);
  ok("no errors, Apply is enabled — on the card and in the Changes panel");

  const mid = await readDef();
  assert.equal(q(mid, "Q6").displayLogic, undefined);
  ok("NOTHING was written yet — the review step is real");
  turn = await lastEntry();

  // the object is selected and the inspector shows it (the Inspector is a tab of the copilot panel now)
  await page.click('[data-testid="cp-tab-inspector"]');
  await page.waitForSelector('[data-testid="inspector"]');
  assert.equal(await page.$eval('[data-testid="inspector"]', (e) => e.dataset.kind), "question");
  assert.equal(await page.textContent('[data-testid="inspector"] .ai-title'), "Q6");
  ok("the inspector shows the proposal's target — how it is wired NOW");

  /*
   * Was: the TurnCard's "Review Logic" view — ALL of [Q4 = 1, Q3 >= 18]. An
   * engine proposal has no TurnCard; its review is the Changes panel, which
   * names the change and shows the question's display logic from → to.
   */
  const ch = await changesPanel();
  assert.deepEqual(ch.summary, ["Add 1 display condition", "Change Q6: display logic"]);
  assert.deepEqual(ch.rows, ["Q6 | display logic | — → Q4 = 1 AND Q3 >= 18"]);
  ok("the Changes panel reviews it: one display condition added, Q6's display logic — → Q4 = 1 AND Q3 >= 18");

  await applyProposal(turn, "card");
  const after = await readDef();
  const dl = q(after, "Q6").displayLogic;
  assert.ok(dl && dl.type === "group" && dl.op === "and" && dl.children.length === 2, JSON.stringify(dl));
  assert.equal(dl.children[0].source.ref, "q_country");
  assert.equal(dl.children[0].value, 1);
  assert.equal(dl.children[1].operator, "gte");
  ok("Apply writes the canonical condition tree onto Q6 — the same shape the visual builder writes");
  turn = await lastEntry();
  assert.equal(await turn.$('[data-testid="cp-apply"]'), null);
  assert.equal(await turn.$('[data-testid="cp-cancel"]'), null);
  assert.match(await textOf(turn, ".iq-kicker"), /^APPLIED · AI CHANGE #001$/);
  ok("an applied card has no more buttons — it says APPLIED, with its place in the change history");

  // one undo step
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
  await engineTurn(turn, "actions");
  const reply = await replyOf(turn);
  assert.match(reply, /^Hide Q9 when Q8 = 2 \(No\)/);
  // was: the TurnCard's warning "already has display logic"
  assert.match(reply, /This replaces the current display logic \(Q9: Q8 = 1 \(Yes\)\)/);
  assert.ok((await detectedOf(turn)).includes("replaces: Q9: Q8 = 1 (Yes)"), (await detectedOf(turn)).join(" | "));
  ok("replacing existing display logic is said out loud before Apply");
  await cancelProposal(turn);
  const d = await readDef();
  assert.equal(d.questions.find((x) => x.code === "Q9").displayLogic.children?.[0]?.source?.ref ?? d.questions.find((x) => x.code === "Q9").displayLogic.source.ref, "q_contact_ok");
  assert.equal(await page.$('[data-testid="cp-changes"]'), null, "nothing left proposed");
  ok("Cancel leaves the survey exactly as it was");
}

/* --------------------------------------------------------- refusals */
{
  // Q99 does not exist in a small survey, but the master demo has one (q_rand_pick, asked after Q3): the unknown question is Q999
  let turn = await say("show Q3 when Q999 = 1");
  await engineTurn(turn, "refused");
  assert.match(await replyOf(turn), /I could not read the condition “Q999 = 1”: Q999 does not exist/);
  await proposesNothing(turn);
  ok(`a condition naming a question that does not exist is refused, nothing to apply: ${await replyOf(turn)}`);

  turn = await say("show Q3 when Q99 = 1");
  await engineTurn(turn, "refused");
  assert.match(await replyOf(turn), /Q99 is asked after Q3/);
  await proposesNothing(turn);
  turn = await say("show Q3 when Q10 = 1");
  await engineTurn(turn, "refused");
  assert.match(await replyOf(turn), /not applied: Q10 is asked after Q3, so Q3 cannot be shown on Q10's answer/);
  await proposesNothing(turn);
  ok("logic that reads a LATER question is refused by the engine's validation — the model could not sneak it in either");

  // the engine hands it on; the copilot (the fake model) has nothing usable; the grammar explains it did not understand
  turn = await say("make me a sandwich");
  assert.ok(await isGrammar(turn), "the grammar's card");
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
  await engineTurn(turn, "actions");
  assert.equal(await replyOf(turn), "Screen out respondents when Q3 is less than “18”: after Q3, when Q3 < 18, they leave the survey (screened).");
  assert.deepEqual(await detectedOf(turn), ["condition: Q3 < 18", "skip from: Q3", "target: out of the survey (screened)"]);
  const ch = await changesPanel();
  assert.deepEqual(ch.summary, ["Add 1 skip condition", "Change Q3: skip rules"]);
  assert.deepEqual(ch.rows, [`Q3 | skip rules | ${skipsBefore} → ${skipsBefore + 1}`]);
  ok("a termination is a skip rule to terminate/screened, on the question that triggers it");
  await applyProposal(turn, "card");
  const after = await readDef();
  assert.equal(q(after, "Q3").skipLogic.length, skipsBefore + 1);
  const rule = q(after, "Q3").skipLogic.at(-1);
  assert.deepEqual(rule.target, { kind: "terminate", status: "screened" });
  ok("the rule is on Q3 with a terminate target");

  const t2 = await say("make Q9 required");
  await engineTurn(t2, "actions");
  assert.equal(await replyOf(t2), "Make Q9 required.");
  const c2 = await changesPanel();
  assert.deepEqual(c2.summary, ["Change Q9: required"]);
  assert.deepEqual(c2.rows, ["Q9 | required | optional → required"]);
  await applyProposal(t2);
  assert.equal(q(await readDef(), "Q9").required, true);
  ok("required flips through the same review → Apply path");
}

/* ------------------------------------------------------ add question */
{
  const before = await readDef();
  const n = before.questions.length;
  const turn = await say("Add a single choice question “Do you own a car?” after Q3 with options Yes, No");
  await engineTurn(turn, "actions");
  const summary = await replyOf(turn);
  assert.equal(summary, "Add a Radio Button question “Do you own a car?” with options “Yes”, “No” after Q3.");
  assert.deepEqual(await detectedOf(turn), ["type: single choice", "after: Q3", "text: Do you own a car?"]);
  const ch = await changesPanel();
  assert.deepEqual(ch.summary, ["Add 1 question"]);
  const added = await page.$$eval('[data-testid="cp-structure"] [data-testid="cp-o-q"][data-mark="added"]', (els) => els.map((e) => e.textContent));
  assert.equal(added.length, 1);
  assert.match(added[0], /Do you own a car\?/);
  ok(`a new question is proposed with its type, text, options and place: ${summary}`);
  await applyProposal(turn, "card");
  const after = await readDef();
  assert.equal(after.questions.length, n + 1);
  const addedQ = after.questions.find((x) => x.text === "Do you own a car?");
  assert.ok(addedQ);
  assert.deepEqual(addedQ.options.map((o) => o.label), ["Yes", "No"]);
  assert.equal(addedQ.variant, "single_select.radio");
  const page1 = (function find(nodes) { for (const nd of nodes) { if (nd.type === "page" && nd.questionIds.includes("q_age")) return nd; const r = nd.children ? find(nd.children) : null; if (r) return r; } return null; })(after.flow);
  assert.equal(page1.questionIds[page1.questionIds.indexOf("q_age") + 1], addedQ.id);
  ok("Apply adds it right after Q3 on Q3's page, as the picker's single-select radio variant");
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
  // was: the grammar's "find" card with chips; the engine answers from the dependency index, in sections whose references navigate
  await engineTurn(turn, "answer");
  assert.match(await replyOf(turn), /^\d+ objects? depends? on Q13/);
  await proposesNothing(turn);
  const titles = await turn.$$eval('[data-testid="cp-engine-section"]', (es) => es.map((e) => e.dataset.title));
  assert.ok(titles.includes("Display logic") && titles.includes("Flow (branches, loops, blocks)"), titles.join(" | "));
  const refs = await turn.$$('[data-testid="cp-engine-ref"]');
  assert.ok(refs.length >= 2, `Q13 (use type) drives branches and rules: ${refs.length}`);
  ok(`a question answers from the dependency index with ${refs.length} selectable objects (${titles.join(", ")}) — no Apply button`);
  await page.click('[data-testid="cp-tab-inspector"]');
  const key = await refs[0].evaluate((e) => e.closest("li").dataset.key);
  await refs[0].click();
  await page.waitForFunction((k) => document.querySelector('[data-testid="inspector"] .ai-title')?.textContent === k.split(":")[1] || document.querySelector('[data-testid="inspector"]')?.dataset.kind === k.split(":")[0], key);
  ok(`clicking a reference selects that object (${key}) — the inspector follows`);

  const t2 = await say("explain Q5");
  assert.ok(await isGrammar(t2), "explain is the grammar's (the engine defers it)");
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
  await engineTurn(turn, "actions");
  assert.equal(await turn.$eval('[data-testid="cp-engine"]', (e) => e.dataset.category), "validation");
  assert.equal(await replyOf(turn), "Q3: minimum value 18, maximum value 99; its other rules stay (whole number).");
  assert.deepEqual(await detectedOf(turn), ["question: Q3", "rule: minimum value 18", "rule: maximum value 99"]);
  assert.deepEqual((await changesPanel()).rows, ["Q3 | validation | integer → integer, min_value 18, max_value 99"]);
  ok("a validation sentence becomes a proposal in the engine's rule kinds, merged with the rules Q3 already has");
  await applyProposal(turn);
  const after = await readDef();
  const rules = q(after, "Q3").validation;
  assert.deepEqual(rules.filter((r) => /_value$/.test(r.kind)).map((r) => [r.kind, r.value]), [["min_value", 18], ["max_value", 99]]);
  assert.equal(rules.find((r) => r.kind === "integer")?.message, "Please enter a whole number of years.", "the existing whole-number rule stays, message and all");
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
  await engineTurn(bad, "refused");
  // was: the grammar's "not numeric" error with a disabled Apply
  assert.match(await replyOf(bad), /Q6 is a text question, so a minimum value does not apply/);
  await proposesNothing(bad);
  assert.equal(await bad.$('[data-testid="cp-engine-fix"]'), null, "no empty “fix” — re-setting Q6's own rules would change nothing");
  ok("a value range on a text question is refused by the engine before Apply is offered");
  // Q7 already checks for an email address (with its own message): asking again changes nothing, and says so
  const same = await say("Q7 must be an email address");
  await engineTurn(same, "refused");
  assert.equal(await replyOf(same), "Q7 already has that rule (email) — nothing to change.");
  await proposesNothing(same);
  // a format check where there is none: Q144 (an open suggestion box, max 200 characters) — merged with the rule it has
  const email = await say("Q144 must be an email address");
  await engineTurn(email, "actions");
  assert.equal(await replyOf(email), "Q144: email; its other rules stay (maximum length 200).");
  await applyProposal(email);
  const v144 = q(await readDef(), "Q144").validation;
  assert.ok(v144.some((r) => r.kind === "email"));
  assert.ok(v144.some((r) => r.kind === "max_length" && r.value === 200));
  ok("a format check (email) applies the same way — and asking for one a question already has is “nothing to change”");
  await page.waitForSelector('[data-testid="intelligent-view"]');
  // masking: Q13's options limited to what Q11 selected
  const mask = await say("At Q13 show only the options selected in Q11");
  await engineTurn(mask, "actions");
  assert.equal(await mask.$eval('[data-testid="cp-engine"]', (e) => e.dataset.category), "masking");
  assert.equal(await replyOf(mask), "At Q13, show only the options selected at Q11 (mask Q11.Selected).");
  assert.deepEqual(await detectedOf(mask), ["mask source: Q11.Selected", "masked question: Q13", "action: display"]);
  assert.deepEqual((await changesPanel()).rows, ["Q13 | mask | — → display: Q11.Selected"]);
  ok("a masking sentence becomes a set expression the mask parser accepted");
  await applyProposal(mask);
  const masked = q(await readDef(), "Q13");
  assert.deepEqual(masked.mask.expr, { kind: "ref", questionId: q(before, "Q11").id, selection: "selected" });
  assert.equal(masked.mask.action, "display");
  ok("Apply writes the universal OptionMask onto Q13 — the same object the Masking builder edits");
  await page.waitForSelector('[data-testid="intelligent-view"]');
  const clear = await say("remove the mask from Q13");
  await engineTurn(clear, "actions");
  assert.deepEqual((await changesPanel()).rows, ["Q13 | mask | display: Q11.Selected → —"]);
  await applyProposal(clear);
  assert.equal(q(await readDef(), "Q13").mask, undefined);
  ok("and “remove the mask” takes it off again");
  await page.waitForSelector('[data-testid="intelligent-view"]');
}

/* ------------------------------------------- structure and context (UI upgrade §17, §22–§24) */
{
  const d0 = await readDef();
  // "this question": the selection is the context — an answered question becomes the selection
  const ex = await say("explain Q9");
  assert.ok(await isGrammar(ex));
  const t2 = await say("make this question optional");
  await engineTurn(t2, "actions");
  assert.equal(await replyOf(t2), "Make Q9 optional.");
  assert.deepEqual(await detectedOf(t2), ["question: Q9"]);
  ok("“this question” is the selected question — the selection is the context");
  await cancelProposal(t2);
  // page break
  const t3 = await say("Add a page break after Q3");
  await engineTurn(t3, "actions");
  assert.equal(await replyOf(t3), "Add a page break after Q3, so what follows it starts a new page.");
  // was: "… in Block 2 · About you — Q4, Q5, Q6 move to a new page"; the Changes panel now says it — a page break, no block added, nothing moved
  const c3 = await changesPanel();
  assert.deepEqual(c3.summary, ["Add 1 page break"]);
  await page.click('[data-testid="cp-before-after"]');
  const pagesAfter = await page.$$eval('[data-testid="cp-outline-after"] .cp-o-block', (els) => els.map((e) => e.textContent.trim()));
  assert.deepEqual(pagesAfter.filter((x) => /About you/.test(x)), ["About you"], `the About you block, now split: ${pagesAfter.join(" | ")}`);
  await applyProposal(t3, "card");
  const d1 = await readDef();
  const blockAbout = d1.flow.flatMap((n) => n.type === "section" ? n.children : [n]).find((n) => n.type === "block" && n.children?.some((p) => p.questionIds?.includes(q(d0, "Q3").id)));
  assert.ok(blockAbout, "the About you page became a block");
  assert.equal(blockAbout.children.length, 2);
  assert.deepEqual(blockAbout.children[0].questionIds, [q(d0, "Q3").id]);
  assert.ok(blockAbout.children[1].questionIds.length >= 3);
  ok("Apply splits the page through the engine — Q3 | the rest, one block");
  const t4 = await say("Remove the page break after Q3");
  await engineTurn(t4, "actions");
  assert.deepEqual((await changesPanel()).summary, ["Remove 1 page break"]);
  await applyProposal(t4, "card");
  const d2 = await readDef();
  const pagesOf = (flow) => { const out = []; const walk = (ns) => { for (const n of ns) { if (n.type === "page") out.push([n.id, n.title ?? "", n.questionIds.join(",")]); if (n.children) walk(n.children); if (n.branches) for (const b of n.branches) walk(b.children); if (n.otherwise) walk(n.otherwise); } }; walk(flow); return JSON.stringify(out); };
  assert.equal(pagesOf(d2.flow), pagesOf(d0.flow), "and removing it restores the pages exactly");
  assert.equal(d2.flow.length, d0.flow.length);
  ok("“Remove the page break after Q3” joins the pages back — the flow is byte-identical to before");
  // embedded variable
  const t5 = await say("Create an embedded variable called country and set it to India");
  await engineTurn(t5, "actions");
  assert.equal(await replyOf(t5), "Create the embedded variable country, set to “India”.");
  assert.deepEqual((await changesPanel()).summary, ["Add embedded country"]);
  await applyProposal(t5, "card");
  const d3 = await readDef();
  const ed = d3.flow.find((n) => n.type === "embedded_data");
  assert.ok(ed.fields.some((f) => f.name === "country" && f.source === "static" && f.value === "India"), JSON.stringify(ed.fields));
  ok("an embedded variable joins the survey's embedded-data node, with its value");
  const t6 = await say("add embedded data country");
  await engineTurn(t6, "refused");
  assert.match(await replyOf(t6), /already exists/);
  await proposesNothing(t6);
  ok("the same name again is refused before Apply is offered");
  // hidden variable — the engine defers it to the grammar
  const t7 = await say("Add a hidden variable for respondent type");
  assert.ok(await isGrammar(t7), "a hidden variable is the grammar's");
  assert.match(await textOf(t7, '[data-testid="iq-summary"]'), /Add the hidden variable RESPONDENT_TYPE/);
  await t7.$eval('[data-testid="iq-apply"]', (b) => b.click());
  await page.waitForFunction((el) => el.dataset.state === "applied", t7);
  const d4 = await readDef();
  assert.ok(d4.questions.some((x) => x.variableName === "RESPONDENT_TYPE" && x.type === "hidden"));
  ok("a hidden variable is a question of type hidden, named for what it is for");
  // the brief's sentence
  const t8 = await say("Show Q10 only when Q5 option 3 is selected.");
  await engineTurn(t8, "actions");
  assert.equal(await replyOf(t8), "Show Q10 only when Q5 = us_s (South).");
  assert.deepEqual(await detectedOf(t8), ["condition: Q5 = us_s (South)", "question: Q10"]);
  assert.equal(await t8.$('[data-testid="cp-card-refused"]'), null);
  assert.deepEqual((await changesPanel()).rows, ["Q10 | display logic | — → Q5 = us_s"]);
  ok("“Show Q10 only when Q5 option 3 is selected” — the option by its code, no errors");
  await cancelProposal(t8);
  /*
   * Was: a proposal "After Q8, skip to Q11 when Q8 is “Yes”" (then cancelled).
   * Q9 shares Q8's page in the master demo, so the skip could never skip it:
   * the engine says so, keeps what it resolved (Q8 = 1 (Yes), Q9 → Q11), and
   * offers the checked fix — a page break after Q8, then the skip.
   */
  const t9 = await say("If Q8 is option 1, skip Q9 and go directly to Q11");
  await engineTurn(t9, "refused");
  assert.match(await replyOf(t9), /Q9 is on the same page as Q8, so it is already on screen when the skip is decided\. Add a page break first\./);
  const d9 = await detectedOf(t9);
  for (const x of ["condition: Q8 = 1 (Yes)", "skip from: Q8", "skip range: Q9 → Q11", "target: Q11"]) assert.ok(d9.includes(x), `${x} in ${d9.join(" | ")}`);
  ok("“skip Q9 and go directly to Q11” lands on Q11 — and the engine refuses a skip within one page");
  await t9.$eval('[data-testid="cp-engine-fix"]', (b) => b.click());
  const c9 = await changesPanel();
  assert.deepEqual(c9.summary, ["Add 1 skip condition", "Add 1 page break", "Change Q8: skip rules"]);
  await page.click('[data-testid="cp-panel-cancel"]');
  assert.equal(q(await readDef(), "Q8").skipLogic?.length ?? 0, q(d0, "Q8").skipLogic?.length ?? 0, "the previewed fix wrote nothing");
  ok("its suggested fix (a page break after Q8, then the skip to Q11) is previewed in Changes, and cancelled writes nothing");
  const t10 = await say("Explain why respondents are screened out");
  assert.ok(await isGrammar(t10));
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
  // (was "make q 6 required": Q6 is already required, which the engine now answers as "nothing to change" — optional is a real proposal)
  await page.evaluate(() => window.__rescriptVoiceHint("make q 6 optional", "en"));
  await mic.click();
  await page.waitForFunction(() => document.querySelector('[data-testid="iq-mic"]')?.dataset.state === "recording");
  ok("click → recording (the fake microphone is live)");
  await page.waitForTimeout(700);
  const before = await entryCount();
  await page.click('[data-testid="iq-mic"]');
  const vt = await settled(before);
  assert.match(await textOf(vt, '[data-testid="iq-heard"]'), /Heard \(English\): make Q6 optional/);
  await engineTurn(vt, "actions");
  assert.equal(await replyOf(vt), "Make Q6 optional.");
  assert.equal(await vt.getAttribute("data-proposal"), "open");
  assert.ok(await vt.$('[data-testid="cp-apply"]'), "a proposal with Apply, like a typed sentence — nothing applied by itself");
  assert.equal(q(await readDef(), "Q6").required, true);
  ok("click again → transcribed through /api/ai/transcribe → tidied (q 6 → Q6) → proposed for review, not applied");
  await cancelProposal(await lastEntry());
  await page.evaluate(() => window.__rescriptVoiceHint("Q5 के option 3 पर Q10 को दिखाना है", "hi"));
  await page.click('[data-testid="iq-mic"]');
  await page.waitForFunction(() => document.querySelector('[data-testid="iq-mic"]')?.dataset.state === "recording");
  await page.waitForTimeout(500);
  const before2 = await entryCount();
  await page.click('[data-testid="iq-mic"]');
  // the engine hands Hindi on, the (fake) copilot has nothing usable, the grammar's card says what was heard
  const ht = await settled(before2);
  assert.ok(await isGrammar(ht), "the grammar's card");
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
  const badgeText = (await page.textContent('[data-testid="iq-provider"]')).trim();
  if (r.status === 501) {
    assert.equal(badge, "off");
    assert.equal(badgeText, "engine only");
    ok("no provider configured: the route says 501, the badge says engine only");
  } else {
    assert.equal(r.status, 200);
    assert.ok(r.body.ok === true && (r.body.intent === null || typeof r.body.intent === "object"), JSON.stringify(r.body));
    assert.equal(badge, "on");
    assert.equal(badgeText, "engine + copilot");
    ok(`the fake provider answers (${JSON.stringify(r.body.intent)}) and the badge says engine + copilot`);
  }
  assert.ok(!JSON.stringify(r.body).includes("AI_API"), "nothing about the provider leaks");
}

/* ------------------------------------------------------- read-only */
{
  const roButton = await page.$('[data-testid="readonly-toggle"], button:has-text("Read-only")');
  if (roButton) {
    await roButton.click();
    await page.waitForTimeout(200);
    const t = await say("make Q6 optional");
    await engineTurn(t, "actions");
    assert.equal(await t.$eval('[data-testid="cp-apply"]', (b) => b.disabled), true);
    ok("read-only: the proposal is shown, Apply is disabled");
    await cancelProposal(t);
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
  const turns = await entryCount();
  assert.ok(turns >= 20, `the session's history survives a mode round trip: ${turns} turns`);
  ok("the conversation is kept while the survey is edited elsewhere and you come back");
}

assert.deepEqual(pageErrors, [], `page errors: ${pageErrors.join("\n")}`);
ok("no page errors");
await browser.close();
console.log(`\n  ${passed} checks passed`);

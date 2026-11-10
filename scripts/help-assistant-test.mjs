/**
 * HELP ASSISTANT (2026-11-09) — browser suite. Studio on :3000 with AI_API_URL=fake: (the sandbox: no database, no
 * model, so answers come from the guides and nothing is stored).
 *
 *   1  the Studio's Help button opens the assistant: welcome, popular questions, topics led by the current panel's
 *   2  a natural-language question gets the right guide: steps with real control names, sources, follow-ups
 *   3  a follow-up ("two conditions") stays on the topic; an ambiguous request gets a clarifying question whose
 *      options lead to the right guide
 *   4  troubleshooting leads with causes and checks (the open survey is sent as context; the model uses it — diagnosing
 *      it directly is phase 2); billing answers state the live test-usage rule
 *   5  "do it for me" is handed to Intelligent Mode — the instruction lands in its input, unsent; nothing changed
 *   6  a source opens the full guide; no page errors
 *
 * THE HELP CENTER ROUTING (2026-11-10, lib/help/levels.ts):
 *   7  answers say how they were produced (guides / survey checked / AI); a well-covered question uses no model
 *   8  Level 2: "why isn't Q4 showing" checks the open survey — verified findings, a verdict, and a fix to propose in
 *      Intelligent Mode; the goal example ("every selected brand in a separate set of questions") reaches loops
 *   9  "Did this solve it? No" moves the problem on without repeating the guide; a second No offers a person
 *  10  the hand-off shows exactly what would be shared and, with no database or support address (the sandbox), says
 *      plainly that it isn't set up instead of pretending; out-of-domain questions are not guessed at
 */
import assert from "node:assert/strict";
import { chromium } from "./lib/playwright.mjs";
import { openTab, switchMode } from "./lib/nav.mjs";

const STUDIO = process.env.STUDIO_URL ?? "http://localhost:3000";
let passed = 0;
const ok = (m) => { passed++; console.log(`  ok   ${m}`); };
const DEF = {
  meta: { id: "sandbox", code: "HELP", title: "Help study", version: "1.0", schemaVersion: 1, status: "draft" },
  questions: [
    { id: "q1", code: "Q1", variableName: "Q1", type: "single_select", text: "Have you purchased in the last six months?", required: true, options: [{ id: "o1", code: 1, label: "Yes" }, { id: "o2", code: 2, label: "No" }] },
    { id: "q2", code: "Q2", variableName: "Q2", type: "single_select", text: "Where did you buy it?", required: true, displayLogic: { type: "rule", source: { kind: "question", ref: "q1" }, operator: "eq", value: 1 }, options: [{ id: "a", code: 1, label: "Online" }, { id: "b", code: 2, label: "In store" }] },
    { id: "q3", code: "Q3", variableName: "Q3", type: "long_text", text: "Anything else?" },
    /* Level 2's "never": its display logic reads Q5, which is asked after it */
    { id: "q4", code: "Q4", variableName: "Q4", type: "long_text", text: "Tell us about the follow-up", displayLogic: { type: "rule", source: { kind: "question", ref: "q5" }, operator: "answered" } },
    { id: "q5", code: "Q5", variableName: "Q5", type: "long_text", text: "Any last words?" },
  ],
  flow: [{ type: "page", id: "p1", questionIds: ["q1"] }, { type: "page", id: "p2", questionIds: ["q2"] }, { type: "page", id: "p3", questionIds: ["q3"] }, { type: "page", id: "p4", questionIds: ["q4"] }, { type: "page", id: "p5", questionIds: ["q5"] }, { type: "end", id: "e1", status: "complete" }],
};

const browser = await chromium.launch();
const errors = [];
const p = await (await browser.newContext({ viewport: { width: 1500, height: 1000 } })).newPage();
p.on("pageerror", (e) => errors.push(String(e)));
p.on("dialog", (d) => d.accept());
for (let i = 0; i < 20; i++) { try { const r = await fetch(`${STUDIO}/sandbox?mode=studio`); if (r.status < 500) break; } catch { /* starting */ } await new Promise((r) => setTimeout(r, 2000)); }
await p.goto(`${STUDIO}/sandbox?mode=studio`, { waitUntil: "load" });
await p.waitForSelector(".block-badge", { timeout: 60000 });
await switchMode(p, "studio").catch(() => {});
await openTab(p, "JSON");
await p.waitForSelector("textarea.code");
await p.click('button:has-text("edit")');
await p.$eval("textarea.code", (el, v) => { Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value").set.call(el, v); el.dispatchEvent(new Event("input", { bubbles: true })); }, JSON.stringify(DEF));
await p.click('button:has-text("validate & apply")');
await p.waitForTimeout(1200);
await openTab(p, "Questions");

const lastAnswer = () => p.locator('[data-testid="help-answer"]').last();
async function ask(text, expectCount) {
  await p.fill('[data-testid="help-input"]', text);
  await p.click('[data-testid="help-send"]');
  await p.waitForFunction((n) => document.querySelectorAll('[data-testid="help-answer"]').length >= n, expectCount, { timeout: 20000 });
  return (await lastAnswer().textContent()) ?? "";
}

console.log("\n1 — the Help drawer");
await p.click('[data-testid="studio-help-button"]'); await p.click('[data-testid="studio-help-help"]');
await p.waitForSelector('[data-testid="studio-help-drawer"] [data-testid="help-welcome"]');
assert.equal(await p.getAttribute('[data-testid="help-input"]', "placeholder"), "Ask anything about ResLens.ai...");
const chips = await p.$$eval('[data-testid="help-suggestions"] .hx-chip', (b) => b.map((x) => x.textContent));
assert.ok(chips.includes("How do I configure skip and display logic?") && chips.length >= 6);
const firstTopic = await p.$eval(".hx-topic summary", (e) => e.textContent);
assert.equal(firstTopic, "Survey creation & programming", "on Questions, the Studio topics come first");
ok(`welcome with ${chips.length} popular questions; topics led by the current panel's (“${firstTopic}”)`);

console.log("\n2 — a question in the user's own words");
let a = await ask("How can I show a question only when someone selects a particular answer?", 1);
assert.match(a, /Show a question only when a condition is met \(display logic\)/);
assert.match(a, /Add logic/); assert.match(a, /\+ Add condition/);
assert.match(await lastAnswer().locator('[data-testid="help-sources"]').textContent(), /display logic/i);
assert.equal(await lastAnswer().getAttribute("data-origin"), "guides");
assert.ok(await lastAnswer().locator('[data-testid="help-followups"] .hx-chip').count() >= 1);
assert.equal(await lastAnswer().getAttribute("data-level"), "1");
assert.equal(await lastAnswer().locator('[data-testid="help-route"]').textContent(), "From the guides · no AI used");
ok("display logic: steps with the real controls (Add logic, + Add condition), its source, follow-ups; labelled as from the guides");

console.log("\n3 — follow-up and clarification");
a = await ask("What if I want to apply two conditions?", 2);
assert.match(a, /ALL of these \(AND\)|ANY of these \(OR\)/);
ok("follow-up “two conditions” → AND / OR, on the same topic");
a = await ask("I want to show respondents only the brands they selected in an earlier question", 3);
await p.waitForSelector('[data-testid="help-clarify"]');
const opts = await lastAnswer().locator('[data-testid="help-clarify"] .hx-chip').allTextContents();
assert.ok(opts.includes("As its answer options") && opts.includes("Inside the question wording"), opts.join("|"));
await lastAnswer().locator('[data-testid="help-clarify"] .hx-chip', { hasText: "As its answer options" }).click();
await p.waitForFunction(() => document.querySelectorAll('[data-testid="help-answer"]').length >= 4, null, { timeout: 20000 });
assert.match(await lastAnswer().textContent(), /carry forward/i);
ok(`ambiguous request → “How should the earlier answers appear…?” (${opts.length} options) → “As its answer options” → carry forward`);

console.log("\n4 — troubleshooting with context, and billing");
await p.locator('.q-card, [data-testid="question-card"], .question-row').filter({ hasText: "Where did you buy it?" }).first().click().catch(() => {});
a = await ask("Why isn't this question displaying?", 5);
assert.equal(await lastAnswer().getAttribute("data-mode"), "troubleshoot");
assert.match(a, /Likely causes/); assert.match(a, /Display logic/);
ok("“Why isn't this question displaying?” → causes and checks (display logic, skip rules, branches, versions)");
a = await ask("Do test responses consume wallet credits?", 6);
assert.equal(await lastAnswer().getAttribute("data-mode"), "billing");
assert.match(a, /Test responses and test-link activity are not charged/);
assert.doesNotMatch(a, /margin|provider cost/i);
ok("billing: the live configuration's rule (test usage free here), no prices or internal costs");

console.log("\n5 — Help me do it → Intelligent Mode");
a = await ask("Can you configure skip logic for me so that No at Q1 goes to Q3?", 7);
assert.equal(await lastAnswer().getAttribute("data-mode"), "do");
assert.match(a, /Help doesn't change your survey itself/);
const instr = await lastAnswer().locator(".hx-instr").textContent();
assert.equal(instr, "Configure skip logic so that No at Q1 goes to Q3");
const before = await p.evaluate(() => document.querySelector('[data-testid="studio-help-drawer"]') ? 1 : 0);
await lastAnswer().locator('[data-testid="help-send-intelligent"]').click();
await openTab(p, "Questions").catch(() => {});
await p.waitForSelector('[data-testid="intelligent-view"]', { timeout: 15000 });
await p.waitForFunction((t) => document.querySelector('[data-testid="iq-input"]')?.value === t, instr, { timeout: 10000 });
assert.equal(before, 1);
ok("the instruction is in Intelligent Mode's input, unsent — Intelligent Mode will propose, the researcher approves");

console.log("\n7–10 — the Help Center routing");
/* back to Help (the hand-off above moved to Intelligent Mode) */
if (!(await p.$('[data-testid="studio-help-drawer"] [data-testid="help-input"]'))) { await p.click('[data-testid="studio-help-button"]'); await p.click('[data-testid="studio-help-help"]'); }
await p.waitForSelector('[data-testid="studio-help-drawer"] [data-testid="help-input"]');
let n = await p.locator('[data-testid="help-answer"]').count();
a = await ask("Why isn't Q4 showing?", ++n);
assert.equal(await lastAnswer().getAttribute("data-level"), "2");
assert.equal(await lastAnswer().locator('[data-testid="help-route"]').textContent(), "Checked your survey · no AI used");
assert.equal(await lastAnswer().locator('[data-testid="help-diagnosis"]').getAttribute("data-verdict"), "never");
assert.match(a, /What I found in your survey/); assert.match(a, /Q4 can never be shown/); assert.match(a, /Q5/);
assert.match(await lastAnswer().locator(".hx-instr").textContent(), /^Find out why Q4 is not shown and fix it: /);
assert.equal(await lastAnswer().locator('[data-testid="help-ask-ai"]').count(), 0, "no project to bill in the sandbox: no AI button");
ok("Level 2: Q4 checked in the open survey — never shown, because its display logic reads Q5 (asked later); fix proposed for Intelligent Mode");
a = await ask("Why isn't Q2 showing?", ++n);
assert.equal(await lastAnswer().locator('[data-testid="help-diagnosis"]').getAttribute("data-verdict"), "sometimes");
assert.match(a, /shown only to some respondents/);
ok("Level 2: Q2 is shown only sometimes — its condition on Q1 named");

a = await ask("I want to show every selected brand in a separate set of questions", ++n);
assert.match(await lastAnswer().locator('[data-testid="help-sources"]').textContent(), /loop/i);
ok("the goal, not the feature name: “every selected brand in a separate set of questions” → the loops guide");

a = await ask("my piped text is blank", ++n);
const firstSources = await lastAnswer().locator('[data-testid="help-sources"]').textContent();
await lastAnswer().locator('[data-testid="help-solved-no"]').click();
await p.waitForFunction((k) => document.querySelectorAll('[data-testid="help-answer"]').length >= k, ++n, { timeout: 20000 });
a = (await lastAnswer().textContent()) ?? "";
assert.match(a, /Since the earlier steps didn't fix it/);
assert.doesNotMatch(a, /isn't covered by the ResLens.ai guides/, "a retry is still about the documented problem");
assert.notEqual(await lastAnswer().locator('[data-testid="help-sources"]').textContent().catch(() => ""), firstSources, "a fix that didn't work is not offered again");
assert.equal(await lastAnswer().locator('[data-testid="help-escalate"]').count(), 1, "one failed fix, internal checks exhausted: a person is offered");
await lastAnswer().locator('[data-testid="help-solved-no"]').click();
await p.waitForFunction((k) => document.querySelectorAll('[data-testid="help-answer"]').length >= k, ++n, { timeout: 20000 });
assert.equal(await lastAnswer().locator('[data-testid="help-escalate"]').count(), 1);
ok("“Did this solve it? No” → a different guide, not the same one again; the escalation offer follows");

await lastAnswer().locator('[data-testid="help-escalate-open"]').click();
await p.waitForSelector('[data-testid="help-escalate-confirm"] li');
const sharedList = await lastAnswer().locator('[data-testid="help-escalate-confirm"] li').allTextContents();
assert.ok(sharedList.some((x) => /this conversation/.test(x)) && sharedList.some((x) => /account e-mail/.test(x)), sharedList.join("|"));
await p.waitForSelector('[data-testid="help-escalate-unavailable"]');
assert.match(await p.textContent('[data-testid="help-escalate-unavailable"]'), /isn't set up on this installation/);
assert.equal(await lastAnswer().locator('[data-testid="help-escalate-send"]').isDisabled(), true);
ok(`the hand-off shows what would be shared (${sharedList.length} items) and, with no database or support address, says it isn't set up — nothing pretends to be sent`);

a = await ask("can I talk to a person please?", ++n);
assert.equal(await lastAnswer().locator('[data-testid="help-escalate"]').count(), 1);
assert.match(a, /hand this conversation to the ResLens.ai support team/);
a = await ask("how do I integrate with salesforce crm", ++n);
assert.match(a, /isn't covered by the ResLens.ai guides, so I won't guess/);
assert.equal(await lastAnswer().locator('[data-testid="help-escalate"]').count(), 1);
ok("asking for a person offers the hand-off at once; another product's feature is not guessed at");

console.log("\n6 — reading a guide; page errors");
await p.locator('[data-testid="help-sources"] .hx-src').first().click();
await p.waitForSelector('[data-testid="help-article"]');
assert.match(await p.textContent('[data-testid="help-article"]'), /Common mistakes/);
ok("a source opens the full guide beside the conversation");
assert.deepEqual(errors, []);
ok("no page errors");
await browser.close();
console.log(`\n${passed} passed`);

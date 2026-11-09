import { test } from "node:test";
import assert from "node:assert/strict";
import { DEFAULT_BILLING_CONFIG, DEFAULT_BILLABLE_EVENTS, billingConfig } from "@rescript/billing";
import { helpKnowledge } from "./kb.ts";
import { guidesAnswer, readModelAnswer, contextText, safeHref, helpPrompt } from "./compose.ts";
import { billingFacts } from "./billingFacts.ts";
import { clarificationFor } from "./intent.ts";

const { index } = helpKnowledge();
const article = (id: string) => index.chunks.filter((c) => c.article === id);

test("the guides' own answer: the steps, with sources and follow-ups", () => {
  const a = guidesAnswer({ mode: "guide", question: "show Q5 only if Q2 yes", article: article("display-logic"), others: [{ title: "Skip logic", ask: "Skip questions based on an answer (skip logic)" }], clarify: null, billingFacts: null, instruction: null });
  assert.match(a.answer, /\*\*How to set it up\*\*/);
  assert.match(a.answer, /\*\*Add logic\*\*/);
  assert.equal(a.origin, "guides");
  assert.ok(a.sources.every((s) => s.id.startsWith("display-logic#")) && a.sources.length >= 2);
  assert.deepEqual(a.followUps, ["Skip questions based on an answer (skip logic)"]);
  assert.equal(a.intelligent, null);
});

test("a do-it-for-me request is handed to Intelligent Mode, never claimed as done", () => {
  const a = guidesAnswer({ mode: "do", question: "Can you configure skip logic for me?", article: article("skip-logic"), others: [], clarify: null, billingFacts: null, instruction: "Configure skip logic" });
  assert.match(a.answer, /Help doesn't change your survey itself/);
  assert.deepEqual(a.intelligent, { instruction: "Configure skip logic" });
});

test("troubleshooting leads with causes and checks", () => {
  const a = guidesAnswer({ mode: "troubleshoot", question: "piping blank", article: article("troubleshoot-piping-blank"), others: [], clarify: null, billingFacts: null, instruction: null });
  assert.ok(a.answer.indexOf("Likely causes") < a.answer.indexOf("What to check"));
});

test("an ambiguous request with no clear guide returns the clarifying question", () => {
  const c = clarificationFor("I want to show respondents only the brands they selected in an earlier question")!;
  const a = guidesAnswer({ mode: "guide", question: "x", article: null, others: [], clarify: c, billingFacts: null, instruction: null });
  assert.equal(a.answer, c.question);
  assert.equal(a.clarify?.options.length, 4);
});

test("nothing found: says so instead of guessing", () => {
  const a = guidesAnswer({ mode: "guide", question: "zzz", article: null, others: [], clarify: null, billingFacts: null, instruction: null });
  assert.match(a.answer, /won't guess/);
});

test("the model's answer: only known sources, no claimed changes, no prices", () => {
  const chunks = article("display-logic");
  const r = readModelAnswer({ answer: "I've configured display logic on Q5.", sources: [chunks[0].id, "made-up#x"], follow_ups: ["What about two conditions?"], clarify: null, intelligent_instruction: null }, { mode: "do", chunks, instruction: "Show Q5 only if Q2 = Yes" })!;
  assert.deepEqual(r.sources.map((s) => s.id), [chunks[0].id]);
  assert.doesNotMatch(r.answer, /I've configured/);
  assert.match(r.note!, /Nothing in your survey was changed/);
  assert.deepEqual(r.intelligent, { instruction: "Show Q5 only if Q2 = Yes" });
  const p = readModelAnswer({ answer: "Each response costs $0.50 per complete.", sources: [], follow_ups: [], clarify: null, intelligent_instruction: null }, { mode: "billing", chunks, instruction: null })!;
  assert.match(p.note!, /Prices are not quoted/);
  assert.equal(readModelAnswer({ answer: "" }, { mode: "guide", chunks, instruction: null }), null);
});

test("billing facts: the live rules, never margins, costs or rates", () => {
  const f = billingFacts(DEFAULT_BILLING_CONFIG, DEFAULT_BILLABLE_EVENTS, { balance: 12.5, reserved: 0.25, state: "active", level: "low" });
  assert.match(f, /Test responses and test-link activity are not charged/);
  assert.match(f, /read-only/);
  assert.match(f, /12\.50 USD balance/);
  assert.doesNotMatch(f, /margin|provider cost|processor|tax|infrastructure cost|markup/i);
  const metered = billingFacts(billingConfig({ testUsagePolicy: "discounted", testUsageDiscountPct: 30, overdraftEnabled: true, overdraftLimit: 10 }), DEFAULT_BILLABLE_EVENTS);
  assert.match(metered, /30% discount/);
  assert.match(metered, /Overdraft is on/);
});

test("context, prompt and links", () => {
  const t = contextText({ surface: "studio", tabLabel: "Questions", mode: "studio", survey: { title: "Car study", questions: 12 }, question: { code: "Q12", type: "single_select", text: "Which brand?", displayLogic: "Q3 = 1" } });
  assert.match(t, /Selected question: Q12/); assert.match(t, /Display logic: Q3 = 1/);
  const p = helpPrompt({ question: "Why isn't Q12 showing?", mode: "troubleshoot", chunks: article("troubleshoot-question-not-showing"), history: [{ role: "user", text: "hi" }], context: t, billingFacts: null });
  assert.match(p, /SOURCES:\n\[troubleshoot-question-not-showing#/); assert.match(p, /CONTEXT:\nThe user is in the Studio/);
  assert.equal(safeHref("javascript:alert(1)"), "#"); assert.equal(safeHref("//evil.example"), "#");
  assert.equal(safeHref("/help?article=piping"), "/help?article=piping"); assert.equal(safeHref("https://example.com"), "https://example.com");
});

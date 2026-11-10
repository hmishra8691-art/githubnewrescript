import { test } from "node:test";
import assert from "node:assert/strict";
import { draftTicket, sharedSummary, ticketReference, ticketText } from "./escalation.ts";
import { helpUsage } from "./usage.ts";

const turns = [
  { role: "user" as const, content: { text: "why isn't Q3 showing" } },
  { role: "assistant" as const, content: { answer: "Q3 can never be shown…", sources: [{ title: "Question not showing", heading: "Likely causes" }], route: { level: 2, reason: "your survey was checked", modelUsed: false, cached: false }, diagnosis: { summary: "Q3 can never be shown", findings: [{ severity: "blocking", message: "reads Q4, which comes after it" }] }, charge: 0 } },
  { role: "user" as const, content: { text: "still not showing" } },
  { role: "assistant" as const, content: { answer: "Other causes…", sources: [], route: { level: 3, reason: "the earlier steps didn't fix it", modelUsed: true, cached: false }, charge: 0.002, escalate: { offer: true, reason: "x" }, solved: false } },
];

test("a ticket carries the conversation, the steps tried and the latest survey check", () => {
  const d = draftTicket(turns, { reason: "you asked for a person" });
  assert.equal(d.subject, "why isn't Q3 showing");
  assert.equal(d.transcript.length, 4);
  assert.deepEqual(d.attempts.map((a) => [a.level, a.modelUsed]), [[2, false], [3, true]]);
  assert.deepEqual(d.attempts[0].sources, ["Question not showing — Likely causes"]);
  assert.equal((d.diagnostics as { summary: string }).summary, "Q3 can never be shown");
  const text = ticketText({ reference: "HLP-ABCDEFGH", draft: d, userEmail: "a@b.c", message: "urgent", context: { tab: "questions" }, surveyId: null });
  assert.match(text, /Help escalation HLP-ABCDEFGH/);
  assert.match(text, /Why escalated: you asked for a person/);
  assert.match(text, /\[blocking\] reads Q4/);
  assert.match(text, /2\. AI: the earlier steps didn't fix it/);
  assert.match(text, /USER: still not showing/);
});

test("the reference is readable and the user is told exactly what is shared", () => {
  const r = ticketReference();
  assert.match(r, /^HLP-[A-HJ-NP-Z2-9]{8}$/);
  const s = sharedSummary({ turns: 4, hasDiagnostics: true, attempts: 2, hasContext: false });
  assert.equal(s[0], "this conversation (4 messages)");
  assert.ok(s.includes("what the checks of your survey found"));
  assert.ok(!s.some((x) => /Studio tab/.test(x)));
});

test("usage: answers per level, model calls, cache hits, charge, feedback", () => {
  const u = helpUsage([
    { content: { route: { level: 1, modelUsed: false } } },
    { content: { route: { level: 2, modelUsed: false }, diagnosis: {}, solved: true } },
    { content: { route: { level: 3, modelUsed: true }, charge: 0.002, escalate: { offer: true } } },
    { content: { route: { level: 3, modelUsed: false, cached: true } } },
    { content: { origin: "model", charge: 0.001 } },
  ]);
  assert.deepEqual(u.byLevel, { 1: 1, 2: 1, 3: 2, unrouted: 1 });
  assert.equal(u.modelCalls, 2);
  assert.equal(u.cacheHits, 1);
  assert.equal(u.internalShare, 60);
  assert.equal(u.charge, 0.003);
  assert.equal(u.escalationsOffered, 1);
  assert.deepEqual(u.solved, { yes: 1, no: 0 });
  assert.equal(u.diagnosed, 1);
});

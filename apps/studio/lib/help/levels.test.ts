import { test } from "node:test";
import assert from "node:assert/strict";
import { SurveyDefinition } from "@rescript/schema";
import { helpKnowledge } from "./kb.ts";
import { categoryFor, search, topArticles } from "./search.ts";
import { helpMode } from "./intent.ts";
import { retrievalConfidence } from "./confidence.ts";
import { problemThread, stillFailing, wantsHuman } from "./attempts.ts";
import { diagnoseSurvey, diagnosisText, featureFor, targetQuestion } from "./diagnostics.ts";
import { cacheClear, cacheGet, cacheKey, cachePut, cacheStats } from "./cache.ts";
import { routeHelp, type RouteInput } from "./levels.ts";

const { index } = helpKnowledge();
const conf = (q: string) => { const m = helpMode(q); const top = topArticles(search(index, q, { limit: 12, ...categoryFor(m, q) }), 3); return { top, c: retrievalConfidence(index, q, top[0]) }; };

/* ------------------------------------------------------------------ confidence */

test("confidence: a documented feature is high, a near miss medium, another product's feature out of domain", () => {
  assert.equal(conf("How do I show Q5 only if Q2 is yes?").c.level, "high");
  assert.equal(conf("how do I set up a conjoint study").c.level, "high");
  assert.equal(conf("my piping is blank").c.level, "high");
  const q12 = conf("why isn't Q12 showing").c;
  assert.equal(q12.domain, "in");
  assert.notEqual(q12.level, "high");
  for (const q of ["what is the capital of france", "how do I integrate with salesforce crm", "purple elephant banana"]) {
    const c = conf(q).c;
    assert.equal(c.domain, "out", q);
    assert.equal(c.level, "low", q);
  }
  assert.ok(conf("how do I integrate with salesforce crm").c.unknown.includes("salesforc"));
});

test("the brand example: every selected brand in its own set of questions → the loops guide", () => {
  const { top, c } = conf("I want to show every selected brand in a separate set of questions");
  assert.equal(top[0].article, "loops");
  assert.notEqual(c.level, "low");
});

/* ------------------------------------------------------------------ attempts */

test("still failing, wanting a person, and the problem thread", () => {
  assert.ok(stillFailing("it's still blank"));
  assert.ok(stillFailing("that didn't work"));
  assert.ok(stillFailing("same problem"));
  assert.ok(!stillFailing("my piping doesn't work"), "a fresh report is not a retry");
  assert.ok(!stillFailing("how do I add a loop"));
  assert.ok(wantsHuman("can I talk to a person?"));
  assert.ok(wantsHuman("please open a support ticket"));
  assert.ok(!wantsHuman("how do I invite a person to my project"));

  const history = [
    { role: "user" as const, text: "my piping is blank" },
    { role: "assistant" as const, text: "…", sources: ["troubleshoot-piping-blank#likely-causes"], level: 2 },
    { role: "user" as const, text: "still blank" },
    { role: "assistant" as const, text: "…", sources: ["piping#how-to"], level: 1 },
  ];
  const t = problemThread("that didn't work either", history);
  assert.equal(t.origin, "my piping is blank");
  assert.equal(t.failedAttempts, 2);
  assert.deepEqual(t.tried.sort(), ["piping", "troubleshoot-piping-blank"]);
  assert.deepEqual(t.levels.sort(), [1, 2]);
  assert.equal(problemThread("how do quotas work", history).origin, null);
  assert.equal(problemThread("still blank", []).origin, null, "nothing to go back to");
});

/* ------------------------------------------------------------------ diagnostics on the user's survey */

const yn = [{ code: 1, label: "Yes" }, { code: 2, label: "No" }];
const make = () => SurveyDefinition.parse({
  meta: { id: "s", code: "S", title: "T" },
  questions: [
    { id: "q1", code: "Q1", variableName: "Q1", type: "single_select", text: "Own a car?", options: yn },
    { id: "q2", code: "Q2", variableName: "Q2", type: "open_text", text: "You said {{Q1}} — and {{Q77}}?" },
    { id: "q3", code: "Q3", variableName: "Q3", type: "open_text", text: "Why?", displayLogic: { type: "rule", source: { kind: "question", ref: "q4" }, operator: "answered" } },
    { id: "q4", code: "Q4", variableName: "Q4", type: "open_text", text: "Anything else?" },
  ],
  flow: [
    { type: "page", id: "p1", questionIds: ["q1"] },
    { type: "page", id: "p2", questionIds: ["q2"] },
    { type: "page", id: "p3", questionIds: ["q3"] },
    { type: "page", id: "p4", questionIds: ["q4"] },
    { type: "end", id: "e", status: "complete" },
  ],
  deployment: { clientSlug: "c", studySlug: "s" },
});

test("feature and target: words decide the check, a named code or the selected question the target", () => {
  assert.equal(featureFor("my piping is blank"), "piping");
  assert.equal(featureFor("why isn't Q3 showing"), "visibility");
  assert.equal(featureFor("the loop repeats the wrong items"), "loop");
  assert.equal(featureFor("respondents can't continue past Q4"), "validation");
  assert.equal(featureFor("how do quotas work"), null);
  const def = make();
  assert.equal(targetQuestion(def, "why isn't q3 showing")?.id, "q3");
  assert.equal(targetQuestion(def, "why isn't it showing", "Q4")?.id, "q4");
  assert.equal(targetQuestion(def, "why isn't Q99 showing"), null);
});

test("not showing: the engine's diagnosis, with a verdict and a fix for Intelligent Mode", () => {
  const d = diagnoseSurvey(make(), "why isn't Q3 showing?")!;
  assert.equal(d.feature, "visibility");
  assert.equal(d.target?.code, "Q3");
  assert.equal(d.verdict, "never");
  assert.ok(d.findings.some((f) => /Q4/.test(f.message)));
  assert.match(d.fix ?? "", /^Find out why Q3 is not shown and fix it: /);
  assert.match(diagnosisText(d), /\*\*What I found in your survey\*\*/);
  const ok = diagnoseSurvey(make(), "why isn't Q4 showing?")!;
  assert.equal(ok.verdict, "always");
  assert.equal(ok.fix, null);
  assert.match(ok.summary, /shown to every respondent/);
});

test("piping: unknown references are found in the question named", () => {
  const d = diagnoseSurvey(make(), "the piping in Q2 shows blank")!;
  assert.equal(d.feature, "piping");
  assert.ok(d.findings.some((f) => /Q2: Unknown piping reference "Q77"/.test(f.message)), JSON.stringify(d.findings));
  assert.match(d.fix ?? "", /Fix the piping problem/);
  const clean = diagnoseSurvey(make(), "piping blank in Q1")!;
  assert.equal(clean.findings.length, 0);
  assert.match(clean.summary, /nothing wrong/);
});

test("no feature words, or nothing to look at: no diagnosis", () => {
  assert.equal(diagnoseSurvey(make(), "how do I export to SPSS"), null);
  assert.equal(diagnoseSurvey(make(), "why isn't my question showing"), null, "no question named or selected");
});

/* ------------------------------------------------------------------ cache */

test("cache: same question and sources hit, another account or other sources miss, entries expire", () => {
  cacheClear();
  const k = cacheKey({ scope: "cust-a", question: "How do quotas work?", mode: "guide", sources: ["quotas#a", "quotas#b"], context: "" });
  assert.equal(cacheGet(k), null);
  cachePut(k, { answer: "x" });
  assert.deepEqual(cacheGet(cacheKey({ scope: "cust-a", question: "how do quotas work", mode: "guide", sources: ["quotas#b", "quotas#a"], context: "" })), { answer: "x" });
  assert.equal(cacheGet(cacheKey({ scope: "cust-b", question: "How do quotas work?", mode: "guide", sources: ["quotas#a", "quotas#b"], context: "" })), null);
  assert.equal(cacheGet(cacheKey({ scope: "cust-a", question: "How do quotas work?", mode: "guide", sources: ["quotas#a"], context: "" })), null);
  assert.equal(cacheGet(k, Date.now() + 7 * 3600_000), null);
  assert.equal(cacheStats().hits, 1);
});

/* ------------------------------------------------------------------ routing */

const base = (o: Partial<RouteInput> = {}): RouteInput => ({
  mode: "guide", confidence: { score: 0.9, level: "high", domain: "in", strength: 1, coverage: 0.8, unknown: [] },
  clarifying: false, diagnosis: null, thread: { origin: null, failedAttempts: 0, tried: [], levels: [] },
  wantsHuman: false, forceAi: false, modelAllowed: true, substantive: true, ...o,
});
const low = { score: 0.4, level: "low" as const, domain: "in" as const, strength: 0.2, coverage: 0.6, unknown: [] };
const out = { score: 0.1, level: "low" as const, domain: "out" as const, strength: 0, coverage: 0.1, unknown: ["salesforc"] };

test("routing: internal by default, the model only when it adds something", () => {
  assert.equal(routeHelp(base()).level, 1, "a well-covered question never calls the model, even when one is available");
  assert.equal(routeHelp(base({ mode: "do" })).level, 1);
  assert.equal(routeHelp(base({ mode: "billing", confidence: low })).level, 1);
  assert.equal(routeHelp(base({ clarifying: true, confidence: low })).level, 1);
  assert.equal(routeHelp(base({ confidence: low })).level, 3);
  assert.equal(routeHelp(base({ confidence: low, modelAllowed: false })).level, 1);
  assert.equal(routeHelp(base({ confidence: low, substantive: false })).level, 1);
  assert.equal(routeHelp(base({ confidence: out })).level, 1, "out of domain: say so, don't let the model invent");
  assert.equal(routeHelp(base({ forceAi: true })).level, 3);
  assert.equal(routeHelp(base({ forceAi: true, modelAllowed: false })).level, 1);
});

test("routing: a survey diagnosis is Level 2; a retry with nothing found goes to the model once", () => {
  const d = diagnoseSurvey(make(), "why isn't Q3 showing?")!;
  assert.equal(routeHelp(base({ mode: "troubleshoot", diagnosis: d })).level, 2);
  const clean = diagnoseSurvey(make(), "piping blank in Q1")!;
  assert.equal(routeHelp(base({ mode: "troubleshoot", diagnosis: clean })).level, 2);
  const retry = { origin: "piping blank in Q1", failedAttempts: 1, tried: ["troubleshoot-piping-blank"], levels: [2] };
  assert.equal(routeHelp(base({ mode: "troubleshoot", diagnosis: clean, thread: retry })).level, 3);
  assert.equal(routeHelp(base({ mode: "troubleshoot", diagnosis: clean, thread: { ...retry, levels: [2, 3] } })).level, 2, "the model has already tried");
});

test("escalation is offered, not forced, when it should be", () => {
  assert.equal(routeHelp(base()).escalate.offer, false);
  assert.equal(routeHelp(base({ wantsHuman: true })).escalate.reason, "you asked for a person");
  assert.equal(routeHelp(base({ confidence: out })).escalate.offer, true);
  assert.equal(routeHelp(base({ confidence: low, modelAllowed: false })).escalate.offer, true);
  assert.equal(routeHelp(base({ thread: { origin: "x", failedAttempts: 2, tried: [], levels: [1, 3] } })).escalate.reason, "this has survived more than one fix");
  assert.equal(routeHelp(base({ mode: "billing", confidence: out })).escalate.offer, false);
});

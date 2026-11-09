import { test } from "node:test";
import assert from "node:assert/strict";
import { helpKnowledge } from "./kb.ts";
import { search, topArticles, isFollowUp, tokenize, expandQuery, categoryFor } from "./search.ts";
import { helpMode, clarificationFor, intelligentInstruction } from "./intent.ts";

const { index, articles } = helpKnowledge();
const best = (q: string, topic?: string[]) => topArticles(search(index, q, { limit: 12, topic, followUp: topic ? isFollowUp(q) : false, ...categoryFor(helpMode(q), q) }), 3).map((a) => a.article);

test("the knowledge base holds guides, generated articles and the documentation", () => {
  const kinds = new Set([...articles.values()].map((a) => a.kind));
  assert.deepEqual([...kinds].sort(), ["doc", "generated", "guide"]);
  assert.ok(articles.has("studio-map") && articles.has("quality-rules") && articles.has("methodologies"));
  const map = articles.get("studio-map")!;
  assert.ok(map.sections.some((s) => /\*\*Programming\*\* → \*\*Quotas\*\*/.test(s.body)), "the Studio map comes from the real menu");
  assert.ok(index.chunks.length > 200);
});

/* the spec's own example questions — in the user's words, not the feature's name */
const CASES: [string, string][] = [
  ["How do I apply skip logic to a question?", "skip-logic"],
  ["How can I show a question only when someone selects a particular answer?", "display-logic"],
  ["I want to show Question 5 only when someone selects Yes in Question 2", "display-logic"],
  ["How does automatic piping work?", "piping"],
  ["How can I create a MaxDiff study?", "maxdiff"],
  ["How do I configure quotas?", "quotas"],
  ["Why are my survey responses not appearing in the results?", "troubleshoot-responses-missing"],
  ["How does the wallet deduct credits?", "wallet"],
  ["How can I create a cross-tabulation?", "analytics-crosstab"],
  ["How do I create a cross-tab between gender and brand preference?", "analytics-crosstab"],
  ["How do I deploy a new survey version?", "deploy-versions"],
  ["If they select No, I want to skip the next five questions", "skip-logic"],
  ["My piped text is appearing blank", "troubleshoot-piping-blank"],
  ["My quota is not filling correctly", "troubleshoot-quota-not-filling"],
  ["My JavaScript is not executing", "troubleshoot-script-not-running"],
  ["My wallet credits are being deducted unexpectedly", "troubleshoot-unexpected-charges"],
  ["My survey deployment failed", "troubleshoot-deploy-failed"],
  ["Do test responses consume wallet credits?", "billing-test-vs-live"],
  ["How do I create my first survey?", "create-survey"],
  ["How do I use Intelligent Mode?", "intelligent-mode"],
  ["How do I generate a Conjoint design?", "conjoint"],
  ["How do I monitor live responses?", "fieldwork"],
  ["How do I manage collaborators and permissions?", "collaborators-permissions"],
  ["How do I change the colours and logo of my survey?", "branding"],
  ["How do I set up an interview guide with probes?", "qualitative"],
  ["How do I repeat the same questions for each brand they use?", "loops"],
  ["How do I compare this wave with the last one?", "wave-tracker"],
  ["How do I remove speeders and straightliners?", "data-quality"],
  ["Which method should I use to find the right price?", "choose-a-method"],
  ["How do I export to SPSS?", "data-exports"],
];

test("the right guide for each example question", () => {
  const wrong: string[] = [];
  for (const [q, want] of CASES) { const got = best(q); if (got[0] !== want) wrong.push(`“${q}” → ${got.join(", ")} (wanted ${want})`); }
  assert.deepEqual(wrong, []);
});

test("a follow-up stays on the topic of the conversation", () => {
  assert.ok(isFollowUp("What if I want to apply two conditions?"));
  const near = [...new Set(["display-logic"].flatMap((id) => articles.get(id)?.related ?? []))];
  const got = topArticles(search(index, "What if I want to apply two conditions?", { limit: 12, topic: ["display-logic"], near, followUp: true }), 3).map((a) => a.article);
  assert.ok(got.slice(0, 2).includes("conditions-and-or"), got.join(","));
  assert.ok(!isFollowUp("How do I configure quotas for a nested gender by age design across three regions?"));
});

test("modes: guide, do, troubleshoot, billing", () => {
  assert.equal(helpMode("How do I configure display logic?"), "guide");
  assert.equal(helpMode("Can you configure skip logic for me?"), "do");
  assert.equal(helpMode("Set up a quota of 50% women for me"), "do");
  assert.equal(helpMode("My skip logic is not working"), "troubleshoot");
  assert.equal(helpMode("Why isn't Q12 displaying?"), "troubleshoot");
  assert.equal(helpMode("How does the wallet deduct credits?"), "billing");
  assert.equal(helpMode("How do I add a price attribute to my conjoint?"), "guide");
  assert.equal(intelligentInstruction("Can you please configure skip logic on Q1 so No goes to Q7 for me?"), "Configure skip logic on Q1 so No goes to Q7");
  assert.equal(intelligentInstruction("Can you configure skip logic for me so that No at Q1 goes to Q3?"), "Configure skip logic so that No at Q1 goes to Q3");
});

test("ambiguous requests get a clarifying question", () => {
  const c = clarificationFor("I want to show respondents only the brands they selected in an earlier question");
  assert.ok(c && c.options.length >= 3);
  assert.equal(clarificationFor("How do I carry forward the brands they selected?"), null, "naming the feature decides it");
});

test("everyday words reach the platform's vocabulary", () => {
  assert.match(expandQuery("show Q5 only if they said yes"), /display logic/);
  assert.deepEqual(tokenize("Quotas piped skipping pipe"), ["quota", "pip", "skip", "pip"]);
});

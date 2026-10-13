import test from "node:test";
import assert from "node:assert/strict";
import { checkSentence, claimProblem, claimsBrief, printedNumbers, sentenceLabel, numberForms, type Claim } from "./claims.js";
import { gateNarrative } from "./narrative.js";

/**
 * THE EVALUATION SET (audit A-1; the NIST "Measure" function in the strategy).
 *
 * Claims with known answers, and sentences a model might write about them,
 * each with the verdict a careful reader would give. The rates asserted at the
 * end are the release criteria: no sentence with a wrong number, a swapped
 * direction, an invented quotation, a causal verb or an overclaim may pass
 * (numeric fidelity and overclaiming rate: zero), and no faithful sentence in
 * the set may be refused (the checker must not make the narrative useless).
 */

const claim = (o: Partial<Claim> & { id: string }): Claim => ({ kind: "other", text: "", source: {}, groups: [], significant: null, label: "observed", numbers: [], corpus: "", ...o });
const nums = (...xs: (number | null)[]) => [...new Set(xs.flatMap((x) => numberForms(x)))];

const C0 = claim({ id: "C0", kind: "run", text: "412 completes.", numbers: nums(412, 3, 2), corpus: "" });
/* women 3.86 vs men 3.07, adjusted p .021, moderate effect */
const C1 = claim({
  id: "C1", kind: "comparison", text: "Overall satisfaction is higher among women (3.86) than men (3.07), p = 0.021, d = 0.52.",
  groups: [{ label: "Women", value: 3.86, n: 210 }, { label: "Men", value: 3.07, n: 202 }], significant: true, strength: "moderate", label: "statistically supported",
  numbers: nums(3.86, 3.07, 0.021, 0.52, 210, 202, 412), corpus: "overall satisfaction women men",
});
/* three regions, no difference */
const C2 = claim({
  id: "C2", kind: "comparison", text: "Satisfaction does not differ by region (p = 0.171).",
  groups: [{ label: "North", value: 3.5 }, { label: "South", value: 3.4 }, { label: "East", value: 3.6 }], significant: false, strength: "none", label: "observed",
  numbers: nums(3.5, 3.4, 3.6, 0.171, 412), corpus: "satisfaction region north south east",
});
/* a negative, weak correlation */
const C3 = claim({
  id: "C3", kind: "association", text: "Waiting time and satisfaction move in opposite directions (r = -0.18, p = 0.004).", sign: "negative", significant: true, strength: "weak", label: "statistically supported",
  numbers: nums(-0.18, 0.18, 0.004, 412), corpus: "waiting time satisfaction",
});
const C4 = claim({ id: "C4", kind: "verdict", text: "H1: women are more satisfied. Supported.", label: "hypothesis", numbers: [], corpus: "women are more satisfied", verdict: { label: "H1", verdict: "supported" } });
const claims = [C0, C1, C2, C3, C4];
const verdicts = [{ label: "H1", verdict: "supported" }, { label: "H2", verdict: "not_supported" }, { label: "H3", verdict: "untested" }];

interface Case { text: string; cites: string[]; ok: boolean; why?: RegExp; group: string }
const CASES: Case[] = [
  /* faithful: every one must pass */
  { group: "good", ok: true, cites: ["C1"], text: "Women score 3.86 against 3.07 for men." },
  { group: "good", ok: true, cites: ["C1"], text: "Women are more satisfied than men (3.86 against 3.07, p = 0.021)." },
  { group: "good", ok: true, cites: ["C1"], text: "Men score lower than women on overall satisfaction." },
  { group: "good", ok: true, cites: ["C1"], text: "The gap is moderate in size (d = 0.52) and statistically significant." },
  { group: "good", ok: true, cites: ["C1"], text: "Of 412 respondents, 210 were women and 202 men." },
  { group: "good", ok: true, cites: ["C2"], text: "Satisfaction does not differ significantly by region (p = 0.171)." },
  { group: "good", ok: true, cites: ["C2"], text: "The regions are not statistically different, so no regional action is indicated." },
  { group: "good", ok: true, cites: ["C3"], text: "Longer waits go with lower satisfaction, a weak negative relationship (r = -0.18)." },
  { group: "good", ok: true, cites: ["C3"], text: "The relationship is negative and weak." },
  { group: "good", ok: true, cites: ["C1", "C4"], text: "H1 is supported: women are more satisfied." },
  { group: "good", ok: true, cites: [], text: "Women score 3.86 against 3.07 for men." },
  { group: "good", ok: true, cites: [], text: "Consider a follow-up on why men rate satisfaction lower." },
  { group: "good", ok: true, cites: ["C3"], text: "Follow up on what drives the gap in satisfaction." },
  { group: "good", ok: true, cites: ["C3"], text: "Test whether waiting time causes the lower scores." },
  /* numbers */
  { group: "number", ok: false, cites: ["C1"], why: /number 4\.2/, text: "Women score 4.2 on satisfaction." },
  { group: "number", ok: false, cites: ["C1"], why: /number 5/, text: "Five of the 5 segments favour women." },
  { group: "number", ok: false, cites: ["C1"], why: /number 7/, text: "Seven regions were compared." },
  { group: "number", ok: false, cites: ["C1"], why: /number 2031/, text: "By 2031 the gap will widen." },
  { group: "number", ok: false, cites: ["C1"], why: /number 3\.5/, text: "Women score 3.5, near the North region." },
  { group: "number", ok: false, cites: ["C2"], why: /number 3\.86/, text: "Satisfaction is 3.86 in the North." },
  { group: "number", ok: false, cites: [], why: /number 99/, text: "Satisfaction is 99 for women." },
  /* swapped direction and swapped values */
  { group: "swap", ok: false, cites: ["C1"], why: /printed against/, text: "Women score 3.07 against 3.86 for men." },
  { group: "swap", ok: false, cites: ["C1"], why: /printed against/, text: "Men score 3.86 and women 3.07." },
  { group: "swap", ok: false, cites: ["C1"], why: /higher|lower/, text: "Men are more satisfied than women." },
  { group: "swap", ok: false, cites: ["C1"], why: /higher|lower/, text: "Women score lower than men." },
  { group: "swap", ok: false, cites: ["C1"], why: /higher|lower/, text: "Women trail men on satisfaction." },
  { group: "swap", ok: false, cites: ["C3"], why: /negative, not positive/, text: "Satisfaction rises as waiting time rises: a positive relationship (r = -0.18)." },
  { group: "swap", ok: false, cites: [], why: /printed against|higher|lower/, text: "Men outscore women: 3.86 for men." },
  /* causal wording */
  { group: "cause", ok: false, cites: ["C1"], why: /causal/, text: "Being a woman leads to higher satisfaction." },
  { group: "cause", ok: false, cites: ["C3"], why: /causal/, text: "Waiting time causes lower satisfaction." },
  { group: "cause", ok: false, cites: ["C3"], why: /causal/, text: "Satisfaction is down because of long waits." },
  { group: "cause", ok: false, cites: [], why: /causal/, text: "Cutting the wait will drive satisfaction up." },
  { group: "cause", ok: false, cites: ["C3"], why: /causal/, text: "Long waits drive the gap in satisfaction." },
  { group: "cause", ok: false, cites: ["C3"], why: /causal/, text: "We know what drives it, and waiting time causes lower scores." },
  /* overclaiming */
  { group: "overclaim", ok: false, cites: ["C2"], why: /not significant/, text: "Regions differ significantly in satisfaction." },
  { group: "overclaim", ok: false, cites: ["C3"], why: /strong-effect/, text: "There is a strong link between waiting and satisfaction." },
  { group: "overclaim", ok: false, cites: ["C1"], why: /strong-effect/, text: "Women are dramatically more satisfied than men." },
  { group: "overclaim", ok: false, cites: ["C2"], why: /large-effect|strong-effect/, text: "There is a substantial regional pattern." },
  { group: "overclaim", ok: false, cites: ["C1"], why: /proof/, text: "The data prove that women are more satisfied." },
  /* invented quotations */
  { group: "quote", ok: false, cites: ["C1"], why: /quotation/, text: "As one woman put it, \"I love the new service\"." },
  { group: "quote", ok: false, cites: ["C3"], why: /quotation/, text: "Respondents called the wait “unbearable”." },
  { group: "quote", ok: true, cites: ["C1"], text: "The measure is \"overall satisfaction\"." },
  /* citations and hypotheses */
  { group: "cite", ok: false, cites: ["C9"], why: /C9 is not a claim/, text: "Women score 3.86." },
  { group: "cite", ok: false, cites: ["C2"], why: /number 3\.86/, text: "Women score 3.86." },
  { group: "hyp", ok: false, cites: ["C4"], why: /H3 is untested/, text: "H3 is confirmed by the data." },
  { group: "hyp", ok: false, cites: ["C4"], why: /H1 is supported, not rejected/, text: "H1 was rejected." },
  { group: "hyp", ok: false, cites: ["C4"], why: /H9 is not a hypothesis/, text: "H9 is supported." },
];

test("evaluation set: each sentence gets the verdict a careful reader gives it", () => {
  for (const c of CASES) {
    const r = checkSentence(c.text, claims, c.cites, verdicts);
    if (c.ok) assert.equal(r.problem, null, `should pass: ${c.text} → ${r.problem}`);
    else { assert.ok(r.problem, `should fail: ${c.text}`); if (c.why) assert.match(r.problem!, c.why, c.text); }
  }
});

test("evaluation set: numeric fidelity and overclaiming are zero, and no faithful sentence is refused", () => {
  const bad = CASES.filter((c) => !c.ok), good = CASES.filter((c) => c.ok);
  const accepted = bad.filter((c) => checkSentence(c.text, claims, c.cites, verdicts).problem === null);
  assert.deepEqual(accepted.map((c) => c.text), [], "a bad sentence passed");
  const refused = good.filter((c) => checkSentence(c.text, claims, c.cites, verdicts).problem !== null);
  assert.deepEqual(refused.map((c) => c.text), [], "a faithful sentence was refused");
  const groups = new Set(bad.map((c) => c.group));
  for (const g of ["number", "swap", "cause", "overclaim", "quote", "cite", "hyp"]) assert.ok(groups.has(g), `the set covers ${g}`);
  assert.ok(CASES.length >= 40);
});

test("no whole number and no year is exempt; identifiers are names, not numbers", () => {
  assert.deepEqual(printedNumbers("H1 and Q3 and S2a, 2nd wave, 18-34 year olds, 1,200 people and 26.6% of 5."), ["18", "34", "1200", "26.6", "5"]);
  for (const n of ["0", "1", "5", "10", "2026"]) assert.equal(claimProblem(`It was ${n}.`, [C1]), `the number ${n} is not in the cited claim`, n);
  assert.equal(claimProblem("It was 210.", [C1]), null);
});

test("a number beside a group is held to that group, with the nearest group deciding", () => {
  assert.equal(claimProblem("Women score 3.86 against 3.07 for men.", [C1]), null);
  assert.match(claimProblem("Women score 3.07 against 3.86 for men.", [C1])!, /3\.07 is printed against Women/);
  assert.equal(claimProblem("Satisfaction was 3.86 for women, versus 3.07 for men.", [C1]), null);
  assert.equal(claimProblem("Women (3.86) versus men (3.07).", [C1]), null);
  assert.match(claimProblem("Women (3.07) versus men (3.86).", [C1])!, /printed against/);
  assert.equal(claimProblem("Among the women, 210 answered; 202 men did.", [C1]), null, "a base is not a mean");
  /* 'men' inside 'women' is not a mention of men */
  assert.equal(claimProblem("Women score 3.86.", [C1]), null);
});

test("comparatives are read against the values, for two groups and for three", () => {
  assert.equal(claimProblem("East scores higher than South.", [C2]), null);
  assert.match(claimProblem("South scores higher than East.", [C2])!, /South is lower than East/);
  assert.equal(claimProblem("North scores more than South.", [C2]), null);
  assert.equal(claimProblem("North scores lower than East.", [C2]), null);
  assert.match(claimProblem("North scores higher than East.", [C2])!, /North is lower than East/);
});

test("labels follow the claims: statistically supported, exploratory, hypothesis, recommendation", () => {
  assert.equal(sentenceLabel([C1], "summary"), "statistically supported");
  assert.equal(sentenceLabel([C2], "summary"), "observed");
  assert.equal(sentenceLabel([C4], "implications"), "hypothesis");
  assert.equal(sentenceLabel([C1], "recommendations"), "recommendation");
  assert.equal(sentenceLabel([claim({ id: "C5", label: "exploratory" }), C1], "summary"), "exploratory");
  assert.equal(sentenceLabel([C0], "summary"), "observed", "the run alone is just a count");
});

test("a sentence with no cited id is bound to ONE claim that holds all its numbers — not to the run at large", () => {
  /* 3.07 is C1's and 3.4 is C2's: each is in the run, no single claim holds both */
  const r = checkSentence("Women score 3.07 and the South 3.4.", claims, [], verdicts);
  assert.match(r.problem ?? "", /do not come from one result|not in/);
  assert.equal(checkSentence("Women score 3.86 against 3.07 for men.", claims, [], verdicts).claims[0].id, "C1");
  /* a finding's number beside the run's own count is two claims, and allowed */
  assert.equal(checkSentence("Women score 3.86 among the 412 respondents.", claims, [], verdicts).problem, null);
});

test("the model sees ids and the engine's own sentences, never tables", () => {
  const b = claimsBrief(claims);
  assert.match(b, /^\[C1\] Overall satisfaction is higher among women/m);
  assert.match(b, /\[C2\] \(not significant\) Satisfaction does not differ/);
  assert.ok(!/C0/.test(b));
});

test("gateNarrative with claims: a failing sentence that cites a claim is replaced by the engine's wording and marked; a recommendation is dropped", () => {
  const run = { n: 412, findings: [], verdicts: [], warnings: [] } as unknown as Parameters<typeof gateNarrative>[0];
  const g = gateNarrative(run, {
    headline: { claims: ["C1"], text: "Women score 3.07 against 3.86 for men." },
    summary: [{ claims: ["C1"], text: "Women score 3.86 against 3.07 for men." }, { claims: ["C3"], text: "Waits cause dissatisfaction." }],
    recommendations: [{ claims: [], text: "Cut waits by 40%." }, { claims: [], text: "Review the waiting process." }],
  }, { claims });
  assert.equal(g.offered, 5);
  assert.equal(g.replaced, 2);
  assert.equal(g.accepted.headline, C1.text, "the swapped headline is the engine's own sentence now");
  assert.deepEqual(g.accepted.summary, ["Women score 3.86 against 3.07 for men.", C3.text]);
  assert.deepEqual(g.accepted.recommendations, ["Review the waiting process."]);
  assert.deepEqual(g.sentences.map((s) => [s.section, s.source, s.label]), [
    ["headline", "template", "statistically supported"], ["summary", "model", "statistically supported"], ["summary", "template", "statistically supported"], ["recommendations", "model", "recommendation"],
  ]);
  assert.deepEqual(g.rejected.map((r) => r.section), ["headline", "summary", "recommendations"]);
});

test("a figure written in words is still a figure", () => {
  assert.deepEqual(printedNumbers("Seven of twenty-one, a hundred in all, and one of them."), ["7", "21", "100"]);
  assert.match(claimProblem("Seven regions were compared.", [C1])!, /number 7/);
  assert.match(claimProblem("Twenty-one men answered.", [C1])!, /number 21/);
  assert.equal(claimProblem("One group scores higher.", [C1]), null, "'one' alone is a pronoun");
});

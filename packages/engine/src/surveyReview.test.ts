import { test } from "node:test";
import assert from "node:assert/strict";
import { SurveyDefinition } from "@rescript/schema";
import { reviewSurvey, rangeOf } from "./surveyReview.js";
import { applySurveyActions } from "./surveyActions.js";

let n = 0;
const ids = (p: string) => `${p}_${++n}`;
const empty = () => SurveyDefinition.parse({ meta: { id: "s", code: "S", title: "T" }, questions: [], flow: [{ type: "end", id: "e", status: "complete" }], deployment: { clientSlug: "c", studySlug: "s" } });
const build = (actions: Parameters<typeof applySurveyActions>[1]) => { const r = applySurveyActions(empty(), actions, { ids }); assert.deepEqual(r.errors, [], r.errors.join("\n")); return r.def; };

test("ranges: the shapes answer options are written in", () => {
  assert.deepEqual(rangeOf("18-24"), { lo: 18, hi: 24, int: true });
  assert.deepEqual(rangeOf("25 – 34 years"), { lo: 25, hi: 34, int: true });
  assert.deepEqual(rangeOf("65+"), { lo: 65, hi: Infinity, int: true });
  assert.deepEqual(rangeOf("Under 18"), { lo: -Infinity, hi: 17, int: true });
  assert.deepEqual(rangeOf("$50,000 to $99,999"), { lo: 50000, hi: 99999, int: true });
  assert.equal(rangeOf("Instagram"), null);
});

test("review: what is broken is critical, what degrades the data is a warning, what is worth a look is a suggestion", () => {
  const def = build([
    { op: "set_research", objective: "o", hypotheses: ["exposure → intent"], population: "Adults 18–35", constructs: [{ name: "Exposure", role: "independent", questions: ["EXP"] }, { name: "Trust", role: "dependent" }, { name: "Intent", role: "dependent", questions: ["INT"] }] },
    { op: "create_block", title: "Demographics" },
    { op: "create_question", ref: "AGE", type: "single", text: "What is your age?", options: ["18-24", "24-34", "36-44", "45+"] },
    { op: "create_block", title: "Media" },
    { op: "create_question", ref: "EXP", type: "rating", text: "Don't you agree that influencers are great?", scale: { points: 5 } },
    { op: "create_question", ref: "EXP2", type: "rating", text: "How satisfied are you with the price and quality?", scale: { points: 7 } },
    { op: "create_question", ref: "PLAT", type: "multi", text: "Which platforms do you use?", options: ["Instagram", "TikTok", "YouTube", "Snapchat"] },
    { op: "create_question", ref: "PLAT2", type: "multi", text: "Which social platforms do you use?", options: ["Instagram", "TikTok"] },
    { op: "create_question", ref: "INT", type: "rating", text: "How likely are you to buy?", scale: { points: 5 } },
    { op: "create_question", ref: "WHY", type: "long_text", text: "Why?", required: true },
    { op: "set_display_logic", target: "EXP", expression: "INT answered" },
  ]);
  const r = reviewSurvey(def);
  const has = (sev: string, re: RegExp) => r.findings.some((f) => f.severity === sev && re.test(f.message));
  // critical
  assert.ok(has("critical", /Q2 can never be shown: .*reads Q6, which comes after it/), JSON.stringify(r.findings.map((f) => [f.severity, f.message]), null, 1));
  assert.ok(has("critical", /dependent variable “Trust” is not measured by any question, so the hypothesis cannot be tested/));
  // warnings
  assert.ok(has("warning", /Q2 may be leading/));
  assert.ok(has("warning", /“18-24” and “24-34” overlap/));
  assert.ok(has("warning", /nothing between “24-34” and “36-44” — 35 has no answer/));
  assert.ok(has("warning", /mixes 5-point and 7-point scales \(Q2, Q3, Q6\)/));
  assert.ok(has("warning", /Q4 and Q5 look like the same question/));
  // suggestions
  assert.ok(has("suggestion", /Q3 may be double-barreled: it asks about “price” and “quality”/));
  assert.ok(has("suggestion", /Q4 has no “None of these” or “Other”/));
  assert.ok(has("suggestion", /Q7 is a required open end/));
  assert.ok(has("suggestion", /Nothing screens respondents out, but the target population is “Adults 18–35”/));
  assert.ok(has("suggestion", /“Intent” \(the dependent variable\) is measured by a single item/));
  assert.ok(!has("suggestion", /Demographics come first/), "two blocks is too few to call it a sequencing problem");
  // order and counts
  const sev = r.findings.map((f) => f.severity);
  assert.deepEqual(sev, [...sev].sort((a, b) => ["critical", "warning", "suggestion"].indexOf(a) - ["critical", "warning", "suggestion"].indexOf(b)));
  assert.equal(r.counts.critical + r.counts.warning + r.counts.suggestion, r.findings.length);
  // fixes are offered as actions, and they apply
  const fix = r.findings.find((f) => /Q4 has no “None/.test(f.message))!.fix!;
  const fixed = applySurveyActions(def, fix, { ids });
  assert.deepEqual(fixed.errors, []);
  assert.ok(!reviewSurvey(fixed.def).findings.some((f) => /Q4 has no “None/.test(f.message)));
  assert.ok(r.findings.every((f) => f.questionIds.every((id) => def.questions.some((q) => q.id === id))), "every finding links to real questions");
});

test("a clean, short survey has nothing critical and no warnings", () => {
  const def = build([
    { op: "create_block", title: "Screening" },
    { op: "create_question", ref: "BUY", type: "yes_no", text: "Have you bought skincare in the last six months?" },
    { op: "add_skip", from: "BUY", when: "BUY = No", to: "screen_out" },
    { op: "create_block", title: "Experience" },
    { op: "create_question", type: "rating", text: "Overall, how satisfied are you with the products you bought?", scale: { points: 5, low: "Very dissatisfied", high: "Very satisfied" } },
    { op: "create_question", type: "nps", text: "How likely are you to recommend the brand to a friend?" },
  ]);
  const r = reviewSurvey(def);
  assert.equal(r.counts.critical, 0, JSON.stringify(r.findings));
  assert.equal(r.counts.warning, 0, JSON.stringify(r.findings));
  assert.ok(r.minutes < 2);
});

test("questions that differ only by what they pipe are not duplicates", () => {
  const def = build([
    { op: "create_block", title: "Brands" },
    { op: "create_question", type: "rating", text: "Thinking about {{BRAND_1}}, how satisfied are you overall?", scale: { points: 5 } },
    { op: "create_question", type: "rating", text: "Thinking about {{BRAND_2}}, how satisfied are you overall?", scale: { points: 5 } },
  ]);
  assert.ok(!reviewSurvey(def).findings.some((f) => f.category === "duplicates"));
});

test("a list with consecutive codes is not a scale unless its labels read as one", () => {
  const def = build([
    { op: "create_block", title: "Profile" },
    { op: "create_question", type: "single", text: "What is your role?", options: ["Buyer", "User", "Influencer"] },
    { op: "create_question", type: "rating", text: "How satisfied are you?", scale: { points: 5, low: "Very dissatisfied", high: "Very satisfied" } },
    { op: "create_question", type: "rating", text: "How likely is it?", scale: { points: 7, low: "Very unlikely", high: "Very likely" } },
  ]);
  const mixed = reviewSurvey(def).findings.filter((f) => f.category === "scales");
  assert.equal(mixed.length, 1);
  assert.match(mixed[0].message, /mixes 5-point and 7-point scales \(Q2, Q3\)/, "the role list is not counted as a 3-point scale");
});

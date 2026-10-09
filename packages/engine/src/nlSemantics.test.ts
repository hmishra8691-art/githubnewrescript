import { test } from "node:test";
import assert from "node:assert/strict";
import { SurveyDefinition } from "@rescript/schema";
import { parseScale, resolveConcept, resolvePopulation, resolveRole, scaleLabels } from "./nlSemantics.js";
import { conditionFromText } from "./naturalCondition.js";

/*
 * SEMANTIC RESOLUTION (Research Engine audit, Phase 2) against the audit's
 * brand-switching fixture: a population phrase becomes a question and a
 * condition the logic language accepts; a concept becomes the variable that
 * measures it; a structural role becomes the questions in it; a scale
 * description becomes points and anchors.
 */
const opts = (...ls: string[]) => ls.map((l, i) => ({ code: i + 1, label: l }));
function survey(over: Record<string, unknown> = {}): SurveyDefinition {
  return SurveyDefinition.parse({
    meta: { id: "s", code: "SW", title: "Brand switching" },
    research: { objective: "Why customers switch from Brand A to Brand B", hypotheses: ["Price perception drives switching"], constructs: [{ name: "Price perception", role: "independent", questionIds: ["q6"] }], analysis: [], assumptions: [], sources: [] },
    questions: [
      { id: "q1", code: "Q1", variableName: "AGE", type: "numeric", text: "How old are you?" },
      { id: "q2", code: "Q2", variableName: "GENDER", type: "single_select", text: "What is your gender?", options: opts("Male", "Female", "Prefer not to say") },
      { id: "q3", code: "Q3", variableName: "BRAND_PREF", type: "single_select", text: "Which brand do you prefer?", options: opts("Brand A", "Brand B", "Brand C") },
      { id: "q4", code: "Q4", variableName: "SWITCHED", type: "single_select", text: "Have you switched brands in the last 12 months?", options: opts("Yes", "No") },
      { id: "q5", code: "Q5", variableName: "REASONS", type: "multi_select", text: "Why did you switch?", options: opts("Price", "Quality", "Availability") },
      { id: "q6", code: "Q6", variableName: "PRICE_PERC", type: "single_select", text: "Brand B offers better value for money", options: opts("Strongly disagree", "Disagree", "Neither", "Agree", "Strongly agree") },
      { id: "q7", code: "Q7", variableName: "SAT", type: "single_select", text: "Overall, how satisfied are you with your current brand?", options: opts("1", "2", "3", "4", "5", "6", "7") },
      { id: "q8", code: "Q8", variableName: "PETS", type: "single_select", text: "Do you have pets?", options: opts("Yes", "No") },
      { id: "q9", code: "Q9", variableName: "REGION", type: "single_select", text: "Which region do you live in?", options: opts("North", "South") },
      { id: "q10", code: "Q10", variableName: "COMMENTS", type: "open_text", text: "Anything else?" },
    ],
    flow: [
      { type: "block", id: "b1", title: "Screener", children: [{ type: "page", id: "p1", title: "Screener", questionIds: ["q1", "q2"] }] },
      { type: "block", id: "b2", title: "Brands", children: [{ type: "page", id: "p2", title: "Brands", questionIds: ["q3", "q4", "q5", "q6", "q7"] }] },
      { type: "block", id: "b3", title: "About you", children: [{ type: "page", id: "p3", title: "About you", questionIds: ["q8", "q9", "q10"] }] },
      { type: "end", id: "e", status: "complete" },
    ],
    ...over,
  });
}
const expr = (def: SurveyDefinition, e: string) => { const c = conditionFromText(def, e); assert.ok(!c.errors.length && c.condition, `${e}: ${JSON.stringify(c)}`); };

test("population: ages on a numeric age question, in the phrasings a researcher uses", () => {
  const def = survey();
  const cases: [string, string][] = [
    ["respondents under 25", "Q1 < 25"], ["people aged 18 to 24", "Q1 >= 18 AND Q1 <= 24"], ["anyone over 65", "Q1 > 65"],
    ["those 18+", "Q1 >= 18"], ["adults aged 18–65", "Q1 >= 18 AND Q1 <= 65"], ["under-25s", "Q1 < 25"], ["under 25", "Q1 < 25"],
    ["respondents who are younger than 18", "Q1 < 18"], ["people at least 21 years old", "Q1 >= 21"], ["customers between 25 and 34", "Q1 >= 25 AND Q1 <= 34"],
    ["people at most 30", "Q1 <= 30"],
  ];
  for (const [phrase, expression] of cases) {
    const r = resolvePopulation(def, phrase);
    assert.ok(r && r.ok, `${phrase}: ${JSON.stringify(r)}`);
    assert.equal(r.population.expression, expression, phrase);
    assert.equal(r.population.question.code, "Q1");
    assert.equal(r.population.via, "age");
    expr(def, r.population.expression);
  }
  assert.equal(resolvePopulation(def, "make the survey shorter"), null, "not a population");
  const either = resolvePopulation(def, "respondents under 25 and women");
  assert.ok(either?.ok && either.population.expression === "Q1 < 25 OR Q2 = 2", JSON.stringify(either));
  assert.match(either!.ok ? either!.population.words : "", /under 25, or .*Female/);
  expr(def, either!.ok ? either!.population.expression : "");
  assert.equal(resolvePopulation(def, "respondents under 25 and the moon"), null, "a part that is not a population is not one");
  assert.equal(resolvePopulation(def, "Q3"), null);
  const empty = resolvePopulation(def, "people aged 40 to 30");
  assert.ok(empty && !empty.ok && /empty range/.test(empty.reason));
});

test("population: age bands on a single-select — whole bands inside the range, a straddling band refused with the fix", () => {
  const def = survey({ questions: [
    { id: "q1", code: "Q1", variableName: "AGE", type: "single_select", text: "Which age group are you in?", options: opts("Under 18", "18-24", "25-34", "35-44", "45-54", "55-64", "65+") },
    { id: "q2", code: "Q2", variableName: "GENDER", type: "single_select", text: "What is your gender?", options: opts("Male", "Female") },
  ], flow: [{ type: "page", id: "p1", title: "p", questionIds: ["q1", "q2"] }, { type: "end", id: "e", status: "complete" }] });
  const under25 = resolvePopulation(def, "respondents under 25");
  assert.ok(under25?.ok);
  assert.equal(under25.population.expression, "Q1 in [1, 2]");
  assert.match(under25.population.words, /“Under 18”, “18-24”/);
  expr(def, under25.population.expression);
  const over65 = resolvePopulation(def, "people over 64");
  assert.ok(over65?.ok);
  assert.equal(over65.population.expression, "Q1 = 7");
  const straddle = resolvePopulation(def, "people under 30");
  assert.ok(straddle && !straddle.ok);
  assert.match(straddle.reason, /“25-34” straddles under 30/);
  assert.match(straddle.reason, /screen on “Under 18”, “18-24”/);
});

test("population: no age question says so; two age questions offer the alternative", () => {
  const none = survey({ questions: [{ id: "q2", code: "Q2", variableName: "GENDER", type: "single_select", text: "Gender?", options: opts("Male", "Female") }], flow: [{ type: "page", id: "p1", title: "p", questionIds: ["q2"] }, { type: "end", id: "e", status: "complete" }] });
  const r = resolvePopulation(none, "respondents under 25");
  assert.ok(r && !r.ok && /no question that asks it/.test(r.reason));
  const raw = JSON.parse(JSON.stringify(survey()));
  raw.questions.push({ id: "q11", code: "Q11", variableName: "CHILD_AGE", type: "numeric", text: "How old is your eldest child?" });
  raw.flow[2].children[0].questionIds.push("q11");
  const two = SurveyDefinition.parse(raw);
  const r2 = resolvePopulation(two, "under 25");
  assert.ok(r2?.ok);
  assert.equal(r2.population.question.code, "Q1", "the first age question in the flow");
  assert.deepEqual(r2.population.alternatives?.map((q) => q.code), ["Q11"]);
});

test("population: gender, a yes/no verb phrase, and an option label carried by the phrase", () => {
  const def = survey();
  const women = resolvePopulation(def, "women");
  assert.ok(women?.ok && women.population.expression === "Q2 = 2" && women.population.via === "gender", JSON.stringify(women));
  const men = resolvePopulation(def, "male respondents");
  assert.ok(men?.ok && men.population.expression === "Q2 = 1");
  const who = resolvePopulation(def, "respondents who are female");
  assert.ok(who?.ok && who.population.expression === "Q2 = 2");
  const switched = resolvePopulation(def, "those who switched");
  assert.ok(switched?.ok && switched.population.expression === "Q4 = 1" && switched.population.via === "yes_no", JSON.stringify(switched));
  const notSwitched = resolvePopulation(def, "people who have not switched brands");
  assert.ok(notSwitched?.ok && notSwitched.population.expression === "Q4 = 2");
  const brandA = resolvePopulation(def, "Brand A users");
  assert.ok(brandA?.ok && brandA.population.expression === "Q3 = 1" && brandA.population.via === "option", JSON.stringify(brandA));
  const prefer = resolvePopulation(def, "those who prefer Brand B");
  assert.ok(prefer?.ok && prefer.population.expression === "Q3 = 2");
  const price = resolvePopulation(def, "people who switched because of price");
  // "switched … price": the yes/no reading needs every word; "price" is an option of Q5, so the option reading wins
  assert.ok(price?.ok && price.population.expression === "Q5 = 1", JSON.stringify(price));
  for (const r of [women, men, who, switched, notSwitched, brandA, prefer, price]) expr(def, r!.ok ? r!.population.expression : "");
});

test("concept: code and variable first, then the research design, then wording — ambiguity is said", () => {
  const def = survey();
  const byVar = resolveConcept(def, "BRAND_PREF");
  assert.ok(byVar.ok && byVar.question.code === "Q3" && byVar.via === "variable");
  const byCode = resolveConcept(def, "q7");
  assert.ok(byCode.ok && byCode.question.code === "Q7");
  const pref = resolveConcept(def, "brand preference");
  assert.ok(pref.ok && pref.question.code === "Q3" && pref.via === "wording", JSON.stringify(pref));
  const age = resolveConcept(def, "age");
  assert.ok(age.ok && age.question.code === "Q1", JSON.stringify(age));
  const priceP = resolveConcept(def, "price perception");
  assert.ok(priceP.ok && priceP.question.code === "Q6" && priceP.via === "construct", JSON.stringify(priceP));
  const sat = resolveConcept(def, "satisfaction");
  assert.ok(sat.ok && sat.question.code === "Q7");
  const sel = resolveConcept(def, "this question", { selectedId: "q4" });
  assert.ok(sel.ok && sel.question.code === "Q4" && sel.via === "selection");
  const none = resolveConcept(def, "shoe size");
  assert.ok(!none.ok && !none.ambiguous && /No question measures/.test(none.reason));
  // "brand": four questions carry the word and none carries more → ask
  const brand = resolveConcept(def, "brand");
  assert.ok(!brand.ok && brand.ambiguous, JSON.stringify(brand));
  assert.deepEqual(brand.candidates.map((c) => c.question.code).sort(), ["Q3", "Q4", "Q6", "Q7"]);
  const north = resolvePopulation(def, "those in the North");
  assert.ok(north?.ok && north.population.expression === "Q9 = 1", JSON.stringify(north));
  // two labels carried by the phrase: the longest is the one meant
  const raw = JSON.parse(JSON.stringify(def));
  raw.questions.push({ id: "q11", code: "Q11", variableName: "LINE", type: "single_select", text: "Which product line do you buy?", options: opts("Brand A", "Brand A Premium") });
  raw.flow[1].children[0].questionIds.push("q11");
  const lines = SurveyDefinition.parse(raw);
  const premium = resolvePopulation(lines, "Brand A Premium buyers");
  assert.ok(premium?.ok && premium.population.expression === "Q11 = 2", JSON.stringify(premium));
  const plainA = resolvePopulation(lines, "Brand A buyers");
  // both carry "Brand A"; the one whose wording shares the phrase's verb (buy) comes first, the other is offered
  assert.ok(plainA?.ok && plainA.population.expression === "Q11 = 1" && plainA.population.alternatives?.[0]?.code === "Q3", JSON.stringify(plainA));
  void north;
  assert.ok(north?.ok && north.population.expression === "Q9 = 1", JSON.stringify(north));
});

test("roles: the screener, the demographics, the selection, the whole survey, a block", () => {
  const def = survey();
  const scr = resolveRole(def, "the screener");
  assert.ok(scr && scr.role === "screener");
  assert.deepEqual(scr.questions.map((q) => q.code), ["Q1", "Q2"], scr.via);
  assert.match(scr.via, /block named like a screener/);
  const demo = resolveRole(def, "demographics");
  assert.ok(demo && demo.role === "demographics");
  assert.deepEqual(demo.questions.map((q) => q.code), ["Q1", "Q2", "Q8", "Q9"], `${demo.via} — the About-you block counts, its open text does not`);
  const sel = resolveRole(def, "this question", { selectedId: "q6" });
  assert.ok(sel && sel.questions[0].code === "Q6");
  const all = resolveRole(def, "the whole survey");
  assert.ok(all && all.questions.length === 10);
  const block = resolveRole(def, "the Brands section");
  assert.ok(block && block.questions.map((q) => q.code).join(",") === "Q3,Q4,Q5,Q6,Q7", JSON.stringify(block?.questions.map((q) => q.code)));
  assert.equal(resolveRole(def, "Q3"), null);
  // no screening role and no screener block: the first page stands in, and says so
  const plainDef = survey({ flow: [{ type: "page", id: "p1", title: "p", questionIds: ["q3", "q4"] }, { type: "page", id: "p2", title: "p2", questionIds: ["q1", "q2"] }, { type: "end", id: "e", status: "complete" }] });
  const stand = resolveRole(plainDef, "the screening questions");
  assert.ok(stand && stand.questions.map((q) => q.code).join(",") === "Q3,Q4" && /first page stands in/.test(stand.via));
});

test("scales: points, anchors and kinds from the researcher's words", () => {
  const five = parseScale("a 5-point scale");
  assert.ok(five && five.points === 5 && five.kind === "numeric" && !five.labels);
  assert.deepEqual(scaleLabels(five!), ["1", "2", "3", "4", "5"]);
  const agree = parseScale("5-point agree-disagree scale");
  assert.ok(agree && agree.kind === "agreement" && agree.points === 5);
  assert.deepEqual(agree!.labels, ["Strongly disagree", "Disagree", "Neither agree nor disagree", "Agree", "Strongly agree"]);
  const likert7 = parseScale("a seven point likert scale");
  assert.ok(likert7 && likert7.points === 7 && likert7.labels?.length === 7 && likert7.kind === "agreement");
  const likert = parseScale("likert scale");
  assert.ok(likert && likert.points === 5, "a Likert scale is 5 points unless told otherwise");
  const ten = parseScale("a scale of 1 to 10");
  assert.ok(ten && ten.points === 10 && ten.start === 1);
  const zeroTen = parseScale("0-10 scale where 0 = not at all, 10 = extremely");
  assert.ok(zeroTen && zeroTen.points === 11 && zeroTen.start === 0 && zeroTen.low === "not at all" && zeroTen.high === "extremely", JSON.stringify(zeroTen));
  assert.deepEqual(scaleLabels(zeroTen!).slice(0, 2), ["not at all", "1"]);
  const nps = parseScale("an NPS scale");
  assert.ok(nps && nps.points === 11 && nps.start === 0 && nps.kind === "nps");
  const yn = parseScale("yes/no");
  assert.deepEqual(yn?.labels, ["Yes", "No"]);
  const sat = parseScale("a 7-point satisfaction scale");
  assert.equal(sat?.labels?.[3], "Neither satisfied nor dissatisfied");
  const imp = parseScale("4-point importance scale");
  assert.ok(imp && imp.points === 4 && !imp.labels && imp.low === "Not at all important" && imp.high === "Extremely important");
  assert.equal(parseScale("a dropdown"), null);
  assert.equal(parseScale("a 1-point scale"), null);
  assert.equal(parseScale("a 20-point scale"), null);
});

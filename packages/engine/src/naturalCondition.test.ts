import { test } from "node:test";
import assert from "node:assert/strict";
import { SurveyDefinition } from "@rescript/schema";
import { conditionFromText, normaliseConditionText as n } from "./naturalCondition.js";
import { createResponseState } from "./state.js";
import { evaluateCondition } from "./evaluate.js";

/*
 * THE ONE NORMALISER: everyday condition words → the expression language,
 * shared by the Studio's grammar and the engine's sentence interpreter. The
 * first tests are the Studio's own `normaliseExpression` assertions, ported
 * (the connectives now print in capitals and "is not" is `!=`, the way the
 * expression editor prints them); then the comparators the Studio missed;
 * then the parse against a real survey, strict.
 */

const opts = (...ls: string[]) => ls.map((l, i) => ({ code: i + 1, label: l }));
const survey = () =>
  SurveyDefinition.parse({
    meta: { id: "s", code: "S", title: "Normaliser" },
    questions: [
      { id: "q_age", code: "Q1", variableName: "AGE", type: "numeric", text: "How old are you?" },
      { id: "q_type", code: "Q2", variableName: "TYPE", type: "single_select", text: "Type", options: [{ code: "A", label: "Consumer" }, { code: "B", label: "Business" }, { code: "C", label: "Small business" }] },
      { id: "q_car", code: "Q3", variableName: "CAR", type: "single_select", text: "Do you own a car?", options: opts("Yes", "No") },
      { id: "q_country", code: "Q4", variableName: "COUNTRY", type: "single_select", text: "Country", options: opts("Canada", "United States", "Mexico") },
      { id: "q_brands", code: "Q5", variableName: "BRANDS", type: "multi_select", text: "Brands", options: opts("Brand A", "Brand B", "Brand C") },
      { id: "q_gender", code: "Q7", variableName: "GENDER", type: "single_select", text: "Gender", options: opts("Male", "Female") },
      { id: "q_years", code: "Q9", variableName: "YEARS", type: "numeric", text: "Years" },
    ],
    flow: [{ type: "page", id: "p1", questionIds: ["q_age", "q_type", "q_car", "q_country", "q_brands", "q_gender", "q_years"] }, { type: "end", id: "e", status: "complete" }],
  });

const holds = (text: string, answers: Record<string, unknown>) => {
  const def = survey();
  const c = conditionFromText(def, text);
  assert.deepEqual(c.errors, [], text);
  const state = createResponseState(def, { seed: 1 });
  Object.assign(state.answers, answers);
  return evaluateCondition(c.condition, { def, state, loop: null });
};

test("the Studio's normaliseExpression behaviours, ported: operators, quoting, option numbers, connectives", () => {
  assert.equal(n("Q1 is at least 18 and Q3 was selected"), "Q1 >= 18 AND Q3 selected");
  assert.equal(n("Q1 is greater than 2 or Q2 isn't Business."), "Q1 > 2 OR Q2 != Business");
  assert.equal(n("the answer to Q3 equals Yes"), "Q3 = Yes");
  assert.equal(n("Q2 = A"), "Q2 = A", "already-canonical text is untouched");
  assert.equal(n("Q4 = United States and Q3 >= 18"), 'Q4 = "United States" AND Q3 >= 18', "a multi-word operand is quoted");
  assert.equal(n("Q2 is not Small business or Q1 > 2"), 'Q2 != "Small business" OR Q1 > 2');
  assert.equal(n('Q4 = "United States"'), 'Q4 = "United States"', "already quoted stays as it is");
  assert.equal(n("Q5 option 3 is selected"), 'Q5 = "option 3"');
  assert.equal(n("Q4 is option 2"), 'Q4 = "option 2"');
  assert.equal(n("Q3 is option 2"), 'Q3 = "option 2"');
  assert.equal(n("option 2 of Q3 is selected"), 'Q3 = "option 2"');
  assert.equal(n("neither Q3 = 1 nor Q3 = 2"), "NOT (Q3 = 1 OR Q3 = 2)");
});

test("the comparator words the Studio missed: over, under, older/younger than, N or more, N+, up to, exceeds, between, a bare is", () => {
  assert.equal(n("Q9 is over 25"), "Q9 > 25");
  assert.equal(n("Q7 is Male and Q9 is over 25"), "Q7 = Male AND Q9 > 25");
  assert.equal(n("Q9 is above 25"), "Q9 > 25");
  assert.equal(n("Q9 is more than 25"), "Q9 > 25");
  assert.equal(n("Q1 is older than 65"), "Q1 > 65");
  assert.equal(n("Q9 exceeds 5"), "Q9 > 5");
  assert.equal(n("Q9 is after 30"), "Q9 > 30", "after a NUMBER is greater than");
  assert.equal(n("Q1 is under 18"), "Q1 < 18");
  assert.equal(n("Q1 is below 18"), "Q1 < 18");
  assert.equal(n("Q1 is younger than 18"), "Q1 < 18");
  assert.equal(n("Q9 is fewer than 3"), "Q9 < 3");
  assert.equal(n("Q9 is before 30"), "Q9 < 30");
  assert.equal(n("Q1 is at least 18"), "Q1 >= 18");
  assert.equal(n("Q1 is no less than 18"), "Q1 >= 18", "the negated comparative is read whole, not as “less than”");
  assert.equal(n("Q9 is 25 or more"), "Q9 >= 25");
  assert.equal(n("Q1 is 18 and over"), "Q1 >= 18");
  assert.equal(n("Q9 is 25+"), "Q9 >= 25");
  assert.equal(n("Q9 is at most 10"), "Q9 <= 10");
  assert.equal(n("Q9 is no more than 10"), "Q9 <= 10");
  assert.equal(n("Q9 is 10 or less"), "Q9 <= 10");
  assert.equal(n("Q1 is 17 or younger"), "Q1 <= 17");
  assert.equal(n("Q9 is up to 10"), "Q9 <= 10");
  assert.equal(n("Q1 is between 18 and 30"), "Q1 between 18 and 30", "between keeps its own “and”: it is two operands, not a conjunction");
  assert.equal(n("Q1 is not between 18 and 30"), "Q1 not between 18 and 30");
  assert.equal(n("Q7 is not Male"), "Q7 != Male");
  assert.equal(n("Q7 isn't Male"), "Q7 != Male");
  assert.equal(n("Q7 is Female"), "Q7 = Female");
  // a date stays the parser's date operator; an operator the parser spells with "is" is left to it
  assert.equal(n("Q3 is after 2026-01-01"), "Q3 after 2026-01-01");
  assert.equal(n("Q3 is not empty"), "Q3 is not empty");
  assert.equal(n("Q1 is blank"), "Q1 unanswered");
});

test("lists of conditions: none of / any of / all of; quoted text is never rewritten", () => {
  assert.equal(n("none of Q3 = 1, Q4 = 1"), "NOT (Q3 = 1 OR Q4 = 1)", "NONE is the NOR the parser stores");
  assert.equal(n("none of Q3 = 1, Q4 = 1 or Q7 = 2"), "NOT (Q3 = 1 OR Q4 = 1 OR Q7 = 2)");
  assert.equal(n("any of Q3 = 1, Q4 = 2"), "Q3 = 1 OR Q4 = 2");
  assert.equal(n("all of Q3 = 1, Q4 = 2"), "Q3 = 1 AND Q4 = 2");
  assert.equal(n("Q3 = 1 nor Q4 = 1"), "Q3 = 1 NOR Q4 = 1", "NOR passes through as the parser's connective");
  assert.equal(n('Q2 = "is over the moon"'), 'Q2 = "is over the moon"', "a quoted value keeps every word");
  assert.equal(n("Q4 is “United States”"), 'Q4 = "United States"', "curly quotes become the straight ones the parser reads");
  assert.equal(n("Q5 is Brand A or Q5 is Brand B"), 'Q5 = "Brand A" OR Q5 = "Brand B"');
});

test("conditionFromText: normalised, parsed strictly against the survey, option labels read as their codes", () => {
  const def = survey();
  const c = conditionFromText(def, "Q7 is Male and Q9 is over 25");
  assert.deepEqual(c.errors, []);
  assert.equal(c.expression, "Q7 = Male AND Q9 > 25");
  assert.equal(c.canonical, "Q7 = 1 AND Q9 > 25", "Male is option 1 of Q7, stored as its code");
  assert.equal(conditionFromText(def, "Q3 is no").canonical, "Q3 = 2");
  assert.equal(conditionFromText(def, "Q1 is between 18 and 30").canonical, "Q1 between 18 and 30");
  // strict: a numeric question compared with a word is an error, not a literal that is never true
  const bad = conditionFromText(def, "Q1 is old");
  assert.equal(bad.condition, undefined);
  assert.match(bad.errors[0].message, /numeric/);
  assert.deepEqual(conditionFromText(def, 'Q1 = "old"', { strict: false }).errors, [], "non-strict: a quoted word is the literal text, as the expression editor has always read it");
  assert.match(conditionFromText(def, 'Q1 = "old"').errors[0].message, /numeric/, "strict (the default) refuses it");
  // a typo of a code comes back with the parser's corrected expression
  const typo = conditionFromText(def, "Q3 = Yess");
  assert.equal(typo.condition, undefined);
  assert.match(typo.errors[0].message, /did you mean Yes/);
  assert.equal(typo.errors[0].suggestion, "Q3 = Yes");
  // an option that is not there is refused with the options listed
  assert.match(conditionFromText(def, "Q7 is Unknown").errors[0].message, /option|Male/);
  assert.match(conditionFromText(def, "").errors[0].message, /empty/);
});

test("the normalised conditions mean what the words say", () => {
  assert.equal(holds("Q7 is Male and Q9 is over 25", { q_gender: 1, q_years: 30 }), true);
  assert.equal(holds("Q7 is Male and Q9 is over 25", { q_gender: 1, q_years: 25 }), false);
  assert.equal(holds("Q9 is 25 or more", { q_years: 25 }), true);
  assert.equal(holds("Q1 is under 18", { q_age: 17 }), true);
  assert.equal(holds("Q1 is between 18 and 30", { q_age: 31 }), false);
  assert.equal(holds("none of Q3 = 1, Q7 = 1", { q_car: 2, q_gender: 2 }), true);
  assert.equal(holds("none of Q3 = 1, Q7 = 1", { q_car: 2, q_gender: 1 }), false);
  assert.equal(holds("neither Q3 = 1 nor Q7 = 1", { q_car: 1, q_gender: 2 }), false);
  assert.equal(holds("Q7 is not Male", { q_gender: 2 }), true);
  assert.equal(holds("Q5 is Brand A or Q5 is Brand B", { q_brands: [2] }), true);
});

/* mutation-checked: each assertion below fails if the rewrite it names is weakened */
test("but not / except exclude; or-equal-to keeps the equality; neither of / both of are lists; one item is not a list; is not in", () => {
  assert.equal(n("Q3 = 1 but not Q7 = 2"), "Q3 = 1 AND NOT Q7 = 2", "“but not” excludes");
  assert.equal(n("Q3 = 1 except when Q7 = 2"), "Q3 = 1 AND NOT (Q7 = 2)", "“except when” excludes");
  assert.equal(holds("Q3 = 1 but not Q7 = 2", { q_car: 1, q_gender: 2 }), false);
  assert.equal(holds("Q3 = 1 except when Q7 = 2", { q_car: 1, q_gender: 1 }), true);
  assert.equal(n("Q1 is greater than or equal to 18"), "Q1 >= 18");
  assert.equal(n("Q1 is less than or equal to 18"), "Q1 <= 18");
  assert.equal(n("neither of Q3 = 1, Q7 = 1"), "NOT (Q3 = 1 OR Q7 = 1)", "NEITHER OF is the NOR, like NONE OF");
  assert.equal(n("both of Q3 = 1, Q7 = 1"), "Q3 = 1 AND Q7 = 1", "BOTH OF joins with AND, like ALL OF");
  assert.equal(n("none of Q3 = 1"), "none of Q3 = 1", "one item is not a list: it is left for the parser to refuse");
  assert.equal(n("Q4 is not in (1, 2)"), "Q4 not in (1, 2)");
});

test("conditionFromText: when a rewrite breaks an expression that was already correct, the typed text wins", () => {
  // the variable OVER reads as the comparator “over”: normalised it is “> > 3”, which does not parse
  const def = SurveyDefinition.parse({
    meta: { id: "s", code: "S", title: "Raw" },
    questions: [{ id: "q_over", code: "Q1", variableName: "OVER", type: "numeric", text: "Hours over budget" }],
    flow: [{ type: "page", id: "p1", questionIds: ["q_over"] }, { type: "end", id: "e", status: "complete" }],
  });
  assert.equal(n("OVER > 3"), "> > 3");
  const c = conditionFromText(def, "OVER > 3");
  assert.deepEqual(c.errors, []);
  assert.equal(c.expression, "OVER > 3");
  assert.equal(c.canonical, "Q1 > 3");
});

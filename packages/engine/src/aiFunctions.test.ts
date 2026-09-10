import { test } from "node:test";
import assert from "node:assert/strict";
import { SurveyDefinition } from "@rescript/schema";
import {
  parseAiCall, isServerResolvedExpression, mentionsAiFunction,
  serverResolvedQuestions, lintAiCalls, lintCalculations,
  pickCategory, pickSentiment, fakeClassify, fakeSentiment,
  createResponseState, setAnswer, runCalculations, validateExpression,
} from "./index.js";

/**
 * AI-DERIVED VARIABLES — the pure half (aiFunctions.ts).
 *
 * The provider call lives in the runtime app and is tested against a fake
 * provider in the browser suite. What is proven here is everything the engine
 * decides without a network: what counts as an AI expression, that the
 * browser leaves such a variable alone, that the names are known to the calc
 * grammar, and that lint refuses the one shape the design forbids.
 */

test("THE GRAMMAR IS EXACTLY ONE SHAPE — an AI call, and nothing around it", () => {
  assert.deepEqual(parseAiCall('ai_classify(Q5, "Price|Quality|Service|Other")'),
    { fn: "ai_classify", sourceRef: "Q5", categories: ["Price", "Quality", "Service", "Other"] });
  assert.deepEqual(parseAiCall("ai_sentiment(Q5)"), { fn: "ai_sentiment", sourceRef: "Q5" });
  assert.deepEqual(parseAiCall("  ai_sentiment( VERBATIM )  "), { fn: "ai_sentiment", sourceRef: "VERBATIM" }, "whitespace and variable names are fine");
  assert.deepEqual(parseAiCall('ai_classify(Q5, " Price | Quality ")')?.categories, ["Price", "Quality"], "categories are trimmed");

  assert.equal(parseAiCall('if(ai_sentiment(Q5) = "negative", 1, 0)'), null, "nested is NOT the shape");
  assert.equal(parseAiCall("ai_sentiment(Q5) + 1"), null);
  assert.equal(parseAiCall("upper(Q5)"), null);
  assert.equal(parseAiCall(""), null);
  assert.equal(parseAiCall(undefined), null);
});

test("server-resolved is decided by the whole expression, mentions by any occurrence", () => {
  assert.equal(isServerResolvedExpression("ai_sentiment(Q5)"), true);
  assert.equal(isServerResolvedExpression('if(ai_sentiment(Q5) = "negative", 1, 0)'), false);
  assert.equal(mentionsAiFunction('if(ai_sentiment(Q5) = "negative", 1, 0)'), true, "…but lint can still see it");
  assert.equal(mentionsAiFunction("sum(Q1, Q2)"), false);
});

const def = (calcExpr: string, extra: Record<string, unknown> = {}) => SurveyDefinition.parse({
  meta: { id: "s1", code: "S1", title: "AI", version: "1.0" },
  questions: [
    { id: "q5", code: "Q5", variableName: "VERBATIM", type: "long_text", text: "Why?" },
    { id: "q9", code: "Q9", variableName: "NUM", type: "numeric", text: "How many?" },
    { id: "qa", code: "Q5_CAT", variableName: "Q5_CAT", type: "calculated", text: "", settings: { expression: calcExpr, ...extra } },
  ],
  flow: [{ type: "page", id: "p1", questionIds: ["q5", "q9"] }, { type: "end", id: "e1", status: "complete" }],
});

test("THE BROWSER LEAVES A SERVER-RESOLVED VARIABLE ALONE — whatever the server wrote survives every trigger", () => {
  /*
   * The whole feature rests on this. runCalculations runs on every change,
   * every page submit and completion. If it recomputed an AI variable it would
   * produce null (no provider here) and erase the classification the save
   * route had just stored.
   */
  const d = def('ai_classify(Q5, "Price|Quality|Other")');
  const state = createResponseState(d, { seed: 1 });
  setAnswer(d, state, "q5", "It was far too expensive for what you get");
  state.answers.qa = "Price"; // as the save route would have written it
  runCalculations(d, state, "on_change");
  runCalculations(d, state, "on_page_submit");
  runCalculations(d, state, "on_complete");
  assert.equal(state.answers.qa, "Price", "kept through every trigger");

  // and an ORDINARY calculated question is still computed exactly as before
  const plain = def("NUM * 2");
  const s2 = createResponseState(plain, { seed: 1 });
  setAnswer(plain, s2, "q9", 21);
  runCalculations(plain, s2, "on_change");
  assert.equal(s2.answers.qa, 42, "non-AI calculations are untouched by this change");
});

test("the function names are known to the calc grammar — the expression editor accepts them, lint does not call them variables", () => {
  assert.equal(validateExpression("ai_sentiment(Q5)"), null, "parses as a valid expression");
  assert.equal(validateExpression('ai_classify(Q5, "a|b")'), null);
});

test("serverResolvedQuestions finds each AI calculation with its source resolved by code, variable or id", () => {
  const byCode = serverResolvedQuestions(def("ai_sentiment(Q5)"));
  assert.equal(byCode.length, 1);
  assert.equal(byCode[0].source?.id, "q5");
  assert.equal(serverResolvedQuestions(def("ai_sentiment(VERBATIM)"))[0].source?.id, "q5", "by variable name");
  assert.equal(serverResolvedQuestions(def("ai_sentiment(q5)"))[0].source?.id, "q5", "by id");
  assert.equal(serverResolvedQuestions(def("NUM * 2")).length, 0, "an ordinary calculation is not one");
});

test("LINT REFUSES THE ONE FORBIDDEN SHAPE, and says what to do instead", () => {
  const problems = lintAiCalls(def('if(ai_sentiment(Q5) = "negative", 1, 0)'));
  assert.equal(problems.length, 1);
  assert.match(problems[0], /must be the whole expression/);
  assert.match(problems[0], /own calculated question/, "the fix is named, not just the fault");
});

test("lint catches a missing source, a non-text source, too few categories and a duplicate category", () => {
  assert.match(lintAiCalls(def("ai_sentiment(Q77)"))[0], /Q77, which is not a question/);
  assert.match(lintAiCalls(def("ai_sentiment(Q9)"))[0], /Q9, which is numeric, not an open end/);
  assert.match(lintAiCalls(def('ai_classify(Q5, "Only")'))[0], /at least two categories/);
  assert.match(lintAiCalls(def('ai_classify(Q5, "A|B|A")'))[0], /lists “A” twice/);
  assert.deepEqual(lintAiCalls(def('ai_classify(Q5, "A|B")')), [], "a well-formed call lints silently");
});

test("AI problems appear in the ordinary calculations lint — one list, not a second one", () => {
  const all = lintCalculations(def("ai_sentiment(Q77)"));
  assert.ok(all.some((p) => /Q77, which is not a question/.test(p)));
});

test("pickCategory returns the programmer's label VERBATIM, tolerates case, never invents", () => {
  const cats = ["Price", "Quality", "Other"];
  assert.equal(pickCategory("Price", cats), "Price");
  assert.equal(pickCategory("quality", cats), "Quality", "case-insensitive match returns the programmer's spelling");
  assert.equal(pickCategory(" other ", cats), "Other");
  assert.equal(pickCategory("Pricing", cats), null, "a near-miss is null, not the closest");
  assert.equal(pickCategory(42, cats), null);
  assert.equal(pickCategory(undefined, cats), null);
});

test("pickSentiment accepts the three labels in any case and nothing else", () => {
  assert.equal(pickSentiment("Positive"), "positive");
  assert.equal(pickSentiment(" NEGATIVE "), "negative");
  assert.equal(pickSentiment("mixed"), null);
  assert.equal(pickSentiment(null), null);
});

test("THE FAKE PROVIDER IS DETERMINISTIC, keyword-driven, and falls to the LAST category", () => {
  const cats = ["Price", "Product quality", "Customer service", "Other"];
  assert.equal(fakeClassify("Far too expensive, the price is absurd", cats), "Price");
  assert.equal(fakeClassify("the quality of the product was poor", cats), "Product quality");
  assert.equal(fakeClassify("customer service never answered", cats), "Customer service");
  assert.equal(fakeClassify("It arrived on a Tuesday", cats), "Other", "nothing matched → the last category, by convention Other");
  assert.equal(fakeClassify("anything", []), null);
  assert.equal(fakeSentiment("I love it, great and fast"), "positive");
  assert.equal(fakeSentiment("terrible, slow and expensive"), "negative");
  assert.equal(fakeSentiment("It arrived on a Tuesday"), "neutral");
  assert.equal(fakeSentiment("good but slow"), "neutral", "a tie is neutral");
});

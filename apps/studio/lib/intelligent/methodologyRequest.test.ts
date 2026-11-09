import { test } from "node:test";
import assert from "node:assert/strict";
import { methodologyAnswer, methodologyQuestion } from "./methodologyRequest.ts";

test("only a question ABOUT method is answered by the methodology engine; build requests stay with the Copilot", () => {
  const r = methodologyQuestion("Which methodology should I use to find out how much customers would pay for our new plan?")!;
  assert.equal(r.category, "pricing");
  assert.match(methodologyAnswer(r).answer, /I recommend Van Westendorp/);
  const bad = methodologyQuestion("Is MaxDiff the right method to set the price of our new plan?")!;
  assert.equal(bad.proposed?.fits, false);
  assert.match(methodologyAnswer(bad).answer, /does not answer this objective/);
  for (const s of ["Create a pricing survey with 10 questions", "Add a question about price", "Translate the survey into French"]) assert.equal(methodologyQuestion(s), null, s);
});

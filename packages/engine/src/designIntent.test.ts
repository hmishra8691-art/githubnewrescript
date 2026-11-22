import { test } from "node:test";
import assert from "node:assert/strict";
import { SurveyDefinition } from "@rescript/schema";
import { answerDesignRequest, interpretDesignRequest } from "./designIntent.js";
import { interpretRequest } from "./nlIntent.js";

const def = SurveyDefinition.parse({
  meta: { id: "d", code: "D", title: "Design", version: "1.0" },
  questions: [{ id: "a", code: "Q1", variableName: "Q1", type: "single_select", text: "Which brand do you use", options: [{ code: 1, label: "Alpha" }, { code: 2, label: "Beta" }] }],
  flow: [{ type: "page", id: "p1", questionIds: ["a"] }, { type: "end", id: "e", status: "complete" }],
});
const read = (s: string) => interpretDesignRequest(s);

test("sample size for a margin, said several ways", () => {
  for (const s of ["How many completes do I need for a margin of error of 3%?", "What sample size gives ±3%?", "how many respondents for plus or minus 3 percent", "How big a sample do I need to be within 3 points?", "What sample size do I need for a 3% margin of error?"]) {
    const r = read(s);
    assert.deepEqual([r?.tool, r?.input.margin], ["design.sample_size_margin", 3], s);
  }
  assert.deepEqual(read("How many completes for ±5% at 99% confidence out of 2,000 customers?")?.input, { margin: 5, confidence: 99, population: 2000 });
  assert.equal(answerDesignRequest(def, "How many completes for a margin of error of 3%?")?.answer, "You need 1,068 completes for a margin of error of ±3 points.");
});

test("sample size for a difference, and what a sample can show", () => {
  assert.deepEqual(read("What sample size do I need to detect 40% vs 50%?")?.input, { share1: 40, share2: 50 });
  assert.deepEqual(read("How many respondents to tell apart 10 percent and 15 percent with 90% power?")?.input, { share1: 10, share2: 15, power: 90 });
  assert.deepEqual(read("What margin of error does 400 completes give?")?.input, { completes: 400 });
  assert.deepEqual(read("What difference can 1,000 completes detect across 4 groups?")?.input, { completes: 1000, groups: 4 });
  assert.deepEqual(read("How precise is a sample of 2k?")?.input, { completes: 2000 });
  const a = answerDesignRequest(def, "What margin of error does 400 completes give?");
  assert.ok(a?.ok && /±4\.9 points/.test(a.answer) && a.working.length > 0 && a.assumptions.length > 0);
});

test("interview length and the field estimate", () => {
  for (const s of ["How long is this survey?", "What is the interview length?", "how many minutes will the questionnaire take", "What's the LOI?"]) assert.equal(read(s)?.tool, "design.interview_length", s);
  assert.deepEqual(read("How many invitations do I need for 1000 completes at 25% incidence and 10% response rate?")?.input, { completes: 1000, incidence: 25, responseRate: 10 });
  assert.deepEqual(read("How much will 500 completes cost at $4.50 per complete?")?.input, { completes: 500, pricePerComplete: 4.5, currency: "$" });
  const a = answerDesignRequest(def, "How many invitations do I need for 1000 completes at 25% incidence and 10% response rate?");
  assert.ok(a?.ok && /4,000 starts and 40,000 invitations/.test(a.answer) && /Not worked out: cost/.test(a.answer));
});

test("a sentence that is not a design question is left alone", () => {
  for (const s of [
    "Add a question about sample size", "Make Q1 required", "Set the sample size to 1,000", "Plan the fieldwork: 1,000 completes in 10 days",
    "How many respondents chose Alpha?", "How many questions are in this survey?", "Show satisfaction by region", "How long will the fieldwork take?",
    "What is the margin of error?", "How many completes do we have?", "Is 40% vs 50% significant?", "Delete Q1", "Write me a poem",
    "We need a study of 1,000 adults with a 3% margin of error to understand why customers leave and what would bring them back, across four regions, in field for two weeks",
  ]) assert.equal(read(s), null, s);
});

test("Intelligent Mode answers these from the calculators, with the working, and no model", () => {
  const r = interpretRequest(def, "How many completes do I need for a margin of error of 3%?");
  assert.equal(r.kind, "answer");
  if (r.kind !== "answer") return;
  assert.equal(r.answer, "You need 1,068 completes for a margin of error of ±3 points.");
  assert.deepEqual(r.sections.map((s) => s.title), ["Working", "Assumptions"]);
  assert.ok(r.sections[0]!.items.some((i) => /1,068/.test(i.label)));
  const bad = interpretRequest(def, "How many completes for a margin of error of 80%?");
  assert.equal(bad.kind, "refused");
  /* the questionnaire's own sentences are still the grammar's */
  assert.equal(interpretRequest(def, "Make Q1 required").kind, "actions");
});

test("Level 5 baseline defects: new wording is not a move, and question order is not data cleaning", () => {
  const d = SurveyDefinition.parse({
    meta: { id: "bd", code: "BD", title: "Baseline defects", version: "1.0" },
    questions: [
      { id: "own", code: "S1", variableName: "S1", type: "single_select", text: "Do you own a car?", options: [{ code: "y", label: "Yes" }, { code: "n", label: "No" }] },
      ...[1, 2, 3, 4, 5, 6, 7, 8, 9, 10].map((i) => ({ id: `q${i}`, code: `Q${i}`, variableName: `Q${i}`, type: i === 6 ? "long_text" : "single_select", text: i === 5 ? "To show you are reading, select Beta" : `Question ${i}`, ...(i === 6 ? {} : { options: [{ code: "a", label: "Alpha" }, { code: "b", label: "Beta" }] }) })),
    ],
    flow: [{ type: "page", id: "p1", questionIds: ["own", "q1", "q2", "q3", "q4", "q5", "q6", "q7", "q8", "q9", "q10"] }, { type: "end", id: "e", status: "complete" }],
  });
  /* was: move_question S1 after Q10 */
  const add = interpretRequest(d, "After S1 ask how many cars they own, as a number between 0 and 10");
  assert.equal(add.kind, "model", JSON.stringify(add));
  /* was: a data-cleaning batch, because of the words "attention check" */
  const move = interpretRequest(d, "Ask the open-end Q6 ahead of the attention check Q5");
  assert.equal(move.kind, "actions");
  if (move.kind === "actions") assert.deepEqual(move.actions, [{ op: "move_question", target: "Q6", after: "Q4" }]);
  /* and the cleaning sentences that start with "ask" still are cleaning */
  assert.equal(interpretRequest(d, "Ask the AI to read the open ends for gibberish").kind, "cleaning");
  assert.equal(interpretRequest(d, "Remove the speeders").kind, "cleaning");
  /* an existing question named after "ask" is still a move */
  assert.equal(interpretRequest(d, "Ask Q6 before Q5").kind, "actions");
});

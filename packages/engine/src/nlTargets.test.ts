import { test } from "node:test";
import assert from "node:assert/strict";
import { SurveyDefinition, type Question } from "@rescript/schema";
import { countWord, firstQuestionAfter, resolveOptionRef, resolveQuestionRange, resolveQuestionRef } from "./nlTargets.js";

/*
 * WHAT A SENTENCE NAMES: codes, variables, the selection, descriptions,
 * ranges and options — resolved against a real survey, with candidates (not
 * guesses) when a name fits several objects or none.
 */

const opts = (...ls: string[]) => ls.map((l, i) => ({ code: i + 1, label: l }));
const survey = () =>
  SurveyDefinition.parse({
    meta: { id: "s", code: "S", title: "Targets" },
    questions: [
      { id: "q1", code: "Q1", variableName: "AGE", type: "numeric", text: "How old are you?" },
      { id: "q2", code: "Q2", variableName: "INCOME", type: "numeric", text: "What is your household income?" },
      { id: "q3", code: "Q3", variableName: "CAR", type: "single_select", text: "Do you own a car?", options: opts("Yes", "No") },
      { id: "q4", code: "Q4", variableName: "CAR_AGE", type: "numeric", text: "What is the age of your car?" },
      { id: "q5", code: "Q5", variableName: "BRANDS", type: "multi_select", text: "Which brands have you bought?", options: [...opts("Brand A", "Brand B", "Brand C"), { code: 99, label: "None of these", flags: ["exclusive", "anchor_bottom"] }] },
      { id: "q6", code: "Q6", variableName: "COUNTRY", type: "single_select", text: "Country", options: [...opts("Canada", "United States", "United Kingdom"), { code: 4, label: "Other (please specify)", flags: ["other_specify"] }] },
      { id: "q7", code: "Q7", variableName: "ARM_A", type: "open_text", text: "Arm A question" },
      { id: "q8", code: "Q8", variableName: "ARM_B", type: "open_text", text: "Arm B question" },
      { id: "q9", code: "Q9", variableName: "LAST", type: "open_text", text: "How do you get to work?" },
      { id: "q10", code: "Q10", variableName: "LOOSE", type: "open_text", text: "Not on any page" },
    ],
    flow: [
      { type: "page", id: "p1", questionIds: ["q1", "q2"] },
      { type: "page", id: "p2", questionIds: ["q3", "q4"] },
      { type: "page", id: "p3", questionIds: ["q5", "q6"] },
      { type: "branch", id: "br", title: "Split", branches: [
        { id: "a1", when: { type: "rule", source: { kind: "question", ref: "q3" }, operator: "eq", value: 1 }, children: [{ type: "page", id: "pa", questionIds: ["q7"] }] },
        { id: "a2", when: { type: "rule", source: { kind: "question", ref: "q3" }, operator: "eq", value: 2 }, children: [{ type: "page", id: "pb", questionIds: ["q8"] }] },
      ] },
      { type: "page", id: "p9", questionIds: ["q9"] },
      { type: "end", id: "e", status: "complete" },
    ],
  });

const ok = (r: ReturnType<typeof resolveQuestionRef>): string => { assert.ok(r.ok, !r.ok ? r.reason : ""); return (r as { question: Question }).question.code; };
const codes = (r: ReturnType<typeof resolveQuestionRange>): string[] => { assert.ok(r.ok, !r.ok ? r.reason : ""); return (r as { questions: Question[] }).questions.map((q) => q.code); };

test("a question by code, variable, number, the selection, quoted text or a description", () => {
  const def = survey();
  assert.equal(ok(resolveQuestionRef(def, "Q3")), "Q3");
  assert.equal(ok(resolveQuestionRef(def, "q3")), "Q3", "codes are case-insensitive when nothing matches exactly");
  assert.equal(ok(resolveQuestionRef(def, "question 3")), "Q3");
  assert.equal(ok(resolveQuestionRef(def, "INCOME")), "Q2");
  assert.equal(ok(resolveQuestionRef(def, "Q5's")), "Q5", "a possessive names the question");
  assert.equal(ok(resolveQuestionRef(def, "this question", { selectedId: "q6" })), "Q6");
  assert.equal(ok(resolveQuestionRef(def, "it", { selectedId: "q6" })), "Q6");
  assert.equal(ok(resolveQuestionRef(def, "the selected question", { selectedId: "q6" })), "Q6");
  assert.equal(ok(resolveQuestionRef(def, "the income question")), "Q2");
  assert.equal(ok(resolveQuestionRef(def, "the question about income")), "Q2");
  assert.equal(ok(resolveQuestionRef(def, "“household income”")), "Q2", "quoted: a piece of the wording");
  assert.equal(ok(resolveQuestionRef(def, "the brands question")), "Q5", "stemmed: brand / brands");
});

test("no match is a did-you-mean; several are candidates, never a guess", () => {
  const def = survey();
  const typo = resolveQuestionRef(def, "Q99");
  assert.equal(typo.ok, false);
  assert.equal(!typo.ok && typo.reason, "There is no Q99 in this survey — did you mean Q9?");
  assert.deepEqual(!typo.ok && typo.candidates.map((c) => c.code), ["Q9"]);
  assert.equal(!typo.ok && typo.ambiguous, false);
  const many = resolveQuestionRef(def, "the age question");
  assert.equal(many.ok, false, "AGE (Q1) and the age of your car (Q4) both fit");
  assert.equal(!many.ok && many.ambiguous, true);
  assert.deepEqual(!many.ok && many.candidates.map((c) => c.code), ["Q1", "Q4"]);
  assert.match(!many.ok ? many.reason : "", /2 questions match/);
  const none = resolveQuestionRef(def, "this question");
  assert.equal(none.ok, false);
  assert.match(!none.ok ? none.reason : "", /nothing is selected/);
  const nothing = resolveQuestionRef(def, "the question about pets");
  assert.equal(nothing.ok, false);
  assert.equal(!nothing.ok && nothing.ambiguous, false);
});

test("ranges: through / to / dashes / lists / the next N / these, in flow order", () => {
  const def = survey();
  assert.deepEqual(codes(resolveQuestionRange(def, "Q2 through Q5")), ["Q2", "Q3", "Q4", "Q5"]);
  assert.deepEqual(codes(resolveQuestionRange(def, "Q2 to Q4")), ["Q2", "Q3", "Q4"]);
  assert.deepEqual(codes(resolveQuestionRange(def, "Q2 thru Q4")), ["Q2", "Q3", "Q4"]);
  assert.deepEqual(codes(resolveQuestionRange(def, "Q2-Q4")), ["Q2", "Q3", "Q4"]);
  assert.deepEqual(codes(resolveQuestionRange(def, "Q2–Q4")), ["Q2", "Q3", "Q4"]);
  assert.deepEqual(codes(resolveQuestionRange(def, "Q4, Q2 and Q3")), ["Q2", "Q3", "Q4"], "a list comes back in flow order");
  assert.deepEqual(codes(resolveQuestionRange(def, "the next three questions", { anchorId: "q1" })), ["Q2", "Q3", "Q4"]);
  assert.deepEqual(codes(resolveQuestionRange(def, "the next 2 questions", { anchorId: "q3" })), ["Q4", "Q5"]);
  assert.deepEqual(codes(resolveQuestionRange(def, "the next question", { anchorId: "q3" })), ["Q4"]);
  assert.deepEqual(codes(resolveQuestionRange(def, "the previous two questions", { anchorId: "q3" })), ["Q1", "Q2"]);
  assert.deepEqual(codes(resolveQuestionRange(def, "the next two questions after Q4")), ["Q5", "Q6"]);
  assert.deepEqual(codes(resolveQuestionRange(def, "these questions", { selectedIds: ["q5", "q2"] })), ["Q2", "Q5"]);
  assert.deepEqual(codes(resolveQuestionRange(def, "Q3")), ["Q3"], "one question is a range of one");
  assert.deepEqual(codes(resolveQuestionRange(def, "“get to work”")), ["Q9"], "wording containing “to” is not split into a range when it names one question");
});

test("ranges refuse what is not a forward run in one flow, and say which end failed", () => {
  const def = survey();
  const back = resolveQuestionRange(def, "Q5 through Q2");
  assert.equal(back.ok, false);
  assert.equal(!back.ok && back.reason, "Q5 comes after Q2 in the flow — a range runs forward: say “Q2 through Q5”.");
  const arms = resolveQuestionRange(def, "Q7 to Q8");
  assert.equal(arms.ok, false);
  assert.match(!arms.ok ? arms.reason : "", /different arms of the branch “Split”/);
  assert.deepEqual(codes(resolveQuestionRange(def, "Q6 to Q9")), ["Q6", "Q7", "Q8", "Q9"], "a range around the whole branch is one flow");
  const loose = resolveQuestionRange(def, "Q9 to Q10");
  assert.equal(loose.ok, false);
  assert.match(!loose.ok ? loose.reason : "", /Q10 is not on any page/);
  const typo = resolveQuestionRange(def, "Q2 through Q55");
  assert.equal(typo.ok, false);
  assert.equal(!typo.ok && typo.ref, "Q55", "the failing end is named, so a did-you-mean can be substituted into the sentence");
  assert.deepEqual(!typo.ok && typo.candidates.map((c) => c.code), ["Q5"]);
  const short = resolveQuestionRange(def, "the next five questions", { anchorId: "q6" });
  assert.equal(short.ok, false);
  assert.match(!short.ok ? short.reason : "", /Only 3 questions come after Q6/);
  assert.match((resolveQuestionRange(def, "the next five questions") as { reason: string }).reason, /counts from a question/);
  assert.match((resolveQuestionRange(def, "these questions") as { reason: string }).reason, /nothing is selected/);
  assert.equal(countWord("five"), 5);
  assert.equal(countWord("12"), 12);
  assert.equal(countWord("several"), null);
});

test("firstQuestionAfter: where a skip over a range lands, or the end", () => {
  const def = survey();
  const q = (c: string) => def.questions.find((x) => x.code === c)!;
  assert.equal((firstQuestionAfter(def, [q("Q2"), q("Q3")]) as Question).code, "Q4");
  assert.equal((firstQuestionAfter(def, [q("Q5"), q("Q6")]) as Question).code, "Q7");
  assert.equal(firstQuestionAfter(def, [q("Q9")]), "end", "Q10 is on no page, so Q9 is the last question asked");
});

test("options: by number, ordinal, label, prefix, the Other flag, the last, the selection — candidates when several fit", () => {
  const def = survey();
  const q5 = def.questions.find((x) => x.code === "Q5")!, q6 = def.questions.find((x) => x.code === "Q6")!;
  const code = (r: ReturnType<typeof resolveOptionRef>) => { assert.ok(r.ok, !r.ok ? r.reason : ""); return (r as { option: { code: unknown } }).option.code; };
  assert.equal(code(resolveOptionRef(q6, "option 2")), 2);
  assert.equal(code(resolveOptionRef(q6, "the third option")), 3);
  assert.equal(code(resolveOptionRef(q6, "the last option")), 4);
  assert.equal(code(resolveOptionRef(q6, "Canada")), 1);
  assert.equal(code(resolveOptionRef(q6, "option Canada")), 1);
  assert.equal(code(resolveOptionRef(q5, "\"None of these\"")), 99);
  assert.equal(code(resolveOptionRef(q5, "None")), 99, "a unique prefix");
  assert.equal(code(resolveOptionRef(q6, "the Other option")), 4, "the option with a specify box");
  assert.equal(code(resolveOptionRef(q6, "this option", { selected: 3 })), 3);
  const two = resolveOptionRef(q6, "United");
  assert.equal(two.ok, false);
  assert.equal(!two.ok && two.ambiguous, true);
  assert.deepEqual(!two.ok && two.candidates.map((c) => c.code), [2, 3]);
  const near = resolveOptionRef(q6, "Canadaa");
  assert.equal(near.ok, false);
  assert.match(!near.ok ? near.reason : "", /did you mean “Canada”/);
  const none = resolveOptionRef(q6, "Brazil");
  assert.match(!none.ok ? none.reason : "", /Q6 has no option “Brazil” — its options are/);
  assert.match((resolveOptionRef(q6, "the ninth option") as { reason: string }).reason, /has 4 options, so there is no ninth one/);
  assert.match((resolveOptionRef(def.questions[0], "Yes") as { reason: string }).reason, /Q1 has no options/);
});

/* mutation-checked: stems, lower-case codes, “question N”, two did-you-means, shared quoted wording, every word of a description */
test("names: a stemmed plural, a lower-case code, “question 99”, several did-you-means, quoted wording two questions share, all words must fit", () => {
  const def = survey();
  assert.equal(ok(resolveQuestionRef(def, "the brand question")), "Q5", "“brand” finds “brands”: the plural is stemmed");
  const s1 = survey();
  s1.questions[0].code = "S1";
  const lower = resolveQuestionRef(s1, "s1");
  assert.equal(ok(lower), "S1", "a code typed in lower case");
  assert.equal(lower.ok && lower.via, "code");
  assert.equal((resolveQuestionRef(def, "question 99") as { reason: string }).reason, "There is no Q99 in this survey — did you mean Q9?", "“question 99” is read as the code Q99");
  const two = resolveQuestionRef(def, "the car colour question");
  assert.equal(!two.ok && two.reason, "There is no question “the car colour question” in this survey — did you mean Q3, Q4?");
  const quoted = resolveQuestionRef(def, "“What is”");
  assert.equal(quoted.ok, false, "two questions contain the wording: never the first one");
  assert.equal(!quoted.ok && quoted.ambiguous, true);
  assert.deepEqual(!quoted.ok && quoted.candidates.map((c) => c.code), ["Q2", "Q4"]);
  assert.equal(ok(resolveQuestionRef(def, "the car age question")), "Q4", "car AND age: only Q4 has both words");
});

test("ranges at their edges: previous N from the start, a run one short, “these” as the single selection, a description containing “to”", () => {
  const def = survey();
  assert.equal((resolveQuestionRange(def, "the previous three questions", { anchorId: "q3" }) as { reason: string }).reason, "Only 2 questions come before Q3 (Q1, Q2), not 3.");
  assert.equal((resolveQuestionRange(def, "the next four questions", { anchorId: "q6" }) as { reason: string }).reason, "Only 3 questions come after Q6 (Q7, Q8, Q9), not 4.");
  assert.deepEqual(codes(resolveQuestionRange(def, "these questions", { selectedId: "q4" })), ["Q4"], "one selected question is “these”");
  // one end of “the time to first purchase question” resolves, the other is ambiguous — the whole phrase names one question
  const d = survey();
  const loose = d.questions.find((x) => x.code === "Q10")!;
  d.questions.push({ ...loose, id: "q20", code: "Q20", variableName: "T1", text: "Time to first purchase" }, { ...loose, id: "q21", code: "Q21", variableName: "T2", text: "Time spent online" });
  (d.flow[4] as { questionIds: string[] }).questionIds.push("q20", "q21");
  assert.deepEqual(codes(resolveQuestionRange(d, "the time to first purchase question")), ["Q20"]);
});

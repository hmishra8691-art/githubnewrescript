import { test } from "node:test";
import assert from "node:assert/strict";
import { estimateTaskSize, requestedQuestionCount, saysPlanFirst, isLongBrief } from "./index.js";

/*
 * PLAN FIRST OR ONE TURN (durable tasks, 2026-10-25). The production prompts that timed out at 163–165 s are tasks;
 * a single edit stays a single turn.
 */

const survey = (n: number) => ({ questions: Array.from({ length: n }, (_, i) => ({ id: `q${i + 1}`, code: `Q${i + 1}`, type: "single_select", text: `Which of the following statements about topic ${i + 1} is correct?`, options: [{ code: 1, label: "Statement A is correct" }, { code: 2, label: "Statement B is correct" }, { code: 3, label: "Both" }, { code: 4, label: "Neither" }] })) });

/* the production UPSC brief (2026-10-24): ~650 characters, Hindi, "100 questions, General Studies" */
const UPSC = "मुझे UPSC प्रीलिम्स की तैयारी के लिए एक मॉक टेस्ट चाहिए। इसमें General Studies Paper 1 के 100 questions होने चाहिए — इतिहास, भूगोल, राजव्यवस्था, अर्थव्यवस्था, पर्यावरण, विज्ञान और करंट अफेयर्स से। हर प्रश्न multiple choice हो, चार विकल्प के साथ, और हर प्रश्न का सही उत्तर और एक छोटी व्याख्या भी दो। कठिनाई स्तर असली UPSC परीक्षा जैसा होना चाहिए, कुछ आसान, ज़्यादातर मध्यम और कुछ कठिन। सही उत्तर पर 2 अंक और गलत उत्तर पर एक तिहाई नेगेटिव मार्किंग हो। टेस्ट के अंत में topic-wise score report दिखाओ ताकि मुझे पता चले कि किस विषय में मैं कमजोर हूँ। प्रश्न हिंदी में हों।";

test("the production UPSC brief (650 chars, Hindi, 100 questions) is a task — it is NOT a long brief, which is why it ran single-shot", () => {
  assert.ok(UPSC.length > 450 && UPSC.length < 1500, `length ${UPSC.length}`);
  assert.equal(isLongBrief(UPSC), false, "the old rule never planned it");
  const e = estimateTaskSize({ message: UPSC, survey: { questions: [] } });
  assert.equal(e.task, true);
  assert.equal(e.kind, "generate");
  assert.equal(e.requestedCount, 100);
  assert.ok(e.outputTokens > 20_000, `output ${e.outputTokens}`);
  assert.ok(e.steps >= 10, `steps ${e.steps}`);
  for (const d of ["answer_key", "explanations", "scoring", "report"]) assert.ok(e.deliverables.includes(d), d);
});

test("translate the survey to Urdu on a 78-question survey is a task (Devanagari and English)", () => {
  for (const m of ["सर्वे को उर्दू में ट्रांस्लेट कर दो", "Translate the survey to Urdu", "translate all questions into urdu please"]) {
    const e = estimateTaskSize({ message: m, survey: survey(78) });
    assert.equal(e.task, true, m);
    assert.equal(e.kind, "translate", m);
    assert.equal(e.units, 78, m);
    assert.equal(e.language, "Urdu", m);
  }
});

test("translating the first 10 questions is a (small) task; translating Q3 alone is one turn", () => {
  const e = estimateTaskSize({ message: "Translate the first 10 questions to Urdu", survey: survey(78) });
  assert.deepEqual(e.range, { from: 1, to: 10 });
  assert.equal(e.units, 10);
  assert.equal(e.task, true);
  const one = estimateTaskSize({ message: "Translate Q3 into Hindi", survey: survey(78) });
  assert.equal(one.task, false);
  assert.equal(one.units, 1);
});

test("the production follow-up on 104 questions (correct answer, what I selected, explanations for every question) is a task", () => {
  const e = estimateTaskSize({ message: "show for every question what was correct, what I selected, and an explanation", survey: survey(104) });
  assert.equal(e.task, true);
  assert.equal(e.kind, "per_question");
  assert.equal(e.units, 104);
  const hi = estimateTaskSize({ message: "सभी प्रश्नों के सही उत्तर और व्याख्या दिखाओ", survey: survey(104) });
  assert.equal(hi.task, true);
});

test("small requests stay single-turn (H)", () => {
  for (const m of ["make Q1 required", "Add an NPS question", "What does Q4 measure?", "rename Q2 to BRAND", "add 2 more questions about price", "randomize the options of Q5", "Q1 को required करो"]) {
    const e = estimateTaskSize({ message: m, survey: survey(12) });
    assert.equal(e.task, false, m);
    assert.equal(e.kind, "single", m);
  }
  assert.equal(estimateTaskSize({ message: "create a customer satisfaction survey", survey: { questions: [] } }).task, false, "a short generation keeps the existing plan stage");
  assert.equal(estimateTaskSize({ message: "explain every question", survey: survey(5) }).task, false, "five questions fit one turn");
});

test("200–300-question requests and counts in words / Devanagari digits", () => {
  assert.equal(requestedQuestionCount("Build a 250-question survey with complex logic"), 250);
  assert.equal(requestedQuestionCount("Build a survey with 200-300 questions and complex skip logic"), 300);
  assert.equal(requestedQuestionCount("१०० प्रश्न बनाओ"), 100);
  assert.equal(requestedQuestionCount("a hundred questions on GK"), 100);
  assert.equal(requestedQuestionCount("make Q1 required"), undefined);
  assert.equal(requestedQuestionCount("100 questionnaires"), undefined);
  const e = estimateTaskSize({ message: "Build a survey with 200-300 questions and complex skip logic, quotas and piping", survey: { questions: [] } });
  assert.equal(e.task, true);
  assert.equal(e.units, 300);
  assert.ok(e.steps >= 20);
});

test("multi-deliverable and forced", () => {
  const e = estimateTaskSize({ message: "Create a brand tracker survey with an analysis plan, a PowerPoint deck of the findings and a Word report", survey: { questions: [] } });
  assert.equal(e.task, true);
  assert.equal(e.kind, "multi");
  const f = estimateTaskSize({ message: "make Q1 required", survey: survey(3), force: true });
  assert.equal(f.task, true);
  assert.equal(f.forced, true);
  assert.equal(saysPlanFirst("Plan first: add a screener"), true);
  assert.equal(saysPlanFirst("add a screener"), false);
});

test("a long pasted brief on an empty survey is a task", () => {
  const brief = ["# Study brief", "## Objectives", "1. Understand coffee habits of under-35 consumers", "2. Measure brand awareness", "3. Identify price sensitivity", "4. Segment the market", "## Sample", "- n=1000 adults", "- quotas by age and region", "## Questionnaire", "Screener, usage, attitudes, brand funnel, pricing, demographics. ".repeat(20)].join("\n");
  const e = estimateTaskSize({ message: brief, survey: { questions: [] } });
  assert.equal(e.task, true);
  assert.equal(e.reason, "long_brief");
});

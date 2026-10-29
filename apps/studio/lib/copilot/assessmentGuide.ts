/**
 * THE ASSESSMENT GUIDE (2026-10-25, K4 — docs/ASSESSMENTS-2026-10-25.md; ported 2026-10-29, step 4A) — how Intelligent Mode writes a scored
 * paper: the answer key per question (`set_answer_key`) and the paper's marking / results settings
 * (`set_assessment`), engine `assessmentActions.ts`. Sent only when a request is about a test, quiz, exam, answer
 * key, marks or a results report (`assessmentIntent`), lifted into the cached system prefix like every guide; the
 * system prompt is at its cap and is not touched. Every `{"op":…}` line is applied by the engine as written
 * (`assessmentGuide.test.ts`).
 *
 * What it must never let the model do: write per-question results, scores, "what you selected" or weak-area
 * reports itself — those are computed deterministically on the server after submission and shown on the results
 * page. A request for them is answered with set_assessment (report sections on), never with generated text.
 */
export const COPILOT_ASSESSMENT_GUIDE = `ASSESSMENTS — a survey can be a scored test (practice paper, quiz, knowledge test, UPSC-style exam). Write each question as single_select (multi_select for several correct answers) with 4 options coded 1–4, then its key:
set_answer_key {target: "<question code>", correct: ["<option code or exact label>"], marks?, negativeMarks? (deducted, positive), partialCredit?: none | proportional | proportional_no_wrong, topic: "<subject>", subtopic?, difficulty?: easy | medium | hard, explanation: "<why the correct answer is correct>", optionExplanations?: {"<code>": "<why this option is wrong>"}, ungraded?} — fields left out are kept, so a follow-up can add only an explanation. Remove a key: {"op":"clear_answer_key","target":"<code>"}.
set_assessment {enabled?, title?, defaultMarks?, defaultNegativeMarks?, partialCredit?, passPercent? | passMarks? (null clears), showResults?: after_submit | never | per_question, report?: {summary, perQuestion, explanations, topicBreakdown, weakAreas, recommendations}, weakThreshold? (%), expectedQuestions?, reportQuestions?: [codes]} — UPSC Prelims GS: defaultMarks 2, defaultNegativeMarks 0.66, 100 questions.
The key is never sent to respondents: they are scored ON THE SERVER after submitting and see a results page (score, every question with their answer, the correct answer and the explanation, topic breakdown, weak areas, revision topics) — so NEVER write results, scores, "correct / selected" lists or weak-area text yourself: switch the report on with set_assessment. per_question shows right/wrong after each answer but puts the key in the browser — say so. Explanations are factual, 1–3 sentences; one topic tag per question.
{"op":"set_assessment","enabled":true,"defaultMarks":2,"defaultNegativeMarks":0.66,"passPercent":33,"showResults":"after_submit","report":{"perQuestion":true,"explanations":true,"weakAreas":true}}
{"op":"set_answer_key","target":"Q1","correct":["3"],"topic":"Polity","subtopic":"Fundamental Rights","explanation":"Article 21 protects life and personal liberty.","optionExplanations":{"1":"Article 14 is equality before law."}}`;

/** a request about a scored test / quiz / exam, an answer key, marking, or a results report of one */
export function assessmentIntent(text: string): boolean {
  return /\b(?:quiz(?:zes)?|exam(?:s|ination)?|mock (?:test|paper)|practice (?:test|paper|set)|question paper|prelims?|mains|upsc|ssc|neet|jee|gate exam|knowledge (?:test|check)|assessment|answer ?keys?|correct (?:answers?|options?)|right answers?|marks?(?:ing| scheme)?|negative marking|pass ?mark|score (?:report|card)|scorecard|weak (?:areas?|topics?)|explanations? for (?:each|every) (?:question|answer)|what i (?:selected|chose)|set_answer_key|set_assessment)\b/i.test(text)
    || /प्रश्न ?पत्र|उत्तर ?कुंजी|सही (?:उत्तर|विकल्प)|अंक|परीक्षा|प्रीलिम्स|मॉक टेस्ट|कमजोर (?:क्षेत्र|विषय)|व्याख्या/.test(text);
}

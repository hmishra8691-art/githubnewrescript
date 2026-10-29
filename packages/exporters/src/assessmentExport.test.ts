import test from "node:test";
import assert from "node:assert/strict";
import { inflateRawSync } from "node:zlib";
import { SurveyDefinition } from "@rescript/schema";
import { assessmentAnalytics, scoreAssessment } from "@rescript/engine";
import { responsesToCSV } from "./csv.js";
import { exportAssessmentDocx } from "./assessmentDocx.js";

/* ASSESSMENTS (K4 2026-10-25, ported 2026-10-29): the researcher's Word document — answer-key sheet and results report */
const def = SurveyDefinition.parse({
  meta: { id: "s", code: "UPSC", title: "Mock", version: "1.0" },
  questions: [1, 2, 3].map((n) => ({ id: `q${n}`, code: `Q${n}`, variableName: `Q${n}`, type: "single_select", text: `Question ${n}`, options: [{ code: 1, label: "Alpha" }, { code: 2, label: "Beta" }], assessment: { correct: [2], topic: n < 3 ? "Polity" : "Economy", explanation: `Because ${n}`, ...(n === 1 ? { optionExplanations: { "1": "Alpha is the trap" } } : {}) } })),
  flow: [{ type: "page", id: "p", questionIds: ["q1", "q2", "q3"] }, { type: "end", id: "e", status: "complete" }],
  assessment: { title: "GS Mock 1", defaultMarks: 2, defaultNegativeMarks: 0.66, passPercent: 40 },
});

/** word/document.xml out of the .docx zip */
function documentXml(buf: Buffer): string {
  assert.equal(buf.subarray(0, 2).toString(), "PK", "a .docx (zip)");
  const name = Buffer.from("word/document.xml");
  const at = buf.indexOf(name);
  assert.ok(at > 0, "the zip names word/document.xml");
  const hdr = at - 30;
  const comp = buf.readUInt32LE(hdr + 18), method = buf.readUInt16LE(hdr + 8), extraLen = buf.readUInt16LE(hdr + 28);
  const start = at + name.length + extraLen;
  return (method === 8 ? inflateRawSync(buf.subarray(start, start + comp)) : buf.subarray(start, start + comp)).toString("utf8");
}

test("Word answer-key sheet: marking scheme, pass mark, every graded question with its correct answer, explanation and mistake note", async () => {
  const xml = documentXml(await exportAssessmentDocx(def, { generatedAt: new Date("2026-10-29T00:00:00Z") }));
  for (const s of ["GS Mock 1", "contains the answer key", "Marking scheme", "+2 per correct answer, −0.66 per wrong answer", "Maximum 6 marks", "Pass mark: 40%", "Answer key", "Q1. Question 1", "Q3. Question 3", "Correct: 2 — Beta", "Because 1", "Because 3", "Option 1 (Alpha): Alpha is the trap", "Polity", "Economy"]) assert.ok(xml.includes(s), s);
  assert.ok(!xml.includes("Respondent report") && !xml.includes("Item analysis"), "no results section without results");
});

test("Word results report: one respondent's score, topics, weak areas, per question; and the item analysis over all", async () => {
  const results = [{ q1: 2, q2: 2, q3: 2 }, { q1: 2, q2: 1 }, { q1: 1 }, { q2: 2, q3: 1 }].map((a) => scoreAssessment(def, a));
  const xml = documentXml(await exportAssessmentDocx(def, { analytics: assessmentAnalytics(def, results), result: results[1], generatedAt: new Date("2026-10-29T00:00:00Z") }));
  for (const s of ["Respondent report", "Score 1.34 / 6 (22.33%) — not passed", "Correct 1, incorrect 1, partly correct 0, not attempted 1", "Weak areas", "Recommended revision", "Results", "4 scored responses", "Item analysis", "p-value", "Answer key"]) assert.ok(xml.includes(s), s);
});

test("a survey that is not an assessment: the CSV export has no score columns (unchanged by 4A)", () => {
  const plain = SurveyDefinition.parse({ ...def, assessment: undefined, questions: def.questions.map((q) => ({ ...q, assessment: undefined })) });
  const head = responsesToCSV(plain, []).trim().split(",");
  assert.ok(!head.includes("SCORE") && !head.includes("Q1_CORRECT"));
});

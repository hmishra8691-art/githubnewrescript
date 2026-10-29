import { Document, Packer, Paragraph, TextRun, Table, TableRow, TableCell, WidthType, BorderStyle } from "docx";
import type { SurveyDefinition } from "@rescript/schema";
import { assessmentSettings, gradedQuestions, UNTAGGED_TOPIC, type AssessmentAnalytics, type AssessmentResult } from "@rescript/engine";
import { plainText } from "./exportConfig.js";

/**
 * THE ASSESSMENT AS A WORD DOCUMENT, FOR THE RESEARCHER (K4 2026-10-25, ported 2026-10-29 — docs/ASSESSMENTS-2026-10-29.md).
 *
 *   1. the paper: marking scheme, pass mark, number of graded questions
 *   2. the answer key: question, correct answer(s), marks, topic, explanation, the per-option mistake notes
 *   3. (with `analytics`) the results: n, mean, median, SD, pass rate, the score distribution and the item
 *      analysis (p-value, point-biserial, flag)
 *   4. (with `result`) one respondent's report: score, per question selected / correct / status / marks
 *
 * Deterministic text from the definition and the server's scores — no model. CONTAINS THE ANSWER KEY: the
 * route that serves it is a member's (responses.read), never a respondent's.
 */
const INK = "16202E", SUBTLE = "5F6B7D", RULE = "D5DBE4";
const h = (text: string, size = 30) => new Paragraph({ children: [new TextRun({ text, bold: true, size, color: INK })], spacing: { before: 200, after: 80 } });
const p = (text: string, opts: { muted?: boolean; bold?: boolean } = {}) => new Paragraph({ children: [new TextRun({ text, size: opts.muted ? 18 : 20, color: opts.muted ? SUBTLE : INK, bold: opts.bold, italics: opts.muted })], spacing: { after: 60 } });
const cell = (text: string, bold = false) => new TableCell({ children: [new Paragraph({ children: [new TextRun({ text, size: 18, bold, color: INK })] })] });
const table = (head: string[], rows: string[][]) => new Table({
  width: { size: 100, type: WidthType.PERCENTAGE },
  borders: { top: { style: BorderStyle.SINGLE, size: 4, color: RULE }, bottom: { style: BorderStyle.SINGLE, size: 4, color: RULE }, left: { style: BorderStyle.NONE, size: 0, color: "FFFFFF" }, right: { style: BorderStyle.NONE, size: 0, color: "FFFFFF" }, insideHorizontal: { style: BorderStyle.SINGLE, size: 2, color: RULE }, insideVertical: { style: BorderStyle.NONE, size: 0, color: "FFFFFF" } },
  rows: [new TableRow({ tableHeader: true, children: head.map((x) => cell(x, true)) }), ...rows.map((r) => new TableRow({ children: r.map((x) => cell(x)) }))],
});
const n2 = (v: number | null | undefined) => (v === null || v === undefined ? "–" : String(Math.round(v * 100) / 100));

export async function exportAssessmentDocx(def: SurveyDefinition, extra: { analytics?: AssessmentAnalytics | null; result?: AssessmentResult | null; generatedAt?: Date } = {}): Promise<Buffer> {
  const s = assessmentSettings(def);
  const graded = gradedQuestions(def);
  const children: (Paragraph | Table)[] = [];
  children.push(new Paragraph({ children: [new TextRun({ text: plainText(s?.title || def.meta.title) || def.meta.code, bold: true, size: 44, color: INK })], spacing: { after: 80 } }));
  children.push(p(`${def.meta.code} · ${graded.length} graded questions · generated ${(extra.generatedAt ?? new Date()).toISOString().slice(0, 16).replace("T", " ")} UTC · contains the answer key`, { muted: true }));
  if (s) {
    const maxMarks = graded.reduce((t, q) => t + (q.assessment!.marks ?? s.defaultMarks), 0);
    children.push(h("Marking scheme", 26));
    children.push(p(`+${s.defaultMarks} per correct answer${s.defaultNegativeMarks ? `, −${s.defaultNegativeMarks} per wrong answer` : ", no negative marking"}; unattempted 0. Multi-answer credit: ${s.partialCredit.replace(/_/g, " ")}. Maximum ${n2(maxMarks)} marks.`));
    if (s.passMarks !== undefined || s.passPercent !== undefined) children.push(p(`Pass mark: ${s.passMarks !== undefined ? `${s.passMarks} marks` : `${s.passPercent}%`}`));
    children.push(p(`Results shown to respondents: ${s.showResults.replace(/_/g, " ")}. Weak areas: topics below ${s.weakThreshold}%.`));
  }

  if (extra.result) {
    const r = extra.result;
    children.push(h("Respondent report", 26));
    children.push(p(`Score ${n2(r.marks)} / ${n2(r.maxMarks)} (${n2(r.percentage)}%)${r.passed === null ? "" : r.passed ? " — passed" : " — not passed"}. Correct ${r.correct}, incorrect ${r.incorrect}, partly correct ${r.partial}, not attempted ${r.unattempted}; negative marks ${n2(r.negative)}.`, { bold: true }));
    children.push(table(["Topic", "Questions", "Attempted", "Correct", "Accuracy", "Marks"], r.topics.map((t) => [t.topic, String(t.questions), String(t.attempted), String(t.correct), t.accuracy === null ? "–" : `${n2(t.accuracy)}%`, `${n2(t.marks)} / ${n2(t.maxMarks)}`])));
    if (r.weakAreas.length) { children.push(p("Weak areas", { bold: true })); for (const w of r.weakAreas) children.push(p(`• ${w.topic} — ${w.reason}`)); }
    if (r.recommendations.length) { children.push(p("Recommended revision", { bold: true })); for (const x of r.recommendations) children.push(p(`• ${x.reason}`)); }
    children.push(table(["Q", "Selected", "Correct", "Result", "Marks"], r.questions.map((q) => [q.code, q.selectedLabels.join(", ") || "—", q.correctLabels.join(", "), q.status, n2(q.marks)])));
  }

  if (extra.analytics && extra.analytics.n > 0) {
    const a = extra.analytics;
    children.push(h("Results", 26));
    children.push(p(`${a.n} scored responses · mean ${n2(a.mean)} (${n2(a.meanPct)}%) · median ${n2(a.median)} · SD ${n2(a.sd)} · min ${n2(a.min)} · max ${n2(a.max)}${a.passRate === null ? "" : ` · pass rate ${n2(a.passRate)}%`}`));
    children.push(table(["Score %", "Responses"], a.distribution.map((b) => [`${b.from}–${b.to}`, String(b.count)])));
    children.push(p("Item analysis — p-value (share answering correctly) and corrected point-biserial (discrimination)", { bold: true }));
    children.push(table(["Q", "Topic", "n", "p-value", "r(pb)", "Flag"], a.items.map((i) => [i.code, i.topic, String(i.n), n2(i.pValue), n2(i.pointBiserial), i.flag ?? ""])));
  }

  children.push(h("Answer key", 26));
  for (const q of graded) {
    const a = q.assessment!;
    const label = (c: string | number) => plainText((q.options ?? []).find((o) => String(o.code) === String(c))?.label ?? String(c));
    children.push(p(`${q.code}. ${plainText(q.text)}`, { bold: true }));
    children.push(p(`Correct: ${(a.correct ?? []).map((c) => `${c} — ${label(c)}`).join("; ") || "— not set —"}   ·   ${a.marks ?? s?.defaultMarks ?? 1} marks${(a.negativeMarks ?? s?.defaultNegativeMarks) ? `, −${a.negativeMarks ?? s?.defaultNegativeMarks}` : ""}   ·   ${(a.topic ?? "").trim() || UNTAGGED_TOPIC}${a.subtopic ? ` / ${a.subtopic}` : ""}${a.difficulty ? `   ·   ${a.difficulty}` : ""}`, { muted: true }));
    if (a.explanation) children.push(p(`Explanation: ${a.explanation}`));
    for (const [code, why] of Object.entries(a.optionExplanations ?? {})) children.push(p(`Option ${code} (${label(code)}): ${why}`, { muted: true }));
  }
  const doc = new Document({ sections: [{ children }] });
  return Buffer.from(await Packer.toBuffer(doc));
}

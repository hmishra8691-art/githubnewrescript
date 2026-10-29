import type { Question, QuestionAssessment, SurveyDefinition } from "@rescript/schema";
import { AssessmentSettings as AssessmentSettingsSchema } from "@rescript/schema";

/**
 * ASSESSMENTS AS INTELLIGENT-MODE ACTIONS (2026-10-25, engineer K4 — docs/ASSESSMENTS-2026-10-25.md).
 *
 *   set_answer_key    the key and marking of ONE question → question.assessment:
 *                     { op, target: "<code>", correct: ["<option code | exact label | letter A–Z>"], marks?,
 *                       negativeMarks?, partialCredit?, topic?, subtopic?, difficulty?, explanation?,
 *                       optionExplanations?: { "<option code | label>": "why it is wrong" }, ungraded? }
 *                     Fields left out keep their stored value (a follow-up "add explanations" sends only
 *                     `explanation`). Every correct option is resolved against the question's options;
 *                     an option that does not exist is REFUSED, never stored.
 *   clear_answer_key  removes question.assessment (destructive: confirmed)
 *   set_assessment    the paper → def.assessment, patched field by field: enabled, title, defaultMarks,
 *                     defaultNegativeMarks, partialCredit, passPercent | passMarks (null clears), showResults,
 *                     report sections, weakThreshold, maxWeakAreas, expectedQuestions, reportQuestions (codes)
 *
 * Writes question.assessment / def.assessment and nothing else; deterministic.
 */

export const ASSESSMENT_ACTION_OPS = ["set_answer_key", "clear_answer_key", "set_assessment"] as const;
export const isAssessmentOp = (op: string): boolean => (ASSESSMENT_ACTION_OPS as readonly string[]).includes(op);

export interface SetAnswerKeyAction {
  op: "set_answer_key";
  target: string;
  correct?: (string | number)[];
  marks?: number | null;
  negativeMarks?: number | null;
  partialCredit?: "none" | "proportional" | "proportional_no_wrong" | null;
  topic?: string | null;
  subtopic?: string | null;
  difficulty?: "easy" | "medium" | "hard" | null;
  explanation?: string | null;
  optionExplanations?: Record<string, string>;
  ungraded?: boolean;
}
export interface ClearAnswerKeyAction { op: "clear_answer_key"; target: string }
export interface SetAssessmentAction {
  op: "set_assessment";
  enabled?: boolean;
  title?: string | null;
  defaultMarks?: number;
  defaultNegativeMarks?: number;
  partialCredit?: "none" | "proportional" | "proportional_no_wrong";
  passPercent?: number | null;
  passMarks?: number | null;
  showResults?: "after_submit" | "never" | "per_question";
  report?: Partial<Record<"summary" | "perQuestion" | "explanations" | "topicBreakdown" | "weakAreas" | "recommendations", boolean>>;
  weakThreshold?: number;
  maxWeakAreas?: number;
  expectedQuestions?: number | null;
  /** question codes / ids the per-question report is limited to; [] or null = every graded question */
  reportQuestions?: string[] | null;
}
export type AssessmentAction = SetAnswerKeyAction | ClearAnswerKeyAction | SetAssessmentAction;

const str = (v: unknown, max = 4000): string | undefined => (typeof v === "string" && v.trim() ? v.trim().slice(0, max) : typeof v === "number" ? String(v) : undefined);
const num = (v: unknown): number | undefined => { const n = typeof v === "number" ? v : typeof v === "string" && v.trim() ? Number(v) : NaN; return Number.isFinite(n) ? n : undefined; };
const PARTIAL = ["none", "proportional", "proportional_no_wrong"] as const;
const DIFF = ["easy", "medium", "hard"] as const;
const SHOW = ["after_submit", "never", "per_question"] as const;
const SECTIONS = ["summary", "perQuestion", "explanations", "topicBreakdown", "weakAreas", "recommendations"] as const;

/** The gate: known fields only, typed; null clears where the field is optional. */
export function coerceAssessmentAction(op: string, o: Record<string, unknown>): AssessmentAction | string | null {
  /* "set_assessment_settings" (the name the P0 plan uses) is read as set_assessment — one op, one gate */
  if (op === "set_assessment_settings") op = "set_assessment";
  if (!isAssessmentOp(op)) return null;
  if (op === "clear_answer_key") { const t = str(o.target ?? o.question, 120); return t ? { op, target: t } : "clear_answer_key needs a target"; }
  if (op === "set_answer_key") {
    const target = str(o.target ?? o.question, 120);
    if (!target) return "set_answer_key needs a target question";
    const rawCorrect = o.correct ?? o.answer ?? o.answers ?? o.correctOption ?? o.correctOptions;
    const correct = rawCorrect === undefined ? undefined : (Array.isArray(rawCorrect) ? rawCorrect : [rawCorrect]).map((x) => (typeof x === "number" ? x : str(x, 400))).filter((x): x is string | number => x !== undefined).slice(0, 30);
    if (rawCorrect !== undefined && !correct?.length) return "set_answer_key: correct names no option";
    const a: SetAnswerKeyAction = { op, target, ...(correct ? { correct } : {}) };
    for (const k of ["marks", "negativeMarks"] as const) {
      if (o[k] === null) a[k] = null;
      else if (o[k] !== undefined) { const n = num(o[k]); if (n === undefined) return `set_answer_key: ${k} must be a number`; a[k] = k === "negativeMarks" ? Math.abs(n) : n; }
    }
    if (o.partialCredit === null) a.partialCredit = null; else if (o.partialCredit !== undefined) { if (!PARTIAL.includes(o.partialCredit as never)) return "set_answer_key: partialCredit is none, proportional or proportional_no_wrong"; a.partialCredit = o.partialCredit as never; }
    if (o.difficulty === null) a.difficulty = null; else if (o.difficulty !== undefined) { const d = String(o.difficulty).toLowerCase(); if (DIFF.includes(d as never)) a.difficulty = d as never; }
    for (const k of ["topic", "subtopic", "explanation"] as const) { if (o[k] === null) a[k] = null; else { const v = str(o[k], k === "explanation" ? 4000 : 120); if (v) a[k] = v; } }
    if (o.optionExplanations && typeof o.optionExplanations === "object" && !Array.isArray(o.optionExplanations)) {
      const m: Record<string, string> = {};
      for (const [k, v] of Object.entries(o.optionExplanations as Record<string, unknown>).slice(0, 30)) { const t = str(v, 2000); if (t) m[String(k).slice(0, 120)] = t; }
      if (Object.keys(m).length) a.optionExplanations = m;
    }
    if (typeof o.ungraded === "boolean") a.ungraded = o.ungraded;
    if (Object.keys(a).length === 2) return "set_answer_key: nothing to set (correct, marks, topic, explanation …)";
    return a;
  }
  const a: SetAssessmentAction = { op: "set_assessment" };
  if (typeof o.enabled === "boolean") a.enabled = o.enabled;
  if (o.title === null) a.title = null; else { const t = str(o.title, 200); if (t) a.title = t; }
  for (const k of ["defaultMarks", "defaultNegativeMarks", "weakThreshold"] as const) if (o[k] !== undefined) { const n = num(o[k]); if (n === undefined) return `set_assessment: ${k} must be a number`; a[k] = k === "defaultNegativeMarks" ? Math.abs(n) : n; }
  if (o.maxWeakAreas !== undefined) { const n = num(o.maxWeakAreas); if (n === undefined || n < 1) return "set_assessment: maxWeakAreas must be a positive number"; a.maxWeakAreas = Math.round(n); }
  for (const k of ["passPercent", "passMarks", "expectedQuestions"] as const) { if (o[k] === null) a[k] = null; else if (o[k] !== undefined) { const n = num(o[k]); if (n === undefined) return `set_assessment: ${k} must be a number`; a[k] = k === "expectedQuestions" ? Math.round(n) : n; } }
  if (o.partialCredit !== undefined) { if (!PARTIAL.includes(o.partialCredit as never)) return "set_assessment: partialCredit is none, proportional or proportional_no_wrong"; a.partialCredit = o.partialCredit as never; }
  if (o.showResults !== undefined) { if (!SHOW.includes(o.showResults as never)) return "set_assessment: showResults is after_submit, never or per_question"; a.showResults = o.showResults as never; }
  if (o.report && typeof o.report === "object") { const r: SetAssessmentAction["report"] = {}; for (const k of SECTIONS) if (typeof (o.report as Record<string, unknown>)[k] === "boolean") r[k] = (o.report as Record<string, boolean>)[k]; if (Object.keys(r).length) a.report = r; }
  if (o.reportQuestions === null) a.reportQuestions = null; else if (Array.isArray(o.reportQuestions)) a.reportQuestions = o.reportQuestions.map((x) => str(x, 120)).filter((x): x is string => !!x).slice(0, 500);
  if (Object.keys(a).length === 1) a.enabled = true; // "make this a test" with nothing else = switch it on with the defaults
  return a;
}

class AssessmentActionError extends Error {}
const fail = (m: string): never => { throw new AssessmentActionError(m); };
const plain = (s: string) => s.replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim().toLowerCase();

export interface AssessmentApplied { description: string; warnings: string[]; touched: string[]; destructive?: string }
export interface AssessmentLookups { question: (ref: string) => Question | undefined }

/** An option reference → the option's code: the code itself, the exact label, "A"/"(b)"/"option C" by position. */
export function resolveKeyOption(q: Question, ref: string | number): string | null {
  const opts = q.options ?? [];
  const r = String(ref).trim();
  const byCode = opts.find((o) => String(o.code) === r) ?? opts.find((o) => String(o.code).toLowerCase() === r.toLowerCase());
  if (byCode) return String(byCode.code);
  const byLabel = opts.find((o) => plain(o.label) === plain(r));
  if (byLabel) return String(byLabel.code);
  const letter = /^(?:option\s+)?\(?([a-z])\)?[.)]?$/i.exec(r);
  if (letter) { const i = letter[1].toLowerCase().charCodeAt(0) - 97; if (opts[i]) return String(opts[i].code); }
  // "B) Article 21" / "(b) Article 21" — a letter prefix followed by the label
  const prefixed = /^\(?([a-z])[).:]\s+(.+)$/i.exec(r);
  if (prefixed) { const i = prefixed[1].toLowerCase().charCodeAt(0) - 97; const byL = opts.find((o) => plain(o.label) === plain(prefixed[2])); if (byL) return String(byL.code); if (opts[i]) return String(opts[i].code); }
  return null;
}

export function applyAssessmentAction(def: SurveyDefinition, a: AssessmentAction, look: AssessmentLookups): AssessmentApplied {
  const warnings: string[] = [];
  if (a.op === "set_assessment") {
    const cur = AssessmentSettingsSchema.parse(def.assessment ?? {});
    const next = { ...cur, report: { ...cur.report } } as Record<string, unknown> & typeof cur;
    const changes: string[] = [];
    if (a.enabled !== undefined) { next.enabled = a.enabled; changes.push(a.enabled ? "on" : "off"); }
    if (a.title === null) { delete (next as { title?: string }).title; } else if (a.title) { next.title = a.title; changes.push(`“${a.title}”`); }
    if (a.defaultMarks !== undefined) { if (!(a.defaultMarks > 0)) fail("marks per question must be positive"); next.defaultMarks = a.defaultMarks; changes.push(`+${a.defaultMarks} per correct`); }
    if (a.defaultNegativeMarks !== undefined) { next.defaultNegativeMarks = a.defaultNegativeMarks; changes.push(a.defaultNegativeMarks ? `−${a.defaultNegativeMarks} per wrong` : "no negative marking"); }
    if (a.partialCredit) { next.partialCredit = a.partialCredit; changes.push(`partial credit ${a.partialCredit}`); }
    if (a.passPercent === null) delete (next as { passPercent?: number }).passPercent; else if (a.passPercent !== undefined) { if (a.passPercent < 0 || a.passPercent > 100) fail("passPercent is 0–100"); next.passPercent = a.passPercent; changes.push(`pass at ${a.passPercent}%`); }
    if (a.passMarks === null) delete (next as { passMarks?: number }).passMarks; else if (a.passMarks !== undefined) { next.passMarks = a.passMarks; changes.push(`pass at ${a.passMarks} marks`); }
    if (a.showResults) { next.showResults = a.showResults; changes.push(`results ${a.showResults.replace("_", " ")}`); if (a.showResults === "per_question") warnings.push("Results per question show the right answer straight after each answer, so the answer key is sent to the respondent's browser. For an exam, use “after submit”."); }
    if (a.report) { Object.assign(next.report, a.report); changes.push("report sections"); }
    if (a.weakThreshold !== undefined) { if (a.weakThreshold < 0 || a.weakThreshold > 100) fail("weakThreshold is 0–100"); next.weakThreshold = a.weakThreshold; changes.push(`weak below ${a.weakThreshold}%`); }
    if (a.maxWeakAreas !== undefined) next.maxWeakAreas = Math.min(50, a.maxWeakAreas);
    if (a.expectedQuestions === null) delete (next as { expectedQuestions?: number }).expectedQuestions; else if (a.expectedQuestions !== undefined) { if (a.expectedQuestions < 1) fail("expectedQuestions must be at least 1"); next.expectedQuestions = a.expectedQuestions; changes.push(`${a.expectedQuestions} questions`); }
    if (a.reportQuestions === null || (a.reportQuestions && !a.reportQuestions.length)) delete (next as { reportQuestionIds?: string[] }).reportQuestionIds;
    else if (a.reportQuestions) next.reportQuestionIds = a.reportQuestions.map((r) => (look.question(r) ?? fail(`there is no question “${r}”`)).id);
    def.assessment = AssessmentSettingsSchema.parse(next);
    return { description: `Assessment settings${changes.length ? `: ${changes.join(", ")}` : ""}`, warnings, touched: [] };
  }
  const q = look.question(a.target) ?? fail(`there is no question “${a.target}”`);
  if (a.op === "clear_answer_key") {
    if (!q.assessment) fail(`${q.code} has no answer key`);
    delete q.assessment;
    return { description: `Remove the answer key of ${q.code}`, destructive: `Removes the answer key, marks and explanation of ${q.code}`, warnings, touched: [q.id] };
  }
  const cur: QuestionAssessment = q.assessment ? { ...q.assessment } : { correct: [] };
  delete cur.withheld;
  const parts: string[] = [];
  if (a.correct) {
    if (!["single_select", "multi_select", "dropdown", "image_select"].includes(q.type)) fail(`${q.code} is a ${q.type} question — an answer key needs a single or multiple choice question`);
    const codes: string[] = [];
    for (const r of a.correct) {
      const c = resolveKeyOption(q, r);
      if (c === null) fail(`${q.code} has no option “${r}” (options: ${(q.options ?? []).map((o) => `${o.code}=${plain(o.label).slice(0, 30)}`).join(", ")})`);
      if (!codes.includes(c!)) codes.push(c!);
    }
    if (codes.length > 1 && q.type !== "multi_select") fail(`${q.code} is single-choice — give it one correct answer, or make it a multiple choice question first`);
    // keep the stored type of the codes (numbers stay numbers)
    cur.correct = codes.map((c) => (q.options ?? []).find((o) => String(o.code) === c)!.code);
    parts.push(`correct ${codes.join(", ")}`);
  }
  for (const k of ["marks", "negativeMarks", "partialCredit", "topic", "subtopic", "difficulty", "explanation"] as const) {
    const v = a[k];
    if (v === null) { delete cur[k]; continue; }
    if (v === undefined) continue;
    if (k === "marks" && !((v as number) > 0)) fail("marks must be positive");
    (cur as Record<string, unknown>)[k] = v;
    parts.push(k === "marks" ? `+${v}` : k === "negativeMarks" ? `−${v}` : k === "explanation" ? "explanation" : `${k} ${v}`);
  }
  if (a.optionExplanations) {
    const m: Record<string, string> = { ...(cur.optionExplanations ?? {}) };
    for (const [ref, text] of Object.entries(a.optionExplanations)) {
      const c = resolveKeyOption(q, ref);
      if (c === null) { warnings.push(`${q.code}: no option “${ref}” to explain — skipped`); continue; }
      m[c] = text;
    }
    if (Object.keys(m).length) { cur.optionExplanations = m; parts.push("option explanations"); }
  }
  if (a.ungraded !== undefined) { if (a.ungraded) cur.ungraded = true; else delete cur.ungraded; parts.push(a.ungraded ? "ungraded" : "graded"); }
  if (!cur.correct?.length && !cur.ungraded) warnings.push(`${q.code} has no correct answer yet`);
  q.assessment = cur;
  if (!def.assessment) { def.assessment = AssessmentSettingsSchema.parse({}); parts.push("assessment switched on"); }
  return { description: `Answer key for ${q.code}${parts.length ? `: ${parts.join(", ")}` : ""}`, warnings, touched: [q.id] };
}

export function describeAssessmentAction(a: AssessmentAction): string {
  if (a.op === "set_assessment") return a.enabled === false ? "Switch the assessment off" : "Assessment settings";
  if (a.op === "clear_answer_key") return `Remove the answer key of ${a.target}`;
  return `Answer key for ${a.target}${a.correct ? ` (${a.correct.join(", ")})` : ""}`;
}

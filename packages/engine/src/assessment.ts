import type { Question, QuestionAssessment, SurveyDefinition } from "@rescript/schema";
import { AssessmentSettings as AssessmentSettingsSchema, type AssessmentSettings } from "@rescript/schema";

/**
 * ASSESSMENTS — deterministic scoring, the results report, item analysis,
 * validation and the respondent-payload stripping (2026-10-25,
 * docs/ASSESSMENTS-2026-10-25.md).
 *
 * Everything here is PURE: no clock, no randomness, no model. The same
 * definition and the same answers always produce the same result (the
 * runtime's save route, the sandbox store, the Studio's export and the unit
 * tests all call `scoreAssessment`). Production lesson (2026-10-24): "for
 * every question show the correct answer, what I selected, explanations and
 * weak areas" was sent to the model as one giant call and timed out twice —
 * none of it needs a model.
 */

export type AssessmentStatus = "correct" | "incorrect" | "partial" | "unattempted";

export interface AssessmentQuestionResult {
  id: string;
  code: string;
  variable: string;
  /** the question text (HTML as authored) — the report renders it without the definition */
  text: string;
  topic: string;
  subtopic?: string;
  multi: boolean;
  selected: string[];
  selectedLabels: string[];
  correct: string[];
  correctLabels: string[];
  status: AssessmentStatus;
  marks: number;
  maxMarks: number;
  /** 0..1 — the share of the question earned (partial credit), 0 when wrong or unattempted */
  credit: number;
  explanation?: string;
  /** "why the option you chose is wrong", when authored for that option */
  mistakeExplanation?: string;
}

export interface AssessmentTopicResult {
  topic: string;
  questions: number;
  attempted: number;
  correct: number;
  incorrect: number;
  partial: number;
  unattempted: number;
  /** percent of ATTEMPTED questions answered correctly (partial credit counted by its share); null when none attempted */
  accuracy: number | null;
  /** percent of ALL the topic's questions answered correctly */
  scoreRate: number;
  marks: number;
  maxMarks: number;
}

export interface AssessmentWeakArea { topic: string; accuracy: number; questions: number; correct: number; attempted: number; reason: string }
export interface AssessmentRecommendation { topic: string; subtopics: string[]; questions: string[]; reason: string }

export interface AssessmentResult {
  v: 1;
  title?: string;
  totalQuestions: number;
  attempted: number;
  correct: number;
  incorrect: number;
  partial: number;
  unattempted: number;
  marks: number;
  maxMarks: number;
  /** marks lost to negative marking */
  negative: number;
  /** marks / maxMarks × 100 (can be negative under negative marking) */
  percentage: number;
  passMark: number | null;
  passed: boolean | null;
  questions: AssessmentQuestionResult[];
  topics: AssessmentTopicResult[];
  weakAreas: AssessmentWeakArea[];
  recommendations: AssessmentRecommendation[];
  /** a short hash of the key the result was scored against — a re-score with a changed key is visible */
  keyFingerprint: string;
}

const r2 = (n: number) => Math.round(n * 100) / 100;
const plain = (s: string | undefined) => String(s ?? "").replace(/<[^>]*>/g, " ").replace(/&nbsp;/g, " ").replace(/\s+/g, " ").trim();
export const UNTAGGED_TOPIC = "General";

/* ------------------------------------------------------------ settings */

/** The paper's settings with defaults filled, or null when the survey is not an (enabled) assessment. */
export function assessmentSettings(def: Pick<SurveyDefinition, "assessment">): AssessmentSettings | null {
  const raw = def.assessment;
  if (!raw) return null;
  const parsed = AssessmentSettingsSchema.safeParse(raw);
  if (!parsed.success) return null;
  return parsed.data.enabled ? parsed.data : null;
}

export const isAssessment = (def: Pick<SurveyDefinition, "assessment">): boolean => assessmentSettings(def) !== null;

const GRADABLE = new Set(["single_select", "multi_select", "dropdown", "image_select"]);
const isMultiType = (q: Question) => q.type === "multi_select";

/** Questions that carry a key and count toward the score, in definition order. */
export function gradedQuestions(def: SurveyDefinition): Question[] {
  return def.questions.filter((q) => q.assessment && !q.assessment.ungraded);
}

function marksOf(q: Question, s: AssessmentSettings) {
  const a = q.assessment!;
  return {
    marks: a.marks ?? s.defaultMarks,
    negative: a.negativeMarks ?? s.defaultNegativeMarks,
    partial: a.partialCredit ?? s.partialCredit,
  };
}

/* ------------------------------------------------------------ answers */

/** Any stored answer shape → the list of selected option codes (strings). */
export function assessmentSelectedCodes(v: unknown): string[] {
  if (v === null || v === undefined || v === "") return [];
  if (Array.isArray(v)) return v.filter((x) => x !== null && x !== undefined && x !== "").map((x) => String(x));
  if (typeof v === "object") {
    // { code: true } maps from some multi renderers
    return Object.entries(v as Record<string, unknown>).filter(([, x]) => x === true || x === 1 || x === "1").map(([k]) => k);
  }
  return [String(v)];
}

const labelOf = (q: Question, code: string): string => {
  const o = (q.options ?? []).find((x) => String(x.code) === code);
  return o ? plain(o.label) : code;
};

/* ------------------------------------------------------------ scoring */

/**
 * Score one set of answers against the paper. `answers` is the response's
 * answers map (question id → value), exactly as the runtime stores it.
 */
export function scoreAssessment(def: SurveyDefinition, answers: Record<string, unknown>): AssessmentResult {
  const s = assessmentSettings(def) ?? AssessmentSettingsSchema.parse({});
  const questions: AssessmentQuestionResult[] = [];
  for (const q of gradedQuestions(def)) {
    const a = q.assessment as QuestionAssessment;
    const { marks: full, negative, partial } = marksOf(q, s);
    const correct = (a.correct ?? []).map(String);
    const selected = assessmentSelectedCodes(answers[q.id]);
    const multi = isMultiType(q) || correct.length > 1;
    let status: AssessmentStatus;
    let marks = 0;
    let credit = 0;
    if (!selected.length) status = "unattempted";
    else if (!multi) {
      const right = correct.includes(selected[0]);
      status = right ? "correct" : "incorrect";
      marks = right ? full : -negative;
      credit = right ? 1 : 0;
    } else {
      const hits = selected.filter((c) => correct.includes(c)).length;
      const wrong = selected.filter((c) => !correct.includes(c)).length;
      const exact = wrong === 0 && hits === correct.length && correct.length > 0;
      if (exact) { status = "correct"; marks = full; credit = 1; }
      else if (partial === "proportional" && hits - wrong > 0) { credit = (hits - wrong) / correct.length; status = "partial"; marks = full * credit; }
      else if (partial === "proportional_no_wrong" && wrong === 0 && hits > 0) { credit = hits / correct.length; status = "partial"; marks = full * credit; }
      else { status = "incorrect"; marks = -negative; }
    }
    const firstWrong = selected.find((c) => !correct.includes(c));
    const mistake = status !== "correct" && firstWrong !== undefined ? a.optionExplanations?.[firstWrong] : undefined;
    questions.push({
      id: q.id, code: String(q.code), variable: q.variableName, text: q.text ?? "",
      topic: (a.topic ?? "").trim() || UNTAGGED_TOPIC, ...(a.subtopic ? { subtopic: a.subtopic } : {}),
      multi, selected, selectedLabels: selected.map((c) => labelOf(q, c)), correct, correctLabels: correct.map((c) => labelOf(q, c)),
      status, marks: r2(marks), maxMarks: r2(full), credit: r2(credit),
      ...(a.explanation ? { explanation: a.explanation } : {}),
      ...(mistake ? { mistakeExplanation: mistake } : {}),
    });
  }
  const sum = (f: (x: AssessmentQuestionResult) => number) => questions.reduce((t, x) => t + f(x), 0);
  const marks = r2(sum((x) => x.marks));
  const maxMarks = r2(sum((x) => x.maxMarks));
  const passMark = s.passMarks ?? (s.passPercent !== undefined ? r2((maxMarks * s.passPercent) / 100) : null);
  const topics = topicBreakdown(questions);
  const weakAreas = weakAreasOf(topics, s);
  return {
    v: 1,
    ...(s.title ? { title: s.title } : {}),
    totalQuestions: questions.length,
    attempted: questions.filter((x) => x.status !== "unattempted").length,
    correct: questions.filter((x) => x.status === "correct").length,
    incorrect: questions.filter((x) => x.status === "incorrect").length,
    partial: questions.filter((x) => x.status === "partial").length,
    unattempted: questions.filter((x) => x.status === "unattempted").length,
    marks, maxMarks,
    negative: r2(-sum((x) => (x.marks < 0 ? x.marks : 0))),
    percentage: maxMarks > 0 ? r2((marks / maxMarks) * 100) : 0,
    passMark, passed: passMark === null ? null : marks >= passMark,
    questions, topics, weakAreas,
    recommendations: recommendationsOf(weakAreas, questions),
    keyFingerprint: assessmentKeyFingerprint(def),
  };
}

function topicBreakdown(questions: AssessmentQuestionResult[]): AssessmentTopicResult[] {
  const by = new Map<string, AssessmentQuestionResult[]>();
  for (const q of questions) { const l = by.get(q.topic) ?? []; l.push(q); by.set(q.topic, l); }
  return [...by.entries()].map(([topic, qs]) => {
    const attempted = qs.filter((x) => x.status !== "unattempted").length;
    const creditSum = qs.reduce((t, x) => t + x.credit, 0);
    return {
      topic, questions: qs.length, attempted,
      correct: qs.filter((x) => x.status === "correct").length,
      incorrect: qs.filter((x) => x.status === "incorrect").length,
      partial: qs.filter((x) => x.status === "partial").length,
      unattempted: qs.filter((x) => x.status === "unattempted").length,
      accuracy: attempted ? r2((creditSum / attempted) * 100) : null,
      scoreRate: r2((creditSum / qs.length) * 100),
      marks: r2(qs.reduce((t, x) => t + x.marks, 0)),
      maxMarks: r2(qs.reduce((t, x) => t + x.maxMarks, 0)),
    };
  });
}

function weakAreasOf(topics: AssessmentTopicResult[], s: AssessmentSettings): AssessmentWeakArea[] {
  const metric = (t: AssessmentTopicResult) => (s.weakCountsUnattempted ? t.scoreRate : t.accuracy ?? 0);
  return topics
    .filter((t) => (s.weakCountsUnattempted || t.attempted > 0) && metric(t) < s.weakThreshold)
    .sort((a, b) => metric(a) - metric(b) || b.questions - a.questions || a.topic.localeCompare(b.topic))
    .slice(0, s.maxWeakAreas)
    .map((t) => ({
      topic: t.topic, accuracy: metric(t), questions: t.questions, correct: t.correct, attempted: t.attempted,
      reason: `${t.correct} of ${t.questions} correct (${Math.round(metric(t))}%)${t.unattempted ? `, ${t.unattempted} not attempted` : ""}${t.incorrect ? `, ${t.incorrect} wrong` : ""} — below ${s.weakThreshold}%`,
    }));
}

function recommendationsOf(weak: AssessmentWeakArea[], questions: AssessmentQuestionResult[]): AssessmentRecommendation[] {
  return weak.map((w) => {
    const missed = questions.filter((q) => q.topic === w.topic && q.status !== "correct");
    const subtopics = [...new Set(missed.map((q) => q.subtopic).filter((x): x is string => !!x))];
    return {
      topic: w.topic, subtopics, questions: missed.map((q) => q.code),
      reason: subtopics.length
        ? `Revise ${w.topic}: ${subtopics.join(", ")} (${missed.length} question${missed.length === 1 ? "" : "s"} missed)`
        : `Revise ${w.topic} (${missed.length} question${missed.length === 1 ? "" : "s"} missed)`,
    };
  });
}

/** FNV-1a over the graded questions' keys and marks — stable across runs, cheap, not a security hash. */
export function assessmentKeyFingerprint(def: SurveyDefinition): string {
  const s = assessmentSettings(def);
  const src = JSON.stringify([s?.defaultMarks, s?.defaultNegativeMarks, s?.partialCredit, ...gradedQuestions(def).map((q) => [q.id, q.assessment?.correct, q.assessment?.marks, q.assessment?.negativeMarks, q.assessment?.partialCredit])]);
  let h = 0x811c9dc5;
  for (let i = 0; i < src.length; i++) { h ^= src.charCodeAt(i); h = Math.imul(h, 0x01000193) >>> 0; }
  return h.toString(16).padStart(8, "0");
}

/* ------------------------------------------------------------ what the respondent sees */

/**
 * The part of the result the RESPONDENT may see, per the paper's settings:
 * null when results are never shown; otherwise only the report sections that
 * are switched on. Per-question entries keep the question text and option
 * labels, so the report renders without the (stripped) definition.
 */
export function respondentAssessmentReport(def: SurveyDefinition, result: AssessmentResult): (Partial<AssessmentResult> & { v: 1; sections: AssessmentSettings["report"] }) | null {
  const s = assessmentSettings(def);
  if (!s || s.showResults === "never") return null;
  const sec = s.report;
  const only = s.reportQuestionIds?.length ? new Set(s.reportQuestionIds) : null;
  const out: Partial<AssessmentResult> & { v: 1; sections: AssessmentSettings["report"] } = { v: 1, sections: sec, ...(result.title ? { title: result.title } : {}), totalQuestions: result.totalQuestions };
  if (sec.summary) Object.assign(out, { attempted: result.attempted, correct: result.correct, incorrect: result.incorrect, partial: result.partial, unattempted: result.unattempted, marks: result.marks, maxMarks: result.maxMarks, negative: result.negative, percentage: result.percentage, passMark: result.passMark, passed: result.passed });
  if (sec.perQuestion) out.questions = result.questions.filter((q) => !only || only.has(q.id)).map((q) => {
    const { explanation, mistakeExplanation, ...rest } = q;
    return sec.explanations ? { ...rest, ...(explanation ? { explanation } : {}), ...(mistakeExplanation ? { mistakeExplanation } : {}) } : rest;
  });
  if (sec.topicBreakdown) out.topics = result.topics;
  if (sec.weakAreas) out.weakAreas = result.weakAreas;
  if (sec.recommendations) out.recommendations = result.recommendations;
  return out;
}

/* ------------------------------------------------------------ the answer key never reaches the browser */

/** Does this definition still carry an answer key or explanation anywhere a respondent could read it? */
export function assessmentSecretsPresent(def: SurveyDefinition): string[] {
  const found: string[] = [];
  for (const q of def.questions) {
    const a = q.assessment;
    if (a && ((a.correct?.length ?? 0) > 0 || a.explanation || (a.optionExplanations && Object.keys(a.optionExplanations).length))) found.push(`${q.code}.assessment`);
    if (a) for (const o of q.options ?? []) if (o.meta && ("correct" in o.meta || "explanation" in o.meta)) found.push(`${q.code}.options.${o.code}.meta`);
  }
  return found;
}

/**
 * The definition a RESPONDENT receives: every answer key, explanation and
 * per-option mistake note removed from graded questions (and from their
 * options' `meta.correct` / `meta.explanation`, the older quiz variant's key),
 * translations of those texts dropped, and `withheld: true` left behind so the
 * renderer knows a key exists. Marks, negative marks and topic tags stay —
 * an exam paper shows them.
 *
 * NOT stripped: a paper whose settings say `showResults: "per_question"`
 * (instant right/wrong after each answer necessarily needs the key in the
 * browser — the Studio warns about it), and a survey that is not an
 * assessment at all (the legacy gamified quiz variant keeps its behaviour).
 * Returns the same object when there is nothing to strip.
 */
export function stripAssessmentSecrets<T extends SurveyDefinition>(def: T): T {
  const s = assessmentSettings(def);
  const anyKey = (def.questions ?? []).some((q) => q.assessment);
  if (!anyKey) return def;
  if (s && s.showResults === "per_question") return def;
  const out = structuredClone(def) as T;
  for (const q of out.questions) {
    if (!q.assessment) continue;
    const a = q.assessment;
    q.assessment = {
      correct: [], withheld: true,
      ...(a.marks !== undefined ? { marks: a.marks } : {}),
      ...(a.negativeMarks !== undefined ? { negativeMarks: a.negativeMarks } : {}),
      ...(a.partialCredit ? { partialCredit: a.partialCredit } : {}),
      ...(a.topic ? { topic: a.topic } : {}),
      ...(a.subtopic ? { subtopic: a.subtopic } : {}),
      ...(a.difficulty ? { difficulty: a.difficulty } : {}),
      ...(a.ungraded ? { ungraded: true } : {}),
    } as QuestionAssessment;
    for (const o of q.options ?? []) {
      if (o.meta && ("correct" in o.meta || "explanation" in o.meta)) {
        const { correct: _c, explanation: _e, ...rest } = o.meta as Record<string, unknown>;
        o.meta = Object.keys(rest).length ? rest : undefined;
        if (!o.meta) delete o.meta;
      }
    }
  }
  // translations of the explanations (localization stores strings by path keys)
  const loc = (out as { localization?: { translations?: Record<string, Record<string, unknown>> } }).localization;
  if (loc?.translations && typeof loc.translations === "object") {
    for (const lang of Object.keys(loc.translations)) {
      const t = loc.translations[lang];
      if (!t || typeof t !== "object") continue;
      for (const k of Object.keys(t)) if (/assessment|explanation/i.test(k)) delete t[k];
    }
  }
  return out;
}

/**
 * The name the platform uses for the stripping (step 4A, 2026-10-29): what a
 * RESPONDENT may receive. Same function as `stripAssessmentSecrets`.
 */
export const stripAssessmentForRespondent = stripAssessmentSecrets;

/**
 * Property names that mean "this is the answer". Merged from the base's
 * scored-exam gate (apps/studio/lib/copilot/deliverable.ts, 25 Oct audit
 * remediation): the definition is served whole, so a key smuggled into
 * settings, meta_extensions, embedded data or a script is a leak too.
 */
const KEY_SHAPED = /^(answer_?key|answers?_?key|correct|correct_?answers?|correct_?codes?|correct_?options?|is_?correct|marking_?scheme|marking_?key|scoring_?key|answer_?sheet)$/i;
const emptyValue = (v: unknown) => v === undefined || v === null || v === false || v === "" || (Array.isArray(v) && v.length === 0);

/**
 * THE ONE LEAK CHECK (step 4A, 2026-10-29). Walks what a respondent would
 * actually be served — `stripAssessmentForRespondent(def)` — in full and
 * names every key-shaped property that still carries a value, every
 * assessment secret the stripper left (a paper on `per_question` results),
 * and every script whose source mentions an answer key. Empty list = safe to
 * serve. The base's `examKeyLeaks` (deliverable gate) is a thin wrapper.
 */
export function assessmentKeyLeaks(def: SurveyDefinition): string[] {
  const served = stripAssessmentForRespondent(def);
  const found: string[] = [];
  const seen = new Set<unknown>();
  const walk = (v: unknown, path: string): void => {
    if (!v || typeof v !== "object") return;
    if (seen.has(v)) return;
    seen.add(v);
    if (Array.isArray(v)) { v.forEach((x, i) => walk(x, `${path}[${i}]`)); return; }
    for (const [k, child] of Object.entries(v as Record<string, unknown>)) {
      if (KEY_SHAPED.test(k) && !emptyValue(child)) found.push(`${path}.${k} carries an answer key — the respondent is served this definition, so the key must be stripped or live outside it.`);
      walk(child, `${path}.${k}`);
    }
  };
  walk(served as unknown, "definition");
  for (const q of (served.questions ?? []) as Question[]) {
    const a = q.assessment;
    if (a && (a.explanation || (a.optionExplanations && Object.keys(a.optionExplanations).length))) found.push(`definition.questions.${q.code}.assessment carries an explanation — a respondent would read it before submitting.`);
  }
  /* a script can smuggle the key as text rather than as a property */
  for (const s of served.scripts ?? []) {
    const body = String((s as { code?: unknown }).code ?? "");
    if (/\banswer_?key\b|\bcorrectAnswer\b|\bmarkingScheme\b/i.test(body)) {
      found.push(`definition.scripts.${s.id ?? (s as { name?: string }).name ?? "?"} mentions an answer key in its source — a respondent can read every script.`);
    }
  }
  return found;
}

/* ------------------------------------------------------------ export columns */

const colName = (s: string) => s.normalize("NFKD").replace(/[^\w]+/g, "_").replace(/^_+|_+$/g, "").toUpperCase().slice(0, 40) || "TOPIC";

/**
 * The flat columns an export carries for one scored response: SCORE,
 * SCORE_MAX, PCT, PASS (1/0, empty without a pass mark), ATTEMPTED, CORRECT,
 * INCORRECT, UNATTEMPTED, <TOPIC>_SCORE / <TOPIC>_PCT and, per question,
 * <VAR>_CORRECT (1 correct, 0 wrong, the credit share when partial, empty
 * unattempted) and <VAR>_MARKS. Prefixed `ASMT_` when a name would collide
 * with one of the survey's own variables.
 */
export function assessmentColumns(def: SurveyDefinition, result: AssessmentResult | null | undefined): Record<string, number | null> {
  const out: Record<string, number | null> = {};
  const names = assessmentColumnNames(def);
  const pre = names.prefix;
  if (!result) { for (const n of names.columns) out[n] = null; return out; }
  out[`${pre}SCORE`] = result.marks;
  out[`${pre}SCORE_MAX`] = result.maxMarks;
  out[`${pre}PCT`] = result.percentage;
  out[`${pre}PASS`] = result.passed === null ? null : result.passed ? 1 : 0;
  out[`${pre}ATTEMPTED`] = result.attempted;
  out[`${pre}CORRECT`] = result.correct;
  out[`${pre}INCORRECT`] = result.incorrect;
  out[`${pre}UNATTEMPTED`] = result.unattempted;
  for (const t of result.topics) { out[`${pre}${colName(t.topic)}_SCORE`] = t.marks; out[`${pre}${colName(t.topic)}_PCT`] = t.scoreRate; }
  for (const q of result.questions) {
    out[`${q.variable}_CORRECT`] = q.status === "unattempted" ? null : q.status === "correct" ? 1 : q.status === "partial" ? q.credit : 0;
    out[`${q.variable}_MARKS`] = q.marks;
  }
  return out;
}

/** The column names (in order) an assessment export adds — the same for every row, so a CSV header is stable. */
export function assessmentColumnNames(def: SurveyDefinition): { prefix: string; columns: string[] } {
  const own = new Set<string>([...def.questions.map((q) => q.variableName.toUpperCase()), ...(def.calculations ?? []).map((c) => String(c.targetVariable ?? "").toUpperCase())]);
  const base = ["SCORE", "SCORE_MAX", "PCT", "PASS", "ATTEMPTED", "CORRECT", "INCORRECT", "UNATTEMPTED"];
  const prefix = base.some((b) => own.has(b)) ? "ASMT_" : "";
  const topics = [...new Set(gradedQuestions(def).map((q) => (q.assessment?.topic ?? "").trim() || UNTAGGED_TOPIC))];
  return {
    prefix,
    columns: [
      ...base.map((b) => prefix + b),
      ...topics.flatMap((t) => [`${prefix}${colName(t)}_SCORE`, `${prefix}${colName(t)}_PCT`]),
      ...gradedQuestions(def).flatMap((q) => [`${q.variableName}_CORRECT`, `${q.variableName}_MARKS`]),
    ],
  };
}

/* ------------------------------------------------------------ analytics: item analysis */

export interface ItemStat { id: string; code: string; topic: string; n: number; attempted: number; pValue: number | null; pointBiserial: number | null; flag?: string }
export interface AssessmentAnalytics {
  n: number;
  mean: number | null; median: number | null; sd: number | null; min: number | null; max: number | null;
  meanPct: number | null; passRate: number | null;
  /** percentage bins 0–10 … 90–100 (negative scores in the first bin) */
  distribution: { from: number; to: number; count: number }[];
  items: ItemStat[];
  topics: { topic: string; meanScoreRate: number }[];
}

/**
 * Score distribution and classical item analysis over scored responses:
 * difficulty (p-value: mean credit) and discrimination (corrected
 * item-total point-biserial: the item's credit against the total score
 * WITHOUT that item). Flags: too easy (p > .9), too hard (p < .2),
 * non-discriminating (r < .1) or negatively discriminating (r < 0 — check the
 * key).
 */
export function assessmentAnalytics(def: SurveyDefinition, results: AssessmentResult[]): AssessmentAnalytics {
  const n = results.length;
  const totals = results.map((r) => r.marks).sort((a, b) => a - b);
  const mean = n ? totals.reduce((a, b) => a + b, 0) / n : null;
  const sd = n > 1 && mean !== null ? Math.sqrt(totals.reduce((t, x) => t + (x - mean) ** 2, 0) / (n - 1)) : null;
  const median = n ? (n % 2 ? totals[(n - 1) / 2] : (totals[n / 2 - 1] + totals[n / 2]) / 2) : null;
  const distribution = Array.from({ length: 10 }, (_, i) => ({ from: i * 10, to: i * 10 + 10, count: 0 }));
  for (const r of results) distribution[Math.min(9, Math.max(0, Math.floor(r.percentage / 10)))].count++;
  const withPass = results.filter((r) => r.passed !== null);
  const items: ItemStat[] = gradedQuestions(def).map((q) => {
    const xs: number[] = []; const rest: number[] = []; let attempted = 0;
    for (const r of results) {
      const qr = r.questions.find((x) => x.id === q.id);
      if (!qr) continue;
      if (qr.status !== "unattempted") attempted++;
      xs.push(qr.credit); rest.push(r.marks - qr.marks);
    }
    const p = xs.length ? r2(xs.reduce((a, b) => a + b, 0) / xs.length) : null;
    const rpb = correlation(xs, rest);
    const flag = p === null ? undefined : rpb !== null && rpb < 0 ? "negative discrimination — check the key" : p > 0.9 ? "too easy" : p < 0.2 ? "too hard" : rpb !== null && rpb < 0.1 ? "does not discriminate" : undefined;
    return { id: q.id, code: String(q.code), topic: (q.assessment?.topic ?? "").trim() || UNTAGGED_TOPIC, n: xs.length, attempted, pValue: p, pointBiserial: rpb === null ? null : r2(rpb), ...(flag ? { flag } : {}) };
  });
  const topicNames = [...new Set(results.flatMap((r) => r.topics.map((t) => t.topic)))];
  return {
    n, mean: mean === null ? null : r2(mean), median: median === null ? null : r2(median), sd: sd === null ? null : r2(sd),
    min: n ? totals[0] : null, max: n ? totals[n - 1] : null,
    meanPct: n ? r2(results.reduce((t, r) => t + r.percentage, 0) / n) : null,
    passRate: withPass.length ? r2((withPass.filter((r) => r.passed).length / withPass.length) * 100) : null,
    distribution, items,
    topics: topicNames.map((topic) => {
      const rates = results.map((r) => r.topics.find((t) => t.topic === topic)?.scoreRate).filter((x): x is number => x !== undefined);
      return { topic, meanScoreRate: rates.length ? r2(rates.reduce((a, b) => a + b, 0) / rates.length) : 0 };
    }),
  };
}

function correlation(x: number[], y: number[]): number | null {
  const n = x.length;
  if (n < 3) return null;
  const mx = x.reduce((a, b) => a + b, 0) / n, my = y.reduce((a, b) => a + b, 0) / n;
  let sxy = 0, sxx = 0, syy = 0;
  for (let i = 0; i < n; i++) { sxy += (x[i] - mx) * (y[i] - my); sxx += (x[i] - mx) ** 2; syy += (y[i] - my) ** 2; }
  if (sxx === 0 || syy === 0) return null;
  return sxy / Math.sqrt(sxx * syy);
}

/* ------------------------------------------------------------ validation (test A, the planner, targeted repair) */

export type AssessmentIssueCode =
  | "not_enabled" | "count_mismatch" | "no_key" | "key_unknown_option" | "single_multi_key" | "unsupported_type" | "no_options"
  | "marks_invalid" | "negative_invalid" | "no_explanation" | "no_topic" | "pass_invalid" | "report_unknown_question" | "duplicate_code" | "too_few_options";

export interface AssessmentIssue { code: AssessmentIssueCode; message: string; questionId?: string; questionCode?: string }
export interface AssessmentValidation { ok: boolean; errors: AssessmentIssue[]; warnings: AssessmentIssue[]; graded: number; missingExplanations: string[]; missingTopics: string[] }

export interface AssessmentValidationOptions {
  /** exactly this many graded questions (default: settings.expectedQuestions, if set) */
  expectedCount?: number;
  requireExplanations?: boolean;
  requireTopics?: boolean;
  /** check only these question codes (a generation batch) — count / settings checks are skipped */
  scopeCodes?: string[];
  /** the settings must exist and be enabled (default true unless scoped) */
  requireSettings?: boolean;
  /** minimum options per graded question (default 2) */
  minOptions?: number;
}

/** Structured, deterministic validation of an assessment — each error names the question so a repair step can target it. */
export function validateAssessment(def: SurveyDefinition, opts: AssessmentValidationOptions = {}): AssessmentValidation {
  const errors: AssessmentIssue[] = [];
  const warnings: AssessmentIssue[] = [];
  const s = assessmentSettings(def);
  const scope = opts.scopeCodes?.length ? new Set(opts.scopeCodes.map((c) => c.toLowerCase())) : null;
  const requireSettings = opts.requireSettings ?? !scope;
  if (requireSettings && !s) errors.push({ code: "not_enabled", message: "the survey has no enabled assessment settings (set_assessment)" });
  const inScope = (q: Question) => !scope || scope.has(String(q.code).toLowerCase()) || scope.has(q.id.toLowerCase());
  const graded = gradedQuestions(def).filter(inScope);
  if (scope) for (const c of scope) if (!def.questions.some((q) => String(q.code).toLowerCase() === c || q.id.toLowerCase() === c)) errors.push({ code: "no_key", message: `question ${c} does not exist`, questionCode: c });
  const expected = scope ? undefined : opts.expectedCount ?? s?.expectedQuestions;
  if (expected !== undefined && graded.length !== expected) errors.push({ code: "count_mismatch", message: `the paper has ${graded.length} graded question${graded.length === 1 ? "" : "s"}, expected exactly ${expected}` });
  const seen = new Map<string, string>();
  const missingExplanations: string[] = [];
  const missingTopics: string[] = [];
  const minOptions = opts.minOptions ?? 2;
  for (const q of graded) {
    const a = q.assessment!;
    const at = { questionId: q.id, questionCode: String(q.code) };
    const codeKey = String(q.code).toLowerCase();
    if (seen.has(codeKey)) errors.push({ code: "duplicate_code", message: `${q.code} is used by two graded questions`, ...at });
    seen.set(codeKey, q.id);
    if (!GRADABLE.has(q.type)) { errors.push({ code: "unsupported_type", message: `${q.code} is a ${q.type} question — only single / multiple choice questions can be scored`, ...at }); continue; }
    const opts2 = (q.options ?? []).map((o) => String(o.code));
    if (!opts2.length) { errors.push({ code: "no_options", message: `${q.code} has no options`, ...at }); continue; }
    if (opts2.length < minOptions) errors.push({ code: "too_few_options", message: `${q.code} has ${opts2.length} option${opts2.length === 1 ? "" : "s"}, needs at least ${minOptions}`, ...at });
    const correct = (a.correct ?? []).map(String);
    if (!correct.length) errors.push({ code: "no_key", message: `${q.code} has no correct answer`, ...at });
    for (const c of correct) if (!opts2.includes(c)) errors.push({ code: "key_unknown_option", message: `${q.code}'s answer key names option ${c}, which does not exist (options: ${opts2.join(", ")})`, ...at });
    if (correct.length > 1 && q.type !== "multi_select") errors.push({ code: "single_multi_key", message: `${q.code} is single-choice but has ${correct.length} correct answers — keep one, or make it multiple choice`, ...at });
    const m = a.marks ?? s?.defaultMarks ?? 1;
    if (!(Number.isFinite(m) && m > 0)) errors.push({ code: "marks_invalid", message: `${q.code}'s marks must be a positive number`, ...at });
    const neg = a.negativeMarks ?? s?.defaultNegativeMarks ?? 0;
    if (!(Number.isFinite(neg) && neg >= 0 && neg <= m)) errors.push({ code: "negative_invalid", message: `${q.code}'s negative marks must be between 0 and its marks`, ...at });
    if (!plain(a.explanation)) { missingExplanations.push(q.id); (opts.requireExplanations ? errors : warnings).push({ code: "no_explanation", message: `${q.code} has no explanation`, ...at }); }
    if (!(a.topic ?? "").trim()) { missingTopics.push(q.id); (opts.requireTopics ? errors : warnings).push({ code: "no_topic", message: `${q.code} has no topic tag`, ...at }); }
    for (const k of Object.keys(a.optionExplanations ?? {})) if (!opts2.includes(k)) warnings.push({ code: "key_unknown_option", message: `${q.code} explains option ${k}, which does not exist`, ...at });
  }
  if (s && !scope) {
    const max = gradedQuestions(def).reduce((t, q) => t + (q.assessment!.marks ?? s.defaultMarks), 0);
    if (s.passMarks !== undefined && (s.passMarks > max || s.passMarks < 0)) errors.push({ code: "pass_invalid", message: `the pass mark ${s.passMarks} is outside 0…${r2(max)}` });
    for (const id of s.reportQuestionIds ?? []) if (!def.questions.some((q) => q.id === id)) errors.push({ code: "report_unknown_question", message: `the report names question ${id}, which does not exist`, questionId: id });
    if (s.showResults === "per_question") warnings.push({ code: "not_enabled", message: "results per question reveal the answer key in the respondent's browser — use 'after submit' for an exam" });
  }
  return { ok: errors.length === 0, errors, warnings, graded: graded.length, missingExplanations, missingTopics };
}

/** What the respondent's results page renders (the server's result filtered by the paper's report settings). */
export type RespondentAssessmentReport = NonNullable<ReturnType<typeof respondentAssessmentReport>>;

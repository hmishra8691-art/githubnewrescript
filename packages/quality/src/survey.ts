import type { Question, SurveyDefinition, Option } from "@rescript/schema";
import { conditionRefs, listPages, questionOrder } from "@rescript/engine";
import { agreementPolarity, normalizeText, words } from "./metrics.js";

/**
 * What the rules need to know about a survey's questions, derived once per
 * assessment from the definition. This is the "semantic survey intelligence"
 * layer: it reads the survey's own structure — types, scales, display logic,
 * skip logic, piping, blocks — and never guesses at meaning it cannot see.
 */

export const SINGLE = new Set(["single_select", "dropdown", "image_select", "nps"]);
export const MULTI = new Set(["multi_select", "multi_dropdown"]);
export const OPEN = new Set(["open_text", "long_text"]);
export const MATRIX_SINGLE = new Set(["matrix_single", "matrix_dropdown"]);
export const NON_RESPONDENT = new Set(["html", "hidden", "calculated", "embedded_data", "custom_component"]);

export const isSingle = (q: Question) => SINGLE.has(q.type) && q.options.length > 0;
export const isMulti = (q: Question) => MULTI.has(q.type) && q.options.length > 0;
export const isOpen = (q: Question) => OPEN.has(q.type) || (q.type === "text_list");
export const isMatrix = (q: Question) => MATRIX_SINGLE.has(q.type) && q.rows.length > 0 && q.options.length > 0;
export const isClosed = (q: Question) => isSingle(q) || isMulti(q) || isMatrix(q) || q.type === "slider" || q.type === "numeric";
export const isRespondentQuestion = (q: Question) => !NON_RESPONDENT.has(q.type);

/** Ordered respondent-facing questions with their page. */
export interface PlacedQuestion { q: Question; pageId: string; pageIndex: number; blockPath: string[] }

export function placedQuestions(def: SurveyDefinition): PlacedQuestion[] {
  const byId = new Map(def.questions.map((q) => [q.id, q]));
  const out: PlacedQuestion[] = [];
  const pages = listPages(def.flow as any[]);
  pages.forEach((p, i) => {
    for (const id of p.node.questionIds) {
      const q = byId.get(id);
      if (q && isRespondentQuestion(q)) out.push({ q, pageId: p.node.id, pageIndex: i, blockPath: [] });
    }
  });
  // questions not placed on any page still exist (e.g. hidden) — leave them out of behavioural rules
  return out;
}

export function pageQuestionIds(def: SurveyDefinition): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  for (const p of listPages(def.flow as any[])) out[p.node.id] = p.node.questionIds;
  return out;
}

/** Non-substantive options: don't know / prefer not to say / other / none. */
export function isNonSubstantive(o: Option): boolean {
  if (o.flags?.some((f) => ["dont_know", "refused", "other_specify", "none_of_above"].includes(f))) return true;
  const l = normalizeText(o.label);
  return /^(don t know|dont know|do not know|not sure|prefer not to say|prefer not to answer|no opinion|not applicable|n a|none of the above|other)\b/.test(l);
}

/** Option position 0..n-1 of a code, or null. */
export function optionIndex(q: Question, code: unknown): number | null {
  const i = q.options.findIndex((o) => String(o.code) === String(code));
  return i >= 0 ? i : null;
}

/** Whether a question's options read as an ordered scale (agree…disagree, 1…5, poor…excellent). */
export function isScale(q: Question): boolean {
  if (q.type === "nps" || q.type === "slider") return true;
  if (q.options.length < 3 || q.options.length > 11) return false;
  const nums = q.options.every((o) => /^\d+$/.test(String(o.code)));
  const polar = q.options.map((o) => agreementPolarity(o.label)).filter((x) => x !== 0).length >= 2;
  return polar || (nums && q.options.length >= 4 && isMatrix(q)) || (nums && q.options.some((o) => agreementPolarity(o.label) !== 0));
}

/** Middle index for odd-length scales; null otherwise. */
export function midpointIndex(q: Question): number | null {
  const n = q.options.length;
  return n >= 3 && n % 2 === 1 ? (n - 1) / 2 : null;
}

/** A row whose wording is reversed relative to the others (negations). */
export function isReverseWorded(label: string): boolean {
  const l = normalizeText(label);
  return /\b(not|never|no longer|dislike|hate|unhappy|difficult|hard to|worse|poor|rarely|fail|fails|failed|waste|useless|avoid|don t|doesn t|isn t|can t|cannot|unlikely|disagree)\b/.test(l);
}

/** Row polarity of a grid: +1 normal, -1 reverse-worded. */
export function rowPolarities(q: Question): number[] {
  return q.rows.map((r) => (isReverseWorded(r.label) ? -1 : 1));
}

/**
 * Screening questions: those whose skip logic or an enclosing branch can end
 * the survey with status `screened`/`terminated` (or that a quota check
 * follows). Screener gaming and screener speed rules look only at these.
 */
export function screenerQuestionIds(def: SurveyDefinition): Set<string> {
  const out = new Set<string>();
  for (const q of def.questions) {
    for (const r of q.skipLogic ?? []) {
      const t = r.target;
      if (t.kind === "terminate" || (t.kind === "end" && (t.status === "screened" || t.status === "terminated")) || t.kind === "url") {
        out.add(q.id);
        conditionRefs(def, r.when, out);
      }
    }
  }
  const walk = (nodes: any[]) => {
    for (const n of nodes ?? []) {
      if (n?.type === "branch") {
        const endsInScreen = (kids: any[]) => (kids ?? []).some((k) => k?.type === "end" && (k.status === "screened" || k.status === "terminated"));
        for (const b of n.branches ?? []) {
          if (endsInScreen(b.children)) conditionRefs(def, b.when, out);
          walk(b.children);
        }
        if (endsInScreen(n.otherwise)) for (const b of n.branches ?? []) conditionRefs(def, b.when, out);
        walk(n.otherwise);
      }
      if (n?.type === "quota_check") {
        for (const qid of n.quotaIds ?? []) {
          const quota = def.quotas.find((x) => x.id === qid);
          for (const cell of quota?.cells ?? []) conditionRefs(def, (cell as any).when, out);
        }
      }
      if (n?.children) walk(n.children);
    }
  };
  walk(def.flow as any[]);
  return out;
}

/** Words a respondent could reasonably echo: the question text + option/row labels. */
export function questionVocabulary(q: Question): Set<string> {
  const ws = new Set<string>();
  for (const w of words(q.text)) if (w.length > 3) ws.add(w);
  for (const o of q.options) for (const w of words(o.label)) if (w.length > 3) ws.add(w);
  for (const r of q.rows) for (const w of words(r.label)) if (w.length > 3) ws.add(w);
  return ws;
}

/** Word count of everything shown on a page (question texts, instructions, options, rows). */
export function pageWordCount(def: SurveyDefinition, questionIds: string[]): number {
  let n = 0;
  for (const id of questionIds) {
    const q = def.questions.find((x) => x.id === id);
    if (!q) continue;
    n += words(q.text).length + words(q.instruction ?? "").length;
    for (const o of q.options) n += words(o.label).length;
    for (const r of q.rows) n += words(r.label).length;
  }
  return n;
}

/**
 * Estimated honest answering time for a page, in seconds, from the definition
 * alone: reading at 250 wpm plus a per-decision cost. Used when there are too
 * few peers to have a median.
 */
export function estimatePageSeconds(def: SurveyDefinition, questionIds: string[]): number {
  const readSec = (pageWordCount(def, questionIds) / 250) * 60;
  let decide = 0;
  for (const id of questionIds) {
    const q = def.questions.find((x) => x.id === id);
    if (!q || !isRespondentQuestion(q)) continue;
    if (isMatrix(q)) decide += q.rows.length * 1.5;
    else if (isOpen(q)) decide += 12;
    else if (isMulti(q)) decide += 3;
    else if (q.type === "ranking" || q.type === "allocation") decide += q.options.length * 1.5;
    else decide += 2;
  }
  return Math.max(1.5, readSec + decide);
}

export function estimateQuestionSeconds(q: Question): number {
  const readSec = ((words(q.text).length + q.options.reduce((s, o) => s + words(o.label).length, 0)) / 250) * 60;
  if (isMatrix(q)) return readSec + q.rows.length * 1.5;
  if (isOpen(q)) return readSec + 12;
  if (isMulti(q)) return readSec + 3;
  return readSec + 2;
}

export const orderedIds = (def: SurveyDefinition) => questionOrder(def);

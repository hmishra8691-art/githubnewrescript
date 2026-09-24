import type { SurveyDefinition } from "@rescript/schema";
import { getQuestionByCodeOrVar } from "@rescript/engine";
import { simulateRespondent } from "@rescript/templates";

/**
 * DEBUG MODE — "with these answers, where does a respondent go?"
 *
 * The programmer types hypothetical answers ("Q2=A, Q1=30, Q11=1|3") and a
 * headless respondent WALKS the survey with them, through the real engine —
 * start, visibleQuestions, setAnswer, validatePage, advance — so branches,
 * display logic, loops AND skip jumps (which happen at navigation, not at
 * compile) all take effect. Questions the answers do not cover get the
 * engine's default answer, the same as the test-data generator uses. The
 * canvas then lights the path and dims the rest.
 */

export interface DebugResult {
  /** page ids in the order they were visited (a loop repeats a page) */
  pageIds: string[];
  /** question ids shown along the way */
  questionIds: Set<string>;
  endStatus: string | null;
  /** answers that named an unknown question */
  unknown: string[];
  applied: number;
  /** the walk did not reach an end within the page guard */
  truncated: boolean;
}

/** "Q2=A, Q1=30, Q11=1|3 ; Q5 = yes" → pairs; `|` separates a multi-select's codes */
export function parseAnswers(text: string): [string, string | string[]][] {
  const out: [string, string | string[]][] = [];
  for (const part of text.split(/[,;\n]+/)) {
    const m = /^\s*([A-Za-z_][\w.]*)\s*[=:]\s*(.+?)\s*$/.exec(part);
    if (!m) continue;
    const raw = m[2].trim();
    out.push([m[1], raw.includes("|") ? raw.split("|").map((x) => x.trim()).filter(Boolean) : raw]);
  }
  return out;
}

/** a typed value into what the question stores: an option code (by code or label), a number, a list */
export function coerceAnswer(def: SurveyDefinition, qid: string, v: string | string[]): unknown {
  const q = def.questions.find((x) => x.id === qid);
  const one = (s: string): unknown => {
    const opt = q?.options?.find((o) => String(o.code) === s || (o.label ?? "").toLowerCase() === s.toLowerCase());
    if (opt) return typeof opt.code === "number" ? opt.code : (/^-?\d+(\.\d+)?$/.test(String(opt.code)) ? Number(opt.code) : opt.code);
    if (/^-?\d+(\.\d+)?$/.test(s)) return Number(s);
    if (/^(yes|true)$/i.test(s)) return 1;
    if (/^(no|false)$/i.test(s)) return 2;
    return s;
  };
  if (Array.isArray(v)) return v.map(one);
  if (q && /multi/.test(q.type)) return [one(v)];
  return one(v);
}

export function debugPath(def: SurveyDefinition, answersText: string): DebugResult {
  const answers: Record<string, unknown> = {};
  const unknown: string[] = [];
  let applied = 0;
  for (const [name, v] of parseAnswers(answersText)) {
    const q = getQuestionByCodeOrVar(def, name);
    if (!q) { unknown.push(name); continue; }
    answers[q.id] = coerceAnswer(def, q.id, v);
    applied++;
  }
  const maxPages = 400;
  try {
    const r = simulateRespondent(def, { answers, seed: 1, maxPages });
    const questionIds = new Set<string>();
    for (const p of r.pages) for (const id of p.questionIds) questionIds.add(id);
    return {
      pageIds: r.pages.map((p) => p.pageId),
      questionIds,
      endStatus: r.endStatus ?? null,
      unknown, applied,
      truncated: r.pages.length >= maxPages,
    };
  } catch {
    return { pageIds: [], questionIds: new Set(), endStatus: null, unknown, applied, truncated: false };
  }
}

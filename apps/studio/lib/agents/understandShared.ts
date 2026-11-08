import type { Launcher } from "./launch.ts";

/**
 * The client-safe half of lib/agents/understand.ts: the reading's shape, and folding a clarification's answer back
 * into the fields. No reader here (they pull in server code); the launcher imports only this.
 */
export interface Clarification { key: string; question: string; suggestions?: string[] }
export interface Understanding {
  launcher: Launcher["id"] | null;
  fields: Record<string, string>;
  /** what was read from the sentence, in plain words */
  understood: string[];
  /** assumptions made to fill a gap — shown, never hidden */
  assumptions: string[];
  /** what must be answered before starting */
  questions: Clarification[];
  confidence: "high" | "medium" | "low";
  /** other agents the sentence could also mean */
  alternatives: Launcher["id"][];
}

/** closed questions a respondent answers in a minute — the usual rule of thumb for a length of interview */
export const QPM = 3;
export const loiOf = (t: string): number | null => {
  const m = /\b(\d{1,3})\s*[- ]?(?:min(?:ute)?s?)\b(?:\s*(?:loi|length|interview|survey|questionnaire))?|\bloi\s*(?:of\s*)?(\d{1,3})\b/i.exec(t);
  const n = Number(m?.[1] ?? m?.[2]);
  return Number.isFinite(n) && n > 0 && n <= 120 ? n : null;
};

/** a clarification's answer, folded back into the fields (a "10-minute LOI" answer becomes a count) */
export function applyAnswer(u: Understanding, key: string, answer: string): Understanding {
  const a = answer.trim();
  if (!a) return u;
  const fields = { ...u.fields };
  const assumptions = [...u.assumptions];
  if (key === "count") {
    const loi = loiOf(a);
    const n = /^\d+$/.test(a) ? Number(a) : loi ? Math.max(10, Math.min(120, Math.round(loi * QPM))) : NaN;
    if (!Number.isFinite(n)) return u;
    fields.count = String(n);
    if (loi && !/^\d+$/.test(a)) assumptions.push(`About ${n} questions for a ${loi}-minute interview.`);
  } else if (key === "language") fields.language = a;
  else return u;
  return { ...u, fields, assumptions, questions: u.questions.filter((q) => q.key !== key), confidence: "high" };
}

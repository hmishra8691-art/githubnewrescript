import type { Question, SurveyDefinition } from "@rescript/schema";
import { questionOrder } from "./dependencies.js";

/**
 * QUESTION NUMBERS AND OPTION LETTERS SHOWN TO RESPONDENTS (audit 2026-11-07) — `branding.layout.questionNumbers`
 * ("code" | "sequence") and `branding.layout.optionNumbering` ("letters" | "numbers"). Pure: the renderer asks,
 * the export never changes (codes and values are untouched; these are display only).
 */
const NOT_NUMBERED = new Set(["html", "calculated", "hidden", "embedded_data"]);
const SEQ = new WeakMap<SurveyDefinition, Map<string, number>>();

/** "Q7." / "3." / "" for a question, per the survey's setting */
export function questionNumberLabel(def: SurveyDefinition, q: Pick<Question, "id" | "code" | "type" | "settings">): string {
  const mode = (def.branding?.layout as { questionNumbers?: string } | undefined)?.questionNumbers ?? "none";
  if (mode === "none" || NOT_NUMBERED.has(q.type) || (q.settings as { hidden?: boolean } | undefined)?.hidden) return "";
  if (mode === "code") return `${q.code}.`;
  let seq = SEQ.get(def);
  if (!seq) {
    seq = new Map();
    let n = 0;
    for (const id of questionOrder(def)) {
      const x = def.questions.find((y) => y.id === id);
      if (x && !NOT_NUMBERED.has(x.type) && !(x.settings as { hidden?: boolean } | undefined)?.hidden) seq.set(id, ++n);
    }
    SEQ.set(def, seq);
  }
  const n = seq.get(q.id);
  return n ? `${n}.` : "";
}

/** "A." / "1." / "" for the option at `index` in the list as shown */
export function optionNumberLabel(def: SurveyDefinition, index: number): string {
  const mode = (def.branding?.layout as { optionNumbering?: string } | undefined)?.optionNumbering ?? "none";
  if (mode === "numbers") return `${index + 1}.`;
  if (mode === "letters") {
    let i = index, s = "";
    do { s = String.fromCharCode(65 + (i % 26)) + s; i = Math.floor(i / 26) - 1; } while (i >= 0);
    return `${s}.`;
  }
  return "";
}

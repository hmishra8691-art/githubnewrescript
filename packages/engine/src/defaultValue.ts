import type { Question } from "@rescript/schema";
import { effectiveResponseModel } from "@rescript/schema";
import type { EvalContext } from "./evaluate.js";
import type { AnswerValue } from "./state.js";
import { effectiveQuestion } from "./carryforward.js";
import { resolveOptionValue, type OptionList } from "./optionCodes.js";
import { resolvePiping } from "./piping.js";

/**
 * A QUESTION'S DEFAULT VALUE (`settings.defaultValue`, set in Properties or by
 * the copilot's `set_default_value`) is the answer the question starts with.
 *
 * It is written into the response the first time the question is shown, and
 * only if the question has no answer yet, so it never overwrites something the
 * respondent typed. It is written ONCE per question: a respondent who clears it
 * and comes back finds it still cleared. The default is read as the question
 * reads answers: a number for a numeric question, text for a text question,
 * option CODES for a choice question (a label or "option 2" is resolved to its
 * code, and only options the question actually shows can be chosen). A piped
 * default (`{{Q1}}`) is read from the answers so far. A default
 * that does not fit the question is ignored rather than stored.
 */
export function defaultAnswerFor(q: Question, ctx: EvalContext): AnswerValue | null {
  const stored = (q.settings as { defaultValue?: unknown } | undefined)?.defaultValue;
  if (stored === undefined || stored === null || stored === "") return null;
  // "static, or {{Q1}} piped" (the Properties field): a piped default is read from the answers so far
  const raw = typeof stored === "string" && stored.includes("{{") ? resolvePiping(stored, ctx).trim() : stored;
  if (raw === "") return null;
  const model = effectiveResponseModel(q);
  if (model === "numeric") {
    const n = typeof raw === "number" ? raw : Number(String(raw).trim());
    return Number.isFinite(n) && String(raw).trim() !== "" ? n : null;
  }
  if (model === "text") return typeof raw === "string" || typeof raw === "number" ? String(raw) : null;
  if (model === "single_choice" || model === "multiple_choice") {
    const options = effectiveQuestion(q, ctx).options as OptionList;
    const wanted = Array.isArray(raw) ? raw : model === "multiple_choice" && typeof raw === "string" ? raw.split(/\s*[,;]\s*/).filter(Boolean) : [raw];
    const codes: (string | number)[] = [];
    for (const w of wanted) {
      const r = resolveOptionValue(options, w);
      if (r.kind === "code" && !codes.some((c) => String(c) === String(r.code))) codes.push(r.code);
    }
    if (!codes.length) return null;
    return (model === "multiple_choice" ? codes : codes[0]) as AnswerValue;
  }
  return null;
}

const APPLIED = "defaultsApplied";

/** fill the defaults of the questions about to be shown; the keys it wrote */
export function applyDefaultValues(questions: Question[], ctx: EvalContext, answerKeyFor: (q: Question) => string): string[] {
  const filled: string[] = [];
  for (const q of questions) {
    if ((q.settings as { defaultValue?: unknown } | undefined)?.defaultValue === undefined) continue;
    const key = answerKeyFor(q);
    const meta = (ctx.state.meta ??= {});
    const done = (Array.isArray(meta[APPLIED]) ? meta[APPLIED] : []) as string[];
    if (done.includes(key)) continue;
    const a = ctx.state.answers[key];
    const empty = a === undefined || a === null || a === "" || (Array.isArray(a) && a.length === 0);
    if (!empty) { meta[APPLIED] = [...done, key]; continue; }
    const v = defaultAnswerFor(q, ctx);
    if (v === null) continue;
    ctx.state.answers[key] = v;
    meta[APPLIED] = [...done, key];
    filled.push(key);
  }
  return filled;
}

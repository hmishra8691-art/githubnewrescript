import type { SurveyDefinition, Question, ProbeConfig } from "@rescript/schema";
import type { ResponseState } from "./state.js";
import { evaluateCondition, type EvalContext } from "./evaluate.js";
import { resolvePiping } from "./piping.js";

/**
 * FOLLOW-UP PROBES — the pure half. What the runtime shows and when is decided
 * here; the runtime only asks "is another probe due?", renders the synthetic
 * question this module hands back, and stores the answer under the keys this
 * module names. The AI wording (when there is one) comes from the runtime's
 * provider through `/api/session/probe`; a fixed wording is rendered here.
 *
 * ## Storage
 *
 *   state.answers[`${q.id}__probe_${n}`]    the respondent's n-th follow-up answer
 *   state.answers[`${q.id}__probe_${n}_q`]  the wording that was asked for it
 *
 * Side keys beside the answer, exactly like `__other` and the gamified
 * `__correct` / `__rt`: the ordinary save persists them, resume restores them,
 * and `flattenVariables` maps them to `Q5_PROBE_n` / `Q5_PROBE_n_Q`, which the
 * dictionary declares up front. `__probe_n` does not match `startsWith("q5@")`,
 * so the generic flatten of loop-suffixed answers never touches them.
 *
 * ## Why probes are not questions in the definition
 *
 * A probe's wording may be generated per respondent, its count varies per
 * respondent, and it must never move the flow. A flow node would put the
 * step index, the progress bar, back navigation and every suite that counts
 * pages at the mercy of a value the definition does not contain. A side key
 * beside the answer is what varies-per-respondent data already looks like in
 * this platform.
 */

export const PROBE_TYPES = ["open_text", "long_text"] as const;

export function probeAnswerKey(qid: string, n: number): string { return `${qid}__probe_${n}`; }
export function probePromptKey(qid: string, n: number): string { return `${qid}__probe_${n}_q`; }

/** One asked follow-up: the wording and the answer (answer undefined = shown, not yet answered). */
export interface ProbeTurn { n: number; prompt: string; answer: unknown }

/** The follow-ups already asked for a question, in order. */
export function probeTranscript(state: ResponseState, qid: string): ProbeTurn[] {
  const out: ProbeTurn[] = [];
  for (let n = 1; n <= 5; n++) {
    const prompt = state.answers[probePromptKey(qid, n)];
    if (typeof prompt !== "string") break;
    out.push({ n, prompt, answer: state.answers[probeAnswerKey(qid, n)] });
  }
  return out;
}

/** The text of the probed answer, whatever shape the open end stored it in. */
export function probeSourceText(value: unknown): string {
  if (value == null) return "";
  if (typeof value === "string") return value.trim();
  if (typeof value === "object") {
    return Object.values(value as Record<string, unknown>).map((x) => (x == null ? "" : String(x))).filter(Boolean).join("\n").trim();
  }
  return String(value).trim();
}

const wordCount = (s: string) => (s.match(/\S+/g) ?? []).length;

/**
 * The text a probe is ABOUT, for any question: an open end's text, or the
 * label(s) of a coded answer ("Dissatisfied" for code 2), so a follow-up on a
 * satisfaction scale reads the words the respondent saw, not the code.
 */
export function probeSourceTextFor(q: Question, value: unknown): string {
  const labelOf = (code: unknown) => q.options.find((o) => String(o.code) === String(code))?.label.replace(/<[^>]*>/g, "").trim();
  if (q.options?.length && (typeof value === "string" || typeof value === "number")) return labelOf(value) ?? String(value);
  if (q.options?.length && Array.isArray(value)) return value.map((v) => labelOf(v) ?? String(v)).filter(Boolean).join(", ");
  if (q.type === "nps" || q.type === "numeric" || q.type === "slider") return value == null || value === "" ? "" : `${value}`;
  return probeSourceText(value);
}

/**
 * IS ANOTHER FOLLOW-UP DUE for this question? Returns its number, or null.
 *
 * Due when: the question has a probe; the answer is non-empty and long
 * enough; `when` holds (or is absent); fewer than `maxProbes` have been
 * asked; and `stopWhen` does not hold. Evaluated against the whole response,
 * so a probe can depend on anything logic can.
 */
export function nextProbe(q: Question, ctx: EvalContext, probe: ProbeConfig | null | undefined = q.probe): number | null {
  const p = probe;
  if (!p) return null;
  const text = probeSourceTextFor(q, ctx.state.answers[q.id]);
  if (!text) return null;
  if (p.minWords > 0 && wordCount(text) < p.minWords) return null;
  const asked = probeTranscript(ctx.state, q.id);
  if (asked.length >= p.maxProbes) return null;
  if (p.when && !evaluateCondition(p.when, ctx)) return null;
  if (p.stopWhen && evaluateCondition(p.stopWhen, ctx)) return null;
  return asked.length + 1;
}

/** Every question on a page with a follow-up due, in page order. */
export function dueProbes(questions: Question[], ctx: EvalContext, probeOf?: (q: Question) => ProbeConfig | null | undefined): { q: Question; n: number; probe: ProbeConfig }[] {
  const out: { q: Question; n: number; probe: ProbeConfig }[] = [];
  for (const q of questions) {
    const probe = probeOf ? probeOf(q) : q.probe;
    const n = nextProbe(q, ctx, probe);
    if (n && probe) out.push({ q, n, probe });
  }
  return out;
}

/** Is the wording fixed in the definition (true) or written by the provider (false)? */
export function probeHasFixedPrompt(p: ProbeConfig): boolean {
  return !!(p.prompt ?? "").trim();
}

/** Render a fixed wording: `{answer}` first, then ordinary piping. */
export function renderFixedProbe(p: ProbeConfig, sourceText: string, ctx: EvalContext): string {
  const raw = (p.prompt ?? "").replace(/\{answer\}/gi, sourceText);
  return resolvePiping(raw, ctx);
}

/**
 * THE SYNTHETIC QUESTION the runtime renders for one follow-up. A long_text
 * whose id IS the storage key, so the ordinary `QuestionRenderer` and the
 * ordinary `validatePage` work on it unchanged. It is never written into the
 * definition; it exists for the duration of one screen.
 */
export function probeQuestion(q: Question, n: number, prompt: string, probe: ProbeConfig | null | undefined = q.probe): Question {
  return {
    ...q,
    id: probeAnswerKey(q.id, n),
    code: `${q.code}_PROBE_${n}`,
    variableName: `${q.variableName}_PROBE_${n}`,
    type: "long_text",
    variant: undefined,
    text: prompt,
    instruction: undefined,
    required: probe?.required ?? false,
    options: [],
    rows: [],
    columns: [],
    displayLogic: undefined,
    skipLogic: [],
    punches: [],
    probe: undefined,
    ai: undefined,
    spoken: undefined,
    attentionCheck: undefined,
    carryForward: undefined,
    customJs: undefined,
    customCss: undefined,
    customHtml: undefined,
    settings: { ...q.settings, expression: undefined, hidden: false, readOnly: false, defaultValue: undefined, placeholder: "Your answer" },
  } as Question;
}

/** Record a shown follow-up's wording and (later) its answer. */
export function recordProbePrompt(state: ResponseState, qid: string, n: number, prompt: string): void {
  state.answers[probePromptKey(qid, n)] = prompt;
}

/** Forget a follow-up that was shown but abandoned (the respondent went Back). */
export function forgetProbe(state: ResponseState, qid: string, n: number): void {
  delete state.answers[probePromptKey(qid, n)];
  delete state.answers[probeAnswerKey(qid, n)];
}

/** Problems a programmer can fix, in words, for one question. */
export function lintProbeQuestion(q: Question): string[] {
  const out: string[] = [];
  const p = q.probe;
  if (!p) return out;
  if (!(PROBE_TYPES as readonly string[]).includes(q.type)) {
    out.push(`A follow-up probe asks about an open end; ${q.code} is ${q.type}. Put the probe on the text question, or use display logic for a fixed follow-up question.`);
  }
  if (!probeHasFixedPrompt(p) && !(p.instruction ?? "").trim()) {
    out.push(`The probe has neither a fixed wording nor an instruction for the AI, so it will ask a generic "tell me more". Give it one or the other.`);
  }
  if (probeHasFixedPrompt(p) && p.maxProbes > 1) {
    out.push(`A fixed wording is asked ${p.maxProbes} times word for word. Use one probe, or leave the wording blank so each follow-up differs.`);
  }
  return out;
}

/** The same, across the survey, prefixed with the question code — for the survey-wide logic check. */
export function lintProbes(def: SurveyDefinition): string[] {
  return def.questions.flatMap((q) => lintProbeQuestion(q).map((m) => `${q.code}: ${m}`));
}

/* -------------------------------------------------------- the fake writer */

/**
 * THE FAKE PROBE WRITER — deterministic wording for the fake provider. Quotes
 * the first clause of the answer on the first turn, then asks fixed follow-up
 * questions, so a suite can assert the exact text and a developer can watch
 * the mechanism without a key.
 */
export function fakeProbe(sourceText: string, n: number, instruction?: string): string {
  const clause = sourceText.split(/[.!?\n]/)[0].trim().slice(0, 60);
  if (n === 1) return `You mentioned “${clause}”. Could you tell me a bit more about that?`;
  if (n === 2) return instruction ? `Thanks. Thinking about ${instruction.toLowerCase().replace(/[.]+$/, "")} — what else comes to mind?` : "Thanks. What would have made that better?";
  return "Is there anything else you would like to add?";
}

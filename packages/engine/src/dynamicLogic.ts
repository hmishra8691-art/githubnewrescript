import type { Option, Question, SurveyDefinition } from "@rescript/schema";
import { evaluateExpression, validateExpression } from "./calc.js";
import { calcOptionsFor, noteCalcOutcome } from "./calcContext.js";
import type { EvalContext } from "./evaluate.js";
import { createResponseState, getQuestionByCodeOrVar } from "./state.js";
import { questionOrder } from "./dependencies.js";
import { expressionNames } from "./exprNames.js";
export { expressionNames };

/**
 * DYNAMIC TEXT AND OPTIONS BY TERNARY LOGIC (2026-11-07).
 *
 *   question.dynamicText.expression     → the text shown (it may pipe: "About {{Q1}}?")
 *   question.dynamicOptions.expression  → which option CODES are shown ("1,2,3")
 *   option.labelExpression              → that option's label for this respondent
 *
 * The expressions are the calculation language (calc.ts) — the same one every calculation,
 * `{{expr: …}}` pipe and `expr` condition already uses — with `cond ? a : b`, nestable, and
 * `Q1 == "A"` matching by code or by label. One evaluator for the runtime, the preview, the
 * editor's outcome table and Intelligent Mode; nothing here writes an answer.
 *
 * Every failure falls back to the static definition (the text, every option, the label), and
 * the reason is noted where the test console shows calculation problems — a broken expression
 * never blanks a question or empties its list.
 */

function run(expression: string, ctx: EvalContext, key: string): unknown {
  try {
    const v = evaluateExpression(expression, calcOptionsFor(ctx.def, ctx.state, ctx.loop));
    noteCalcOutcome(ctx.state, key);
    return v;
  } catch (e) {
    noteCalcOutcome(ctx.state, key, e);
    return null;
  }
}

const asText = (v: unknown): string => (v === null || v === undefined || v === false ? "" : Array.isArray(v) ? v.map(String).join(", ") : String(v));

/** the text template for this respondent — the dynamic text when it gives one, else the question's own text. Pipe it as usual. */
export function questionTextTemplate(q: Pick<Question, "id" | "text" | "dynamicText">, ctx: EvalContext): string {
  const expr = q.dynamicText?.expression?.trim();
  if (!expr) return q.text ?? "";
  const t = asText(run(expr, ctx, `dynamicText:${q.id}`)).trim();
  return t || (q.text ?? "");
}

/** the option codes the dynamic option set allows for this respondent, or null = no restriction */
export function dynamicOptionCodes(q: Pick<Question, "id" | "dynamicOptions">, ctx: EvalContext): Set<string> | null {
  const expr = q.dynamicOptions?.expression?.trim();
  if (!expr) return null;
  const v = run(expr, ctx, `dynamicOptions:${q.id}`);
  const parts = (Array.isArray(v) ? v.flat() : asText(v).split(/[,;|]/)).map((x) => String(x).trim()).filter(Boolean);
  return parts.length ? new Set(parts) : null;
}

/** an option's label for this respondent (the code never changes) */
export function optionLabelFor(o: Pick<Option, "label" | "labelExpression" | "code">, ctx: EvalContext, qid = ""): string {
  const expr = o.labelExpression?.trim();
  if (!expr) return o.label;
  const t = asText(run(expr, ctx, `optionLabel:${qid}:${o.code}`)).trim();
  return t || o.label;
}

/** apply the option set and the dynamic labels to a list (the option pipeline's stage 4d) */
export function applyDynamicOptions<T extends Pick<Option, "code" | "label" | "labelExpression">>(q: Question, list: T[], ctx: EvalContext): T[] {
  const allow = dynamicOptionCodes(q, ctx);
  let out = allow ? list.filter((o) => allow.has(String(o.code))) : list;
  if (allow && out.length === 0) out = list; // fail open: a set that names no real option hides nothing
  return out.some((o) => o.labelExpression) ? out.map((o) => (o.labelExpression ? { ...o, label: optionLabelFor(o, ctx, q.id) } : o)) : out;
}

/* ------------------------------------------------------------------ authoring: lint + outcomes */

export interface DynamicProblem { field: "text" | "options" | "label"; code?: string; severity: "error" | "warning"; message: string }

function nameProblem(def: SurveyDefinition, q: Question, name: string, order: string[]): string | null {
  if (/^(?:ed|embedded)\./i.test(name) || /^loop\./i.test(name) || /^rule\./i.test(name) || /^calc\./i.test(name)) return null;
  const head = name.split(".")[0];
  const ref = getQuestionByCodeOrVar(def, head) ?? getQuestionByCodeOrVar(def, head.replace(/_[^_]+$/, ""));
  if (ref) {
    if (ref.id === q.id) return `${name} is this question — dynamic text can only read answers given before it`;
    const a = order.indexOf(ref.id), b = order.indexOf(q.id);
    if (a >= 0 && b >= 0 && a > b) return `${name} is asked after ${q.code} — it has no answer yet when ${q.code} is shown`;
    return null;
  }
  if ((def.calculations ?? []).some((c) => (c as { name?: string }).name === head)) return null;
  if ((def.embeddedData ?? []).some((e) => e.name.toLowerCase() === head.toLowerCase())) return null;
  if ((def.namedExpressions ?? []).some((x) => x.name === head)) return null;
  return `“${name}” is not a question, calculation, embedded field or named rule in this survey`;
}

/** problems with a question's dynamic text / options / labels — the editor shows them, the publish lint and Intelligent Mode refuse on errors */
export function lintDynamicLogic(def: SurveyDefinition, q: Question): DynamicProblem[] {
  const out: DynamicProblem[] = [];
  /* nothing dynamic, nothing to read — and no survey-wide order computed per question (the lint must stay linear) */
  if (!q.dynamicText?.expression?.trim() && !q.dynamicOptions?.expression?.trim() && !(q.options ?? []).some((o) => o.labelExpression?.trim())) return out;
  const order = questionOrder(def);
  const check = (field: DynamicProblem["field"], expr: string | undefined, code?: string) => {
    const e = expr?.trim();
    if (!e) return;
    const syntax = validateExpression(e);
    if (syntax) { out.push({ field, ...(code !== undefined ? { code } : {}), severity: "error", message: `Syntax: ${syntax}` }); return; }
    for (const n of expressionNames(e)) {
      const p = nameProblem(def, q, n, order);
      if (p) out.push({ field, ...(code !== undefined ? { code } : {}), severity: p.includes("not a question") || p.includes("this question") ? "error" : "warning", message: p });
    }
  };
  check("text", q.dynamicText?.expression);
  check("options", q.dynamicOptions?.expression);
  for (const o of q.options ?? []) check("label", o.labelExpression, String(o.code));
  if (q.dynamicOptions?.expression?.trim() && !(q.options ?? []).length) out.push({ field: "options", severity: "error", message: `${q.code} has no options for a dynamic option set to choose from` });
  /* the codes every outcome names must be real options */
  if (q.dynamicOptions?.expression?.trim() && !out.some((p) => p.field === "options" && p.severity === "error")) {
    const known = new Set((q.options ?? []).map((o) => String(o.code)));
    const unknown = new Set<string>();
    for (const oc of dynamicOutcomes(def, q).outcomes) for (const c of oc.optionCodes ?? []) if (!known.has(c)) unknown.add(c);
    if (unknown.size) out.push({ field: "options", severity: "error", message: `the option set names code${unknown.size === 1 ? "" : "s"} ${[...unknown].join(", ")} — ${q.code} has no such option (codes: ${[...known].join(", ")})` });
  }
  return out;
}

export interface DynamicOutcome {
  /** "Q1 = Product A", or "no answer yet" */
  when: string;
  text?: string;
  optionCodes?: string[];
  optionLabels?: string[];
}

/**
 * WHAT EACH RESPONDENT WOULD SEE: the first question the expressions read that has options,
 * answered with each of its options in turn (and left unanswered) — the text and the options
 * the question would show. For the editor's preview table and for Intelligent Mode to say what
 * it built. Up to 12 answers; other references keep no answer.
 */
export function dynamicOutcomes(def: SurveyDefinition, q: Question): { source?: string; outcomes: DynamicOutcome[] } {
  const exprs = [q.dynamicText?.expression, q.dynamicOptions?.expression, ...(q.options ?? []).map((o) => o.labelExpression)].filter((x): x is string => !!x && !!x.trim());
  if (!exprs.length) return { outcomes: [] };
  /* the source: a referenced question with options that is asked BEFORE this one (a later one has no answer yet) */
  const order = questionOrder(def);
  const before = (r: Question) => { const i = order.indexOf(r.id), j = order.indexOf(q.id); return i < 0 || j < 0 || i < j; };
  let src: Question | undefined;
  for (const e of exprs) {
    for (const n of expressionNames(e)) {
      const r = getQuestionByCodeOrVar(def, n.split(".")[0]);
      if (r && r.id !== q.id && (r.options ?? []).length && before(r)) { src = r; break; }
    }
    if (src) break;
  }
  const show = (answer: unknown, when: string): DynamicOutcome => {
    const state = createResponseState(def, { sessionId: "preview", seed: 1 });
    if (src && answer !== undefined) state.answers[src.id] = answer as never;
    const ctx: EvalContext = { def, state, loop: null };
    const text = q.dynamicText?.expression ? questionTextTemplate(q, ctx) : undefined;
    const opts = q.dynamicOptions?.expression || (q.options ?? []).some((o) => o.labelExpression) ? applyDynamicOptions(q, q.options ?? [], ctx) : undefined;
    const raw = q.dynamicOptions?.expression ? dynamicOptionCodes(q, ctx) : null;
    return {
      when,
      ...(text !== undefined ? { text } : {}),
      ...(opts ? { optionCodes: raw ? [...raw] : opts.map((o) => String(o.code)), optionLabels: opts.map((o) => o.label) } : {}),
    };
  };
  const plain = (s: string) => s.replace(/<[^>]*>/g, "").trim();
  const outcomes: DynamicOutcome[] = [];
  if (src) for (const o of (src.options ?? []).slice(0, 12)) outcomes.push(show(src.type === "multi_select" ? [o.code] : o.code, `${src.code} = ${plain(o.label)}`));
  outcomes.push(show(undefined, src ? `${src.code} not answered` : "as written"));
  return { ...(src ? { source: String(src.code) } : {}), outcomes };
}

/**
 * Build the nested ternary for "Q1 = A → text A, Q1 = B → text B …, otherwise fallback" — for the
 * editor's "Build from answers" and Intelligent Mode. Strings are quoted safely.
 */
export function buildTernary(source: string, cases: { equals: string | number; result: string }[], fallback: string): string {
  const q = (s: string | number) => (typeof s === "number" ? String(s) : `"${String(s).replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`);
  return cases.reduceRight((acc, c) => `${source} == ${q(c.equals)} ? ${q(c.result)} : ${acc}`, q(fallback));
}

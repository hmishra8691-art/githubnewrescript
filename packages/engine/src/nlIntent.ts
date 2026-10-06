import type { Condition, ConditionRule, Option, Question, SurveyDefinition, ValidationRule } from "@rescript/schema";
import { hypothesisLabel, LANGUAGE_LIBRARY, variantRegistry } from "@rescript/schema";
import { applySurveyActions, describeAction, diffSurveys, variantForActionType, type OptionSpec, type SurveyAction, type ValidationSpec } from "./surveyActions.js";
import { conditionFromText } from "./naturalCondition.js";
import { closestName } from "./logicExpression.js";
import { contentWords, countWord, firstQuestionAfter, placedOrder, resolveOptionRef, resolveQuestionRange, resolveQuestionRef, stemWord, type QuestionCandidate, type TargetContext } from "./nlTargets.js";
import { formatCondition } from "./logicExpression.js";
import { conditionSummary } from "./logicSummary.js";
import { conditionRefs } from "./dependencies.js";
import { buildDependencyIndex, objectKey, parseObjectKey, type DependencyEdge, type DependencyIndex, type EdgeKind, type ObjectKey, type ObjectKind } from "./dependencyIndex.js";
import { impactOf, impactPhrase, type ImpactItem, type ImpactReport } from "./impact.js";
import { buildAnalysisFramework, explainPlan, explainPlanItem, hypothesisCoverage, planItemKind, planItemTitle, planSampleSize, prioritizeCrosstabs, segmentationQuestions, segmentVariableName } from "./analysisFramework.js";
import { effectiveLocalization, languageName, lintLanguage } from "./localization.js";
import { listBlocks, listPages } from "./blocks.js";
import { getQuestionByCodeOrVar } from "./state.js";
import { stripHtmlText } from "./html.js";
import { ruleLabel } from "./logicProposal.js";

/**
 * THE SENTENCE INTERPRETER (Intelligent Mode Phase 3) — what the researcher
 * typed, read against THIS survey, before any language model is asked.
 *
 * Intelligent Mode used to send every sentence to the cloud model first and
 * keep a grammar as the fallback, and the grammar spoke a different
 * vocabulary from the copilot's actions. This turns that round. The engine
 * reads the sentence itself, into the ONE action vocabulary the copilot
 * already uses (`SurveyAction`), answers the questions a survey can answer
 * about itself (what depends on Q7, what breaks if Q15 goes, which questions
 * measure purchase intent, what is untranslated), and — when it cannot do
 * what was asked — says precisely what it understood, what it found, why it
 * stops, and what would work instead. The model is for what is left: writing
 * wording, translations, whole surveys from a brief, narrative findings, and
 * phrasings this layer does not parse.
 *
 * `interpretRequest(def, text, ctx)` tries a list of small RECOGNISERS in
 * order; each returns an `Interpretation` or null, and the first non-null
 * wins. It never throws. Every edit it hands back has been APPLIED to a copy
 * of the survey with `applySurveyActions` — the same gate the model's
 * actions go through — and if any action was refused the result is
 * `refused` with the engine's own reason (and its suggested fix, when it has
 * one), never actions that would fail on Apply.
 *
 * Five kinds of result:
 *
 *   actions   the edits, the targets, and what was detected on the way
 *   answer    a question the survey answers itself, as navigable sections
 *   clarify   the sentence named several things; one choice per candidate,
 *             each the sentence re-written with that candidate
 *   refused   understood, but not possible as asked — the reason, and a
 *             suggestion (a sentence, with its actions when they apply) when
 *             a safe one exists
 *   model     the language model's job. `reason: "defer:grammar"` is the
 *             contract with the Studio: explain / diagnose / screening /
 *             "what can affect" / loops / hidden variables are answered by
 *             the Studio's existing deterministic grammar, so this layer
 *             steps aside for them rather than answering them twice
 *
 * `detected` is always filled with what the interpreter resolved — the
 * condition with its option labels, the range, the target, the questions and
 * options a sentence named — so the review card (and the model's turn, when
 * it gets one) can say "Detected: Q7 = 2 (No), Q8–Q12 → Q13".
 */

/* ------------------------------------------------------------ vocabulary */

export type IntentCategory =
  | "survey_creation" | "survey_editing" | "question_creation" | "question_modification" | "option_modification"
  | "logic" | "validation" | "randomization" | "masking" | "variables" | "calculations" | "translation"
  | "analysis" | "findings" | "research_design" | "quality_control" | "data_cleaning" | "reporting"
  | "visualization" | "export" | "debugging" | "dependency_analysis" | "impact_analysis";

export const INTENT_CATEGORIES: readonly IntentCategory[] = [
  "survey_creation", "survey_editing", "question_creation", "question_modification", "option_modification",
  "logic", "validation", "randomization", "masking", "variables", "calculations", "translation",
  "analysis", "findings", "research_design", "quality_control", "data_cleaning", "reporting",
  "visualization", "export", "debugging", "dependency_analysis", "impact_analysis",
] as const;

/** what the interpreter resolved: { what: "condition", value: "Q7 = 2 (No)" }, { what: "skip range", value: "Q8–Q12 → Q13" } */
export interface Detected { what: string; value: string }

export interface AnswerItem {
  label: string;
  /** a dependency-index ObjectKey (`question:<id>`, `skipRule:<qid>/<rid>`, `analysis:<id>` …) for navigation */
  key?: string;
  detail?: string;
}
export interface AnswerSection { title: string; items: AnswerItem[] }

export type Interpretation =
  | { kind: "actions"; category: IntentCategory; understood: string; actions: SurveyAction[]; detected: Detected[]; targets: string[] /* question ids */; warnings?: string[] }
  | { kind: "answer"; category: IntentCategory; understood: string; answer: string; sections: AnswerSection[]; detected: Detected[] }
  | { kind: "clarify"; category: IntentCategory; understood: string; question: string; choices: { label: string; text: string }[]; detected: Detected[] }
  | { kind: "refused"; category: IntentCategory; understood: string; reason: string; detected: Detected[]; suggestion?: { text: string; actions?: SurveyAction[] }; /** nothing to do: the survey already is as asked */ noop?: boolean }
  | { kind: "model"; category: IntentCategory | null; reason: string; detected: Detected[] };

export interface InterpretContext {
  /** the selected question: "this question", "it", "these options" */
  selectedId?: string | null;
  /** the selected option of that question: "this option" */
  selectedOption?: string | number | null;
  /** a multi-selection of questions: "these questions" (falls back to `selectedId`) */
  selectedIds?: string[] | null;
}

/** the `reason` of a `model` result that hands the sentence to the Studio's deterministic grammar instead */
export const DEFER_TO_GRAMMAR = "defer:grammar";

/* ------------------------------------------------------------ the run */

interface Run { def: SurveyDefinition; text: string; ctx: InterpretContext; depth: number; ix?: DependencyIndex }
type Recogniser = (r: Run) => Interpretation | null;

const index = (r: Run): DependencyIndex => (r.ix ??= buildDependencyIndex(r.def));
const plain = (s: string | undefined, n = 80): string => { const t = stripHtmlText(s ?? "").replace(/\s+/g, " ").trim(); return t.length > n ? `${t.slice(0, n - 1)}…` : t; };
const cap = (s: string) => (s ? s[0].toUpperCase() + s.slice(1) : s);
const code = (q: Question) => String(q.code);
const plural = (n: number, w: string, pl = `${w}s`) => `${n} ${n === 1 ? w : pl}`;
const unquote = (s: string) => s.trim().replace(/^["“'‘]+|["”'’]+$/g, "").trim();
const det = (what: string, value: string): Detected => ({ what, value });
const qDetected = (qs: Question[]): Detected[] => qs.map((q) => det("question", code(q)));
/** "Q8–Q12" for a run in flow order, "Q6, Q8" otherwise */
function rangeLabel(def: SurveyDefinition, qs: Question[]): string {
  if (qs.length === 1) return code(qs[0]);
  const order = placedOrder(def);
  const idx = qs.map((q) => order.indexOf(q.id));
  const contiguous = idx.every((v, i) => v >= 0 && (i === 0 || v === idx[i - 1] + 1));
  return contiguous ? `${code(qs[0])}–${code(qs[qs.length - 1])}` : qs.map(code).join(", ");
}
/** the sentence with one name swapped for another — how a did-you-mean or a clarification choice is re-asked */
function substitute(text: string, ref: string, by: string): string {
  const i = text.toLowerCase().indexOf(ref.toLowerCase());
  return i < 0 ? text : `${text.slice(0, i)}${by}${text.slice(i + ref.length)}`;
}

/* ------------------------------------------------------------ conditions in words */

/** a rule's option labels, when it compares a choice question with codes: "No" for `Q7 = 2` */
function ruleLabels(def: SurveyDefinition, rule: ConditionRule): string[] {
  const src = rule.source as { kind?: string; ref?: string; count?: unknown };
  if ((src.kind !== "question" && src.kind !== "variable") || src.count) return [];
  const q = getQuestionByCodeOrVar(def, String(src.ref ?? ""));
  if (!q?.options?.length) return [];
  const vals = Array.isArray(rule.value) ? rule.value : [rule.value];
  return vals.map((v) => q.options.find((o) => String(o.code) === String(v))?.label).filter((l): l is string => !!l).map((l) => plain(l, 40));
}

/**
 * A condition as the review card's "Detected" line says it: the canonical
 * expression with each compared option's label beside its code —
 * `Q7 = 2 (No)`, `Q3 = 1 (Male) AND Q9 > 25`.
 */
export function conditionWords(def: SurveyDefinition, c: Condition): string {
  if (c.type === "group") {
    if (!c.children.length) return c.op === "and" ? "always" : "never";
    const inner = (ch: Condition) => (ch.type === "group" && ch.op !== "not" && ch.children.length > 1 ? `(${conditionWords(def, ch)})` : conditionWords(def, ch));
    if (c.op === "not") return `NOT (${c.children.map((ch) => conditionWords(def, ch)).join(" OR ")})`;
    return c.children.length === 1 ? conditionWords(def, c.children[0]) : c.children.map(inner).join(c.op === "and" ? " AND " : " OR ");
  }
  const text = formatCondition(def, c).replace(/\s+/g, " ");
  const labels = ruleLabels(def, c);
  return labels.length ? `${text} (${labels.join(", ")})` : text;
}

/** "who answer No at Q7" for a single code comparison, else "when …" in the Logic panel's words */
function whoPhrase(def: SurveyDefinition, c: Condition): string {
  if (c.type === "rule" && ["eq", "selected", "contains"].includes(c.operator)) {
    const labels = ruleLabels(def, c);
    const q = getQuestionByCodeOrVar(def, String((c.source as { ref?: string }).ref ?? ""));
    if (labels.length === 1 && q) return `who answer ${labels[0]} at ${code(q)}`;
  }
  return `when ${conditionSummary(def, c) || formatCondition(def, c)}`;
}

/* ------------------------------------------------------------ results */

/** the survey's own sentence for a suggested action — what "Apply suggested fix" would re-ask */
function sentenceFor(def: SurveyDefinition, a: SurveyAction): string {
  const words = (c: unknown) => (typeof c === "string" ? c : formatCondition(def, c as Condition));
  if (a.op === "set_display_logic") return a.expression === null ? `remove the display logic from ${a.target}` : `show ${a.target} only if ${words(a.expression)}`;
  if (a.op === "add_skip") return `after ${a.from}, skip to ${a.to} if ${words(a.when)}`;
  return describeAction(a);
}

/**
 * The gate every edit passes before it is handed back: the actions are
 * APPLIED to a copy with `applySurveyActions`, and a refusal there is a
 * refusal here — with the engine's reason, and the engine's suggested fix
 * (re-checked the same way) when it offered one.
 */
function act(r: Run, category: IntentCategory, understood: string, actions: SurveyAction[], detected: Detected[]): Interpretation {
  const out = applySurveyActions(r.def, actions);
  const failed = out.results.find((x) => !x.ok);
  if (failed || !out.valid) {
    const a = failed ? actions[failed.index] : actions[0];
    const why = (failed?.error ?? out.errors[0] ?? "the result does not pass the survey schema").replace(/\.\s*$/, "");
    let suggestion: { text: string; actions?: SurveyAction[] } | undefined;
    if (failed?.suggestion) {
      const fixed = actions.map((x, i) => (i === failed.index ? failed.suggestion! : x));
      const check = applySurveyActions(r.def, fixed);
      // a "fix" that changes nothing the review would show (re-setting the rules a question already has) is not offered — its Apply would say "nothing to apply"
      if (check.valid && !check.errors.length && !diffSurveys(r.def, check.def).empty) suggestion = { text: sentenceFor(r.def, failed.suggestion), actions: fixed };
    }
    return { kind: "refused", category, understood, reason: `${describeAction(a)} — not applied: ${why}.`, detected, ...(suggestion ? { suggestion } : {}) };
  }
  const targets = [...new Set(out.results.flatMap((x) => x.touched))].filter((id) => out.def.questions.some((q) => q.id === id));
  return { kind: "actions", category, understood, actions, detected, targets, ...(out.warnings.length ? { warnings: out.warnings } : {}) };
}

const refused = (category: IntentCategory, understood: string, reason: string, detected: Detected[] = [], suggestion?: { text: string; actions?: SurveyAction[] }): Interpretation =>
  ({ kind: "refused", category, understood, reason, detected, ...(suggestion ? { suggestion } : {}) });
/** the survey is already as asked ("Q3 is already optional — nothing to change"): a refusal alone, but in a longer request a clause to leave out, not a reason to refuse the rest */
const alreadySo = (category: IntentCategory, understood: string, reason: string, detected: Detected[] = []): Interpretation =>
  ({ kind: "refused", category, understood, reason, detected, noop: true });

/** a suggestion sentence, with its actions when the sentence itself interprets to actions */
function suggest(r: Run, text: string): { text: string; actions?: SurveyAction[] } {
  if (r.depth >= 2) return { text };
  const again = interpret({ ...r, text, depth: r.depth + 1, ix: undefined });
  return { text, ...(again.kind === "actions" ? { actions: again.actions } : {}) };
}

/**
 * A name that did not resolve, as a result: several candidates → a
 * clarifying question (one choice per candidate, the sentence re-written with
 * its code); one did-you-mean → refused with that sentence as the suggestion
 * (and its actions); none → refused with the reason.
 */
function unresolved(r: Run, category: IntentCategory, understood: string, ref: string, f: { reason: string; candidates: QuestionCandidate[]; ambiguous: boolean }, detected: Detected[] = []): Interpretation {
  if (f.ambiguous && f.candidates.length > 1) {
    return { kind: "clarify", category, understood, question: f.reason, choices: f.candidates.map((c) => ({ label: `${c.code} — ${c.text}`, text: substitute(r.text, ref, c.code) })), detected };
  }
  return refused(category, understood, f.reason, detected, f.candidates.length === 1 ? suggest(r, substitute(r.text, ref, f.candidates[0].code)) : undefined);
}

type Got<T> = { ok: true; v: T } | { ok: false; out: Interpretation | null };
const CODE_SHAPE = /^[A-Za-z]{1,4}\d+[A-Za-z0-9_]*$/;

/**
 * One question for a recogniser. `loose`: when the name is a description
 * that matches nothing (and is not shaped like a code), the recogniser does
 * not apply at all — "delete the duplicates" is not about a question named
 * "duplicates" — and the next one (eventually the model) gets the sentence.
 */
function questionOf(r: Run, ref: string, category: IntentCategory, understood: string, opts: { loose?: boolean } = {}): Got<Question> {
  const res = resolveQuestionRef(r.def, ref, r.ctx);
  if (res.ok) return { ok: true, v: res.question };
  if (opts.loose && !res.ambiguous && !CODE_SHAPE.test(unquote(ref))) return { ok: false, out: null };
  return { ok: false, out: unresolved(r, category, understood, ref, res) };
}
function rangeOf(r: Run, ref: string, category: IntentCategory, understood: string, extra: TargetContext = {}, opts: { loose?: boolean } = {}): Got<Question[]> {
  const res = resolveQuestionRange(r.def, ref, { selectedId: r.ctx.selectedId, selectedIds: r.ctx.selectedIds, ...extra });
  if (res.ok) return { ok: true, v: res.questions };
  const part = res.ref ?? ref;
  if (opts.loose && !res.ambiguous && !res.candidates.length && !CODE_SHAPE.test(unquote(part)) && res.ref !== undefined) return { ok: false, out: null };
  if (res.ref !== undefined || res.candidates.length || res.ambiguous) return { ok: false, out: unresolved(r, category, understood, part, res) };
  return { ok: false, out: refused(category, understood, res.reason) };
}
function optionOf(r: Run, q: Question, ref: string, category: IntentCategory, understood: string): Got<Option> {
  const res = resolveOptionRef(q, ref, { selected: r.ctx.selectedOption });
  if (res.ok) return { ok: true, v: res.option };
  if (res.ambiguous && res.candidates.length > 1) {
    return { ok: false, out: { kind: "clarify", category, understood, question: res.reason, choices: res.candidates.map((c) => ({ label: `${c.code} — ${c.label}`, text: substitute(r.text, ref, `“${c.label}”`) })), detected: [det("question", code(q))] } };
  }
  return { ok: false, out: refused(category, understood, res.reason, [det("question", code(q))], res.candidates.length === 1 && /did you mean/.test(res.reason) ? suggest(r, substitute(r.text, unquote(ref), res.candidates[0].label)) : undefined) };
}

/** a block by "block Usage", "the Usage block", its title or id */
function blockOf(def: SurveyDefinition, text: string): { id: string; title: string } | null {
  const t = unquote(text);
  const m = /^(?:the\s+)?(?:block|section)\s+(.+)$/i.exec(t) ?? /^(?:the\s+)?(.+?)\s+(?:block|section)$/i.exec(t);
  const name = unquote(m ? m[1] : t).toLowerCase();
  const blocks = listBlocks(def.flow as unknown[]).filter((b) => b.wrapped || b.title);
  const b = blocks.find((x) => x.id.toLowerCase() === name) ?? blocks.find((x) => (x.title ?? "").trim().toLowerCase() === name) ?? (m ? blocks.find((x) => (x.title ?? "").trim().toLowerCase().startsWith(name) && name.length >= 3) : undefined);
  return b ? { id: b.id, title: b.title ?? b.id } : null;
}

/**
 * How an action names a block: by its TITLE when that names it alone — no
 * other block or page, no block id reads the
 * same (for set_display_logic, whose target may be a question, no question
 * code or variable either) — otherwise by id. A title survives a replay; an id may not: a block
 * the open proposal created gets a new id each time the proposal is
 * re-evaluated, so "remove the trust block" on a generated (not yet applied)
 * survey named, by id, a block that the next evaluation no longer had.
 */
function blockRef(def: SurveyDefinition, b: { id: string; title: string }, opts: { orQuestion?: boolean } = {}): string {
  const t = (b.title ?? "").trim();
  const low = t.toLowerCase();
  if (!t || t === b.id) return b.id;
  const all = listBlocks(def.flow as unknown[]);
  if (all.filter((x) => (x.title ?? "").trim().toLowerCase() === low).length !== 1) return b.id;
  if (all.some((x) => x.id.toLowerCase() === low) || (def.flow as { id?: string; title?: string }[]).some((n) => n.id?.toLowerCase() === low || (n.id !== b.id && (n.title ?? "").trim().toLowerCase() === low))) return b.id;
  // where the action's target may also be a question (set_display_logic), a title a question code or variable reads the same stays an id
  if (opts.orQuestion && def.questions.some((q) => String(q.code).toLowerCase() === low || q.variableName.toLowerCase() === low)) return b.id;
  return t;
}

/**
 * A piece of expression text as an operand of AND / OR: bracketed only when
 * it has a connective of its own. A bracket the parser reads around a single
 * rule is kept as a one-child group (the shape the programmer typed), which
 * prints the same but is not what "Q7 = 1 OR Q1 > 60" should store.
 */
const paren = (s: string): string => (/\s(?:AND|OR|NOR)\s/i.test(s) ? `(${s})` : s);

/** the condition text of a sentence, parsed; "A unless B" is (A) AND NOT (B), a bare "unless B" is NOT B */
function readCondition(r: Run, text: string, unlessAlone = false): { ok: true; expression: string; condition: Condition } | { ok: false; error: string; suggestion?: string } {
  let t = text.trim();
  const parts = t.split(/\s+unless\s+/i);
  if (parts.length === 2 && parts[0].trim() && parts[1].trim()) t = `${paren(parts[0].trim())} AND NOT (${parts[1].trim()})`;
  else if (unlessAlone) t = `NOT (${t})`;
  const c = conditionFromText(r.def, t);
  if (!c.condition) return { ok: false, error: c.errors[0]?.message ?? "the condition is empty", suggestion: c.errors.find((e) => e.suggestion)?.suggestion };
  return { ok: true, expression: c.expression, condition: c.condition };
}
/*
 * A CONDITION THE ENGINE CANNOT READ is a phrasing question, not a verdict.
 * With a confident did-you-mean (a near-miss name — "Q99" for Q9) it is
 * almost certainly a typo: refused, with the corrected sentence as the fix.
 * Otherwise ("Other is not chosen" — an option named without its question)
 * the engine does not know what was meant, so it does not refuse what it did
 * not understand: the sentence goes to the language model with what the
 * engine did detect, exactly as an unrecognised sentence would — and, with
 * no model, to the grammar, which says what it could not read.
 */
function badCondition(r: Run, category: IntentCategory, understood: string, condText: string, e: { error: string; suggestion?: string }): Interpretation {
  /* a question code that is not there ("Q33 does not exist") is an object that is missing, not a phrasing: refused, with the nearest code as the fix */
  const missing = /^[“"]?([A-Za-z_][\w.]*)[”"]? does not exist/.exec(e.error);
  if (!e.suggestion && missing && CODE_SHAPE.test(missing[1])) {
    const near = closestName(missing[1], r.def.questions.map(code));
    if (near) e = { ...e, suggestion: substitute(condText, missing[1], near) };
    else return refused(category, understood, `I could not read the condition “${condText}”: there is no ${missing[1]} in this survey.`, [det("condition text", condText)]);
  }
  if (!e.suggestion) return { kind: "model", category, reason: `the condition “${condText}” is not in a form the engine reads (${e.error.replace(/\.$/, "")}) — the language model interprets it`, detected: [det("condition text", condText), ...namedObjects(r)] };
  return refused(category, understood, `I could not read the condition “${condText}”: ${e.error.replace(/\.$/, "")}.`, [det("condition text", condText)], suggest(r, substitute(r.text, condText, e.suggestion)));
}

/* ------------------------------------------------------------ what a sentence names */

/** every question code / variable, option label and language a sentence names — for "Detected: Q7, Q8" on a model turn */
function namedObjects(r: Run): Detected[] {
  const out: Detected[] = [];
  const seen = new Set<string>();
  const qs: Question[] = [];
  for (const tok of r.text.match(/\b[A-Za-z_][A-Za-z0-9_]*\b/g) ?? []) {
    const q = getQuestionByCodeOrVar(r.def, tok) ?? (CODE_SHAPE.test(tok) ? r.def.questions.find((x) => code(x).toLowerCase() === tok.toLowerCase()) : undefined);
    if (q && !seen.has(q.id)) { seen.add(q.id); qs.push(q); out.push(det("question", code(q))); }
  }
  for (const q of qs) for (const o of q.options ?? []) {
    const l = plain(o.label, 80);
    if (!l) continue;
    // a short label ("No", "US") only as written — in lower case it is an ordinary word
    const re = new RegExp(`(?:^|[^\\p{L}\\p{N}])${l.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?:$|[^\\p{L}\\p{N}])`, l.length >= 4 ? "iu" : "u");
    if (re.test(r.text)) out.push(det("option", `${code(q)}: ${l}`));
  }
  const lang = languageIn(r.text);
  if (lang) out.push(det("language", `${lang.name} (${lang.code})`));
  return out;
}

/* ------------------------------------------------------------ languages */

const LANGUAGE_NAMES: Record<string, string> = {
  english: "en", french: "fr", german: "de", spanish: "es", italian: "it", portuguese: "pt", dutch: "nl", japanese: "ja",
  chinese: "zh", mandarin: "zh", hindi: "hi", arabic: "ar", korean: "ko", polish: "pl", turkish: "tr", russian: "ru",
  swedish: "sv", danish: "da", norwegian: "no", finnish: "fi", greek: "el", hebrew: "he", thai: "th", vietnamese: "vi",
  indonesian: "id", malay: "ms", czech: "cs", hungarian: "hu", romanian: "ro", ukrainian: "uk", bengali: "bn", tamil: "ta",
  telugu: "te", marathi: "mr", urdu: "ur", gujarati: "gu", kannada: "kn", malayalam: "ml", punjabi: "pa", filipino: "fil", tagalog: "tl",
};
const ENGLISH_NAME: Record<string, string> = Object.fromEntries(Object.entries(LANGUAGE_NAMES).map(([n, c]) => [c, cap(n)]));

/** a language from what a sentence calls it: "French", "Canadian French" (fr, fr-CA), "Français", "de" */
function languageFrom(text: string): { code: string; locale?: string; name: string } | null {
  const t = unquote(text).toLowerCase().replace(/\s+(?:language|version|translation)$/, "").trim();
  if (LANGUAGE_NAMES[t]) return { code: LANGUAGE_NAMES[t], name: cap(t) };
  for (const l of LANGUAGE_LIBRARY) {
    if (l.name.toLowerCase() === t || l.nativeName.toLowerCase() === t || l.code === t) return { code: l.code, name: l.name };
    const loc = l.locales.find((x) => x.name.toLowerCase() === t || x.tag.toLowerCase() === t);
    if (loc) return { code: l.code, locale: loc.tag, name: loc.name };
  }
  return /^[a-z]{2,3}$/.test(t) && ENGLISH_NAME[t] ? { code: t, name: ENGLISH_NAME[t] } : null;
}
/** the first language a sentence names anywhere */
function languageIn(text: string): { code: string; locale?: string; name: string } | null {
  const words = text.replace(/[.,;:!?]/g, " ").split(/\s+/).filter(Boolean);
  for (let i = 0; i < words.length; i++) {
    for (const span of [2, 1]) {
      const w = words.slice(i, i + span).join(" ");
      if (span === 1 && /^[a-z]{2,3}$/.test(w)) continue; // "de", "it", "no" in a sentence are words, not codes
      const l = languageFrom(w);
      if (l) return l;
    }
  }
  return null;
}
const surveyHasLanguage = (def: SurveyDefinition, c: string) => effectiveLocalization(def).languages.some((l) => l.code === c);

/* ------------------------------------------------------------ question types */

/** everyday words for a question type → a key `variantForActionType` knows */
const TYPE_WORDS: [RegExp, string][] = [
  [/^drop[\s-]?down(?:\s+(?:list|menu|select))?$|^select\s+box$/, "dropdown"],
  [/^(?:multi(?:ple)?[\s-]?select\s+(?:matrix|grid)|(?:matrix|grid)\s+multi(?:[\s-]?select)?)$/, "matrix_multi"],
  [/^multi(?:ple)?[\s-]?(?:select|choice|answer|response)(?:\s+list)?$|^check[\s-]?box(?:es)?$|^select[\s-]all(?:[\s-]that[\s-]apply)?$/, "multi_select"],
  [/^single[\s-]?(?:select|choice|answer|response)$|^radio(?:\s+buttons?)?$|^yes\s*\/\s*no$/, "single_select"],
  [/^slider(?:\s+scale)?$/, "slider"],
  [/^(?:integer|whole[\s-]number)$/, "integer"],
  [/^(?:numeric|number|numerical)(?:\s+(?:input|entry|open|box))?$/, "numeric"],
  [/^(?:currency|money|amount)$/, "currency"],
  [/^percent(?:age)?$/, "percentage"],
  [/^(?:long\s+text|essay|paragraph|text\s*area|comment\s+box|multi[\s-]?line(?:\s+text)?|long\s+open[\s-]?end(?:ed)?)$/, "long_text"],
  [/^(?:open[\s-]?(?:text|end(?:ed)?)|text(?:\s+(?:box|entry|input))?|short\s+text|free[\s-]?text|single[\s-]line(?:\s+text)?)$/, "text"],
  [/^e-?mail(?:\s+address)?$/, "email"], [/^(?:tele)?phone(?:\s+number)?$/, "phone"], [/^date$/, "date"], [/^time$/, "time"],
  [/^rank(?:ing)?(?:\s+order)?$/, "ranking"], [/^(?:nps|net\s+promoter(?:\s+score)?)$/, "nps"],
  [/^likert(?:\s+(?:matrix|grid|scale))?$/, "likert_matrix"], [/^(?:matrix|grid)(?:\s+single(?:[\s-]select)?)?$/, "matrix"],
  [/^stars?(?:\s+rating)?$|^star[\s-]rating$/, "stars"], [/^(?:constant\s+sum|allocation)$/, "constant_sum"], [/^(?:file\s+)?upload$/, "upload"],
];
/** a question's kind in the picker's words: "Dropdown", "Checkboxes", "numeric" */
function kindOf(q: Pick<Question, "type" | "variant">): string {
  const v = q.variant ? (variantRegistry.get(q.variant) as { name?: string } | undefined) : undefined;
  return v?.name ?? q.type.replace(/_/g, " ");
}
const variantName = (variant: string): string => (variantRegistry.get(variant) as { name?: string } | undefined)?.name ?? variant;

function typeFromWords(words: string): string | null {
  const w = words.trim().toLowerCase().replace(/^(?:an?|the)\s+/, "").replace(/\s+(?:question|type|format|field)$/, "").trim();
  for (const [re, key] of TYPE_WORDS) if (re.test(w)) return variantForActionType(key) ? key : null;
  return null;
}

/* ============================================================ recognisers */

/* ---------------------------------------------------------- defer to the Studio grammar */

/**
 * The sentences the Studio's grammar already answers deterministically —
 * explain, diagnose ("why is Q25 not showing"), screening, "what can affect
 * Q7", loops, hidden and expressionless calculated variables. This layer
 * answers none of them twice: it returns `{ kind: "model", reason:
 * "defer:grammar" }` and the Studio runs its grammar.
 */
const deferred: Recogniser = (r) => {
  const t = r.text;
  const out = (category: IntentCategory): Interpretation => ({ kind: "model", category, reason: DEFER_TO_GRAMMAR, detected: namedObjects(r) });
  if (/^why\b/i.test(t) || /^(?:diagnose|debug|troubleshoot)\b/i.test(t)) return out("debugging");
  if (/^(?:is|can)\s+.+?\s+(?:reachable|(?:ever\s+)?be\s+reached|ever\s+shown|shown\s+to\s+anyone|ever\s+asked)$/i.test(t)) return out("debugging");
  if (/\b(?:screened|screen[- ]?outs?|terminated|terminations?|disqualified|screening)\b/i.test(t) && /^(?:explain|show|tell|list|describe|what|which|when|how)\b/i.test(t)) return out("debugging");
  if (/^(?:what|which)(?:\s+\w+)?\s+(?:can|could|might)\s+(?:affect|change|influence|impact|reach)\s+/i.test(t)) return out("dependency_analysis");
  if (/^(?:explain|describe|tell\s+me\s+about|walk\s+me\s+through)\s+/i.test(t)) return out("debugging");
  const what = /^(?:what\s+is|what's|how\s+does|how\s+is)\s+(.+?)(?:\s+(?:work|doing|set\s+up|configured|shown|hidden|asked))?$/i.exec(t);
  if (what && resolveQuestionRef(r.def, what[1], r.ctx).ok) return out("debugging");
  if (/^(?:create|add|make|build|put|wrap)\s+(?:a\s+)?loop\b/i.test(t) || /^(?:loop|repeat)\s+(?:the\s+)?(?:questions?\s+)?\S+\s+(?:to|through|thru|–|-)\s+/i.test(t)) return out("survey_editing");
  if (/^(?:add|create|make|insert|new|define)\s+(?:an?\s+|the\s+)?(?:new\s+)?hidden\s+(?:variable|value|field|question)\b/i.test(t)) return out("variables");
  if (/^(?:add|create|make|insert|new|define)\s+(?:an?\s+|the\s+)?(?:new\s+)?(?:calculated|computed|derived)\s+(?:variable|value|field|question)\b/i.test(t) && !/=|\s(?:as|equal\s+to|equals)\s/i.test(t)) return out("calculations");
  return null;
};

/* ---------------------------------------------------------- queries: dependencies */

/** the Studio's sections, in the order an inspector lists them */
const SECTION_ORDER = ["Display logic", "Skip logic", "Validation", "Masking & carry-forward", "Piping", "Calculations", "Quotas", "Randomization & list logic", "Flow (branches, loops, blocks)", "Analysis plan", "Constructs", "Translations"] as const;
const SECTION_OF: Record<EdgeKind, (typeof SECTION_ORDER)[number]> = {
  display: "Display logic", optionLogic: "Display logic", skip: "Skip logic", validation: "Validation",
  mask: "Masking & carry-forward", carryForward: "Masking & carry-forward", piping: "Piping",
  calculation: "Calculations", punch: "Calculations", namedExpression: "Calculations", quotaCell: "Quotas",
  randomization: "Randomization & list logic", listLogic: "Randomization & list logic", listOperation: "Randomization & list logic", listFillSource: "Randomization & list logic", listFillGate: "Randomization & list logic",
  flowCondition: "Flow (branches, loops, blocks)", loopSource: "Flow (branches, loops, blocks)", placement: "Flow (branches, loops, blocks)", target: "Flow (branches, loops, blocks)",
  analysis: "Analysis plan", construct: "Constructs", translation: "Translations",
};
const NOUN: Record<(typeof SECTION_ORDER)[number], [string, string]> = {
  "Display logic": ["display condition", "display conditions"], "Skip logic": ["skip", "skips"], Validation: ["validation rule", "validation rules"],
  "Masking & carry-forward": ["mask or carry-forward", "masks and carry-forwards"], Piping: ["pipe", "pipes"], Calculations: ["calculation", "calculations"], Quotas: ["quota", "quotas"],
  "Randomization & list logic": ["list rule", "list rules"], "Flow (branches, loops, blocks)": ["flow element", "flow elements"],
  "Analysis plan": ["planned analysis", "planned analyses"], Constructs: ["construct", "constructs"], Translations: ["translation", "translations"],
};

/** the value at a dotted path of the definition */
function atPath(def: SurveyDefinition, path: string): unknown {
  let cur: unknown = def;
  for (const tok of path.split(/\.|\[|\]\.?/).filter(Boolean)) { if (cur === null || typeof cur !== "object") return undefined; cur = (cur as Record<string, unknown>)[tok]; }
  return cur;
}
/** what the reference at an edge's path says — the condition it sits in, in words */
function edgeDetail(def: SurveyDefinition, e: DependencyEdge): string | undefined {
  try {
    const cut = e.path.search(/\.children\[|\.source\.|\.value$|\.value\[/);
    const v = atPath(def, cut >= 0 ? e.path.slice(0, cut) : e.path);
    if (v && typeof v === "object" && ((v as { type?: string }).type === "rule" || (v as { type?: string }).type === "group")) return conditionWords(def, v as Condition);
    if (typeof v === "string" && e.kind === "calculation") return `= ${plain(v, 80)}`;
  } catch { /* a half-formed definition must not take the answer down */ }
  return undefined;
}
function sectioned(groups: Map<string, AnswerItem[]>): AnswerSection[] {
  return SECTION_ORDER.filter((s) => groups.get(s)?.length).map((s) => ({ title: s, items: groups.get(s)! }));
}
function countWords(sections: AnswerSection[]): string {
  return sections.map((s) => { const n = NOUN[s.title as (typeof SECTION_ORDER)[number]]; return n ? `${s.items.length} ${s.items.length === 1 ? n[0] : n[1]}` : `${s.items.length} ${s.title.toLowerCase()}`; }).join(", ");
}

/** an index node as a list line: "Q10", "calculation AGE_GAP", "quota Gender", "branch Main" */
function nodeWords(ix: DependencyIndex, k: ObjectKey): string {
  const n = ix.nodes.get(k);
  if (!n) return k;
  switch (n.kind) {
    case "question": return n.code;
    case "skipRule": return `${n.code.replace(/ skip (\d+)$/, " skip rule $1")}`;
    case "flowNode": return `${n.label.toLowerCase()} “${n.code}”`;
    case "translation": return `${n.label} translations`;
    case "analysis": return `planned ${n.code.replace(/ \S+$/, "")}`;
    default: return `${({ displayRule: "display rule", calculation: "calculation", quota: "quota", namedExpression: "expression", listFill: "list fill", embedded: "embedded", construct: "construct" } as Record<string, string>)[n.kind] ?? n.kind} ${n.code}`;
  }
}

/** the object a sentence names for a dependency question: a question, a calculation, an embedded field, a block, a quota */
function objectFor(r: Run, ref: string): { key: ObjectKey; label: string } | { fail: Interpretation } {
  const q = resolveQuestionRef(r.def, ref, r.ctx);
  if (q.ok) return { key: objectKey("question", q.question.id), label: code(q.question) };
  const ix = index(r);
  const name = unquote(ref).replace(/['’]s$/, "");
  const named = ix.forName(name) ?? ([objectKey("embedded", name)] as ObjectKey[]).find((k) => ix.nodes.has(k)) ?? null;
  if (named) return { key: named, label: ix.nodes.get(named)?.code ?? name };
  const b = blockOf(r.def, ref);
  if (b) return { key: objectKey("flowNode", b.id), label: `block “${b.title}”` };
  const quota = r.def.quotas?.find((x) => x.name.toLowerCase() === name.toLowerCase());
  if (quota) return { key: objectKey("quota", quota.id), label: `quota “${quota.name}”` };
  return { fail: unresolved(r, "dependency_analysis", `Find what depends on ${unquote(ref)}.`, ref, q) };
}

const dependents: Recogniser = (r) => {
  const t = r.text;
  const m = /^(?:what|which|who)(?:\s+(?:questions?|objects?|logic|rules?|things?|conditions?|elements?|items?|variables?))?\s+(?:else\s+)?(?:that\s+)?(?:depends?\s+on|uses?|references?|reads?|needs?|relies\s+on|is\s+using|are\s+using|refers?\s+to|mentions?|looks?\s+at)\s+(.+)$/i.exec(t)
    ?? /^(?:find|list|show(?:\s+me)?)\s+(?:everything|all(?:\s+the)?(?:\s+(?:logic|rules|questions|objects|conditions))?|every\s+\w+)\s+(?:that\s+)?(?:depends?\s+on|uses?|references?|reads?|mentions?)\s+(.+)$/i.exec(t)
    ?? /^(?:what|which(?:\s+\w+)?)\s+(?:is|are|would\s+be|gets?|will\s+be)\s+affected\s+by\s+(.+)$/i.exec(t)
    ?? /^(?:what|which)\s+(?:does|do|would|will)\s+(.+?)\s+(?:affect|impact|influence|feed(?:\s+into)?)$/i.exec(t)
    ?? /^where\s+(?:is|are)\s+(.+?)\s+(?:used|referenced|read)$/i.exec(t);
  if (!m) return null;
  const ref = m[1].replace(/^(?:the\s+)?(?:question|variable)\s+(?=\S)/i, (x) => (/question/i.test(x) && /^\d/.test(m[1].slice(x.length)) ? x : ""));
  const o = objectFor(r, ref);
  if ("fail" in o) return o.fail;
  const rep = dependencyReport(r.def, o.key, { index: index(r), label: o.label });
  return { kind: "answer", category: "dependency_analysis", understood: `List everything that reads ${o.label}, directly and indirectly.`, answer: rep.usedBySummary, sections: rep.usedBy, detected: [det("object", o.label)] };
};

const dependencies: Recogniser = (r) => {
  const m = /^(?:what|which(?:\s+\w+)?)\s+(?:does|do)\s+(.+?)\s+(?:depend\s+on|read|use|reference|rely\s+on|need|look\s+at)$/i.exec(r.text)
    ?? /^what\s+(?:is|are)\s+(.+?)\s+(?:based\s+on|depending\s+on)$/i.exec(r.text);
  if (!m) return null;
  const o = objectFor(r, m[1]);
  if ("fail" in o) return o.fail;
  const rep = dependencyReport(r.def, o.key, { index: index(r), label: o.label });
  return { kind: "answer", category: "dependency_analysis", understood: `List everything ${o.label} reads, directly and indirectly.`, answer: rep.readsSummary, sections: rep.reads, detected: [det("object", o.label)] };
};

/**
 * WHAT AN OBJECT IS WIRED TO, BOTH WAYS — the one reading the sentence
 * answers ("what depends on Q7?", "what does Q9 read?") and the Studio's
 * dependency view both show: what reads it, grouped by how (display logic,
 * skips, masks, piping, calculations, quotas, list logic, flow, the analysis
 * plan, constructs, translations), then what is reached only through those;
 * and what it reads, grouped the same way, then what that reads in turn.
 * Every item carries the dependency-index key, so a list can navigate.
 */
export interface DependencyReport {
  label: string;
  usedBy: AnswerSection[];
  reads: AnswerSection[];
  usedByCount: number;
  readsCount: number;
  usedBySummary: string;
  readsSummary: string;
}
export function dependencyReport(def: SurveyDefinition, key: ObjectKey, opts: { index?: DependencyIndex; label?: string } = {}): DependencyReport {
  const ix = opts.index ?? buildDependencyIndex(def);
  const label = opts.label ?? ix.nodes.get(key)?.code ?? key;
  /* what reads it */
  const direct = ix.usedBy(key).filter((e) => e.from !== key);
  const groups = new Map<string, AnswerItem[]>();
  const seen = new Set<string>();
  for (const e of direct) {
    const s = SECTION_OF[e.kind] ?? "Flow (branches, loops, blocks)";
    if (seen.has(`${s}|${e.from}`)) continue;
    seen.add(`${s}|${e.from}`);
    const d = edgeDetail(def, e);
    (groups.get(s) ?? groups.set(s, []).get(s)!).push({ label: e.label, key: e.from, ...(d ? { detail: d } : {}) });
  }
  const usedBy = sectioned(groups);
  const directKeys = new Set(direct.map((e) => e.from));
  const indirect = ix.affects(key).filter((k) => k !== key && !directKeys.has(k));
  if (indirect.length) usedBy.push({ title: "Indirectly affected", items: indirect.map((k) => ({ label: nodeWords(ix, k), key: k, detail: "reads something that reads it" })) });
  const n = directKeys.size;
  const usedBySummary = n
    ? `${plural(n, "object")} depend${n === 1 ? "s" : ""} on ${label}: ${countWords(usedBy.filter((s) => s.title !== "Indirectly affected"))}${indirect.length ? `; ${indirect.length} more ${indirect.length === 1 ? "is" : "are"} affected indirectly` : ""}.`
    : `Nothing depends on ${label}.`;
  /* what it reads — a question's own skip rules are part of it: what they read, it reads */
  const own = parseObjectKey(key).kind === "question" ? ix.dependsOn(key).filter((e) => parseObjectKey(e.to).kind === "skipRule" && e.to.startsWith(`skipRule:${parseObjectKey(key).id}/`)).map((e) => e.to) : [];
  const edges = [...ix.dependsOn(key).filter((e) => !own.includes(e.to)), ...own.flatMap((k) => ix.dependsOn(k))].filter((e) => e.to !== key);
  const rg = new Map<string, AnswerItem[]>();
  const rseen = new Set<string>();
  for (const e of edges) {
    const s = SECTION_OF[e.kind] ?? "Flow (branches, loops, blocks)";
    if (rseen.has(`${s}|${e.to}`)) continue;
    rseen.add(`${s}|${e.to}`);
    const node = ix.nodes.get(e.to);
    const d = edgeDetail(def, e);
    (rg.get(s) ?? rg.set(s, []).get(s)!).push({ label: `${node?.code ?? e.to} — ${e.label.split(" — ").slice(1).join(" — ") || e.kind}`, key: e.to, ...(d ? { detail: d } : {}) });
  }
  const reads = sectioned(rg);
  const readKeys = new Set(edges.map((e) => e.to));
  const further = ix.reach(key).filter((k) => k !== key && !readKeys.has(k) && !own.includes(k));
  if (further.length) reads.push({ title: "Indirectly", items: further.map((k) => ({ label: nodeWords(ix, k), key: k, detail: "read by something it reads" })) });
  const m = readKeys.size;
  const readsSummary = m ? `${label} depends on ${plural(m, "object")}: ${[...readKeys].map((k) => ix.nodes.get(k)?.code ?? k).join(", ")}${further.length ? `; ${further.length} more indirectly` : ""}.` : `${label} depends on nothing.`;
  return { label, usedBy, reads, usedByCount: n, readsCount: m, usedBySummary, readsSummary };
}

/* ---------------------------------------------------------- queries: impact */

function impactKey(o: ImpactItem["object"]): string {
  if (o.kind === "option") return objectKey("question", o.questionId ?? o.id);
  if (o.kind === "block" || o.kind === "page") return objectKey("flowNode", o.id);
  return objectKey(o.kind as ObjectKind, o.id);
}
function impactAnswer(report: ImpactReport, understood: string, detected: Detected[], extra: AnswerItem[] = []): Interpretation {
  const words = { breaks: "Breaks", changes: "Changes", informs: "To review" } as const;
  const sections: AnswerSection[] = (["breaks", "changes", "informs"] as const).map((s) => ({
    title: words[s],
    items: [...(s === "breaks" ? extra : []), ...report.items.filter((i) => i.severity === s).map((i) => ({ label: impactPhrase(i), key: impactKey(i.object), detail: `${i.text}${i.indirect ? " (indirect)" : ""}` }))],
  })).filter((s) => s.items.length);
  return { kind: "answer", category: "impact_analysis", understood, answer: report.summary, sections, detected };
}

const impact: Recogniser = (r) => {
  const t = r.text;
  const m = /^(?:what|which\s+\w+)\s+(?:will|would|could|might|does|do)?\s*(?:break|breaks|happens?|changes?|be\s+affected|is\s+affected|go\s+wrong|stop\s+working|fails?)\s+(?:if|when)\s+(?:i|we|you)\s+(delete|remove|drop|change|convert|move|retype|turn)\s+(.+)$/i.exec(t)
    ?? /^(?:can|could|may|should)\s+(?:i|we)\s+(?:safely\s+)?(delete|remove|drop)\s+(.+)$/i.exec(t)
    ?? /^is\s+it\s+safe\s+to\s+(delete|remove|drop|change|convert|move)\s+(.+)$/i.exec(t)
    ?? /^what\s+(?:is|would\s+be)\s+the\s+impact\s+of\s+(deleting|removing|dropping|changing|converting|moving)\s+(.+)$/i.exec(t)
    ?? /^if\s+(?:i|we)\s+(delete|remove|drop|change|convert|move)\s+(.+?),?\s+(?:what|which\s+\w+)\s+(?:will\s+|would\s+|could\s+)?(?:breaks?|happens?|changes?|is\s+affected|fails?)$/i.exec(t);
  if (!m) return null;
  const w = m[1].toLowerCase();
  const verb = /^(?:delet|remov|drop)/.test(w) ? "delete" : /^mov/.test(w) ? "move" : "change";
  const obj = m[2].trim();
  const def = r.def;
  if (verb === "delete") {
    const b = /\bblock\b/i.test(obj) ? blockOf(def, obj) : null;
    if (b) return impactAnswer(impactOf(def, { blocks: [b.id] }, { change: "delete", index: index(r) }), `List what deleting block “${b.title}” would break or change.`, [det("block", b.title)]);
    const opt = /^(?:the\s+)?(?:option|answer|choice)\s+(.+?)\s+(?:from|of|in|on|at)\s+(.+)$/i.exec(obj) ?? /^(.+?)\s+(?:from|of|in)\s+(.+)$/i.exec(obj);
    if (opt) {
      const q = resolveQuestionRef(def, opt[2], r.ctx);
      if (q.ok) {
        const o = resolveOptionRef(q.question, opt[1], { selected: r.ctx.selectedOption });
        if (o.ok) return impactAnswer(impactOf(def, { options: [{ questionId: q.question.id, codes: [o.option.code] }] }, { change: "delete", index: index(r) }), `List what removing option ${o.option.code} “${plain(o.option.label, 40)}” from ${code(q.question)} would break or change.`, [det("question", code(q.question)), det("option", `${o.option.code} (${plain(o.option.label, 40)})`)]);
        if (/^(?:the\s+)?(?:option|answer|choice)\s/i.test(obj)) return refused("impact_analysis", `Find what removing an option of ${code(q.question)} would break.`, o.reason, [det("question", code(q.question))]);
      }
    }
    const range = rangeOf(r, obj, "impact_analysis", `Find what deleting ${unquote(obj)} would break.`);
    if (!range.ok) return range.out;
    const qs = range.v;
    return impactAnswer(impactOf(def, { questions: qs.map((q) => q.id) }, { change: "delete", index: index(r) }), `List what deleting ${rangeLabel(def, qs)} would break or change.`, qDetected(qs));
  }
  if (verb === "move") {
    const mv = /^(.+?)\s+(after|below|before|above)\s+(.+)$/i.exec(obj);
    if (!mv) return null;
    const q = questionOf(r, mv[1], "impact_analysis", `Find what moving ${mv[1]} would break.`);
    if (!q.ok) return q.out;
    const anchor = questionOf(r, mv[3], "impact_analysis", `Find what moving ${code(q.v)} would break.`);
    if (!anchor.ok) return anchor.out;
    const after = /after|below/i.test(mv[2]) ? anchor.v : questionBefore(def, anchor.v);
    const move: SurveyAction = after ? { op: "move_question", target: code(q.v), after: code(after) } : { op: "move_question", target: code(q.v), block: listBlocks(def.flow as unknown[]).find((b) => b.pages.some((p) => p.node.questionIds.includes(anchor.v.id)))?.title ?? "" };
    const out = applySurveyActions(def, [move]);
    const failed = out.results.find((x) => !x.ok);
    if (failed) return impactAnswer(impactOf(def, { questions: [] }), `Find what moving ${code(q.v)} ${mv[2]} ${code(anchor.v)} would break.`, qDetected([q.v, anchor.v]), [{ label: `moving ${code(q.v)}`, key: objectKey("question", q.v.id), detail: failed.error }]);
    return impactAnswer(impactOf(out.def, { questions: [q.v.id] }, { change: "move" }), `List what moving ${code(q.v)} ${mv[2].toLowerCase()} ${code(anchor.v)} would break or change.`, qDetected([q.v, anchor.v]));
  }
  // change / convert: a type change is judged against the survey AFTER it — the operators must fit the new shape
  const to = /^(.+?)\s+(?:to|into)\s+(?:an?\s+)?(.+?)$/i.exec(obj);
  const type = to ? typeFromWords(to[2]) : null;
  if (!to || !type) return null;
  const q = questionOf(r, to[1], "impact_analysis", `Find what changing ${to[1]} to ${to[2]} would break.`);
  if (!q.ok) return q.out;
  const action: SurveyAction = { op: "update_question", target: code(q.v), type };
  const out = applySurveyActions(def, [action]);
  const failed = out.results.find((x) => !x.ok);
  const understood = `List what changing ${code(q.v)} from ${kindOf(q.v)} to ${variantName(variantForActionType(type)!)} would break or change.`;
  if (failed) return impactAnswer(impactOf(def, { questions: [] }), understood, qDetected([q.v]), [{ label: `changing ${code(q.v)} to ${to[2]}`, key: objectKey("question", q.v.id), detail: failed.error }]);
  return impactAnswer(impactOf(out.def, { questions: [q.v.id] }, { change: "retype" }), understood, [...qDetected([q.v]), det("new type", variantName(variantForActionType(type)!))]);
};

/** the placed question just before `q` in flow order */
function questionBefore(def: SurveyDefinition, q: Question): Question | undefined {
  const order = placedOrder(def);
  const i = order.indexOf(q.id);
  return i > 0 ? def.questions.find((x) => x.id === order[i - 1]) : undefined;
}

/* ---------------------------------------------------------- queries: translations */

const untranslated: Recogniser = (r) => {
  const t = r.text;
  const m = /^(?:which|what)\s+(?:questions?|elements?|texts?|strings?|parts?)\s+(?:are|is)\s+(?:still\s+)?(?:untranslated|not\s+(?:yet\s+)?translated|missing\s+(?:a\s+|their\s+)?translations?|outdated|not\s+translated\s+yet)(?:\s+(?:in|into|for)\s+(.+))?$/i.exec(t)
    ?? /^what(?:'s|\s+is)\s+(?:still\s+)?(?:missing|untranslated|left\s+to\s+translate|outdated|not\s+translated)\s+(?:in|for|from)\s+(?:the\s+)?(.+?)$/i.exec(t)
    ?? /^(?:is|are)\s+(?:the\s+)?(.+?)\s+(?:translations?|versions?)\s+(?:complete|done|finished|ready)$/i.exec(t)
    ?? /^(?:what|which)\s+(?:still\s+)?needs?\s+(?:to\s+be\s+)?translat(?:ing|ed|ion)(?:\s+(?:in|into|for)\s+(.+))?$/i.exec(t)
    ?? /^(?:show|list)\s+(?:me\s+)?(?:the\s+|all\s+)?(?:untranslated|missing|outdated)\s+(?:questions|translations|texts|elements)(?:\s+(?:in|for)\s+(.+))?$/i.exec(t)
    ?? /^(?:which|what)\s+translations\s+are\s+(?:outdated|stale|out\s+of\s+date|missing)()$/i.exec(t);
  if (!m) return null;
  const def = r.def;
  const loc = effectiveLocalization(def);
  const langs = loc.languages.filter((l) => l.code !== loc.sourceLanguage);
  const asked = m[1] ? languageFrom(m[1]) : null;
  if (m[1] && !asked) return null;
  const understood = `List what is missing or outdated${asked ? ` in ${asked.name}` : " in each language"}.`;
  if (!langs.length) return { kind: "answer", category: "translation", understood, answer: `This survey has only its source language (${languageName(loc.sourceLanguage)}) — there is nothing to translate yet. Add one first, e.g. “add French as a language”.`, sections: [], detected: asked ? [det("language", `${asked.name} (${asked.code})`)] : [] };
  if (asked && !langs.some((l) => l.code === asked.code)) {
    return { kind: "answer", category: "translation", understood, answer: `${asked.name} is not a language of this survey — its languages are ${langs.map((l) => languageName(l.code, l)).join(", ")}. Say “add ${asked.name} as a language” to add it.`, sections: [], detected: [det("language", `${asked.name} (${asked.code})`)] };
  }
  const sections: AnswerSection[] = [];
  const lines: string[] = [];
  for (const l of langs.filter((x) => !asked || x.code === asked.code)) {
    const rep = lintLanguage(def, l.code);
    const issues = rep.issues.filter((i) => i.kind === "missing" || i.kind === "stale_source" || i.kind === "untranslated");
    const byQ = new Map<string, { missing: number; outdated: number; same: number; labels: string[] }>();
    for (const i of issues) {
      const k = i.questionId ?? "";
      const g = byQ.get(k) ?? byQ.set(k, { missing: 0, outdated: 0, same: 0, labels: [] }).get(k)!;
      if (i.kind === "missing") g.missing++; else if (i.kind === "stale_source") g.outdated++; else g.same++;
      if (g.labels.length < 3) g.labels.push(plain(i.label, 30));
    }
    const items: AnswerItem[] = [...byQ].map(([qid, g]) => {
      const q = def.questions.find((x) => x.id === qid);
      const parts = [g.missing ? `${g.missing} missing` : "", g.outdated ? `${g.outdated} outdated` : "", g.same ? `${g.same} identical to the source` : ""].filter(Boolean).join(", ");
      return { label: q ? code(q) : "Survey texts", ...(q ? { key: objectKey("question", q.id) } : {}), detail: `${parts} (${g.labels.join(", ")}${g.missing + g.outdated + g.same > g.labels.length ? ", …" : ""})` };
    });
    const name = languageName(l.code, l);
    const questions = items.filter((i) => i.key).length;
    sections.push({ title: `${name} — ${rep.completion}% complete`, items });
    lines.push(items.length ? `${name}: ${plural(questions, "question")}${items.some((i) => !i.key) ? " and some survey texts" : ""} with missing or outdated text (${rep.completion}% complete)` : `${name}: fully translated`);
  }
  return { kind: "answer", category: "translation", understood, answer: `${lines.join("; ")}.`, sections: sections.filter((s) => s.items.length), detected: asked ? [det("language", `${asked.name} (${asked.code})`)] : [] };
};

/* ---------------------------------------------------------- queries: research */

/**
 * Concept words for "which questions measure X": a researcher's construct
 * name is rarely the wording of the question ("purchase intent" is asked as
 * "how likely are you to buy …"), so each word brings its everyday family.
 * Kept small and obvious — anything subtler is the model's.
 */
const CONCEPTS: string[][] = [
  ["purchase", "buy", "bought", "buying", "order", "shop", "shopp"],
  ["intent", "intention", "intend", "likely", "likelihood", "plan", "consider", "probability"],
  ["satisfaction", "satisfied", "satisfi", "happy", "pleased", "content"],
  ["awareness", "aware", "heard", "familiar", "recognise", "recognize", "know"],
  ["loyalty", "loyal", "recommend", "again", "repeat", "nps"],
  ["usage", "use", "used", "using", "consume"],
  ["price", "cost", "expensive", "cheap", "afford", "pay", "spend", "value"],
  ["age", "old", "year", "born"],
  ["gender", "sex", "male", "female"],
  ["income", "earn", "salary", "household"],
  ["trust", "trustworthy", "reliable", "rely"],
  ["preference", "prefer", "favourite", "favorite", "best"],
];
const family = (w: string): Set<string> => {
  const s = stemWord(w);
  const g = CONCEPTS.find((xs) => xs.some((x) => stemWord(x) === s));
  return new Set([s, ...(g ?? []).map(stemWord)]);
};
const QUERY_STOP = new Set(["measure", "measur", "capture", "captur", "asses", "assess", "track", "cover", "relat", "relate", "deal", "concept", "thing", "topic", "our", "my", "their", "study", "survey"]);

const measures: Recogniser = (r) => {
  const m = /^(?:which|what)\s+(?:questions?|variables?|items?)\s+(?:measures?|captures?|assess(?:es)?|covers?|asks?\s+about|are\s+about|is\s+about|relates?\s+to|deals?\s+with|tracks?|measure|capture)\s+(.+)$/i.exec(r.text)
    ?? /^(?:where|how)\s+(?:do|does)\s+(?:we|the\s+survey|this\s+survey|it|this\s+study|the\s+study)\s+(?:measure|capture|ask\s+about|assess|cover)\s+(.+)$/i.exec(r.text);
  if (!m) return null;
  const def = r.def;
  const phrase = unquote(m[1]);
  const words = contentWords(phrase).filter((w) => !QUERY_STOP.has(w));
  if (!words.length) return null;
  const fams = words.map(family);
  const score = (text: string) => { const have = new Set(contentWords(text)); return fams.filter((f) => [...f].some((x) => have.has(x))).length; };
  const sections: AnswerSection[] = [];
  const evidence = new Map<string, string[]>();
  const note = (q: Question, why: string) => evidence.set(q.id, [...(evidence.get(q.id) ?? []), why]);
  const constructs = (def.research?.constructs ?? []).filter((c) => score(`${c.name} ${c.definition ?? ""}`) === fams.length);
  if (constructs.length) {
    sections.push({ title: "Research constructs", items: constructs.flatMap((c) => {
      const qs = c.questionIds.map((id) => def.questions.find((q) => q.id === id)).filter((q): q is Question => !!q);
      qs.forEach((q) => note(q, `construct “${c.name}”`));
      return qs.length ? qs.map((q) => ({ label: code(q), key: objectKey("question", q.id), detail: `measures the construct “${c.name}” (${c.role}) — ${plain(q.text, 60)}` }))
        : [{ label: `construct “${c.name}”`, key: objectKey("construct", c.name), detail: "recorded in the research design, but no question measures it yet" }];
    }) });
  }
  const tagged = def.questions.filter((q) => q.analysis?.construct && score(q.analysis.construct) === fams.length);
  if (tagged.length) {
    tagged.forEach((q) => note(q, "analysis tag"));
    sections.push({ title: "Tagged in the analysis", items: tagged.map((q) => ({ label: code(q), key: objectKey("question", q.id), detail: `its analysis says it measures “${q.analysis!.construct}” — ${plain(q.text, 60)}` })) });
  }
  // a grid's rows are what it measures ("Price", "Quality"), so they count as its wording; options are answers, and do not
  const wordingOf = (q: Question) => `${q.text} ${q.variableName} ${(q.rows ?? []).map((x) => x.label).join(" ")}`;
  const scored = def.questions.map((q) => ({ q, s: score(wordingOf(q)) })).filter((x) => x.s > 0);
  const best = Math.max(0, ...scored.map((x) => x.s));
  const wording = scored.filter((x) => x.s === best);
  if (wording.length) {
    wording.forEach((x) => note(x.q, "wording"));
    const have = (q: Question) => { const ws = new Set(contentWords(wordingOf(q))); return [...new Set(fams.flatMap((f) => [...f].filter((x) => ws.has(x))))]; };
    sections.push({ title: best === fams.length ? "By wording" : "By wording (partial match)", items: wording.map((x) => ({ label: code(x.q), key: objectKey("question", x.q.id), detail: `its wording mentions ${have(x.q).join(", ")} — ${plain(x.q.text, 60)}` })) });
  }
  const understood = `Find the questions that measure “${phrase}”: research constructs, analysis tags, and wording.`;
  if (!evidence.size && !constructs.length) return { kind: "answer", category: "research_design", understood, answer: `No question measures “${phrase}” — no construct, analysis tag or question wording matches it.`, sections: [], detected: [det("concept", phrase)] };
  const answer = [...evidence].map(([id, why]) => `${code(def.questions.find((q) => q.id === id)!)} (${[...new Set(why)].join(", ")})`).join("; ");
  return { kind: "answer", category: "research_design", understood, answer: `“${cap(phrase)}” is measured by ${answer || "a construct no question measures yet"}.`, sections, detected: [det("concept", phrase)] };
};

const savedOrBuilt = (def: SurveyDefinition) => ({ plan: def.research?.analysisPlan ?? buildAnalysisFramework(def, { now: "" }), saved: !!def.research?.analysisPlan });
const testWords = (t: { method: string; outcome?: string; groupBy?: string; variables: string[] }) =>
  `${t.method.replace(/_/g, " ").replace(/^t test$/, "t-test")}${t.outcome ? ` on ${t.outcome}` : ""}${t.groupBy ? ` across ${t.groupBy}` : ""}${t.variables.length ? ` with ${t.variables.join(", ")}` : ""}`;
/** a plan item's reason with the hypotheses it serves — unless the reason already names them */
const withHypotheses = (reason: string | undefined, hyps: string[]): string => {
  const missing = hyps.filter((h) => !(reason ?? "").includes(h));
  return `${reason ?? ""}${missing.length ? ` (${missing.join(", ")})` : ""}`.trim();
};
const varKey = (def: SurveyDefinition, name: string) => { const q = getQuestionByCodeOrVar(def, name); return q ? objectKey("question", q.id) : undefined; };

const analysisQuery: Recogniser = (r) => {
  const t = r.text;
  const def = r.def;
  if (/^(?:what|which)\s+(?:analys[ie]s|tests?|statistics|stats|statistical\s+tests?)\s+(?:can|could|should)\s+(?:i|we)\s+(?:run|do|perform|use)\b/i.test(t)
    || /^how\s+(?:should|can|could)\s+(?:i|we)\s+analy[sz]e\b/i.test(t)
    || /^(?:what(?:'s|\s+is)\s+the\s+analysis\s+plan|show\s+(?:me\s+)?the\s+analysis\s+(?:plan|framework))$/i.test(t)) {
    const { plan, saved } = savedOrBuilt(def);
    const sections: AnswerSection[] = [
      { title: "Crosstabs", items: plan.crosstabs.map((x) => ({ label: `${x.rows.join(" + ")} by ${x.columns.join(" + ")}`, key: objectKey("analysis", x.id), detail: `${withHypotheses(x.reason, x.hypotheses)} — priority ${x.priority}`.replace(/^ — /, "") })) },
      { title: "Tests", items: plan.tests.map((x) => ({ label: testWords(x), key: objectKey("analysis", x.id), detail: withHypotheses(x.reason, x.hypotheses) || undefined })) },
      { title: "Derived variables", items: plan.derived.map((d) => ({ label: d.name, key: objectKey("analysis", `derived:${d.name}`), detail: `${d.kind.replace(/_/g, " ")} of ${d.from.join(", ")}${d.reason ? ` — ${d.reason}` : ""}` })) },
      { title: "Segments", items: plan.segments.map((s) => ({ label: s.name, key: objectKey("analysis", `segment:${s.name}`), detail: `by ${s.by.join(", ")}` })) },
    ].filter((s) => s.items.length);
    const counts = [plural(plan.crosstabs.length, "crosstab"), plural(plan.tests.length, "test"), plan.derived.length ? plural(plan.derived.length, "derived variable") : "", plan.segments.length ? plural(plan.segments.length, "segment") : ""].filter(Boolean).join(", ");
    return { kind: "answer", category: "analysis", understood: "List the analysis this study supports.", answer: saved ? `The saved analysis plan has ${counts}.` : `From the survey's design (no plan is saved yet — say “create an analysis framework” to save it): ${counts}.`, sections, detected: [] };
  }
  if (/^(?:which|what)\s+(?:variables?|questions?)\s+should\s+(?:be\s+|i\s+|we\s+)?cross[-\s]?tab(?:bed|ulated|ulate)?\b/i.test(t)
    || /^what\s+should\s+(?:i|we)\s+cross[-\s]?tab(?:ulate)?\b/i.test(t)
    || /^(?:which|what)\s+cross[-\s]?tab(?:ulation)?s?\s+(?:should|can|do|could)\b/i.test(t)
    || /^(?:suggest|recommend|propose)\s+(?:some\s+)?cross[-\s]?tab(?:ulation)?s\b/i.test(t)) {
    const { plan, saved } = savedOrBuilt(def);
    const top = prioritizeCrosstabs(def, 10, plan);
    const banner = segmentationQuestions(def);
    const sections: AnswerSection[] = [
      { title: "Crosstabs, most important first", items: top.map((x) => ({ label: `${x.rows.join(" + ")} by ${x.columns.join(" + ")}`, key: objectKey("analysis", x.id), detail: withHypotheses(x.reason, x.hypotheses) || undefined })) },
      { title: "Banner (what to cut by)", items: banner.map((q) => ({ label: `${code(q)} (${q.variableName})`, key: objectKey("question", q.id), detail: plain(q.text, 60) })) },
    ].filter((s) => s.items.length);
    return { kind: "answer", category: "analysis", understood: "Recommend the crosstabs for this study.", answer: top.length ? `${plural(top.length, "crosstab")} ${saved ? "in the saved plan" : "follow from the design"}; the banner is ${banner.length ? banner.map(code).join(", ") : "not identified (no demographic or segmentation questions)"}.` : "No crosstab follows from the design yet — tag the outcomes and the segmentation questions in the analysis, or ask the copilot to propose a plan.", sections, detected: [] };
  }
  const seg = /^(?:which|what)\s+(?:variables?|questions?)\s+(?:are\s+)?(?:used\s+)?(?:in|define|make\s+up|for)\s+(?:the\s+)?segment\s+(.+)$/i.exec(t)
    ?? /^(?:which|what)\s+(?:variables?|questions?)\s+(?:are\s+)?used\s+in\s+(?:the\s+)?(.+?)\s+segment$/i.exec(t)
    ?? /^what\s+defines\s+(?:the\s+)?(?:segment\s+)?(.+?)(?:\s+segment)?$/i.exec(t);
  if (seg) {
    const { plan } = savedOrBuilt(def);
    const want = unquote(seg[1]).toLowerCase();
    const s = plan.segments.find((x) => x.name.toLowerCase() === want) ?? plan.segments.find((x) => x.name.toLowerCase().includes(want));
    if (!s) return { kind: "answer", category: "analysis", understood: `List the variables of segment “${unquote(seg[1])}”.`, answer: `There is no segment “${unquote(seg[1])}”${plan.segments.length ? ` — the segments are ${plan.segments.map((x) => `“${x.name}”`).join(", ")}` : " — the plan has no segments"}.`, sections: [], detected: [] };
    return { kind: "answer", category: "analysis", understood: `List the variables of segment “${s.name}”.`, answer: `Segment “${s.name}” is defined by ${s.by.join(", ")}.`, sections: [{ title: `Segment “${s.name}”`, items: s.by.map((v) => ({ label: v, ...(varKey(def, v) ? { key: varKey(def, v) } : {}), detail: plain(getQuestionByCodeOrVar(def, v)?.text, 60) || undefined })) }], detected: [det("segment", s.name)] };
  }
  return null;
};

/* ---------------------------------------------------------- queries: why this analysis */

/*
 * "WHY ARE YOU RECOMMENDING A REGRESSION?" — answered by the engine from the
 * plan item's explanation (`explainPlanItem`): the objective it serves, the
 * variables and their levels, the rule that chose the method, what the run
 * will produce, the sample it needs against the sample expected, and what to
 * keep in mind. It was the model's to word from structured facts; the facts
 * are the answer. The item is found by the method named, by the variables
 * named, or — "explain the analysis plan", "why this analysis" — it is the
 * whole plan.
 */
const WHY_METHODS: [RegExp, { kind: "crosstab" | "test" | "derived" | "segment"; methods?: string[]; derivedKinds?: string[] }][] = [
  [/^(?:key\s+)?drivers?(?:\s+analysis)?$|^(?:linear\s+|multiple\s+)?regressions?(?:\s+(?:analysis|model))?$|^(?:the\s+)?models?$/i, { kind: "test", methods: ["regression", "driver_analysis", "logistic_regression"] }],
  [/^logistic(?:\s+regression)?$|^logit$/i, { kind: "test", methods: ["logistic_regression"] }],
  [/^t[-\s]?tests?$/i, { kind: "test", methods: ["t_test"] }],
  [/^(?:one[-\s]way\s+)?anovas?$|^analysis\s+of\s+variance$/i, { kind: "test", methods: ["anova"] }],
  [/^chi[-\s]?squares?(?:\s+tests?)?$|^χ²$/i, { kind: "test", methods: ["chi_square"] }],
  [/^correlations?$/i, { kind: "test", methods: ["correlation"] }],
  [/^(?:mann[-\s–]whitney|kruskal[-\s–]wallis)(?:\s+tests?)?$/i, { kind: "test", methods: ["mann_whitney", "kruskal_wallis"] }],
  [/^reliability(?:\s+analysis)?$|^cronbach(?:'s)?(?:\s+alpha|\s+α)?$/i, { kind: "test", methods: ["reliability"] }],
  [/^factor(?:\s+analysis)?$/i, { kind: "test", methods: ["factor"] }],
  [/^cluster(?:ing|\s+analysis)?$/i, { kind: "test", methods: ["cluster"] }],
  [/^max\s?diff(?:\s+scores?)?$/i, { kind: "test", methods: ["maxdiff_scores"] }],
  [/^conjoint(?:\s+utilities)?$/i, { kind: "test", methods: ["conjoint_utilities"] }],
  [/^nps$|^net\s+promoter(?:\s+score)?$/i, { kind: "test", methods: ["nps"] }],
  [/^cross[-\s]?tab(?:ulation)?s?$|^tables?$|^banners?$/i, { kind: "crosstab" }],
  [/^top[-\s]?(?:2|two)[-\s]?box(?:es)?$|^t2b$|^top[-\s]?box(?:es)?$/i, { kind: "derived", derivedKinds: ["top_box"] }],
  [/^(?:mean\s+)?scores?$|^(?:the\s+)?(?:construct\s+)?scores?$/i, { kind: "derived", derivedKinds: ["mean_score", "sum_score"] }],
  [/^derived\s+variables?$/i, { kind: "derived" }],
  [/^segments?(?:ation)?$/i, { kind: "segment" }],
];
const WHOLE_PLAN = /^(?:(?:(?:the|this|that|your|our)\s+)?(?:analysis\s+)?(?:plan|framework|analys[ie]s|analysis\s+(?:plan|framework))|this|that|it|these|them)$/i;

type PlanItemAny = Parameters<typeof explainPlanItem>[1];

const analysisWhy: Recogniser = (r) => {
  const t = r.text.replace(/\?+$/, "").trim();
  const def = r.def;
  /* how many completes the plan needs */
  if ((/\bsample\s+size\b|\bhow\s+many\s+(?:completes|respondents|interviews|people|responses)\b|\bhow\s+(?:big|large)\s+(?:a\s+)?sample\b|\bwhat\s+(?:base|n)\s+do\b/i.test(t)) && /\b(?:need|require|enough|should|plan|analysis|analyses)\b/i.test(t) && !/^(?:set|make|change|add)\b/i.test(t)) {
    const { plan, saved } = savedOrBuilt(def);
    const s = planSampleSize(def, plan);
    const exp = s.expected;
    const verdict = !exp ? "No sample is recorded to compare it with — set quota targets or the research design's sample size." : s.minimum > exp.n ? `That is more than ${exp.note} (${exp.detail}).` : `${exp.note.replace(/^./, (c) => c.toUpperCase())}, which is enough.`;
    const sections: AnswerSection[] = [
      { title: "Required sample by item", items: s.items.slice(0, 12).map((x) => ({ label: x.title.replace(/^./, (c) => c.toUpperCase()), detail: `about ${x.minimum} — ${x.note}` })) },
      { title: "Expected sample", items: [{ label: exp ? exp.detail : "Nothing records it", ...(exp ? {} : { detail: "the quotas have no targets and the research design no sample size" }) }] },
      ...(s.driver ? [{ title: "The rule that drives it", items: [{ label: s.driver.title, detail: s.driver.requiredBase.rule }] }] : []),
    ];
    return { kind: "answer", category: "analysis", understood: `Work out the sample the ${saved ? "saved" : "engine's"} analysis plan needs.`, answer: `The plan needs about ${s.minimum} completes${s.driver ? `, driven by ${s.driver.title.replace(/^./, (c) => c.toLowerCase())} (${s.driver.requiredBase.note})` : ""}. ${verdict}`, sections, detected: s.driver ? [det("driving item", s.driver.title)] : [] };
  }
  /* which item the sentence asks about */
  let phrase: string | null = null;
  let pair: [string, string] | null = null;
  let m: RegExpExecArray | null;
  if ((m = /^why\s+(?:are|do|did|would)\s+(?:you|we)\s+(?:recommend(?:ing)?|suggest(?:ing)?|propos(?:e|ing)|plan(?:ning)?|includ(?:e|ing)|us(?:e|ing))\s+(.+)$/i.exec(t))) phrase = m[1];
  else if ((m = /^why\s+(?:is|was)\s+(?:the\s+engine\s+|it\s+)?(?:recommending|suggesting|proposing|planning)\s+(.+)$/i.exec(t))) phrase = m[1];
  else if ((m = /^why\s+(?:is|are)\s+(\S+)\s+(?:crossed|cross[-\s]?tabbed|cross[-\s]?tabulated|tabulated|compared|tested|correlated|regressed|analy[sz]ed)\s+(?:with|by|against|across|on)\s+(\S+)$/i.exec(t))) pair = [m[1], m[2]];
  else if ((m = /^why\s+(?:(?:a|an|the|this|that)\s+)?(.+?)(?:\s+(?:on|of|for|between|across|with|by)\s+(.+))?$/i.exec(t)) && WHY_METHODS.some(([re]) => re.test(m![1].trim()))) phrase = m[2] ? `${m[1]} on ${m[2]}` : m[1];
  else if (/^why\s+(?:this|that|these|the)\s+(?:analys[ie]s|analysis\s+plan|plan|framework|methods?)$/i.test(t) || /^(?:explain|justify|walk\s+me\s+through)\s+(?:the\s+|this\s+|your\s+)?(?:analysis\s+plan|analysis\s+framework|analysis|plan)$/i.test(t)) phrase = "the plan";
  else if ((m = /^(?:explain|justify)\s+(?:the\s+|this\s+)?(.+?)(?:\s+(?:on|of|for|between|across|with|by)\s+(.+))?$/i.exec(t)) && WHY_METHODS.some(([re]) => re.test(m![1].trim()))) phrase = m[2] ? `${m[1]} on ${m[2]}` : m[1];
  if (!phrase && !pair) return null;

  const { plan, saved } = savedOrBuilt(def);
  const all: PlanItemAny[] = [...plan.crosstabs, ...plan.tests, ...plan.derived, ...plan.segments];
  const label = (x: PlanItemAny) => planItemTitle(def, x).replace(/^./, (c) => c.toUpperCase());
  const varsOf = (x: PlanItemAny): string[] => ("rows" in x ? [...x.rows, ...x.columns] : "method" in x ? [x.outcome, x.groupBy, x.moderator, x.mediator, ...x.variables].filter((v): v is string => !!v) : "from" in x ? [x.name, ...x.from] : [segmentVariableName(x), ...x.by]);
  const named = (s: string): string[] => {
    // every question the words name (codes and variable names), as variable names; derived / segment names as they are
    const out: string[] = [];
    for (const w of s.split(/[\s,]+|\band\b/i).map((x) => x.replace(/^["“'‘(]+|["”'’).?]+$/g, "")).filter(Boolean)) {
      const q = getQuestionByCodeOrVar(def, w) ?? def.questions.find((x) => String(x.code).toLowerCase() === w.toLowerCase() || x.variableName.toLowerCase() === w.toLowerCase());
      if (q) out.push(q.variableName);
      else if (all.some((x) => varsOf(x).some((v) => v.toLowerCase() === w.toLowerCase()))) out.push(all.flatMap(varsOf).find((v) => v.toLowerCase() === w.toLowerCase())!);
    }
    return out;
  };
  const understood = (what: string) => `Explain why the ${saved ? "saved" : "engine's"} analysis plan includes ${what}.`;

  /* the whole plan */
  if (phrase && WHOLE_PLAN.test(phrase.trim())) {
    const ex = explainPlan(def, plan);
    if (!ex.length) return { kind: "answer", category: "analysis", understood: "Explain the analysis plan.", answer: "The plan is empty — nothing in the design implies a table or a test yet. Mark the outcomes and the segmentation questions (Properties → Analysis), or say “create an analysis framework”.", sections: [], detected: [] };
    const size = planSampleSize(def, plan);
    const sections: AnswerSection[] = [
      { title: "Objective", items: [{ label: ex[0].objective.split(/(?<=\.)\s/)[0] }, ...(def.research?.hypotheses ?? []).map((h, i) => ({ label: `${hypothesisLabel(i)}: ${plain(h, 90)}`, detail: `${ex.filter((e) => e.hypotheses.some((x) => x.label === hypothesisLabel(i))).length} planned item(s) serve it` }))] },
      { title: "Why each item", items: ex.map((e) => ({ label: e.title, ...(e.kind === "crosstab" || e.kind === "test" ? { key: objectKey("analysis", e.id) } : {}), detail: e.why })) },
      { title: "Required sample", items: [{ label: `about ${size.minimum} completes`, detail: `${size.driver ? `driven by ${size.driver.title.replace(/^./, (c) => c.toLowerCase())} (${size.driver.requiredBase.note})` : ""}${size.expected ? ` — ${size.expected.note}` : " — no sample is recorded"}` }] },
    ].filter((s) => s.items.length);
    return { kind: "answer", category: "analysis", understood: "Explain the analysis plan: why each item is there.", answer: `${saved ? "The saved plan" : "The engine's plan (not saved yet)"} has ${plural(ex.length, "item")}; each follows from the measurement levels and roles of the questions it reads. The whole plan needs about ${size.minimum} completes${size.expected ? ` (${size.expected.note})` : ""}.`, sections, detected: [] };
  }

  /* one item: by the variables named, the method named, or both */
  let pool = all;
  let want = "";
  if (pair) {
    const vs = [...named(pair[0]), ...named(pair[1])];
    if (vs.length < 2) return { kind: "refused", category: "analysis", understood: understood(`${pair[0]} with ${pair[1]}`), reason: `${[pair[0], pair[1]].filter((p) => !named(p).length).join(" and ")} ${[pair[0], pair[1]].filter((p) => !named(p).length).length === 1 ? "is" : "are"} not a question or planned variable of this survey.`, detected: [] };
    pool = all.filter((x) => vs.every((v) => varsOf(x).includes(v)));
    want = `${pair[0]} with ${pair[1]}`;
  } else if (phrase) {
    const [, methodPart, varPart] = /^(.+?)(?:\s+(?:on|of|for|between|across|with|by)\s+(.+))?$/i.exec(phrase.trim().replace(/^(?:a|an|the|this|that)\s+/i, "")) ?? [];
    const spec = WHY_METHODS.find(([re]) => re.test((methodPart ?? "").trim()))?.[1];
    const vs = named(varPart ?? (spec ? "" : phrase));
    if (spec) pool = pool.filter((x) => planItemKind(x) === spec.kind && (!spec.methods || ("method" in x && spec.methods.includes(x.method))) && (!spec.derivedKinds || ("from" in x && spec.derivedKinds.includes(x.kind))));
    if (vs.length) pool = pool.filter((x) => vs.every((v) => varsOf(x).includes(v)));
    if (!spec && !vs.length) return null; // not about the analysis
    want = phrase.trim();
  }
  if (!pool.length) {
    const avail = [...new Set(all.map((x) => ("method" in x ? (METHOD_NAMES[x.method] ?? x.method.replace(/_/g, " ")) : planItemKind(x))))];
    return { kind: "answer", category: "analysis", understood: understood(want), answer: `The ${saved ? "saved" : "engine's"} plan has no ${want}${avail.length ? ` — it plans ${avail.join(", ")}` : " — it is empty"}. Ask “explain the analysis plan” for every item, or “add a … to the analysis plan” to plan one.`, sections: [], detected: [] };
  }
  // the most important match: a hypothesis-linked item first, then by priority
  const ranked = [...pool].sort((a, b) => (("hypotheses" in b ? b.hypotheses.length : 0) - ("hypotheses" in a ? a.hypotheses.length : 0)) || (("priority" in a ? a.priority : 2) - ("priority" in b ? b.priority : 2)));
  const e = explainPlanItem(def, ranked[0], plan);
  const exp = e.expectedSample;
  const sections: AnswerSection[] = [
    { title: "Objective", items: [{ label: e.objective }, ...e.hypotheses.map((h) => ({ label: `${h.label}: ${plain(h.text, 90)}` }))] },
    { title: "Variables", items: e.variables.map((v) => ({ label: `${v.code}${v.code !== v.name ? ` (${v.name})` : ""} — ${v.role}`, ...(varKey(def, v.name) ? { key: varKey(def, v.name) } : {}), detail: `${v.level}${v.categories ? `, ${v.categories} categories` : ""} · ${v.designRole}${v.text ? ` · ${plain(v.text, 60)}` : ""}` })) },
    { title: "Why this method", items: [{ label: e.why }] },
    { title: "Expected output", items: [{ label: e.expectedOutput }] },
    { title: "Required sample", items: [{ label: `about ${e.requiredBase.minimum} completes (${e.requiredBase.note})`, detail: `${e.requiredBase.rule}${exp ? ` — ${e.requiredBase.minimum > exp.n ? `more than ${exp.note}` : exp.note}` : " — no expected sample is recorded"}` }] },
    { title: "Limitations", items: e.limitations.map((l) => ({ label: l })) },
    ...(ranked.length > 1 ? [{ title: "Also planned", items: ranked.slice(1, 8).map((x) => ({ label: label(x), ...("id" in x && typeof x.id === "string" ? { key: objectKey("analysis", x.id) } : {}) })) }] : []),
  ].filter((s) => s.items.length);
  return { kind: "answer", category: "analysis", understood: understood(e.title.replace(/^./, (c) => c.toLowerCase())), answer: e.text, sections, detected: [det("plan item", e.title), ...e.variables.filter((v) => resolve(def, v.name)).map((v) => det("question", v.code))] };
};
const METHOD_NAMES: Record<string, string> = { t_test: "a t-test", anova: "an ANOVA", chi_square: "a chi-square test", correlation: "a correlation", regression: "a regression", logistic_regression: "a logistic regression", reliability: "a reliability analysis", maxdiff_scores: "MaxDiff scores", conjoint_utilities: "conjoint utilities", nps: "NPS" };
const resolve = (def: SurveyDefinition, name: string) => getQuestionByCodeOrVar(def, name) ?? def.questions.find((q) => q.id === name);

const hypothesesQuery: Recogniser = (r) => {
  const t = r.text;
  if (!(/^(?:what|which)\s+(?:are\s+)?(?:the\s+|our\s+)?(?:key\s+|main\s+)?hypothes[ie]s\s+(?:can|could|should|do)\s+(?:we|i)\s+test\b/i.test(t)
    || /^(?:list|show)\s+(?:me\s+)?(?:the\s+|our\s+)?(?:key\s+)?hypothes[ie]s\b/i.test(t)
    || /^what\s+are\s+(?:the|our)\s+(?:key\s+|main\s+)?hypothes[ie]s\b/i.test(t)
    || /^(?:are|is)\s+(?:the|our|every)\s+hypothes[ie]s\s+(?:covered|testable|measured)\b/i.test(t))) return null;
  const def = r.def;
  const cov = hypothesisCoverage(def);
  const understood = "List the recorded hypotheses and whether the survey and the plan can test them.";
  if (!cov.length) {
    const constructs = def.research?.constructs ?? [];
    const outcomes = def.questions.filter((q) => q.analysis?.role === "dependent" || q.analysis?.construct);
    const sections: AnswerSection[] = [
      { title: "Constructs the survey measures", items: constructs.map((c) => ({ label: c.name, key: objectKey("construct", c.name), detail: `${c.role}${c.questionIds.length ? ` — ${c.questionIds.map((id) => def.questions.find((q) => q.id === id)?.code).filter(Boolean).join(", ")}` : " — not measured yet"}` })) },
      { title: "Questions tagged as outcomes", items: outcomes.filter((q) => !constructs.some((c) => c.questionIds.includes(q.id))).map((q) => ({ label: code(q), key: objectKey("question", q.id), detail: `${q.analysis?.construct ?? q.analysis?.role} — ${plain(q.text, 60)}` })) },
    ].filter((s) => s.items.length);
    return { kind: "answer", category: "research_design", understood, answer: `No hypotheses are recorded for this study yet.${sections.length ? " The survey measures the constructs below; hypotheses would relate them —" : ""} The copilot can propose some (ask “propose hypotheses for this study”), or add one with “add hypothesis: …”.`, sections, detected: [] };
  }
  const STATUS = { testable: "testable — measured, and the plan tests it", partly: "measured, but no test is planned yet", unmeasured: "a construct it names has no question", unlinked: "no construct or question is linked to it" } as const;
  const items: AnswerItem[] = cov.map((h) => ({
    label: `${h.label}: ${plain(h.text, 80)}`,
    detail: `${STATUS[h.status]}${h.constructs.length ? ` · constructs ${h.constructs.map((c) => `${c.name}${c.questions.length ? ` (${c.questions.join(", ")})` : " (unmeasured)"}`).join(", ")}` : ""}${h.tests.length ? ` · tests: ${h.tests.map(testWords).join("; ")}` : ""}${h.crosstabs.length ? ` · crosstabs: ${h.crosstabs.map((x) => `${x.rows.join("+")} by ${x.columns.join("+")}`).join("; ")}` : ""}`,
  }));
  const testable = cov.filter((h) => h.status === "testable").length;
  return { kind: "answer", category: "research_design", understood, answer: `${plural(cov.length, "hypothesis", "hypotheses")} recorded; ${testable} ${testable === 1 ? "is" : "are"} testable as the survey and the plan stand${cov.length - testable ? `, ${cov.length - testable} need${cov.length - testable === 1 ? "s" : ""} work (see each)` : ""}.`, sections: [{ title: "Hypotheses", items }], detected: cov.map((h) => det("hypothesis", h.label)) };
};

/* ---------------------------------------------------------- the long brief → the model */

const RESEARCH_WORDS = /\b(?:study|research|survey|questionnaire|objectives?|brief|hypothes[ie]s|audience|respondents|awareness|segment|target\s+group|we\s+want|our\s+client|the\s+client|understand|explore|measure)\b/i;
const EDIT_VERB = /^(?:show|hide|skip|if|when|make|set|mask|randomi[sz]e|move|delete|remove|rename|change|add|terminate|screen|limit|sort|reorder|duplicate|copy|convert|translate)\b/i;

const longBrief: Recogniser = (r) => {
  const n = r.text.split(/\s+/).length;
  if (n <= 25 || !RESEARCH_WORDS.test(r.text) || EDIT_VERB.test(r.text)) return null;
  return { kind: "model", category: /\bcreate\s+(?:an?\s+)?(?:survey|questionnaire)\b/i.test(r.text) ? "survey_creation" : "research_design", reason: "a research brief: the design, the questions or the framework it asks for are written by the language model, then applied as actions through the same gate", detected: namedObjects(r) };
};

/* ---------------------------------------------------------- survey settings */

const surveySettings: Recogniser = (r) => {
  const t = r.text;
  const m = /^(?:rename|retitle)\s+(?:the\s+|this\s+)?(?:survey|study|questionnaire|project)\s+(?:to|as)\s+(.+)$/i.exec(t)
    ?? /^(?:set|change|update|make)\s+(?:the\s+|this\s+)?(?:survey|study|questionnaire)(?:['’]s)?\s+(?:title|name)\s+(?:to|as)\s+(.+)$/i.exec(t)
    ?? /^(?:set|change|update)\s+the\s+title\s+(?:of\s+the\s+(?:survey|study|questionnaire)\s+)?to\s+(.+)$/i.exec(t)
    ?? /^(?:call|name|title)\s+(?:the\s+|this\s+)?(?:survey|study|questionnaire)\s+(.+)$/i.exec(t);
  if (m) {
    const title = unquote(m[1]);
    return act(r, "survey_editing", `Rename the survey to “${title}” (it was “${r.def.meta.title}”).`, [{ op: "set_survey_settings", title }], [det("survey title", title)]);
  }
  const d = /^(?:set|change|update)\s+(?:the\s+)?(?:survey(?:['’]s)?\s+|study(?:['’]s)?\s+)?description\s+(?:to|as)\s+(.+)$/i.exec(t);
  if (d) { const description = unquote(d[1]); return act(r, "survey_editing", `Set the survey description to “${plain(description, 60)}”.`, [{ op: "set_survey_settings", description }], [det("survey description", plain(description, 60))]); }
  if (/^(?:remove|clear|delete)\s+(?:the\s+)?(?:survey(?:['’]s)?\s+)?description$/i.test(t)) return act(r, "survey_editing", "Remove the survey description.", [{ op: "set_survey_settings", description: null }], []);
  const c = /^(?:set|change)\s+(?:the\s+)?survey(?:['’]s)?\s+code\s+to\s+(\S+)$/i.exec(t);
  if (c) return act(r, "survey_editing", `Set the survey code to ${c[1]}.`, [{ op: "set_survey_settings", code: c[1] }], [det("survey code", c[1])]);
  return null;
};

/* ---------------------------------------------------------- languages */

const languages: Recogniser = (r) => {
  const t = r.text;
  const tr = /^(?:please\s+)?(?:translate|localise|localize)\s+(?:(?:this|the|my|our)\s+)?(.*?)\s*(?:into|to|in)\s+(.+)$/i.exec(t);
  if (tr) {
    const lang = languageFrom(tr[2]);
    const detected: Detected[] = [...namedObjects({ ...r, text: tr[1] }).filter((x) => x.what !== "language")];
    if (lang) {
      detected.push(det("language", `${lang.name} (${lang.code})`));
      if (!surveyHasLanguage(r.def, lang.code)) detected.push(det("prerequisite", `add_language ${lang.code} — ${lang.name} is not a language of this survey yet, so it is added first`));
    }
    return { kind: "model", category: "translation", reason: `the ${lang?.name ?? "translated"} text is written by the language model or a translation provider; the engine checks it (placeholders, glossary, HTML) and stores it with set_translations`, detected };
  }
  const add = /^(?:add|enable|include|support|create)\s+(?:an?\s+|the\s+)?(.+?)\s+(?:as\s+(?:a\s+|an\s+)?(?:new\s+)?language|language|version|translation)$/i.exec(t)
    ?? /^(?:add|enable)\s+(?:the\s+)?(?:language|locale)\s+(.+)$/i.exec(t)
    ?? /^(?:make|offer)\s+(?:the\s+|this\s+)?(?:survey|questionnaire|study)\s+(?:available\s+)?in\s+(.+)$/i.exec(t)
    ?? /^add\s+(\S+(?:\s+\S+)?)$/i.exec(t);
  if (add) {
    const lang = languageFrom(add[1]);
    if (!lang) return null;
    if (surveyHasLanguage(r.def, lang.code)) return alreadySo("translation", `Add ${lang.name} as a language.`, `${lang.name} is already a language of this survey — say “translate this survey into ${lang.name}” to fill in its text, or “what is missing in ${lang.name}” to see what is left.`, [det("language", `${lang.name} (${lang.code})`)]);
    return act(r, "translation", `Add ${lang.name} (${lang.locale ?? lang.code}) as a language of this survey — its text starts untranslated.`, [{ op: "add_language", code: lang.code, ...(lang.locale ? { locale: lang.locale } : {}), name: lang.name }], [det("language", `${lang.name} (${lang.code})`)]);
  }
  const rm = /^(?:remove|delete|drop)\s+(?:the\s+)?(.+?)\s+(?:language|version|translations?)$/i.exec(t) ?? /^(?:remove|delete|drop)\s+(?:the\s+)?language\s+(.+)$/i.exec(t) ?? /^(?:remove|delete|drop)\s+(\S+)$/i.exec(t);
  if (rm) {
    const lang = languageFrom(rm[1]);
    if (!lang) return null;
    if (!surveyHasLanguage(r.def, lang.code)) return refused("translation", `Remove the ${lang.name} version.`, `${lang.name} is not a language of this survey, so there is nothing to remove.`, [det("language", `${lang.name} (${lang.code})`)]);
    return act(r, "translation", `Remove the ${lang.name} version and its translations.`, [{ op: "remove_language", code: lang.code }], [det("language", `${lang.name} (${lang.code})`)]);
  }
  return null;
};

/* ---------------------------------------------------------- research design */

const ORDINAL_WORDS: Record<string, number> = { first: 1, second: 2, third: 3, fourth: 4, fifth: 5, sixth: 6, seventh: 7, eighth: 8, ninth: 9, tenth: 10 };

const research: Recogniser = (r) => {
  const t = r.text;
  const h = /^(?:add|record|new|log|note)\s+(?:a\s+|another\s+|the\s+|this\s+)?(?:new\s+)?hypothes[ie]s\s*(?::|-|—|–|that|saying)?\s*(.+)$/i.exec(t) ?? /^hypothesis\s*:\s*(.+)$/i.exec(t);
  if (h) {
    const text = cap(unquote(h[1]));
    const n = (r.def.research?.hypotheses.length ?? 0);
    return act(r, "research_design", `Record hypothesis ${hypothesisLabel(n)}: “${text}”.`, [{ op: "add_hypothesis", text }], [det("hypothesis", `${hypothesisLabel(n)}: ${plain(text, 60)}`)]);
  }
  const rm = /^(?:remove|delete|drop)\s+(?:the\s+)?(?:hypothesis\s+)?(h\d+)$/i.exec(t) ?? /^(?:remove|delete|drop)\s+(?:the\s+)?hypothesis\s+(\d+|.+)$/i.exec(t) ?? /^(?:remove|delete|drop)\s+the\s+(first|second|third|fourth|fifth|sixth|seventh|eighth|ninth|tenth|last)\s+hypothesis$/i.exec(t);
  if (rm) {
    const hyps = r.def.research?.hypotheses ?? [];
    const w = rm[1].toLowerCase();
    const ref: string | number = w === "last" ? hyps.length : ORDINAL_WORDS[w] ?? (/^h?\d+$/i.test(w) ? Number(w.replace(/^h/i, "")) : unquote(rm[1]));
    const i = typeof ref === "number" ? ref - 1 : -1;
    return act(r, "research_design", `Remove hypothesis ${typeof ref === "number" ? hypothesisLabel(ref - 1) : `“${ref}”`}${hyps[i] ? ` (“${plain(hyps[i], 60)}”)` : ""}; later hypotheses move up one label.`, [{ op: "remove_hypothesis", hypothesis: ref }], [det("hypothesis", typeof ref === "number" ? hypothesisLabel(ref - 1) : String(ref))]);
  }
  if (/^(?:create|build|make|generate|propose|draft|set\s+up|write|design|suggest|give\s+me|prepare)\s+(?:me\s+)?(?:an?\s+|the\s+)?(?:analysis\s+(?:framework|plan)|analytic(?:al)?\s+(?:framework|plan)|tab(?:ulation)?\s+plan|data\s+analysis\s+plan|framework\s+for\s+(?:the\s+)?analysis)(?:\s+for\s+(?:this|the|my|our)\s+(?:research|study|survey|project|questionnaire|data))?$/i.test(t)
    || /^plan\s+the\s+analysis(?:\s+for\s+(?:this|the)\s+\w+)?$/i.test(t)) {
    const plan = buildAnalysisFramework(r.def, { now: "" });
    const merge = !!r.def.research?.analysisPlan;
    return act(r, "analysis", `Propose the analysis framework the design implies${merge ? ", merged into the saved plan" : ""}: ${plural(plan.crosstabs.length, "crosstab")}, ${plural(plan.tests.length, "test")}, ${plural(plan.derived.length, "derived variable")}, ${plural(plan.segments.length, "segment")}.`, [{ op: "propose_analysis_plan", ...(merge ? { merge: true } : {}) }], [det("crosstabs", String(plan.crosstabs.length)), det("tests", String(plan.tests.length))]);
  }
  return null;
};

/* ---------------------------------------------------------- embedded data and calculations */

const variables: Recogniser = (r) => {
  const t = r.text;
  const calc = /^(?:add|create|make|define|new)\s+(?:an?\s+|the\s+)?(?:new\s+)?(?:calculated|computed|derived)\s+(?:variable|value|field)\s+(?:called\s+|named\s+)?([A-Za-z_]\w*)\s*(?:=|:|\s+as\s+|\s+equal\s+to\s+|\s+equals\s+|\s+that\s+is\s+|\s+which\s+is\s+)\s*(.+)$/i.exec(t)
    ?? /^(?:add|create|define)\s+(?:an?\s+|the\s+)?calculation\s+(?:called\s+|named\s+)?([A-Za-z_]\w*)\s*(?:=|:|\s+as\s+)\s*(.+)$/i.exec(t)
    ?? /^(?:compute|calculate)\s+([A-Za-z_]\w*)\s*(?:=|\s+as\s+)\s*(.+)$/i.exec(t);
  if (calc) {
    const name = calc[1], expression = calc[2].trim();
    return act(r, "calculations", `Create the calculated variable ${name} = ${expression}, computed when its page is submitted.`, [{ op: "create_calculation", name, expression }], [det("variable", name), det("expression", expression)]);
  }
  const m = /^(?:add|create|make|define|insert|new)\s+(?:an?\s+|the\s+)?(?:new\s+)?embedded\s+(?:data\s+)?(?:variable|field|value|data)?\s*(?:called|named|for)?\s*[:]?\s*["“]?([A-Za-z_][\w ]*?)["”]?(?:\s*(?:,|and|which is|that is|with(?:\s+(?:the\s+)?value)?|=|:)\s*(?:set\s+(?:it\s+)?to|equal\s+to|value|to)?\s*["“]?([^"”]+?)["”]?)?(?:\s+(?:from|read\s+from|taken\s+from|captured\s+from)\s+(?:the\s+)?(url|link|panel|query\s*string))?$/i.exec(t);
  if (!m) return null;
  const name = m[1].trim().replace(/\s+/g, "_");
  let value: string | undefined = m[2]?.trim();
  let source: "url" | "panel" | "static" = m[3] ? (/panel/i.test(m[3]) ? "panel" : "url") : value !== undefined ? "static" : "url";
  const from = value && /^(?:from|read from)\s+(?:the\s+)?(url|link|panel|query\s*string)$/i.exec(value);
  if (from) { source = /panel/i.test(from[1]) ? "panel" : "url"; value = undefined; }
  const words = source === "url" ? `read from the survey link (?${name}=…)` : source === "panel" ? "passed by the panel" : `set to “${value}”`;
  return act(r, "variables", `Create the embedded variable ${name}, ${words}.`, [{ op: "create_embedded", name, source, ...(value !== undefined ? { value } : {}) }], [det("variable", name), det("source", source)]);
};

/* ---------------------------------------------------------- page breaks */

const pageBreaks: Recogniser = (r) => {
  const t = r.text;
  let m: RegExpExecArray | null;
  if ((m = /^(?:(?:add|insert|put|create|place|start)\s+)?(?:a\s+|another\s+)?(?:new\s+)?(?:page\s*break|page)\s+(?:after|below|following|under)\s+(.+)$/i.exec(t))
    || (m = /^(?:break|split)\s+(?:the\s+)?page\s+(?:after|below)\s+(.+)$/i.exec(t))) {
    const q = questionOf(r, m[1], "survey_editing", `Add a page break after ${m[1]}.`);
    if (!q.ok) return q.out;
    return act(r, "survey_editing", `Add a page break after ${code(q.v)}, so what follows it starts a new page.`, [{ op: "page_break", after: code(q.v) }], qDetected([q.v]));
  }
  if ((m = /^(?:remove|delete|drop|take\s+out|clear)\s+(?:the\s+)?(?:page\s*break|break)\s+(?:after|below|following|under)\s+(.+)$/i.exec(t))) {
    const q = questionOf(r, m[1], "survey_editing", `Remove the page break after ${m[1]}.`);
    if (!q.ok) return q.out;
    return act(r, "survey_editing", `Remove the page break after ${code(q.v)}, joining its page with the next one.`, [{ op: "page_break", after: code(q.v), remove: true }], qDetected([q.v]));
  }
  if ((m = /^(?:put|move|show|place|start)\s+(.+?)\s+on\s+(?:a\s+)?(?:new|separate|its\s+own|fresh|a\s+separate)\s+page$/i.exec(t))
    || (m = /^(?:add|insert|put|create|place)\s+(?:a\s+)?(?:new\s+)?(?:page\s*break|page)\s+(?:before|above|in\s+front\s+of)\s+(.+)$/i.exec(t))) {
    const q = questionOf(r, m[1], "survey_editing", `Put ${m[1]} on a new page.`);
    if (!q.ok) return q.out;
    // the break before Q is the break after the question before Q on the same page
    const page = listPages(r.def.flow as unknown[]).find((p) => p.node.questionIds.includes(q.v.id));
    if (!page) return refused("survey_editing", `Put ${code(q.v)} on a new page.`, `${code(q.v)} is not on any page.`, qDetected([q.v]));
    const i = page.node.questionIds.indexOf(q.v.id);
    if (i === 0) return alreadySo("survey_editing", `Put ${code(q.v)} on a new page.`, `${code(q.v)} already starts its page — there is no break to add before it.`, qDetected([q.v]));
    const prev = r.def.questions.find((x) => x.id === page.node.questionIds[i - 1])!;
    return act(r, "survey_editing", `Put ${code(q.v)} on a new page: a page break after ${code(prev)}.`, [{ op: "page_break", after: code(prev) }], qDetected([prev, q.v]));
  }
  return null;
};

/* ---------------------------------------------------------- masking */

const SRC_WORDS = String.raw`(not\s+selected|unselected|not\s+chosen|selected|chosen|picked|ticked|bought|used|shown|displayed|seen)`;
const maskWord = (w: string) => (/not|un/i.test(w) ? "Unselected" : /shown|displayed|seen/i.test(w) ? "Displayed" : "Selected");

const masking: Recogniser = (r) => {
  const t = r.text;
  const clear = /^(?:remove|clear|drop|delete)\s+(?:the\s+)?(?:option\s+|row\s+)?mask(?:ing)?\s+(?:from|on|of|at)\s+(.+)$/i.exec(t) ?? /^(?:unmask|stop\s+masking)\s+(.+)$/i.exec(t) ?? /^(?:remove|clear|drop)\s+(.+?)['’]s\s+mask$/i.exec(t);
  if (clear) {
    const q = questionOf(r, clear[1], "masking", `Remove the mask from ${clear[1]}.`);
    if (!q.ok) return q.out;
    return act(r, "masking", `Remove the mask from ${code(q.v)}, so it shows all its options again.`, [{ op: "clear_mask", target: code(q.v) }], qDetected([q.v]));
  }
  if (!/\b(?:mask(?:ing)?|carry\s+(?:forward|over)|pipe|only|just|hide|remove|exclude|drop|filter|restrict|limit|show|display|offer)\b/i.test(t)) return null;
  // where the options come from: "selected in Q5", "Q5's selected brands", "carry forward Q5 …"
  let src: { ref: string; word: string; phrase: string } | null = null;
  const a = new RegExp(String.raw`${SRC_WORDS}\s+(?:in|at|for|on)\s+([A-Za-z_][\w]*)`, "i").exec(t);
  const b = new RegExp(String.raw`\b([A-Za-z_][\w]*)['’]s\s+(?:${SRC_WORDS}\s+)?(?:\w+\s+)?(?:options|answers|brands|items|choices|selections|picks|responses)\b`, "i").exec(t);
  const cf = /^carry\s+(?:forward|over)\s+(?:the\s+)?(?:(selected|unselected|not\s+selected|displayed|shown)\s+)?(?:\w+\s+)?(?:(?:from|of)\s+)?([A-Za-z_]\w*)(?:['’]s)?(?:\s+(?:(selected|unselected|not\s+selected|displayed|shown)\s+)?(?:options|answers|brands|items|choices|selections))?\s+(?:to|into|forward\s+to|at|onto)\s+(.+)$/i.exec(t);
  // "mask Q10 by Q5": the masked question first, its source after
  const by = /^(?:mask|filter)\s+(?:the\s+)?(?:options\s+(?:of|in|at)\s+)?([A-Za-z_]\w*)(?:['’]s)?(?:\s+options)?\s+(?:by|with|using|on)\s+(?:the\s+)?(?:(?:answers?|selections?)\s+(?:to|of|from|in|at)\s+)?([A-Za-z_]\w*)$/i.exec(t);
  if (by && resolveQuestionRef(r.def, by[1], r.ctx).ok && resolveQuestionRef(r.def, by[2], r.ctx).ok) src = { ref: by[2], word: "selected", phrase: "" };
  else if (a && resolveQuestionRef(r.def, a[2], r.ctx).ok) src = { ref: a[2], word: a[1], phrase: a[0] };
  else if (b && resolveQuestionRef(r.def, b[1], r.ctx).ok) src = { ref: b[1], word: b[2] ?? "selected", phrase: b[0] };
  else if (cf && resolveQuestionRef(r.def, cf[2], r.ctx).ok) src = { ref: cf[2], word: cf[1] ?? cf[3] ?? "selected", phrase: "" };
  if (!src) return null;
  if (!/\b(?:mask(?:ing)?|carry\s+(?:forward|over)|only|just|hide|remove|exclude|drop|filter|restrict|limit|pipe)\b/i.test(t)) return null;
  const source = resolveQuestionRef(r.def, src.ref, r.ctx) as Extract<ReturnType<typeof resolveQuestionRef>, { ok: true }>;
  // the target: "mask Q10 by …", "at Q10 …", "… from Q10", "… to Q10"
  const rest = src.phrase ? t.replace(src.phrase, " ") : t;
  let targetRef: string | null = by && src.ref === by[2] ? by[1] : cf ? cf[4] : null;
  if (!targetRef) {
    const lead = /^(?:mask|filter|restrict|limit)\s+(?:the\s+)?(?:options?\s+(?:of|in|at)\s+)?([A-Za-z_]\w*)(?:['’]s)?(?:\s+options)?\s+(?:by|to|with|using|on)\b/i.exec(rest);
    if (lead && resolveQuestionRef(r.def, lead[1], r.ctx).ok) targetRef = lead[1];
  }
  if (!targetRef) {
    for (const p of rest.matchAll(/\b(?:at|in|on|from|to|into|for)\s+([A-Za-z_]\w*)/gi)) {
      const q = resolveQuestionRef(r.def, p[1], r.ctx);
      if (q.ok && q.question.id !== source.question.id) { targetRef = p[1]; break; }
    }
  }
  if (!targetRef) {
    if (r.ctx.selectedId && r.ctx.selectedId !== source.question.id && /\b(?:this|here|these)\b/i.test(rest)) targetRef = "this question";
    else return refused("masking", `Mask a question by what was ${src.word} at ${code(source.question)}.`, `I can see the options come from ${code(source.question)}, but not which question they are for — say “at Q10, show only the options selected in ${code(source.question)}”.`, qDetected([source.question]));
  }
  const target = questionOf(r, targetRef, "masking", `Mask ${targetRef} by ${code(source.question)}.`);
  if (!target.ok) return target.out;
  const word = maskWord(src.word);
  const remove = /^(?:hide|remove|exclude|drop|don['’]?t\s+show|do\s+not\s+show)\b|,?\s+(?:hide|remove|exclude|drop)\b|\bnot\s+(?:show|display|offer)\b/i.test(t) && !/^(?:mask|carry)\b/i.test(t);
  const expression = `${code(source.question)}.${word}`;
  const what = word === "Unselected" ? "not selected" : word === "Displayed" ? "shown" : "selected";
  const understood = remove ? `At ${code(target.v)}, hide the options ${what} at ${code(source.question)} (mask ${expression}, remove).` : `At ${code(target.v)}, show only the options ${what} at ${code(source.question)} (mask ${expression}).`;
  return act(r, "masking", understood, [{ op: "set_mask", target: code(target.v), expression, ...(remove ? { action: "remove" as const } : {}) }], [det("mask source", expression), det("masked question", code(target.v)), det("action", remove ? "remove" : "display")]);
};

/* ---------------------------------------------------------- option visibility */

const optionVisibility: Recogniser = (r) => {
  const t = r.text;
  const m = /^(?:only\s+)?(show|display|offer|hide)\s+(?:the\s+)?(?:option|answer|choice)\s+(.+?)\s+(?:in|at|of|on|for)\s+(.+?)\s+(?:only\s+)?(when|if|unless)\s+(.+)$/i.exec(t)
    ?? /^(?:only\s+)?(show|display|offer|hide)\s+(.+?)\s+(?:in|at)\s+(.+?)\s+only\s+(when|if)\s+(.+)$/i.exec(t);
  const clear = /^(?:remove|clear|delete)\s+the\s+(?:display\s+)?(?:condition|logic)\s+(?:from|of|on)\s+(?:the\s+)?(?:option|answer|choice)\s+(.+?)\s+(?:in|at|of|on)\s+(.+)$/i.exec(t);
  if (clear) {
    const q = questionOf(r, clear[2], "option_modification", `Always show option ${clear[1]} of ${clear[2]}.`);
    if (!q.ok) return q.out;
    const o = optionOf(r, q.v, clear[1], "option_modification", `Always show option ${clear[1]} of ${code(q.v)}.`);
    if (!o.ok) return o.out;
    return act(r, "option_modification", `Always show option ${o.v.code} “${plain(o.v.label, 40)}” of ${code(q.v)} (remove its condition).`, [{ op: "update_option", target: code(q.v), option: o.v.code, visibleIf: null }], qDetected([q.v]));
  }
  if (!m) return null;
  const withWord = /^(?:only\s+)?(?:show|display|offer|hide)\s+(?:the\s+)?(?:option|answer|choice)\s/i.test(t);
  const q = resolveQuestionRef(r.def, m[3], r.ctx);
  if (!q.ok) return withWord ? unresolved(r, "option_modification", `Show an option of ${m[3]} conditionally.`, m[3], q) : null;
  const o = resolveOptionRef(q.question, m[2], { selected: r.ctx.selectedOption });
  if (!o.ok) { if (!withWord) return null; const got = optionOf(r, q.question, m[2], "option_modification", `Show option ${m[2]} of ${code(q.question)} conditionally.`); return got.ok ? null : got.out; }
  const hide = /^hide$/i.test(m[1]) !== /^unless$/i.test(m[4]);
  const c = readCondition(r, m[5]);
  const understood0 = `${hide ? "Hide" : "Show"} option “${plain(o.option.label, 40)}” of ${code(q.question)} ${hide ? "" : "only "}when ${m[5]}.`;
  if (!c.ok) return badCondition(r, "option_modification", understood0, m[5], c);
  const expression = hide ? `NOT (${c.expression})` : c.expression;
  return act(r, "option_modification", `Show option ${o.option.code} “${plain(o.option.label, 40)}” of ${code(q.question)} only when ${hide ? `NOT (${conditionWords(r.def, c.condition)})` : conditionWords(r.def, c.condition)}.`, [{ op: "update_option", target: code(q.question), option: o.option.code, visibleIf: expression }], [det("question", code(q.question)), det("option", `${o.option.code} (${plain(o.option.label, 40)})`), det("condition", conditionWords(r.def, c.condition))]);
};

/* ---------------------------------------------------------- randomization */

/** "None of these and Other last", "Brand A first", "None anchored" → which options stay where */
function keepClause(r: Run, q: Question, text: string): { first: Option[]; last: Option[]; anchors: Option[] } | Interpretation {
  let t = text.trim().replace(/^(?:the\s+)?/i, "");
  let where: "first" | "last" | "anchors" = "anchors";
  const w = /\s+(?:(?:at|in)\s+the\s+)?(last|bottom|end|first|top|start|anchored|in\s+place|fixed|pinned|where\s+(?:it\s+is|they\s+are))(?:\s+(?:position|place|of\s+the\s+list))?$/i.exec(t);
  if (w) { where = /last|bottom|end/i.test(w[1]) ? "last" : /first|top|start/i.test(w[1]) ? "first" : "anchors"; t = t.slice(0, w.index).trim(); }
  t = t.replace(/^(?:the\s+)?(?:options?\s+)?/i, "");
  const whole = resolveOptionRef(q, t, { selected: r.ctx.selectedOption });
  const items = whole.ok ? [t] : t.split(/\s*(?:,|&|\band\b)\s*/i).filter(Boolean);
  const got: Option[] = [];
  for (const it of items) {
    const o = optionOf(r, q, it, "randomization", `Randomize ${code(q)}'s options, keeping ${t} ${where === "anchors" ? "in place" : where}.`);
    if (!o.ok) return o.out!;
    got.push(o.v);
  }
  return { first: where === "first" ? got : [], last: where === "last" ? got : [], anchors: where === "anchors" ? got : [] };
}

const randomization: Recogniser = (r) => {
  const t = r.text;
  const stop = /^(?:stop|don['’]?t|do\s+not|no\s+longer|never)\s+(?:randomi[sz](?:e|ing)|shuffl(?:e|ing)|rotat(?:e|ing))\s+(.+)$/i.exec(t)
    ?? /^(?:turn\s+off|disable|remove|switch\s+off)\s+(?:the\s+)?(?:option\s+)?randomi[sz]ation\s+(?:on|of|for|from|in)\s+(.+)$/i.exec(t)
    ?? /^un-?randomi[sz]e\s+(.+)$/i.exec(t);
  const blocks = /^(?:randomi[sz]e|shuffle|rotate)\s+(?:the\s+)?(?:order\s+of\s+(?:the\s+)?)?blocks?\s+(.+)$/i.exec(t);
  if (blocks) {
    const names = blocks[1].split(/\s*(?:,|\band\b|&)\s*/i).map(unquote).filter(Boolean);
    const found = names.map((n) => ({ n, b: blockOf(r.def, n) }));
    const missing = found.filter((x) => !x.b);
    if (missing.length) return refused("randomization", `Randomize the order of blocks ${names.join(", ")}.`, `There is no block ${missing.map((x) => `“${x.n}”`).join(", ")} — the blocks are ${listBlocks(r.def.flow as unknown[]).filter((b) => b.title).map((b) => `“${b.title}”`).join(", ")}.`);
    return act(r, "randomization", `Randomize the order of blocks ${found.map((x) => `“${x.b!.title}”`).join(", ")} (each respondent sees them in a random order).`, [{ op: "create_randomizer", blocks: found.map((x) => blockRef(r.def, x.b!)) }], found.map((x) => det("block", x.b!.title)));
  }
  const pick = /^(?:randomly\s+)?(?:show|display|pick|offer|select)\s+(?:only\s+)?(\w+)\s+(?:random(?:ly\s+(?:chosen|selected|picked))?\s+)?(?:of\s+(?:the\s+)?)?(?:options?|answers?|items?|brands?|rows?|statements?|choices?)\s+(?:of|from|in|at|for)\s+(.+?)(?:\s+at\s+random|\s+randomly)?$/i.exec(t)
    ?? /^(?:randomly\s+)?(?:show|display|pick|offer)\s+(?:only\s+)?(\w+)\s+of\s+(.+?)['’]s\s+(?:options|answers|rows|items|brands|statements)(?:\s+at\s+random|\s+randomly)?$/i.exec(t);
  const main = /^(?:randomi[sz]e|shuffle|rotate)\s+(.+)$/i.exec(t);
  if (!stop && !(pick && /random/i.test(t) && countWord(pick[1]) !== null) && !main) return null;
  let rest = stop ? stop[1] : pick && /random/i.test(t) && countWord(pick[1]) !== null ? pick[2] : main![1];
  let keep: string | null = null;
  const k = /\s*,?\s*(?:but\s+|and\s+|while\s+|then\s+)?(?:keep(?:ing)?|leav(?:e|ing)|with|anchor(?:ing)?|pin(?:ning)?|hold(?:ing)?|lock(?:ing)?)\s+(.+)$/i.exec(rest);
  if (k && !stop) { keep = k[1]; rest = rest.slice(0, k.index); }
  const scope = /\b(?:rows|statements)\b/i.test(rest) ? "rows" as const : /\bcolumns\b/i.test(rest) ? "columns" as const : undefined;
  let ref = rest.replace(/^(?:the\s+)?(?:order\s+of\s+(?:the\s+)?)?/i, "").replace(/\b(?:options?|answers?|choices?|answer\s+list|list|rows?|statements?|columns?|items?|brands?|order)\b/gi, " ").replace(/\b(?:of|in|for|on|at|the)\b/gi, " ").replace(/['’]s\b/g, " ").replace(/\s+/g, " ").trim();
  if (!ref || /^(?:these|those|this|it|them)$/i.test(ref)) ref = "this question";
  const understood0 = stop ? `Stop randomizing ${ref}.` : `Randomize the options of ${ref}.`;
  const q = questionOf(r, ref, "randomization", understood0);
  if (!q.ok) return q.out;
  if (stop) return act(r, "randomization", `Stop randomizing the ${scope ?? "options"} of ${code(q.v)} — they show in their listed order.`, [{ op: "set_option_randomization", target: code(q.v), enabled: false, ...(scope ? { scope } : {}) }], qDetected([q.v]));
  const n = pick && /random/i.test(t) ? countWord(pick[1]) : null;
  let kept: { first: Option[]; last: Option[]; anchors: Option[] } = { first: [], last: [], anchors: [] };
  if (keep) { const kc = keepClause(r, q.v, keep); if ("kind" in kc) return kc; kept = kc; }
  const words = [...kept.first.map((o) => `“${plain(o.label, 30)}” first`), ...kept.last.map((o) => `“${plain(o.label, 30)}” last`), ...kept.anchors.map((o) => `“${plain(o.label, 30)}” in place`)];
  const what = scope ?? "options";
  return act(r, "randomization", `Randomize the ${what} of ${code(q.v)}${n ? `, showing ${n} at random to each respondent` : ""}${words.length ? `; keep ${words.join(", ")}` : ""}.`, [{
    op: "set_option_randomization", target: code(q.v), enabled: true,
    ...(kept.first.length ? { keepFirst: kept.first.map((o) => o.code) } : {}), ...(kept.last.length ? { keepLast: kept.last.map((o) => o.code) } : {}), ...(kept.anchors.length ? { anchors: kept.anchors.map((o) => o.code) } : {}),
    ...(n ? { pick: n } : {}), ...(scope ? { scope } : {}),
  }], [...qDetected([q.v]), ...[...kept.first, ...kept.last, ...kept.anchors].map((o) => det("option", `${o.code} (${plain(o.label, 40)})`))]);
};

/* ---------------------------------------------------------- options */

const EXCLUSIVE_LABEL = String.raw`none(?:\s+of\s+(?:these|the\s+above|them))?|don['’]?t\s+know|not\s+sure|prefer\s+not\s+to\s+(?:say|answer)|not\s+applicable|n\/a|nothing`;
const isExclusiveLabel = (l: string) => new RegExp(`^(?:${EXCLUSIVE_LABEL})$`, "i").test(l.trim());
const isOtherLabel = (l: string) => /^other\b/i.test(l.trim());
/** "Red, Green and Blue", "\"Red\", \"Green\"" → labels */
function splitLabels(s: string): string[] {
  const quoted = [...s.matchAll(/["“]([^"”]+)["”]/g)].map((m) => m[1].trim());
  if (quoted.length) return quoted;
  return s.split(/\s*(?:,|;|\/)\s*(?:and\s+|or\s+)?|\s+(?:and|or)\s+/i).map((x) => x.trim()).filter(Boolean);
}
const specFor = (label: string): OptionSpec => (isExclusiveLabel(label) ? { label, exclusive: true } : isOtherLabel(label) && /specify/i.test(label) ? { label, other: true } : label);

const SORTS: [RegExp, "alphabetical" | "alphabetical_desc" | "numeric" | "reverse"][] = [
  [/^(?:in\s+)?(?:reverse\s+alphabetical(?:ly)?(?:\s+order)?|z\s*(?:-|to|→)\s*a|descending)$/i, "alphabetical_desc"],
  [/^(?:in\s+)?(?:alphabetical(?:ly)?(?:\s+order)?|a\s*(?:-|to|→)\s*z|ascending|by\s+(?:name|label))$/i, "alphabetical"],
  [/^(?:in\s+)?(?:code\s+order|by\s+code|numerical(?:ly)?(?:\s+order)?|by\s+number)$/i, "numeric"],
  [/^(?:in\s+)?reverse(?:d)?(?:\s+order)?$/i, "reverse"],
];
const SORT_WORDS = { alphabetical: "A→Z", alphabetical_desc: "Z→A", numeric: "by code", reverse: "reversed" } as const;

/**
 * Quoted names are atoms: "mark “None of these” as exclusive" must not read
 * "of these" as "of question these". The quotes are masked while the
 * patterns run and restored in what they captured.
 */
function maskQuotes(text: string): { masked: string; unmask: (s: string) => string } {
  const held: string[] = [];
  const masked = text.replace(/"[^"]*"|“[^”]*”/g, (q) => { held.push(q); return `\u0001${held.length - 1}\u0001`; });
  return { masked, unmask: (s: string) => s.replace(/\u0001(\d+)\u0001/g, (_, i: string) => held[Number(i)]) };
}

const options: Recogniser = (r) => {
  const { masked: t, unmask } = maskQuotes(r.text);
  let m: RegExpExecArray | null;
  const exec = (re: RegExp): RegExpExecArray | null => { const x = re.exec(t); if (x) for (let i = 1; i < x.length; i++) if (x[i] !== undefined) x[i] = unmask(x[i]); return x; };

  /* ---- add */
  if ((m = exec(/^add\s+(?:an?\s+|the\s+)?["“]?(other(?:\s*\(\s*please\s+specify\s*\)|,?\s+please\s+specify|\s+specify)?)["”]?(?:\s+(?:option|answer|choice))?(?:\s+with\s+a\s+(?:text|specify)\s+box)?\s+(?:to|in|for|on|at)\s+(.+)$/i))) {
    const q = questionOf(r, m[2], "option_modification", `Add an Other option to ${m[2]}.`);
    if (!q.ok) return q.out;
    const label = /specify/i.test(m[1]) ? cap(m[1].trim()) : "Other (please specify)";
    return act(r, "option_modification", `Add “${label}” to ${code(q.v)}, with a text box to specify, kept at the bottom.`, [{ op: "update_question", target: code(q.v), addOptions: [{ label, other: true }] }], [...qDetected([q.v]), det("new option", label)]);
  }
  if ((m = new RegExp(String.raw`^add\s+(?:an?\s+|the\s+)?["“]?(${EXCLUSIVE_LABEL})["”]?(?:\s+(?:option|answer|choice))?\s+(?:to|in|for|on|at)\s+(.+)$`, "i").exec(t))) {
    const q = questionOf(r, m[2], "option_modification", `Add a ${m[1]} option to ${m[2]}.`);
    if (!q.ok) return q.out;
    const label = cap(m[1].trim());
    return act(r, "option_modification", `Add “${label}” to ${code(q.v)} as an exclusive option (selecting it clears the others), kept at the bottom.`, [{ op: "update_question", target: code(q.v), addOptions: [{ label, exclusive: true }] }], [...qDetected([q.v]), det("new option", label)]);
  }
  if ((m = exec(/^add\s+(?:the\s+)?(?:new\s+)?(?:options?|answers?|choices?|codes?)\s*:?\s+(.+?)\s+(?:to|in|for|on|at)\s+(.+?)(?:['’]s\s+(?:options|answers|list|choices))?$/i))
    || (m = exec(/^add\s+(.+?)\s+(?:to|in)\s+(.+?)['’]s\s+(?:options|answers|list|choices)$/i))
    || (m = exec(/^add\s+(.+?)\s+as\s+(?:an?\s+)?(?:new\s+)?(?:options?|answers?|choices?)\s+(?:to|of|in|for|on)\s+(.+)$/i))) {
    const q = questionOf(r, m[2], "option_modification", `Add options to ${m[2]}.`);
    if (!q.ok) return q.out;
    const labels = splitLabels(m[1]);
    if (!labels.length) return null;
    const dup = labels.filter((l) => (q.v.options ?? []).some((o) => plain(o.label, 200).toLowerCase() === l.toLowerCase()));
    if (dup.length) return (dup.length === labels.length ? alreadySo : refused)("option_modification", `Add ${labels.map((l) => `“${l}”`).join(", ")} to ${code(q.v)}.`, `${code(q.v)} already has ${dup.map((l) => `“${l}”`).join(", ")} — nothing to add${dup.length < labels.length ? " for those; ask for the others on their own" : ""}.`, qDetected([q.v]));
    return act(r, "option_modification", `Add ${labels.map((l) => `“${l}”`).join(", ")} to the options of ${code(q.v)}.`, [{ op: "update_question", target: code(q.v), addOptions: labels.map(specFor) }], [...qDetected([q.v]), ...labels.map((l) => det("new option", l))]);
  }

  /* ---- remove */
  {
    const withWord = exec(/^(?:remove|delete|drop)\s+(?:the\s+)?(?:options?|answers?|choices?|codes?)\s+(.+?)\s+(?:from|of|in|on|at)\s+(.+)$/i)
      ?? exec(/^(?:remove|delete|drop)\s+(?:the\s+)?(.+?)\s+(?:option|answer|choice)s?\s+(?:from|of|in|on|at)\s+(.+)$/i)
      ?? exec(/^(?:remove|delete|drop)\s+(.+?)\s+from\s+(.+?)['’]s\s+(?:options|answers|list|choices)$/i);
    const bare = withWord ? null : exec(/^(?:remove|delete|drop)\s+(.+?)\s+from\s+(.+)$/i);
    const rm = withWord ?? bare;
    if (rm) {
      const q = resolveQuestionRef(r.def, rm[2], r.ctx);
      if (!q.ok && !withWord) return null;
      if (!q.ok) return unresolved(r, "option_modification", `Remove option ${rm[1]} from ${rm[2]}.`, rm[2], q);
      const whole = resolveOptionRef(q.question, rm[1], { selected: r.ctx.selectedOption });
      const items = whole.ok ? [rm[1]] : splitLabels(rm[1]);
      const got: Option[] = [];
      for (const it of items) {
        const o = resolveOptionRef(q.question, it, { selected: r.ctx.selectedOption });
        if (!o.ok) { if (!withWord) return null; const x = optionOf(r, q.question, it, "option_modification", `Remove option ${it} from ${code(q.question)}.`); return x.ok ? null : x.out; }
        got.push(o.option);
      }
      return act(r, "option_modification", `Remove ${got.map((o) => `option ${o.code} “${plain(o.label, 40)}”`).join(", ")} from ${code(q.question)}.`, [{ op: "update_question", target: code(q.question), removeOptions: got.map((o) => o.code) }], [det("question", code(q.question)), ...got.map((o) => det("option", `${o.code} (${plain(o.label, 40)})`))]);
    }
  }

  /* ---- recode */
  if ((m = exec(/^(?:recode|re-code)\s+(?:the\s+)?(?:option\s+)?(.+?)\s+(?:in|of|on|at)\s+(.+?)\s+(?:as|to|into)\s+(?:code\s+)?(\S+)$/i))
    || (m = exec(/^(?:change|set)\s+the\s+code\s+of\s+(?:the\s+)?(?:option\s+)?(.+?)\s+(?:in|of|on|at)\s+(.+?)\s+to\s+(\S+)$/i))) {
    return recode(r, m[1], m[2], m[3]);
  }
  if ((m = exec(/^(?:recode|re-code)\s+(?:the\s+)?(?:option\s+)?(.+?)\s+(?:as|to)\s+(?:code\s+)?(\S+)\s+(?:in|of|on|at)\s+(.+)$/i))) return recode(r, m[1], m[3], m[2]);

  /* ---- rename */
  {
    const ren = exec(/^(?:rename|relabel|change|reword|retitle)\s+(?:the\s+)?(?:label\s+of\s+(?:the\s+)?)?(?:option|answer|choice)\s+(.+?)\s+(?:of|in|on|at|for)\s+(.+?)\s+(?:to|as|into)\s+(.+)$/i)
      ?? exec(/^(?:rename|relabel|change)\s+(?:the\s+)?(.+?)\s+(?:option|answer|choice)\s+(?:of|in|on|at)\s+(.+?)\s+(?:to|as)\s+(.+)$/i);
    const loose = ren ? null : exec(/^(?:rename|relabel)\s+(.+?)\s+(?:in|of|on|at)\s+(.+?)\s+(?:to|as)\s+(.+)$/i);
    const x = ren ?? loose;
    if (x) {
      const q = resolveQuestionRef(r.def, x[2], r.ctx);
      if (!q.ok) return ren ? unresolved(r, "option_modification", `Rename option ${x[1]} of ${x[2]}.`, x[2], q) : null;
      const o = resolveOptionRef(q.question, x[1], { selected: r.ctx.selectedOption });
      if (!o.ok) { if (!ren) return null; const g = optionOf(r, q.question, x[1], "option_modification", `Rename option ${x[1]} of ${code(q.question)}.`); return g.ok ? null : g.out; }
      const label = unquote(x[3]);
      return act(r, "option_modification", `Rename option ${o.option.code} of ${code(q.question)} from “${plain(o.option.label, 40)}” to “${label}” (its code stays ${o.option.code}).`, [{ op: "update_option", target: code(q.question), option: o.option.code, label }], [det("question", code(q.question)), det("option", `${o.option.code} (${plain(o.option.label, 40)})`), det("new label", label)]);
    }
  }

  /* ---- exclusive / other-specify */
  {
    const EXW = String.raw`(exclusive|not\s+exclusive|non-?exclusive|an?\s+exclusive\s+(?:option|answer)|an?\s+other[-\s]specify(?:\s+option)?|an?\s+specify\s+option|specify)`;
    const qFirst = exec(new RegExp(String.raw`^(?:make|mark|set)\s+(.+?)(?:['’]s)?\s+options?\s+${EXW}\s+(?:for|on)\s+(.+)$`, "i"));
    const inQ = exec(new RegExp(String.raw`^(?:make|mark|set|flag)\s+(?:the\s+)?(?:option\s+)?(.+?)\s+(?:option\s+)?(?:as\s+)?${EXW}\s+(?:in|on|at|for|of)\s+(.+)$`, "i"));
    const ofQ = exec(new RegExp(String.raw`^(?:make|mark|set|flag)\s+(?:the\s+)?(?:option\s+)?(.+?)\s+(?:of|in|on|at)\s+(.+?)\s+(?:as\s+)?${EXW}$`, "i"));
    const noQ = exec(new RegExp(String.raw`^(?:make|mark|set|flag)\s+(?:the\s+)?(?:option\s+)?(.+?)\s+(?:option\s+)?(?:as\s+)?${EXW}$`, "i"));
    const pick = qFirst ? { opt: qFirst[3], q: qFirst[1], w: qFirst[2] } : inQ ? { opt: inQ[1], q: inQ[3], w: inQ[2] } : ofQ ? { opt: ofQ[1], q: ofQ[2], w: ofQ[3] } : noQ ? { opt: noQ[1], q: null as string | null, w: noQ[2] } : null;
    if (pick) {
      const other = /specify/i.test(pick.w);
      const on = !/not|non/i.test(pick.w);
      let q: Question | undefined;
      if (pick.q) { const g = questionOf(r, pick.q, "option_modification", `Make option ${pick.opt} ${pick.w}.`); if (!g.ok) return g.out; q = g.v; }
      else {
        // no question named: the selected one, else the one question with an option of that label
        const sel = r.ctx.selectedId ? r.def.questions.find((x) => x.id === r.ctx.selectedId) : undefined;
        if (sel && resolveOptionRef(sel, pick.opt, { selected: r.ctx.selectedOption }).ok) q = sel;
        else {
          const want = unquote(pick.opt).toLowerCase();
          const holders = r.def.questions.filter((x) => (x.options ?? []).some((o) => plain(o.label, 200).toLowerCase() === want));
          if (holders.length === 1) q = holders[0];
          else if (holders.length > 1) return { kind: "clarify", category: "option_modification", understood: `Make “${unquote(pick.opt)}” ${pick.w}.`, question: `${holders.length} questions have an option “${unquote(pick.opt)}”: ${holders.map(code).join(", ")} — in which one?`, choices: holders.map((h) => ({ label: `${code(h)} — ${plain(h.text, 60)}`, text: `${r.text} in ${code(h)}` })), detected: [] };
          else if (!sel) return refused("option_modification", `Make “${unquote(pick.opt)}” ${pick.w}.`, `No question has an option “${unquote(pick.opt)}”, and none is selected — name the question (“make None exclusive in Q5”).`);
          else q = sel;
        }
      }
      const o = optionOf(r, q, pick.opt, "option_modification", `Make option ${pick.opt} of ${code(q)} ${pick.w}.`);
      if (!o.ok) return o.out;
      const label = `${o.v.code} “${plain(o.v.label, 40)}”`;
      if (other ? o.v.flags?.includes("other_specify") : !!o.v.flags?.includes("exclusive") === on) return alreadySo("option_modification", `Make option ${label} of ${code(q)} ${pick.w}.`, `Option ${label} of ${code(q)} is already ${other ? "an other-specify option" : on ? "exclusive" : "not exclusive"} — nothing to change.`, [det("question", code(q)), det("option", `${o.v.code} (${plain(o.v.label, 40)})`)]);
      return act(r, "option_modification", other ? `Give option ${label} of ${code(q)} a text box to specify.` : on ? `Make option ${label} of ${code(q)} exclusive: selecting it clears every other answer.` : `Make option ${label} of ${code(q)} no longer exclusive.`, [{ op: "update_option", target: code(q), option: o.v.code, ...(other ? { other: true } : { exclusive: on }) }], [det("question", code(q)), det("option", `${o.v.code} (${plain(o.v.label, 40)})`)]);
    }
  }

  /* ---- sort / reverse */
  {
    const s = exec(/^(?:sort|order|reorder|re-order|arrange|put|list)\s+(?:the\s+)?(?:options?\s+(?:of|in|for)\s+)?(.+?)(?:['’]s)?(?:\s+options)?\s+((?:in\s+)?(?:reverse\s+alphabetical(?:ly)?|alphabetical(?:ly)?|a\s*(?:-|to|→)\s*z|z\s*(?:-|to|→)\s*a|by\s+code|by\s+name|by\s+label|code\s+order|numerical(?:ly)?|by\s+number|reverse(?:d)?|descending|ascending)(?:\s+order)?)$/i);
    const rev = exec(/^(?:reverse|flip|invert)\s+(?:the\s+)?(?:order\s+of\s+(?:the\s+)?)?(?:options?\s+(?:of|in|for)\s+)?(.+?)(?:['’]s)?(?:\s+options)?(?:\s+order)?$/i);
    const sortBy = s ? SORTS.find(([re]) => re.test(s[2].trim()))?.[1] : rev ? "reverse" as const : undefined;
    if (sortBy && (s || rev)) {
      const ref = (s ?? rev)![1].replace(/\s+options?$/i, "");
      const q = questionOf(r, ref, "option_modification", `Sort the options of ${ref} ${SORT_WORDS[sortBy]}.`, { loose: !!rev });
      if (!q.ok) return q.out;
      return act(r, "option_modification", `Put the options of ${code(q.v)} in ${sortBy === "reverse" ? "reverse order" : `${SORT_WORDS[sortBy]} order`}; anchored options keep their place.`, [{ op: "reorder_options", target: code(q.v), sort: sortBy }], qDetected([q.v]));
    }
  }

  /* ---- move one option */
  {
    // "move Canada to the top of Q11" / "move Canada in Q11 to the top": [option, edge, question]
    const e1 = exec(/^move\s+(?:the\s+)?(?:option\s+)?(.+?)\s+(?:to\s+)?(?:the\s+)?(top|bottom|start|end|first|last)(?:\s+(?:of\s+the\s+list|position|place))?\s+(?:of|in|on|at)\s+(.+)$/i);
    const e2 = e1 ? null : exec(/^move\s+(?:the\s+)?(?:option\s+)?(.+?)\s+(?:in|of|at)\s+(.+?)\s+to\s+the\s+(top|bottom|start|end)$/i);
    const edge = e1 ? [e1[0], e1[1], e1[2], e1[3]] : e2 ? [e2[0], e2[1], e2[3], e2[2]] : null;
    const rel = exec(/^move\s+(?:the\s+)?(?:option\s+)?(.+?)\s+(before|after|above|below)\s+(.+?)\s+(?:in|of|on|at)\s+(.+)$/i);
    if (edge || rel) {
      const qRef = edge ? edge[3] : rel![4];
      const q = resolveQuestionRef(r.def, qRef, r.ctx);
      if (!q.ok) return null;
      const o = resolveOptionRef(q.question, edge ? edge[1] : rel![1], { selected: r.ctx.selectedOption });
      if (!o.ok) return null;
      if (edge) {
        const top = /top|start|first/i.test(edge[2]);
        const position = top ? 1 : (q.question.options ?? []).length;
        if (o.position === position) return alreadySo("option_modification", `Move “${plain(o.option.label, 40)}” to the ${top ? "top" : "bottom"} of ${code(q.question)}.`, `“${plain(o.option.label, 40)}” is already ${top ? "the first" : "the last"} option of ${code(q.question)}.`, [det("question", code(q.question))]);
        return act(r, "option_modification", `Move option ${o.option.code} “${plain(o.option.label, 40)}” to the ${top ? "top" : "bottom"} of ${code(q.question)} (position ${position}).`, [{ op: "update_option", target: code(q.question), option: o.option.code, position }], [det("question", code(q.question)), det("option", `${o.option.code} (${plain(o.option.label, 40)})`)]);
      }
      const anchor = optionOf(r, q.question, rel![3], "option_modification", `Move option ${o.option.code} of ${code(q.question)}.`);
      if (!anchor.ok) return anchor.out;
      const after = /after|below/i.test(rel![2]);
      return act(r, "option_modification", `Move option “${plain(o.option.label, 40)}” of ${code(q.question)} ${after ? "after" : "before"} “${plain(anchor.v.label, 40)}”.`, [{ op: "update_option", target: code(q.question), option: o.option.code, position: after ? { after: anchor.v.code } : { before: anchor.v.code } }], [det("question", code(q.question)), det("option", `${o.option.code} (${plain(o.option.label, 40)})`)]);
    }
  }

  /* ---- anchor */
  if ((m = exec(/^(?:anchor|pin|lock|fix)\s+(?:the\s+)?(?:option\s+)?(.+?)\s+(?:at|to)\s+the\s+(top|bottom)\s+(?:of|in|on|at)\s+(.+)$/i))) {
    const q = questionOf(r, m[3], "option_modification", `Anchor option ${m[1]} at the ${m[2]}.`);
    if (!q.ok) return q.out;
    const o = optionOf(r, q.v, m[1], "option_modification", `Anchor option ${m[1]} of ${code(q.v)}.`);
    if (!o.ok) return o.out;
    return act(r, "option_modification", `Anchor option “${plain(o.v.label, 40)}” of ${code(q.v)} at the ${m[2].toLowerCase()}, whatever the order.`, [{ op: "update_option", target: code(q.v), option: o.v.code, anchor: m[2].toLowerCase() as "top" | "bottom" }], [det("question", code(q.v)), det("option", `${o.v.code} (${plain(o.v.label, 40)})`)]);
  }
  return null;
};

function recode(r: Run, optRef: string, qRef: string, to: string): Interpretation {
  const q = questionOf(r, qRef, "option_modification", `Recode option ${optRef} of ${qRef} as ${to}.`);
  if (!q.ok) return q.out!;
  const o = optionOf(r, q.v, optRef, "option_modification", `Recode option ${optRef} of ${code(q.v)} as ${to}.`);
  if (!o.ok) return o.out!;
  const value: string | number = /^-?\d+$/.test(to) ? Number(to) : unquote(to);
  return act(r, "option_modification", `Recode option “${plain(o.v.label, 40)}” of ${code(q.v)} from ${o.v.code} to ${value}; every condition and quota that compares ${code(q.v)} with ${o.v.code} follows it.`, [{ op: "update_option", target: code(q.v), option: o.v.code, code: value }], [det("question", code(q.v)), det("option", `${o.v.code} (${plain(o.v.label, 40)})`), det("new code", String(value))]);
}

/* ---------------------------------------------------------- required */

const required: Recogniser = (r) => {
  const t = r.text;
  const WORD = String.raw`(required|mandatory|compulsory|optional|not\s+required|non-?mandatory|not\s+mandatory)`;
  const m = new RegExp(String.raw`^(?:make|set|mark|turn)\s+(.+?)\s+(?:as\s+|to\s+)?(?:be\s+)?${WORD}$`, "i").exec(t)
    ?? new RegExp(String.raw`^(.+?)\s+(?:is|are|should\s+be|must\s+be|has\s+to\s+be|have\s+to\s+be|needs\s+to\s+be|need\s+to\s+be|becomes?)\s+(?:now\s+)?${WORD}$`, "i").exec(t);
  const verb = m ? null : /^(?:require|mandate)\s+(?!(?:at\s+least|at\s+most|a\s+minimum|a\s+maximum|min|max|no\s+more|up\s+to|exactly|\d))(?:an?\s+answers?\s+(?:to|for|on)\s+)?(.+)$/i.exec(t);
  if (!m && !verb) return null;
  const ref = m ? m[1] : verb![1];
  const on = m ? !/optional|not|non/i.test(m[2]) : true;
  const word = on ? "required" : "optional";
  const range = rangeOf(r, ref, "question_modification", `Make ${unquote(ref)} ${word}.`);
  if (!range.ok) return range.out;
  const qs = range.v;
  const change = qs.filter((q) => !!q.required !== on);
  const label = rangeLabel(r.def, qs);
  if (!change.length) return alreadySo("question_modification", `Make ${label} ${word}.`, `${label} ${qs.length === 1 ? "is" : "are"} already ${word} — nothing to change.`, qDetected(qs));
  const already = qs.filter((q) => !change.includes(q));
  return act(r, "question_modification", `Make ${label} ${word}${already.length ? ` (${already.map(code).join(", ")} already ${already.length === 1 ? "is" : "are"})` : ""}.`, change.map((q): SurveyAction => ({ op: "update_question", target: code(q), required: on })), qDetected(qs));
};

/* ---------------------------------------------------------- skips and terminations */

interface SkipAsk { cond: string; unless?: boolean; from?: string; range?: string; to?: string; status?: "end" | "screened" | "terminated" | "quota_full"; back?: boolean }

function pageIdOf(def: SurveyDefinition, qid: string): string | undefined {
  return listPages(def.flow as unknown[]).find((p) => p.node.questionIds.includes(qid))?.node.id;
}

/**
 * Hide each of `qs` when the condition holds — what a skip over questions
 * that are not one continuous run (or not right after the question the
 * condition reads) has to be instead. Display logic already on a question is
 * kept: the new condition is an exception to it.
 */
function hideEach(r: Run, qs: Question[], expression: string): { text: string; actions?: SurveyAction[] } | undefined {
  const actions: SurveyAction[] = qs.map((q) => ({ op: "set_display_logic", target: code(q), expression: q.displayLogic ? `${paren(formatCondition(r.def, q.displayLogic))} AND NOT (${expression})` : `NOT (${expression})` }));
  const out = applySurveyActions(r.def, actions);
  return out.valid && !out.errors.length ? { text: `hide ${rangeLabel(r.def, qs)} when ${expression}`, actions } : undefined;
}

function planSkip(r: Run, ask: SkipAsk): Interpretation {
  const def = r.def;
  const order = placedOrder(def);
  const at = (q: Question) => order.indexOf(q.id);
  const c = readCondition(r, ask.cond, ask.unless);
  const askWords = ask.range ? `Skip ${ask.range} when ${ask.cond}.` : ask.status ? `${ask.status === "end" ? "End the survey" : ask.status === "screened" ? "Screen out" : "Terminate"} when ${ask.cond}.` : `Skip to ${ask.to} when ${ask.cond}.`;
  if (!c.ok) return badCondition(r, "logic", askWords, ask.cond, c);
  const cond = c.condition;
  const condWords = conditionWords(def, cond);
  const detected: Detected[] = [det("condition", condWords)];
  // the question the rule lives on: the one named, else the LAST question the condition reads (its answer is known by then)
  const reads = [...conditionRefs(def, cond)].map((id) => def.questions.find((q) => q.id === id)).filter((q): q is Question => !!q && at(q) >= 0).sort((a, b) => at(a) - at(b));
  let from: Question | undefined = reads[reads.length - 1];
  if (ask.from) { const f = questionOf(r, ask.from, "logic", askWords); if (!f.ok) return f.out!; from = f.v; }
  if (!from) return refused("logic", askWords, `The condition ${condWords} reads no question that is asked in the flow, so I cannot tell which question the skip should follow — say “after Q3, skip to …”.`, detected);
  detected.push(det("skip from", code(from)));

  if (ask.range) {
    const range = rangeOf(r, ask.range, "logic", askWords, { anchorId: from.id });
    if (!range.ok) return range.out!;
    const qs = range.v;
    const label = rangeLabel(def, qs);
    const start = qs[0], end = qs[qs.length - 1];
    detected.push(det("range", label));
    const idx = qs.map(at);
    const gaps = idx.some((v, i) => i > 0 && v !== idx[i - 1] + 1);
    if (gaps) {
      const between = order.slice(idx[0], idx[idx.length - 1] + 1).filter((id) => !qs.some((q) => q.id === id)).map((id) => code(def.questions.find((q) => q.id === id)!));
      return refused("logic", askWords, `A skip jumps over one continuous run of questions, and ${label} is not one — ${between.join(", ")} ${between.length === 1 ? "sits" : "sit"} between them and would be skipped too. Use display logic on each question instead.`, detected, hideEach(r, qs, c.expression));
    }
    const inside = reads.find((q) => at(q) >= at(start));
    if (inside) return refused("logic", askWords, `The condition reads ${code(inside)}, which is asked ${at(inside) <= at(end) ? `inside the questions to skip (${label})` : `after them`}, so its answer is not known when the skip would happen.`, detected);
    if (at(from) >= at(start)) return refused("logic", askWords, `The skip would live on ${code(from)}, which is not before ${label} — a skip can only pass over questions asked after the one it follows.`, detected);
    const gap = order.slice(at(from) + 1, at(start)).map((id) => def.questions.find((q) => q.id === id)!);
    if (gap.length) return refused("logic", askWords, `The skip would live on ${code(from)} (the question the condition reads) and jump past ${label} — but ${gap.map(code).join(", ")} ${gap.length === 1 ? "comes" : "come"} between ${code(from)} and ${code(start)} and would be skipped too. Hide ${label} with display logic instead, or skip ${code(gap[0])} through ${code(end)}.`, detected, hideEach(r, qs, c.expression));
    const after = firstQuestionAfter(def, qs);
    const toCode = after === "end" ? "end" : code(after);
    const toLabel = after === "end" ? "the end" : code(after);
    if (ask.to) {
      const named = /^(?:the\s+)?end(?:\s+of\s+(?:the\s+)?survey)?$/i.test(ask.to.trim()) ? "end" as const : (() => { const g = resolveQuestionRef(def, ask.to!, r.ctx); return g.ok ? g.question : null; })();
      if (named && named !== after && (named === "end" || after === "end" || named.id !== (after as Question).id)) {
        return refused("logic", askWords, `Skipping ${label} lands on ${toLabel}, but you asked to go to ${named === "end" ? "the end" : code(named)} — ${named !== "end" && at(named) <= at(end) ? `${code(named)} is inside the questions to skip` : "that would skip more than you named"}. Say which you mean: “skip ${label}” or “skip to ${named === "end" ? "the end" : code(named)}”.`, detected);
      }
    }
    detected.push(det("skip range", `${label} → ${toLabel}`), det("target", toLabel));
    // a skip lands on the PAGE of its target and only fires from a question the respondent was shown
    const breaks: SurveyAction[] = [];
    if (pageIdOf(def, from.id) && pageIdOf(def, from.id) === pageIdOf(def, start.id)) breaks.push({ op: "page_break", after: code(from) });
    if (after !== "end" && pageIdOf(def, after.id) && pageIdOf(def, after.id) === pageIdOf(def, end.id)) breaks.push({ op: "page_break", after: code(end) });
    const skip: SurveyAction = { op: "add_skip", from: code(from), when: c.expression, to: toCode };
    if (breaks.length) {
      const why = [breaks.some((b) => b.op === "page_break" && b.after === code(from)) ? `${code(start)} is on the same page as ${code(from)}, so it is already on screen when the skip is decided` : "", breaks.some((b) => b.op === "page_break" && b.after === code(end)) ? `${toLabel} shares a page with ${code(end)}, so landing on it shows ${code(end)} again` : ""].filter(Boolean).join("; and ");
      const fix = [...breaks, skip];
      const ok = applySurveyActions(def, fix);
      return refused("logic", askWords, `A skip moves between pages: ${why}. Add a page break first.`, detected, ok.valid && !ok.errors.length ? { text: `${breaks.map((b) => `add a page break after ${(b as { after: string }).after}`).join(", ")}, then ${r.text}`, actions: fix } : undefined);
    }
    return act(r, "logic", `Skip ${label} for respondents ${whoPhrase(def, cond)}: after ${code(from)}, when ${condWords}, go to ${toLabel}.`, [skip], detected);
  }

  // a jump to a named target, or out of the survey
  let to: string;
  let toLabel: string;
  if (ask.status) {
    to = ask.status;
    toLabel = ask.status === "end" ? "the end" : `out of the survey (${ask.status.replace(/_/g, " ")})`;
  } else {
    const word = ask.to!.trim().toLowerCase();
    if (/^(?:the\s+)?(?:end|finish|completion|last\s+page)(?:\s+of\s+(?:the\s+)?survey)?$/.test(word)) { to = "end"; toLabel = "the end"; }
    else if (/screen|disqualif/.test(word)) { to = "screened"; toLabel = "out of the survey (screened)"; }
    else if (/terminat|exit/.test(word)) { to = "terminated"; toLabel = "out of the survey (terminated)"; }
    else {
      const b = /\bblock\b|\bsection\b/i.test(ask.to!) ? blockOf(def, ask.to!) : null;
      if (b) { to = b.title; toLabel = `block “${b.title}”`; }
      else {
        const g = questionOf(r, ask.to!, "logic", askWords);
        if (!g.ok) return g.out!;
        const target = g.v;
        // "back" to a question that is still ahead: refused for the word, not for a direction it does not have
        if (ask.back && at(target) > at(from)) {
          return refused("logic", askWords, `Skips only move forward, and ${code(target)} is asked after ${code(from)}${ask.from ? "" : " (the question the condition reads)"}, so there is nothing to go back to — to jump ahead to it, say “skip to ${code(target)}”.`, [...detected, det("target", code(target))], suggest(r, r.text.replace(/\bback\s+/i, "")));
        }
        if (at(target) <= at(from)) {
          return refused("logic", askWords, `Skips only move forward. You asked to go to ${code(target)} when ${condWords}; the rule would live on ${code(from)}${ask.from ? "" : " (the question the condition reads)"}, and ${code(target)} ${target.id === from.id ? "is that question itself" : `is asked before it`}. To ask ${code(target)} again, use a loop over the questions in between; to route around it, skip forward to a later question.`, [...detected, det("target", code(target))]);
        }
        // a skip lands on its target's page: a target in the middle of a page shows the questions above it as well
        const page = listPages(def.flow as unknown[]).find((p) => p.node.questionIds.includes(target.id));
        const pos = page ? page.node.questionIds.indexOf(target.id) : -1;
        if (page && pos > 0) {
          const prev = def.questions.find((q) => q.id === page.node.questionIds[pos - 1])!;
          const fix: SurveyAction[] = [{ op: "page_break", after: code(prev) }, { op: "add_skip", from: code(from), when: c.expression, to: code(target) }];
          const ok = applySurveyActions(def, fix);
          return refused("logic", askWords, `A skip lands on the page of its target, and ${code(target)} shares a page with ${code(prev)}, which is above it — the respondent would see ${code(prev)} too. Put ${code(target)} on its own page first.`, [...detected, det("target", code(target))], ok.valid && !ok.errors.length ? { text: `put ${code(target)} on a new page, then ${r.text}`, actions: fix } : undefined);
        }
        to = code(target); toLabel = code(target);
      }
    }
  }
  detected.push(det("target", toLabel));
  const out = ask.status && ask.status !== "end"
    ? `${ask.status === "screened" ? "Screen out" : ask.status === "quota_full" ? "End as quota full" : "Terminate"} respondents ${whoPhrase(def, cond)}: after ${code(from)}, when ${condWords}, they leave the survey (${ask.status.replace(/_/g, " ")}).`
    : `After ${code(from)}, when ${condWords}, go to ${toLabel}.`;
  return act(r, "logic", out, [{ op: "add_skip", from: code(from), when: c.expression, to }], detected);
}

const skips: Recogniser = (r) => {
  const t = r.text;
  let m: RegExpExecArray | null;
  const STATUS = (s: string, as?: string): SkipAsk["status"] => (as && /quota/i.test(as) ? "quota_full" : as && /screen/i.test(as) ? "screened" : as && /complete|end/i.test(as) ? "end" : /screen|disqualif/i.test(s) ? "screened" : /^end|finish|close/i.test(s) ? "end" : "terminated");
  const TERM = String.raw`(terminate|screen\s*(?:them\s+|respondents?\s+|people\s+|him\s+|her\s+)?out|disqualify|end\s+the\s+(?:survey|interview)|finish\s+the\s+survey|exit|close\s+the\s+survey|reject)`;
  // "if Q7 is no, skip Q8 through Q12" / "… skip the next five questions" / "… skip Q6 and Q7 and go directly to Q8" / "… skip to Q13"
  if ((m = /^(?:if|when|where)\s+(.+?),?\s+(?:then\s+)?(skip|jump|go|move|send(?:\s+(?:them|respondents?|people))?|branch|route(?:\s+(?:them|respondents?))?)\s+(.+)$/i.exec(t))) {
    const rest = m[3].trim();
    const toForm = /^(?:(?:straight|directly|forward|ahead|right)\s+)*(back\s+)?(?:to|ahead\s+to)\s+(.+)$/i.exec(rest);
    if (toForm) return planSkip(r, { cond: m[1], to: toForm[2], back: !!toForm[1] });
    if (!/^skip$/i.test(m[2])) return null;
    const and = /^(.+?)\s+and\s+(?:then\s+)?(?:go|jump|continue|proceed|move|skip)\s+(?:(?:straight|directly|on|right)\s+)?(?:ahead\s+)?to\s+(.+)$/i.exec(rest);
    return planSkip(r, { cond: m[1], range: and ? and[1] : rest, ...(and ? { to: and[2] } : {}) });
  }
  if ((m = new RegExp(String.raw`^(?:if|when|where)\s+(.+?),?\s+(?:then\s+)?${TERM}(?:\s+(?:the\s+)?(?:survey|interview|respondents?|them|people))?(?:\s+as\s+(\w+(?:\s+\w+)?))?$`, "i").exec(t))) {
    return planSkip(r, { cond: m[1], status: STATUS(m[2], m[3]) });
  }
  // "skip Q8 through Q12 if Q7 is No"
  if ((m = /^skip\s+(?!to\b|ahead\b|straight\b|directly\b|forward\b|back\b)(.+?)\s+(if|when|unless|for\s+(?:respondents?|people|those|anyone)\s+(?:who|that|whose))\s+(.+)$/i.exec(t))) {
    return planSkip(r, { cond: m[3], unless: /^unless$/i.test(m[2]), range: m[1] });
  }
  // "[after Q2,] skip to Q9 when Q2 = No" / "go to the end if …" / "jump back to Q2 if …"
  if ((m = /^(?:(?:after|from|at)\s+(.+?),?\s+)?(?:skip|jump|go|move|branch|send(?:\s+(?:them|respondents?|people))?|route(?:\s+(?:them|respondents?))?)\s+(?:(?:straight|directly|forward|ahead|right)\s+)*(back\s+)?(?:to|ahead\s+to)\s+(.+?)\s+(when|if|where|unless)\s+(.+)$/i.exec(t))) {
    return planSkip(r, { cond: m[5], unless: /^unless$/i.test(m[4]), ...(m[1] ? { from: m[1] } : {}), to: m[3], back: !!m[2] });
  }
  if (/^(?:skip|jump|go)\s+(?:straight\s+|directly\s+)?to\s+\S+/i.test(t) && !/\b(?:if|when|unless|where)\b/i.test(t)) {
    return refused("logic", `Skip ${t.replace(/^(?:skip|jump|go)\s+/i, "")}.`, "A skip needs a condition — say when it happens: “skip to Q9 when Q2 = No”. To move a question instead, say “move Q9 after Q2”.");
  }
  // "[after Q1,] screen out / terminate if Q1 < 18"
  if ((m = new RegExp(String.raw`^(?:(?:after|from|at)\s+(.+?),?\s+)?${TERM}(?:\s+(?:the\s+)?(?:survey|interview|respondents?|them|people|anyone))?(?:\s+as\s+(\w+(?:\s+\w+)?))?\s*,?\s+(when|if|where|unless)\s+(.+)$`, "i").exec(t))) {
    return planSkip(r, { cond: m[5], unless: /^unless$/i.test(m[4]), ...(m[1] ? { from: m[1] } : {}), status: STATUS(m[2], m[3]) });
  }
  return null;
};

/* ---------------------------------------------------------- display logic */

function planDisplay(r: Run, targetRef: string, condText: string, mode: "show" | "hide" | "also_show" | "also_hide", unless = false): Interpretation {
  const def = r.def;
  const hide = mode === "hide" || mode === "also_hide";
  const words0 = `${hide ? "Hide" : "Show"} ${unquote(targetRef)} ${hide ? "" : "only "}when ${condText}.`;
  const c = readCondition(r, condText, unless);
  if (!c.ok) return badCondition(r, "logic", words0, condText, c);
  const cw = conditionWords(def, c.condition);
  const detected: Detected[] = [det("condition", cw)];
  const block = /\b(?:block|section)\b/i.test(targetRef) ? blockOf(def, targetRef) : null;
  const shown = hide ? `NOT (${c.expression})` : c.expression;
  if (block) {
    const node = listBlocks(def.flow as unknown[]).find((b) => b.id === block.id)?.node as { visibleIf?: Condition } | undefined;
    const had = node?.visibleIf;
    const expression = had && mode === "also_show" ? `${paren(formatCondition(def, had))} OR ${paren(c.expression)}` : had && mode === "also_hide" ? `${paren(formatCondition(def, had))} AND NOT (${c.expression})` : shown;
    // a block is named by its title only when nothing else reads the same — a title can also be a variable name ("Brands" / BRANDS); see blockRef
    return act(r, "logic", `${hide ? "Hide" : "Show"} block “${block.title}” ${hide ? "" : "only "}when ${cw}${had && !mode.startsWith("also") ? ` — this replaces its current condition (${conditionWords(def, had)})` : ""}.`, [{ op: "set_display_logic", target: blockRef(def, block, { orQuestion: true }), expression }], [...detected, det("block", block.title)]);
  }
  const range = rangeOf(r, targetRef, "logic", words0);
  if (!range.ok) return range.out!;
  const qs = range.v;
  const actions: SurveyAction[] = [];
  const replaced: string[] = [];
  for (const q of qs) {
    const had = q.displayLogic;
    const expression = had && mode === "also_show" ? `${paren(formatCondition(def, had))} OR ${paren(c.expression)}` : had && mode === "also_hide" ? `${paren(formatCondition(def, had))} AND NOT (${c.expression})` : shown;
    if (had && !mode.startsWith("also")) replaced.push(`${code(q)}: ${conditionWords(def, had)}`);
    actions.push({ op: "set_display_logic", target: code(q), expression });
  }
  const label = rangeLabel(def, qs);
  const understood = mode === "also_show" ? `Also show ${label} when ${cw}, in addition to the logic ${qs.length === 1 ? "it" : "they"} already ${qs.length === 1 ? "has" : "have"}.`
    : mode === "also_hide" ? `Also hide ${label} when ${cw}, keeping the logic ${qs.length === 1 ? "it" : "they"} already ${qs.length === 1 ? "has" : "have"}.`
    : hide ? `Hide ${label} when ${cw} — ${qs.length === 1 ? "its" : "their"} display logic becomes NOT (${c.expression}).` : `Show ${label} only when ${cw}.`;
  return act(r, "logic", `${understood}${replaced.length ? ` This replaces the current display logic (${replaced.join("; ")}) — say “also show …” to add to it instead.` : ""}`, actions, [...detected, ...qDetected(qs), ...replaced.map((x) => det("replaces", x))]);
}

const display: Recogniser = (r) => {
  const t = r.text;
  let m: RegExpExecArray | null;
  const WHEN = String.raw`(?:only\s+)?(?:when|if|where|for\s+(?:respondents?|people|those|anyone|users|participants)\s+(?:who|that|whose))`;
  if ((m = /^(?:remove|clear|delete|drop)\s+(?:the\s+|all\s+)?(?:display\s+)?(?:logic|conditions?|display\s+logic|display\s+conditions?|visibility\s+(?:logic|condition))\s+(?:from|on|of|for)\s+(.+)$/i.exec(t))
    || (m = /^(?:remove|clear|delete)\s+(.+?)['’]s\s+display\s+(?:logic|condition)$/i.exec(t))
    || (m = /^(?:always\s+show|unhide)\s+(.+)$/i.exec(t))) {
    const ref = m[1];
    const block = /\b(?:block|section)\b/i.test(ref) ? blockOf(r.def, ref) : null;
    if (block) return act(r, "logic", `Always show block “${block.title}” (remove its display condition).`, [{ op: "set_display_logic", target: blockRef(r.def, block, { orQuestion: true }), expression: null }], [det("block", block.title)]);
    const range = rangeOf(r, ref, "logic", `Remove the display logic of ${unquote(ref)}.`);
    if (!range.ok) return range.out;
    const qs = range.v;
    const none = qs.filter((q) => !q.displayLogic);
    if (none.length === qs.length) return alreadySo("logic", `Remove the display logic of ${rangeLabel(r.def, qs)}.`, `${rangeLabel(r.def, qs)} ${qs.length === 1 ? "has" : "have"} no display logic — ${qs.length === 1 ? "it is" : "they are"} always shown already.`, qDetected(qs));
    const had = qs.filter((q) => q.displayLogic);
    return act(r, "logic", `Always show ${had.map(code).join(", ")}: remove ${had.length === 1 ? "its" : "their"} display logic (${had.map((q) => `${code(q)}: ${conditionWords(r.def, q.displayLogic!)}`).join("; ")}).`, had.map((q): SurveyAction => ({ op: "set_display_logic", target: code(q), expression: null })), had.map((q) => det("removes", `${code(q)}: ${conditionWords(r.def, q.displayLogic!)}`)));
  }
  if ((m = new RegExp(String.raw`^also\s+(?:show|display|ask|present|include)\s+(.+?)\s+${WHEN}\s+(.+)$`, "i").exec(t))) return planDisplay(r, m[1], m[2], "also_show");
  if ((m = new RegExp(String.raw`^also\s+(?:hide|suppress)\s+(.+?)\s+${WHEN}\s+(.+)$`, "i").exec(t))) return planDisplay(r, m[1], m[2], "also_hide");
  // "when A unless B" is read by the condition (A AND NOT B), so the when-forms go first and a bare "unless" after them
  if ((m = new RegExp(String.raw`^(?:only\s+)?(?:show|display|ask|present|include)\s+(.+?)\s+${WHEN}\s+(.+)$`, "i").exec(t))) return planDisplay(r, m[1], m[2], "show");
  if ((m = /^(?:only\s+)?(?:show|display|ask|present|include)\s+(.+?)\s+unless\s+(.+)$/i.exec(t))) return planDisplay(r, m[1], m[2], "show", true);
  if ((m = new RegExp(String.raw`^(?:hide|suppress|don['’]t\s+(?:show|ask|display)|do\s+not\s+(?:show|ask|display)|never\s+(?:show|ask))\s+(.+?)\s+${WHEN}\s+(.+)$`, "i").exec(t))) return planDisplay(r, m[1], m[2], "hide");
  if ((m = /^(?:hide|suppress|don['’]t\s+(?:show|ask|display)|do\s+not\s+(?:show|ask|display)|never\s+(?:show|ask))\s+(.+?)\s+unless\s+(.+)$/i.exec(t))) return planDisplay(r, m[1], m[2], "show");
  if ((m = /^(.+?)\s+(?:should\s+(?:only\s+)?(?:be\s+)?|is\s+(?:only\s+)?|must\s+(?:only\s+)?(?:be\s+)?|(?:will|can)\s+(?:only\s+)?(?:be\s+)?)?(?:shown|displayed|asked|visible)(?:\s+only)?\s+(?:when|if|where)\s+(.+)$/i.exec(t))) return planDisplay(r, m[1], m[2], "show");
  if ((m = /^(.+?)\s+(?:should\s+(?:be\s+)?|is\s+|must\s+(?:be\s+)?|(?:will|can)\s+(?:be\s+)?)?(?:hidden|suppressed|not\s+(?:shown|asked|displayed))\s+(?:when|if|where)\s+(.+)$/i.exec(t))) return planDisplay(r, m[1], m[2], "hide");
  if ((m = /^(?:if|when)\s+(.+?),?\s+(?:then\s+)?(?:only\s+)?(show|display|ask|hide|suppress|don['’]t\s+show|do\s+not\s+show)\s+(.+)$/i.exec(t))) return planDisplay(r, m[3], m[1], /^(?:show|display|ask)$/i.test(m[2]) ? "show" : "hide");
  return null;
};

/* ---------------------------------------------------------- validation */

const NUM = String.raw`(-?\d+(?:\.\d+)?)`;
type ValAsk = { target: string; rules: ValidationSpec[] } | { target: string; clear: true; kinds?: string[] };

/** Validation sentences: the subject is whatever comes before the rule words. Every shape maps onto a rule kind the Validation panel already offers. */
function parseValidation(text: string): ValAsk | null {
  let m: RegExpExecArray | null;
  const T = String.raw`(.+?)`;
  const SEL = String.raw`(?:selections?|options?|answers?|items?|choices?|boxes|brands?)`;
  const rule = (target: string, rules: ValidationSpec[]): ValAsk => ({ target: unquote(target).replace(/^(?:the\s+)?(?:answer|value|response)\s+(?:to|of|for)\s+/i, ""), rules });
  if ((m = /^(?:clear|remove|drop|delete)\s+(?:all\s+|the\s+|every\s+)?validation(?:\s+rules?)?\s+(?:from|on|of)\s+(.+)$/i.exec(text))) return { target: m[1], clear: true };
  if ((m = /^(?:remove|drop|delete)\s+(?:the\s+)?(min(?:imum)?|max(?:imum)?|length|character|email|phone|url|zip|integer|pattern|range|selection)\s*(?:value|length|selections?|limit|rule|check)?\s+(?:rule\s+)?(?:from|on|of)\s+(.+)$/i.exec(text))) {
    const w = m[1].toLowerCase();
    const kinds = /^min/.test(w) ? ["min_value", "min_length", "min_selections"] : /^max/.test(w) ? ["max_value", "max_length", "max_selections"] : /length|character/.test(w) ? ["min_length", "max_length"] : /range/.test(w) ? ["min_value", "max_value"] : /selection/.test(w) ? ["min_selections", "max_selections"] : [w];
    return { target: m[2], clear: true, kinds };
  }
  if ((m = new RegExp(String.raw`^(?:make\s+|limit\s+|restrict\s+)?${T}\s+(?:must\s+be\s+|should\s+be\s+|is\s+|has\s+to\s+be\s+|to\s+(?:values?\s+)?|values?\s+)?(?:a\s+number\s+)?(?:between|from)\s+${NUM}\s+(?:and|to|-)\s+${NUM}(?:\s+(characters?|chars|letters|selections?|options?|answers?|items?))?$`, "i").exec(text))) {
    const unit = (m[4] ?? "").toLowerCase();
    const k = /char|letter/.test(unit) ? ["min_length", "max_length"] : /select|option|answer|item/.test(unit) ? ["min_selections", "max_selections"] : ["min_value", "max_value"];
    return rule(m[1], [{ kind: k[0], value: Number(m[2]) }, { kind: k[1], value: Number(m[3]) }]);
  }
  const exact = (target: string, n: string) => rule(target, [{ kind: "min_selections", value: Number(n) }, { kind: "max_selections", value: Number(n) }]);
  if ((m = new RegExp(String.raw`^(?:require\s+|allow\s+)?exactly\s+${NUM}\s+${SEL}\s+(?:on|for|at|in)\s+${T}$`, "i").exec(text))) return exact(m[2], m[1]);
  if ((m = new RegExp(String.raw`^${T}\s+(?:must\s+have\s+|should\s+have\s+|needs?\s+|requires?\s+|allows?\s+|has\s+)?exactly\s+${NUM}\s+${SEL}(?:\s+selected)?$`, "i").exec(text))) return exact(m[1], m[2]);
  if ((m = new RegExp(String.raw`^(?:require\s+|allow\s+)?(?:at\s+least|a\s+minimum\s+of|min(?:imum)?)\s+${NUM}\s+${SEL}\s+(?:on|for|at|in)\s+${T}$`, "i").exec(text))) return rule(m[2], [{ kind: "min_selections", value: Number(m[1]) }]);
  if ((m = new RegExp(String.raw`^(?:allow\s+|permit\s+)?(?:at\s+most|a\s+maximum\s+of|max(?:imum)?|no\s+more\s+than|up\s+to)\s+${NUM}\s+${SEL}\s+(?:on|for|at|in)\s+${T}$`, "i").exec(text))) return rule(m[2], [{ kind: "max_selections", value: Number(m[1]) }]);
  if ((m = new RegExp(String.raw`^${T}\s+(?:must\s+have\s+|should\s+have\s+|needs?\s+|requires?\s+|allows?\s+|has\s+)?(?:at\s+least|min(?:imum)?(?:\s+of)?)\s+${NUM}\s+${SEL}(?:\s+selected)?$`, "i").exec(text))) return rule(m[1], [{ kind: "min_selections", value: Number(m[2]) }]);
  if ((m = new RegExp(String.raw`^${T}\s+(?:must\s+have\s+|should\s+have\s+|allows?\s+|has\s+)?(?:at\s+most|max(?:imum)?(?:\s+of)?|no\s+more\s+than|up\s+to)\s+${NUM}\s+${SEL}(?:\s+selected)?$`, "i").exec(text))) return rule(m[1], [{ kind: "max_selections", value: Number(m[2]) }]);
  if ((m = new RegExp(String.raw`^(?:limit|restrict|cap)\s+${T}\s+(?:to|at)\s+${NUM}\s+(?:characters?|chars|letters)$`, "i").exec(text))) return rule(m[1], [{ kind: "max_length", value: Number(m[2]) }]);
  if ((m = new RegExp(String.raw`^${T}\s+(?:must\s+be\s+|should\s+be\s+|is\s+|has\s+|allows?\s+)?(?:at\s+most|max(?:imum)?(?:\s+of)?|no\s+(?:more|longer)\s+than|up\s+to)\s+${NUM}\s+(?:characters?|chars|letters)(?:\s+long)?$`, "i").exec(text))) return rule(m[1], [{ kind: "max_length", value: Number(m[2]) }]);
  if ((m = new RegExp(String.raw`^${T}\s+(?:must\s+be\s+|should\s+be\s+|is\s+|has\s+|needs?\s+)?(?:at\s+least|min(?:imum)?(?:\s+of)?|no\s+(?:fewer|less|shorter)\s+than)\s+${NUM}\s+(?:characters?|chars|letters)(?:\s+long)?$`, "i").exec(text))) return rule(m[1], [{ kind: "min_length", value: Number(m[2]) }]);
  if ((m = new RegExp(String.raw`^${T}\s+(?:must\s+be\s+|should\s+be\s+|is\s+|has\s+(?:a\s+)?)?(?:at\s+least|min(?:imum)?(?:\s+(?:value\s+)?(?:of|is))?|no\s+(?:less|lower|smaller)\s+than|>=|greater\s+than\s+or\s+equal\s+to)\s+${NUM}$`, "i").exec(text))) return rule(m[1], [{ kind: "min_value", value: Number(m[2]) }]);
  if ((m = new RegExp(String.raw`^${T}\s+(?:must\s+be\s+|should\s+be\s+|is\s+|has\s+(?:a\s+)?)?(?:at\s+most|max(?:imum)?(?:\s+(?:value\s+)?(?:of|is))?|no\s+(?:more|higher|greater)\s+than|<=|less\s+than\s+or\s+equal\s+to|up\s+to)\s+${NUM}$`, "i").exec(text))) return rule(m[1], [{ kind: "max_value", value: Number(m[2]) }]);
  if ((m = new RegExp(String.raw`^(?:set\s+(?:the\s+)?)?(?:min(?:imum)?|lowest)\s+(?:value\s+)?(?:of|for|on)\s+${T}\s+(?:to|=|is)\s+${NUM}$`, "i").exec(text))) return rule(m[1], [{ kind: "min_value", value: Number(m[2]) }]);
  if ((m = new RegExp(String.raw`^(?:set\s+(?:the\s+)?)?(?:max(?:imum)?|highest)\s+(?:value\s+)?(?:of|for|on)\s+${T}\s+(?:to|=|is)\s+${NUM}$`, "i").exec(text))) return rule(m[1], [{ kind: "max_value", value: Number(m[2]) }]);
  if ((m = new RegExp(String.raw`^(?:validate\s+|check\s+|make\s+|treat\s+)?${T}\s+(?:must\s+be\s+|should\s+be\s+|is\s+|as\s+|to\s+be\s+|has\s+to\s+be\s+)?(?:a\s+valid\s+|a\s+|an\s+|as\s+an?\s+)?(e-?mail(?:\s+address)?|phone(?:\s+number)?|telephone(?:\s+number)?|url|web\s+address|website|link|zip(?:\s+code)?|post(?:al)?\s*code|whole\s+number|integer|number\s+without\s+decimals)$`, "i").exec(text))) {
    const w = m[2].toLowerCase();
    return rule(m[1], [{ kind: /mail/.test(w) ? "email" : /phone|tele/.test(w) ? "phone" : /url|web|link/.test(w) ? "url" : /zip|post/.test(w) ? "zip" : "integer" }]);
  }
  if ((m = new RegExp(String.raw`^${T}\s+(?:must|should)\s+match\s+(?:the\s+)?(?:pattern|regex|regular\s+expression)\s+(.+)$`, "i").exec(text))) return rule(m[1], [{ kind: "pattern", value: unquote(m[2]) }]);
  return null;
}

/** a stored rule back as a spec: its condition gate kept, its stored (invalid-case) check turned back into what a valid answer satisfies */
function specOf(v: ValidationRule): ValidationSpec {
  const check = v.check ? (v.check.type === "group" && v.check.op === "not" && v.check.children.length === 1 ? v.check.children[0] : { type: "group", op: "not", children: [v.check] } as Condition) : undefined;
  return { kind: v.kind, ...(v.value !== undefined ? { value: v.value as number | string } : {}), ...(v.when ? { when: v.when } : {}), ...(check ? { check } : {}), ...(v.message ? { message: v.message } : {}) };
}
const ruleWords = (s: ValidationSpec) => `${ruleLabel(s.kind as ValidationRule["kind"])}${s.value !== undefined ? ` ${s.value}` : ""}`;

const validation: Recogniser = (r) => {
  const v = parseValidation(r.text);
  if (!v) return null;
  const q = questionOf(r, v.target, "validation", `Set validation on ${unquote(v.target)}.`);
  if (!q.ok) return q.out;
  const existing = q.v.validation ?? [];
  /*
   * set_validation REPLACES a question's rules, so a new rule is merged into
   * the ones already there: the same kind is replaced, every other rule is
   * re-emitted as it was (its condition gate and check included).
   */
  if ("clear" in v) {
    const kinds = v.kinds;
    const keep = kinds ? existing.filter((x) => !kinds.includes(x.kind)) : [];
    if (keep.length === existing.length) return refused("validation", `Remove ${kinds ? `the ${kinds.map((k) => ruleLabel(k as ValidationRule["kind"])).join(" / ")} rule` : "the validation"} from ${code(q.v)}.`, `${code(q.v)} has no ${kinds ? `${kinds.map((k) => ruleLabel(k as ValidationRule["kind"])).join(" or ")} rule` : "validation rules"} to remove.`, qDetected([q.v]));
    const gone = existing.filter((x) => !keep.includes(x));
    return act(r, "validation", `Remove ${gone.map((x) => ruleWords(specOf(x))).join(", ")} from ${code(q.v)}${keep.length ? `; keep ${keep.map((x) => ruleWords(specOf(x))).join(", ")}` : ""}.`, [{ op: "set_validation", target: code(q.v), rules: keep.map(specOf) }], qDetected([q.v]));
  }
  /*
   * A rule asked for exactly as it already stands keeps the stored one — its
   * message and all: "Q7 must be an email address" on a question that already
   * checks for an email changes nothing, and says so, rather than re-writing
   * the rule without its message.
   */
  const same = (x: ValidationRule, s: ValidationSpec) => x.kind === s.kind && !x.when && !s.when && !s.check && !s.message && String(x.value ?? "") === String(s.value ?? "");
  const fresh = v.rules.filter((s) => !existing.some((x) => same(x, s)));
  if (!fresh.length) {
    return alreadySo("validation", `${code(q.v)}: ${v.rules.map(ruleWords).join(", ")}.`, `${code(q.v)} already has ${v.rules.length === 1 ? "that rule" : "those rules"} (${v.rules.map(ruleWords).join(", ")}) — nothing to change.`, [...qDetected([q.v]), ...v.rules.map((x) => det("rule", ruleWords(x)))]);
  }
  const kinds = new Set(fresh.map((x) => x.kind));
  const kept = existing.filter((x) => !kinds.has(x.kind));
  const replaced = existing.filter((x) => kinds.has(x.kind));
  const rules = [...kept.map(specOf), ...fresh];
  return act(r, "validation", `${code(q.v)}: ${fresh.map(ruleWords).join(", ")}${replaced.length ? ` (replacing ${replaced.map((x) => ruleWords(specOf(x))).join(", ")})` : ""}${kept.length ? `; its other rules stay (${kept.map((x) => ruleWords(specOf(x))).join(", ")})` : ""}.`, [{ op: "set_validation", target: code(q.v), rules }], [...qDetected([q.v]), ...v.rules.map((x) => det("rule", ruleWords(x)))]);
};

/* ---------------------------------------------------------- questions */

const questions: Recogniser = (r) => {
  const t = r.text;
  const def = r.def;
  let m: RegExpExecArray | null;

  /* ---- rename a block */
  if ((m = /^rename\s+(?:the\s+)?block\s+(.+?)\s+(?:to|as)\s+(.+)$/i.exec(t)) || (m = /^rename\s+(?:the\s+)?(.+?)\s+block\s+(?:to|as)\s+(.+)$/i.exec(t))) {
    const b = blockOf(def, `block ${unquote(m[1])}`);
    if (!b) return refused("survey_editing", `Rename block ${unquote(m[1])}.`, `There is no block “${unquote(m[1])}” — the blocks are ${listBlocks(def.flow as unknown[]).filter((x) => x.title).map((x) => `“${x.title}”`).join(", ")}.`);
    const title = unquote(m[2]);
    return act(r, "survey_editing", `Rename block “${b.title}” to “${title}”.`, [{ op: "rename_block", target: blockRef(def, b), title }], [det("block", b.title)]);
  }
  /* ---- delete a quota — by its name ("the gender × age quota", "quota Region"); never a question or a block of that name */
  if ((m = /^(?:delete|remove|drop)\s+(?:the\s+)?(?:quota\s+(.+)|(.+?)\s+quota)$/i.exec(t))) {
    const name = unquote(m[1] ?? m[2]);
    const norm = (x: string) => x.toLowerCase().replace(/\s*[×x*]\s*/g, " x ").replace(/[“”"]/g, "").replace(/\s+/g, " ").trim();
    const quota = (def.quotas ?? []).find((x) => norm(x.name) === norm(name));
    if (!quota) return refused("survey_editing", `Delete the quota ${name}.`, (def.quotas ?? []).length ? `There is no quota “${name}” — the quotas are ${(def.quotas ?? []).map((x) => `“${x.name}”`).join(", ")}.` : `This survey has no quotas, so there is no “${name}” to delete.`);
    return act(r, "survey_editing", `Delete the quota “${quota.name}” (${quota.cells.length} cell${quota.cells.length === 1 ? "" : "s"}), its checks in the flow and any List Fill that reads it.`, [{ op: "delete_quota", quota: quota.name } as SurveyAction], [det("quota", quota.name)]);
  }
  /* ---- delete a block */
  if ((m = /^(?:delete|remove|drop)\s+(?:the\s+)?(?:whole\s+)?(block\s+.+|.+?\s+block)$/i.exec(t))) {
    const b = blockOf(def, m[1]);
    if (b) return act(r, "survey_editing", `Delete block “${b.title}” and every question in it.`, [{ op: "delete_block", target: blockRef(def, b) }], [det("block", b.title)]);
  }

  /* ---- question code */
  if ((m = /^(?:change|set|update|rename)\s+(?:the\s+)?(?:question\s+)?code\s+(?:of|for)\s+(.+?)\s+to\s+(\S+)$/i.exec(t)) || (m = /^(?:change|set|update)\s+(.+?)['’]s\s+(?:question\s+)?code\s+to\s+(\S+)$/i.exec(t)) || (m = /^renumber\s+(.+?)\s+(?:to|as)\s+(\S+)$/i.exec(t))) {
    const q = questionOf(r, m[1], "question_modification", `Change the code of ${m[1]} to ${m[2]}.`);
    if (!q.ok) return q.out;
    const to = unquote(m[2]);
    return act(r, "question_modification", `Change ${code(q.v)}'s code to ${to}; conditions and pipes that name ${code(q.v)} follow it.`, [{ op: "update_question", target: code(q.v), code: to }], [...qDetected([q.v]), det("new code", to)]);
  }

  /* ---- variable name */
  if ((m = /^rename\s+(?:the\s+)?(?:variable\s+)?(?!the\s+survey\b|survey\b|block\b|option\b)(.+?)(?:['’]s\s+variable(?:\s+name)?)?\s+(?:to|as|→|->)\s+([A-Za-z_]\w*)$/i.exec(t))
    || (m = /^(?:change|set|update)\s+(?:the\s+)?(?:variable(?:\s+name)?\s+(?:of|for)\s+)(.+?)\s+to\s+([A-Za-z_]\w*)$/i.exec(t))
    || (m = /^(?:change|set|update)\s+(.+?)['’]s\s+variable(?:\s+name)?\s+to\s+([A-Za-z_]\w*)$/i.exec(t))) {
    const q = questionOf(r, m[1], "variables", `Rename the variable of ${m[1]} to ${m[2]}.`, { loose: true });
    if (!q.ok) return q.out;
    return act(r, "variables", `Rename ${code(q.v)}'s variable ${q.v.variableName} to ${m[2]}; logic, calculations and piping that name it are rewritten, and the export column changes.`, [{ op: "update_question", target: code(q.v), variable: m[2] }], [...qDetected([q.v]), det("variable", `${q.v.variableName} → ${m[2]}`)]);
  }

  /* ---- question text (explicit wording only — anything to be written is the model's) */
  if ((m = /^(?:change|set|update|replace)\s+(?:the\s+)?(?:text|wording|question\s+text)\s+(?:of|for|on)\s+(.+?)\s+(?:to|with)\s*:?\s*["“](.+)["”]$/i.exec(t)) || (m = /^(?:change|set)\s+(.+?)['’]s\s+(?:text|wording)\s+to\s*:?\s*["“](.+)["”]$/i.exec(t)) || (m = /^(?:reword|rephrase|rewrite)\s+(.+?)\s+(?:to|as)\s*:?\s*["“](.+)["”]$/i.exec(t))) {
    const q = questionOf(r, m[1], "question_modification", `Change the wording of ${m[1]}.`);
    if (!q.ok) return q.out;
    return act(r, "question_modification", `Change the wording of ${code(q.v)} to “${plain(m[2], 80)}”.`, [{ op: "update_question", target: code(q.v), text: m[2] }], qDetected([q.v]));
  }

  /* ---- type change */
  {
    const conv = /^(?:change|convert|turn|switch)\s+(?:question\s+)?(.+?)\s+(?:to|into|in)\s+(?:an?\s+)?(.+?)$/i.exec(t);
    const make = /^make\s+(.+)$/i.exec(t);
    let hit: { ref: string; key: string; words: string } | null = null;
    if (conv) { const key = typeFromWords(conv[2]); if (key) hit = { ref: conv[1], key, words: conv[2] }; }
    if (!hit && make) {
      // "make the age question a slider": every split of the words into a name and a type, a resolving name first, then one that is at least ambiguous (to ask which)
      const ws = make[1].split(/\s+/);
      const splits = ws.map((_, k) => k).filter((k) => k > 0).map((k) => ({ ref: ws.slice(0, k).join(" "), words: ws.slice(k).join(" "), key: typeFromWords(ws.slice(k).join(" ").replace(/^(?:into\s+)?/i, "")) })).filter((x) => x.key);
      const named = splits.find((x) => resolveQuestionRef(def, x.ref, r.ctx).ok) ?? splits.find((x) => { const q = resolveQuestionRef(def, x.ref, r.ctx); return !q.ok && (q.ambiguous || CODE_SHAPE.test(x.ref)); });
      if (named) hit = { ref: named.ref, key: named.key!, words: named.words };
    }
    if (hit) {
      const q = questionOf(r, hit.ref, "question_modification", `Change ${hit.ref} to ${hit.words}.`);
      if (!q.ok) return q.out;
      const variant = variantForActionType(hit.key)!;
      if (q.v.variant === variant) return alreadySo("question_modification", `Change ${code(q.v)} to ${hit.words}.`, `${code(q.v)} is already a ${kindOf(q.v)} question.`, qDetected([q.v]));
      return act(r, "question_modification", `Change ${code(q.v)} from ${kindOf(q.v)} to ${variantName(variant)}; what the new type cannot hold is reported before it is applied.`, [{ op: "update_question", target: code(q.v), type: hit.key }], [...qDetected([q.v]), det("new type", variantName(variant))]);
    }
  }

  /* ---- duplicate */
  if ((m = /^(?:duplicate|copy|clone)\s+(?:question\s+)?(.+?)(?:\s+(?:and\s+(?:put|place)\s+(?:it|the\s+copy)\s+)?(?:after|below)\s+(.+))?$/i.exec(t))) {
    const q = questionOf(r, m[1], "question_modification", `Duplicate ${m[1]}.`, { loose: true });
    if (!q.ok) return q.out;
    let after: Question | undefined;
    if (m[2]) { const a = questionOf(r, m[2], "question_modification", `Duplicate ${code(q.v)} after ${m[2]}.`); if (!a.ok) return a.out; after = a.v; }
    return act(r, "question_modification", `Duplicate ${code(q.v)} (with its options and logic) ${after ? `and place the copy after ${code(after)}` : "right after it"}.`, [{ op: "duplicate_question", target: code(q.v), ...(after ? { after: code(after) } : {}) }], qDetected(after ? [q.v, after] : [q.v]));
  }

  /* ---- move */
  if ((m = /^move\s+(?:question\s+)?(.+?)\s+(after|below|before|above)\s+(.+)$/i.exec(t))) {
    const range = rangeOf(r, m[1], "question_modification", `Move ${m[1]} ${m[2]} ${m[3]}.`, {}, { loose: true });
    if (!range.ok) return range.out;
    const anchor = questionOf(r, m[3], "question_modification", `Move ${rangeLabel(def, range.v)} ${m[2]} ${m[3]}.`);
    if (!anchor.ok) return anchor.out;
    const qs = range.v;
    if (qs.some((q) => q.id === anchor.v.id)) return refused("question_modification", `Move ${rangeLabel(def, qs)} ${m[2]} ${code(anchor.v)}.`, `${code(anchor.v)} is one of the questions being moved.`, qDetected(qs));
    const after = /after|below/i.test(m[2]) ? anchor.v : questionBefore(def, anchor.v);
    if (!after) return refused("question_modification", `Move ${rangeLabel(def, qs)} before ${code(anchor.v)}.`, `${code(anchor.v)} is the first question, so there is no question to place ${qs.length === 1 ? "it" : "them"} after — move ${code(anchor.v)} after ${qs[qs.length - 1].code} instead.`, qDetected(qs));
    // a run moves in order: each after the previous one
    const actions: SurveyAction[] = qs.map((q, i) => ({ op: "move_question", target: code(q), after: i === 0 ? code(after.id === q.id ? anchor.v : after) : code(qs[i - 1]) }));
    return act(r, "question_modification", `Move ${rangeLabel(def, qs)} ${/after|below/i.test(m[2]) ? "after" : "before"} ${code(anchor.v)}; logic that would now read a later question is refused before it is applied.`, actions, qDetected([...qs, anchor.v]));
  }
  if ((m = /^move\s+(?:question\s+)?(.+?)\s+(?:to|into)\s+(?:the\s+)?(?:end\s+of\s+(?:the\s+)?)?(.+)$/i.exec(t))) {
    const b = blockOf(def, /\bblock\b|\bsection\b/i.test(m[2]) ? m[2] : `block ${m[2]}`);
    if (!b) return null;
    const range = rangeOf(r, m[1], "question_modification", `Move ${m[1]} to block “${b.title}”.`, {}, { loose: true });
    if (!range.ok) return range.out;
    return act(r, "question_modification", `Move ${rangeLabel(def, range.v)} to the end of block “${b.title}”.`, range.v.map((q): SurveyAction => ({ op: "move_question", target: code(q), block: blockRef(def, b) })), [...qDetected(range.v), det("block", b.title)]);
  }

  /* ---- delete */
  if ((m = /^(?:delete|remove|drop|get\s+rid\s+of)\s+(?:the\s+)?(?:questions?\s+(?=\S))?(.+)$/i.exec(t))) {
    const ref = /^question\s+\d/i.test(t.replace(/^(?:delete|remove|drop|get\s+rid\s+of)\s+(?:the\s+)?/i, "")) ? t.replace(/^(?:delete|remove|drop|get\s+rid\s+of)\s+(?:the\s+)?/i, "") : m[1];
    // "remove X from Q11" names something inside a question, not a question to delete
    if (/\s(?:from|in|of|on)\s/i.test(ref)) return null;
    const range = rangeOf(r, ref, "question_modification", `Delete ${unquote(ref)}.`, {}, { loose: true });
    if (!range.ok) return range.out;
    const qs = range.v;
    const rep = impactOf(def, { questions: qs.map((q) => q.id) }, { change: "delete", index: index(r) });
    return act(r, "question_modification", `Delete ${rangeLabel(def, qs)}${qs.length === 1 ? ` (“${plain(qs[0].text, 50)}”)` : ""}. ${rep.summary}.`, qs.map((q): SurveyAction => ({ op: "delete_question", target: code(q) })), [...qDetected(qs), ...rep.items.filter((i) => i.severity === "breaks").slice(0, 6).map((i) => det("breaks", impactPhrase(i)))]);
  }

  /* ---- create a question (explicit wording only) */
  if ((m = /^(?:add|create|insert|new|append)\s+(?:an?\s+|another\s+|one\s+more\s+)?(?:new\s+)?(.*?)\s*question\b(.*)$/i.exec(t))) {
    let typeWords = m[1].trim();
    let rest = m[2].trim();
    let req: boolean | undefined;
    if (/^required\s+/i.test(typeWords)) { req = true; typeWords = typeWords.replace(/^required\s+/i, ""); }
    let opts: string[] | undefined;
    const opt = /\s*(?:,\s*)?(?:with|having|offering)\s+(?:the\s+)?(?:options?|answers?|choices?|answer\s+options?)\s*[:=]?\s*(.+)$/i.exec(rest);
    if (opt) { opts = splitLabels(opt[1]); rest = rest.slice(0, opt.index).trim(); }
    const rq = /\s*,?\s*(?:\(|,\s*)?(required|mandatory|optional)\)?\s*$/i.exec(rest);
    if (rq) { req = !/optional/i.test(rq[1]); rest = rest.slice(0, rq.index).trim(); }
    let after: string | undefined;
    const posFront = /^(?:after|below|following)\s+(.+?)(?:\s*[:,-]\s*|\s+(?:asking|saying|that\s+says|with\s+(?:the\s+)?text|titled|reading)\s+)(.+)$/i.exec(rest);
    const pos = /\s*(?:,\s*)?(?:after|below|following|under)\s+([^"“”]+?)\s*$/i.exec(rest);
    let body = rest;
    if (posFront) { after = posFront[1]; body = posFront[2]; } else if (pos) { after = pos[1]; body = rest.slice(0, pos.index); }
    body = body.replace(/^(?:[:,-]\s*|(?:asking|saying|that\s+says|with\s+(?:the\s+)?text|titled|reading)\s+)/i, "").trim();
    const quoted = /^["“'‘](.+)["”'’]$/.exec(body)?.[1];
    const explicit = quoted ?? (/^[:]/.test(m[2].trim()) || posFront ? body : undefined);
    const typeKey = typeWords ? typeFromWords(typeWords) ?? (/^(?:single|multi|multiple)[\s-]/i.test(typeWords) ? null : null) : opts?.length ? "single_select" : null;
    const detected: Detected[] = [...(typeWords ? [det("type", typeWords)] : []), ...(after ? [det("after", after)] : [])];
    if (!explicit) return { kind: "model", category: "question_creation", reason: "the question's wording has to be written — the language model drafts it, then it is applied as create_question through the same gate", detected: [...detected, ...namedObjects(r)] };
    if (typeWords && !typeKey) return { kind: "model", category: "question_creation", reason: `“${typeWords}” is not a question type this layer knows — the language model picks the type`, detected };
    const key = typeKey ?? "single_select";
    if (/select|dropdown|ranking|matrix/.test(key) && !opts?.length) return { kind: "model", category: "question_creation", reason: "a choice question needs its options written — the language model drafts them", detected: [...detected, det("text", explicit)] };
    let afterQ: Question | undefined;
    if (after) { const a = questionOf(r, after, "question_creation", `Add a question after ${after}.`); if (!a.ok) return a.out; afterQ = a.v; }
    const action: SurveyAction = { op: "create_question", type: key, text: explicit, ...(opts?.length ? { options: opts.map(specFor) } : {}), ...(afterQ ? { after: code(afterQ) } : {}), ...(req !== undefined ? { required: req } : {}) };
    return act(r, "question_creation", `Add a ${variantName(variantForActionType(key)!)} question “${plain(explicit, 60)}”${opts?.length ? ` with options ${opts.map((o) => `“${o}”`).join(", ")}` : ""}${afterQ ? ` after ${code(afterQ)}` : " at the end of the last block"}${req ? ", required" : ""}.`, [action], [...detected, det("text", plain(explicit, 60))]);
  }
  return null;
};

/* ---------------------------------------------------------- everything else: the model */

const CATEGORY_WORDS: [RegExp, IntentCategory][] = [
  [/\b(?:create|build|generate|write|draft|design|make)\s+(?:me\s+)?(?:an?\s+|the\s+)?(?:new\s+)?(?:\w+\s+)?(?:survey|questionnaire|screener)\b/i, "survey_creation"],
  [/\breport(?:ing)?\b|\bexecutive\s+summary\b|\bdeck\b|\boutline\b/i, "reporting"],
  [/\bfind(?:ings)?\b|\binsights?\b|\bdifferences?\s+between\b|\bkey\s+(?:drivers|results)\b|\bwhat\s+do\s+the\s+(?:data|results)\b|\bcompare\s+.+\s+respondents\b/i, "findings"],
  [/\bhypothes[ie]s\b|\bresearch\s+(?:design|objectives?|questions?)\b|\bconstructs?\b|\bmethodology\b/i, "research_design"],
  [/\btranslat/i, "translation"],
  [/\b(?:chart|graph|visuali[sz]|dashboard|plot)\b/i, "visualization"],
  [/\b(?:export|download|spss|csv|excel|sav\b|codebook|datamap)\b/i, "export"],
  [/\b(?:clean|speeders?|straight-?lin|outliers?|duplicates?\s+respon|bad\s+data|weight(?:ing)?)\b/i, "data_cleaning"],
  [/\b(?:review|quality|check\s+the\s+survey|lint|best\s+practice|errors?\s+in)\b/i, "quality_control"],
  [/\b(?:theme|style|colou?rs?|fonts?|animation|look\s+and\s+feel|layout|branding|logo|progress\s+bar|mobile|css)\b/i, "survey_editing"],
  [/\b(?:reword|rephrase|rewrite|clearer|friendlier|simpler|shorter|wording|tone|neutral|leading|plain\s+language)\b/i, "question_modification"],
  [/\b(?:add|create|insert)\s+(?:an?\s+)?(?:\w+\s+)?question\b/i, "question_creation"],
  [/\b(?:options?|answers?|choices?)\b/i, "option_modification"],
  [/\b(?:skip|display|show|hide|logic|branch|condition)\b/i, "logic"],
  [/\b(?:randomi[sz]|rotate|shuffle)\b/i, "randomization"],
  [/\bmask|carry\s+forward\b/i, "masking"],
  [/\bvalidat|\bmust\s+be\b|\bat\s+least\b|\bat\s+most\b/i, "validation"],
  [/\b(?:calculat|compute|formula)\b/i, "calculations"],
  [/\b(?:variable|embedded|recode)\b/i, "variables"],
  [/\b(?:analy[sz]|crosstab|regression|correlation|significan|segment)\b/i, "analysis"],
  [/\b(?:depend|uses?\b|references?)\b/i, "dependency_analysis"],
  [/\b(?:break|impact|safe\s+to)\b/i, "impact_analysis"],
  [/\b(?:why|broken|not\s+working|bug|wrong)\b/i, "debugging"],
];
const MODEL_REASONS: Partial<Record<IntentCategory, string>> = {
  survey_creation: "a survey generated from a brief is written by the language model, then applied as actions through the same gate",
  research_design: "research design — hypotheses, constructs, objectives — is the language model's to propose; the engine records it",
  findings: "narrative findings are written by the language model from the results; the engine supplies the tables",
  reporting: "a report structure is written by the language model from the research objectives and the analysis plan",
  question_modification: "rewording a question is writing — the language model drafts it, and the change is applied through the same gate",
  survey_editing: "look-and-feel changes are composed by the language model as style, theme and behaviour actions",
  translation: "translated text is written by the language model or a translation provider",
  visualization: "charts are built in the analytics workspace; the model can propose which",
};

/** the model's turn, with a category guessed from the words and everything the sentence named */
function fallback(r: Run): Interpretation {
  const category = CATEGORY_WORDS.find(([re]) => re.test(r.text))?.[1] ?? null;
  const reason = (category && MODEL_REASONS[category]) ?? "this layer does not parse that phrasing — the language model interprets it, and any change it proposes goes through the same action gate";
  return { kind: "model", category, reason, detected: namedObjects(r) };
}

/* ============================================================ the interpreter */

/*
 * The order is the order of specificity. Questions about the survey come
 * before edits (a question can contain an edit verb: "what breaks if I
 * delete Q15"); the Studio's own grammar gets its sentences next; a long
 * research brief goes to the model before any edit pattern can catch a verb
 * inside it; and among edits, the ones with the most distinctive words come
 * first — masking before display ("show only the options selected in Q5 at
 * Q10" starts like display logic), an option's visibility before a
 * question's, options before questions ("remove option Canada from Q11"
 * before "remove Q11"), skips before display ("if Q7 is no, skip …").
 */
const RECOGNISERS: Recogniser[] = [
  analysisWhy, impact, dependents, dependencies, untranslated, hypothesesQuery, analysisQuery, measures,
  deferred, longBrief,
  surveySettings, languages, research, variables, pageBreaks,
  masking, optionVisibility, randomization, options, required, skips, display, validation, questions,
];

function interpret(r: Run): Interpretation {
  if (!r.text) return { kind: "clarify", category: "survey_editing", understood: "Nothing was asked.", question: "What would you like to change, or to know about this survey?", choices: ["Make Q1 required", "What depends on Q1?", "Which questions are untranslated?"].map((text) => ({ label: text, text })), detected: [] };
  for (const rec of RECOGNISERS) {
    const out = rec(r);
    if (out) return out;
  }
  return fallback(r);
}

/**
 * Read a sentence against the survey: the edits it asks for (validated by
 * applying them to a copy), the answer the survey gives to it, a clarifying
 * question, a precise refusal, or — for what only the language model can do —
 * a hand-off with everything detected so far. Never throws.
 */
export function interpretRequest(def: SurveyDefinition, text: string, ctx: InterpretContext = {}): Interpretation {
  const clean = String(text ?? "").trim().replace(/\s+/g, " ").replace(/[.!?]+$/, "").trim();
  try {
    const parts = splitCommands(clean);
    return parts.length > 1 ? compound(def, clean, parts, ctx) : interpret({ def, text: clean, ctx, depth: 0 });
  } catch (e) {
    return { kind: "model", category: null, reason: `the interpreter could not read this (${(e as Error).message}) — the language model takes it`, detected: [] };
  }
}

/*
 * MORE THAN ONE INSTRUCTION IN A SENTENCE. "Remove the trust block and make
 * the platforms question optional" is two edits; read as one, a recogniser
 * took "trust block and make the platforms question optional" for the
 * block's name and refused it. A clause starts where "and", "then", a comma
 * or a full stop is followed by a command verb — so "when Q1 > 18 and Q3 = 1"
 * is never split. Each clause is read against the survey as the clauses
 * before it leave it ("add a question … and make it required"); the whole is
 * deterministic only if every clause is, and the combined actions pass one
 * dry run together. A clause the engine hands on hands the whole sentence on.
 */
// "go" and "jump" continue a skip ("skip Q8 to Q9 and go to Q10"); a verb on "it" / "them" continues the clause before ("… and set it to India")
const COMMAND_VERB = String.raw`(?:make|set|mark|delete|remove|drop|add|create|insert|show|hide|display|ask|skip|terminate|screen|rename|call|move|put|place|randomi[sz]e|shuffle|mask|carry|change|convert|turn|duplicate|copy|recode|sort|reorder|order|require|limit|restrict|translate|reword|rephrase|rewrite|plan|record|clear|unmask|stop)`;
const SPLIT_RE = new RegExp(String.raw`\s*(?:[.;]\s+|,\s*(?:and\s+|then\s+)?|\s+and\s+(?:then\s+)?|\s+then\s+)(?=${COMMAND_VERB}\b(?!\s+(?:it|them|this|that|these|those)\b))`, "i");

export function splitCommands(text: string): string[] {
  const parts = text.split(SPLIT_RE).map((x) => x.trim().replace(/[.;,]+$/, "")).filter(Boolean);
  // a leading clause that is only a condition ("if Q7 is No, skip …") belongs to the clause right after it, not to the rest
  if (parts.length > 1 && /^(?:if|when|unless|after|for)\b/i.test(parts[0]) && !new RegExp(String.raw`\b${COMMAND_VERB}\b`, "i").test(parts[0].replace(/^(?:if|when|unless|after|for)\b/i, ""))) {
    return [`${parts[0]}, ${parts[1]}`, ...parts.slice(2)];
  }
  return parts;
}

function compound(def: SurveyDefinition, text: string, parts: string[], ctx: InterpretContext): Interpretation {
  const actions: SurveyAction[] = [];
  const detected: Detected[] = [];
  const understood: string[] = [];
  /* clauses the survey already satisfies: left out, and said */
  const noops: Extract<Interpretation, { kind: "refused" }>[] = [];
  let category: IntentCategory | null = null;
  let current = def;
  /* the first clause the engine cannot carry out — returned only if no LATER clause is the model's (which takes the whole sentence) */
  let stop: Interpretation | null = null;
  for (const part of parts) {
    const it = interpret({ def: current, text: part, ctx, depth: 0 });
    if (it.kind === "model") return { kind: "model", category: it.category ?? category, reason: `“${part}” is for the language model, so the whole request goes to it (${it.reason})`, detected: [...detected, ...it.detected] };
    if (stop) continue;
    if (it.kind === "refused" && it.noop) { noops.push(it); category ??= it.category; continue; }
    if (it.kind === "clarify") { stop = { ...it, understood: `In “${part}”: ${it.understood}`, choices: it.choices.map((c) => ({ label: c.label, text: text.replace(part, c.text) })) }; continue; }
    if (it.kind === "refused") { stop = { ...it, understood: `In “${part}”: ${it.understood}`, reason: `${it.reason} Nothing else in the request was applied.`, ...(it.suggestion ? { suggestion: { text: text.replace(part, it.suggestion.text) } } : {}) }; continue; }
    if (it.kind === "answer") { stop = { kind: "model", category: it.category, reason: "a question and an edit in one sentence — the language model takes the whole request", detected }; continue; }
    category ??= it.category;
    actions.push(...it.actions);
    detected.push(...it.detected);
    understood.push(it.understood.replace(/\.$/, ""));
    current = applySurveyActions(current, it.actions).def;
  }
  if (stop) return stop;
  // every clause was already so: one "nothing to change", with each reason
  if (!actions.length) return { ...noops[0], understood: noops.map((n) => n.understood.replace(/\.$/, "")).join("; ") + ".", reason: noops.map((n) => n.reason).join(" "), detected: noops.flatMap((n) => n.detected) };
  const out = act({ def, text, ctx, depth: 0 }, category ?? "survey_editing", `${understood.join("; then ")}.${noops.length ? ` Left as it is: ${noops.map((n) => n.reason.replace(/\.$/, "")).join("; ")}.` : ""}`, actions, detected);
  return out.kind === "actions" && noops.length ? { ...out, warnings: [...noops.map((n) => n.reason), ...(out.warnings ?? [])] } : out;
}

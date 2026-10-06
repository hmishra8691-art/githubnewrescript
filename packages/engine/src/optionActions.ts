import type { Condition, EmbeddedDataType, FlowNode, Option, OptionMask, Question, SetExpr, SurveyDefinition } from "@rescript/schema";
import { hypothesisLabel } from "@rescript/schema";
import type { IdMinter } from "./questionOps.js";
import { duplicateQuestion, moveQuestionTo } from "./questionOps.js";
import { forEachRuleInSurvey } from "./conditionWalk.js";
import { describeOptions, normalizeOptionText, resolveOptionValue, type OptionList } from "./optionCodes.js";
import { questionOrder } from "./dependencies.js";
import { formatCondition } from "./logicExpression.js";
import { formatSetExpression, parseSetExpression, setExprSources } from "./setExpression.js";
import { maskSummary } from "./logicProposal.js";
import { pagePositionOf } from "./pageBreaks.js";
import { embeddedFieldNames } from "./structureOps.js";
import { usedNames } from "./variableUsage.js";
import { stripHtmlText } from "./html.js";
import { K, moveTranslationKey } from "./localization.js";

/**
 * THE OPTION, ORDER AND HOUSEKEEPING ACTIONS (Intelligent Mode Phase 2) —
 * the edits a programmer makes a hundred times a day that the copilot could
 * not: "make option 4 exclusive", "recode United States from 2 to 5", "put
 * the options in alphabetical order", "randomize, keep None last", "show at
 * Q7 only the brands selected at Q5", "duplicate Q7", "rename the survey",
 * "rename the embedded variable country", "drop hypothesis 2", "add this CSS
 * to Q3".
 *
 * Like the survey, UX, analysis, localization and quota actions: a closed
 * vocabulary, a gate that reads the model's JSON into typed actions or
 * refuses them with a reason, and an apply step that resolves every target
 * against the real survey — an option by id, code, label or position, a
 * question through the batch's own resolver, every condition through the
 * expression gate, every SET expression through the mask parser — and
 * refuses what would break a respondent's experience or the data.
 *
 * Two of these rewrite the survey beyond their target and say so as
 * DESTRUCTIVE, because the thing they change is a JOIN KEY that other places
 * hold by value: recoding an option rewrites every condition anywhere that
 * compares that question with the old code (a quota cell among them — a cell
 * that kept comparing with 2 after the option became 5 would silently never
 * fill); renaming an embedded variable rewrites every condition and pipe
 * that reads it by name. The rest are plain edits, described exactly.
 */

/* ------------------------------------------------------------ vocabulary */

import type { CondInput } from "./surveyActions.js";
/** an option as the model names it: its id, its code, its (normalised) label, "option 3" / "#3", or its 1-based position */
export type OptionRef = string | number;
export type OptionPosition = number | { before: OptionRef } | { after: OptionRef };
export type MaskDimension = "options" | "rows" | "columns";
export type EmbeddedSource = "url" | "static" | "panel" | "expression";

export type OptionAction =
  | { op: "update_option"; target: string; option: OptionRef; label?: string; code?: string | number; value?: string | number | null; exclusive?: boolean; other?: boolean; anchor?: "top" | "bottom" | "none"; visibleIf?: CondInput | null; position?: OptionPosition }
  | { op: "reorder_options"; target: string; order?: OptionRef[]; sort?: "alphabetical" | "alphabetical_desc" | "numeric" | "reverse" }
  | { op: "set_option_randomization"; target: string; enabled: boolean; anchors?: OptionRef[]; keepLast?: OptionRef[]; keepFirst?: OptionRef[]; pick?: number; scope?: MaskDimension }
  | { op: "set_mask"; target: string; expression: string; action?: OptionMask["action"]; dimension?: MaskDimension }
  | { op: "clear_mask"; target: string; dimension?: MaskDimension }
  | { op: "duplicate_question"; target: string; after?: string }
  | { op: "set_survey_settings"; title?: string; description?: string | null; code?: string }
  | { op: "update_embedded"; name: string; newName?: string; source?: EmbeddedSource; value?: string | null; dataType?: EmbeddedDataType }
  | { op: "remove_embedded"; name: string; force?: boolean }
  | { op: "add_hypothesis"; text: string }
  | { op: "remove_hypothesis"; hypothesis: string | number }
  | { op: "set_custom_code"; target: string; js?: string | null; css?: string | null };

export const OPTION_ACTION_OPS = [
  "update_option", "reorder_options", "set_option_randomization", "set_mask", "clear_mask", "duplicate_question",
  "set_survey_settings", "update_embedded", "remove_embedded", "add_hypothesis", "remove_hypothesis", "set_custom_code",
] as const;
const OPS = new Set<string>(OPTION_ACTION_OPS);
export const isOptionOp = (op: string): boolean => OPS.has(op);

/* ------------------------------------------------------------ the gate */

const str = (v: unknown, max = 200): string | undefined => (typeof v === "string" && v.trim() ? v.trim().slice(0, max) : undefined);
const num = (v: unknown): number | undefined => (typeof v === "number" && Number.isFinite(v) ? v : typeof v === "string" && v.trim() && Number.isFinite(Number(v)) ? Number(v) : undefined);
const bool = (v: unknown): boolean | undefined => (typeof v === "boolean" ? v : undefined);
/** an option reference: a finite number as it is, a string trimmed */
const ref = (v: unknown): OptionRef | undefined => (typeof v === "number" && Number.isFinite(v) ? v : str(v, 300));
const refs = (v: unknown, max = 200): OptionRef[] | undefined => (Array.isArray(v) ? v.map(ref).filter((x): x is OptionRef => x !== undefined).slice(0, max) : v !== undefined && v !== null && ref(v) !== undefined ? [ref(v)!] : undefined);
const cond = (v: unknown): CondInput | undefined => (typeof v === "string" && v.trim() ? v.trim() : v && typeof v === "object" && !Array.isArray(v) ? (JSON.parse(JSON.stringify(v)) as Condition) : undefined);
/** a code block: kept as written (whitespace is meaning in code), bounded; an empty string reads as "remove it" */
const code = (v: unknown, max = 20000): string | null | undefined => (v === null ? null : typeof v === "string" ? (v.trim() ? v.slice(0, max) : null) : undefined);

const DIMENSIONS = new Set<string>(["options", "rows", "columns"]);
const MASK_ACTIONS = new Set<string>(["display", "preselect", "display_and_preselect", "disable", "remove"]);
const SORTS: Record<string, Extract<OptionAction, { op: "reorder_options" }>["sort"]> = {
  alphabetical: "alphabetical", alpha: "alphabetical", a_z: "alphabetical", az: "alphabetical", asc: "alphabetical", label: "alphabetical",
  alphabetical_desc: "alphabetical_desc", z_a: "alphabetical_desc", za: "alphabetical_desc", desc: "alphabetical_desc", reverse_alphabetical: "alphabetical_desc",
  numeric: "numeric", code: "numeric", by_code: "numeric", codes: "numeric",
  reverse: "reverse", reversed: "reverse", flip: "reverse",
};
const EMBEDDED_SOURCES = new Set<string>(["url", "static", "panel", "expression"]);
const EMBEDDED_TYPES = new Set<string>(["string", "integer", "decimal", "boolean", "date", "datetime"]);
const NAME_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;
/** the first of several spellings of a field that was given — `??` would read an explicit null as "not given", and null is exactly how the model says "remove it" */
const first = (o: Record<string, unknown>, ...keys: string[]): unknown => keys.map((k) => o[k]).find((v) => v !== undefined);

/** the gate: a well-formed action, a reason it is refused, or null when `op` is not an option action */
export function coerceOptionAction(op: string, o: Record<string, unknown>): OptionAction | string | null {
  if (!isOptionOp(op)) return null;
  switch (op) {
    case "update_option": {
      const target = str(o.target ?? o.question, 120), option = ref(o.option);
      if (!target || option === undefined) return "update_option needs target and option";
      const a: Extract<OptionAction, { op: "update_option" }> = { op, target, option };
      const label = str(o.label ?? o.newLabel ?? o.text, 300); if (label) a.label = label;
      const newCode = ref(o.code ?? o.newCode); if (newCode !== undefined) a.code = typeof newCode === "string" ? newCode.slice(0, 80) : newCode;
      if (o.value === null) a.value = null; else if (ref(o.value) !== undefined) a.value = ref(o.value);
      if (bool(o.exclusive) !== undefined) a.exclusive = bool(o.exclusive);
      if (bool(o.other ?? o.otherSpecify) !== undefined) a.other = bool(o.other ?? o.otherSpecify);
      const anchorRaw = o.anchor ?? o.anchored;
      if (anchorRaw !== undefined && anchorRaw !== null) {
        const k = typeof anchorRaw === "boolean" ? (anchorRaw ? "bottom" : "none") : str(anchorRaw)?.toLowerCase().replace(/^(?:last|end)$/, "bottom").replace(/^(?:first|start)$/, "top").replace(/^(?:no|off|false)$/, "none");
        if (k !== "top" && k !== "bottom" && k !== "none") return `anchor is top, bottom or none — not “${String(anchorRaw)}”`;
        a.anchor = k;
      }
      const vi = first(o, "visibleIf", "showWhen", "when");
      if (vi === null) a.visibleIf = null; else if (vi !== undefined) { const c = cond(vi); if (!c) return "visibleIf is expression text or a condition (or null to remove it)"; a.visibleIf = c; }
      const pos = o.position ?? o.moveTo;
      if (pos !== undefined && pos !== null) {
        const n = num(pos);
        if (n !== undefined) { if (!Number.isInteger(n) || n < 1) return "position is a 1-based option number"; a.position = n; }
        else if (pos && typeof pos === "object") {
          const p = pos as Record<string, unknown>;
          if (ref(p.before) !== undefined) a.position = { before: ref(p.before)! };
          else if (ref(p.after) !== undefined) a.position = { after: ref(p.after)! };
          else return "position is a number (1-based) or { before: option } / { after: option }";
        } else return "position is a number (1-based) or { before: option } / { after: option }";
      }
      if (Object.keys(a).length <= 3) return "update_option changes nothing";
      return a;
    }
    case "reorder_options": {
      const target = str(o.target ?? o.question, 120); if (!target) return "reorder_options needs a target";
      const order = refs(o.order ?? o.options);
      const sortRaw = str(o.sort ?? o.by);
      const sort = sortRaw ? SORTS[sortRaw.toLowerCase().replace(/[\s-]+/g, "_")] : undefined;
      if (sortRaw && !sort) return `“${sortRaw}” is not an order the options can take (alphabetical, alphabetical_desc, numeric, reverse)`;
      if (!order?.length && !sort) return "reorder_options needs order (the options, first to last) or sort (alphabetical, alphabetical_desc, numeric, reverse)";
      return { op, target, ...(order?.length ? { order } : {}), ...(sort ? { sort } : {}) };
    }
    case "set_option_randomization": {
      const target = str(o.target ?? o.question, 120); if (!target) return "set_option_randomization needs a target";
      const enabled = bool(o.enabled ?? o.randomize ?? o.randomized) ?? true;
      const pick = num(o.pick ?? o.show ?? o.showOnly);
      if (pick !== undefined && (!Number.isInteger(pick) || pick < 1)) return "pick is a whole number of options to show";
      const scope = str(o.scope ?? o.axis)?.toLowerCase();
      if (scope && !DIMENSIONS.has(scope)) return "scope is options, rows or columns";
      const anchors = refs(o.anchors ?? o.anchor ?? o.pin), keepLast = refs(o.keepLast ?? o.anchorBottom ?? o.last), keepFirst = refs(o.keepFirst ?? o.anchorTop ?? o.first);
      return { op, target, enabled, ...(anchors?.length ? { anchors } : {}), ...(keepLast?.length ? { keepLast } : {}), ...(keepFirst?.length ? { keepFirst } : {}), ...(pick !== undefined ? { pick } : {}), ...(scope ? { scope: scope as MaskDimension } : {}) };
    }
    case "set_mask": {
      const target = str(o.target ?? o.question, 120), expression = str(o.expression ?? o.mask ?? o.set ?? o.source, 2000);
      if (!target || !expression) return "set_mask needs target and expression (a SET expression such as “Q5.Selected” or “Q5.Selected EXCEPT Q6.Selected”)";
      const action = str(o.action)?.toLowerCase().replace(/[\s-]+/g, "_");
      if (action && !MASK_ACTIONS.has(action)) return `“${action}” is not something a mask can do (display, preselect, display_and_preselect, disable, remove)`;
      const dimension = str(o.dimension ?? o.axis)?.toLowerCase();
      if (dimension && !DIMENSIONS.has(dimension)) return "dimension is options, rows or columns";
      return { op, target, expression, ...(action ? { action: action as OptionMask["action"] } : {}), ...(dimension ? { dimension: dimension as MaskDimension } : {}) };
    }
    case "clear_mask": {
      const target = str(o.target ?? o.question, 120); if (!target) return "clear_mask needs a target";
      const dimension = str(o.dimension ?? o.axis)?.toLowerCase();
      if (dimension && !DIMENSIONS.has(dimension)) return "dimension is options, rows or columns";
      return { op, target, ...(dimension ? { dimension: dimension as MaskDimension } : {}) };
    }
    case "duplicate_question": {
      const target = str(o.target ?? o.question, 120); if (!target) return "duplicate_question needs a target";
      return { op, target, ...(str(o.after, 120) ? { after: str(o.after, 120) } : {}) };
    }
    case "set_survey_settings": {
      if (typeof o.title === "string" && !o.title.trim()) return "the survey title cannot be empty";
      const a: Extract<OptionAction, { op: "set_survey_settings" }> = { op };
      const title = str(o.title ?? o.name, 300); if (title) a.title = title;
      if (o.description === null || (typeof o.description === "string" && !o.description.trim())) a.description = null; else if (str(o.description, 4000)) a.description = str(o.description, 4000);
      const sc = str(o.code ?? o.surveyCode, 60); if (sc) a.code = sc;
      if (Object.keys(a).length <= 1) return "set_survey_settings changes nothing (title, description, code)";
      return a;
    }
    case "update_embedded": {
      const name = str(o.name ?? o.target ?? o.variable, 80); if (!name) return "update_embedded needs the embedded variable's name";
      const a: Extract<OptionAction, { op: "update_embedded" }> = { op, name };
      const newName = str(o.newName ?? o.rename ?? o.to, 80); if (newName) a.newName = newName;
      const source = str(o.source)?.toLowerCase(); if (source) { if (!EMBEDDED_SOURCES.has(source)) return "source is url, static, panel or expression"; a.source = source as EmbeddedSource; }
      if (o.value === null) a.value = null; else if (typeof o.value === "string" || typeof o.value === "number") a.value = String(o.value).trim().slice(0, 2000);
      const dt = str(o.dataType ?? o.type)?.toLowerCase(); if (dt) { if (!EMBEDDED_TYPES.has(dt)) return `“${dt}” is not an embedded data type (string, integer, decimal, boolean, date, datetime)`; a.dataType = dt as EmbeddedDataType; }
      if (Object.keys(a).length <= 2) return "update_embedded changes nothing";
      return a;
    }
    case "remove_embedded": {
      const name = str(o.name ?? o.target ?? o.variable, 80); if (!name) return "remove_embedded needs the embedded variable's name";
      return { op, name, ...(o.force === true ? { force: true } : {}) };
    }
    case "add_hypothesis": {
      const text = str(o.text ?? o.hypothesis, 1000); if (!text) return "add_hypothesis needs the hypothesis text";
      return { op, text };
    }
    case "remove_hypothesis": {
      const hypothesis = ref(o.hypothesis ?? o.text ?? o.label ?? o.index ?? o.target);
      if (hypothesis === undefined) return "remove_hypothesis needs the hypothesis (its text, its label such as H2, or its number)";
      return { op, hypothesis };
    }
    case "set_custom_code": {
      const target = str(o.target ?? o.question, 120); if (!target) return "set_custom_code needs a target";
      const js = code(first(o, "js", "javascript", "customJs")), css = code(first(o, "css", "customCss"));
      if (js === undefined && css === undefined) return "set_custom_code needs js or css (null removes it)";
      return { op, target, ...(js !== undefined ? { js } : {}), ...(css !== undefined ? { css } : {}) };
    }
  }
  return null;
}

/* ------------------------------------------------------------ applying */

export interface OptionEnv {
  /** a question by batch ref, code, variable or id — the batch's own resolver */
  question(ref: string): Question | undefined;
  /** a condition through the survey's gate (the parser, option-code canonicalisation); throws on a bad one */
  condition(input: CondInput): Condition;
  /** a SET expression through the caller's gate (batch refs resolved); absent → parsed here against the definition */
  setExpression?(text: string): SetExpr;
  ids: IdMinter;
  now: string;
}
export interface OptionApplied { description: string; destructive?: string; warnings: string[]; touched: string[] }

class ActionError extends Error {}
const fail = (m: string): never => { throw new ActionError(m); };
const plural = (n: number, w: string) => `${n} ${w}${n === 1 ? "" : "s"}`;
const plain = (s: string | undefined, n = 40): string => { const t = stripHtmlText(s ?? "").replace(/\s+/g, " ").trim(); return t.length > n ? `${t.slice(0, n - 1)}…` : t; };
const questionOrFail = (env: OptionEnv, ref: string): Question => env.question(ref) ?? fail(`there is no question “${ref}”`);

type Flag = Option["flags"][number];
/** an option, a row or a column — anything with a label, usually a code, and flags */
interface Item { id?: string; code?: string | number; label: string; flags?: Flag[] }

/* ------------------------------------------------------------ resolving an option */

/**
 * An option as the model (or a person) names it: its id, its code (exactly,
 * or quoted / emphasised), its label (markup, case and spacing ignored, when
 * only one option has it), "option 3" / "#3" (by code, else by position), or
 * a bare number (by code, else the 3rd option). Anything else is a reason
 * that lists the options, so the next attempt can name one.
 */
export function resolveItem<T extends Item>(items: T[], ref: OptionRef, what = "option"): T | string {
  const raw = String(ref).trim();
  const byId = items.find((o) => o.id !== undefined && o.id === raw);
  if (byId) return byId;
  const list = items.map((o, i) => ({ code: o.code ?? o.id ?? i + 1, label: o.label, flags: o.flags })) as OptionList;
  const r = resolveOptionValue(list, raw);
  if (r.kind === "code") { const hit = items.find((o, i) => String(o.code ?? o.id ?? i + 1) === String(r.code)); if (hit) return hit; }
  // a bare number nothing has as a code: the Nth option
  if (/^\d+$/.test(raw) && items[Number(raw) - 1]) return items[Number(raw) - 1];
  // a label that is a unique prefix / contains match, once nothing exact fits ("United" for "United States")
  const bare = normalizeOptionText(raw);
  const loose = bare.length >= 3 ? items.filter((o) => normalizeOptionText(o.label).includes(bare)) : [];
  if (loose.length === 1) return loose[0];
  return `there is no ${what} “${raw}”${loose.length > 1 ? ` — ${loose.length} ${what}s match it (${loose.map((o) => `“${plain(o.label)}”`).join(", ")})` : ` — the ${what}s are ${describeOptions(list)}`}`;
}

/** `resolveItem` over a question's options: the Option, or a reason naming the question and listing its options */
export function resolveOption(q: Question, ref: OptionRef): Option | string {
  const options = (q.options ?? []) as Option[];
  if (!options.length) return `${q.code} has no options`;
  const r = resolveItem(options, ref);
  return typeof r === "string" ? `${q.code}: ${r}` : r;
}
const optionOrFail = (q: Question, ref: OptionRef): Option => { const r = resolveOption(q, ref); return typeof r === "string" ? fail(r) : r; };

const hasFlag = (o: Item, f: Flag) => !!o.flags?.includes(f);
const setFlag = (o: Item, f: Flag, on: boolean): void => { const flags = (o.flags ?? []).filter((x) => x !== f); o.flags = on ? [...flags, f] : flags; };

/* ------------------------------------------------------------ recoding */

/** does a condition source name this question — by id, code or variable, as the parser and the runtime both accept */
const readsQuestion = (src: { kind?: string; ref?: string } | undefined, q: Question): boolean =>
  !!src && (src.kind === "question" || src.kind === "variable") && (src.ref === q.id || src.ref === String(q.code) || src.ref === q.variableName);
const sameCode = (v: unknown, c: string | number): boolean => (typeof v === "string" || typeof v === "number") && String(v) === String(c);

/**
 * Every rule anywhere in the definition that compares this question's answer
 * with `from` now compares it with `to` — display and skip logic, quota cells,
 * branches, validation, punches, masks' `when`, and a COUNT `where` over this
 * question's options. Ranking rules compare a code (value) and a rank
 * (value2), so only the code side is touched. Returns how many CONDITIONS
 * (roots, not rules) changed.
 */
function recodeConditions(def: SurveyDefinition, q: Question, from: string | number, to: string | number): number {
  const changed = new Set<string>();
  forEachRuleInSurvey(def, (rule, loc, at) => {
    const ofQ = readsQuestion(rule.source as { kind?: string; ref?: string }, q)
      || (at.inCountWhere && rule.source?.kind === "option" && (rule.source.ref ?? "code") === "code" && readsQuestion(at.countOwner?.source as { kind?: string; ref?: string }, q));
    if (!ofQ) return;
    const r = rule as { value?: unknown; value2?: unknown; operator: string };
    let hit = false;
    const fix = (v: unknown): unknown => {
      if (Array.isArray(v)) return v.map(fix);
      if (sameCode(v, from)) { hit = true; return to; }
      return v;
    };
    r.value = fix(r.value);
    if (r.value2 !== undefined && !String(r.operator).startsWith("rank")) r.value2 = fix(r.value2);
    if (hit) changed.add(loc.path);
  });
  return changed.size;
}

/** the question's own code lists that name the option: punch rules coding it, randomization groups holding it */
function recodeOwnLists(q: Question, from: string | number, to: string | number): void {
  for (const p of (q.punches ?? []) as { source?: { kind?: string; codes?: (string | number)[] } }[]) if (p.source?.kind === "codes" && p.source.codes) p.source.codes = p.source.codes.map((c) => (sameCode(c, from) ? to : c));
  if (q.randomization?.groups) q.randomization.groups = q.randomization.groups.map((g) => g.map((c) => (sameCode(c, from) ? to : c)));
}

/* ------------------------------------------------------------ embedded variables */

type EmbeddedNode = Extract<FlowNode, { type: "embedded_data" }>;
type EmbeddedField = EmbeddedNode["fields"][number];

/** every embedded-data node, at any depth of the flow */
function embeddedNodes(def: SurveyDefinition): EmbeddedNode[] {
  const out: EmbeddedNode[] = [];
  const walk = (nodes: FlowNode[]): void => {
    for (const n of nodes) {
      if (n.type === "embedded_data") out.push(n);
      const k = n as { children?: FlowNode[]; branches?: { children: FlowNode[] }[]; otherwise?: FlowNode[] };
      for (const list of [k.children, ...(k.branches ?? []).map((b) => b.children), k.otherwise]) if (list) walk(list);
    }
  };
  walk(def.flow as FlowNode[]);
  return out;
}
function findEmbedded(def: SurveyDefinition, name: string): { node: EmbeddedNode; field: EmbeddedField } | undefined {
  const nodes = embeddedNodes(def);
  for (const exact of [true, false]) for (const node of nodes) {
    const field = node.fields.find((f) => (exact ? f.name === name : f.name.toLowerCase() === name.toLowerCase()));
    if (field) return { node, field };
  }
  return undefined;
}

/** `{{NAME…}}` and `{{ed.NAME…}}` at the head of a pipe token — the property, row and modifiers after it are left exactly as written */
const pipeHead = (name: string) => new RegExp(`(\\{\\{\\s*(?:ed\\.)?)${name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?=[\\s.|\\[}])`, "g");

/** every string in the questions and the flow that pipes `name`, rewritten by `fn`; returns how many strings held one */
function rewritePipes(def: SurveyDefinition, name: string, fn: (s: string) => string): number {
  let n = 0;
  const re = pipeHead(name);
  const walk = (node: unknown): void => {
    if (!node || typeof node !== "object") return;
    if (Array.isArray(node)) { node.forEach(walk); return; }
    const o = node as Record<string, unknown>;
    for (const [k, v] of Object.entries(o)) {
      if (typeof v === "string") { if (v.includes("{{") && (re.lastIndex = 0, re.test(v))) { o[k] = fn(v); n++; } continue; }
      walk(v);
    }
  };
  walk(def.questions); walk(def.flow);
  return n;
}
/** what reads an embedded variable: the conditions (where they sit) and the number of texts that pipe it */
function embeddedReads(def: SurveyDefinition, name: string): { conditions: string[]; pipes: number } {
  const where = new Map<string, string>();
  forEachRuleInSurvey(def, (rule, loc) => { const s = rule.source as { kind?: string; ref?: string }; if ((s.kind === "embedded" || s.kind === "variable") && s.ref === name) where.set(loc.path, loc.where); });
  let pipes = 0;
  const re = pipeHead(name);
  const walk = (node: unknown): void => { if (!node || typeof node !== "object") return; if (Array.isArray(node)) { node.forEach(walk); return; } for (const v of Object.values(node as Record<string, unknown>)) { if (typeof v === "string") { if (v.includes("{{") && (re.lastIndex = 0, re.test(v))) pipes++; } else walk(v); } };
  walk(def.questions); walk(def.flow);
  return { conditions: [...where.values()], pipes };
}

/* ------------------------------------------------------------ hypotheses */

const research = (def: SurveyDefinition) => (def.research ??= { hypotheses: [], constructs: [], analysis: [], assumptions: [], sources: [] } as never);

/** a hypothesis by number, label (H2) or text — its index, or a reason listing them */
function hypothesisIndex(hyps: string[], ref: string | number): number | string {
  if (!hyps.length) return "the research design has no hypotheses";
  const list = () => hyps.map((h, i) => `${hypothesisLabel(i)} “${plain(h, 60)}”`).join(", ");
  const n = typeof ref === "number" ? ref : /^\s*(?:H|hypothesis\s*)?(\d+)\s*$/i.test(ref) ? Number(/(\d+)/.exec(ref)![1]) : NaN;
  if (Number.isInteger(n)) return n >= 1 && n <= hyps.length ? n - 1 : `there is no hypothesis ${hypothesisLabel(n - 1)} — the hypotheses are ${list()}`;
  const want = String(ref).trim().toLowerCase();
  const exact = hyps.findIndex((h) => h.trim().toLowerCase() === want);
  if (exact >= 0) return exact;
  const loose = hyps.map((h, i) => ({ h, i })).filter(({ h }) => want.length >= 4 && h.toLowerCase().includes(want));
  if (loose.length === 1) return loose[0].i;
  return `there is no hypothesis “${ref}” — the hypotheses are ${list()}`;
}

/* ------------------------------------------------------------ apply */

const MASK_KEY: Record<MaskDimension, "mask" | "rowMask" | "columnMask"> = { options: "mask", rows: "rowMask", columns: "columnMask" };
const MASK_WORD: Record<MaskDimension, string> = { options: "mask", rows: "row mask", columns: "column mask" };

export function applyOptionAction(def: SurveyDefinition, a: OptionAction, env: OptionEnv): OptionApplied {
  const warnings: string[] = [];
  switch (a.op) {
    case "update_option": {
      const q = questionOrFail(env, a.target);
      const options = (q.options ?? []) as Option[];
      const o = optionOrFail(q, a.option);
      const head = `${q.code} option ${o.code} “${plain(o.label)}”`;
      const changed: string[] = [], lossy: string[] = [];
      if (a.label !== undefined && a.label !== o.label) { changed.push(`label → “${a.label}”`); o.label = a.label; }
      if (a.code !== undefined && String(a.code) !== String(o.code)) {
        const clash = options.find((x) => x !== o && String(x.code) === String(a.code));
        if (clash) fail(`${q.code} already has an option with code ${a.code} (“${plain(clash.label)}”)`);
        // the same type as the question's other codes, so `1` and "1" do not end up side by side
        const to: string | number = typeof a.code === "string" && /^-?\d+$/.test(a.code) && options.some((x) => typeof x.code === "number") ? Number(a.code) : a.code;
        const n = recodeConditions(def, q, o.code, to);
        recodeOwnLists(q, o.code, to);
        /*
         * The option's translations are keyed by its code (`q:<qid>:opt:<code>`):
         * a recode MOVES them to the new key, status and history with them —
         * the words did not change, so an approved German label stays approved.
         * Left where they were, they were orphans the batch would then drop.
         */
        const moved = moveTranslationKey(def, K.opt(q.id, o.code), K.opt(q.id, to)) + moveTranslationKey(def, K.optAlt(q.id, o.code), K.optAlt(q.id, to));
        lossy.push(`recodes option “${plain(o.label)}” of ${q.code} from ${o.code} to ${to} — ${plural(n, "condition")} updated${moved ? `, ${plural(moved, "translation")} moved with it` : ""}`);
        changed.push(`code ${o.code} → ${to}`);
        o.code = to;
      }
      if (a.value === null) { if (o.value !== undefined) { delete o.value; changed.push("export value cleared"); } }
      else if (a.value !== undefined && a.value !== o.value) { o.value = a.value; changed.push(`export value → ${a.value}`); }
      if (a.exclusive !== undefined && a.exclusive !== hasFlag(o, "exclusive")) { setFlag(o, "exclusive", a.exclusive); changed.push(a.exclusive ? "exclusive" : "not exclusive"); }
      if (a.other !== undefined && a.other !== hasFlag(o, "other_specify")) { setFlag(o, "other_specify", a.other); changed.push(a.other ? "with a specify box" : "no specify box"); }
      if (a.anchor !== undefined) {
        const was = hasFlag(o, "anchor_top") ? "top" : hasFlag(o, "anchor_bottom") ? "bottom" : "none";
        if (was !== a.anchor) { setFlag(o, "anchor_top", a.anchor === "top"); setFlag(o, "anchor_bottom", a.anchor === "bottom"); changed.push(a.anchor === "none" ? "not anchored" : `anchored at the ${a.anchor}`); }
      }
      if (a.visibleIf !== undefined) {
        const had = o.visibleIf;
        if (a.visibleIf === null) { if (had) { delete o.visibleIf; changed.push("always shown"); lossy.push(`removes the display condition of ${head} (${formatCondition(def, had)})`); } }
        else { const c = env.condition(a.visibleIf); o.visibleIf = c; changed.push(`shown only when ${formatCondition(def, c)}`); if (had) lossy.push(`replaces the display condition of ${head} (was ${formatCondition(def, had)})`); }
      }
      if (a.position !== undefined) {
        const rest = options.filter((x) => x !== o);
        let at: number;
        if (typeof a.position === "number") at = Math.min(a.position - 1, rest.length);
        else { const anchor = optionOrFail(q, "before" in a.position ? a.position.before : a.position.after); if (anchor === o) fail("an option cannot be placed before or after itself"); at = rest.indexOf(anchor) + ("after" in a.position ? 1 : 0); }
        if (options.indexOf(o) !== at) { rest.splice(at, 0, o); q.options = rest as never; changed.push(`moved to position ${at + 1}`); }
      }
      if (!changed.length) fail(`nothing to change on ${head}`);
      return { description: `${head}: ${changed.join(", ")}`, ...(lossy.length ? { destructive: lossy.join("; ") } : {}), warnings, touched: [q.id] };
    }
    case "reorder_options": {
      const q = questionOrFail(env, a.target);
      const options = (q.options ?? []) as Option[];
      if (options.length < 2) fail(`${q.code} has ${options.length ? "only one option" : "no options"} to reorder`);
      // anchored options keep their place whatever the order says: a "None of the above" that drifted into the middle is a bug, not an order
      const top = options.filter((o) => hasFlag(o, "anchor_top")), bottom = options.filter((o) => hasFlag(o, "anchor_bottom") && !hasFlag(o, "anchor_top"));
      const middle = options.filter((o) => !top.includes(o) && !bottom.includes(o));
      let ordered: Option[];
      if (a.order?.length) {
        const picked: Option[] = [];
        for (const r of a.order) { const o = optionOrFail(q, r); if (!picked.includes(o)) picked.push(o); }
        const pinned = picked.filter((o) => !middle.includes(o));
        if (pinned.length) warnings.push(`${pinned.map((o) => `“${plain(o.label)}”`).join(", ")} ${pinned.length === 1 ? "is" : "are"} anchored and ${pinned.length === 1 ? "keeps" : "keep"} ${pinned.length === 1 ? "its" : "their"} place — change the anchor first to move ${pinned.length === 1 ? "it" : "them"}.`);
        const first = picked.filter((o) => middle.includes(o));
        ordered = [...first, ...middle.filter((o) => !first.includes(o))];
      } else {
        const byLabel = (x: Option, y: Option) => normalizeOptionText(x.label).localeCompare(normalizeOptionText(y.label), undefined, { numeric: true, sensitivity: "base" });
        const asNum = (o: Option) => (Number.isFinite(Number(o.code)) ? Number(o.code) : Number.POSITIVE_INFINITY);
        ordered = [...middle];
        switch (a.sort) {
          case "alphabetical": ordered.sort(byLabel); break;
          case "alphabetical_desc": ordered.sort((x, y) => byLabel(y, x)); break;
          case "numeric": ordered.sort((x, y) => asNum(x) - asNum(y) || byLabel(x, y)); break;
          case "reverse": ordered.reverse(); break;
        }
      }
      const next = [...top, ...ordered, ...bottom];
      if (next.every((o, i) => o === options[i])) fail(`the options of ${q.code} are already in that order`);
      q.options = next as never;
      const shown = ordered.slice(0, 12).map((o) => `“${plain(o.label, 30)}”`).join(", ") + (ordered.length > 12 ? ` … (${ordered.length} options)` : "");
      const anchored = [...top.map((o) => `“${plain(o.label, 30)}” stays at the top`), ...bottom.map((o) => `“${plain(o.label, 30)}” stays at the bottom`)];
      return { description: `${q.code} options ${a.sort ? { alphabetical: "A→Z", alphabetical_desc: "Z→A", numeric: "by code", reverse: "reversed" }[a.sort] : "reordered"}: ${shown}${anchored.length ? `; ${anchored.join(", ")}` : ""}`, warnings, touched: [q.id] };
    }
    case "set_option_randomization": {
      const q = questionOrFail(env, a.target);
      const axis: MaskDimension = a.scope ?? (q.rows?.length && /^matrix/.test(q.type) ? "rows" : "options");
      const items = (axis === "rows" ? q.rows : axis === "columns" ? q.columns : q.options) as Item[] | undefined;
      if (!items?.length) fail(`${q.code} has no ${axis} to randomize`);
      const list = items!;
      const word = axis === "options" ? "option" : axis.slice(0, -1);
      const item = (r: OptionRef): Item => { const x = resolveItem(list, r, word); return typeof x === "string" ? fail(`${q.code}: ${x}`) : x; };
      if (a.pick !== undefined && a.pick >= list.length) fail(`pick ${a.pick} is not fewer than the ${list.length} ${axis} of ${q.code} — there would be nothing to leave out`);
      const tops: Item[] = (a.keepFirst ?? []).map(item), bottoms: Item[] = (a.keepLast ?? []).map(item);
      /*
       * "Keep X anchored" without saying where: an option already at an edge
       * stays at that edge (last → bottom, first → top — the leading and
       * trailing runs of already-anchored items count as the edge); one in
       * the middle is refused, because guessing which edge would move it.
       */
      let lead = 0; while (lead < list.length && hasFlag(list[lead], "anchor_top")) lead++;
      let trail = list.length; while (trail > 0 && hasFlag(list[trail - 1], "anchor_bottom")) trail--;
      for (const r of a.anchors ?? []) {
        const o = item(r); if (tops.includes(o) || bottoms.includes(o)) continue;
        const i = list.indexOf(o);
        if (i >= trail || i === list.length - 1) bottoms.push(o);
        else if (i < lead || i === 0) tops.push(o);
        else fail(`“${plain(o.label)}” is in the middle of ${q.code}'s ${axis} — say whether it should stay at the top (keepFirst) or the bottom (keepLast)`);
      }
      for (const o of tops) { if (bottoms.includes(o)) fail(`“${plain(o.label)}” cannot stay both first and last`); setFlag(o, "anchor_bottom", false); setFlag(o, "anchor_top", true); }
      for (const o of bottoms) { setFlag(o, "anchor_top", false); setFlag(o, "anchor_bottom", true); }
      // the physical order follows the flags: tops first (in the order named), bottoms last, everything else as it was
      const allTop = [...tops, ...list.filter((o) => hasFlag(o, "anchor_top") && !tops.includes(o))];
      const allBottom = [...list.filter((o) => hasFlag(o, "anchor_bottom") && !hasFlag(o, "anchor_top") && !bottoms.includes(o)), ...bottoms];
      const next = [...allTop, ...list.filter((o) => !allTop.includes(o) && !allBottom.includes(o)), ...allBottom];
      (q as unknown as Record<string, unknown>)[axis] = next;
      q.randomization = { ...(q.randomization ?? {}), enabled: a.enabled, scope: axis, method: "shuffle", ...(a.pick !== undefined ? { pick: a.pick } : {}) } as never;
      const pins = [...tops.map((o) => `“${plain(o.label, 30)}” stays first`), ...bottoms.map((o) => `“${plain(o.label, 30)}” stays last`)];
      return { description: `${q.code} ${axis} ${a.enabled ? "randomized" : "not randomized"}${a.pick !== undefined ? ` — each respondent sees ${a.pick} of ${list.length}` : ""}${pins.length ? `; ${pins.join(", ")}` : ""}`, warnings, touched: [q.id] };
    }
    case "set_mask": {
      const q = questionOrFail(env, a.target);
      const dim = a.dimension ?? "options", key = MASK_KEY[dim];
      if (dim === "options" && !q.options?.length && !/select|dropdown|rank|matrix/.test(q.type)) fail(`${q.code} has no options to mask`);
      if (dim === "rows" && !q.rows?.length) fail(`${q.code} has no rows to mask`);
      if (dim === "columns" && !q.columns?.length) fail(`${q.code} has no columns to mask`);
      let expr: SetExpr;
      if (env.setExpression) expr = env.setExpression(a.expression);
      else { const r = parseSetExpression(def, a.expression); if (r.errors.length || !r.expr) fail(`the set expression “${a.expression}” does not parse: ${r.errors[0]?.message ?? "empty"}`); expr = r.expr!; }
      // the sources must be answered before the target is shown, or the mask has nothing to go on
      const order = questionOrder(def), at = order.indexOf(q.id);
      for (const id of setExprSources(expr, new Set<string>(), def)) {
        const src = def.questions.find((x) => x.id === id) ?? fail(`the mask reads a question that is not in the survey (${id})`);
        if (src.id === q.id) fail(`${q.code} cannot be masked by its own answer`);
        if (order.indexOf(src.id) >= at) fail(`${src.code} is asked after ${q.code}, so its answer is not known when ${q.code}'s ${dim} are chosen — move ${q.code} after ${src.code}, or mask it by an earlier question`);
      }
      const had = q[key] as OptionMask | undefined;
      const mask: OptionMask = { expr, action: a.action ?? "display", keepAlwaysShow: true };
      (q as unknown as Record<string, unknown>)[key] = mask;
      return { description: `${maskSummary(def, q.code, mask)}${dim !== "options" ? ` (${MASK_WORD[dim]})` : ""}`, ...(had ? { destructive: `Replaces the ${MASK_WORD[dim]} of ${q.code} (was ${formatSetExpression(def, had.expr)})` } : {}), warnings, touched: [q.id] };
    }
    case "clear_mask": {
      const q = questionOrFail(env, a.target);
      const dim = a.dimension ?? "options", key = MASK_KEY[dim];
      const had = (q[key] as OptionMask | undefined) ?? fail(`${q.code} has no ${MASK_WORD[dim]} to remove`);
      delete (q as unknown as Record<string, unknown>)[key];
      return { description: `Removed the ${MASK_WORD[dim]} of ${q.code}`, destructive: `Removes the ${MASK_WORD[dim]} of ${q.code} (${maskSummary(def, q.code, had)})`, warnings, touched: [q.id] };
    }
    case "duplicate_question": {
      const q = questionOrFail(env, a.target);
      const copy = duplicateQuestion(def, q.id, env.ids) ?? fail(`${q.code} could not be duplicated`);
      let afterCode = "";
      if (a.after) {
        const anchor = questionOrFail(env, a.after);
        if (anchor.id === copy.id) fail("the copy cannot be placed after itself");
        const pos = pagePositionOf(def, anchor.id) ?? fail(`${anchor.code} is not on a page`);
        // the copy may already sit on that page (right after the original): its index is read with the copy taken out
        const index = pos.page.questionIds.filter((x) => x !== copy.id).indexOf(anchor.id) + 1;
        if (!moveQuestionTo(def, copy.id, pos.page.id, index)) fail(`the copy could not be placed after ${anchor.code}`);
        afterCode = anchor.code;
      }
      return { description: `Duplicated ${q.code} as ${copy.code}${afterCode ? ` after ${afterCode}` : ""}`, warnings, touched: [q.id, copy.id] };
    }
    case "set_survey_settings": {
      const changed: string[] = [];
      if (a.title !== undefined) { if (!a.title.trim()) fail("the survey title cannot be empty"); if (a.title !== def.meta.title) { def.meta.title = a.title; changed.push(`title “${a.title}”`); } }
      if (a.description === null) { if (def.meta.description) { delete def.meta.description; changed.push("no description"); } }
      else if (a.description !== undefined && a.description !== def.meta.description) { def.meta.description = a.description; changed.push(`description “${plain(a.description, 60)}”`); }
      if (a.code !== undefined && a.code !== def.meta.code) { if (!/^[A-Za-z0-9][A-Za-z0-9_-]*$/.test(a.code)) fail(`“${a.code}” is not a survey code — letters, digits, underscores and dashes`); def.meta.code = a.code; changed.push(`code ${a.code}`); }
      if (!changed.length) fail("the survey settings are already as asked");
      return { description: `Survey settings: ${changed.join(", ")}`, warnings, touched: [] };
    }
    case "update_embedded": {
      const names = embeddedFieldNames(def);
      const { field } = findEmbedded(def, a.name) ?? fail(`there is no embedded variable “${a.name}”${names.length ? ` — the embedded variables are ${names.join(", ")}` : ""}`);
      const changed: string[] = [], lossy: string[] = [];
      const old = field.name;
      if (a.newName && a.newName !== old) {
        if (!NAME_RE.test(a.newName)) fail(`${a.newName} is not a valid variable name — letters, digits and underscores, not starting with a digit`);
        const taken = usedNames(def); taken.delete(old);
        if ([...taken].some((t) => t.toLowerCase() === a.newName!.toLowerCase())) fail(`${a.newName} is already used by a question, a calculation or another embedded variable`);
        let conditions = 0;
        const paths = new Set<string>();
        forEachRuleInSurvey(def, (rule, loc) => { const s = rule.source as { kind?: string; ref?: string }; if ((s.kind === "embedded" || s.kind === "variable") && s.ref === old) { s.ref = a.newName!; paths.add(loc.path); } });
        conditions = paths.size;
        const pipes = rewritePipes(def, old, (s) => s.replace(pipeHead(old), `$1${a.newName}`));
        field.name = a.newName;
        changed.push(`renamed ${old} → ${a.newName}`);
        lossy.push(`renames embedded variable ${old} to ${a.newName} — ${plural(conditions, "condition")} and ${plural(pipes, "pipe")} rewritten; exports and anything outside the survey that read ${old} by name do not follow`);
      }
      if (a.source && a.source !== field.source) { field.source = a.source; changed.push(`source ${a.source}`); }
      if (a.value === null) { if (field.value !== undefined) { delete field.value; changed.push("no value"); } }
      else if (a.value !== undefined && a.value !== field.value) { field.value = a.value; changed.push(`value ${a.value}`); }
      if (a.dataType && a.dataType !== field.dataType) { field.dataType = a.dataType; changed.push(`type ${a.dataType}`); }
      if (!changed.length) fail(`nothing to change on embedded variable ${old}`);
      return { description: `Embedded variable ${field.name}: ${changed.join(", ")}`, ...(lossy.length ? { destructive: lossy.join("; ") } : {}), warnings, touched: [] };
    }
    case "remove_embedded": {
      const names = embeddedFieldNames(def);
      const { node, field } = findEmbedded(def, a.name) ?? fail(`there is no embedded variable “${a.name}”${names.length ? ` — the embedded variables are ${names.join(", ")}` : ""}`);
      const reads = embeddedReads(def, field.name);
      const total = reads.conditions.length + reads.pipes;
      const readers = [reads.conditions.length ? `${plural(reads.conditions.length, "condition")} (${[...new Set(reads.conditions)].slice(0, 3).join(", ")}${reads.conditions.length > 3 ? ", …" : ""})` : "", reads.pipes ? `${plural(reads.pipes, "text")} piping it` : ""].filter(Boolean).join(" and ");
      if (total && !a.force) fail(`${field.name} is still read by ${readers} — change those first, or say force to remove it anyway`);
      node.fields = node.fields.filter((f) => f !== field);
      return { description: `Removed embedded variable ${field.name}`, destructive: `Removes embedded variable ${field.name} (${field.source}${field.value ? ` = ${field.value}` : ""})${total ? ` — ${readers} will no longer resolve` : ""}`, warnings, touched: [] };
    }
    case "add_hypothesis": {
      const r = research(def);
      const i = r.hypotheses.findIndex((h) => h.trim().toLowerCase() === a.text.trim().toLowerCase());
      if (i >= 0) fail(`that is already hypothesis ${hypothesisLabel(i)}`);
      r.hypotheses = [...r.hypotheses, a.text];
      r.updatedAt = env.now;
      return { description: `Hypothesis ${hypothesisLabel(r.hypotheses.length - 1)}: ${a.text}`, warnings, touched: [] };
    }
    case "remove_hypothesis": {
      /*
       * Hypotheses are named by POSITION (H1, H2 — `hypothesisLabel`), and
       * the questions' analysis metadata and the analysis plan hold those
       * labels. Removing H2 therefore also drops "H2" wherever it is held
       * and turns every later label down by one (H3 → H2), so the labels
       * keep pointing at the hypotheses they meant. The description says how
       * many references were dropped and which labels moved.
       */
      const r = research(def);
      const idx = hypothesisIndex(r.hypotheses, a.hypothesis);
      if (typeof idx === "string") fail(idx);
      const i = idx as number;
      const label = hypothesisLabel(i), text = r.hypotheses[i], last = r.hypotheses.length;
      const dropped: string[] = [];
      const relabel = (labels: string[] | undefined, where: string): string[] | undefined => {
        if (!labels) return labels;
        const out: string[] = [];
        for (const l of labels) {
          const m = /^H(\d+)$/i.exec(l.trim());
          if (!m) { out.push(l); continue; }
          const n = Number(m[1]);
          if (n === i + 1) { dropped.push(where); continue; }
          out.push(n > i + 1 ? hypothesisLabel(n - 2) : l);
        }
        return out;
      };
      for (const q of def.questions) if (q.analysis?.hypotheses?.length) q.analysis.hypotheses = relabel(q.analysis.hypotheses, q.code)!;
      const plan = r.analysisPlan;
      if (plan) {
        for (const x of plan.crosstabs) x.hypotheses = relabel(x.hypotheses, `the crosstab ${x.rows.join("+")} by ${x.columns.join("+")}`)!;
        for (const t of plan.tests) t.hypotheses = relabel(t.hypotheses, `the ${t.method.replace(/_/g, " ")}${t.outcome ? ` on ${t.outcome}` : ""}`)!;
      }
      r.hypotheses = r.hypotheses.filter((_, k) => k !== i);
      r.updatedAt = env.now;
      const renumbered = last > i + 1 ? `${hypothesisLabel(i + 1)}${last > i + 2 ? `–${hypothesisLabel(last - 1)}` : ""} ${last > i + 2 ? "become" : "becomes"} ${hypothesisLabel(i)}${last > i + 2 ? `–${hypothesisLabel(last - 2)}` : ""}` : "";
      return {
        description: `Removed hypothesis ${label}: ${plain(text, 80)}${renumbered ? ` — ${renumbered}` : ""}`,
        destructive: `Removes hypothesis ${label} “${plain(text, 80)}”${dropped.length ? ` — ${plural(dropped.length, "reference")} to it (${[...new Set(dropped)].slice(0, 4).join(", ")}) dropped` : ""}${renumbered ? `; ${renumbered} everywhere` : ""}`,
        warnings, touched: [],
      };
    }
    case "set_custom_code": {
      const q = questionOrFail(env, a.target);
      const changed: string[] = [], lossy: string[] = [];
      const edit = (key: "customJs" | "customCss", next: string | null | undefined, word: string) => {
        if (next === undefined) return;
        const had = q[key];
        if (next === null) { if (had !== undefined) { delete q[key]; changed.push(`${word} removed`); lossy.push(`removes the ${word} of ${q.code} (${had.length} characters)`); } return; }
        if (had === next) return;
        q[key] = next; changed.push(`${word} (${next.length} characters)`);
        if (had !== undefined) lossy.push(`replaces the ${word} of ${q.code} (${had.length} characters)`);
      };
      edit("customJs", a.js, "custom JS");
      edit("customCss", a.css, "custom CSS");
      if (!changed.length) fail(`the custom code of ${q.code} is already as asked`);
      return { description: `${q.code}: ${changed.join(", ")}`, ...(lossy.length ? { destructive: lossy.join("; ") } : {}), warnings, touched: [q.id] };
    }
  }
}

export function describeOptionAction(a: OptionAction): string {
  switch (a.op) {
    case "update_option": return `Change option ${a.option} of ${a.target}`;
    case "reorder_options": return `Reorder the options of ${a.target}`;
    case "set_option_randomization": return `${a.enabled ? "Randomize" : "Stop randomizing"} the ${a.scope ?? "options"} of ${a.target}`;
    case "set_mask": return `Mask ${a.target} by ${a.expression}`;
    case "clear_mask": return `Remove the ${MASK_WORD[a.dimension ?? "options"]} of ${a.target}`;
    case "duplicate_question": return `Duplicate ${a.target}`;
    case "set_survey_settings": return "Change the survey settings";
    case "update_embedded": return a.newName ? `Rename embedded variable ${a.name} to ${a.newName}` : `Change embedded variable ${a.name}`;
    case "remove_embedded": return `Remove embedded variable ${a.name}`;
    case "add_hypothesis": return `Add hypothesis “${plain(a.text, 50)}”`;
    case "remove_hypothesis": return `Remove hypothesis ${a.hypothesis}`;
    case "set_custom_code": return `${a.js === null && a.css === null ? "Remove" : "Set"} the custom code of ${a.target}`;
  }
}

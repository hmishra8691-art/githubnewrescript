import type { Condition, ConditionRule, Question, SurveyDefinition } from "@rescript/schema";
import { mapConditionRoots } from "./conditionWalk.js";
import { isOptionValueRef, isQuestionValueRef, effectiveResponseModel } from "@rescript/schema";
import { getQuestionByCodeOrVar } from "./state.js";

/**
 * What a question's answer is made of — the same reading as lintLogic's
 * `sourceKindForQuestion`, without importing the linter. `numeric` is here
 * for the expression parser, which has to know that `Q8 = "abc"` compares a
 * number with text before anything is stored; this module itself only asks
 * whether the answer is a CODE.
 */
export function answerKind(q: Question): "choice" | "list" | "ranking" | "numeric" | "other" {
  switch (effectiveResponseModel(q)) {
    case "single_choice": return "choice";
    case "multiple_choice": return "list";
    case "rank_order": return "ranking";
    case "numeric": case "allocation": return "numeric";
    case "fields": return q.type === "numeric_list" ? "numeric" : "other";
    case "per_row": return q.type === "matrix_multi" ? "list" : q.type === "matrix_numeric" ? "numeric" : q.type === "matrix_text" ? "other" : "choice";
    default: return "other";
  }
}

/**
 * OPTION CODES ARE THE ONLY OPTION VALUES A CONDITION STORES.
 *
 * A choice question's answer is its option's CODE (`1`, `[1, 3]`, `{r1: 2}`),
 * and the evaluator compares answers with the rule's value as they are. So a
 * rule whose value is the option's DISPLAY TEXT — `Q3 = Yes`, `Q3 == "Yes"`,
 * `Q3 = "__Yes__"`, `Q3 = Option 1` — is a rule that can never be true: it was
 * accepted, printed, summarised as `Q3 is “Yes”` (which looks right), and
 * silently never matched a respondent.
 *
 * This is the one place that turns what someone (or a model) wrote into the
 * canonical form, for every writer — the expression parser, the visual
 * builder, the copilot's actions, the Intelligent planner, punch rules, and
 * the one-time repair of a stored survey:
 *
 *   value that is a code             → that code, typed as the option stores it
 *   value that is an option's label  → that option's code (HTML, markdown
 *                                      emphasis such as __Yes__ / **Yes**,
 *                                      entities, quotes, case and spacing
 *                                      ignored)
 *   "Option 2" / "O2" / "#2"         → option 2 (by code, else by position)
 *   anything else                    → an ERROR naming the question's options
 *
 * and, because a multi-select's answer is a LIST: `QM = 2` → `QM.2 is
 * selected`, `QM != 2` → not selected, `QM in [1,2]` → contains any
 * (`contains` already means membership on a list).
 *
 * Only questions whose answer IS a code are touched (single, multi, dropdown,
 * grids by row, rankings); a text or numeric question's literal is its value.
 */

const ENTITIES: Record<string, string> = { amp: "&", nbsp: " ", lt: "<", gt: ">", quot: "\"", apos: "'", "#39": "'" };
/** an option label as a person reads it: markup, markdown emphasis, entities, quotes, case and spacing removed */
export function normalizeOptionText(s: unknown): string {
  return String(s ?? "")
    .replace(/<[^>]*>/g, " ")
    .replace(/&(amp|nbsp|lt|gt|quot|apos|#39);/gi, (_m, e: string) => ENTITIES[e.toLowerCase()] ?? " ")
    .replace(/(\*\*|__)(.+?)\1/g, "$2")
    .replace(/(^|\s)[*_](\S(?:.*?\S)?)[*_](?=\s|$)/g, "$1$2")
    .replace(/[`"“”‘’']/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

export type OptionList = { code: string | number; label: string; flags?: string[] }[];

export type OptionValueResolution =
  | { kind: "code"; code: string | number; via: "code" | "label" | "position" }
  | { kind: "none" };

/** one written value against a list of options */
export function resolveOptionValue(options: OptionList, v: unknown): OptionValueResolution {
  if (v === null || v === undefined || typeof v === "boolean" || typeof v === "object") return { kind: "none" };
  const raw = String(v).trim();
  const exact = options.find((o) => String(o.code) === raw);
  if (exact) return { kind: "code", code: exact.code, via: "code" };
  // a quoted or emphasised code: "1", __1__
  const bare = normalizeOptionText(raw);
  const codeish = options.find((o) => String(o.code).toLowerCase() === bare);
  if (codeish) return { kind: "code", code: codeish.code, via: "code" };
  const byLabel = options.filter((o) => normalizeOptionText(o.label) === bare);
  if (byLabel.length === 1) return { kind: "code", code: byLabel[0].code, via: "label" };
  if (!byLabel.length && bare) {
    const other = /^(?:other|other \(please specify\)|other, please specify)$/.test(bare) ? options.filter((o) => o.flags?.includes("other_specify")) : [];
    if (other.length === 1) return { kind: "code", code: other[0].code, via: "label" };
  }
  const n = /^(?:option|opt|choice|answer|o|a|#)\s*#?\s*(\d+)$/.exec(bare);
  if (n) {
    const byCode = options.find((o) => String(o.code) === n[1]);
    if (byCode) return { kind: "code", code: byCode.code, via: "code" };
    const byPos = options[Number(n[1]) - 1];
    if (byPos) return { kind: "code", code: byPos.code, via: "position" };
  }
  return { kind: "none" };
}

/** the operators whose value is an option CODE (or a list of them) — what canonicalisation rewrites, and what the parser leaves to it */
export const CODE_OPERATORS = new Set<string>([
  "eq", "ne", "in", "notIn", "contains", "notContains", "selected", "notSelected",
  "containsAny", "containsAll", "containsNone",
  "rankedFirst", "rankedLast", "rankedTopN", "rankEquals", "rankGreaterThan", "rankLessThan", "notRanked",
]);
/** multi-select: a list answer — "equals one code" means "that code is selected" */
const LIST_REWRITE: Record<string, ConditionRule["operator"]> = { eq: "selected", ne: "notSelected", in: "containsAny", notIn: "containsNone" };

export const describeOptions = (options: OptionList, max = 8) =>
  options.slice(0, max).map((o) => `${o.code} = ${normalizeOptionText(o.label) ? String(o.label).replace(/<[^>]*>/g, "").trim() : "(no label)"}`).join(", ") + (options.length > max ? ", …" : "");

/**
 * The options a rule's value is compared with, and what kind of answer it
 * reads. The source is resolved by id, code OR variable name — the three
 * spellings `ConditionSource.ref` accepts everywhere else — so a structured
 * condition keyed by code (`{ source: { ref: "Q3" }, value: "Yes" }`, which is
 * how a model writes one) is canonicalised exactly as the parser's
 * id-keyed tree is. Resolved by id only, it was left as written: label stored,
 * never matching.
 */
function domainOf(def: SurveyDefinition, rule: ConditionRule): { q: Question; options: OptionList; list: boolean } | null {
  const src = rule.source as { kind: string; ref?: string; rowCode?: string; columnId?: string; count?: unknown };
  if ((src.kind !== "question" && src.kind !== "variable") || !src.ref || src.count) return null;
  const q = getQuestionByCodeOrVar(def, src.ref);
  if (!q) return null;
  const kind = answerKind(q);
  if (kind === "other" || kind === "numeric") return null;
  const column = src.columnId ? q.columns?.find((c) => c.id === src.columnId) : undefined;
  const options = (column?.options?.length ? column.options : q.options) as OptionList;
  if (!options?.length) return null;
  // a grid read without a row is its whole answer (row → code), not one code
  if ((q.rows?.length ?? 0) > 0 && !src.rowCode && kind !== "ranking") return null;
  return { q, options, list: kind === "list" };
}

export interface CanonicalCondition { condition: Condition; errors: string[]; changes: string[] }

/** the condition with every option value as its code; what changed, and what cannot be resolved */
export function canonicalizeCondition(def: SurveyDefinition, condition: Condition): CanonicalCondition {
  const errors: string[] = [], changes: string[] = [];
  const walk = (c: Condition, counted?: { q: Question; options: OptionList }): Condition => {
    if (c.type === "group") return { ...c, children: c.children.map((k) => walk(k, counted)) };
    /*
     * A COUNT's `where` is a condition of its own, read once per counted item
     * with that item as `@option` — so its option values are codes too, of the
     * counted question's options.
     */
    if (c.source?.count?.where) {
      const r0 = c as ConditionRule;
      const cq = def.questions.find((x) => x.id === r0.source.ref) ?? undefined;
      const inner = cq && (r0.source.count!.scope ?? "options") === "options" && cq.options?.length
        ? { q: cq, options: cq.options as OptionList } : undefined;
      c = { ...r0, source: { ...r0.source, count: { ...r0.source.count!, where: walk(r0.source.count!.where!, inner) } } } as ConditionRule;
    }
    if (!CODE_OPERATORS.has(c.operator)) return c;
    const d = c.source?.kind === "option" && (c.source.ref ?? "code") === "code" && counted
      ? { q: counted.q, options: counted.options, list: false }
      : domainOf(def, c);
    if (!d) return c;
    const fix = (v: unknown): unknown => {
      if (v === null || v === undefined || v === "" || typeof v === "boolean" || isOptionValueRef(v) || isQuestionValueRef(v)) return v;
      if (Array.isArray(v)) return v.map(fix);
      if (typeof v === "object") return v;
      const r = resolveOptionValue(d.options, v);
      if (r.kind === "none") {
        errors.push(`${d.q.code} has no option “${String(v)}” — conditions compare option CODES (${describeOptions(d.options)})`);
        return v;
      }
      // already the code (a "1" for a 1 compares equal): left exactly as written
      if (r.via === "code" && String(r.code) === String(v)) return v;
      changes.push(r.via === "code" ? `${d.q.code}: “${String(v)}” is code ${r.code}` : `${d.q.code}: “${String(v)}” is option ${r.code}`);
      return r.code;
    };
    let next: ConditionRule = { ...c, value: fix(c.value) };
    // ranking operators compare a code (value) and a rank (value2): only the code is an option
    if (c.value2 !== undefined && !String(c.operator).startsWith("rank")) next.value2 = fix(c.value2);
    if (d.list && LIST_REWRITE[next.operator] && !(next.operator === "eq" || next.operator === "ne" ? Array.isArray(next.value) : false)) {
      const op = LIST_REWRITE[next.operator];
      const value = op === "containsAny" || op === "containsNone" ? (Array.isArray(next.value) ? next.value : [next.value]) : next.value;
      if (op !== next.operator) changes.push(`${d.q.code} is a multi-select: “${c.operator}” reads as “${op}”`);
      next = { ...next, operator: op, value };
    }
    return next;
  };
  return { condition: walk(condition), errors: [...new Set(errors)], changes: [...new Set(changes)] };
}

const isRule = (x: unknown): x is ConditionRule => !!x && typeof x === "object" && (x as { type?: unknown }).type === "rule" && "operator" in (x as object) && "source" in (x as object);
const isGroup = (x: unknown): x is Extract<Condition, { type: "group" }> => !!x && typeof x === "object" && (x as { type?: unknown }).type === "group" && Array.isArray((x as { children?: unknown }).children) && ["and", "or", "not"].includes(String((x as { op?: unknown }).op));

/**
 * THE ONE-TIME REPAIR of a stored survey: every condition anywhere in the
 * definition — display logic, skips, branches, display rules, punch rules,
 * quotas, option/row/column visibility, validation — rewritten to option
 * codes. Values that resolve to nothing are left as they are (and reported),
 * never guessed.
 */
export function canonicalizeSurveyConditions(input: SurveyDefinition): { def: SurveyDefinition; changes: string[]; unresolved: string[] } {
  const changes: string[] = [], unresolved: string[] = [];
  // every condition, wherever it sits (UX behaviour guards and COUNT wheres included) — see conditionWalk
  const def = mapConditionRoots(input, (c) => {
    const r = canonicalizeCondition(input, c);
    unresolved.push(...r.errors);
    if (JSON.stringify(r.condition) === JSON.stringify(c)) return c;
    changes.push(...r.changes);
    return r.condition;
  });
  return { def: def === input ? structuredClone(input) : def, changes: [...new Set(changes)], unresolved: [...new Set(unresolved)] };
}

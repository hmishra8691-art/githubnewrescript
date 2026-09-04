import type { Condition, ConditionRule, SurveyDefinition } from "@rescript/schema";
import type { ResponseState } from "./state.js";
import { evaluateCondition } from "./evaluate.js";
import { flattenVariables } from "./flatten.js";
import { conditionSummary } from "./logicSummary.js";

/**
 * Finding responses by condition — for the Response Data Manager's filters,
 * its condition-based bulk delete, and quota recounts from stored data.
 *
 * There is exactly ONE logic engine on this platform. A researcher's filter is
 * an ordinary `Condition` (the same tree the display logic, quotas and quality
 * custom rules use) and the verdict always comes from `evaluateCondition` —
 * multi-select semantics, matrix rows, ranking, dates and `calc.*` behave in a
 * filter precisely as they do in the survey, because it is the same code.
 *
 * What is compiled to SQL is a PREFILTER, never the verdict: a set of clauses
 * that no matching row can fail, used to narrow the scan before the engine
 * decides. When the compiler can prove the clauses are equivalent to the whole
 * condition (`exact`), the engine pass can be skipped entirely and a count is
 * one indexed query. Anything the compiler does not understand simply widens
 * the prefilter — it can never change the answer.
 *
 *   condition → prefilter clauses → DB narrows → evaluateCondition decides
 */

/** A clause the caller applies to its query builder. `jsonEq` uses the GIN index on `answers`. */
export type PrefilterClause =
  /** answers @> {"<questionId>": <value>} — exact scalar match, index-backed */
  | { kind: "jsonEq"; column: "answers" | "calculated" | "embedded"; key: string; value: string | number | boolean }
  /** answers ? '<key>' — the question was answered at all */
  | { kind: "hasKey"; column: "answers" | "calculated" | "embedded"; key: string }
  /** answers->>'<key>' <op> <value> — numeric/text comparison, not index-backed */
  | { kind: "compare"; column: "answers" | "calculated" | "embedded"; key: string; op: "gt" | "gte" | "lt" | "lte"; value: number }
  /** answers->>'<key>' ilike %value% */
  | { kind: "ilike"; column: "answers" | "calculated" | "embedded"; key: string; value: string };

export interface CompiledResponseFilter {
  clauses: PrefilterClause[];
  /**
   * The clauses ARE the condition — every row passing them matches, so the
   * caller may count with a single query and skip the engine pass.
   */
  exact: boolean;
  /** why it is not exact, for the UI's "filter runs in two stages" note */
  reason?: string;
}

const COLUMN_FOR: Record<string, PrefilterClause["column"] | null> = {
  question: "answers",
  calculation: "calculated",
  embedded: "embedded",
  variable: null,
  quota: null,
  loop: null,
  option: null,
};

/**
 * Which questions hold a scalar answer keyed exactly by question id — the only
 * shape a `answers @> {...}` containment test is equivalent to equality for.
 * A multi-select stores an array, a matrix an object per row, a list a per-row
 * map: for those the prefilter falls back to "was answered", and the engine
 * decides.
 */
const SCALAR_ANSWER_TYPES = new Set([
  "single_select", "dropdown", "numeric", "open_text", "long_text", "date", "time",
  "slider", "nps", "image_select", "hidden", "calculated", "embedded_data", "experiment",
]);

function scalarAnswer(def: SurveyDefinition, questionId: string): boolean {
  const q = def.questions.find((x) => x.id === questionId);
  if (!q) return false;
  // a question with rows or columns stores a map, never a scalar
  if (q.rows?.length || q.columns?.length) return false;
  return SCALAR_ANSWER_TYPES.has(String(q.type));
}

/** Is this rule's value a plain scalar we can put in a containment test? */
function scalarValue(v: unknown): v is string | number | boolean {
  return typeof v === "string" || typeof v === "number" || typeof v === "boolean";
}

function ruleClauses(def: SurveyDefinition, rule: ConditionRule): { clauses: PrefilterClause[]; exact: boolean } {
  const column = COLUMN_FOR[rule.source.kind ?? "question"] ?? null;
  if (!column || !rule.source.ref) return { clauses: [], exact: false };
  // a cell of a grid is not addressable by question id alone
  if (rule.source.rowCode || rule.source.columnId) return { clauses: [], exact: false };
  const key = rule.source.ref;
  const isQuestion = (rule.source.kind ?? "question") === "question";
  const scalar = !isQuestion || scalarAnswer(def, key);

  switch (rule.operator) {
    case "eq":
      if (scalar && scalarValue(rule.value)) return { clauses: [{ kind: "jsonEq", column, key, value: rule.value }], exact: true };
      return { clauses: [], exact: false };
    case "selected":
      // a scalar question: "selected X" is equality; a multi-select stores an
      // array, and `@>` on a nested array is not expressible per key here
      if (scalar && scalarValue(rule.value)) return { clauses: [{ kind: "jsonEq", column, key, value: rule.value }], exact: true };
      return { clauses: [{ kind: "hasKey", column, key }], exact: false };
    case "answered":
    case "isNotEmpty":
      // narrows correctly (an unanswered question has no key) but an answered
      // key can still hold an empty value, so the engine confirms
      return { clauses: [{ kind: "hasKey", column, key }], exact: false };
    case "gt": case "gte": case "lt": case "lte":
      if (scalar && typeof rule.value === "number") return { clauses: [{ kind: "compare", column, key, op: rule.operator, value: rule.value }], exact: false };
      return { clauses: [], exact: false };
    case "between":
      if (scalar && typeof rule.value === "number" && typeof rule.value2 === "number") {
        return { clauses: [{ kind: "compare", column, key, op: "gte", value: rule.value }, { kind: "compare", column, key, op: "lte", value: rule.value2 }], exact: false };
      }
      return { clauses: [], exact: false };
    case "contains":
      if (scalar && typeof rule.value === "string") return { clauses: [{ kind: "ilike", column, key, value: rule.value }], exact: false };
      return { clauses: [], exact: false };
    default:
      // ne / notIn / notSelected / unanswered / rank* / date* and the rest:
      // no clause narrows them safely (a row failing the positive test may
      // still match), so the engine decides over the unnarrowed set
      return { clauses: [], exact: false };
  }
}

/**
 * Compile a filter condition into prefilter clauses.
 *
 * Only a top-level AND of rules can contribute clauses: under an OR, a row
 * failing one branch may match another, so narrowing on any single branch
 * would drop matching rows. That is the whole safety rule — when in doubt,
 * emit nothing and let the engine decide.
 */
export function compileResponseFilter(def: SurveyDefinition, condition: Condition | null | undefined): CompiledResponseFilter {
  if (!condition) return { clauses: [], exact: true };
  if (condition.type === "rule") {
    const r = ruleClauses(def, condition);
    return { clauses: r.clauses, exact: r.exact, reason: r.exact ? undefined : `“${conditionSummary(def, condition)}” is evaluated by the survey engine` };
  }
  if (condition.op === "and") {
    const clauses: PrefilterClause[] = [];
    let exact = true;
    for (const child of condition.children) {
      const c = compileResponseFilter(def, child);
      clauses.push(...c.clauses);
      if (!c.exact) exact = false;
    }
    // an empty AND matches everything
    if (!condition.children.length) return { clauses: [], exact: true };
    return { clauses, exact, reason: exact ? undefined : "part of this filter is evaluated by the survey engine" };
  }
  // or / not: nothing can be narrowed safely
  return { clauses: [], exact: false, reason: `${condition.op.toUpperCase()} conditions are evaluated by the survey engine` };
}

/* ------------------------------------------------------------------ verdict */

export interface ResponseRow {
  session_id?: string;
  respondent_id?: string | null;
  status?: string;
  answers?: Record<string, unknown> | null;
  calculated?: Record<string, unknown> | null;
  embedded?: Record<string, unknown> | null;
  flags?: unknown;
  started_at?: string | null;
  seed?: number | string | null;
}

/** A stored response row as the engine's `ResponseState`. */
export function rowToState(def: SurveyDefinition, row: ResponseRow): ResponseState {
  return {
    surveyId: def.meta.id,
    surveyVersion: def.meta.version,
    sessionId: row.session_id ?? "",
    respondentId: row.respondent_id ?? undefined,
    seed: Number(row.seed ?? 0) || 0,
    startedAt: row.started_at ?? "",
    status: (row.status as ResponseState["status"]) ?? "complete",
    answers: (row.answers ?? {}) as ResponseState["answers"],
    embedded: (row.embedded ?? {}) as ResponseState["embedded"],
    calculated: (row.calculated ?? {}) as ResponseState["calculated"],
    flags: Array.isArray(row.flags) ? (row.flags as string[]) : [],
    stepIndex: 0,
  };
}

/**
 * Does this stored response match the filter? The canonical verdict — the
 * same evaluator the survey itself runs, so a filter can never disagree with
 * the logic that produced the data.
 */
export function matchesResponseCondition(
  def: SurveyDefinition,
  condition: Condition | null | undefined,
  row: ResponseRow,
  quotaCounts?: Record<string, Record<string, number>>,
): boolean {
  if (!condition) return true;
  return evaluateCondition(condition, { def, state: rowToState(def, row), quotaCounts });
}

/**
 * Free-text search across a response: its identifiers and every exported
 * variable value. One box that finds "TEST_000123", "Male" or an email,
 * matching what the researcher sees in the grid rather than raw answer keys.
 */
export function responseMatchesText(def: SurveyDefinition, row: ResponseRow & { respondent_code?: string | null }, needle: string): boolean {
  const q = needle.trim().toLowerCase();
  if (!q) return true;
  const ids = [row.respondent_code, row.session_id, row.respondent_id, row.status];
  for (const v of ids) if (v && String(v).toLowerCase().includes(q)) return true;
  const flat = flattenVariables(def, rowToState(def, row));
  for (const [k, v] of Object.entries(flat)) {
    if (v === null || v === undefined || v === "") continue;
    if (k.toLowerCase().includes(q)) return true;
    const s = Array.isArray(v) ? v.join(", ") : typeof v === "object" ? JSON.stringify(v) : String(v);
    if (s.toLowerCase().includes(q)) return true;
  }
  return false;
}

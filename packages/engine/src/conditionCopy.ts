import type { Condition, ConditionRule, Question, SurveyDefinition } from "@rescript/schema";
import { isQuestionValueRef } from "@rescript/schema";
import { mapConditionRoots, mapRules } from "./conditionWalk.js";
import { getQuestionByCodeOrVar } from "./state.js";

/**
 * COPYING AN EXPRESSION, AND REMAPPING ITS REFERENCES — TWO DIFFERENT THINGS.
 *
 * "Copy expression" is EXACT. What comes out is the condition that went in:
 * the same questions, rows, columns, answer codes, operators, constants and
 * nested groups, byte for byte. Putting it on another question changes where
 * it sits and nothing about what it says — a rule on Q9 that reads "Q2 row 1
 * answered 4" still reads Q2, not Q9.
 *
 * "Remap references" is a deliberate operation with a stated map ("everything
 * that read question A should read question B instead"), applied only where
 * somebody asked for it, and it returns what it rewrote so the caller can show
 * it and ask first. Question duplication is the one place the product itself
 * needs it: a copy's OWN rules must point at the copy.
 *
 * Neither one ever mutates its input.
 */

/** The exact copy. Plain JSON in, plain JSON out — nothing is resolved, renamed or re-keyed. */
export function copyCondition<C extends Condition | null | undefined>(c: C): C {
  return c ? structuredClone(c) : c;
}

export interface ReferenceMap {
  /** question id → question id */
  questions?: Record<string, string>;
  /** question id → { old column id → new column id } (composite / table grids, whose columns have ids of their own) */
  columns?: Record<string, Record<string, string>>;
}

export interface RemapResult<T> {
  value: T;
  /** one line per rewritten reference, in words — what a confirmation dialog lists */
  changes: string[];
}

const resolveId = (def: SurveyDefinition | undefined, ref: unknown): string | undefined => {
  if (typeof ref !== "string" || !ref) return undefined;
  if (!def) return ref;
  return getQuestionByCodeOrVar(def, ref)?.id ?? ref;
};

function remapRule(def: SurveyDefinition | undefined, rule: ConditionRule, map: ReferenceMap, changes: string[]): ConditionRule {
  let out = rule;
  const label = (id: string) => def?.questions.find((q) => q.id === id)?.code ?? id;
  const s = rule.source;
  if (s && (s.kind === "question" || s.kind === "variable")) {
    const id = resolveId(def, s.ref);
    const toQ = id ? map.questions?.[id] : undefined;
    const colMap = id ? map.columns?.[id] : undefined;
    let source = s;
    if (toQ && toQ !== s.ref) {
      changes.push(`${label(id!)} → ${label(toQ)}`);
      source = { ...source, ref: toQ };
    }
    if (colMap && s.columnId != null && colMap[String(s.columnId)] && colMap[String(s.columnId)] !== s.columnId) {
      changes.push(`${label(id!)} column ${s.columnId} → ${colMap[String(s.columnId)]}`);
      source = { ...source, columnId: colMap[String(s.columnId)] };
    }
    if (source !== s) out = { ...out, source };
  }
  /* a comparison against another question's answer */
  const v = out.value;
  if (isQuestionValueRef(v)) {
    const id = resolveId(def, v.$question);
    const toQ = id ? map.questions?.[id] : undefined;
    const colMap = id ? map.columns?.[id] : undefined;
    let next = v;
    if (toQ && toQ !== v.$question) { changes.push(`compares with ${label(id!)} → ${label(toQ)}`); next = { ...next, $question: toQ }; }
    if (colMap && v.columnId != null && colMap[String(v.columnId)]) next = { ...next, columnId: colMap[String(v.columnId)] };
    if (next !== v) out = { ...out, value: next };
  }
  return out;
}

/** One condition with the mapped references rewritten. Rules the map does not mention come back as the same objects. */
export function remapConditionReferences(
  c: Condition,
  map: ReferenceMap,
  def?: SurveyDefinition,
): RemapResult<Condition> {
  const changes: string[] = [];
  const value = mapRules(c, (r) => remapRule(def, r, map, changes));
  return { value, changes: [...new Set(changes)] };
}

/**
 * A DUPLICATED QUESTION'S OWN RULES POINT AT THE DUPLICATE.
 *
 * The copy of "Q5, skip to the end when Q5 = 1" read the ORIGINAL's answer,
 * so the copy skipped (or did not) according to a question it was no longer
 * about. Rules in the copy that name the original are rewritten to name the
 * copy; rules that name any OTHER question are not touched, and the original
 * is never modified. A composite or table grid's columns carry ids of their
 * own, which a duplicate re-mints, so the copy's rules about its own columns
 * follow them.
 */
export function pointCopyAtItself(
  copy: Question,
  original: { id: string; columnIds: string[] },
  copyColumnIds: string[],
): string[] {
  const columns: Record<string, string> = {};
  original.columnIds.forEach((old, i) => { if (copyColumnIds[i] && copyColumnIds[i] !== old) columns[old] = copyColumnIds[i]; });
  const map: ReferenceMap = { questions: { [original.id]: copy.id }, columns: { [original.id]: columns } };
  const changes: string[] = [];
  const holder = { questions: [copy] } as unknown as SurveyDefinition;
  const next = mapConditionRoots(holder, (c) => {
    const r = remapConditionReferences(c, map);
    changes.push(...r.changes);
    return r.value;
  });
  if (next !== holder) Object.assign(copy, (next as unknown as { questions: Question[] }).questions[0]);
  return [...new Set(changes)];
}

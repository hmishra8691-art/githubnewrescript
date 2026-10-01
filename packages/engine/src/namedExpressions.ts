/**
 * NAMED EXPRESSIONS — a condition written once, referenced everywhere (§34–35).
 *
 *   IS_HIGH_VALUE   =  Income > 100000 AND PurchaseFrequency >= 5
 *   HAS_APPLE       =  Q2.apple
 *
 *   IF IS_HIGH_VALUE AND HAS_APPLE THEN SHOW Q10
 *
 * The implementation is a source kind and a resolver, and that is deliberate.
 * A reference is `{ kind: "rule", ref: <id> }` inside an ordinary
 * `ConditionRule`, so it evaluates through `evaluateCondition` like everything
 * else — which means display logic, skip logic, masking, option / row /
 * column logic, eligibility, auto punch, auto select, list logic, list
 * operations, branching, loop conditions, quota cells and validation all
 * support it without a line of change in any of them.
 *
 * ## WHY NOT A CALCULATION
 *
 * `def.calculations` is the closest existing thing, and it is the wrong shape.
 * A calculation is a stored string in the CALC language, evaluated on a
 * trigger and snapshotted into a variable. A named expression is a live
 * predicate in the CONDITION language, evaluated where it is used. The
 * difference shows the moment an answer changes after the trigger fired — the
 * calculation is stale and the expression is not — and only the condition
 * language can express `selected`, `containsAny`, ranking and counts.
 *
 * ## RECURSION
 *
 * A macro that references itself, or two that reference each other, is not a
 * wrong answer — it is a hang. The evaluator carries a resolution stack and
 * refuses to re-enter an expression it is already inside; `lintNamedExpressions`
 * finds the same cycles by reading the definition, so a programmer is told
 * before a respondent is.
 */
import type { Condition, NamedExpression, SurveyDefinition } from "@rescript/schema";
import { forEachConditionRoot, forEachRule } from "./conditionWalk.js";

/** Every named expression by id, and by name — a reference may use either. */
export function namedExpressionIndex(def: SurveyDefinition): Map<string, NamedExpression> {
  const out = new Map<string, NamedExpression>();
  for (const e of def.namedExpressions ?? []) {
    out.set(e.id, e);
    /*
     * The NAME is also accepted as a reference. A stored reference always uses
     * the id — so renaming is free — but a hand-written definition, an import
     * or an expression typed before the id existed reads naturally, and
     * resolving it is one more map entry rather than a special case at every
     * call site.
     */
    const n = e.name?.trim();
    if (n && !out.has(n)) out.set(n, e);
  }
  return out;
}

export function findNamedExpression(
  def: SurveyDefinition,
  ref: string,
): NamedExpression | undefined {
  return namedExpressionIndex(def).get(ref)
    /* case-insensitively too: IS_HIGH_VALUE and is_high_value are one macro */
    ?? (def.namedExpressions ?? []).find(
      (e) => e.name?.toLowerCase() === ref.toLowerCase(),
    );
}

/* ------------------------------------------------------------------- lint */

/**
 * Cycles among named expressions.
 *
 * Returned as the chain that closes the loop, so the message can name it:
 * "IS_ELIGIBLE → IS_HIGH_VALUE → IS_ELIGIBLE".
 */
export function namedExpressionCycles(def: SurveyDefinition): string[][] {
  const byId = new Map((def.namedExpressions ?? []).map((e) => [e.id, e]));
  const index = namedExpressionIndex(def);

  /** Which expressions does this tree reference, directly? (COUNT wheres included) */
  const refsOf = (c: Condition | undefined): string[] => {
    const out: string[] = [];
    forEachRule(c, (r) => {
      if (r.source?.kind !== "rule") return;
      const target = index.get(r.source.ref);
      if (target) out.push(target.id);
    });
    return out;
  };

  const cycles: string[][] = [];
  const seen = new Set<string>();
  const state = new Map<string, 0 | 1 | 2>();
  const stack: string[] = [];

  const walk = (id: string): void => {
    const st = state.get(id) ?? 0;
    if (st === 2) return;
    if (st === 1) {
      /* the cycle is the tail of the stack from the first sighting of `id` */
      const from = stack.indexOf(id);
      const chain = [...stack.slice(from), id];
      const key = [...chain].slice(0, -1).sort().join("|");
      if (!seen.has(key)) { seen.add(key); cycles.push(chain); }
      return;
    }
    state.set(id, 1);
    stack.push(id);
    for (const next of refsOf(byId.get(id)?.when)) walk(next);
    stack.pop();
    state.set(id, 2);
  };

  for (const e of def.namedExpressions ?? []) walk(e.id);
  return cycles;
}

/** Problems a programmer should be told about before deployment (§46). */
export function lintNamedExpressions(def: SurveyDefinition): string[] {
  const out: string[] = [];
  const list = def.namedExpressions ?? [];
  if (!list.length) return out;

  const names = new Map<string, number>();
  for (const e of list) {
    const n = (e.name ?? "").trim();
    if (!n) {
      out.push("A named expression has no name, so nothing can reference it.");
      continue;
    }
    names.set(n.toLowerCase(), (names.get(n.toLowerCase()) ?? 0) + 1);
  }
  for (const [n, count] of names) {
    if (count > 1) {
      out.push(
        `${count} named expressions are called “${n}”. A reference by name reaches the first, `
        + "so the others can never be used — rename them or reference them by id.",
      );
    }
  }

  /* references that point at nothing */
  const index = namedExpressionIndex(def);
  const checkRefs = (c: Condition | undefined, where: string): void => {
    forEachRule(c, (r) => {
      if (r.source?.kind === "rule" && !index.get(r.source.ref)) {
        out.push(`${where} references the named expression “${r.source.ref}”, which does not exist.`);
      }
    });
  };
  for (const e of list) checkRefs(e.when, `“${e.name}”`);

  for (const chain of namedExpressionCycles(def)) {
    const nameOf = (id: string) => list.find((e) => e.id === id)?.name ?? id;
    out.push(
      `Circular named expressions: ${chain.map(nameOf).join(" → ")}. `
      + "Each one waits for the next, so none of them can ever produce an answer.",
    );
  }

  return out;
}

/**
 * Every place in the survey that references a named expression.
 *
 * What makes deleting one safe: the editor can say "used by 4 rules" and name
 * them, instead of removing a definition and leaving four rules that silently
 * stop matching.
 */
export function namedExpressionUsage(
  def: SurveyDefinition,
): Map<string, { where: string; id?: string }[]> {
  const index = namedExpressionIndex(def);
  const out = new Map<string, { where: string; id?: string }[]>();
  const note = (ref: string, where: string, id?: string) => {
    const target = index.get(ref);
    if (!target) return;
    const list = out.get(target.id) ?? [];
    list.push({ where, id });
    out.set(target.id, list);
  };

  /*
   * EVERY place, found structurally — display and skip logic, validation,
   * punches, masks, option / row / column / group logic, list logic, flow
   * nodes, branches, loops, display rules, calculations, quota cells, list
   * fills, other named expressions, and the conditions inside COUNTs. The
   * hand-written list this replaced covered about half of them, so "used by
   * 0" could be said of an expression that four rules still needed.
   */
  forEachConditionRoot(def, (c, loc) => {
    forEachRule(c, (r) => { if (r.source?.kind === "rule") note(r.source.ref, loc.where, loc.questionId); });
  });

  return out;
}

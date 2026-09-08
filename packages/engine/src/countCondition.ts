/**
 * COUNT CONDITIONS — "how many of these qualify?"
 *
 * The evaluator behind `ConditionSource.count`. One implementation, reached
 * from `resolveSourceValue`, which is why a count works in display logic,
 * skip logic, masking, option / row / column logic, eligibility, auto select,
 * auto punch, list logic, list operations, branching, loop conditions, quota
 * cells and validation `when` clauses without any of them knowing it exists.
 *
 * ## WHAT IT RETURNS
 *
 * A number, or `null` when the question cannot be resolved at all. `null` is
 * not zero: every comparison operator in the engine already treats a null
 * left-hand side as "does not compare", so a count against a deleted question
 * fails its rule rather than quietly satisfying `<= 5`. That distinction is
 * the difference between a broken rule that shows itself and a broken rule
 * that silently shows a question to everybody.
 *
 * ## THE THREE FILTERS, IN ORDER
 *
 * The pool is narrowed before anything is counted:
 *
 *   1. `scope`  — options, rows or columns of the question
 *   2. `group`  — members of one option group, if the question has groups
 *   3. `only`   — an explicit subset of codes / ids
 *
 * `only` and `group` intersect rather than replace, so "the members of Group A
 * that are also in this shortlist" is expressible and means what it says.
 *
 * ## A NOTE ON `valid` AND `invalid`
 *
 * They mean what validation means: an item holding an answer that PASSES, or
 * FAILS, the validation rules attached to that item. An unanswered item is
 * neither — it is missing, and `notSelected` already counts those. Where an
 * item carries no validation of its own, `valid` is "answered" and `invalid`
 * is zero. Nothing here invents a notion of validity that a question type does
 * not have.
 */
import type {
  Condition, ConditionSource, CountSpec, Option, Question, QuestionColumn, QuestionRow,
  SurveyDefinition,
} from "@rescript/schema";
import type { EvalContext } from "./evaluate.js";
import { evaluateCondition, withOption } from "./evaluate.js";
import { answerKey, getQuestionByCodeOrVar } from "./state.js";
import { effectiveQuestion, carrySourceOptions, carrySourceRows } from "./carryforward.js";
import { checkScalarRules } from "./validate.js";

const str = (v: unknown) => String(v);
const has = (set: Set<string>, v: unknown) => set.has(str(v));

function isEmptyValue(v: unknown): boolean {
  if (v === null || v === undefined || v === "") return true;
  if (Array.isArray(v)) return v.length === 0;
  if (typeof v === "object") return Object.values(v as object).every((x) => isEmptyValue(x));
  return false;
}

/**
 * The codes a stored answer counts as "selected".
 *
 * Every collection-shaped answer in the platform reduces to a set of codes,
 * and they do not all look alike:
 *
 *   multi / multi_dropdown      ["a", "c"]
 *   ranking                     ["c", "a", "b"]   (order is rank)
 *   single / dropdown / scale   "a"                (a scalar is one selection)
 *   allocation                  { a: 30, b: 0 }    (0 is not a selection)
 *   matrix row                  "4"  or  ["4","5"]
 *
 * An allocation of zero is deliberately NOT selected: a respondent who typed 0
 * against an option has considered it and given it nothing, which is the
 * opposite of choosing it.
 */
export function selectedCodes(value: unknown): string[] {
  if (value === null || value === undefined || value === "") return [];
  if (Array.isArray(value)) return value.filter((v) => v !== null && v !== undefined && v !== "").map(str);
  if (typeof value === "object") {
    return Object.entries(value as Record<string, unknown>)
      .filter(([, v]) => {
        const n = Number(v);
        return Number.isFinite(n) ? n > 0 : !isEmptyValue(v);
      })
      .map(([k]) => k);
  }
  return [str(value)];
}

/** The members of one option group, by group id. Empty when there is no such group. */
function groupMembers(q: Question, spec: CountSpec): Set<string> | null {
  if (!spec.group) return null;
  const groups = (q as unknown as { optionGroups?: { id: string; scope?: string; members?: (string | number)[] }[] })
    .optionGroups;
  const g = (groups ?? []).find((x) => x.id === spec.group);
  /*
   * A named group that does not exist counts NOTHING rather than everything.
   * Returning the whole collection would make a typo'd group id look like a
   * rule that works, and it would work in exactly the wrong direction.
   */
  return new Set((g?.members ?? []).map(str));
}

interface Item {
  key: string;
  label: string;
  /** the answer stored against this item, where the scope has per-item answers */
  value: unknown;
  /** validation attached to this item, if the item type carries any */
  validation?: { kind: string }[];
}

/**
 * The pool, narrowed by scope, group and `only` — before anything is counted.
 *
 * Reads the question's carry-forward-resolved rows / options — stage 1 of
 * the option pipeline (`carrySourceRows` / `carrySourceOptions`), the full
 * configured universe carry-forward produces — not the static schema arrays,
 * and NOT the fully pipeline-resolved `effectiveQuestion` result either.
 *
 * That distinction matters: "eligible" / "visible" / "hidden" below compare
 * this pool against `shownKeys`, which IS the final pipeline output — if pool
 * were the same final output, "hidden" would always be empty by construction
 * (everything in the pool would always be "shown"). Using the pre-eligibility
 * universe here mirrors exactly what a plain question's static `options`
 * array already meant for that comparison: every configured item, whether or
 * not this respondent's answers currently keep it visible.
 *
 * Before this, a carry-forward matrix had no rows in the static schema at
 * all — they only exist as a runtime computation from another question's
 * answer — so every COUNT / ANY / ALL / NONE condition against a
 * carry-forward collection silently evaluated to 0, with nothing on screen to
 * say why. For a question with no carry-forward, `carrySourceRows` /
 * `carrySourceOptions` return the same arrays the static read did, so this is
 * not a behavior change for the overwhelming majority of questions.
 */
function pool(q: Question, spec: CountSpec, answer: unknown, ctx: EvalContext): Item[] {
  const only = spec.only ? new Set(spec.only.map(str)) : null;
  const members = groupMembers(q, spec);
  const keep = (key: string) =>
    (!only || only.has(key)) && (!members || members.has(key));

  if (spec.scope === "rows") {
    const rowValue = (code: string) =>
      answer && typeof answer === "object" && !Array.isArray(answer)
        ? (answer as Record<string, unknown>)[code]
        : undefined;
    return carrySourceRows(q, ctx)
      .map((r: QuestionRow) => ({
        key: str(r.code), label: r.label, value: rowValue(str(r.code)),
        validation: r.validation as { kind: string }[] | undefined,
      }))
      .filter((i) => keep(i.key));
  }

  if (spec.scope === "columns") {
    /*
     * A column holds no single answer — it holds one per row. Its "value" is
     * therefore the set of that column's cell values across every row, which
     * is what makes "count columns that were used" answerable.
     */
    const cells = (id: string): unknown[] => {
      if (!answer || typeof answer !== "object" || Array.isArray(answer)) return [];
      return Object.values(answer as Record<string, unknown>)
        .map((row) => (row && typeof row === "object" ? (row as Record<string, unknown>)[id] : undefined))
        .filter((v) => !isEmptyValue(v));
    };
    return (q.columns ?? [])
      .map((c: QuestionColumn) => ({
        key: c.id, label: c.label, value: cells(c.id),
        validation: c.validation as { kind: string }[] | undefined,
      }))
      .filter((i) => keep(i.key));
  }

  return carrySourceOptions(q, ctx)
    .map((o: Option) => ({ key: str(o.code), label: o.label, value: undefined }))
    .filter((i) => keep(i.key));
}

/** The same pool as the respondent is actually shown, for eligible/visible/hidden. */
function shownKeys(q: Question, spec: CountSpec, ctx: EvalContext): Set<string> {
  const view = effectiveQuestion(q, ctx);
  if (spec.scope === "rows") return new Set((view.rows ?? []).map((r) => str(r.code)));
  if (spec.scope === "columns") return new Set((view.columns ?? []).map((c) => c.id));
  return new Set((view.options ?? []).map((o) => str(o.code)));
}

/** Does this item's own validation accept the answer it holds? */
function itemIsValid(item: Item, ctx: EvalContext): boolean {
  if (!item.validation?.length) return true;
  let failed = false;
  checkScalarRules(
    item.validation as never,
    item.value,
    ctx,
    (_msg, severity) => { if (severity !== "warning") failed = true; },
  );
  return !failed;
}

/**
 * Evaluate a count. Returns `null` when the question cannot be resolved —
 * see the header on why that is not zero.
 */
export function evaluateCount(source: ConditionSource, ctx: EvalContext): number | null {
  const spec = source.count;
  if (!spec) return null;

  const def: SurveyDefinition = ctx.def;
  const q = getQuestionByCodeOrVar(def, source.ref);
  if (!q) return null;

  const answer = ctx.state.answers[answerKey(q.id, ctx.loop ?? null)];
  const items = pool(q, spec, answer, ctx);

  switch (spec.of) {
    case "selected":
    case "notSelected": {
      const wanted = spec.of === "selected";
      if (spec.scope === "options") {
        const chosen = new Set(selectedCodes(answer));
        return items.filter((i) => has(chosen, i.key) === wanted).length;
      }
      /* rows and columns are "selected" when they hold an answer */
      return items.filter((i) => !isEmptyValue(i.value) === wanted).length;
    }

    case "valid":
    case "invalid": {
      const wantValid = spec.of === "valid";
      if (spec.scope === "options") {
        /*
         * An option carries no validation of its own, so a selected option is
         * a valid one and nothing is ever invalid. Stated here rather than
         * left for somebody to discover from a rule that never fires.
         */
        const chosen = new Set(selectedCodes(answer));
        return wantValid ? items.filter((i) => has(chosen, i.key)).length : 0;
      }
      const answered = items.filter((i) => !isEmptyValue(i.value));
      return answered.filter((i) => itemIsValid(i, ctx) === wantValid).length;
    }

    case "eligible":
    case "visible": {
      const shown = shownKeys(q, spec, ctx);
      return items.filter((i) => shown.has(i.key)).length;
    }
    case "hidden": {
      const shown = shownKeys(q, spec, ctx);
      return items.filter((i) => !shown.has(i.key)).length;
    }

    case "matching": {
      /*
       * The grid case first, because it is the common one: count rows whose
       * answer is one of these column codes. A multi-response row matches when
       * it holds ANY of them, which is what "rated Good or Very Good" means.
       */
      if (spec.responseIn?.length) {
        const wanted = new Set(spec.responseIn.map(str));
        return items.filter((i) => {
          if (spec.scope === "options") {
            /* on an options pool `responseIn` is a plain subset test */
            const chosen = new Set(selectedCodes(answer));
            return has(chosen, i.key) && wanted.has(i.key);
          }
          return selectedCodes(i.value).some((v) => wanted.has(v));
        }).length;
      }
      if (!spec.where) return 0;
      return items.filter((i) => matches(spec.where!, q, i, spec, ctx)).length;
    }
  }
  return null;
}

/**
 * Evaluate `where` for one item.
 *
 * The item is put in scope as the option under test, so `{ $option: "code" }`
 * and `kind: "option"` sources behave exactly as they do in option-level
 * logic — one mental model, not a second one that only counts use.
 *
 * For a row, the row's own answer is also addressable the ordinary way
 * (`source.rowCode`), so a `where` can compare a row's response without any
 * new vocabulary.
 */
function matches(
  where: Condition,
  q: Question,
  item: Item,
  spec: CountSpec,
  ctx: EvalContext,
): boolean {
  const inner = withOption(ctx, {
    code: item.key,
    label: item.label,
    // for rows/columns this is the item's own stored answer — an object for
    // a multi-column matrix cell, which `columnId` (evaluate.ts) drills into
    value: spec.scope === "options" ? item.key : item.value,
    index: 0,
  });
  return evaluateCondition(where, inner);
}

/**
 * Lint: a count that can never be satisfied, or that names something gone.
 *
 * Studio shows these beside the rule. A count of a question with four options
 * compared `>= 7` is not an error the engine can refuse — it evaluates
 * perfectly well and is simply always false — so it has to be caught by
 * reading the definition.
 */
export function lintCount(def: SurveyDefinition, source: ConditionSource, operator: string, value: unknown): string[] {
  const spec = source.count;
  if (!spec) return [];
  const out: string[] = [];
  const q = getQuestionByCodeOrVar(def, source.ref);
  if (!q) {
    out.push(`Count refers to "${source.ref}", which is not a question in this survey.`);
    return out;
  }

  const collection = spec.scope === "rows" ? q.rows : spec.scope === "columns" ? q.columns : q.options;
  const size = (collection ?? []).length;
  /*
   * A carry-forward question's real size is unknowable at design time — its
   * rows/options/columns for the scope carry-forward feeds only exist once a
   * respondent has answered the source question, so the static collection is
   * legitimately empty (or, with `keepOwn`, incomplete) for a question that
   * is working exactly as programmed. Every warning below that depends on
   * "how many are there" or "which codes exist" would be false for that
   * scope, so each is skipped for it rather than printed with a guess.
   * Warnings unrelated to size (a missing option group, an unconfigured
   * `matching` count) still run — they are about the SAME question but not
   * about a fact only the runtime pipeline knows.
   */
  const isDynamicScope = q.carryForward?.into === spec.scope;
  if (size === 0 && !isDynamicScope) {
    out.push(`${q.code} has no ${spec.scope} to count.`);
    return out;
  }

  if (spec.only?.length && !isDynamicScope) {
    const keys = new Set(
      spec.scope === "columns"
        ? (q.columns ?? []).map((c) => c.id)
        : ((collection ?? []) as { code: string | number }[]).map((x) => str(x.code)),
    );
    const missing = spec.only.filter((k) => !keys.has(str(k)));
    if (missing.length) {
      out.push(`Count of ${q.code} lists ${spec.scope} that no longer exist: ${missing.join(", ")}.`);
    }
  }

  if (spec.group) {
    const groups = (q as unknown as { optionGroups?: { id: string; name?: string }[] }).optionGroups ?? [];
    if (!groups.some((g) => g.id === spec.group)) {
      out.push(`Count names group "${spec.group}", which ${q.code} does not have — it will count nothing.`);
    }
  }

  const n = Number(value);
  if (Number.isFinite(n)) {
    // `only` narrows to a fixed, known-size subset even on a dynamic scope;
    // otherwise the max is unknowable for a dynamic scope, same reasoning as above.
    const max = spec.only?.length ?? (isDynamicScope ? null : size);
    if (max != null && (operator === "gte" || operator === "gt" || operator === "eq") && n > max) {
      out.push(
        `Count of ${q.code} can never reach ${n} — there ${max === 1 ? "is" : "are"} only ${max} `
        + `${spec.scope === "options" ? "option" : spec.scope === "rows" ? "row" : "column"}${max === 1 ? "" : "s"} to count.`,
      );
    }
    if (n < 0) out.push("A count cannot be negative.");
  }

  if (spec.of === "matching" && !spec.responseIn?.length && !spec.where) {
    out.push(`Count of ${q.code} matches nothing — give it either a set of responses or a condition.`);
  }
  if (spec.of === "invalid" && spec.scope === "options") {
    out.push(`Options carry no validation of their own, so "count invalid" on ${q.code} is always 0.`);
  }

  return out;
}

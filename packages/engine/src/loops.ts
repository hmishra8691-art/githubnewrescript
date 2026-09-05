import type {
  Condition, FlowNode, LoopCount, LoopCountValue, LoopOrder, LoopReferenceColumn, LoopReferences,
  LoopSource, SurveyDefinition,
} from "@rescript/schema";
import { codesFrom } from "./carryforward.js";
import { evaluateCondition, type EvalContext } from "./evaluate.js";
import { listFillLoopItems, listFillVariableNames } from "./listFill.js";
import type { QuotaCounts } from "./quotas.js";
import { mulberry32, seededShuffle, subSeed } from "./random.js";
import {
  getQuestion, getQuestionByCodeOrVar, lookupAnswer,
  type LoopContext, type LoopReferenceValue, type ResponseState,
} from "./state.js";
import { directChildLoops, loopNodes, loopVariablePrefix, type LoopFlowNode } from "./loopModel.js";
export * from "./loopModel.js";

/**
 * THE LOOP ENGINE — which items a loop runs over, in what order, how many, and
 * what each iteration knows about itself.
 *
 * This is the pure half. `compileFlow` calls `resolveLoopItems` once per loop
 * node per compile and walks the children once per item; the Studio's
 * simulator calls the same function against a hypothetical state; the
 * inspector reads the same context. There is no second copy of "which items
 * qualify" anywhere — a preview and a live respondent can only ever disagree
 * if the data they are given disagrees.
 *
 * THE PIPELINE, in the order the requirement states it (§42):
 *
 *     source           question / static / design / List Fill / count / variable
 *       → filter       selected / not selected / displayed / all / invalid / eligible
 *       → eligibleIf   a per-item condition that can read the item's own references
 *       → order        source / selection / List Fill / priority / random / weighted / custom
 *       → count        all / exact / max / min
 *       → contexts     one LoopContext per surviving item, references attached
 *
 * WHERE REFERENCES COME FROM. A loop node may carry `references` — its own
 * columns and one row per item code. `referenceRow` reads that table and
 * nothing else. It does not look at the source question, does not consult any
 * survey-level dictionary, and cannot see another loop's table. That is the
 * spec's central rule (§2, §5, §20, §43) expressed as a function with one
 * input.
 */


export interface LoopItem {
  code: string;
  label: string;
  /** this item's row of the loop's reference table, typed per column */
  references: Record<string, LoopReferenceValue>;
  /** position in the source (option order, static order, allocation order) */
  sourceIndex: number;
  /** position in the respondent's answer, when the source is an answer */
  selectionIndex?: number;
}

/* ------------------------------------------------------------ references */

/** Coerce a stored reference value to its column's declared type. */
export function coerceReference(v: unknown, col?: LoopReferenceColumn): LoopReferenceValue {
  if (v === null || v === undefined || v === "") return null;
  switch (col?.dataType) {
    case "number": {
      const n = typeof v === "number" ? v : Number(String(v).trim());
      return Number.isFinite(n) ? n : null;
    }
    case "boolean": {
      if (typeof v === "boolean") return v;
      const s = String(v).trim().toLowerCase();
      if (["true", "yes", "y", "1"].includes(s)) return true;
      if (["false", "no", "n", "0"].includes(s)) return false;
      return null;
    }
    default:
      return typeof v === "string" ? v : String(v);
  }
}

/**
 * One item's references, from THIS loop's table only.
 *
 * Every declared column is present in the result — as `null` when the table
 * has no value for this item — so `{{loop.Category}}` on an unlisted item
 * pipes an empty string rather than the label, and a condition on it compares
 * against null rather than against a code. Columns nobody declared are not
 * invented from stray keys in the values row.
 */
export function referenceRow(refs: LoopReferences | undefined, code: string): Record<string, LoopReferenceValue> {
  const out: Record<string, LoopReferenceValue> = {};
  if (!refs) return out;
  const row = refs.values?.[code] ?? {};
  for (const col of refs.columns) out[col.name] = coerceReference(row[col.name], col);
  return out;
}

/* ------------------------------------------------------------ numbers */

/** A count the loop needs, resolved against the respondent's data. */
export function resolveLoopCount(
  def: SurveyDefinition,
  state: ResponseState,
  value: LoopCountValue | undefined,
  loop: LoopContext | null,
): number | null {
  if (value == null) return null;
  if (typeof value === "number") return Number.isFinite(value) ? Math.max(0, Math.trunc(value)) : null;
  let raw: unknown;
  switch (value.kind) {
    case "question": {
      const q = getQuestionByCodeOrVar(def, value.ref);
      raw = lookupAnswer(state.answers, q?.id ?? value.ref, loop);
      // a multi-select's "count" is how many were chosen; a numeric's is its value
      if (Array.isArray(raw)) raw = raw.length;
      else if (raw && typeof raw === "object") raw = Object.keys(raw as object).length;
      break;
    }
    case "calculation":
      raw = state.calculated[value.ref];
      break;
    case "embedded":
      raw = state.embedded[value.ref];
      break;
    case "variable":
    default:
      raw = state.calculated[value.ref] ?? state.embedded[value.ref]
        ?? lookupAnswer(state.answers, getQuestionByCodeOrVar(def, value.ref)?.id ?? value.ref, loop);
      if (Array.isArray(raw)) raw = raw.length;
      break;
  }
  const n = Number(raw);
  return Number.isFinite(n) ? Math.max(0, Math.trunc(n)) : null;
}

/* ------------------------------------------------------------ candidates */

/** A delimited string, a JSON array, or an object's keys, as codes. */
function asList(v: unknown, separator?: string): { code: string; label: string }[] {
  if (v == null || v === "") return [];
  if (Array.isArray(v)) {
    return v.map((x) =>
      x && typeof x === "object"
        ? { code: String((x as any).code ?? (x as any).value ?? ""), label: String((x as any).label ?? (x as any).code ?? "") }
        : { code: String(x), label: String(x) },
    ).filter((x) => x.code !== "");
  }
  if (typeof v === "object") return Object.keys(v as object).map((k) => ({ code: k, label: k }));
  const s = String(v).trim();
  if (s.startsWith("[")) {
    try { return asList(JSON.parse(s)); } catch { /* fall through to delimited */ }
  }
  const sep = separator ? new RegExp(separator.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")) : /[,;|\n]/;
  return s.split(sep).map((x) => x.trim()).filter(Boolean).map((c) => ({ code: c, label: c }));
}

/**
 * Every item the source offers BEFORE the loop's own filtering, with where it
 * sits in the source and, when the source is an answer, where it sits in the
 * respondent's selection.
 */
function candidates(
  def: SurveyDefinition,
  state: ResponseState,
  node: LoopFlowNode,
  parent: LoopContext | null,
  quotaCounts?: QuotaCounts,
): LoopItem[] {
  const source: LoopSource = node.source;
  const ctx: EvalContext = { def, state, loop: parent, quotaCounts };
  const withRefs = (items: { code: string; label: string; selectionIndex?: number }[]): LoopItem[] =>
    items.map((it, i) => ({
      ...it,
      code: String(it.code),
      sourceIndex: i,
      references: referenceRow(node.references, String(it.code)),
    }));

  switch (source.kind) {
    case "static":
      return withRefs(source.items);

    case "design": {
      const design = def.designs.find((d) => d.id === source.designId);
      const rows = design?.file?.rows ?? [];
      return withRefs(rows.map((r, i) => ({ code: String((r as any).task ?? i + 1), label: `Task ${i + 1}` })));
    }

    case "listFill":
      /*
       * One iteration per item a List Fill ALREADY allocated to this
       * respondent. The flow never decides an allocation: it recompiles after
       * every answer, and re-deciding would both hand out different items and
       * consume sample capacity again. The allocation is made once,
       * atomically, and lands in `state.calculated` as LISTFILL_* — this reads
       * it back. The reference table is the loop's, keyed by the allocated
       * codes, so a List Fill followed by a loop still has every column the
       * loop declared (§25) without the List Fill or Q2 learning anything (§26).
       */
      return withRefs(listFillLoopItems(def, state, source.listFillId));

    case "count": {
      const n = resolveLoopCount(def, state, source.count, parent) ?? 0;
      return withRefs(Array.from({ length: n }, (_, i) => ({ code: String(i + 1), label: String(i + 1) })));
    }

    case "variable": {
      const q = getQuestionByCodeOrVar(def, source.ref);
      const raw = state.calculated[source.ref] ?? state.embedded[source.ref]
        ?? lookupAnswer(state.answers, q?.id ?? source.ref, parent);
      return withRefs(asList(raw, source.separator));
    }

    case "question": {
      const src = getQuestion(def, source.questionId);
      if (!src) return [];
      const optionIndex = new Map(src.options.map((o, i) => [String(o.code), i]));
      const labelOf = (c: string) => src.options.find((o) => String(o.code) === c)?.label ?? c;
      const filter = source.filter ?? "selected";

      // the respondent's own selection, in the order they made it
      const answer = lookupAnswer(state.answers, src.id, parent);
      const selectedCodes = (Array.isArray(answer) ? answer
        : answer == null ? []
        : typeof answer === "object" ? Object.keys(answer as object)
        : [answer]).map(String);
      const selectionIndex = new Map(selectedCodes.map((c, i) => [c, i]));

      let codes: string[];
      switch (filter) {
        case "selected":
          codes = codesFrom(src.id, "selected", ctx).map(String);
          break;
        case "notSelected":
          codes = codesFrom(src.id, "not_selected", ctx).map(String);
          break;
        case "displayed":
          codes = codesFrom(src.id, "displayed", ctx).map(String);
          break;
        case "invalid": {
          /*
           * "Invalid" is whatever the programmer says it is (§11): every
           * option for which `invalidIf` holds, plus any code in the answer
           * that matches no option at all — the one kind of invalidity that
           * needs no rule to define it.
           */
          const unknown = selectedCodes.filter((c) => !optionIndex.has(c));
          const ruled = node.invalidIf
            ? src.options
                .map((o) => String(o.code))
                .filter((c) => evaluateCondition(node.invalidIf, {
                  def, state, quotaCounts,
                  loop: contextFor(node, { code: c, label: labelOf(c), references: referenceRow(node.references, c), sourceIndex: optionIndex.get(c) ?? 0 }, 0, 0, parent),
                }))
            : [];
          codes = [...new Set([...unknown, ...ruled])];
          break;
        }
        case "eligible":
        case "all":
        default:
          codes = src.options.map((o) => String(o.code));
          break;
      }

      // source order is the option order; unknown codes go last, in answer order
      const items = codes.map((c) => ({
        code: c, label: labelOf(c),
        sourceIndex: optionIndex.get(c) ?? src.options.length + (selectionIndex.get(c) ?? 0),
        selectionIndex: selectionIndex.get(c),
        references: referenceRow(node.references, c),
      }));
      return items;
    }
  }
}

/* ------------------------------------------------------------ context */

/** The context one iteration runs in. `index`/`count` are 1-based and total. */
export function contextFor(
  node: LoopFlowNode,
  item: Pick<LoopItem, "code" | "label" | "references" | "sourceIndex">,
  index: number,
  count: number,
  parent: LoopContext | null,
): LoopContext {
  return {
    loopVar: node.loopVar,
    loopId: node.id,
    code: item.code,
    label: item.label,
    index,
    count,
    references: item.references,
    parent: parent ?? null,
  };
}

/* ------------------------------------------------------------ order */

function referenceSortValue(item: LoopItem, column?: string): number | string | null {
  if (!column) return null;
  const v = item.references[column];
  if (v === null || v === undefined) return null;
  if (typeof v === "boolean") return v ? 1 : 0;
  if (typeof v === "number") return v;
  const n = Number(v);
  return Number.isFinite(n) && String(v).trim() !== "" ? n : String(v);
}

function compareValues(a: number | string | null, b: number | string | null): number {
  // nulls sort last whatever the direction
  if (a === null && b === null) return 0;
  if (a === null) return 1;
  if (b === null) return -1;
  if (typeof a === "number" && typeof b === "number") return a - b;
  return String(a).localeCompare(String(b), undefined, { numeric: true });
}

/**
 * Weighted draw without replacement, seeded — the same respondent always gets
 * the same order, and a heavier weight is more likely to come first. A
 * missing or non-positive weight counts as 1 so an unlisted item still takes
 * part rather than silently vanishing.
 */
function weightedOrder(items: LoopItem[], column: string | undefined, seed: number): LoopItem[] {
  const rnd = mulberry32(seed);
  const pool = items.map((it) => {
    const w = column ? Number(it.references[column]) : NaN;
    return { it, w: Number.isFinite(w) && w > 0 ? w : 1 };
  });
  const out: LoopItem[] = [];
  while (pool.length) {
    const total = pool.reduce((s, p) => s + p.w, 0);
    let r = rnd() * total;
    let idx = pool.length - 1;
    for (let i = 0; i < pool.length; i++) {
      r -= pool[i].w;
      if (r <= 0) { idx = i; break; }
    }
    out.push(pool[idx].it);
    pool.splice(idx, 1);
  }
  return out;
}

/** The effective order, honouring the legacy `randomizeIterations` flag. */
export function effectiveOrder(node: LoopFlowNode): LoopOrder {
  if (node.order) return node.order;
  if (node.randomizeIterations) return { kind: "random" };
  return { kind: node.source.kind === "listFill" ? "listFill" : "source" };
}

/** The effective count rule, honouring the legacy `maxIterations` field. */
export function effectiveCount(node: LoopFlowNode): LoopCount {
  if (node.count) return node.count;
  if (node.maxIterations != null) return { mode: "max", value: node.maxIterations };
  return { mode: "all" };
}

function orderItems(items: LoopItem[], node: LoopFlowNode, state: ResponseState): LoopItem[] {
  const order = effectiveOrder(node);
  const dir = order.direction === "desc" ? -1 : 1;
  switch (order.kind) {
    case "selection":
      return [...items].sort((a, b) =>
        (a.selectionIndex ?? Number.MAX_SAFE_INTEGER) - (b.selectionIndex ?? Number.MAX_SAFE_INTEGER)
        || a.sourceIndex - b.sourceIndex);
    case "priority":
      return [...items].sort((a, b) =>
        dir * compareValues(referenceSortValue(a, order.column), referenceSortValue(b, order.column))
        || a.sourceIndex - b.sourceIndex);
    case "random":
      // the same seed key the loop has always used, so a respondent already
      // mid-survey when this shipped keeps the order they started with
      return seededShuffle(items, subSeed(state.seed, `loop:${node.id}`));
    case "weightedRandom":
      return weightedOrder(items, order.column, subSeed(state.seed, `loop:${node.id}:weighted`));
    case "custom": {
      const rank = new Map((order.custom ?? []).map((c, i) => [String(c), i]));
      return [...items].sort((a, b) =>
        (rank.get(a.code) ?? Number.MAX_SAFE_INTEGER) - (rank.get(b.code) ?? Number.MAX_SAFE_INTEGER)
        || a.sourceIndex - b.sourceIndex);
    }
    case "listFill":
    case "source":
    default:
      return [...items].sort((a, b) => a.sourceIndex - b.sourceIndex);
  }
}

/* ------------------------------------------------------------ the pipeline */

/**
 * THE items this loop runs over for this respondent, in order, with their
 * references — the single function behind the flow, the simulator and the
 * inspector.
 */
export function resolveLoopItems(
  def: SurveyDefinition,
  state: ResponseState,
  node: LoopFlowNode,
  parent: LoopContext | null = null,
  quotaCounts?: QuotaCounts,
): LoopItem[] {
  let items = candidates(def, state, node, parent, quotaCounts);

  /*
   * Eligibility narrows whatever the filter produced (§12). It is evaluated
   * with the CANDIDATE as the loop context, which is what lets a rule read
   * the item's own reference columns — `loop.Category = "Smartphone"` — and
   * is also why eligibility is a per-loop rule rather than a property of the
   * source question: two loops over Q2 can disagree about who is eligible.
   */
  if (node.eligibleIf) {
    const rule: Condition = node.eligibleIf;
    items = items.filter((it) =>
      evaluateCondition(rule, { def, state, quotaCounts, loop: contextFor(node, it, 0, 0, parent) }));
  }

  items = orderItems(items, node, state);

  const count = effectiveCount(node);
  const n = resolveLoopCount(def, state, count.value, parent);
  switch (count.mode) {
    case "exact":
    case "max":
      if (n != null) items = items.slice(0, n);
      break;
    case "min":
      // a gate, not a floor: the loop cannot invent items it does not have
      if (n != null && items.length < n) items = [];
      break;
    case "all":
    default:
      break;
  }
  return items;
}

/** The contexts, one per item — what `compileFlow` walks the children with. */
export function loopContexts(
  def: SurveyDefinition,
  state: ResponseState,
  node: LoopFlowNode,
  parent: LoopContext | null = null,
  quotaCounts?: QuotaCounts,
): LoopContext[] {
  const items = resolveLoopItems(def, state, node, parent, quotaCounts);
  return items.map((it, i) => contextFor(node, it, i + 1, items.length, parent));
}

/**
 * Every item the loop COULD produce, from the definition alone — what an
 * export declares columns for before any respondent exists. `null` means the
 * set is unbounded (a count from a variable, a list from a variable), in
 * which case the dictionary can declare nothing positional and the lint says
 * so; the data is still stored and still reachable by code.
 */
export function possibleLoopItems(def: SurveyDefinition, node: LoopFlowNode): { code: string; label: string }[] | null {
  const s = node.source;
  switch (s.kind) {
    case "static": return s.items.map((i) => ({ code: String(i.code), label: i.label }));
    case "question": {
      const q = getQuestion(def, s.questionId);
      return q ? q.options.map((o) => ({ code: String(o.code), label: o.label })) : [];
    }
    case "design": {
      const rows = def.designs.find((d) => d.id === s.designId)?.file?.rows ?? [];
      return rows.map((r, i) => ({ code: String((r as any).task ?? i + 1), label: `Task ${i + 1}` }));
    }
    case "listFill": {
      const lf = def.listFills.find((x) => x.id === s.listFillId);
      if (!lf) return [];
      // positions, not codes: a List Fill's slot n can hold different items
      // for different respondents, and the declared width is what matters
      const n = listFillVariableNames(lf).filter((v) => /_\d+_CODE$/.test(v.name)).length;
      return Array.from({ length: n }, (_, i) => ({ code: String(i + 1), label: `Slot ${i + 1}` }));
    }
    case "count":
      return typeof s.count === "number"
        ? Array.from({ length: Math.max(0, Math.trunc(s.count)) }, (_, i) => ({ code: String(i + 1), label: String(i + 1) }))
        : null;
    case "variable":
      return null;
  }
}

/** The most iterations the loop can run, from the definition alone; null if unbounded. */
export function maxLoopIterations(def: SurveyDefinition, node: LoopFlowNode): number | null {
  const items = possibleLoopItems(def, node);
  const count = effectiveCount(node);
  const literal = typeof count.value === "number" ? count.value : null;
  if (items === null) return literal != null && (count.mode === "exact" || count.mode === "max") ? literal : null;
  if (literal != null && (count.mode === "exact" || count.mode === "max")) return Math.min(items.length, literal);
  return items.length;
}

/* ------------------------------------------------------------ variables */

export interface LoopVariableName {
  name: string;
  loopId: string;
  loopVar: string;
  label: string;
  dataType: "number" | "text" | "boolean";
  /** which iteration this belongs to, 1-based; absent for the count */
  iteration?: number;
  /** which reference column this carries, if any */
  referenceColumn?: string;
}

/**
 * The variables a loop DECLARES — fixed by the definition, so an export has
 * the same columns before the first respondent and after the last (the List
 * Fill precedent: a column that only appears once somebody happens to reach
 * iteration 4 is how a dataset silently changes shape between waves).
 *
 *   LOOP_BRAND_COUNT
 *   LOOP_BRAND_ITEM_1          the label of whatever ran first
 *   LOOP_BRAND_ITEM_1_CODE     its code — the join key back to the source
 *   LOOP_BRAND_ITEM_1_<Col>    one per reference column
 *
 * Nested loops are declared for their top level only; a nested loop's
 * variables exist at runtime (prefixed with the outer item) but their set
 * depends on the outer item, so they are not positional in the same sense.
 */
export function loopVariableNames(def: SurveyDefinition, node: LoopFlowNode): LoopVariableName[] {
  const prefix = loopVariablePrefix(node);
  const out: LoopVariableName[] = [
    { name: `${prefix}_COUNT`, loopId: node.id, loopVar: node.loopVar, label: `${node.loopVar}: number of iterations`, dataType: "number" },
  ];
  const max = maxLoopIterations(def, node);
  if (max == null) return out;
  for (let i = 1; i <= max; i++) {
    out.push({ name: `${prefix}_ITEM_${i}`, loopId: node.id, loopVar: node.loopVar, iteration: i, label: `${node.loopVar}: item ${i}`, dataType: "text" });
    out.push({ name: `${prefix}_ITEM_${i}_CODE`, loopId: node.id, loopVar: node.loopVar, iteration: i, label: `${node.loopVar}: item ${i} code`, dataType: "text" });
    for (const col of node.references?.columns ?? []) {
      out.push({
        name: `${prefix}_ITEM_${i}_${col.name.toUpperCase()}`, loopId: node.id, loopVar: node.loopVar,
        iteration: i, referenceColumn: col.name,
        label: `${node.loopVar}: item ${i} ${col.name}`,
        dataType: col.dataType === "number" ? "number" : col.dataType === "boolean" ? "boolean" : "text",
      });
    }
  }
  return out;
}

/**
 * The loop variables' VALUES for this respondent — merged into
 * `state.calculated` by `runCalculations` so piping, conditions, calculations
 * and scripts all see them, and read by `flattenVariables` to place each
 * iteration's answers in their positional columns.
 *
 * Top-level loops only take `state`; a nested loop's values depend on the
 * outer item and are produced per outer iteration inside `compileFlow`.
 */
export function loopVariables(
  def: SurveyDefinition,
  state: ResponseState,
  quotaCounts?: QuotaCounts,
): Record<string, LoopReferenceValue> {
  const out: Record<string, LoopReferenceValue> = {};
  /*
   * Nested loops are produced per OUTER iteration, with the outer item in the
   * name (`LOOP_BRAND_A_LOOP_PRODUCT_COUNT`), because which products Apple's
   * inner loop runs over is a different question from which products Google's
   * does. Recursion with the parent context is what makes the inner loop's
   * source (the outer iteration's own answer) resolve correctly.
   */
  const emit = (node: LoopFlowNode, parent: LoopContext | null) => {
    const items = resolveLoopItems(def, state, node, parent, quotaCounts);
    Object.assign(out, variablesFromItems(node, parent, items));
    const children = directChildLoops(node);
    if (!children.length) return;
    items.forEach((it, i) => {
      const ctx = contextFor(node, it, i + 1, items.length, parent);
      for (const child of children) emit(child, ctx);
    });
  };
  for (const { node, ancestors } of loopNodes(def)) {
    if (ancestors.length === 0) emit(node, null);
  }
  return out;
}

function variablesFromItems(node: LoopFlowNode, parent: LoopContext | null, items: LoopItem[]): Record<string, LoopReferenceValue> {
  const prefix = loopVariablePrefix(node, parent);
  const out: Record<string, LoopReferenceValue> = { [`${prefix}_COUNT`]: items.length };
  items.forEach((it, i) => {
    const n = i + 1;
    out[`${prefix}_ITEM_${n}`] = it.label;
    out[`${prefix}_ITEM_${n}_CODE`] = it.code;
    for (const col of node.references?.columns ?? []) {
      out[`${prefix}_ITEM_${n}_${col.name.toUpperCase()}`] = it.references[col.name] ?? null;
    }
  });
  return out;
}

/** The values for one loop, given the enclosing iteration (null at top level). */
export function loopVariablesFor(
  def: SurveyDefinition,
  state: ResponseState,
  node: LoopFlowNode,
  parent: LoopContext | null,
  quotaCounts?: QuotaCounts,
): Record<string, LoopReferenceValue> {
  return variablesFromItems(node, parent, resolveLoopItems(def, state, node, parent, quotaCounts));
}

/* ------------------------------------------------------------ simulator */

export interface LoopSimulation {
  loopId: string;
  loopVar: string;
  count: number;
  iterations: {
    index: number;
    code: string;
    label: string;
    references: Record<string, LoopReferenceValue>;
  }[];
  /** columns the loop declares, so the simulator can show empty cells honestly */
  columns: string[];
}

/**
 * What the loop would do for a hypothetical respondent (§34). Nothing here is
 * special: it is `resolveLoopItems` against the state the Studio hands in,
 * which is the whole point — the simulator cannot disagree with the runtime.
 */
export function simulateLoop(
  def: SurveyDefinition,
  node: LoopFlowNode,
  state: ResponseState,
  parent: LoopContext | null = null,
): LoopSimulation {
  const contexts = loopContexts(def, state, node, parent);
  return {
    loopId: node.id,
    loopVar: node.loopVar,
    count: contexts.length,
    iterations: contexts.map((c) => ({ index: c.index, code: c.code, label: c.label, references: c.references ?? {} })),
    columns: (node.references?.columns ?? []).map((c) => c.name),
  };
}

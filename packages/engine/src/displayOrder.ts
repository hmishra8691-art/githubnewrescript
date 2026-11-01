import type { Question, SurveyDefinition } from "@rescript/schema";
import type { LoopContext, ResponseState } from "./state.js";
import type { RuntimeStep } from "./flow.js";
import { loopKeySuffix } from "./state.js";
import { effectiveQuestion, randomizedAxes } from "./carryforward.js";

/**
 * S4c (RK-04, RA-07, SM-10) — THE ORDER EACH RESPONDENT ACTUALLY SAW, STORED WITH THE RESPONSE.
 *
 * Before this the displayed order was reproducible from the seed only (and stored for conjoint / MaxDiff tasks as
 * `_T<n>_ORDER`, and for exact randomizers as the claimed SET in `RANDOMIZER_<ID>` — not its order).
 *
 *   ORDER_<ID>[_<loop codes>]   a flow randomizer's children in the order shown (child ids, comma-separated) —
 *                               DEFAULT ON for every randomizer (`recordOrder: false` turns it off). A sequential
 *                               monadic test (a randomizer over every concept block) therefore records the order
 *                               each respondent rated the concepts in, with no embedded variable.
 *   <VAR>[_<loop codes>]_ORDER  a question's options in displayed order (option codes);
 *   …_ROW_ORDER / …_COL_ORDER   a grid's rows / columns — OPT-IN per question (`settings.recordOrder: true`), so
 *                               the exports of surveys already in the field do not gain columns. Recorded for the
 *                               randomized axes (options when nothing is randomized: a sort can still vary).
 *
 * WHEN. The Runner writes them every time it shows a page (`recordDisplayOrders`), so the stored value is the order
 * of the page as last shown — deterministic from the seed, the exact-balance claims and the answers before it. The
 * server's replay calls the same function at every page it walks, so a posted order that differs from the one the
 * server derives is a soft `server_mismatch` and the server's value is stored (D7). They are calculated variables:
 * every export (CSV, SPSS, Excel) carries them, with the labels below.
 */

const ident = (s: string) => s.replace(/[^A-Za-z0-9_]/g, "_").toUpperCase();
const codesSuffix = (loop: LoopContext | null | undefined) => {
  const s = loopKeySuffix(loop ?? null);
  return s ? s.split("@").filter(Boolean).map((c) => `_${ident(c)}`).join("") : "";
};

/** `ORDER_<ID>` (+ `_<loop code>` per enclosing loop) */
export function randomizerOrderVariable(nodeId: string, loop: LoopContext | null | undefined): string {
  return `ORDER_${ident(nodeId)}${codesSuffix(loop)}`;
}

export type OrderAxis = "options" | "rows" | "columns";
const AXIS_SUFFIX: Record<OrderAxis, string> = { options: "_ORDER", rows: "_ROW_ORDER", columns: "_COL_ORDER" };

/** `<VAR>_ORDER` / `<VAR>_ROW_ORDER` / `<VAR>_COL_ORDER` (+ loop codes before the suffix) */
export function questionOrderVariable(q: Pick<Question, "id"> & { variableName?: string }, axis: OrderAxis, loop?: LoopContext | null): string {
  return `${q.variableName || q.id}${codesSuffix(loop)}${AXIS_SUFFIX[axis]}`;
}

/** the axes whose order a question records (empty unless `settings.recordOrder`) */
export function recordedAxes(q: Question): OrderAxis[] {
  if (!(q.settings as { recordOrder?: boolean } | undefined)?.recordOrder) return [];
  const r = (q as { randomization?: Parameters<typeof randomizedAxes>[0] }).randomization;
  const axes = randomizedAxes(r).filter((a) => (a === "options" ? q.options.length : a === "rows" ? q.rows.length : (q.columns ?? []).length) > 0);
  if (axes.length) return axes;
  return q.options.length ? ["options"] : q.rows.length ? ["rows"] : [];
}

/** the order values of a page as shown now: the enclosing randomizers' (from the step) and the opted-in questions' */
export function displayOrders(def: SurveyDefinition, state: ResponseState, step: RuntimeStep | null | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  if (!step || step.kind !== "page") return out;
  for (const o of step.orders ?? []) out[o.variable] = o.value;
  for (const qid of step.questionIds) {
    const q = def.questions.find((x) => x.id === qid);
    if (!q) continue;
    const axes = recordedAxes(q);
    if (!axes.length) continue;
    let view;
    try { view = effectiveQuestion(q, { def, state, loop: step.loop ?? null } as never); } catch { continue; }
    for (const axis of axes) {
      const list = axis === "options" ? view.options : axis === "rows" ? view.rows : (view.columns ?? []);
      out[questionOrderVariable(q, axis, step.loop ?? null)] = (list as { code: string | number }[]).map((x) => String(x.code)).join(",");
    }
  }
  return out;
}

/** write the page's display orders into `state.calculated` (Runner on show; server replay on every page) — returns the names written */
export function recordDisplayOrders(def: SurveyDefinition, state: ResponseState, step: RuntimeStep | null | undefined): string[] {
  const orders = displayOrders(def, state, step);
  for (const [k, v] of Object.entries(orders)) state.calculated[k] = v;
  return Object.keys(orders);
}

/** the variable label an export gives an order variable, or null when the name is not one */
export function displayOrderLabel(def: SurveyDefinition, name: string): string | null {
  const m = /^ORDER_([A-Z0-9_]+)$/.exec(name);
  if (m) {
    const r = findRandomizer(def.flow as unknown[], (id) => m[1] === ident(id) || m[1]!.startsWith(`${ident(id)}_`));
    if (r) return `Order shown — randomizer ${r.title ?? r.id} (${r.children.map((c) => `${c.id}${(c as { title?: string }).title ? `=${(c as { title?: string }).title}` : ""}`).join(", ")})`;
  }
  for (const axis of ["rows", "columns", "options"] as OrderAxis[]) {
    if (!name.endsWith(AXIS_SUFFIX[axis])) continue;
    const base = name.slice(0, -AXIS_SUFFIX[axis].length);
    const q = def.questions.find((x) => recordedAxes(x).includes(axis) && (base === (x.variableName || x.id) || base.startsWith(`${x.variableName || x.id}_`)));
    if (q) return `Order shown — ${q.code ?? q.variableName} ${axis === "options" ? "options" : axis} (codes in displayed order)`;
  }
  return null;
}

type RNode = { type: string; id: string; title?: string; children?: RNode[]; branches?: { children: RNode[] }[]; otherwise?: RNode[] };
function findRandomizer(nodes: unknown[], match: (id: string) => boolean): { id: string; title?: string; children: RNode[] } | null {
  for (const n of nodes as RNode[]) {
    if (n.type === "randomizer" && match(n.id)) return n as { id: string; title?: string; children: RNode[] };
    const kids = [...(n.children ?? []), ...(n.branches ?? []).flatMap((b) => b.children), ...(n.otherwise ?? [])];
    const hit = kids.length ? findRandomizer(kids, match) : null;
    if (hit) return hit;
  }
  return null;
}

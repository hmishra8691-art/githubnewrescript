import type { Question, SurveyDefinition } from "@rescript/schema";
import type { LoopContext } from "@rescript/engine";

/**
 * PREVIEWING A QUESTION THAT LIVES INSIDE A LOOP.
 *
 * A looped question is written once and asked many times, so "how does it
 * look" has no single answer until you say *for which item*. This finds the
 * loop a question sits in, lists the items it will run over, and builds the
 * `LoopContext` the engine and the renderer already understand — the same
 * shape a real interview passes them, so piping, conditions and carry-forward
 * resolve for the chosen iteration exactly as they will in the field.
 *
 * Reference columns come along too. A loop can carry a table beside its items
 * (`Brand_Name`, `Product_ID`, `Client_Code`…), and `{{CURRENT_ITEM.Brand_Name}}`
 * reads from it; without them a looped question previews with half its text
 * missing.
 */

export interface LoopItem {
  code: string;
  label: string;
  /** this item's row of the loop's reference table, when it has one */
  references?: Record<string, string | number | boolean | null>;
}

export interface LoopPreview {
  loopId: string;
  loopVar: string;
  items: LoopItem[];
  /** the reference columns this loop defines, in their programmed order */
  columns: { key: string; label?: string }[];
  /** where the items came from, for the programmer's benefit */
  sourceNote: string;
}

/** Walk the flow tree; loops can nest inside groups, branches and each other. */
function walk(nodes: unknown[], visit: (n: Record<string, any>) => void): void {
  for (const raw of nodes) {
    const n = raw as Record<string, any>;
    if (!n || typeof n !== "object") continue;
    visit(n);
    for (const k of ["children", "nodes", "body", "branches", "paths"]) {
      if (Array.isArray(n[k])) walk(n[k], visit);
    }
  }
}

/**
 * The loops whose body contains this question, innermost last.
 *
 * Containment is decided by the question's id appearing anywhere inside the
 * loop node, which is how the flow already stores membership (page nodes list
 * `questionIds`), so this needs no separate index and cannot drift from it.
 */
export function loopsFor(def: SurveyDefinition, q: Question): LoopPreview[] {
  const out: LoopPreview[] = [];
  walk((def.flow ?? []) as unknown[], (n) => {
    if (n.type !== "loop") return;
    if (!JSON.stringify(n).includes(`"${q.id}"`)) return;

    const loopVar: string = n.loopVar ?? "CURRENT_ITEM";
    const refs = n.references as { columns?: { key: string; label?: string }[]; values?: Record<string, Record<string, any>> } | undefined;
    const columns = refs?.columns ?? [];
    const values = refs?.values ?? {};

    let items: LoopItem[] = [];
    let sourceNote = "";
    const src = n.source as Record<string, any> | undefined;

    if (src?.kind === "static" && Array.isArray(src.items)) {
      items = src.items.map((i: any) => ({ code: String(i.code), label: String(i.label ?? i.code) }));
      sourceNote = "static list";
    } else if (src?.kind === "question") {
      const source = def.questions.find((x) => x.id === src.questionId);
      items = (source?.options ?? []).map((o) => ({ code: String(o.code), label: o.label }));
      sourceNote = source ? `${source.code} · ${src.filter ?? "selected"}` : "a question";
    } else if (src?.kind === "listFill") {
      const lf = (def.listFills ?? []).find((l: any) => l.id === src.listFillId) as any;
      items = (lf?.items ?? lf?.options ?? []).map((o: any) => ({ code: String(o.code), label: String(o.label ?? o.code) }));
      sourceNote = lf ? `List Fill · ${lf.name ?? lf.id}` : "a List Fill";
    } else if (src?.kind === "count") {
      const n2 = typeof src.count === "number" ? src.count : 3;
      items = Array.from({ length: Math.max(1, Math.min(n2, 20)) }, (_, i) => ({ code: String(i + 1), label: `Item ${i + 1}` }));
      sourceNote = `a count of ${n2}`;
    } else {
      sourceNote = src?.kind ? `${src.kind} source` : "this loop";
    }

    // reference rows are keyed by item code
    items = items.map((it) => (values[it.code] ? { ...it, references: values[it.code] } : it));

    // a loop with references but no resolvable items still previews from the
    // reference table, which is the only place the codes are written down
    if (items.length === 0 && Object.keys(values).length > 0) {
      items = Object.entries(values).map(([code, row]) => ({
        code,
        label: String(row[columns[0]?.key ?? ""] ?? code),
        references: row,
      }));
    }
    if (items.length === 0) items = [{ code: "1", label: "Item 1" }];

    out.push({ loopId: String(n.id ?? loopVar), loopVar, items, columns, sourceNote });
  });
  return out;
}

/** The context the engine and renderer take for one chosen iteration. */
export function contextFor(loop: LoopPreview, index: number, overrides?: Record<string, string>): LoopContext | null {
  const i = Math.max(0, Math.min(index, loop.items.length - 1));
  const item = loop.items[i];
  if (!item) return null;
  const references = { ...(item.references ?? {}), ...(overrides ?? {}) };
  return {
    loopVar: loop.loopVar,
    code: item.code,
    label: item.label.replace(/<[^>]*>/g, ""),
    index: i,
    count: loop.items.length,
    ...(Object.keys(references).length ? { references } : {}),
  } as LoopContext;
}

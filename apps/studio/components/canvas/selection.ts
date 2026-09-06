import type { Question, SurveyDefinition } from "@rescript/schema";
import { parseCellId } from "@rescript/renderer";

/**
 * THE SELECTION MODEL.
 *
 * One value says what the programmer is currently programming. The canvas
 * writes it (from a click on the rendered question) and the contextual
 * property panel reads it to decide which configuration to offer. Nothing else
 * describes "what is selected" — there is one selection, not one per surface.
 *
 * Everything is addressed by the identifiers the schema already uses: question
 * id, option/row code, column id. Nothing here is derived from screen
 * position, so a selection survives a re-render, a device switch and a change
 * of question type.
 */
export type SelectedEntity =
  | { type: "question"; questionId: string }
  | { type: "text"; questionId: string }
  | { type: "instruction"; questionId: string }
  | { type: "media"; questionId: string }
  | { type: "option"; questionId: string; optionCode: string }
  | { type: "row"; questionId: string; rowCode: string }
  | { type: "column"; questionId: string; columnId: string }
  | { type: "cell"; questionId: string; rowCode: string; columnId: string }
  | { type: "scalepoint"; questionId: string; value: string };

export type SelectionKind = SelectedEntity["type"];

/** Human label for the panel heading — "OPTION: Google". */
export function selectionLabel(sel: SelectedEntity, q: Question | undefined): string {
  const plain = (s: string) => s.replace(/<[^>]*>/g, "").trim();
  switch (sel.type) {
    case "question": return q ? `${q.code} — question` : "Question";
    case "text": return "Question text";
    case "instruction": return "Instruction text";
    case "media": return "Question media";
    case "option": {
      const o = q?.options.find((x) => String(x.code) === sel.optionCode);
      return `Option: ${o ? plain(o.label) || sel.optionCode : sel.optionCode}`;
    }
    case "row": {
      const r = q?.rows.find((x) => String(x.code) === sel.rowCode);
      return `Row: ${r ? plain(r.label) || sel.rowCode : sel.rowCode}`;
    }
    case "column": {
      const c = q?.columns.find((x) => x.id === sel.columnId);
      if (c) return `Column: ${plain(c.label) || c.id}`;
      const o = q?.options.find((x) => String(x.code) === sel.columnId);
      return `Column: ${o ? plain(o.label) || sel.columnId : sel.columnId}`;
    }
    case "cell": return `Cell: ${sel.rowCode} × ${sel.columnId}`;
    case "scalepoint": return `Scale point: ${sel.value}`;
  }
}

/** Two selections are the same when they address the same schema object. */
export function sameSelection(a: SelectedEntity | null, b: SelectedEntity | null): boolean {
  if (!a || !b) return a === b;
  if (a.type !== b.type || a.questionId !== b.questionId) return false;
  switch (a.type) {
    case "option": return a.optionCode === (b as typeof a).optionCode;
    case "row": return a.rowCode === (b as typeof a).rowCode;
    case "column": return a.columnId === (b as typeof a).columnId;
    case "cell": return a.rowCode === (b as typeof a).rowCode && a.columnId === (b as typeof a).columnId;
    case "scalepoint": return a.value === (b as typeof a).value;
    default: return true;
  }
}

/**
 * Resolve a clicked DOM node to the schema object that drew it.
 *
 * The renderers stamp `data-rs-el` / `data-rs-id` (see @rescript/renderer's
 * authoring module). Walking UP from the click finds the innermost addressable
 * ancestor, which is what makes a click on an option's label select the option
 * rather than the question — the most specific thing under the cursor wins,
 * exactly as it does in a design tool.
 *
 * Returns null for chrome the programmer cannot program (spacing, wrappers).
 */
export function resolveFromDom(node: Element | null, questionId: string): SelectedEntity | null {
  let el: Element | null = node;
  while (el) {
    const kind = el.getAttribute("data-rs-el");
    if (kind) {
      const id = el.getAttribute("data-rs-id") ?? "";
      switch (kind) {
        case "question": return { type: "question", questionId };
        case "text": return { type: "text", questionId };
        case "instruction": return { type: "instruction", questionId };
        case "media": return { type: "media", questionId };
        case "option": return id ? { type: "option", questionId, optionCode: id } : null;
        case "row": return id ? { type: "row", questionId, rowCode: id } : null;
        case "column": return id ? { type: "column", questionId, columnId: id } : null;
        case "scalepoint": return id ? { type: "scalepoint", questionId, value: id } : null;
        case "cell": {
          const c = parseCellId(id);
          return c ? { type: "cell", questionId, rowCode: c.rowCode, columnId: c.columnId } : null;
        }
      }
    }
    el = el.parentElement;
  }
  return null;
}

/** The element that draws a selection, so the overlay knows where to sit. */
export function findElement(root: HTMLElement, sel: SelectedEntity): HTMLElement | null {
  const q = (s: string) => root.querySelector<HTMLElement>(s);
  const esc = (v: string) => (typeof CSS !== "undefined" && typeof CSS.escape === "function" ? CSS.escape(v) : v.replace(/["\\]/g, "\\$&"));
  switch (sel.type) {
    case "question": return root.querySelector<HTMLElement>('[data-rs-el="question"]') ?? root;
    case "text": return q('[data-rs-el="text"]');
    case "instruction": return q('[data-rs-el="instruction"]');
    case "media": return q('[data-rs-el="media"]');
    case "option": return q(`[data-rs-el="option"][data-rs-id="${esc(sel.optionCode)}"]`);
    case "row": return q(`[data-rs-el="row"][data-rs-id="${esc(sel.rowCode)}"]`);
    case "column": return q(`[data-rs-el="column"][data-rs-id="${esc(sel.columnId)}"]`);
    case "scalepoint": return q(`[data-rs-el="scalepoint"][data-rs-id="${esc(sel.value)}"]`);
    case "cell": return q(`[data-rs-el="cell"][data-rs-id="${esc(`${sel.rowCode}::${sel.columnId}`)}"]`);
  }
}

/**
 * Does the selection still exist? A programmer who deletes the option they had
 * selected should land back on the question, not on a panel editing nothing.
 */
export function selectionExists(sel: SelectedEntity, def: SurveyDefinition): boolean {
  const q = def.questions.find((x) => x.id === sel.questionId);
  if (!q) return false;
  switch (sel.type) {
    case "option": return q.options.some((o) => String(o.code) === sel.optionCode);
    case "row": return q.rows.some((r) => String(r.code) === sel.rowCode);
    case "column":
      return q.columns.some((c) => c.id === sel.columnId) || q.options.some((o) => String(o.code) === sel.columnId);
    case "cell":
      return (
        q.rows.some((r) => String(r.code) === sel.rowCode) &&
        (q.columns.some((c) => c.id === sel.columnId) || q.options.some((o) => String(o.code) === sel.columnId))
      );
    default: return true;
  }
}

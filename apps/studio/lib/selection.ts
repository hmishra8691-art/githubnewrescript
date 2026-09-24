import type { ObjectKey } from "@rescript/engine";

/**
 * ONE SELECTION FOR EVERY ENVIRONMENT.
 *
 * The Studio had two: the store's `selectedQuestionId` (a single question,
 * read by the Questions panel and the property panel) and the canvas's
 * `SelectedEntity` (an element inside that question). Both are kept — every
 * panel and browser test reads them — and this sits above them: a set of
 * engine `ObjectKey`s (`question:…`, `flowNode:…`, `displayRule:…`, …) with
 * one PRIMARY, so a grid can select twelve rows, a canvas can select a
 * branch, and an inspector can show whichever one was touched last.
 *
 * The reducer is pure so it can be tested without React: it knows nothing
 * about the store. The provider (components/studio/SelectionContext.tsx)
 * mirrors the primary into `selectedQuestionId` when it is a question.
 */

export interface SelectionState {
  /** the object the inspector shows; always a member of `keys` when non-null */
  primary: ObjectKey | null;
  /** everything selected, in the order it was selected */
  keys: ObjectKey[];
  /** the anchor for shift-range selection: the last plain click */
  anchor: ObjectKey | null;
}

export const EMPTY_SELECTION: SelectionState = { primary: null, keys: [], anchor: null };

export type SelectionAction =
  /** a plain click: this and only this */
  | { type: "select"; key: ObjectKey }
  /** ⌘/ctrl-click: add or remove without touching the rest */
  | { type: "toggle"; key: ObjectKey }
  /** shift-click: everything between the anchor and this, in `order` */
  | { type: "range"; key: ObjectKey; order: ObjectKey[] }
  /** replace the whole set, e.g. "select all in block"; primary is the first */
  | { type: "set"; keys: ObjectKey[]; primary?: ObjectKey | null }
  | { type: "clear" }
  /** an object was deleted: drop it, promote the next primary */
  | { type: "drop"; keys: ObjectKey[] };

export function selectionReducer(state: SelectionState, action: SelectionAction): SelectionState {
  switch (action.type) {
    case "select":
      if (state.primary === action.key && state.keys.length === 1) return state;
      return { primary: action.key, keys: [action.key], anchor: action.key };

    case "toggle": {
      if (state.keys.includes(action.key)) {
        const keys = state.keys.filter((k) => k !== action.key);
        return {
          keys,
          primary: state.primary === action.key ? (keys[keys.length - 1] ?? null) : state.primary,
          anchor: state.anchor === action.key ? (keys[keys.length - 1] ?? null) : state.anchor,
        };
      }
      return { primary: action.key, keys: [...state.keys, action.key], anchor: state.anchor ?? action.key };
    }

    case "range": {
      const anchor = state.anchor ?? state.primary;
      const a = anchor ? action.order.indexOf(anchor) : -1;
      const b = action.order.indexOf(action.key);
      if (a < 0 || b < 0) return selectionReducer(state, { type: "select", key: action.key });
      const [lo, hi] = a <= b ? [a, b] : [b, a];
      const span = action.order.slice(lo, hi + 1);
      // keep anything already selected outside the span — shift extends, it does not replace
      const outside = state.keys.filter((k) => !span.includes(k));
      return { primary: action.key, keys: [...outside, ...span], anchor };
    }

    case "set": {
      const keys = [...new Set(action.keys)];
      const primary = action.primary !== undefined
        ? (action.primary && keys.includes(action.primary) ? action.primary : null)
        : (keys[0] ?? null);
      return { primary, keys, anchor: primary };
    }

    case "clear":
      return state.keys.length === 0 && state.primary === null ? state : EMPTY_SELECTION;

    case "drop": {
      const gone = new Set(action.keys);
      if (!state.keys.some((k) => gone.has(k))) return state;
      const keys = state.keys.filter((k) => !gone.has(k));
      const primary = state.primary && !gone.has(state.primary) ? state.primary : (keys[keys.length - 1] ?? null);
      const anchor = state.anchor && !gone.has(state.anchor) ? state.anchor : primary;
      return { primary, keys, anchor };
    }
  }
}

/** `question:q_12` → "q_12" when the key is a question, else null. */
export function questionIdOf(key: ObjectKey | null): string | null {
  return key && key.startsWith("question:") ? key.slice("question:".length) : null;
}

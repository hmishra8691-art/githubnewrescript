"use client";
import React from "react";
import type { ObjectKey } from "@rescript/engine";
import { useStudio } from "./store";
import {
  selectionReducer, EMPTY_SELECTION, questionIdOf, type SelectionState, type SelectionAction,
} from "../../lib/selection";

/**
 * THE SELECTION EVERY ENVIRONMENT SHARES — and its bridge to the old one.
 *
 * `useStudio().selectedQuestionId` is read by the Questions panel, the
 * property panel and a hundred browser checks, so it stays exactly as it is.
 * This provider keeps a richer selection (any object kind, several at once)
 * and keeps the two in step in both directions:
 *
 *   · a panel that calls `s.select(id)` — every existing click — is seen
 *     here and becomes the primary;
 *   · an environment that selects here mirrors a question primary into
 *     `s.select`, and a non-question primary clears it, so the property
 *     panel (which only knows questions) hides rather than showing the
 *     wrong thing.
 *
 * So `selectedQuestionId` is, from now on, a derived view of this selection
 * — the alias the plan promised — without a single panel having changed.
 */

interface SelectionApi extends SelectionState {
  dispatch(action: SelectionAction): void;
  /** convenience: plain-select one key */
  select(key: ObjectKey): void;
  isSelected(key: ObjectKey): boolean;
}

const Ctx = React.createContext<SelectionApi | null>(null);

export function SelectionProvider({ children }: { children: React.ReactNode }) {
  const s = useStudio();
  const [state, dispatchRaw] = React.useReducer(selectionReducer, EMPTY_SELECTION);
  const stateRef = React.useRef(state);
  stateRef.current = state;
  /* what this provider last told the store, so the echo does not bounce back as a new event */
  const mirrored = React.useRef<string | null>(null);

  // store → selection: an old-style click somewhere becomes the primary here
  React.useEffect(() => {
    const id = s.selectedQuestionId;
    if (id === mirrored.current) return;
    mirrored.current = id;
    if (id) dispatchRaw({ type: "select", key: `question:${id}` });
    else if (questionIdOf(state.primary)) dispatchRaw({ type: "clear" });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [s.selectedQuestionId]);

  // selection → store: a question primary is what `selectedQuestionId` means
  const dispatch = React.useCallback((action: SelectionAction) => {
    const next = selectionReducer(stateRef.current, action);
    stateRef.current = next;
    dispatchRaw(action);
    const qid = questionIdOf(next.primary);
    if (qid !== mirrored.current) {
      mirrored.current = qid;
      s.select(qid);
    }
  }, [s]);

  const value = React.useMemo<SelectionApi>(() => ({
    ...state,
    dispatch,
    select: (key) => dispatch({ type: "select", key }),
    isSelected: (key) => state.keys.includes(key),
  }), [state, dispatch]);

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

/** Null outside the provider, so a component can be rendered in isolation. */
export function useSelection(): SelectionApi | null {
  return React.useContext(Ctx);
}

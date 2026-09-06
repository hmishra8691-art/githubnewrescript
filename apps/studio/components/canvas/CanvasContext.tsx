"use client";
import React from "react";
import type { SelectedEntity } from "./selection";
import type { AuthoringAnnotations } from "./authoringView";

/**
 * WHAT THE PROGRAMMER IS LOOKING AT, AND WHAT THEY HAVE SELECTED.
 *
 * The question editor lives in the centre column and the property panel lives
 * in the right column — siblings in the Studio shell, so neither can hold this
 * state for the other. It sits above both instead.
 *
 * It is deliberately NOT question data. The question is the store's, and there
 * is exactly one of it; this only carries which VIEW of the current question
 * is open (Standard or Live) and which ELEMENT of it is selected, so the right
 * panel can offer that element's properties instead of the whole question's.
 *
 * The mode is per question, not global: opening a different question starts it
 * in Standard, which is where a programmer expects to land, and the selection
 * is dropped because it named something in the question they just left.
 */

export type EditorMode = "standard" | "live";

interface CanvasContextValue {
  mode: EditorMode;
  setMode(m: EditorMode): void;
  selected: SelectedEntity | null;
  select(sel: SelectedEntity | null): void;
  /** the question the mode and selection belong to */
  questionId: string | null;
  /** called by the editor when it mounts for a question */
  attach(questionId: string): void;
  /**
   * What the real pipeline says about the question right now — which options,
   * rows and columns today's logic hides, and which carry programming. The
   * Live View computes it (it owns the sample answers the pipeline runs
   * against) and the property panel reads it, so an element's panel can say
   * "hidden for these sample answers" without evaluating anything twice.
   */
  annotations: AuthoringAnnotations | null;
  setAnnotations(a: AuthoringAnnotations | null): void;
}

const Ctx = React.createContext<CanvasContextValue | null>(null);

export function CanvasProvider({ children }: { children: React.ReactNode }) {
  const [mode, setMode] = React.useState<EditorMode>("standard");
  const [selected, setSelected] = React.useState<SelectedEntity | null>(null);
  const [questionId, setQuestionId] = React.useState<string | null>(null);
  const [annotations, setAnnotations] = React.useState<AuthoringAnnotations | null>(null);

  const attach = React.useCallback((id: string) => {
    setQuestionId((prev) => {
      if (prev === id) return prev;
      // a different question: its own view, and no stale selection
      setMode("standard");
      setSelected(null);
      setAnnotations(null);
      return id;
    });
  }, []);

  const select = React.useCallback((sel: SelectedEntity | null) => setSelected(sel), []);

  const value = React.useMemo(
    () => ({ mode, setMode, selected, select, questionId, attach, annotations, setAnnotations }),
    [mode, selected, questionId, attach, select, annotations],
  );
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

/**
 * Returns null outside the provider rather than throwing: the property panel
 * is also rendered in contexts that have no question editor at all, and a
 * missing selection there simply means "show the question's own properties".
 */
export function useCanvas(): CanvasContextValue | null {
  return React.useContext(Ctx);
}

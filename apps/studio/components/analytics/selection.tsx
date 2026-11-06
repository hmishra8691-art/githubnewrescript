"use client";
import React from "react";

/**
 * THE UNIFIED SELECTION (Analytics upgrade M6) — one basket across the four modes. Anything with a catalogue
 * key can be put in it: an analysis (`crosstabs:<id>`, `tests:…`, `models:…`, `correlations:…`), a chart
 * (`charts:<id>`), a hypothesis (`hypotheses:H2`), a finding (`findings:<id>`), a theme (`themes:<id>`), a whole
 * report or dashboard. Present turns it into one export (PPTX, PDF, XLSX, CSV) or one saved report; Architect's
 * Explorer ticks are this same basket. Remembered per survey in this browser.
 */
export interface SelectedItem { key: string; label: string; title?: string; note?: string }

interface SelectionApi {
  items: SelectedItem[];
  keys: Set<string>;
  has: (key: string) => boolean;
  add: (key: string, label: string) => void;
  addMany: (items: { key: string; label: string }[]) => void;
  remove: (key: string) => void;
  toggle: (key: string, label: string) => void;
  update: (key: string, patch: Partial<Pick<SelectedItem, "title" | "note" | "label">>) => void;
  move: (key: string, dir: -1 | 1) => void;
  clear: () => void;
}

const Ctx = React.createContext<SelectionApi | null>(null);
const storageKey = (surveyId: string) => `rescript.analytics.selection.${surveyId}`;

export function SelectionProvider({ surveyId, children }: { surveyId: string; children: React.ReactNode }) {
  const [items, setItems] = React.useState<SelectedItem[]>([]);
  React.useEffect(() => { try { const raw = window.localStorage.getItem(storageKey(surveyId)); const parsed = raw ? (JSON.parse(raw) as SelectedItem[]) : []; setItems(Array.isArray(parsed) ? parsed.filter((x) => x && typeof x.key === "string").slice(0, 200) : []); } catch { setItems([]); } }, [surveyId]);
  const persist = (next: SelectedItem[]) => { try { window.localStorage.setItem(storageKey(surveyId), JSON.stringify(next)); } catch { /* fine */ } return next; };
  const api = React.useMemo<SelectionApi>(() => {
    const set = (f: (cur: SelectedItem[]) => SelectedItem[]) => setItems((cur) => persist(f(cur)));
    return {
      items, keys: new Set(items.map((i) => i.key)),
      has: (key) => items.some((i) => i.key === key),
      add: (key, label) => set((cur) => (cur.some((i) => i.key === key) ? cur : [...cur, { key, label }])),
      addMany: (xs) => set((cur) => { const have = new Set(cur.map((i) => i.key)); return [...cur, ...xs.filter((x) => !have.has(x.key)).map((x) => ({ key: x.key, label: x.label }))]; }),
      remove: (key) => set((cur) => cur.filter((i) => i.key !== key)),
      toggle: (key, label) => set((cur) => (cur.some((i) => i.key === key) ? cur.filter((i) => i.key !== key) : [...cur, { key, label }])),
      update: (key, patch) => set((cur) => cur.map((i) => (i.key === key ? { ...i, ...patch } : i))),
      move: (key, dir) => set((cur) => { const i = cur.findIndex((x) => x.key === key); const j = i + dir; if (i < 0 || j < 0 || j >= cur.length) return cur; const next = [...cur]; [next[i], next[j]] = [next[j], next[i]]; return next; }),
      clear: () => set(() => []),
    };
  }, [items]); // eslint-disable-line react-hooks/exhaustive-deps
  return <Ctx.Provider value={api}>{children}</Ctx.Provider>;
}

export function useSelection(): SelectionApi {
  const v = React.useContext(Ctx);
  if (!v) throw new Error("useSelection outside SelectionProvider");
  return v;
}

/** the category a saved analysis's key belongs to, from its kind */
export const analysisKey = (kind: string, id: string): string => `${kind === "crosstab" ? "crosstabs" : kind === "test" ? "tests" : kind === "correlation" ? "correlations" : "models"}:${id}`;

/** a small tick-to-select control, the same everywhere */
export function SelectTick({ keyName, label, title }: { keyName: string; label: string; title?: string }) {
  const s = useSelection();
  const on = s.has(keyName);
  return (
    <button type="button" className={`ax-sel-tick ${on ? "on" : ""}`} onClick={(e) => { e.stopPropagation(); s.toggle(keyName, label); }} aria-pressed={on} title={title ?? (on ? "In the selection — click to remove" : "Add to the selection for Present / export")} data-testid="ax-sel-tick" data-key={keyName}>
      {on ? "✓ Selected" : "+ Select"}
    </button>
  );
}

"use client";
import React from "react";
import {
  MODES, MODE_STORAGE_KEY, SPLIT_STORAGE_KEY, CHOOSER_STORAGE_KEY, SPLIT_MIN_WIDTH, DEFAULT_MODE,
  resolveInitialMode, resolveInitialSplit, withModeInUrl, withSplitInUrl, modeInfo, nextPair, shouldShowChooser,
  type ProgrammingMode,
} from "../../lib/programmingMode";

/**
 * WHICH ENVIRONMENT THE PROGRAMMER IS IN.
 *
 * Deliberately not in the survey store: the store is the SURVEY — the thing
 * every environment edits — and the mode is a property of the person looking
 * at it. Putting it in the store would make "switch to Grid" look like an
 * edit, and two collaborators would fight over it.
 *
 * Switching is a state change and nothing more. No navigation, no reload,
 * no refetch: the `?mode=` (and `?split=`) in the URL is kept in step with
 * `history.replaceState` so a reload or a shared link lands in the same
 * environment, and the last choice is remembered per browser.
 */

interface ModeState {
  mode: ProgrammingMode;
  setMode(mode: ProgrammingMode): void;
  /** the modes, with availability, for selectors and the palette */
  modes: typeof MODES;
  /**
   * FOCUS MODE (§14): everything outside the selection's dependency
   * neighbourhood goes visually secondary. A view-level switch, so it lives
   * with the mode rather than in any one renderer — Architect dims its map,
   * Flow will dim its canvas, Grid its rows, all from this one flag.
   */
  focus: boolean;
  setFocus(on: boolean): void;
  /**
   * DUAL-MODE SPLIT (§15): a second renderer beside the first, over the
   * same store. `null` is the ordinary single view. Not offered below
   * `SPLIT_MIN_WIDTH` — `splitAllowed` says whether the window is wide
   * enough; the value is kept so widening the window brings it back.
   */
  split: ProgrammingMode | null;
  setSplit(mode: ProgrammingMode | null): void;
  splitAllowed: boolean;
  /** the onboarding chooser (§10): open on a first run, reopenable any time */
  chooserOpen: boolean;
  openChooser(): void;
  closeChooser(): void;
}

const Ctx = React.createContext<ModeState | null>(null);

const read = (key: string): string | null => {
  try { return typeof window !== "undefined" ? window.localStorage.getItem(key) : null; } catch { return null; }
};
const write = (key: string, value: string | null) => {
  try { if (value === null) window.localStorage.removeItem(key); else window.localStorage.setItem(key, value); } catch { /* fine without memory */ }
};

export function ModeProvider({ children, sandbox = false }: { children: React.ReactNode; /** the scratch survey: no unasked-for chooser */ sandbox?: boolean }) {
  const [pair, setPairState] = React.useState<{ mode: ProgrammingMode; split: ProgrammingMode | null }>(() => {
    if (typeof window === "undefined") return { mode: DEFAULT_MODE, split: null };
    const mode = resolveInitialMode(window.location.search, read(MODE_STORAGE_KEY));
    return { mode, split: resolveInitialSplit(window.location.search, read(SPLIT_STORAGE_KEY), mode) };
  });

  // the current pair, readable from a stable callback — a setState updater
  // must stay pure, and the URL/memory write is not; kept current on commit
  // as well as on render so two changes in one tick compose
  const pairRef = React.useRef(pair);
  pairRef.current = pair;

  const commit = React.useCallback((next: { mode: ProgrammingMode; split: ProgrammingMode | null }) => {
    pairRef.current = next;
    setPairState(next);
    if (typeof window === "undefined") return;
    write(MODE_STORAGE_KEY, next.mode);
    write(SPLIT_STORAGE_KEY, next.split);
    const search = withSplitInUrl(withModeInUrl(window.location.search, next.mode), next.split);
    const url = `${window.location.pathname}${search}${window.location.hash}`;
    if (url !== `${window.location.pathname}${window.location.search}${window.location.hash}`) {
      window.history.replaceState(window.history.state, "", url);
    }
  }, []);

  const setMode = React.useCallback((next: ProgrammingMode) => {
    if (!modeInfo(next).available) return;
    commit(nextPair(pairRef.current, { mode: next }));
  }, [commit]);
  const setSplit = React.useCallback((next: ProgrammingMode | null) => {
    commit(nextPair(pairRef.current, { split: next }));
  }, [commit]);

  /* the split needs room: two renderers under 1100px are two unusable ones */
  const [splitAllowed, setSplitAllowed] = React.useState(() => typeof window === "undefined" ? true : window.innerWidth >= SPLIT_MIN_WIDTH);
  React.useEffect(() => {
    const mq = window.matchMedia(`(min-width: ${SPLIT_MIN_WIDTH}px)`);
    const on = () => setSplitAllowed(mq.matches);
    on();
    mq.addEventListener("change", on);
    return () => mq.removeEventListener("change", on);
  }, []);

  const [focus, setFocus] = React.useState(false);

  /* the chooser: once, unless asked for again */
  const [chooserOpen, setChooserOpen] = React.useState(false);
  React.useEffect(() => {
    if (shouldShowChooser(window.location.search, read(MODE_STORAGE_KEY), read(CHOOSER_STORAGE_KEY), { sandbox })) setChooserOpen(true);
  }, [sandbox]);
  const openChooser = React.useCallback(() => setChooserOpen(true), []);
  const closeChooser = React.useCallback(() => { setChooserOpen(false); write(CHOOSER_STORAGE_KEY, "1"); }, []);

  const value = React.useMemo<ModeState>(() => ({
    mode: pair.mode, setMode, modes: MODES, focus, setFocus,
    split: pair.split, setSplit, splitAllowed,
    chooserOpen, openChooser, closeChooser,
  }), [pair, setMode, focus, setSplit, splitAllowed, chooserOpen, openChooser, closeChooser]);
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

/** Null outside the provider, like `useCanvas` — a panel rendered elsewhere is simply in Studio mode. */
export function useMode(): ModeState | null {
  return React.useContext(Ctx);
}

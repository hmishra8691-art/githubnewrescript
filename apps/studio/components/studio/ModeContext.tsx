"use client";
import React from "react";
import {
  MODES, MODE_STORAGE_KEY, DEFAULT_MODE, resolveInitialMode, withModeInUrl, modeInfo,
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
 * no refetch: the `?mode=` in the URL is kept in step with
 * `history.replaceState` so a reload or a shared link lands in the same
 * environment, and the last choice is remembered per browser.
 */

interface ModeState {
  mode: ProgrammingMode;
  setMode(mode: ProgrammingMode): void;
  /** the modes, with availability, for selectors and the palette */
  modes: typeof MODES;
}

const Ctx = React.createContext<ModeState | null>(null);

export function ModeProvider({ children }: { children: React.ReactNode }) {
  const [mode, setModeState] = React.useState<ProgrammingMode>(() => {
    if (typeof window === "undefined") return DEFAULT_MODE;
    let remembered: string | null = null;
    try { remembered = window.localStorage.getItem(MODE_STORAGE_KEY); } catch { /* private mode, blocked storage */ }
    return resolveInitialMode(window.location.search, remembered);
  });

  const setMode = React.useCallback((next: ProgrammingMode) => {
    if (!modeInfo(next).available) return;
    setModeState(next);
    if (typeof window === "undefined") return;
    try { window.localStorage.setItem(MODE_STORAGE_KEY, next); } catch { /* fine without memory */ }
    const search = withModeInUrl(window.location.search, next);
    const url = `${window.location.pathname}${search}${window.location.hash}`;
    if (url !== `${window.location.pathname}${window.location.search}${window.location.hash}`) {
      window.history.replaceState(window.history.state, "", url);
    }
  }, []);

  const value = React.useMemo<ModeState>(() => ({ mode, setMode, modes: MODES }), [mode, setMode]);
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

/** Null outside the provider, like `useCanvas` — a panel rendered elsewhere is simply in Studio mode. */
export function useMode(): ModeState | null {
  return React.useContext(Ctx);
}

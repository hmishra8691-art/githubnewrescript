/**
 * PROGRAMMING MODES — the five environments over one survey.
 *
 * A mode is a way of LOOKING AT and INTERACTING WITH the survey, not a
 * different survey. Switching one changes which renderer the centre column
 * shows for the programming tabs and nothing else: the definition, the
 * selection, the tab, the undo history and the autosave are all untouched,
 * because none of them lives in the renderer.
 *
 * Only the modes with a renderer are `available`. The others are declared
 * here so the selector shows what the Studio is becoming, and so their ids
 * are fixed before the code that reads them exists — a `?mode=flow` link
 * shared today keeps meaning Flow when Flow lands.
 */

export type ProgrammingMode = "studio" | "grid" | "architect" | "flow" | "intelligent";

export interface ModeInfo {
  id: ProgrammingMode;
  /** one word, as on the selector */
  label: string;
  /** the tagline from the onboarding chooser */
  tagline: string;
  /** who it is for, one line */
  audience: string;
  /** false until the renderer exists */
  available: boolean;
  /** the keyboard number: ⌘1 … ⌘5 */
  index: 1 | 2 | 3 | 4 | 5;
}

export const MODES: readonly ModeInfo[] = [
  { id: "studio", label: "Studio", tagline: "Build visually", audience: "For researchers who want an intuitive modern builder.", available: true, index: 1 },
  { id: "grid", label: "Grid", tagline: "Program at scale", audience: "For high-speed questionnaire programming.", available: true, index: 2 },
  { id: "architect", label: "Architect", tagline: "Control every detail", audience: "For advanced survey programmers.", available: true, index: 3 },
  { id: "flow", label: "Flow", tagline: "See the survey's behavior", audience: "For complex routing and logic.", available: false, index: 4 },
  { id: "intelligent", label: "Intelligent", tagline: "Describe what you want", audience: "For users who want assistance while programming.", available: false, index: 5 },
];

export const DEFAULT_MODE: ProgrammingMode = "studio";

/** the localStorage key the last-used mode is remembered under */
export const MODE_STORAGE_KEY = "rescript.programmingMode";

export function isProgrammingMode(v: unknown): v is ProgrammingMode {
  return typeof v === "string" && MODES.some((m) => m.id === v);
}

export function modeInfo(id: ProgrammingMode): ModeInfo {
  return MODES.find((m) => m.id === id) ?? MODES[0];
}

/**
 * Which mode to open in. The URL wins over memory, and memory over the
 * default — a shared link says what to show; a returning programmer gets
 * what they last used. A mode that is not yet available falls back to the
 * default rather than opening on an empty screen, whatever asked for it.
 */
export function resolveInitialMode(search: string, remembered: string | null | undefined): ProgrammingMode {
  const fromUrl = new URLSearchParams(search).get("mode");
  const pick = (v: unknown): ProgrammingMode | null =>
    isProgrammingMode(v) && modeInfo(v).available ? v : null;
  return pick(fromUrl) ?? pick(remembered) ?? DEFAULT_MODE;
}

/** The URL with `?mode=` set (or removed for the default), other params kept. */
export function withModeInUrl(search: string, mode: ProgrammingMode): string {
  const p = new URLSearchParams(search);
  if (mode === DEFAULT_MODE) p.delete("mode"); else p.set("mode", mode);
  const s = p.toString();
  return s ? `?${s}` : "";
}

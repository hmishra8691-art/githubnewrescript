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
  { id: "flow", label: "Flow", tagline: "See the survey's behavior", audience: "For complex routing and logic.", available: true, index: 4 },
  { id: "intelligent", label: "Intelligent", tagline: "Describe what you want", audience: "For users who want assistance while programming.", available: true, index: 5 },
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

/* ================================================================ split */

/**
 * DUAL-MODE SPLIT (§15). A second renderer beside the first — Grid on the
 * left, Flow on the right — both over the one store, so an edit in either
 * shows in the other on the same render. The secondary is a property of
 * the view like the mode is: URL (`?split=flow`) and memory, never the
 * survey. A split of a mode with itself is refused; a split whose partner
 * becomes the primary is dropped rather than doubled.
 */
export const SPLIT_STORAGE_KEY = "rescript.programmingSplit";

/** below this width two renderers would each be too narrow to use; the split is not offered */
export const SPLIT_MIN_WIDTH = 1100;

export function resolveInitialSplit(search: string, remembered: string | null | undefined, primary: ProgrammingMode): ProgrammingMode | null {
  const fromUrl = new URLSearchParams(search).get("split");
  const pick = (v: unknown): ProgrammingMode | null =>
    isProgrammingMode(v) && modeInfo(v).available && v !== primary ? v : null;
  // a URL that names a mode is a deliberate view: it alone decides whether there is a split
  if (new URLSearchParams(search).has("mode")) return pick(fromUrl);
  return pick(fromUrl) ?? pick(remembered);
}

/** The URL with `?split=` set or removed, other params kept. */
export function withSplitInUrl(search: string, split: ProgrammingMode | null): string {
  const p = new URLSearchParams(search);
  if (split) p.set("split", split); else p.delete("split");
  const s = p.toString();
  return s ? `?${s}` : "";
}

/**
 * The pair after a change. Setting the primary to the current secondary
 * swaps them (the programmer clearly wants both, the other way round);
 * setting it to anything else keeps the secondary unless it would now be
 * the same mode. `secondary === primary` clears the split.
 */
export function nextPair(cur: { mode: ProgrammingMode; split: ProgrammingMode | null }, change: { mode?: ProgrammingMode; split?: ProgrammingMode | null }): { mode: ProgrammingMode; split: ProgrammingMode | null } {
  let mode = change.mode ?? cur.mode;
  let split = change.split === undefined ? cur.split : change.split;
  if (change.mode !== undefined && change.split === undefined && cur.split === change.mode) split = cur.mode;
  if (split === mode) split = null;
  if (split && !modeInfo(split).available) split = null;
  return { mode, split };
}

/* ============================================================== chooser */

/**
 * THE ONBOARDING CHOOSER (§10, §20): "How do you want to program your
 * research?" — shown once, the first time a browser opens the programming
 * tabs with no mode asked for. A shared `?mode=` link is an answer already;
 * a remembered mode is an answer already; a dismissed chooser stays
 * dismissed. It can always be reopened from the selector or ⌘K.
 */
export const CHOOSER_STORAGE_KEY = "rescript.modeChooserSeen";

export function shouldShowChooser(search: string, remembered: string | null | undefined, seen: string | null | undefined, opts: { sandbox?: boolean } = {}): boolean {
  const p = new URLSearchParams(search);
  // `?chooser=1` asks for it outright — the way to see the first run again, and the way the browser suite reaches it
  if (p.get("chooser") === "1") return true;
  if (seen) return false;
  if (p.has("mode")) return false;
  if (isProgrammingMode(remembered)) return false;
  /*
   * The sandbox is a scratch surface, not a project, and forty-odd browser
   * suites open it expecting the Questions panel and nothing in front of
   * it. A first run in the product is a first PROJECT; the sandbox gets
   * the chooser only when asked (`?chooser=1`, the ⓘ, ⌘K).
   */
  if (opts.sandbox) return false;
  return true;
}

/* ========================================================== permissions */

/**
 * WHAT EACH MODE MAY DO (round 2, §12). Five views of one survey, each with
 * a purpose; the purpose decides which edits a view offers, and nothing a
 * view offers is its own — every edit goes through the same engine
 * functions and the same store as Studio's.
 *
 *   Studio       build       everything
 *   Architect    structure   blocks, questions, placement, flow, logic — not every property
 *   Flow         understand  nothing is edited; click selects, double-click opens in Studio
 *   Grid         review      supported fields, in bulk — not a second builder
 *   Intelligent  assist      proposals over the same model, applied only on Apply
 *
 * `properties` says whether the Studio properties panel belongs beside the
 * view; `create` whether the view offers to add questions / blocks /
 * elements; `edit` whether the view edits fields in place. A split keeps
 * each pane's own permissions, and the properties panel is shown when ANY
 * pane wants it (§13: Studio beside Intelligent keeps its Properties).
 */
export interface ModeCapabilities {
  purpose: "build" | "structure" | "understand" | "review" | "assist";
  properties: boolean;
  create: boolean;
  edit: "full" | "structure" | "fields" | "proposals" | "none";
  /** a click on an object opens it in Studio rather than editing here */
  opensInStudio: boolean;
}

export const MODE_CAPABILITIES: Record<ProgrammingMode, ModeCapabilities> = {
  studio: { purpose: "build", properties: true, create: true, edit: "full", opensInStudio: false },
  architect: { purpose: "structure", properties: false, create: true, edit: "structure", opensInStudio: false },
  flow: { purpose: "understand", properties: false, create: false, edit: "none", opensInStudio: true },
  grid: { purpose: "review", properties: true, create: true, edit: "fields", opensInStudio: false },
  intelligent: { purpose: "assist", properties: false, create: false, edit: "proposals", opensInStudio: false },
};

/** whether the properties panel is shown beside a view or a pair of views */
export function propertiesWanted(mode: ProgrammingMode, split: ProgrammingMode | null): boolean {
  return MODE_CAPABILITIES[mode].properties || (!!split && MODE_CAPABILITIES[split].properties);
}

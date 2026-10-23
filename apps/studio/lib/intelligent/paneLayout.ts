/**
 * INTELLIGENT MODE'S THREE PANES, ADAPTIVE (2026-10-22, engine item #19).
 *
 * With the structure pane (240 px) and the inspector (360 px) open beside the conversation, a 1024 px
 * window left the conversation 418 px wide — its turn cards and plan tables wrapped into a column a
 * phone would recognise. The rule now: the CONVERSATION keeps at least `minMain` (600 px); the side
 * panes give way, in this order, until it does —
 *
 *   1  each docked pane shrinks toward its minimum (structure 180, inspector 260)
 *   2  the structure pane collapses to an icon RAIL (40 px); pressing it opens the pane as a DRAWER over
 *      the conversation (it takes no width)
 *   3  the inspector collapses to a rail the same way
 *   4  below the width where even two rails leave less than `minMain` (a phone), no rails: the toolbar's
 *      own buttons open the panes as drawers
 *
 * Widths the researcher set with a splitter are kept (localStorage) and used whenever they fit. Pure, so
 * the breakpoints are unit-tested (`paneLayout.test.ts`) and the browser suite measures the result.
 */

export const MIN_MAIN = 600;
export const SPLITTER = 6;
export const RAIL = 40;
export const PANE_LIMITS = { structure: { min: 180, max: 420, dflt: 240 }, inspector: { min: 260, max: 640, dflt: 360 } } as const;

export type PaneMode = "docked" | "rail" | "hidden";
export interface PaneLayoutInput {
  /** the width the workspace has (the `.iq` element) */
  width: number;
  structure: { open: boolean; width: number };
  inspector: { open: boolean; width: number };
  minMain?: number;
}
export interface PaneLayout {
  structure: PaneMode;
  inspector: PaneMode;
  structureWidth: number;
  inspectorWidth: number;
  mainWidth: number;
  /** the grid-template-columns that draws it (structure, its splitter, main, the inspector's splitter, inspector) */
  columns: string;
}

const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));

export function paneLayout(i: PaneLayoutInput): PaneLayout {
  const minMain = i.minMain ?? MIN_MAIN;
  const W = Math.max(0, Math.floor(i.width));
  const sw0 = clamp(Math.round(i.structure.width || PANE_LIMITS.structure.dflt), PANE_LIMITS.structure.min, PANE_LIMITS.structure.max);
  const iw0 = clamp(Math.round(i.inspector.width || PANE_LIMITS.inspector.dflt), PANE_LIMITS.inspector.min, PANE_LIMITS.inspector.max);
  let s: PaneMode = i.structure.open ? "docked" : "hidden";
  let n: PaneMode = i.inspector.open ? "docked" : "hidden";
  let sw = sw0, iw = iw0;
  const used = () => (s === "docked" ? sw + SPLITTER : s === "rail" ? RAIL : 0) + (n === "docked" ? iw + SPLITTER : n === "rail" ? RAIL : 0);
  const fits = () => W - used() >= minMain;
  /* 1 shrink: the inspector first (it is the wider), then the structure pane */
  if (!fits() && n === "docked") iw = clamp(iw - (minMain - (W - used())), PANE_LIMITS.inspector.min, iw0);
  if (!fits() && s === "docked") sw = clamp(sw - (minMain - (W - used())), PANE_LIMITS.structure.min, sw0);
  /* 2 the structure pane to a rail; give the inspector back what it can have */
  if (!fits() && s === "docked") { s = "rail"; if (n === "docked") iw = clamp(W - used() - minMain + iw, PANE_LIMITS.inspector.min, iw0); }
  /* 3 the inspector to a rail */
  if (!fits() && n === "docked") n = "rail";
  /* 4 no room even for rails: drawers from the toolbar only */
  if (!fits()) { if (s === "rail") s = "hidden"; if (n === "rail") n = "hidden"; }
  const mainWidth = Math.max(0, W - used());
  const cols: string[] = [];
  if (s === "docked") cols.push(`${sw}px`, `${SPLITTER}px`);
  else if (s === "rail") cols.push(`${RAIL}px`);
  cols.push("minmax(0, 1fr)");
  if (n === "docked") cols.push(`${SPLITTER}px`, `${iw}px`);
  else if (n === "rail") cols.push(`${RAIL}px`);
  return { structure: s, inspector: n, structureWidth: s === "docked" ? sw : 0, inspectorWidth: n === "docked" ? iw : 0, mainWidth, columns: cols.join(" ") };
}

/** a splitter moved by the keyboard: arrows 16 px (Shift: 64), Home / End to the limits */
export function splitterKey(key: string, shift: boolean, width: number, pane: keyof typeof PANE_LIMITS, side: "start" | "end", rtl: boolean): number | null {
  const lim = PANE_LIMITS[pane];
  const step = shift ? 64 : 16;
  /* the splitter sits after the start pane / before the end pane; "toward the pane" shrinks it — mirrored in RTL */
  const grows = (k: string) => {
    const right = k === "ArrowRight", left = k === "ArrowLeft";
    if (!right && !left) return null;
    const towardEnd = rtl ? left : right;
    return side === "start" ? towardEnd : !towardEnd;
  };
  if (key === "Home") return lim.min;
  if (key === "End") return lim.max;
  const g = grows(key);
  if (g === null) return null;
  return clamp(width + (g ? step : -step), lim.min, lim.max);
}

/** remembered widths, read defensively (a private window, blocked storage, a hand-edited value) */
export function readPaneWidths(raw: string | null): { inspector: number; structure: number } {
  try {
    const p = raw ? JSON.parse(raw) as { inspector?: unknown; structure?: unknown } : {};
    const num = (v: unknown, pane: keyof typeof PANE_LIMITS) => (typeof v === "number" && Number.isFinite(v) ? clamp(Math.round(v), PANE_LIMITS[pane].min, PANE_LIMITS[pane].max) : PANE_LIMITS[pane].dflt);
    return { inspector: num(p.inspector, "inspector"), structure: num(p.structure, "structure") };
  } catch { return { inspector: PANE_LIMITS.inspector.dflt, structure: PANE_LIMITS.structure.dflt }; }
}

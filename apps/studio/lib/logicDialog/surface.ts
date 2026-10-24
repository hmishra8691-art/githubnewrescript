/**
 * WHERE LOGIC IS EDITED — the one preference behind the logic workspace.
 *
 *   "workspace"  THE DEFAULT (23-Oct review: "clicking its configuration
 *                control should open a properly sized, centered popup instead
 *                of forcing users to configure complex rules inside a narrow
 *                sidebar"). In the narrow surfaces — the Properties panel and
 *                the Survey Flow cards (`CompactLogicScope`) — each rule set is
 *                a read-only summary (the sentence, the count, the active dot)
 *                with "Edit logic ⤢"; all editing happens in the centred dialog.
 *   "inline"     the explicit opt-out: the narrow surfaces keep the builders in
 *                place as well, with ⤢ beside each.
 *
 * Stored per browser in localStorage, never in the survey. Wide main panes
 * (Quotas, List Fill, Logic tab, …) are outside the compact scope and always
 * show their builders, with the ⤢ button.
 */
export type LogicSurface = "inline" | "workspace";

export const LOGIC_SURFACE_KEY = "rescript.logicSurface";
export const DEFAULT_LOGIC_SURFACE: LogicSurface = "workspace";
/** dispatched on `window` when the preference changes, so every open panel re-reads it */
export const LOGIC_SURFACE_EVENT = "rescript:logic-surface";

export function parseLogicSurface(raw: string | null | undefined): LogicSurface {
  return raw === "workspace" || raw === "inline" ? raw : DEFAULT_LOGIC_SURFACE;
}

export function readLogicSurface(storage: { getItem(k: string): string | null } | null | undefined): LogicSurface {
  try { return parseLogicSurface(storage?.getItem(LOGIC_SURFACE_KEY)); } catch { return DEFAULT_LOGIC_SURFACE; }
}

export function writeLogicSurface(storage: { setItem(k: string, v: string): void; removeItem(k: string): void } | null | undefined, next: LogicSurface): void {
  try {
    if (next === DEFAULT_LOGIC_SURFACE) storage?.removeItem(LOGIC_SURFACE_KEY); else storage?.setItem(LOGIC_SURFACE_KEY, next);
  } catch { /* private mode, blocked storage: the choice lasts for this page only */ }
}

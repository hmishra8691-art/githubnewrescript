import type { DashboardWidget } from "./types.js";

/**
 * DASHBOARD LAYOUT (§40) — where a widget actually sits.
 *
 * Until now `DashboardWidget` carried `x` and `y` and nothing ever set them:
 * every widget was written at 0,0 and the dashboard was a CSS auto-flow grid
 * that placed them in document order. Widgets could be made wider or taller,
 * but not PUT anywhere — which is the difference between a list of charts and
 * a dashboard.
 *
 * The geometry lives here, as pure functions over the widget list, rather than
 * inside the React component that handles the pointer. Placement rules are the
 * part that has to be right — a dashboard that loses a widget under another
 * one, or that reflows the moment it is reopened, is worse than one that never
 * moved at all — and they are only testable if they are separable from the
 * dragging.
 *
 * The grid is 12 columns wide and unbounded downwards; `h` is in row units,
 * matching the row height the stylesheet uses.
 */

export const DASHBOARD_COLUMNS = 12;

/**
 * The grid's pixel geometry lives beside its algebra because BOTH the
 * stylesheet and the drag arithmetic need it, and a dashboard whose CSS row
 * height disagrees with the row height the pointer maths assumes drifts
 * further from the cursor with every row — the widget lands one cell off at
 * the top of the canvas and four cells off at the bottom.
 */
export const DASHBOARD_ROW_PX = 60;
export const DASHBOARD_GAP_PX = 10;

export interface LayoutBox { x: number; y: number; w: number; h: number }

const overlaps = (a: LayoutBox, b: LayoutBox): boolean =>
  a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;

/** Force a box onto the grid: whole cells, at least 1×1, never past the right edge. */
export function clampBox(b: LayoutBox): LayoutBox {
  const w = Math.max(1, Math.min(DASHBOARD_COLUMNS, Math.round(b.w) || 1));
  const h = Math.max(1, Math.round(b.h) || 1);
  const x = Math.max(0, Math.min(DASHBOARD_COLUMNS - w, Math.round(b.x) || 0));
  const y = Math.max(0, Math.round(b.y) || 0);
  return { x, y, w, h };
}

/**
 * Place widgets left to right in array order, wrapping at the right edge —
 * exactly what the CSS auto-flow grid used to do.
 *
 * This is how a dashboard saved before this feature gets a layout: its widgets
 * all sit at 0,0, and dropping them straight into a positioned grid would
 * stack every one of them in the top-left cell. Flowing them in order
 * reproduces the arrangement their author last saw, which is the only
 * migration that does not silently rearrange somebody's work.
 */
export function flowLayout(widgets: DashboardWidget[]): DashboardWidget[] {
  let x = 0, y = 0, rowH = 0;
  return widgets.map((widget) => {
    const w = Math.max(1, Math.min(DASHBOARD_COLUMNS, Math.round(widget.w) || 1));
    const h = Math.max(1, Math.round(widget.h) || 1);
    if (x + w > DASHBOARD_COLUMNS) { x = 0; y += rowH; rowH = 0; }
    const placed = { ...widget, x, y, w, h };
    x += w;
    rowH = Math.max(rowH, h);
    return placed;
  });
}

/** True when nothing has ever been positioned — every widget still at the origin. */
export function isUnpositioned(widgets: DashboardWidget[]): boolean {
  return widgets.length > 1 && widgets.every((w) => (w.x ?? 0) === 0 && (w.y ?? 0) === 0);
}

/**
 * Push overlapping widgets down until nothing is hidden.
 *
 * `priorityId` is the widget the person just moved: it keeps the cell it was
 * dropped on, and everything else gives way. Without that, dropping a widget
 * onto an occupied cell would bounce the dragged one somewhere else, which
 * feels like the drag failed.
 *
 * Overlap is resolved, but GAPS ARE NOT CLOSED. Free placement means the empty
 * column someone left beside a KPI is a decision, not a defect; `compactLayout`
 * is there for when they want it tidied, and it is something they ask for.
 */
export function resolveOverlaps(widgets: DashboardWidget[], priorityId?: string): DashboardWidget[] {
  const order = [...widgets].sort((a, b) => {
    if (a.id === priorityId) return -1;
    if (b.id === priorityId) return 1;
    return a.y - b.y || a.x - b.x;
  });
  const placed: DashboardWidget[] = [];
  for (const widget of order) {
    let box: LayoutBox = clampBox(widget);
    // a widget can be pushed past several others, so keep going until it lands
    for (let guard = 0; guard < 200; guard++) {
      const hit = placed.find((p) => overlaps(box, p));
      if (!hit) break;
      box = { ...box, y: hit.y + hit.h };
    }
    placed.push({ ...widget, ...box });
  }
  // hand back the caller's own ordering: array order is the saved definition's
  // order, and a drag should not rewrite it
  const byId = new Map(placed.map((w) => [w.id, w]));
  return widgets.map((w) => byId.get(w.id) ?? w);
}

/**
 * Everything a stored layout needs before it can be drawn: whole cells, a
 * flow for the dashboards that predate positioning, and no widget hidden
 * under another. Idempotent, so running it on every render is safe.
 */
export function normalizeLayout(widgets: DashboardWidget[]): DashboardWidget[] {
  if (!widgets.length) return widgets;
  const base = isUnpositioned(widgets) ? flowLayout(widgets) : widgets.map((w) => ({ ...w, ...clampBox(w) }));
  return resolveOverlaps(base);
}

/** Move or resize one widget, then settle everything around it. */
export function placeWidget(widgets: DashboardWidget[], id: string, box: LayoutBox): DashboardWidget[] {
  const next = widgets.map((w) => (w.id === id ? { ...w, ...clampBox(box) } : w));
  return resolveOverlaps(next, id);
}

/**
 * Pull every widget as far up as it will go without colliding — the "tidy up"
 * a dashboard wants after widgets have been moved around and left holes. This
 * is explicit rather than automatic: see `resolveOverlaps`.
 */
export function compactLayout(widgets: DashboardWidget[]): DashboardWidget[] {
  const order = [...widgets].sort((a, b) => a.y - b.y || a.x - b.x);
  const placed: DashboardWidget[] = [];
  for (const widget of order) {
    let box: LayoutBox = clampBox(widget);
    while (box.y > 0 && !placed.some((p) => overlaps({ ...box, y: box.y - 1 }, p))) box = { ...box, y: box.y - 1 };
    placed.push({ ...widget, ...box });
  }
  const byId = new Map(placed.map((w) => [w.id, w]));
  return widgets.map((w) => byId.get(w.id) ?? w);
}

/**
 * Reading order: left to right, top to bottom.
 *
 * The rendered list is sorted by position rather than by array index so that
 * the DOM order matches what the eye sees — which is what a screen reader
 * announces, what the keyboard tabs through, and what the single-column
 * phone layout stacks. After a few drags the array order says nothing about
 * the arrangement, and without this the narrow-screen view would put widgets
 * in an order nobody chose.
 */
export function sortByPosition(widgets: DashboardWidget[]): DashboardWidget[] {
  return [...widgets].sort((a, b) => a.y - b.y || a.x - b.x);
}

/** The first cell a new widget of this size fits in, scanning top to bottom. */
export function firstFreeSlot(widgets: DashboardWidget[], w: number, h: number): { x: number; y: number } {
  const width = Math.max(1, Math.min(DASHBOARD_COLUMNS, Math.round(w) || 1));
  const height = Math.max(1, Math.round(h) || 1);
  const taken = widgets.map(clampBox);
  const maxY = taken.reduce((m, b) => Math.max(m, b.y + b.h), 0);
  for (let y = 0; y <= maxY; y++) {
    for (let x = 0; x + width <= DASHBOARD_COLUMNS; x++) {
      const box = { x, y, w: width, h: height };
      if (!taken.some((t) => overlaps(box, t))) return { x, y };
    }
  }
  return { x: 0, y: maxY };
}

/** How many rows the layout needs, for sizing the canvas. */
export function layoutRows(widgets: DashboardWidget[]): number {
  return widgets.reduce((m, w) => Math.max(m, (w.y ?? 0) + (w.h ?? 1)), 0);
}

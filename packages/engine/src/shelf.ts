import type { Question } from "@rescript/schema";

/**
 * S5c item 5 — SHELF TEST (audit SM-16), variant `hotspot.shelf` (image_select, renderer `shelf`).
 *
 * A shelf photo whose products are regions (the hotspot machinery: option.meta.region {x, y, w, h} in % of the
 * image). Task: "pick the product you would buy". The ANSWER is the picked product's code (one region — an
 * ordinary single choice that reports, pipes and exports like any other). Beside it, as paradata (embedded data,
 * client-measured — the browser's clock, like every timing):
 *   SHELF_<CODE>_TIME      seconds from the shelf first shown to the pick (time to find)
 *   SHELF_<CODE>_EXAMINED  the products looked at before the pick, in order (hover or keyboard focus, each once)
 *   SHELF_<CODE>_PICK2     the second choice ("if that one were not there"), when settings.shelf.secondPick
 */
export function shelfParadataKeys(code: string): { time: string; examined: string; pick2: string } {
  const c = code.replace(/[^A-Za-z0-9_]/g, "_").toUpperCase();
  return { time: `SHELF_${c}_TIME`, examined: `SHELF_${c}_EXAMINED`, pick2: `SHELF_${c}_PICK2` };
}

/** the examined list: each product once, in the order first looked at */
export function noteExamined(list: readonly string[], code: string): string[] {
  return list.includes(code) ? [...list] : [...list, code];
}

/** seconds, one decimal, never negative */
export const shelfSeconds = (ms: number): number => Math.max(0, Math.round(ms / 100) / 10);

export function lintShelf(q: Question): string[] {
  const out: string[] = [];
  if (!q.settings.imageUrl) out.push(`${q.code}: a shelf test needs the shelf image (imageUrl)`);
  const drawn = (q.options ?? []).filter((o) => { const r = o.meta?.region as { w?: number; h?: number } | undefined; return r && Number(r.w) > 0 && Number(r.h) > 0; });
  if (drawn.length < 2) out.push(`${q.code}: draw at least two product regions on the shelf (${drawn.length} drawn)`);
  if ((q.settings.maxSelections ?? 1) !== 1) out.push(`${q.code}: a shelf pick is one product — set maxSelections to 1 (the second choice is settings.shelf.secondPick)`);
  return out;
}

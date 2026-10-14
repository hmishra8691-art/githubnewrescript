/*
 * The table formatting a researcher saved in the editor (heat, counts under percentages, decimals, tinted significance)
 * is stored in the analysis definition. A report or a shared page shows a result, and a result carries the definition it
 * was computed from (its provenance), so the saved formatting travels with it (audit C-11). Anything unreadable is "no
 * formatting", never an error.
 */
export interface SavedTableFormatting { heat?: boolean; highlightSig?: boolean; showCounts?: boolean; decimals?: number; dense?: boolean }

export function formattingOf(result: { provenance?: { definition?: { options?: unknown } } } | null | undefined): SavedTableFormatting | undefined {
  const f = (result?.provenance?.definition?.options as { formatting?: unknown } | undefined)?.formatting;
  if (!f || typeof f !== "object" || Array.isArray(f)) return undefined;
  const o = f as Record<string, unknown>;
  const out: SavedTableFormatting = {};
  if (o.heat === true) out.heat = true;
  if (o.highlightSig === true) out.highlightSig = true;
  if (o.showCounts === true) out.showCounts = true;
  if (o.dense === true) out.dense = true;
  if (typeof o.decimals === "number" && Number.isFinite(o.decimals)) out.decimals = Math.max(0, Math.min(4, Math.round(o.decimals)));
  return Object.keys(out).length ? out : undefined;
}

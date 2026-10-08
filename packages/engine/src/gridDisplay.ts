import type { Option, Question } from "@rescript/schema";
import { resolveVariant } from "@rescript/schema";

/* ======================================================= header repeat (P2) */

/**
 * REPEATING A GRID'S COLUMN HEADER (07-10-2026 review, Prince #2).
 *
 * On a long grid the column header scrolls away and a respondent rating row
 * 18 no longer knows which circle means "Agree". The header can be drawn
 * again inside the grid every N rows. Display only: the repeated header is
 * the same cells, marked hidden from assistive technology (the real header
 * still labels every cell), and no column, value or variable is added.
 *
 *   "off"      never repeated
 *   "auto"     about every 10 rows (`AUTO_HEADER_EVERY`)
 *   a number   after every N rows (5, 10, 15, 20, 25, or the author's own)
 *   unset      the default for the grid's length — off up to 20 rows, Auto
 *              beyond ("1–15 rows off, 16–20 available, 20+ enable Auto")
 */
export const AUTO_HEADER_EVERY = 10;
export const HEADER_REPEAT_PRESETS = [5, 10, 15, 20, 25] as const;
/** a grid longer than this repeats its header unless the author says otherwise */
export const HEADER_REPEAT_DEFAULT_ABOVE = 20;
/** from here the builder suggests it */
export const HEADER_REPEAT_SUGGEST_FROM = 16;

export type HeaderRepeat = "off" | "auto" | number;

/** The grids that draw a column header row, so have one to repeat. */
const HEADER_RENDERERS = new Set(["likert", "ratingmatrix", "summatrix", "spreadsheet", "slidermatrix", "semantic"]);
const HEADER_TYPES = new Set(["matrix_single", "matrix_multi", "matrix_numeric", "matrix_text", "matrix_dropdown", "composite", "custom_table"]);

export function headerRepeatApplies(q: { type: string; variant?: string | null }): boolean {
  if (!HEADER_TYPES.has(q.type)) return false;
  const renderer = resolveVariant(q.variant ?? undefined)?.renderer;
  return !renderer || HEADER_RENDERERS.has(renderer);
}

/** Rows between headers for a grid of `rowCount` rows, or null for none. */
export function headerRepeatEvery(setting: HeaderRepeat | undefined | null, rowCount: number): number | null {
  const s = setting ?? (rowCount > HEADER_REPEAT_DEFAULT_ABOVE ? "auto" : "off");
  if (s === "off") return null;
  const every = s === "auto" ? AUTO_HEADER_EVERY : Math.floor(Number(s));
  if (!Number.isFinite(every) || every < 1) return null;
  // a header after the last row, or one repeated before a single trailing row, is noise
  return rowCount > every ? every : null;
}

/** Is a repeated header drawn before the row at `index` (0-based)? */
export function headerRepeatsBefore(index: number, every: number | null, rowCount: number): boolean {
  if (!every || index <= 0 || index % every !== 0) return false;
  return index < rowCount;
}

/* ===================================================== Rating Matrix (P1) */

/**
 * A RATING MATRIX'S COLUMNS (07-10-2026 review, Prince #1).
 *
 * The rating points are the question's options — codes 1…N, the numbers the
 * data stores — and their labels are what the column headers say: the
 * numbers themselves, or words ("Very Poor … Excellent"). Keeping the header
 * in the option label means the builder, the preview, Test Survey, the live
 * survey and the export's value labels all read one thing. Switching to
 * Numbers keeps the words (in `meta.textLabel`), so switching back restores
 * what the author wrote.
 */
export const RATING_SCALE_SIZES = [3, 4, 5, 7, 10] as const;

export const RATING_TEXT_LABELS: Record<number, readonly string[]> = {
  3: ["Poor", "Neutral", "Good"],
  4: ["Poor", "Fair", "Good", "Excellent"],
  5: ["Very Poor", "Poor", "Neutral", "Good", "Excellent"],
  7: ["Very Poor", "Poor", "Fair", "Neutral", "Good", "Very Good", "Excellent"],
};

export type RatingLabelMode = "numbers" | "text";

const plain = (s: string) => s.replace(/<[^>]*>/g, "").trim();
const isNumberLabel = (o: Pick<Option, "code" | "label">) => plain(String(o.label ?? "")) === String(o.code);

/** What the column headers show — the setting, or what the labels already are. */
export function ratingLabelMode(q: Pick<Question, "settings" | "options">): RatingLabelMode {
  const set = (q.settings as { ratingLabels?: RatingLabelMode }).ratingLabels;
  if (set === "numbers" || set === "text") return set;
  return (q.options ?? []).every(isNumberLabel) ? "numbers" : "text";
}

/** The word a point is given when it has none of its own. */
function standardText(n: number, i: number, code: string | number): string {
  return RATING_TEXT_LABELS[n]?.[i] ?? String(code);
}

/**
 * A scale of `n` points, 1…n, labelled for `mode`. Points that already exist
 * keep their label (or remembered words) and everything else they carry.
 */
export function ratingScaleOptions(n: number, mode: RatingLabelMode, prev: readonly Option[] = []): Option[] {
  const size = Math.max(2, Math.min(10, Math.floor(n)));
  const sameSize = prev.length === size;
  const points = Array.from({ length: size }, (_, i) => {
    const code = i + 1;
    const old = prev.find((o) => String(o.code) === String(code));
    // the author's own words for this point survive a resize only when the scale keeps its size
    const own = old && sameSize ? (isNumberLabel(old) ? (old.meta?.textLabel as string | undefined) : String(old.label)) : undefined;
    const meta = { ...(old?.meta ?? {}) } as Record<string, unknown>;
    delete meta.textLabel;
    if (own) meta.textLabel = own;
    const point = { flags: [], ...(old ?? {}), code, label: String(code) } as Option;
    if (Object.keys(meta).length) point.meta = meta; else delete (point as { meta?: unknown }).meta;
    return point;
  });
  return mode === "numbers" ? points : switchRatingLabels(points, "text");
}

/** The same points, relabelled for `mode`. */
export function switchRatingLabels(options: readonly Option[], mode: RatingLabelMode): Option[] {
  const n = options.length;
  return options.map((o, i) => {
    const meta = { ...(o.meta ?? {}) } as Record<string, unknown>;
    if (mode === "numbers") {
      if (!isNumberLabel(o)) meta.textLabel = String(o.label);
      const next = { ...o, label: String(o.code) } as Option;
      if (Object.keys(meta).length) next.meta = meta;
      return next;
    }
    const words = isNumberLabel(o) ? ((meta.textLabel as string | undefined) ?? standardText(n, i, o.code)) : String(o.label);
    delete meta.textLabel;
    const next = { ...o, label: words } as Option;
    if (Object.keys(meta).length) next.meta = meta; else delete (next as { meta?: unknown }).meta;
    return next;
  });
}

/**
 * WHAT EACH RENDERER ACTUALLY READS.
 *
 * The Studio decides which controls to offer from a variant's `capabilities`
 * list. That list describes a question's SHAPE, which is the right thing for
 * the schema migration to read — but it is not the same question as "will
 * anything happen if I set this?", and the September 2026 review found the
 * gap twice over. A Multi-Select Dropdown offered a column layout its
 * renderer cannot draw. A card-sort question accepted an image URL on each
 * option, confirmed it with a green tick, and drew none of them, because that
 * renderer takes its images from the rows.
 *
 * A control that cannot take effect is worse than a missing one: the
 * programmer believes they have made a setting, and nothing ever tells them
 * otherwise. So the facts live here, beside the renderers, and the editor
 * asks. The key is the one the dispatcher uses: a variant's `renderer`, or
 * `base:<type>` when it has none.
 *
 * ---------------------------------------------------------------------------
 * COLUMNS.
 *
 * "Layout: 1 column" was the single most reported bug in the September
 * question-type review — fourteen separate write-ups of the same complaint
 * across Button, Card, Tile, Image, Icon, Product, List and Statement select,
 * single and multi. There were two causes and they compounded.
 *
 * THE FIRST was that the editor could not express "1". It wrote `undefined`
 * for one column, which is indistinguishable from "never chosen", so every
 * renderer fell through to its own fallback — two for cards, three for rich
 * cards, four for icons, `auto-fill` for image grids. Picking 1 column
 * therefore did nothing at all, and picking 2, 3 or 4 worked, which is
 * exactly the shape the reports described. The editor now stores the number
 * it is given, including 1, and offers an explicit "auto" for the old
 * unset meaning, so the control can no longer say something the question
 * does not mean. Existing questions keep their `undefined` and go on
 * rendering exactly as they did.
 *
 * THE SECOND is this file. The control was shown by capability, and the
 * capability lists say `layout_columns` for several variants whose renderer
 * never reads it — a Multi-Select Dropdown, a carousel — and the editor
 * also showed every control to any question with no variant at all. A
 * control that cannot take effect is worse than a missing one: it is a
 * setting the programmer believes they have made. So the fact lives here,
 * next to the renderers, and the editor asks.
 *
 * The key is the one the dispatcher uses: a variant's `renderer`, or
 * `base:<type>` when it has none.
 */

/** Renderer keys whose grid reads `settings.columnsLayout`. */
export const COLUMN_RENDERERS: ReadonlySet<string> = new Set([
  /* option grids with a cols-N class */
  "buttons",
  "cards",
  "icons",
  "richcards",
  "listrows",
  "statements",
  "flipcards",
  "dragbuckets",
  "adaptive",
  /* grids that take an inline gridTemplateColumns override */
  "categorize",
  "compare",
  /* base types whose default renderer honours it */
  "base:single_select",
  "base:multi_select",
  "base:image_select",
  "base:image_ranking",
  "base:numeric_list",
  "base:text_list",
]);

/**
 * WHICH RENDERERS DRAW AN OPTION'S OWN IMAGE (`option.imageUrl`).
 *
 * Everything else ignores it. A plain radio or checkbox list draws a control
 * and a label and nothing more; `categorize` draws its pictures from
 * `row.meta.image`, because in a card-sort the options are the buckets and
 * the rows are the things being sorted — which is exactly the question the
 * review filed an image against, with three URLs set on the buckets and no
 * pictures anywhere in the preview.
 */
export const IMAGE_RENDERERS: ReadonlySet<string> = new Set([
  "cards",
  "icons",
  "listrows",
  "richcards",
  "flipcards",
  "carousel",
  "multicarousel",
  "compare",
  "attrcompare",
  "swipe",
  "dragrank",
  "base:image_select",
  "base:image_ranking",
]);

/** The dispatch key for a question: its variant's renderer, or `base:<type>`. */
export function rendererKey(renderer: string | undefined, baseType: string): string {
  return renderer ?? `base:${baseType}`;
}

/**
 * Does the thing that will draw this question read the column setting?
 * The Studio asks this before offering the Layout control.
 */
export function honoursColumns(renderer: string | undefined, baseType: string): boolean {
  return COLUMN_RENDERERS.has(rendererKey(renderer, baseType));
}

/**
 * Will an image URL set on an option ever be shown to a respondent? The
 * Studio asks before offering the field — and before telling the author
 * their image is fine.
 */
export function drawsOptionImages(renderer: string | undefined, baseType: string): boolean {
  return IMAGE_RENDERERS.has(rendererKey(renderer, baseType));
}

/**
 * WHICH RENDERERS ACTUALLY LAY OPTIONS OUT IN COLUMNS.
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

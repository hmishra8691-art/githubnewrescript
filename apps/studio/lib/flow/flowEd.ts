/**
 * PURE HELPERS FOR THE SURVEY FLOW EDITORS (document 15/10/2026, items B, C, F).
 *
 * Kept out of the components so the rules the browser suite checks visually
 * are also pinned by unit tests: how wide a compact value field starts, how a
 * long "stored as" preview is shortened, where a piped token lands, and how
 * the arrow keys move through the Add Element grid.
 */

/**
 * The width a compact value field asks for, in `ch`: the longest line plus
 * room for the caret, never narrower than `min`. The CSS caps it at the
 * container (`max-width: 100%`), where the text wraps instead — so "Male",
 * "25" and "India" get a small field and a list of hundreds of ZIP codes gets
 * the full width and grows DOWNWARDS, never past the card.
 */
export function compactWidthCh(value: string, min = 12, max = 200): number {
  const longest = String(value ?? "").split(/\r?\n/).reduce((n, l) => Math.max(n, l.length), 0);
  return Math.max(min, Math.min(max, longest + 3));
}

/**
 * A preview shortened for display. `full` is kept so an expand control can
 * show everything; `truncated` says whether that control is needed.
 */
export function previewText(text: string, limit = 140): { shown: string; truncated: boolean; length: number } {
  const s = String(text ?? "");
  if (s.length <= limit) return { shown: s, truncated: false, length: s.length };
  // cut at a separator near the limit when there is one, so a list ends on a whole item
  const cut = s.lastIndexOf(",", limit);
  const at = cut > limit * 0.6 ? cut + 1 : limit;
  return { shown: `${s.slice(0, at).trimEnd()} …`, truncated: true, length: s.length };
}

/** Insert `token` over the selection [start, end) of `value`; the caret goes after it. */
export function insertAt(value: string, start: number | null | undefined, end: number | null | undefined, token: string): { value: string; caret: number } {
  const v = String(value ?? "");
  const s = Math.max(0, Math.min(v.length, start ?? v.length));
  const e = Math.max(s, Math.min(v.length, end ?? s));
  return { value: `${v.slice(0, s)}${token}${v.slice(e)}`, caret: s + token.length };
}

/**
 * Keyboard movement through a grid of `count` buttons, `cols` per row.
 * Arrow keys move one step (left/right wrap across rows), Home / End jump to
 * the ends. Anything else: unchanged (`null`).
 */
export function gridMove(index: number, key: string, cols: number, count: number): number | null {
  if (count <= 0) return null;
  const clamp = (i: number) => Math.max(0, Math.min(count - 1, i));
  switch (key) {
    case "ArrowRight": return clamp(index + 1);
    case "ArrowLeft": return clamp(index - 1);
    case "ArrowDown": return index + cols < count ? index + cols : index;
    case "ArrowUp": return index - cols >= 0 ? index - cols : index;
    case "Home": return 0;
    case "End": return count - 1;
    default: return null;
  }
}

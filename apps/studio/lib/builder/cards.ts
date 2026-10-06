import type { Option, Question } from "@rescript/schema";

/**
 * SWIPE CARDS — the pure half of the cards builder
 * (`components/studio/variantConfig/swipe.tsx`). A card is a row: its title
 * is the label, the rest is `row.meta` (engine `cards.ts` reads it).
 */

/**
 * THE RANKS, AS OPTIONS. When Swipe to Rate / Rank / Categorize records a
 * rank, the stored code is the rank number; the options exist so every
 * report can label it ("Rank 1" … "Rank N"), one per card.
 */
export function rankOptions(cards: number): Option[] {
  return Array.from({ length: Math.max(1, cards) }, (_, i) => ({ code: i + 1, label: `Rank ${i + 1}`, flags: [] }) as Option);
}

/** Are the options exactly Rank 1…N for N cards? */
export function ranksInStep(options: Pick<Option, "code" | "label">[], cards: number): boolean {
  const want = rankOptions(cards);
  return options.length === want.length && want.every((o, i) => String(options[i].code) === String(o.code) && options[i].label === o.label);
}

/** What the options become when the response type changes. */
export function optionsForResponse(mode: "rate" | "rank" | "categorize", q: Pick<Question, "options" | "rows" | "settings">): Option[] {
  const from = q.settings.swipeResponse ?? "rate";
  if (mode === "rank") return rankOptions(q.rows.length);
  if (from !== "rank") return q.options;
  return mode === "categorize"
    ? [{ code: "like", label: "Like", flags: [] }, { code: "neutral", label: "Neutral", flags: [] }, { code: "dislike", label: "Dislike", flags: [] }] as Option[]
    : [1, 2, 3, 4, 5].map((n) => ({ code: n, label: String(n), flags: [] }) as Option);
}

/** Move an entry (a card's field) one place up (-1) or down (+1); out of range is a no-op. */
export function moveItem<T>(rows: T[], i: number, by: -1 | 1): T[] {
  const j = i + by;
  if (i < 0 || i >= rows.length || j < 0 || j >= rows.length) return rows;
  const next = rows.slice();
  [next[i], next[j]] = [next[j], next[i]];
  return next;
}

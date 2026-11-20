/**
 * THE WORDS OF A RESULT (phase 2, 2026-11-20) — shared by the results page and the PDF report, so both say the same.
 */
export interface Standing { n: number; mean: number; median: number; below: number; above: number }

/** a number as a person writes it: 9, 4.5, 49.7 */
export const fmtScore = (n: number): string => (Number.isInteger(n) ? String(n) : n.toFixed(Math.abs(n) < 10 ? 2 : 1).replace(/0+$/, "").replace(/\.$/, ""));

/** where a value sits between the two ends of a range, 0–100; null when the range is not known */
export const placeOn = (v: number, min: number | null, max: number | null): number | null => (min !== null && max !== null && max > min ? Math.min(100, Math.max(0, ((v - min) / (max - min)) * 100)) : null);

/** "Higher than 62% of 143 people" — worded from the good end for a score where less is better */
export function standingText(s: Standing, higherIsBetter: boolean): string {
  if (s.below === 0 && s.above === 0) return `The same as the ${s.n} people compared`;
  return `${higherIsBetter ? "Higher" : "Lower"} than ${higherIsBetter ? s.below : s.above}% of ${s.n} people`;
}

export const NOTE_GROUPS = "Comparisons are with groups of at least ten people. Nobody's individual result is shown to anyone else.";
export const NOTE_NOT_ADVICE = "Scores describe the answers you gave. They are not a diagnosis or professional advice.";

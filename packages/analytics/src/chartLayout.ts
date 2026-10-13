/**
 * SHARED CHART GEOMETRY — the arithmetic of stacked and diverging bars, in one place.
 *
 * The browser chart, the animated HTML story and the PowerPoint export each used to work out a diverging bar for
 * themselves, and each got it differently wrong (audit C-1, C-2): the neutral was not centred, the most negative
 * series sat next to the centre, a single series was drawn from 50 to 50 + v, and bars overflowed the axis. Every
 * renderer now takes its segments from here, so one test of this file covers all three.
 */

/** each part as a share of its own stack, summing to 100 (negatives and missing values count as 0; an empty stack is all zeros) */
export function stackShares(values: (number | null | undefined)[]): number[] {
  const v = values.map((x) => (typeof x === "number" && Number.isFinite(x) && x > 0 ? x : 0));
  const total = v.reduce((a, b) => a + b, 0);
  return total ? v.map((x) => (x / total) * 100) : v.map(() => 0);
}

export interface DivergingSegment { /** index of the series in the input order (lowest scale point first) */ index: number; from: number; to: number }
export interface DivergingLayout { segments: DivergingSegment[]; /** how far the bar reaches left of the centre, ≥ 0 */ left: number; /** how far it reaches right of the centre, ≥ 0 */ right: number }

/**
 * A diverging stacked bar for an ordered scale, series given lowest point first.
 *  - the lower half of the scale goes left of the centre, the upper half right;
 *  - with an odd number of points the middle one (the neutral) straddles the centre;
 *  - within each side the series nearest the middle of the scale sits nearest the centre.
 * Positions are in the same units as the shares (percent of the stack), with the centre at 0.
 * Returns null for fewer than two series: a single series has no "sides" and is an ordinary bar.
 */
export function divergingLayout(shares: number[]): DivergingLayout | null {
  const k = shares.length;
  if (k < 2) return null;
  const half = Math.floor(k / 2), odd = k % 2 === 1;
  const neutral = odd ? shares[half] : 0;
  const segments: DivergingSegment[] = [];
  let cl = -neutral / 2;
  for (let j = half - 1; j >= 0; j--) { segments.push({ index: j, from: cl - shares[j], to: cl }); cl -= shares[j]; }
  if (odd) segments.push({ index: half, from: -neutral / 2, to: neutral / 2 });
  let cr = neutral / 2;
  for (let j = odd ? half + 1 : half; j < k; j++) { segments.push({ index: j, from: cr, to: cr + shares[j] }); cr += shares[j]; }
  return { segments: segments.sort((a, b) => a.index - b.index), left: -cl, right: cr };
}

/**
 * The same bar as signed values for a chart library that stacks positive and negative values outward from zero
 * (PowerPoint has no diverging type). Series come out in stacking order, so a neutral appears twice (a half on
 * each side): `index` says which input series each entry draws, `half` marks the two halves of a neutral.
 */
export function divergingSeriesOrder(k: number): { index: number; sign: -1 | 1; half?: boolean }[] {
  if (k < 2) return [];
  const h = Math.floor(k / 2), odd = k % 2 === 1;
  const out: { index: number; sign: -1 | 1; half?: boolean }[] = [];
  if (odd) out.push({ index: h, sign: -1, half: true });
  for (let j = h - 1; j >= 0; j--) out.push({ index: j, sign: -1 });
  if (odd) out.push({ index: h, sign: 1, half: true });
  for (let j = odd ? h + 1 : h; j < k; j++) out.push({ index: j, sign: 1 });
  return out;
}

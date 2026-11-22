/**
 * SPEECH MEASURES (roadmap Q1) — the arithmetic a provider comparison needs, with no provider in it.
 *
 * Word error rate is (substitutions + deletions + insertions) / words in the reference, on text normalised the
 * same way for every provider: lower case, punctuation removed, digits kept. For a language written without
 * spaces (Chinese, Japanese, Thai) the unit is the character, which is the convention for those languages.
 */
const NO_SPACES = /[぀-ヿ㐀-鿿฀-๿]/;
export function speechTokens(text: string): string[] {
  const t = String(text ?? "").normalize("NFKC").toLowerCase().replace(/[^\p{L}\p{N}\p{M}'\s]/gu, " ").replace(/\s+/g, " ").trim();
  if (!t) return [];
  return NO_SPACES.test(t) ? [...t.replace(/\s/g, "")] : t.split(" ");
}

export interface WordErrors { words: number; substitutions: number; deletions: number; insertions: number; rate: number }
export function wordErrorRate(reference: string, hypothesis: string): WordErrors {
  const r = speechTokens(reference), h = speechTokens(hypothesis);
  /* edit distance with the three kinds of error kept apart */
  type Cell = [cost: number, sub: number, del: number, ins: number];
  let prev: Cell[] = Array.from({ length: h.length + 1 }, (_, j) => [j, 0, 0, j] as Cell);
  for (let i = 1; i <= r.length; i++) {
    const row: Cell[] = [[i, 0, i, 0]];
    for (let j = 1; j <= h.length; j++) {
      if (r[i - 1] === h[j - 1]) { row.push(prev[j - 1]!); continue; }
      const s = prev[j - 1]!, d = prev[j]!, n = row[j - 1]!;
      if (s[0] <= d[0] && s[0] <= n[0]) row.push([s[0] + 1, s[1] + 1, s[2], s[3]]);
      else if (d[0] <= n[0]) row.push([d[0] + 1, d[1], d[2] + 1, d[3]]);
      else row.push([n[0] + 1, n[1], n[2], n[3] + 1]);
    }
    prev = row;
  }
  const [cost, substitutions, deletions, insertions] = prev[h.length]!;
  return { words: r.length, substitutions, deletions, insertions, rate: r.length ? cost / r.length : h.length ? 1 : 0 };
}

/** the rate over a whole set: total errors over total reference words, not the mean of the clips' rates */
export function corpusWordErrorRate(pairs: { reference: string; hypothesis: string }[]): number {
  let errors = 0, words = 0;
  for (const p of pairs) { const w = wordErrorRate(p.reference, p.hypothesis); errors += w.substitutions + w.deletions + w.insertions; words += w.words; }
  return words ? errors / words : 0;
}

/** nearest-rank percentile, p in 0..100 */
export function percentile(values: number[], p: number): number {
  if (!values.length) return 0;
  const s = [...values].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.max(0, Math.ceil((p / 100) * s.length) - 1))]!;
}

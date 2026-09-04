/**
 * Small, dependency-free statistics and text measures the rules share.
 * Everything here is pure and unit-tested on its own.
 */

export const clamp = (n: number, lo = 0, hi = 100) => Math.max(lo, Math.min(hi, n));
export const round1 = (n: number) => Math.round(n * 10) / 10;
export const pct = (n: number) => `${Math.round(n * 100)}%`;

export function median(xs: number[]): number | null {
  const a = xs.filter((x) => Number.isFinite(x)).sort((p, q) => p - q);
  if (!a.length) return null;
  const m = a.length >> 1;
  return a.length % 2 ? a[m] : (a[m - 1] + a[m]) / 2;
}

export function mean(xs: number[]): number | null {
  const a = xs.filter((x) => Number.isFinite(x));
  return a.length ? a.reduce((s, x) => s + x, 0) / a.length : null;
}

export function stddev(xs: number[]): number | null {
  const a = xs.filter((x) => Number.isFinite(x));
  if (a.length < 2) return null;
  const m = a.reduce((s, x) => s + x, 0) / a.length;
  return Math.sqrt(a.reduce((s, x) => s + (x - m) ** 2, 0) / (a.length - 1));
}

/** coefficient of variation — 0 for perfectly uniform values */
export function cv(xs: number[]): number | null {
  const m = mean(xs); const sd = stddev(xs);
  if (m === null || sd === null || m === 0) return null;
  return sd / m;
}

/** Shannon entropy in bits of a categorical distribution. */
export function entropy(values: unknown[]): number {
  const counts = new Map<string, number>();
  for (const v of values) counts.set(String(v), (counts.get(String(v)) ?? 0) + 1);
  const n = values.length;
  if (n === 0) return 0;
  let h = 0;
  for (const c of counts.values()) { const p = c / n; h -= p * Math.log2(p); }
  return h;
}

/** entropy / log2(distinct values available) — 1 = perfectly spread, 0 = one value */
export function normalizedEntropy(values: unknown[], categories: number): number {
  if (categories <= 1 || values.length === 0) return 0;
  return entropy(values) / Math.log2(categories);
}

/** Is a numeric sequence an arithmetic progression with |step| = 1 (1,2,3… or 5,4,3…)? */
export function isDiagonal(xs: number[]): boolean {
  if (xs.length < 3) return false;
  const step = xs[1] - xs[0];
  if (Math.abs(step) !== 1) return false;
  for (let i = 2; i < xs.length; i++) if (xs[i] - xs[i - 1] !== step) return false;
  return true;
}

/** a,b,a,b,… (or a,b,c,a,b,c) with period 2 or 3 */
export function repeatingPeriod(xs: unknown[]): number | null {
  if (xs.length < 4) return null;
  for (const p of [2, 3]) {
    if (xs.length < p * 2) continue;
    let ok = true;
    for (let i = p; i < xs.length; i++) if (String(xs[i]) !== String(xs[i - p])) { ok = false; break; }
    // must not be a straight line in disguise
    if (ok && new Set(xs.slice(0, p).map(String)).size > 1) return p;
  }
  return null;
}

/** Longest run of the same value. */
export function longestRun(xs: unknown[]): number {
  let best = 0, cur = 0, prev: string | undefined;
  for (const x of xs) {
    const k = String(x);
    cur = k === prev ? cur + 1 : 1;
    prev = k;
    if (cur > best) best = cur;
  }
  return best;
}

/** Share of positions where consecutive values differ — 1 = alternates every time. */
export function transitionRate(xs: unknown[]): number {
  if (xs.length < 2) return 0;
  let t = 0;
  for (let i = 1; i < xs.length; i++) if (String(xs[i]) !== String(xs[i - 1])) t++;
  return t / (xs.length - 1);
}

/* ------------------------------------------------------------- text */

export const normalizeText = (s: string) =>
  s.toLowerCase().replace(/<[^>]*>/g, " ").replace(/[^\p{L}\p{N}\s]/gu, " ").replace(/\s+/g, " ").trim();

export const words = (s: string) => normalizeText(s).split(" ").filter(Boolean);

/** fnv-1a 32-bit, hex — stable, fast, good enough for signatures (not security) */
export function fnv1a(s: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, "0");
}

/** character 3-gram shingles for near-duplicate text comparison */
export function shingles(s: string, n = 3): Set<string> {
  const t = normalizeText(s);
  const out = new Set<string>();
  if (t.length < n) { if (t) out.add(t); return out; }
  for (let i = 0; i <= t.length - n; i++) out.add(t.slice(i, i + n));
  return out;
}

export function jaccard(a: Set<string>, b: Set<string>): number {
  if (!a.size && !b.size) return 1;
  let inter = 0;
  for (const x of a) if (b.has(x)) inter++;
  return inter / (a.size + b.size - inter);
}

const KEYBOARD_ROWS = ["qwertyuiop", "asdfghjkl", "zxcvbnm", "1234567890"];

/** Fraction of a word that is a run along a keyboard row ("asdf", "qwerty", "hjkl"). */
export function keyboardRunScore(word: string): number {
  const w = word.toLowerCase();
  if (w.length < 4) return 0;
  let best = 0;
  for (const row of KEYBOARD_ROWS) {
    const rev = [...row].reverse().join("");
    for (let i = 0; i <= w.length - 4; i++) {
      const piece = w.slice(i, i + 4);
      if (row.includes(piece) || rev.includes(piece)) best = Math.max(best, 4 / w.length);
    }
    for (let len = 5; len <= w.length; len++) {
      for (let i = 0; i <= w.length - len; i++) {
        const piece = w.slice(i, i + len);
        if (row.includes(piece) || rev.includes(piece)) best = Math.max(best, len / w.length);
      }
    }
  }
  return best;
}

/**
 * Gibberish estimate 0–1 for a text: vowel ratio far from natural language,
 * long consonant runs, keyboard runs, very low character diversity, many
 * "words" with no vowels. Deliberately language-agnostic and conservative.
 */
export function gibberishScore(text: string): number {
  const ws = words(text).filter((w) => /\p{L}/u.test(w));
  if (!ws.length) return 0;
  const letters = ws.join("");
  if (letters.length < 4) return 0;
  const vowels = (letters.match(/[aeiouyàáâäãåèéêëìíîïòóôöõùúûüæøœ]/gi) ?? []).length;
  const vr = vowels / letters.length;
  let score = 0;
  if (vr < 0.15 || vr > 0.75) score += 0.35;
  const longConsonant = (letters.match(/[^aeiouy\s\d]{5,}/gi) ?? []).length;
  if (longConsonant) score += Math.min(0.35, longConsonant * 0.15);
  const kb = ws.reduce((s, w) => s + keyboardRunScore(w), 0) / ws.length;
  score += Math.min(0.4, kb * 0.6);
  const noVowelWords = ws.filter((w) => w.length >= 4 && !/[aeiouy]/i.test(w)).length / ws.length;
  score += Math.min(0.3, noVowelWords * 0.5);
  const distinct = new Set(letters).size / Math.min(letters.length, 26);
  if (letters.length >= 8 && distinct < 0.25) score += 0.3; // "aaaaaaaa", "hahahaha"
  return clamp(score, 0, 1);
}

const GENERIC_PHRASES = [
  "good", "nice", "ok", "okay", "fine", "no", "nothing", "none", "n a", "na", "idk", "i don t know", "dont know",
  "no comment", "no comments", "not sure", "yes", "great", "bad", "same", "all good", "it s good", "its good",
  "nothing to say", "no idea", "asdf", "test", "blah", "good product", "very good", "like it", "i like it",
];

/** Is this the kind of answer that says nothing? */
export function isGenericAnswer(text: string): boolean {
  const t = normalizeText(text);
  if (!t) return true;
  if (GENERIC_PHRASES.includes(t)) return true;
  return words(text).length <= 2 && GENERIC_PHRASES.some((g) => t === g || t.startsWith(g + " "));
}

/**
 * "Overly polished" heuristics — a RISK signal for machine-written text, never
 * proof. Long, punctuated, connector-heavy, uniform sentence lengths, no
 * lowercase-i / typos / contractions, opens with a restatement.
 */
export function polishedTextScore(text: string): number {
  const raw = text.trim();
  const ws = words(raw);
  if (ws.length < 25) return 0;
  const sentences = raw.split(/[.!?]+\s/).map((s) => s.trim()).filter(Boolean);
  let score = 0;
  const connectors = (raw.match(/\b(furthermore|moreover|additionally|in conclusion|overall|it is important to note|in summary|notably|however|consequently|ultimately|as a result|comprehensive|exceptional|demonstrates|multifaceted|leverag\w*|robust)\b/gi) ?? []).length;
  score += Math.min(0.5, connectors * 0.15);
  if (sentences.length >= 3) {
    const lens = sentences.map((s) => s.split(/\s+/).length);
    const c = cv(lens);
    if (c !== null && c < 0.25) score += 0.2; // unnaturally even sentences
  }
  const avgLen = ws.reduce((s, w) => s + w.length, 0) / ws.length;
  if (avgLen >= 6) score += 0.15; // formal vocabulary throughout
  if (ws.filter((w) => w.length >= 9).length / ws.length > 0.2) score += 0.1;
  if (!/\b(i'm|don't|can't|it's|didn't|i've|isn't|wasn't|won't|i |my )\b/i.test(raw) && ws.length > 30) score += 0.15; // no first person, no contractions
  if (/^[A-Z]/.test(raw) && /[.!?]$/.test(raw) && !/\s{2,}|\.\./.test(raw) && ws.length > 30) score += 0.1;
  if (/^(the|this|my) (experience|product|service|survey)\b/i.test(raw)) score += 0.1;
  if (/\b(as an ai|language model)\b/i.test(raw)) score += 0.6;
  return clamp(score, 0, 1);
}

/** words repeated back-to-back or a single word making up most of the text */
export function repeatedWordScore(text: string): number {
  const ws = words(text);
  if (ws.length < 3) return 0;
  let consecutive = 0;
  for (let i = 1; i < ws.length; i++) if (ws[i] === ws[i - 1]) consecutive++;
  const counts = new Map<string, number>();
  for (const w of ws) counts.set(w, (counts.get(w) ?? 0) + 1);
  const top = Math.max(...counts.values()) / ws.length;
  return clamp(Math.max(consecutive / (ws.length - 1), top > 0.5 && ws.length >= 4 ? top : 0), 0, 1);
}

/** Levenshtein-free "same answer" test for two texts: normalized equality or high shingle overlap. */
export function textSimilarity(a: string, b: string): number {
  const na = normalizeText(a), nb = normalizeText(b);
  if (!na || !nb) return 0;
  if (na === nb) return 1;
  return jaccard(shingles(na), shingles(nb));
}

/** Simple label test: does an option label read as an "agree"-type scale point? */
export function agreementPolarity(label: string): 1 | -1 | 0 {
  const l = normalizeText(label);
  if (/\b(strongly agree|agree|very satisfied|satisfied|very likely|likely|excellent|very good|good|always|often)\b/.test(l) && !/\b(dis|not|neither|un)\w*/.test(l)) return 1;
  if (/\b(strongly disagree|disagree|very dissatisfied|dissatisfied|very unlikely|unlikely|poor|very poor|never|rarely)\b/.test(l)) return -1;
  return 0;
}

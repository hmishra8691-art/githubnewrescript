import { tokenize, type HelpIndex } from "./search.ts";

/**
 * HOW SURE ARE THE GUIDES? (2026-11-10) — the retrieval confidence that decides whether Help answers from its own
 * knowledge (no model) or needs the model at all.
 *
 * Two signals, both from the search that has already run:
 *   strength   the best article's BM25 score, saturating at STRONG — a guide that matches the question's terms in its
 *              title, headings and keywords scores far above one that mentions them in passing;
 *   coverage   how much of the question's meaning the best article contains: the idf-weighted share of the question's
 *              words found in it. A word the knowledge base has never seen ("salesforce", "blockchain") weighs the
 *              most, so a question about something ResLens.ai does not document scores low even if its other words
 *              match. Question codes (Q12) and numbers are left out — they name the user's survey, not a feature.
 *
 * `domain: "out"` is a question the knowledge base does not cover at all (almost no match, or most of its meaning
 * unknown). Help says so plainly and offers support; it does not send such a question to the model, which would have
 * nothing to ground the answer in and could only invent one.
 */
export interface Confidence {
  score: number;
  level: "high" | "medium" | "low";
  domain: "in" | "out";
  strength: number;
  coverage: number;
  /** the question's words the knowledge base has never seen */
  unknown: string[];
}

const STRONG = 80;
const CODE = /^(?:q\d+\w*|\d+)$/;

export function retrievalConfidence(index: HelpIndex, question: string, best: { article: string; score: number } | null | undefined): Confidence {
  const words = [...new Set(tokenize(question))].filter((t) => !CODE.test(t));
  const N = index.chunks.length;
  const idf = (t: string) => { const n = index.df.get(t) ?? 0; return Math.log(1 + (N - n + 0.5) / (n + 0.5)); };
  const unknown = words.filter((t) => !index.df.has(t));
  const inBest = new Set<string>();
  if (best) for (const c of index.chunks) if (c.article === best.article) for (const t of c.tf.keys()) inBest.add(t);
  const total = words.reduce((a, t) => a + idf(t), 0);
  const covered = words.filter((t) => inBest.has(t)).reduce((a, t) => a + idf(t), 0);
  const coverage = total > 0 ? covered / total : words.length ? 0 : 1;
  const strength = Math.min(1, (best?.score ?? 0) / STRONG);
  const score = Math.round((0.5 * strength + 0.5 * coverage) * 100) / 100;
  const domain = !best || best.score < 10 || coverage < 0.35 ? "out" : "in";
  const level = domain === "out" ? "low" : score >= 0.75 ? "high" : score >= 0.5 ? "medium" : "low";
  return { score, level, domain, strength: Math.round(strength * 100) / 100, coverage: Math.round(coverage * 100) / 100, unknown };
}

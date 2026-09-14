/**
 * READING `GET /api/surveys/:id/responses?format=summary`.
 *
 * A function rather than an inline expression, because the inline expression
 * was wrong for the entire life of the feature and nothing could tell.
 *
 * The editor asks this endpoint one question — has this survey collected live
 * data? — and freezes option and row codes if it has, because re-sequencing
 * rewrites references across the definition but cannot rewrite answers
 * already stored against the old codes. A respondent who chose code 4 is
 * recorded as having chosen 4; moving that option to 3 changes what they
 * said.
 *
 * The old reader was `d.total ?? d.rows?.length ?? 0`. The endpoint answers
 * `{ live: { …, total }, test: { …, total } }`. There is no top-level `total`
 * and no `rows`, so it read 0 on every survey that has ever existed, the
 * freeze was never once engaged, and codes were renumbered on live surveys
 * mid-field. Two of our own files, no type between them, no test.
 *
 * So the shape is now parsed in one named place, `blocker-fixes-test.mjs`
 * runs this function over the REAL response from the running server, and a
 * drift on either side fails rather than quietly reading zero.
 *
 * LIVE ONLY, deliberately: test data is disposable, and a programmer piloting
 * their own survey should not find its codes frozen by their own interviews.
 */
export interface ResponseSummary {
  live?: { total?: number } | null;
  test?: { total?: number } | null;
}

export function liveResponseCount(summary: unknown): number {
  const s = summary as ResponseSummary | null | undefined;
  const n = Number(s?.live?.total);
  return Number.isFinite(n) && n > 0 ? n : 0;
}

/** Whether option and row codes must be read-only for this survey. */
export function codesFrozenBy(summary: unknown): boolean {
  return liveResponseCount(summary) > 0;
}

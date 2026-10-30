/**
 * SAVE ORDERING (audit 2026-10-30 D6, migration 0078 `responses.save_seq`).
 *
 * Every save of a session carries the WHOLE state, so the newest one is the truth. Two intermediate saves in
 * flight could arrive out of order, and the older snapshot overwrote the newer — reproduced on the navigation trail
 * (section-nav-test §G). The Runner now numbers its saves 1, 2, 3, … per session (continuing from the row's
 * `save_seq` on resume and from its pending cache after a reload) and sends them one after another; the save route
 * writes an intermediate save only when its seq is greater than the stored one and otherwise answers 200
 * `{ ok: true, stale: true }` without writing.
 *
 * The final save is NOT refused for its seq: it is guarded by `status = 'in_progress'` and finalises exactly once
 * (Y11) — refusing a completion would strand a respondent. A save without a seq (a page opened before this deploy)
 * is written as before and leaves `save_seq` alone.
 */

/** the client's seq, or null when absent / not a positive safe integer (then the save is unordered, as before) */
export function parseSaveSeq(raw: unknown): number | null {
  const n = typeof raw === "number" ? raw : typeof raw === "string" && /^\d{1,15}$/.test(raw) ? Number(raw) : NaN;
  return Number.isSafeInteger(n) && n > 0 ? n : null;
}

/** an intermediate save whose seq is not newer than what the row already has must not be written */
export function isStaleSave(stored: unknown, seq: number | null, final: boolean): boolean {
  if (seq == null || final) return false;
  const have = Number(stored ?? 0);
  return Number.isFinite(have) && seq <= have;
}

/** the seq a resumed session continues from: the larger of the server row's and the browser's unacknowledged one */
export function resumeSeq(serverSeq: unknown, pendingSeq: unknown): number {
  const a = Number(serverSeq ?? 0), b = Number(pendingSeq ?? 0);
  return Math.max(Number.isSafeInteger(a) && a > 0 ? a : 0, Number.isSafeInteger(b) && b > 0 ? b : 0);
}

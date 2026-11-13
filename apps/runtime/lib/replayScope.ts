/**
 * WHICH SAVES THE SERVER REPLAYS (scalability audit 2026-11-13).
 *
 * The save route replays the whole interview with the engine (`checkSubmission`) to check a payload — every page
 * before the one posted. That makes one save cost O(pages) and one interview O(pages²): measured 3.6 ms P50 per save
 * on a 60-question survey but 143 ms P50 / 471 ms P99 on the 160-question Master Demo (10.5 s of CPU per interview),
 * plus two database reads (quota counts, balance claims) before every replay.
 *
 * Under the default posture, `log`, an intermediate save's replay changes nothing: it refuses nothing and stores
 * nothing — it writes a log line. And the FINAL save replays every page of the interview again, so it sees whatever
 * an intermediate replay would have seen. So under `log`, intermediate saves are replayed only for a sample
 * (RUNTIME_SERVER_VALIDATION_SAMPLE, default 0.05 = 1 save in 20) to keep the log representative, and every final save
 * is replayed in full.
 *
 * Whenever the replay's RESULT is used, every save is replayed exactly as before:
 *   `enforce`  — a bad payload is refused (422)
 *   RUNTIME_SERVER_RECOMPUTE=store — the server's recomputed values are stored
 *   RUNTIME_SERVER_VALIDATION_SAMPLE=1 — opt back into replaying everything
 */
export type ValidationPosture = "off" | "log" | "enforce";
export type RecomputePosture = "off" | "log" | "store";

export function sampleRate(raw: string | undefined): number {
  if (raw === undefined || raw.trim() === "") return 0.05;
  const n = Number(raw);
  return Number.isFinite(n) ? Math.min(1, Math.max(0, n)) : 0.05;
}

export function shouldReplay(o: { posture: ValidationPosture; recompute: RecomputePosture; isFinal: boolean; sample: number; random?: () => number }): boolean {
  if (o.posture === "off") return false;
  if (o.posture === "enforce" || o.recompute === "store" || o.isFinal) return true;
  if (o.sample >= 1) return true;
  if (o.sample <= 0) return false;
  return (o.random ?? Math.random)() < o.sample;
}

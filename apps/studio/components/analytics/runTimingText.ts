/* How long the latest run took, said in a line a researcher can read. Durations are what each analysis recorded when it ran. */
export interface RunTimingLike { totalMs: number; measured: number; slowest: { name: string; ms: number }[] }

export function fmtMs(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return "—";
  if (ms < 1000) return `${Math.round(ms)} ms`;
  const s = ms / 1000;
  return s < 60 ? `${s.toFixed(s < 10 ? 1 : 0)} s` : `${Math.floor(s / 60)} min ${Math.round(s % 60)} s`;
}

/** null when the run recorded no timing (a run from before timings were kept). */
export function timingLine(t: RunTimingLike | null | undefined, total: number): string | null {
  if (!t || !t.measured) return null;
  const head = `${fmtMs(t.totalMs)} of compute across ${t.measured} of ${total} analyses`;
  const top = t.slowest.slice(0, 3).filter((x) => x.ms >= 1);
  return top.length ? `${head}; slowest: ${top.map((x) => `${x.name} ${fmtMs(x.ms)}`).join(", ")}` : head;
}

/**
 * INTELLIGENT MODE SERVICE LEVELS (IM10, 2026-11-06).
 *
 * Read from `intelligent_operations` — every sentence, what read it (engine or model), what came of it — against
 * stated objectives. Each objective has a target, the measured value, the count behind it and whether it is met;
 * a breach is said in a sentence an operator can act on. Pure: the route reads the rows, this judges them.
 */
export interface OperationRow { source: string; status: string; created_at: string; intent?: { kind?: string; engine?: string } | null; api_calls?: unknown[] | null }
export interface Slo { id: string; objective: string; target: string; value: number | null; count: number; met: boolean | null; breach?: string }

const pct = (n: number, d: number) => (d ? Math.round((n / d) * 1000) / 10 : null);

export function intelligentSlo(rows: readonly OperationRow[]): { slos: Slo[]; total: number; summary: string } {
  const total = rows.length;
  const finished = rows.filter((r) => r.status !== "proposed");
  const failed = finished.filter((r) => r.status === "failed").length;
  const saveFailed = rows.filter((r) => r.status === "save_failed").length;
  const saved = rows.filter((r) => r.status === "saved" || r.status === "applied" || r.status === "save_failed").length;
  const engine = rows.filter((r) => r.source === "engine" || r.source === "grammar").length;
  const proposals = rows.filter((r) => ["applied", "saved", "save_failed", "cancelled", "reverted"].includes(r.status));
  const kept = proposals.filter((r) => r.status === "applied" || r.status === "saved").length;
  const reverted = proposals.filter((r) => r.status === "reverted").length;
  const slo = (id: string, objective: string, target: string, value: number | null, count: number, ok: (v: number) => boolean, breach: string): Slo => ({ id, objective, target, value, count, met: value === null ? null : ok(value), ...(value !== null && !ok(value) ? { breach } : {}) });
  const slos: Slo[] = [
    slo("answered", "Every sentence gets an answer, a proposal, a question or a reasoned refusal — never a failure", "≥ 98 %", pct(finished.length - failed, finished.length), finished.length, (v) => v >= 98, `${failed} of ${finished.length} sentences ended in a failure — read their status detail in the operation history.`),
    slo("saved", "An applied change is saved", "≥ 99.5 %", pct(saved - saveFailed, saved), saved, (v) => v >= 99.5, `${saveFailed} applied change${saveFailed === 1 ? " was" : "s were"} not saved — check the draft endpoint and the edit lock.`),
    slo("engine", "Sentences read without a model (no cost, no wait)", "≥ 40 %", pct(engine, total), total, (v) => v >= 40, "Most sentences go to the model — look at the ones the engine refused or handed on (Intelligent Mode audit harness)."),
    slo("kept", "Applied proposals that are kept (not undone)", "≥ 90 %", pct(kept, kept + reverted), kept + reverted, (v) => v >= 90, `${reverted} applied change${reverted === 1 ? " was" : "s were"} undone — the proposals that were reverted are the ones to read.`),
  ];
  const breaches = slos.filter((x) => x.met === false);
  return { slos, total, summary: !total ? "No Intelligent Mode activity in the period." : breaches.length ? `${breaches.length} objective${breaches.length === 1 ? "" : "s"} missed: ${breaches.map((b) => b.breach).join(" ")}` : `All ${slos.filter((x) => x.met !== null).length} measured objectives met over ${total} sentences.` };
}

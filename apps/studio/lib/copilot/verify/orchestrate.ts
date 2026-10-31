/**
 * S2c — THE TEST SESSION'S STATE MACHINE, without React or a browser, so its one guarantee can be unit-tested:
 *
 *   EVERY RUN ENDS IN A TERMINAL STATE ("done") WITHIN ITS BUDGET — whatever the harness or the repair turn does.
 *
 *   running   ≤ VERIFY_HARD_LIMIT_MS (the harness's own 20 s proposal limit plus a grace): a harness that never
 *             settles, or throws, ends as `not-run` for every item, with the reason. Apply waits only here.
 *   repairing ≤ REPAIR_WAIT_MS: the one automatic repair turn; a repair that does not come back in time (or fails, or
 *             answers in words) ends as the previous verdict, failing — "Apply anyway" is offered, also while it runs.
 *   done      ok (Apply), or failing (Apply anyway).
 *
 * The browser hook (useCopilot) supplies `run` (the harness), `repair` (the repair turn) and `current` (is this
 * signature still the open proposal's — a revision that arrived owns the card from then on).
 */
import { verificationSummary, VERDICT_NEEDS_REPAIR, type VerificationReport, type VerifyItem } from "@rescript/engine";

export const ITEM_LIMIT_MS = 5000;
export const PROPOSAL_LIMIT_MS = 20000;
/** the harness's limit plus a grace for mounting and tearing down — after this the run is given up */
export const VERIFY_HARD_LIMIT_MS = PROPOSAL_LIMIT_MS + 5000;
/** how long the one automatic repair turn may take before its absence is the answer */
export const REPAIR_WAIT_MS = 90_000;

export interface VerifyState { signature: string; status: "running" | "repairing" | "done"; report?: VerificationReport; repaired: number; ok?: boolean; summary?: string }

/** `p`, or `fallback()` once `ms` have passed — never later, never a rejection */
export function withDeadline<T>(p: Promise<T>, ms: number, fallback: (why: "timeout" | "error", e?: unknown) => T): Promise<T> {
  return new Promise<T>((resolve) => {
    let done = false;
    const t = setTimeout(() => { if (!done) { done = true; resolve(fallback("timeout")); } }, ms);
    p.then((v) => { if (!done) { done = true; clearTimeout(t); resolve(v); } }, (e) => { if (!done) { done = true; clearTimeout(t); resolve(fallback("error", e)); } });
  });
}

/** every item `not-run`, with the reason — what a harness that could not finish reports */
export function notRunReport(signature: string, items: Pick<VerifyItem, "key" | "label">[], reason: string, durationMs = 0): VerificationReport {
  return { signature, at: new Date().toISOString(), durationMs, items: [], verdicts: items.map((i) => ({ key: i.key, label: i.label, verdict: "not-run" as const, summary: `Could not be run here: ${reason}`, detail: [reason], scenarios: 0 })) };
}

export interface VerifyDeps {
  signature: string;
  items: Pick<VerifyItem, "key" | "label">[];
  run(): Promise<VerificationReport>;
  /** the repair turn; resolves when it has come back (whatever it said) */
  repair(report: VerificationReport): Promise<unknown>;
  /** may the one automatic repair be asked now (not yet asked for this proposal, a model allowed) */
  canRepair(): boolean;
  /** is this signature still the open proposal's */
  current(): boolean;
  onState(s: VerifyState): void;
  /** the number of repairs asked so far for this proposal (after this run's, when it asks one) */
  repaired(): number;
  runMs?: number;
  repairMs?: number;
  /** after a repair returns: give the revision (if any) time to take over the card */
  settleMs?: number;
}

/** run, maybe repair once, and end in `done` — the returned state is the terminal one (null: a newer signature took over) */
export async function verifyProposal(d: VerifyDeps): Promise<VerifyState | null> {
  const t0 = Date.now();
  d.onState({ signature: d.signature, status: "running", repaired: d.repaired() });
  const runMs = d.runMs ?? VERIFY_HARD_LIMIT_MS;
  const report = await withDeadline(d.run(), runMs, (why, e) => notRunReport(d.signature, d.items,
    why === "timeout" ? `the test session did not finish within ${Math.round(runMs / 1000)} s` : `the test session failed: ${e instanceof Error ? e.message : String(e)}`, Date.now() - t0));
  if (!d.current()) return null;
  const sum = verificationSummary(report);
  const failing = report.verdicts.filter(VERDICT_NEEDS_REPAIR);
  if (failing.length && d.canRepair()) {
    d.onState({ signature: d.signature, status: "repairing", report, repaired: d.repaired(), ok: false, summary: sum.text });
    await withDeadline(d.repair(report).then(() => "back" as const), d.repairMs ?? REPAIR_WAIT_MS, () => "late" as const);
    await new Promise((r) => setTimeout(r, d.settleMs ?? 250));
    if (!d.current()) return null;
  }
  const end: VerifyState = { signature: d.signature, status: "done", report, repaired: d.repaired(), ok: !failing.length, summary: sum.text };
  d.onState(end);
  return end;
}

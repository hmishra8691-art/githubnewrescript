import type { Pace } from "./fieldwork.js";

/**
 * THE FIELDWORK AGENT (audit 2026-11-17, P3-03) — watches pace, quotas, quality and the sample sources, and PROPOSES.
 *
 * It never acts. Each proposal says what it saw (with the numbers), what it suggests and why, and — when the
 * suggestion is a change the platform can make — the registry tool and input that would make it (P3-01), so the
 * person sees a dry run and approves at the tool's level before anything happens. Every proposal is accepted or
 * rejected by a person, with a reason, and the decision is logged (`decideProposal`).
 *
 * Deterministic: the same snapshot gives the same proposals with the same ids, so a proposal a person rejected is
 * not raised again until the situation changes (its id is a fingerprint of what it saw, rounded).
 *
 * What it watches, and what it proposes:
 *   stalled      nothing for `stallHours` while the field is open      → check the live link and the supplier (no tool: a person looks)
 *   behind       the projection finishes after the close date          → extend the field window (survey.set_deployment activeUntil),
 *                                                                         or plan more sample (recruitment.plan)
 *   quota        a cell projected to miss its target by the close      → plan targeted sample for it (recruitment.plan)
 *   quality      the recent flagged share well above the field's own   → review the recent responses (quality.review is the tool;
 *                                                                         the agent names the window, a person picks)
 *   source       one supplier's flagged share far above the others     → pause or cut that supplier (recruitment.order, spend)
 *   done         the target is met                                     → close fieldwork when the quotas are also full
 */

export interface QuotaCellState { quota: string; cell: string; label: string; target: number; count: number }
export interface SourceState { name: string; completes: number; flagged: number }
export interface FieldworkSnapshot {
  surveyId: string;
  now: string;
  pace: Pace;
  fieldTo?: string | null;
  cells?: QuotaCellState[];
  /** the field so far, and the last `recentHours` */
  quality?: { assessed: number; flagged: number; recentAssessed: number; recentFlagged: number; recentHours: number };
  sources?: SourceState[];
}

export type ProposalKind = "stalled" | "behind" | "quota" | "quality" | "source" | "done";
export interface FieldworkProposal {
  id: string;
  kind: ProposalKind;
  severity: "high" | "medium" | "low";
  saw: string;
  propose: string;
  why: string;
  /** the registry tool that would make the change, when there is one (dry run and approval through /tools) */
  tool?: { name: string; input: Record<string, unknown> };
}

const pct = (x: number) => `${Math.round(x * 100)}%`;
const fp = (parts: (string | number)[]) => {
  let h = 2166136261;
  for (const c of parts.join("|")) h = Math.imul(h ^ c.charCodeAt(0), 16777619) >>> 0;
  return h.toString(36);
};
const addDays = (iso: string, d: number) => new Date(Date.parse(/^\d{4}-\d{2}-\d{2}$/.test(iso) ? `${iso}T00:00:00Z` : iso) + d * 86_400_000).toISOString().slice(0, 10);

export function proposeFieldworkActions(s: FieldworkSnapshot): FieldworkProposal[] {
  const out: FieldworkProposal[] = [];
  const p = s.pace;
  const add = (x: Omit<FieldworkProposal, "id">, key: (string | number)[]) => out.push({ id: `${x.kind}:${fp([s.surveyId, x.kind, ...key])}`, ...x });

  if (p.verdict === "stalled") {
    add({ kind: "stalled", severity: "high", saw: `No completes for ${Math.round(p.quietHours ?? 0)} hours while the field is open (${p.completes}${p.target ? ` of ${p.target}` : ""} so far).`, propose: "Open the live link yourself and complete it; check the supplier's dashboard and whether a quota closed or the link was changed.", why: "A stall is something broken, not something slow: pushing harder does not help until someone looks." }, [Math.floor((p.quietHours ?? 0) / 12)]);
  }
  if (p.verdict === "behind" && p.daysLate != null && p.daysLate > 0 && p.projectedFinish) {
    const until = s.fieldTo ? addDays(s.fieldTo, Math.ceil(p.daysLate)) : p.projectedFinish;
    add({ kind: "behind", severity: p.daysLate > 3 ? "high" : "medium", saw: `${p.completes} of ${p.target}: at ${p.ratePerDay?.toFixed(1)} a day the field finishes ${p.projectedFinish}, ${Math.ceil(p.daysLate)} day${Math.ceil(p.daysLate) === 1 ? "" : "s"} after it closes (${p.requiredPerDay?.toFixed(1)} a day are needed).`, propose: `Extend the field to ${until}, or add sample to reach ${p.requiredPerDay?.toFixed(0)} a day.`, why: "The recent rate predicts the finish; at this rate the target is missed on the close date.", tool: { name: "survey.set_deployment", input: { activeUntil: until } } }, [Math.ceil(p.daysLate)]);
  }
  if (p.verdict === "done") {
    const open = (s.cells ?? []).filter((c) => c.count < c.target);
    add({ kind: "done", severity: "low", saw: `${p.completes} completes: the target of ${p.target} is met${open.length ? `, but ${open.length} quota cell${open.length === 1 ? " is" : "s are"} still short` : " and every quota cell is full"}.`, propose: open.length ? `Keep the field open for ${open.map((c) => c.label).slice(0, 3).join(", ")}${open.length > 3 ? "…" : ""}, or close it and report the shortfall.` : "Close fieldwork, so no more completes are paid for.", why: "Completes past the target cost money and add nothing the plan asked for." }, [open.length]);
  }

  /* quota cells projected to miss: needed per remaining day against the field's own rate share */
  const elapsed = p.elapsed;
  if (elapsed != null && elapsed > 0.15 && elapsed < 1) {
    for (const c of s.cells ?? []) {
      if (c.target <= 0 || c.count >= c.target) continue;
      const projected = c.count / elapsed;
      if (projected < c.target * 0.9) {
        add({ kind: "quota", severity: projected < c.target * 0.6 ? "high" : "medium", saw: `${c.label} (${c.quota}): ${c.count} of ${c.target} with ${pct(elapsed)} of the field gone — on course for about ${Math.round(projected)}.`, propose: `Plan targeted sample for ${c.label}, or agree a lower target for it with the client.`, why: "A cell that fills at this rate will be short on the close date, and late boosts are the most expensive sample.", tool: { name: "recruitment.plan", input: { action: "plan", cell: c.cell, quota: c.quota, needed: c.target - c.count } } }, [c.quota, c.cell, Math.round((projected / c.target) * 10)]);
      }
    }
  }

  /* quality: the recent flagged share against the field's own */
  const q = s.quality;
  if (q && q.assessed >= 30 && q.recentAssessed >= 15) {
    const all = q.flagged / q.assessed, recent = q.recentFlagged / q.recentAssessed;
    if (recent >= 0.15 && recent >= all * 2) {
      add({ kind: "quality", severity: recent >= 0.3 ? "high" : "medium", saw: `${pct(recent)} of the last ${q.recentHours} hours' responses are flagged (${q.recentFlagged} of ${q.recentAssessed}), against ${pct(all)} over the field.`, propose: `Review the last ${q.recentHours} hours in the quality queue, and find the source before more arrive.`, why: "A sudden rise is usually one supplier, one link shared on a forum, or a bot; the earlier it is found, the less is paid for.", tool: { name: "quality.review", input: { window: `${q.recentHours}h`, note: "the agent names the window; a person chooses which responses and the decision" } } }, [Math.round(recent * 20)]);
    }
  }

  /* sources: one supplier far worse than the rest */
  const src = (s.sources ?? []).filter((x) => x.completes >= 20);
  if (src.length >= 2) {
    const rate = (x: SourceState) => x.flagged / x.completes;
    for (const x of src) {
      const others = src.filter((o) => o !== x);
      const base = others.reduce((a, o) => a + o.flagged, 0) / Math.max(1, others.reduce((a, o) => a + o.completes, 0));
      if (rate(x) >= 0.2 && rate(x) >= base * 2.5) {
        add({ kind: "source", severity: "high", saw: `${x.name}: ${pct(rate(x))} of its ${x.completes} completes are flagged, against ${pct(base)} from the other sources.`, propose: `Pause ${x.name} and move its remaining quota to the other sources; ask it to replace the flagged completes.`, why: "Paying for completes that will be removed is the most direct loss in fieldwork.", tool: { name: "recruitment.order", input: { action: "reallocate", from: x.name } } }, [x.name, Math.round(rate(x) * 20)]);
      }
    }
  }

  const order: Record<FieldworkProposal["severity"], number> = { high: 0, medium: 1, low: 2 };
  return out.sort((a, b) => order[a.severity] - order[b.severity]);
}

/* ------------------------------------------------------------ decisions */

export interface ProposalDecision { proposalId: string; kind: ProposalKind; decision: "accept" | "reject"; reason: string; by: string; at: string; tool?: string }

/** a person's decision on a proposal: both accept and reject carry a reason (the log is how the agent's usefulness is judged) */
export function decideProposal(p: FieldworkProposal, decision: "accept" | "reject", reason: string, by: string, now = new Date().toISOString()): ProposalDecision | { error: string } {
  if (!reason.trim()) return { error: `Say why you ${decision === "accept" ? "accept" : "reject"} it — the reason is what makes the next proposal better.` };
  return { proposalId: p.id, kind: p.kind, decision, reason: reason.trim().slice(0, 500), by, at: now, ...(p.tool ? { tool: p.tool.name } : {}) };
}

/** proposals not yet decided (a rejected one is not raised again while its situation is the same — same id) */
export const openProposals = (ps: FieldworkProposal[], decided: Pick<ProposalDecision, "proposalId">[]) => {
  const done = new Set(decided.map((d) => d.proposalId));
  return ps.filter((p) => !done.has(p.id));
};

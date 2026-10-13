import type { SurveyDefinition } from "@rescript/schema";
import type { PlanTier } from "@rescript/engine";
import type { PlanItemState, PlanItemView } from "./planWorkspace.js";
import type { Finding, HypothesisVerdict } from "./findings.js";

/**
 * THE CHAIN FROM WHAT THE STUDY WANTS TO KNOW TO WHAT IT NOW SAYS (audit P-6/P-8, Phase 3).
 *
 *   objective → hypothesis → planned item → result (findings) → claim (verdict)
 *
 * Every link is read from where it lives — the research design, the item's
 * tags, the saved analysis's state, the run's findings and verdicts — and a
 * broken link is named: a hypothesis nothing is planned for, one whose items
 * cannot run, one whose result comes from an analysis that is out of date.
 * Pure: it only arranges what the workspace already has.
 */

export interface TraceFinding { id: string; headline: string; significant: boolean; strength: string }
export interface TraceItem {
  id: string; title: string; kind: "crosstab" | "test"; tier: PlanTier; state: PlanItemState;
  /** the saved analysis behind it, when there is one */
  analysisId: string | null;
  /** its result is from an analysis written before what it reads (or the plan) changed */
  outOfDate: boolean;
  findings: TraceFinding[];
}
export interface TraceHypothesis {
  label: string; text: string;
  /** the claim: the verdict the run reached, in its words */
  claim: { verdict: HypothesisVerdict["verdict"]; reason: string } | null;
  items: TraceItem[];
  /** what is missing between the hypothesis and a claim about it */
  gaps: string[];
}
export interface PlanTrace {
  objective: string | null;
  hypotheses: TraceHypothesis[];
  /** items that serve no hypothesis — profiling and exploration, listed so none is mistaken for a test */
  profiling: TraceItem[];
  gaps: string[];
}

const traceItem = (v: PlanItemView): TraceItem => ({
  id: v.id, title: v.title, kind: v.kind, tier: v.tier, state: v.state, analysisId: v.analysis?.id ?? null, outOfDate: v.state === "stale",
  findings: (v.run?.findings ?? []).map((f: Finding) => ({ id: f.id, headline: f.headline, significant: f.significant, strength: f.strength })),
});

export function planTrace(def: SurveyDefinition, items: readonly PlanItemView[], run?: { verdicts: readonly HypothesisVerdict[] } | null): PlanTrace {
  const hypotheses: TraceHypothesis[] = (def.research?.hypotheses ?? []).map((text, i) => {
    const label = `H${i + 1}`;
    const served = items.filter((it) => it.hypotheses.includes(label)).map(traceItem);
    const v = run?.verdicts.find((x) => x.label === label);
    const gaps: string[] = [];
    if (!served.length) gaps.push("nothing in the plan reads both sides of it");
    else {
      if (served.every((s) => s.state === "invalid")) gaps.push("every item that serves it is invalid, so it cannot be tested");
      else if (served.every((s) => s.state === "planned" || s.state === "invalid")) gaps.push("its items have not been applied yet");
      if (served.some((s) => s.outOfDate)) gaps.push("a result it rests on is from an out-of-date analysis — apply the plan to refresh it");
    }
    if (run && !v && served.length) gaps.push("the latest run reached no verdict on it");
    return { label, text, claim: v ? { verdict: v.verdict, reason: v.reason } : null, items: served, gaps };
  });
  const profiling = items.filter((it) => !it.hypotheses.length).map(traceItem);
  const gaps = hypotheses.flatMap((h) => h.gaps.map((g) => `${h.label}: ${g}`));
  return { objective: def.research?.objective ?? null, hypotheses, profiling, gaps };
}

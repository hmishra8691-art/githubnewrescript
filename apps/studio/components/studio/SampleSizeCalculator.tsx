"use client";
import React from "react";
import { sampleSizeProportion, sampleSizeTwoProportions, sampleSizeTwoMeans, sampleSizeCorrelation, startsNeeded, type SampleSizeResult } from "@rescript/analytics";

/**
 * SAMPLE SIZE, FROM WHAT THE STUDY MUST DETECT (roadmap 2.4, tracker 2.2). Four questions a researcher asks before
 * fieldwork — how precise a share must be, which difference between two groups must show up (shares or means), how
 * small a correlation must be detectable — answered with the standard formulas (`@rescript/analytics`), the working
 * shown, and the starts that fieldwork needs at the expected incidence and completion. "Use as planned completes"
 * writes the number into the research design, where the analysis-plan review reads it.
 */
type Goal = "share" | "two_shares" | "means" | "correlation";
const GOALS: { id: Goal; label: string; hint: string }[] = [
  { id: "share", label: "Estimate a share", hint: "e.g. awareness ± 5 points" },
  { id: "two_shares", label: "Compare two shares", hint: "e.g. concept A 40 % vs B 50 %" },
  { id: "means", label: "Compare two means", hint: "a standardised difference (d)" },
  { id: "correlation", label: "Detect a correlation", hint: "e.g. price sensitivity × intent" },
];

export function SampleSizeCalculator({ onUse }: { onUse(n: number): void }) {
  const [goal, setGoal] = React.useState<Goal>("share");
  const [v, setV] = React.useState({ margin: 5, p: 50, conf: 95, pop: "", p1: 40, p2: 50, d: 0.3, r: 0.2, alpha: 5, power: 80, deff: 1, incidence: 100, completion: 85 });
  const num = (k: keyof typeof v) => (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>) => setV((x) => ({ ...x, [k]: k === "pop" ? e.target.value : Number(e.target.value) }));
  let res: SampleSizeResult | null = null, err: string | null = null;
  try {
    const common = { alpha: v.alpha / 100, power: v.power / 100, designEffect: v.deff || 1 };
    res = goal === "share" ? sampleSizeProportion({ margin: v.margin / 100, p: v.p / 100, confidence: v.conf / 100, population: Number(v.pop) || undefined, designEffect: v.deff || 1 })
      : goal === "two_shares" ? sampleSizeTwoProportions({ p1: v.p1 / 100, p2: v.p2 / 100, ...common })
      : goal === "means" ? sampleSizeTwoMeans({ d: v.d, ...common })
      : sampleSizeCorrelation({ r: v.r, ...common });
  } catch (e) { err = (e as Error).message; }
  const starts = res ? startsNeeded(res.n, (v.incidence || 100) / 100, (v.completion || 100) / 100) : null;
  const field = (label: string, k: keyof typeof v, unit: string, step = 1, title?: string) => (
    <label className="f" style={{ width: 130 }} title={title}><span>{label}</span>
      <span className="row" style={{ gap: 4, alignItems: "center" }}><input className="input" style={{ width: 84 }} type="number" step={step} value={String(v[k])} onChange={num(k)} data-testid={`ss-${k}`} />{unit && <span className="muted" style={{ fontSize: 12 }}>{unit}</span>}</span></label>
  );
  return (
    <details className="qs-details" data-testid="sample-size-calculator">
      <summary>Work out the sample size</summary>
      <div className="row" style={{ gap: 6, flexWrap: "wrap", margin: "8px 0" }} role="radiogroup" aria-label="What must the study detect?">
        {GOALS.map((g) => <button key={g.id} type="button" role="radio" aria-checked={goal === g.id} className={`btn small${goal === g.id ? " primary" : ""}`} title={g.hint} onClick={() => setGoal(g.id)} data-testid={`ss-goal-${g.id}`}>{g.label}</button>)}
      </div>
      <div className="row" style={{ flexWrap: "wrap", gap: 10 }}>
        {goal === "share" && <>{field("Margin of error", "margin", "± pts", 0.5)}{field("Expected share", "p", "%", 1, "50 % is the safest guess")}{field("Confidence", "conf", "%")}<label className="f" style={{ width: 140 }}><span>Population (optional)</span><input className="input" type="number" value={v.pop} onChange={num("pop")} placeholder="large" /></label></>}
        {goal === "two_shares" && <>{field("Group A share", "p1", "%")}{field("Group B share", "p2", "%")}</>}
        {goal === "means" && field("Difference (d)", "d", "SD", 0.05, "0.2 small, 0.5 medium, 0.8 large (Cohen)")}
        {goal === "correlation" && field("Correlation (r)", "r", "", 0.05, "0.1 small, 0.3 medium, 0.5 large")}
        {goal !== "share" && <>{field("Significance", "alpha", "%", 1, "two-sided α")}{field("Power", "power", "%")}</>}
        {field("Design effect", "deff", "×", 0.1, "1 = simple random sample; weighting or clustering raise it (1.2–2 is common)")}
        {field("Incidence", "incidence", "%", 1, "share of people who qualify")}
        {field("Completion", "completion", "%", 1, "share of qualifiers who finish")}
      </div>
      {err && <p className="chip warn" role="alert">{err}</p>}
      {res && (
        <div className="callout" style={{ marginTop: 8 }} data-testid="ss-result">
          <b style={{ fontSize: 16 }}>{res.n.toLocaleString()} completes</b>{res.perGroup ? <span className="muted"> ({res.perGroup.toLocaleString()} per group)</span> : null}
          {starts && starts !== res.n && <span className="muted"> · about {starts.toLocaleString()} starts at {v.incidence} % incidence and {v.completion} % completion</span>}
          <div className="muted mono" style={{ fontSize: 11.5, marginTop: 4 }}>{res.working}</div>
          <button type="button" className="btn small" style={{ marginTop: 6 }} onClick={() => onUse(res!.n)} data-testid="ss-use">Use as planned completes</button>
        </div>
      )}
    </details>
  );
}

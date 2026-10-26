"use client";
import React from "react";
import type { DatasetSpec } from "@rescript/analytics";
import { dedupeFindings } from "@rescript/analytics";
import { AxApi, type PlanPayload, type Row } from "./api";
import type { WsTab } from "./navigation";
import { RunBaseCaption } from "./BaseCaption";
import { DEFAULT_NUMBER_LOCALE } from "@/lib/number";

/**
 * FINDINGS — what matters, and is it reliable? (Phase 5)
 *
 * The latest plan run's findings, strongest first, with the hypotheses they
 * bear on and the verdict each reached. Nothing is computed here: it is the
 * plan payload's `run` (the same one the Plan place and the findings report
 * read), so a number on this page is the number on the analysis it came from,
 * one click away. Open-text themes sit in the second view beside it.
 */
type Run = NonNullable<PlanPayload["run"]>;
type Finding = Run["findings"][number];
const STRENGTH: Record<string, { label: string; rank: number }> = { strong: { label: "Strong", rank: 0 }, moderate: { label: "Moderate", rank: 1 }, weak: { label: "Weak", rank: 2 }, none: { label: "No evidence", rank: 3 } };
const VERDICT: Record<string, string> = { supported: "Supported", not_supported: "Not supported", mixed: "Mixed", inconclusive: "Inconclusive", untested: "Not tested yet" };

export function FindingsView({ api, dataset, analyses, onOpenAnalysis, onTab }: { api: AxApi; dataset: DatasetSpec; analyses: Row[]; onOpenAnalysis: (a: Row) => void; onTab: (t: WsTab) => void }) {
  const [run, setRun] = React.useState<Run | null | undefined>(undefined);
  const [error, setError] = React.useState<string | null>(null);
  const [all, setAll] = React.useState(false);
  React.useEffect(() => {
    let live = true; setRun(undefined); setError(null);
    api.plan({ environment: dataset.environment, dataset: dataset.dataset }).then((d) => { if (live) setRun(d.run ?? null); }).catch((e) => { if (live) { setError((e as Error).message); setRun(null); } });
    return () => { live = false; };
  }, [api, dataset.environment, dataset.dataset]);

  if (run === undefined) return <div className="muted" data-testid="ax-findings-loading">Loading findings…</div>;
  const findings: Finding[] = run ? [...dedupeFindings(run.findings as never) as unknown as Finding[]].sort((a, b) => (STRENGTH[a.strength]?.rank ?? 9) - (STRENGTH[b.strength]?.rank ?? 9)) : [];
  const shown = all ? findings : findings.slice(0, 12);
  return (
    <div className="ax-panel" data-testid="ax-findings">
      <div className="row" style={{ gap: 8, alignItems: "baseline", flexWrap: "wrap" }}>
        <h3 style={{ margin: 0 }}>Findings</h3>
        {run && <span className="muted" style={{ fontSize: 13 }} data-testid="ax-findings-basis">from the plan run of {new Date(run.computedAt).toLocaleDateString()} · <RunBaseCaption run={run} scope={run.scope ?? null} style={{ fontSize: 13 }} /> · {run.items} analyses</span>}
        <span className="grow" />
        <button className="btn small" onClick={() => onTab("themes")} data-testid="ax-findings-themes">Open-text themes</button>
      </div>
      {error && <div className="ax-error" style={{ marginTop: 8 }}>{error}</div>}
      {!run && !error && (
        <div className="ax-empty" data-testid="ax-findings-empty"><div className="ax-empty-t">No findings yet</div><div className="ax-empty-d">Findings come from running the analysis plan on responses. Open the plan to apply it, or run it when there are completes.</div><button className="btn small primary" onClick={() => onTab("plan")}>Open the plan</button></div>
      )}
      {run && run.verdicts.length > 0 && (
        <section style={{ marginTop: 12 }} aria-label="Hypotheses" data-testid="ax-findings-verdicts">
          <h4 style={{ margin: "0 0 6px" }}>What the plan set out to learn</h4>
          <ul style={{ listStyle: "none", margin: 0, padding: 0 }}>
            {run.verdicts.map((v) => { const shownVerdict = v.corrected?.verdict ?? v.verdict; return (
              <li key={v.label} className="card" style={{ padding: "6px 10px", marginBottom: 6 }} data-testid="ax-verdict" data-verdict={shownVerdict}>
                <b>{v.label}</b> {v.text} — <span data-testid="ax-verdict-word">{VERDICT[shownVerdict] ?? shownVerdict}</span>
                <div className="muted" style={{ fontSize: 12.5 }}>{v.corrected ? v.corrected.note : v.reason}</div>
              </li>); })}
          </ul>
        </section>
      )}
      {run && (
        <section style={{ marginTop: 12 }} aria-label="Findings, strongest first">
          <h4 style={{ margin: "0 0 6px" }}>{findings.length ? `Strongest first (${findings.length})` : "The run found nothing to report"}</h4>
          <ol style={{ listStyle: "none", margin: 0, padding: 0 }}>
            {shown.map((f) => {
              const a = f.analysis.id ? analyses.find((x) => x.id === f.analysis.id) : analyses.find((x) => x.name === f.analysis.name);
              return (
                <li key={f.id} className="card" style={{ padding: "8px 10px", marginBottom: 6 }} data-testid="ax-finding" data-strength={f.strength}>
                  <div className="row" style={{ gap: 8, alignItems: "baseline" }}>
                    <span className="badge neutral" style={{ whiteSpace: "nowrap" }}>{STRENGTH[f.strength]?.label ?? f.strength}</span>
                    <b style={{ flex: 1 }}>{f.headline}</b>
                    {a && <button className="btn small" onClick={() => onOpenAnalysis(a)} data-testid="ax-finding-open">Open analysis</button>}
                  </div>
                  {f.detail && <div className="muted" style={{ fontSize: 12.5, marginTop: 2 }}>{f.detail}</div>}
                  <div className="muted" style={{ fontSize: 12, marginTop: 2 }}>From “{f.analysis.name}” · base {f.evidence.n.toLocaleString(DEFAULT_NUMBER_LOCALE)}{f.hypotheses.length ? ` · bears on ${f.hypotheses.join(", ")}` : ""}</div>
                </li>);
            })}
          </ol>
          {findings.length > 12 && <button className="btn small" onClick={() => setAll((x) => !x)} data-testid="ax-findings-more">{all ? "Show the strongest 12" : `Show all ${findings.length}`}</button>}
        </section>
      )}
    </div>
  );
}

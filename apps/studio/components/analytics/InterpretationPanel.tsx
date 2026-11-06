"use client";
import React from "react";
import type { AnalysisDefinition } from "@rescript/analytics";
import type { AxApi, InterpretPayload } from "./api";

/**
 * THE TWO LAYERS, on screen (M5). The plain reading first — what was analysed, why, what it means, the patterns,
 * the objective, what next — then the statistics behind it, folded or open. "Ask the model" adds implications and
 * recommendations through the claim gate, shown apart and marked as the model's with how many sentences survived.
 * Nothing here is computed in the browser; the engine's reading comes from `POST analytics/interpret`.
 */
export function InterpretationPanel(p: { api: AxApi; analysisId?: string | null; definition?: AnalysisDefinition | null; /** re-read when this changes (a saved configuration, a new dataset) */ nonce?: string | number; compact?: boolean; statsOpen?: boolean }) {
  const [data, setData] = React.useState<InterpretPayload | null>(null);
  const [error, setError] = React.useState<string | null>(null);
  const [stats, setStats] = React.useState(!!p.statsOpen);
  const [asking, setAsking] = React.useState(false);
  const key = p.analysisId ?? (p.definition ? JSON.stringify(p.definition) : null);
  React.useEffect(() => {
    if (!key) { setData(null); return; }
    let live = true;
    setData(null); setError(null);
    p.api.interpret(p.analysisId ? { analysisId: p.analysisId } : { definition: p.definition! }).then((d) => { if (live) setData(d); }).catch((e) => { if (live) setError((e as Error).message); });
    return () => { live = false; };
  }, [key, p.nonce]); // eslint-disable-line react-hooks/exhaustive-deps
  const ask = async () => {
    setAsking(true);
    try { setData(await p.api.interpret(p.analysisId ? { analysisId: p.analysisId, model: true } : { definition: p.definition!, model: true })); } catch (e) { setError((e as Error).message); } finally { setAsking(false); }
  };
  if (!key) return null;
  if (error) return <div className="ax-error" data-testid="ax-interp-error">{error}</div>;
  if (!data) return <div className="muted" style={{ fontSize: 12.5, padding: "6px 0" }} data-testid="ax-interp-loading">Reading the result…</div>;
  const i = data.interpretation;
  const badge = i.verdict === "significant" ? <span className="axa-verdict supported">significant</span> : i.verdict === "not_significant" ? <span className="axa-verdict inconclusive">not significant</span> : null;
  return (
    <div className={`ax-interp ${p.compact ? "compact" : ""}`} data-testid="ax-interp" data-verdict={i.verdict}>
      <div className="ax-interp-head"><b>In plain language</b>{badge}<span className="grow" /><button className="btn small ghost" onClick={() => setStats((s) => !s)} data-testid="ax-interp-stats-toggle">{stats ? "Hide statistics" : "Statistics"}</button></div>
      {stats && (
        <div className="ax-interp-stats mono" data-testid="ax-interp-stats">
          {i.statistical.map((s, k) => <div key={k}>{s}</div>)}
        </div>
      )}
      <dl className="ax-interp-dl">
        <dt>What</dt><dd>{i.plain.what}</dd>
        <dt>Why</dt><dd>{i.plain.why}</dd>
        <dt>Meaning</dt><dd>{i.plain.meaning}</dd>
        {!p.compact && i.plain.patterns.length > 0 && <><dt>Patterns</dt><dd>{i.plain.patterns.map((s, k) => <div key={k}>{s}</div>)}</dd></>}
        {!p.compact && i.plain.objective && <><dt>Objective</dt><dd>{i.plain.objective}</dd></>}
        {!p.compact && <><dt>Next</dt><dd>{i.plain.next.map((s, k) => <div key={k}>{s}</div>)}</dd></>}
      </dl>
      {i.caveats.length > 0 && !p.compact && <div className="axa-warning">{i.caveats.join(" ")}</div>}
      <div className="ax-interp-model">
        {!data.model && <button className="btn small" disabled={asking} onClick={() => void ask()} data-testid="ax-interp-ask" title="The model reads the result's claims and offers implications; every sentence is checked against the numbers">{asking ? "Asking…" : "Ask the model for implications"}</button>}
        {data.model && (data.model.implications.length || data.model.recommendations.length) ? (
          <div data-testid="ax-interp-model">
            <div className="eyebrow">The model's reading <span className="muted" style={{ textTransform: "none", letterSpacing: 0 }}>· checked against the numbers{data.model.rejected ? `, ${data.model.rejected} sentence${data.model.rejected === 1 ? "" : "s"} dropped` : ""}</span></div>
            {data.model.implications.map((s, k) => <p key={`i${k}`}>{s}</p>)}
            {data.model.recommendations.length > 0 && <><div className="eyebrow">Suggested next steps</div>{data.model.recommendations.map((s, k) => <p key={`r${k}`}>{s}</p>)}</>}
          </div>
        ) : data.model ? <div className="muted" style={{ fontSize: 12.5 }} data-testid="ax-interp-model-none">{data.model.detail}</div> : null}
      </div>
    </div>
  );
}

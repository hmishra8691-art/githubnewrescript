"use client";
import React from "react";

/**
 * AI COST AND CACHE — MEASURED FROM BILLING (/platform, platform administrators, 2026-10-18).
 *
 * What prompt caching actually saved, from the usage events the meter wrote —
 * not an estimate: per day × operation × model, the token split, the hit rate,
 * the provider cost against the same calls priced with no caching, and what is
 * wrong (prefix churn, prefixes under the provider's minimum, operations never
 * cached). Reads `/api/admin/ai-cache`.
 */
interface Totals { calls: number; splitCalls: number; legacyCalls: number; inputTokens: number; uncachedTokens: number; cacheReadTokens: number; cacheWriteTokens: number; outputTokens: number; readCalls: number; writeCalls: number; hitRate: number; tokenHitRate: number; actualCostUsd: number; noCacheCostUsd: number; savingUsd: number; savingPct: number; chargeUsd: number; chargeNoCacheUsd: number | null }
interface Report {
  sample: { from: string | null; to: string | null; events: number; splitEvents: number; firstSplitAt: string | null };
  totals: Totals;
  groups: (Totals & { day: string; operation: string; model: string })[];
  warnings: { kind: string; message: string }[];
  window: { since: string; until: string };
  truncated: boolean;
}

const k = (n: number) => Math.round(n).toLocaleString("en");
const usd = (n: number) => `$${n.toFixed(4)}`;
const pct = (n: number) => `${Math.round(n * 100)} %`;

export function AiCachePanel() {
  const [days, setDays] = React.useState(30);
  const [excludeEval, setExcludeEval] = React.useState(true);
  const [report, setReport] = React.useState<Report | null>(null);
  const [error, setError] = React.useState<string | null>(null);
  const [loading, setLoading] = React.useState(false);

  const load = React.useCallback(async () => {
    setLoading(true); setError(null);
    try {
      const r = await fetch(`/api/admin/ai-cache?days=${days}${excludeEval ? "&excludeEval=1" : ""}`, { cache: "no-store" });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) { setError(j.error ?? `Not available (${r.status}).`); setReport(null); return; }
      setReport(j.report as Report);
    } catch (e) { setError((e as Error).message); } finally { setLoading(false); }
  }, [days, excludeEval]);
  React.useEffect(() => { void load(); }, [load]);

  const t = report?.totals;
  return (
    <>
      <h3 className="sec">AI cost and cache — measured from billing</h3>
      <div className="card" data-testid="platform-ai-cache">
        <div className="row" style={{ gap: 8, flexWrap: "wrap", alignItems: "center" }}>
          <label className="muted" style={{ fontSize: 13 }}>Window&nbsp;
            <select value={days} onChange={(e) => setDays(Number(e.target.value))} data-testid="ai-cache-days">
              {[1, 7, 30, 90].map((d) => <option key={d} value={d}>{d === 1 ? "last day" : `last ${d} days`}</option>)}
            </select>
          </label>
          <label className="muted" style={{ fontSize: 13 }}>
            <input type="checkbox" checked={excludeEval} onChange={(e) => setExcludeEval(e.target.checked)} /> leave out evaluation runs
          </label>
          <span className="grow" />
          <button className="btn small" disabled={loading} onClick={() => void load()}>{loading ? "Reading…" : "Refresh"}</button>
        </div>
        {error && <div className="chip warn" style={{ marginTop: 8 }} data-testid="ai-cache-error">{error}</div>}
        {report && t && (
          <>
            <p className="muted" style={{ fontSize: 12.5 }} data-testid="ai-cache-sample">
              {k(report.sample.events)} chat calls in the window, {k(report.sample.splitEvents)} with the token split
              {report.sample.firstSplitAt ? ` (recorded since ${report.sample.firstSplitAt.slice(0, 10)})` : ""}.
              {report.truncated ? " The window has more rows than were read — narrow it." : ""}
              {" "}Actual cost is what the meter recorded; “no cache” is the same calls with all input at the input rate.
            </p>
            <table className="grid" data-testid="ai-cache-totals">
              <tbody>
                <tr><td>Input tokens</td><td>{k(t.inputTokens)} — uncached {k(t.uncachedTokens)}, read from cache {k(t.cacheReadTokens)}, written {k(t.cacheWriteTokens)}</td></tr>
                <tr><td>Output tokens</td><td>{k(t.outputTokens)}</td></tr>
                <tr><td>Hit rate</td><td>{pct(t.hitRate)} of calls · {pct(t.tokenHitRate)} of input tokens</td></tr>
                <tr><td>Provider cost</td><td><strong>{usd(t.actualCostUsd)}</strong> actual vs {usd(t.noCacheCostUsd)} with no caching — saved <strong data-testid="ai-cache-saving">{usd(t.savingUsd)} ({t.savingPct.toFixed(1)} %)</strong></td></tr>
                {t.chargeNoCacheUsd != null && <tr><td>Customer charges</td><td>{usd(t.chargeUsd)} vs {usd(t.chargeNoCacheUsd)} uncached</td></tr>}
              </tbody>
            </table>
            {report.groups.length > 0 && (
              <div style={{ overflowX: "auto", marginTop: 10 }}>
                <table className="grid" data-testid="ai-cache-groups" style={{ fontSize: 12.5 }}>
                  <thead><tr><th>Day</th><th>Operation</th><th>Model</th><th>Calls</th><th>Input</th><th>Cache read</th><th>Cache write</th><th>Output</th><th>Hit</th><th>Actual</th><th>No cache</th><th>Saving</th></tr></thead>
                  <tbody>
                    {report.groups.map((g) => (
                      <tr key={`${g.day}|${g.operation}|${g.model}`}>
                        <td className="mono">{g.day}</td><td className="mono">{g.operation}</td><td className="mono">{g.model}</td>
                        <td>{g.calls}{g.legacyCalls ? <span className="muted"> ({g.legacyCalls} no split)</span> : null}</td>
                        <td>{k(g.inputTokens)}</td><td>{k(g.cacheReadTokens)}</td><td>{k(g.cacheWriteTokens)}</td><td>{k(g.outputTokens)}</td>
                        <td>{g.splitCalls ? pct(g.hitRate) : "—"}</td><td>{usd(g.actualCostUsd)}</td><td>{usd(g.noCacheCostUsd)}</td><td>{usd(g.savingUsd)} ({g.savingPct.toFixed(1)} %)</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
            {report.warnings.length > 0 && (
              <ul className="muted" style={{ fontSize: 12.5, marginTop: 10, paddingLeft: 18, lineHeight: 1.6 }} data-testid="ai-cache-warnings">
                {report.warnings.map((w, i) => <li key={i}><span className="chip warn">{w.kind.replace(/_/g, " ")}</span> {w.message}</li>)}
              </ul>
            )}
          </>
        )}
      </div>
    </>
  );
}

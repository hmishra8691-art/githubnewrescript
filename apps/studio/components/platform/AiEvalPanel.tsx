"use client";
import React from "react";

/**
 * INTELLIGENT MODE EVALUATION (/platform, platform administrators, 2026-10-18).
 *
 * Runs the small /platform subset of the evaluation harness (≤10 cases) against
 * this installation's own provider, without a terminal: the estimate is shown
 * first, a hard cap is set, the cases run one request each (the cap is checked
 * before every case on the server), and the report is shown. Sandbox only —
 * no customer project is touched; the cost is metered to the platform.
 * Reads / writes `/api/admin/ai-eval`.
 */
interface CaseRow { id: string; title: string; category: string; turns: number; estimateUsd: number }
interface Info { provider: { configured: boolean; fake: boolean; model: string; host: string | null }; pricedModel: string; cases: CaseRow[]; estimateUsd: number; capCeilingUsd: number; durable: boolean; recent: { id: string; status: string; model: string; cases: number; capUsd: number; spentUsd: number; createdAt: string; passRate: number | null }[] }
interface CaseResult { id: string; passed: boolean; costUsd: number; latencyMs: number; inputTokens: number; cacheReadTokens: number; turns: { checks: { name: string; ok: boolean; detail?: string }[]; reply: string }[]; budgetChecks: { name: string; ok: boolean; detail?: string }[] }
interface Summary { passRate: number; passed: number; cases: number; costUsd: number; latencyMs: { p50: number; p95: number }; repairRate: number; clarifyRate: number; tokens: { input: number; output: number; cacheRead: number; cacheWrite: number } }

const usd = (n: number) => `$${n.toFixed(4)}`;

export function AiEvalPanel() {
  const [info, setInfo] = React.useState<Info | null>(null);
  const [error, setError] = React.useState<string | null>(null);
  const [chosen, setChosen] = React.useState<Set<string>>(new Set());
  const [cap, setCap] = React.useState("");
  const [running, setRunning] = React.useState(false);
  const [progress, setProgress] = React.useState<{ done: number; total: number; spent: number; note?: string } | null>(null);
  const [results, setResults] = React.useState<CaseResult[]>([]);
  const [report, setReport] = React.useState<{ summary: Summary; markdown: string } | null>(null);

  const load = React.useCallback(async () => {
    const r = await fetch("/api/admin/ai-eval", { cache: "no-store" });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) { setError(j.error ?? `Not available (${r.status}).`); return; }
    setInfo(j as Info);
    setChosen((prev) => (prev.size ? prev : new Set((j as Info).cases.map((c) => c.id))));
    setCap((prev) => prev || Math.min((j as Info).capCeilingUsd, Math.max(0.25, Math.ceil((j as Info).estimateUsd * 150) / 100)).toFixed(2));
  }, []);
  React.useEffect(() => { void load(); }, [load]);

  const estimate = info ? info.cases.filter((c) => chosen.has(c.id)).reduce((n, c) => n + c.estimateUsd, 0) : 0;
  const capNum = Number(cap);
  const capOk = Number.isFinite(capNum) && capNum > 0 && !!info && capNum <= info.capCeilingUsd && estimate <= capNum;

  const post = async (body: Record<string, unknown>) => {
    const r = await fetch("/api/admin/ai-eval", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    const j = await r.json().catch(() => ({}));
    return { ok: r.ok, status: r.status, j };
  };
  const run = async () => {
    if (!info) return;
    setRunning(true); setError(null); setResults([]); setReport(null);
    try {
      const start = await post({ action: "start", caseIds: [...chosen], capUsd: capNum });
      if (!start.ok) { setError(start.j.error ?? `Could not start (${start.status}).`); return; }
      const runId = start.j.run.id as string;
      const ids = start.j.run.caseIds as string[];
      let spent = 0;
      for (let i = 0; i < ids.length; i++) {
        setProgress({ done: i, total: ids.length, spent, note: `Running ${ids[i]}…` });
        const r = await post({ action: "case", runId, caseId: ids[i] });
        if (!r.ok) { setProgress({ done: i, total: ids.length, spent, note: r.j.error ?? `Stopped (${r.status}).` }); if (r.j.capped) break; continue; }
        spent = r.j.spentUsd; setResults((prev) => [...prev, r.j.result as CaseResult]);
        if (r.j.status === "capped") { setProgress({ done: i + 1, total: ids.length, spent, note: "Stopped at the cap." }); break; }
      }
      const fin = await post({ action: "finish", runId });
      if (fin.ok) setReport({ summary: fin.j.report.summary as Summary, markdown: fin.j.markdown as string });
      setProgress((p) => (p ? { ...p, done: p.total, note: p.note?.startsWith("Running") ? undefined : p.note } : p));
      void load();
    } catch (e) { setError((e as Error).message); } finally { setRunning(false); }
  };

  return (
    <>
      <h3 className="sec">Intelligent Mode evaluation</h3>
      <div className="card" data-testid="platform-ai-eval">
        <p className="muted" style={{ fontSize: 12.5, marginTop: 0 }}>
          Golden scenarios through the production turn pipeline, against this installation&apos;s provider. Sandbox project only — no
          customer project is read or written; the cost is metered to the platform. The full set (and recorded replays) runs from
          <span className="mono"> pnpm eval:ai</span> and the “AI eval” workflow.
        </p>
        {error && <div className="chip warn" data-testid="ai-eval-error">{error}</div>}
        {info && (
          <>
            <div className="muted" style={{ fontSize: 13, marginBottom: 8 }} data-testid="ai-eval-provider">
              Provider: {info.provider.fake ? <span className="chip warn">fake — scripted replies, the model is not evaluated</span> : <span className="mono">{info.provider.host} · {info.provider.model}</span>}
              {!info.durable && <span className="chip warn" style={{ marginLeft: 8 }}>runs kept in memory (apply migration 0068)</span>}
            </div>
            <table className="grid" style={{ fontSize: 12.5 }}>
              <tbody>
                {info.cases.map((c) => {
                  const r = results.find((x) => x.id === c.id);
                  return (
                    <tr key={c.id} data-testid={`ai-eval-case-${c.id}`}>
                      <td><label><input type="checkbox" disabled={running} checked={chosen.has(c.id)} onChange={(e) => setChosen((prev) => { const n = new Set(prev); if (e.target.checked) n.add(c.id); else n.delete(c.id); return n; })} /> <span className="mono">{c.id}</span></label><div className="muted">{c.title}</div></td>
                      <td className="muted">{c.category}</td>
                      <td>≤ {usd(c.estimateUsd)}</td>
                      <td>{r ? <span className={`chip ${r.passed ? "on" : "warn"}`}>{r.passed ? "pass" : "fail"} · {usd(r.costUsd)} · {Math.round(r.latencyMs / 100) / 10} s</span> : null}
                        {r && !r.passed && <div className="muted" style={{ fontSize: 12 }}>{[...r.turns.flatMap((t) => t.checks.filter((x) => !x.ok).map((x) => `${x.name}: ${x.detail ?? ""}`)), ...r.budgetChecks.filter((b) => !b.ok).map((b) => `budget ${b.name}: ${b.detail ?? ""}`)].join(" · ").slice(0, 300)}</div>}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
            <div className="row" style={{ gap: 8, marginTop: 10, flexWrap: "wrap", alignItems: "center" }}>
              <span data-testid="ai-eval-estimate">Estimate ≤ <strong>{usd(estimate)}</strong> <span className="muted">(priced as {info.pricedModel}, uncached, with headroom)</span></span>
              <label className="muted" style={{ fontSize: 13 }}>Hard cap $<input value={cap} onChange={(e) => setCap(e.target.value)} disabled={running} style={{ width: 70 }} data-testid="ai-eval-cap" /> (max ${info.capCeilingUsd.toFixed(2)})</label>
              <button className="btn small primary" disabled={running || !chosen.size || !capOk} onClick={() => void run()} data-testid="ai-eval-run">{running ? "Running…" : `Run ${chosen.size} case${chosen.size === 1 ? "" : "s"}`}</button>
              {!capOk && chosen.size > 0 && <span className="chip warn">the estimate must fit under the cap</span>}
            </div>
            {progress && <div className="muted" style={{ fontSize: 12.5, marginTop: 6 }} data-testid="ai-eval-progress">{progress.done}/{progress.total} done · spent {usd(progress.spent)}{progress.note ? ` · ${progress.note}` : ""}</div>}
            {report && (
              <div style={{ marginTop: 10 }} data-testid="ai-eval-report">
                <strong>Pass rate {(report.summary.passRate * 100).toFixed(1)} %</strong> ({report.summary.passed}/{report.summary.cases}) · cost {usd(report.summary.costUsd)} · p50 {report.summary.latencyMs.p50} ms · p95 {report.summary.latencyMs.p95} ms · repair {(report.summary.repairRate * 100).toFixed(0)} % · clarify {(report.summary.clarifyRate * 100).toFixed(0)} % · input {report.summary.tokens.input.toLocaleString("en")} tokens (cache read {report.summary.tokens.cacheRead.toLocaleString("en")})
                <details style={{ marginTop: 6 }}><summary className="muted">The report (Markdown)</summary><pre style={{ whiteSpace: "pre-wrap", fontSize: 12 }}>{report.markdown}</pre></details>
              </div>
            )}
            {info.recent.length > 0 && (
              <div className="muted" style={{ fontSize: 12.5, marginTop: 10 }} data-testid="ai-eval-recent">
                Last runs: {info.recent.map((r) => `${r.createdAt.slice(0, 16).replace("T", " ")} ${r.model} ${r.status}${r.passRate != null ? ` ${(r.passRate * 100).toFixed(0)} %` : ""} (${usd(r.spentUsd)})`).join(" · ")}
              </div>
            )}
          </>
        )}
      </div>
    </>
  );
}

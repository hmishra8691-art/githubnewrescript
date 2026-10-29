"use client";
import React from "react";
import type { AssessmentAnalytics } from "@rescript/engine";

/**
 * DATA ANALYTICS → HOME: Assessment results (K4 2026-10-25, ported 2026-10-29 step 4B; docs/ASSESSMENTS-2026-10-29.md
 * part B). Renders NOTHING unless the survey is a scored paper (the route answers `assessment: false`), so ordinary
 * surveys see no change. Over the completed, server-scored responses (`/api/surveys/[id]/assessment`): n, mean,
 * median, SD, pass rate, the score distribution (10 % bands), the topic table, the item analysis (difficulty p,
 * corrected point-biserial, flags) and "Download Word" (the answer-key sheet + marking + this analysis). Live by
 * default; Test switches environment.
 *
 * The database-less sandbox has no saved responses: its paper is taken through Survey Settings → Assessment →
 * "Take the test (sandbox)", which keeps the paper's observer key in this tab (sessionStorage), and the card reads
 * that paper's attempts from the runtime's in-memory store.
 */
export const SANDBOX_OBSERVER_KEY = "rescript.assessmentObserver";

export function AssessmentCard({ surveyId }: { surveyId: string }) {
  const [env, setEnv] = React.useState<"live" | "test">("live");
  const [data, setData] = React.useState<{ assessment: boolean; n: number; rescored: number; analytics: AssessmentAnalytics | null } | null>(null);
  const sandbox = surveyId === "sandbox";
  const observer = React.useMemo(() => { if (!sandbox) return ""; try { return window.sessionStorage.getItem(SANDBOX_OBSERVER_KEY) ?? ""; } catch { return ""; } }, [sandbox]);
  const url = (extra = "") => sandbox ? `/api/surveys/sandbox/assessment?key=${encodeURIComponent(observer)}${extra}` : `/api/surveys/${surveyId}/assessment?env=${env}${extra}`;
  React.useEffect(() => {
    if (!surveyId || (sandbox && !observer)) return;
    let off = false;
    fetch(url(), { cache: "no-store" })
      .then((r) => (r.ok ? r.json() : null))
      .then((j) => { if (!off && j) setData({ assessment: !!j.assessment, n: j.n ?? 0, rescored: j.rescored ?? 0, analytics: j.analytics ?? null }); })
      .catch(() => undefined);
    return () => { off = true; };
  }, [surveyId, env, observer]); // eslint-disable-line react-hooks/exhaustive-deps
  if (!data?.assessment) return null;
  return (
    <div className="card" data-testid="ax-assessment" style={{ padding: 14, marginBottom: 12 }}>
      <div className="row" style={{ justifyContent: "space-between", flexWrap: "wrap", gap: 8 }}>
        <h3 style={{ margin: 0 }}>Assessment results</h3>
        <div className="row" style={{ gap: 6 }}>
          {!sandbox && <select className="select" value={env} onChange={(e) => setEnv(e.target.value as "live" | "test")} data-testid="ax-assessment-env" aria-label="Environment"><option value="live">Live</option><option value="test">Test</option></select>}
          <a className="btn small" href={url("&format=docx")} download data-testid="ax-assessment-docx">Download Word</a>
        </div>
      </div>
      {sandbox && <p className="muted" style={{ fontSize: 12, margin: "4px 0 0" }}>Sandbox: the attempts of the paper last launched with “Take the test” in this tab.</p>}
      {data.rescored > 0 && <p className="muted" style={{ fontSize: 12, margin: "4px 0 0" }} data-testid="ax-assessment-rescored">{data.rescored} response{data.rescored === 1 ? "" : "s"} re-scored from the stored answers against the current key.</p>}
      <AssessmentResultsView n={data.n} analytics={data.analytics} />
    </div>
  );
}

/** Score distribution, pass rate, topic table and item analysis (p-value, point-biserial, flags). */
export function AssessmentResultsView({ n, analytics }: { n: number; analytics: AssessmentAnalytics | null }) {
  if (!analytics || !n) return <p className="muted" style={{ fontSize: 12.5 }} data-testid="assessment-noresults">No scored responses yet.</p>;
  const max = Math.max(1, ...analytics.distribution.map((b) => b.count));
  const f = (x: number | null) => (x === null ? "–" : String(x));
  return (
    <div data-testid="assessment-analytics" data-n={n} style={{ marginTop: 8 }}>
      <div className="row" style={{ gap: 14, flexWrap: "wrap", fontSize: 13 }}>
        <span><b data-testid="assessment-an-n">{n}</b> scored</span>
        <span>mean <b data-testid="assessment-an-mean">{f(analytics.mean)}</b> ({f(analytics.meanPct)}%)</span>
        <span>median <b>{f(analytics.median)}</b></span><span>SD <b>{f(analytics.sd)}</b></span>
        <span>pass rate <b data-testid="assessment-an-pass">{analytics.passRate === null ? "no pass mark" : `${analytics.passRate}%`}</b></span>
      </div>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(10, 1fr)", gap: 3, alignItems: "end", height: 80, marginTop: 8 }} data-testid="assessment-distribution" role="img" aria-label="Score distribution by percentage band">
        {analytics.distribution.map((b) => (
          <div key={b.from} title={`${b.from}–${b.to}%: ${b.count}`} data-count={b.count} style={{ background: "var(--accent, #2563eb)", opacity: b.count ? 0.85 : 0.15, height: `${Math.max(4, (b.count / max) * 100)}%`, borderRadius: 3 }} />
        ))}
      </div>
      <div className="row" style={{ justifyContent: "space-between", fontSize: 11, color: "var(--muted, #64748b)" }}><span>0%</span><span>50%</span><span>100%</span></div>
      {analytics.topics.length > 0 && (
        <table className="tbl" data-testid="assessment-topic-table" style={{ fontSize: 12, width: "100%", marginTop: 8 }}>
          <thead><tr><th>Topic</th><th>Questions</th><th title="mean share of the topic's marks scored">Mean score rate</th></tr></thead>
          <tbody>{analytics.topics.map((t) => <tr key={t.topic}><td>{t.topic}</td><td>{analytics.items.filter((i) => i.topic === t.topic).length}</td><td>{t.meanScoreRate}%</td></tr>)}</tbody>
        </table>
      )}
      <details style={{ marginTop: 8 }} open={analytics.items.length <= 20}>
        <summary style={{ cursor: "pointer", fontSize: 13 }}>Item analysis ({analytics.items.length} questions)</summary>
        <div style={{ maxHeight: 260, overflow: "auto" }}>
          <table className="tbl" data-testid="assessment-items" style={{ fontSize: 12, width: "100%" }}>
            <thead><tr><th>Q</th><th>Topic</th><th title="share answering correctly">p</th><th title="corrected point-biserial — discrimination">r(pb)</th><th>Flag</th></tr></thead>
            <tbody>{analytics.items.map((i) => <tr key={i.id} data-qid={i.id}><td>{i.code}</td><td>{i.topic}</td><td>{f(i.pValue)}</td><td>{f(i.pointBiserial)}</td><td>{i.flag ?? ""}</td></tr>)}</tbody>
          </table>
        </div>
      </details>
    </div>
  );
}

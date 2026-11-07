"use client";
import React from "react";

/**
 * WHAT A RESEARCH AGENT PRODUCED (ResLens agents, 2026-11-07). The completed steps' data, as the handlers wrote it —
 * the analytics engine's summaries, findings and verdicts, never a model's numbers. Rendered by the step that made
 * it; anything this view does not know is left out rather than guessed at.
 */

type Any = Record<string, any>;
const VERDICT: Record<string, string> = { supported: "Supported", not_supported: "Not supported", mixed: "Mixed", inconclusive: "Inconclusive", untested: "Untested" };
const pFmt = (p: number | null | undefined) => (p == null ? "" : p < 0.001 ? "p < .001" : `p = ${p.toFixed(3).replace(/^0/, "")}`);

export function ResearchOutput({ data, surveyId, children }: { data: Record<string, unknown>; surveyId: string; children?: React.ReactNode }) {
  const d = data as Record<string, Any>;
  const analyticsHref = `/analytics?survey=${encodeURIComponent(surveyId)}`;
  return (
    <div className="agw-out" data-testid="agw-output">
      {d.check && (
        <section>
          <h4>Plan checked</h4>
          <p>{d.check.planned} analyses will run{d.check.planWritten ? " from the written analysis plan" : " from the framework derived from the questionnaire"}{d.check.hypotheses ? ` · ${d.check.hypotheses} hypotheses` : ""}.</p>
        </section>
      )}
      {d.apply && (
        <section>
          <h4>Plan applied</h4>
          <p>{d.apply.message || `${d.apply.counts?.run ?? 0} analyses run`} · base n = {d.apply.n}{d.apply.report !== "none" ? ` · findings report ${d.apply.report.replace("_", " ")}` : ""}{d.apply.dashboard !== "none" ? ` · dashboard ${d.apply.dashboard}` : ""}.</p>
          {d.apply.failed?.length > 0 && <details><summary>{d.apply.failed.length} could not be computed</summary><ul>{d.apply.failed.map((f: Any, i: number) => <li key={i}><b>{f.title}</b> — {f.reason}</li>)}</ul></details>}
          <a className="btn tiny" href={analyticsHref}>Open in Data Analytics</a>
        </section>
      )}
      {d.verify && (
        <section data-testid="agw-out-verify">
          <h4>Verified on n = {d.verify.n}</h4>
          <p>{d.verify.holding} of {d.verify.findings} findings hold after correction for multiple comparisons.</p>
          {d.verify.top?.length > 0 && <ol className="agw-out-findings">{d.verify.top.map((f: Any) => <li key={f.id}>{f.headline} <span className="muted">({f.strength}{f.p != null ? `, ${pFmt(f.p)}` : ""}, n = {f.n} · {f.analysis})</span></li>)}</ol>}
          {d.verify.verdicts?.length > 0 && (
            <table className="agw-out-table"><thead><tr><th>Hypothesis</th><th>Verdict</th><th>Why</th></tr></thead>
              <tbody>{d.verify.verdicts.map((v: Any) => <tr key={v.label} className={`v-${v.verdict}`}><td><b>{v.label}</b> {v.text}</td><td>{VERDICT[v.verdict] ?? v.verdict}</td><td>{v.reason}</td></tr>)}</tbody></table>
          )}
        </section>
      )}
      {children}
    </div>
  );
}

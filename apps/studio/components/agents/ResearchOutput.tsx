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
      {d.check?.planned != null && (
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
      {d.storyline && <Storyline story={d.storyline} surveyId={surveyId} check={d.check?.keyFindings != null ? d.check : null} />}
      {d.brief && <DecisionBrief brief={d.brief} />}
      {children}
    </div>
  );
}

const SLIDE_WORD: Record<string, string> = { title: "Title", summary: "Summary", section: "Section", key_finding: "Key finding", segment_comparison: "Segments", statistical_highlight: "Highlight", implications: "Implications", recommendations: "Recommendations", method: "Method", caveats: "Caveats", wave_change: "Since last wave", quotes: "In their own words" };

/** the report agent's storyline, and the two files made from the same run by the existing output route */
function Storyline({ story, surveyId, check }: { story: Any; surveyId: string; check: Any | null }) {
  const [busy, setBusy] = React.useState<string | null>(null);
  const [msg, setMsg] = React.useState<string | null>(null);
  const download = async (type: "findings_pptx" | "findings_docx") => {
    setBusy(type); setMsg(null);
    try {
      const r = await fetch("/api/copilot/output", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ surveyId, output: { type, audience: story.audience } }) });
      if (!r.ok) { const j = await r.json().catch(() => ({})); setMsg(String((j as Any).error ?? `The file could not be made (${r.status}).`)); return; }
      const blob = await r.blob();
      const name = /filename="([^"]+)"/.exec(r.headers.get("content-disposition") ?? "")?.[1] ?? (type === "findings_pptx" ? "findings.pptx" : "findings.docx");
      const a = document.createElement("a"); a.href = URL.createObjectURL(blob); a.download = name; a.click(); setTimeout(() => URL.revokeObjectURL(a.href), 2000);
      setMsg(r.headers.get("x-rescript-output") ?? "Downloaded.");
    } catch { setMsg("The file could not be made — check your connection."); } finally { setBusy(null); }
  };
  return (
    <section data-testid="agw-out-storyline">
      <h4>{story.title} <span className="muted">· {story.audience} audience · n = {story.n}{story.led ? ` · leads with “${story.led}”` : ""}</span></h4>
      <ol className="agw-out-slides">{(story.slides as Any[]).map((sl, i) => (
        <li key={i} className={`sl-${sl.type}${sl.significant === false ? " ns" : ""}`}><span className="agw-out-badge">{SLIDE_WORD[sl.type] ?? sl.type}</span> <b>{sl.title}</b>
          {sl.points?.length > 0 && <ul>{sl.points.slice(0, 5).map((pt: string, j: number) => <li key={j}>{pt}</li>)}</ul>}
          {sl.significant === false && <div className="agw-warn">Not significant — presented as no difference.</div>}
        </li>))}</ol>
      {check && <p className="muted">{check.slides} slides · {check.keyFindings} key findings · sections: {(check.sections as string[]).map((x) => SLIDE_WORD[x] ?? x).join(", ")}</p>}
      <div className="row" style={{ gap: 6, flexWrap: "wrap" }}>
        <button className="btn tiny" disabled={busy != null} onClick={() => void download("findings_pptx")} data-testid="agw-dl-pptx">{busy === "findings_pptx" ? "Making…" : "Download deck (.pptx)"}</button>
        <button className="btn tiny" disabled={busy != null} onClick={() => void download("findings_docx")} data-testid="agw-dl-docx">{busy === "findings_docx" ? "Making…" : "Word report (.docx)"}</button>
        <span className="muted" style={{ fontSize: 12 }}>Made from the same run. When a model is configured it words the story once and the narrative gate checks every sentence; the numbers stay the engine's.</span>
      </div>
      {msg && <div className="muted" role="status">{msg}</div>}
    </section>
  );
}

const ACTIONS: [string, string][] = [["act", "Act on it"], ["avoid", "Do not build on it"], ["resolve", "Resolve before acting"], ["test", "Test further"], ["plan", "Plan the analysis"]];

/** the decision agent's brief — every row editable by the researcher; the export carries the edits and the evidence */
function DecisionBrief({ brief }: { brief: Any }) {
  const [rows, setRows] = React.useState<Any[]>(() => (brief.items as Any[]).map((i) => ({ ...i, decided: i.action, owner: "", note: "" })));
  const set = (k: number, patch: Any) => setRows((r) => r.map((x, i) => (i === k ? { ...x, ...patch } : x)));
  const md = () => [
    `# Decision brief${brief.question ? `: ${brief.question}` : ""}`, "", `Based on the analysis run of ${String(brief.computedAt).slice(0, 10)} (n = ${brief.n}). Only findings that hold after correction count as evidence.`, "",
    ...rows.flatMap((r) => [`## ${ACTIONS.find(([v]) => v === r.decided)?.[1] ?? r.decided}: ${r.title.replace(/^[^:]+:\s*/, "")}`, `- Agent recommended: ${ACTIONS.find(([v]) => v === r.action)?.[1]}${r.decided !== r.action ? " (changed by the researcher)" : ""}`, `- Basis: ${r.basis}`, ...(r.evidence.length ? [`- Evidence: ${r.evidence.join("; ")}`] : ["- Evidence: none that holds"]), `- Strength: ${r.strength}`, ...(r.caveat ? [`- Caveat: ${r.caveat}`] : []), ...(r.owner ? [`- Owner: ${r.owner}`] : []), ...(r.note ? [`- Note: ${r.note}`] : []), ""]),
    ...(brief.implications?.length ? ["## Implications", ...brief.implications.map((x: string) => `- ${x}`), ""] : []),
    ...(brief.recommendations?.length ? ["## Recommendations (analytics engine)", ...brief.recommendations.map((x: string) => `- ${x}`)] : []),
  ].join("\n");
  const save = () => { const a = document.createElement("a"); a.href = URL.createObjectURL(new Blob([md()], { type: "text/markdown" })); a.download = "decision-brief.md"; a.click(); setTimeout(() => URL.revokeObjectURL(a.href), 2000); };
  return (
    <section data-testid="agw-out-brief">
      <h4>Decision brief{brief.question ? `: ${brief.question}` : ""} <span className="muted">· n = {brief.n}</span></h4>
      {!rows.length && <p className="muted">No decision the data can support yet — the plan has no hypotheses and nothing holds beyond it.</p>}
      <table className="agw-out-table"><thead><tr><th>Decision</th><th>Basis and evidence</th><th>Owner / note</th></tr></thead>
        <tbody>{rows.map((r, k) => (
          <tr key={r.id} data-testid="agw-brief-row">
            <td><select className="select small" value={r.decided} onChange={(e) => set(k, { decided: e.target.value })} aria-label={`Decision for ${r.id}`}>{ACTIONS.map(([v, t]) => <option key={v} value={v}>{t}</option>)}</select>
              <div style={{ marginTop: 4 }}>{r.title.replace(/^[^:]+:\s*/, "")}</div>{r.decided !== r.action && <div className="agw-warn">Changed from the agent's “{ACTIONS.find(([v]) => v === r.action)?.[1]}”</div>}</td>
            <td>{r.basis}{r.evidence.length ? <ul>{r.evidence.map((e: string, j: number) => <li key={j}>{e}</li>)}</ul> : <div className="muted">No finding that holds.</div>}<div className="muted">Strength: {r.strength}{r.caveat ? ` · ${r.caveat}` : ""}</div></td>
            <td><input className="input small" placeholder="Owner" value={r.owner} onChange={(e) => set(k, { owner: e.target.value })} /><textarea rows={2} placeholder="Note" value={r.note} onChange={(e) => set(k, { note: e.target.value })} /></td>
          </tr>))}</tbody></table>
      {brief.recommendations?.length > 0 && <details><summary>The analytics engine's recommendations ({brief.recommendations.length})</summary><ul>{brief.recommendations.map((x: string, i: number) => <li key={i}>{x}</li>)}</ul></details>}
      <div className="row" style={{ gap: 6 }}>
        <button className="btn tiny" onClick={save} data-testid="agw-brief-export">Export brief (.md)</button>
        <button className="btn tiny" onClick={() => void navigator.clipboard?.writeText(md())}>Copy</button>
        <span className="muted" style={{ fontSize: 12 }}>Your edits stay on this page until you export or copy them.</span>
      </div>
    </section>
  );
}

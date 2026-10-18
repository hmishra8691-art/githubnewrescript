"use client";
import React from "react";
import type { BuilderDraft, ReportBrief } from "@rescript/analytics";
import { AxApi, type Row } from "./api";

/**
 * "BUILD WITH RESCRIPT" — the intelligent report builder's front door.
 *
 * Step 1 asks for what the report is FOR (objective, key questions, audience,
 * tone, scope, format). Step 2 is a REVIEW: what the builder chose and why
 * (each chart's reason and denominator), what it left out and why, and which
 * key questions no saved analysis answers. Nothing is saved until the person
 * presses Create — and unticking an analysis here rebuilds the draft without it.
 */
type Draft = BuilderDraft & { model: { status: string; detail: string }; truncated: boolean; analysesRead: number };

const ROLE_WORD: Record<string, string> = { key: "answers a key question", finding: "finding", comparison: "group comparison", difference: "tested difference" };

export function ReportBuilderDialog({ api, analyses, onClose, onCreated, initial }: { api: AxApi; analyses: Row[]; onClose: () => void; onCreated: (report: Row) => void; initial?: Partial<Pick<ReportBrief, "objective" | "audience" | "tone" | "title" | "sections" | "theme">> & { story?: boolean } }) {
  const [objective, setObjective] = React.useState(initial?.objective ?? "");
  const [questions, setQuestions] = React.useState("");
  const [audience, setAudience] = React.useState<ReportBrief["audience"]>(initial?.audience ?? "client");
  const [tone, setTone] = React.useState<ReportBrief["tone"]>(initial?.tone ?? "plain");
  const [title, setTitle] = React.useState(initial?.title ?? "");
  const [client, setClient] = React.useState("");
  const [tests, setTests] = React.useState(true);
  const [crosstabs, setCrosstabs] = React.useState(true);
  const [maxItems, setMaxItems] = React.useState("");
  const [picked, setPicked] = React.useState<Set<string> | null>(null);   // null = every saved analysis
  const [withStory, setWithStory] = React.useState(initial?.story ?? true);
  const [withModel, setWithModel] = React.useState(false);
  const [draft, setDraft] = React.useState<Draft | null>(null);
  const [excluded, setExcluded] = React.useState<Set<string>>(new Set());
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  const brief = (ids?: string[]): ReportBrief => ({
    objective: objective.trim(), audience, tone, keyQuestions: questions.split(/\n/).map((q) => q.trim()).filter(Boolean),
    ...(ids?.length ? { analysisIds: ids } : picked ? { analysisIds: [...picked] } : {}),
    ...(tests ? {} : { includeTests: false }), ...(crosstabs ? {} : { includeCrosstabs: false }),
    ...(Number(maxItems) > 0 ? { maxItems: Number(maxItems) } : {}), ...(title.trim() ? { title: title.trim() } : {}), ...(client.trim() ? { client: client.trim() } : {}),
    /* what the sentence asked the report to contain (2026-10-17) — carried through to the draft */
    ...(initial?.sections?.length ? { sections: initial.sections } : {}), ...(initial?.theme ? { theme: initial.theme } : {}),
  });

  const run = async (ids?: string[]) => {
    setBusy(true); setError(null);
    try { const d = await api.reportBuilderDraft({ brief: brief(ids), story: withStory, interpretation: withModel }); setDraft(d); setExcluded(new Set()); }
    catch (e) { setError((e as Error).message); }
    finally { setBusy(false); }
  };
  const rebuildWithout = async () => { if (!draft) return; await run(draft.included.filter((i) => !excluded.has(i.id)).map((i) => i.id)); };
  const create = async () => {
    if (!draft) return;
    setBusy(true); setError(null);
    try { const r = await api.create("reports", { name: draft.report.title, kind: "report", mode: "live", definition: draft.report }); onCreated(r.item); onClose(); }
    catch (e) { setError((e as Error).message); setBusy(false); }
  };
  const toggleAnalysis = (id: string) => { const cur = picked ?? new Set(analyses.map((a) => a.id)); const next = new Set(cur); if (next.has(id)) next.delete(id); else next.add(id); setPicked(next.size === analyses.length ? null : next); };

  return (
    <div className="modal-back" onClick={onClose}>
      <div className="modal" style={{ maxWidth: 760, width: "92vw", maxHeight: "88vh", overflow: "auto" }} onClick={(e) => e.stopPropagation()} data-testid="ax-builder">
        <h3 style={{ marginTop: 0 }}>Build a report</h3>
        {!draft && <>
          <p className="muted" style={{ marginTop: 0 }}>Tell the builder what the report is for. It drafts only from the analyses you have already saved and their computed results — it never writes a number that is not in them.</p>
          <label className="ax-field"><span>Objective</span><textarea className="input" rows={2} value={objective} onChange={(e) => setObjective(e.target.value)} placeholder="e.g. Understand how satisfied customers are and which brands they consider" data-testid="ax-builder-objective" /></label>
          <label className="ax-field"><span>Key questions (one per line)</span><textarea className="input" rows={3} value={questions} onChange={(e) => setQuestions(e.target.value)} placeholder={"How satisfied are customers overall?\nDoes satisfaction differ by gender?"} data-testid="ax-builder-questions" /></label>
          <div className="row" style={{ gap: 10, flexWrap: "wrap" }}>
            <label className="ax-field"><span>Audience</span><select className="select" value={audience} onChange={(e) => setAudience(e.target.value as ReportBrief["audience"])} data-testid="ax-builder-audience"><option value="executive">Executive — few messages</option><option value="client">Client</option><option value="researcher">Researcher — with test detail</option></select></label>
            <label className="ax-field"><span>Tone</span><select className="select" value={tone} onChange={(e) => setTone(e.target.value as ReportBrief["tone"])}><option value="plain">Plain</option><option value="formal">Formal</option><option value="concise">Concise</option></select></label>
            <label className="ax-field"><span>Prepared for</span><input className="input" value={client} onChange={(e) => setClient(e.target.value)} placeholder="optional" /></label>
            <label className="ax-field"><span>Title</span><input className="input" value={title} onChange={(e) => setTitle(e.target.value)} placeholder="from the objective" /></label>
          </div>
          <div className="flabel" style={{ marginTop: 8 }}>Scope</div>
          <div className="row" style={{ gap: 14, flexWrap: "wrap" }}>
            <label className="ax-toggle"><input type="checkbox" checked={tests} onChange={(e) => setTests(e.target.checked)} /> include significance tests</label>
            <label className="ax-toggle"><input type="checkbox" checked={crosstabs} onChange={(e) => setCrosstabs(e.target.checked)} /> include cross-tabs</label>
            <label className="ax-toggle">at most <input className="input small" style={{ width: 60 }} value={maxItems} onChange={(e) => setMaxItems(e.target.value.replace(/\D/g, ""))} placeholder="auto" /> analyses</label>
          </div>
          <details style={{ marginTop: 6 }}><summary className="muted">Choose which saved analyses to read ({picked ? picked.size : analyses.length} of {analyses.length})</summary>
            <div className="ax-chips" style={{ marginTop: 6 }}>{analyses.map((a) => { const on = picked ? picked.has(a.id) : true; return <button key={a.id} type="button" className={`ax-chip ${on ? "on" : ""}`} onClick={() => toggleAnalysis(a.id)}>{a.name}</button>; })}</div>
          </details>
          <div className="flabel" style={{ marginTop: 8 }}>Format</div>
          <label className="ax-toggle"><input type="checkbox" checked={withStory} onChange={(e) => setWithStory(e.target.checked)} data-testid="ax-builder-story" /> also build an animated story (plays scene by scene; downloads as one HTML file)</label>
          <label className="ax-toggle"><input type="checkbox" checked={withModel} onChange={(e) => setWithModel(e.target.checked)} /> add an AI-written interpretation (what the findings may mean) — labelled as interpretation and checked against the numbers</label>
          {!analyses.length && <div className="ax-warn" style={{ marginTop: 8 }}>There are no saved analyses yet. Create them first — the Analysis tab can create them from the analysis plan.</div>}
          {error && <div className="ax-error" style={{ marginTop: 8 }} data-testid="ax-builder-error">{error}</div>}
          <div className="row" style={{ marginTop: 14 }}><span className="grow" /><button className="btn" onClick={onClose}>Cancel</button><button className="btn primary" onClick={() => void run()} disabled={busy || (!objective.trim() && !questions.trim())} data-testid="ax-builder-draft">{busy ? "Reading your analyses…" : "Draft the report"}</button></div>
        </>}

        {draft && <div data-testid="ax-builder-review">
          <p className="muted" style={{ marginTop: 0 }}>Review what the builder chose before anything is saved. It read {draft.analysesRead} saved {draft.analysesRead === 1 ? "analysis" : "analyses"}{draft.truncated ? " (the first 60)" : ""}.</p>
          {draft.notes.map((n, i) => <div key={i} className="ax-warn" style={{ marginBottom: 6 }} data-testid="ax-builder-note">{n}</div>)}
          {draft.model.status !== "not_asked" && <div className="muted" style={{ fontSize: 13, marginBottom: 6 }} data-testid="ax-builder-model" data-status={draft.model.status}>Interpretation: {draft.model.detail}</div>}
          <div className="flabel">Included ({draft.included.length})</div>
          {!draft.included.length && <div className="muted">Nothing could be shown — see the reasons below.</div>}
          <ul style={{ listStyle: "none", padding: 0, margin: 0 }}>
            {draft.included.map((i) => (
              <li key={i.id} className="card" style={{ padding: "8px 10px", marginBottom: 6 }} data-testid="ax-builder-included">
                <label className="ax-toggle"><input type="checkbox" checked={!excluded.has(i.id)} onChange={() => setExcluded((x) => { const n = new Set(x); if (n.has(i.id)) n.delete(i.id); else n.add(i.id); return n; })} /> <b>{i.name}</b> <span className="muted">— {ROLE_WORD[i.role]}</span></label>
                <div className="muted" style={{ fontSize: 12.5, marginLeft: 22 }}>Chart: <b>{i.chart.replace(/_/g, " ")}</b> — {i.chartReason}. {i.denominator}</div>
                {i.answers.length > 0 && <div className="muted" style={{ fontSize: 12.5, marginLeft: 22 }}>Answers: {i.answers.map((q) => `“${q}”`).join("; ")}</div>}
                {i.notes.map((n, k) => <div key={k} style={{ fontSize: 12.5, marginLeft: 22, color: "#b45309" }}>{n}</div>)}
              </li>))}
          </ul>
          {draft.skipped.length > 0 && <><div className="flabel" style={{ marginTop: 8 }}>Left out ({draft.skipped.length})</div>
            <ul style={{ margin: "0 0 0 18px", padding: 0 }}>{draft.skipped.map((s) => <li key={s.id} className="muted" style={{ fontSize: 13 }} data-testid="ax-builder-skipped"><b>{s.name}</b> — {s.reason}</li>)}</ul></>}
          {draft.story && <div className="muted" style={{ marginTop: 8, fontSize: 13 }}>The animated story has {draft.story.scenes.length} scenes: {draft.story.scenes.map((s) => s.type).join(" → ")}.</div>}
          {error && <div className="ax-error" style={{ marginTop: 8 }}>{error}</div>}
          <div className="row" style={{ marginTop: 14 }}>
            <button className="btn" onClick={() => { setDraft(null); setError(null); }}>← Change the brief</button>
            <span className="grow" />
            {excluded.size > 0 && <button className="btn" onClick={() => void rebuildWithout()} disabled={busy} data-testid="ax-builder-rebuild">Rebuild without {excluded.size}</button>}
            <button className="btn primary" onClick={() => void create()} disabled={busy || !draft.included.length} data-testid="ax-builder-create">{busy ? "Creating…" : "Create the report"}</button>
          </div>
        </div>}
      </div>
    </div>
  );
}

"use client";
import React from "react";
import { checkChartChoice, sceneDuration, storyHtml, type AnalysisResult, type ChartType, type StoryDefinition, type StoryScene } from "@rescript/analytics";
import { AxApi } from "./api";

/**
 * THE ANIMATED STORY of a report: scenes that play one after another —
 * objective, sample, findings, comparisons, differences, interpretation,
 * summary. The preview is the very file that is exported (the same renderer),
 * drawn from the same results as the report. Words from the engine are labelled
 * as such; a sentence a model wrote is marked as interpretation; a sentence
 * the researcher typed is theirs. MP4 video is NOT offered: nothing here can
 * render one, and a button that pretended to would fail.
 */
const CHARTS: { type: ChartType; label: string }[] = [
  { type: "bar_vertical", label: "Columns" }, { type: "bar_horizontal", label: "Horizontal bars" }, { type: "bar_grouped", label: "Grouped bars" },
  { type: "bar_stacked_100", label: "Stacked 100%" }, { type: "diverging_likert", label: "Diverging (scales)" }, { type: "donut", label: "Donut" }, { type: "line", label: "Line (ordered / time)" }, { type: "table", label: "Table" },
];
const SOURCE_WORD: Record<StoryScene["source"], string> = { engine: "written from the results", model: "model-written, number-checked", manual: "written by you" };

export function StoryPanel({ api, reportId, story, results, dirty, analysisIds, title, onChange }: {
  api: AxApi; reportId: string; story: StoryDefinition | undefined; results: Record<string, AnalysisResult>; dirty: boolean; analysisIds: string[]; title: string; onChange: (s: StoryDefinition | undefined) => void;
}) {
  const [sel, setSel] = React.useState<string | null>(null);
  const [busy, setBusy] = React.useState<string | null>(null);
  const [msg, setMsg] = React.useState<{ kind: "ok" | "error"; text: string } | null>(null);
  const [narrate, setNarrate] = React.useState(false);
  const html = React.useMemo(() => (story ? storyHtml(story, { results }) : ""), [story, results]);

  if (!story) {
    return (
      <div className="card" data-testid="ax-story-empty" style={{ padding: 16 }}>
        <h3 style={{ marginTop: 0 }}>Animated story</h3>
        <p className="muted">This report has no story yet. A story plays its findings scene by scene — objective, sample, findings, comparisons, differences, summary — from the same analyses and results as the report. It exports as one self-contained animated HTML file.</p>
        {analysisIds.length === 0 && <div className="ax-warn">Add charts or tables to the report first — a story is told from its analyses.</div>}
        {msg && <div className={msg.kind === "error" ? "ax-error" : "ax-ok"}>{msg.text}</div>}
        <button className="btn primary" disabled={!analysisIds.length || busy === "make"} data-testid="ax-story-make"
          onClick={async () => {
            setBusy("make"); setMsg(null);
            try { const d = await api.reportBuilderDraft({ brief: { objective: title, analysisIds, audience: "client", tone: "plain", keyQuestions: [] }, story: true }); if (d.story) onChange(d.story); else setMsg({ kind: "error", text: d.notes.join(" ") || "Nothing in this report could be turned into scenes." }); }
            catch (e) { setMsg({ kind: "error", text: (e as Error).message }); } finally { setBusy(null); }
          }}>{busy === "make" ? "Building…" : "Build a story from this report"}</button>
      </div>
    );
  }

  const scenes = story.scenes;
  const patch = (id: string, p: Partial<StoryScene>) => onChange({ ...story, scenes: scenes.map((s) => (s.id === id ? { ...s, ...p } : s)) });
  const move = (id: string, d: -1 | 1) => { const i = scenes.findIndex((s) => s.id === id), j = i + d; if (j < 0 || j >= scenes.length) return; const next = [...scenes]; [next[i], next[j]] = [next[j], next[i]]; onChange({ ...story, scenes: next }); };
  const remove = (id: string) => { onChange({ ...story, scenes: scenes.filter((s) => s.id !== id) }); if (sel === id) setSel(null); };
  const regenerate = async (id: string) => {
    setBusy(id); setMsg(null);
    try {
      const r = await api.regenerateScene(reportId, id);
      /* the chart the person chose survives — the server only knows the SAVED story — unless the data can no longer draw it */
      const mine = scenes.find((s) => s.id === id)?.chart; const res = r.scene.analysisId ? results[r.scene.analysisId] : undefined;
      const keep = mine && res && !res.error && checkChartChoice(res, mine.type).valid ? mine : r.scene.chart;
      patch(id, { ...r.scene, ...(keep ? { chart: keep } : {}) });
      setMsg({ kind: "ok", text: "Scene rebuilt from its analysis as it is now." });
    }
    catch (e) { setMsg({ kind: "error", text: dirty ? `${(e as Error).message} (Save the report first if this scene was added after the last save.)` : (e as Error).message }); }
    finally { setBusy(null); }
  };
  const addManual = () => { const id = `sc_${Math.random().toString(36).slice(2, 9)}`; onChange({ ...story, scenes: [...scenes, { id, type: "interpretation", title: "Our reading", text: "", narration: "", nature: "interpretation", source: "manual", durationMs: 5000 }] }); setSel(id); };
  const cur = scenes.find((s) => s.id === sel) ?? null;
  const curResult = cur?.analysisId ? results[cur.analysisId] : undefined;
  const charts = curResult && !curResult.error ? CHARTS.filter((c) => checkChartChoice(curResult, c.type).valid) : [];
  const totalSec = Math.round(scenes.filter((s) => !s.hidden).reduce((a, s) => a + s.durationMs, 0) / 1000);

  return (
    <div data-testid="ax-story" style={{ display: "grid", gap: 12 }}>
      <div className="row" style={{ gap: 8, flexWrap: "wrap", alignItems: "flex-end" }}>
        <label className="ax-field"><span>Story title</span><input className="input" value={story.title} onChange={(e) => onChange({ ...story, title: e.target.value })} data-testid="ax-story-title" /></label>
        <label className="ax-field"><span>Subtitle</span><input className="input" value={story.subtitle ?? ""} onChange={(e) => onChange({ ...story, subtitle: e.target.value })} /></label>
        <label className="ax-field"><span>Transition</span><select className="select" value={story.transition} onChange={(e) => onChange({ ...story, transition: e.target.value as StoryDefinition["transition"] })}><option value="fade">Fade</option><option value="slide">Slide</option><option value="zoom">Zoom</option></select></label>
        <label className="ax-field"><span>Accent colour</span><input type="color" value={/^#[0-9a-f]{6}$/i.test(story.accent ?? "") ? story.accent : "#2563eb"} onChange={(e) => onChange({ ...story, accent: e.target.value })} /></label>
        <label className="ax-field"><span>Logo URL (https)</span><input className="input" value={story.logoUrl ?? ""} onChange={(e) => onChange({ ...story, logoUrl: e.target.value })} placeholder="optional" /></label>
      </div>
      <div className="muted" style={{ fontSize: 13 }}>{scenes.filter((s) => !s.hidden).length} scenes · about {totalSec}s · built for a {story.audience} audience, {story.tone} tone. To change audience, tone or scope, build the report again from the builder.</div>
      {msg && <div className={msg.kind === "error" ? "ax-error" : "ax-ok"} data-testid="ax-story-msg">{msg.text}</div>}
      <div style={{ display: "grid", gridTemplateColumns: "minmax(260px, 340px) 1fr", gap: 12 }}>
        <div>
          <ol style={{ listStyle: "none", margin: 0, padding: 0 }} data-testid="ax-story-scenes">
            {scenes.map((s, i) => (
              <li key={s.id} className={`card selectable ${sel === s.id ? "on" : ""}`} style={{ padding: "6px 8px", marginBottom: 4, opacity: s.hidden ? 0.5 : 1 }} onClick={() => setSel(s.id)} data-testid="ax-story-scene">
                <div className="row" style={{ gap: 4 }}>
                  <span className="muted" style={{ width: 18 }}>{i + 1}</span>
                  <b style={{ flex: 1, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{s.title}</b>
                  {s.nature === "interpretation" && <span className="ax-chip on" title="An interpretation, not a finding" style={{ fontSize: 11 }}>reading</span>}
                  <button className="btn small ghost" title="Move up" onClick={(e) => { e.stopPropagation(); move(s.id, -1); }}>▲</button>
                  <button className="btn small ghost" title="Move down" onClick={(e) => { e.stopPropagation(); move(s.id, 1); }}>▼</button>
                </div>
                <div className="muted" style={{ fontSize: 12 }}>{s.type} · {s.source === "engine" ? "from the results" : s.source === "model" ? "model-written" : "yours"}{s.hidden ? " · hidden" : ""}</div>
              </li>))}
          </ol>
          <button className="btn small" style={{ marginTop: 4 }} onClick={addManual} data-testid="ax-story-add">+ Add a scene of your own</button>
        </div>
        <div>
          <iframe title="Story preview" sandbox="allow-scripts" srcDoc={html} data-testid="ax-story-preview" style={{ width: "100%", aspectRatio: "16 / 9", border: "1px solid var(--border, #cbd5e1)", borderRadius: 10, background: "#0f172a" }} />
        </div>
      </div>
      {cur && (
        <div className="card" style={{ padding: 12 }} data-testid="ax-story-editor">
          <div className="muted" style={{ fontSize: 12.5, marginBottom: 6 }}>{cur.nature === "interpretation" ? "Interpretation — shown as “not a finding”." : cur.nature === "frame" ? "Framing scene." : "Finding — drawn from the analysis' results."} Words: {SOURCE_WORD[cur.source]}.</div>
          <label className="ax-field"><span>Scene title</span><input className="input" value={cur.title} onChange={(e) => patch(cur.id, { title: e.target.value })} /></label>
          <label className="ax-field"><span>On-screen text</span><textarea className="input" rows={3} value={cur.text} onChange={(e) => { const text = e.target.value; const narration = [text, cur.base ?? ""].filter(Boolean).join(" "); patch(cur.id, { text, narration, source: "manual", durationMs: sceneDuration(narration) }); }} data-testid="ax-story-text" /></label>
          {cur.analysisId && (
            <label className="ax-field"><span>Chart</span>
              <select className="select" value={cur.chart?.type ?? "bar_vertical"} onChange={(e) => patch(cur.id, { chart: { type: e.target.value as ChartType } })} data-testid="ax-story-chart">
                {charts.length === 0 && <option value="table">Table (no chart can draw this result)</option>}
                {charts.map((c) => <option key={c.type} value={c.type}>{c.label}</option>)}
              </select></label>
          )}
          {cur.base && <div className="muted" style={{ fontSize: 12.5 }}>Base shown: {cur.base}</div>}
          <div className="row" style={{ gap: 8, marginTop: 8, flexWrap: "wrap" }}>
            <label className="ax-field"><span>Seconds on screen</span><input className="input small" style={{ width: 70 }} value={Math.round(cur.durationMs / 1000)} onChange={(e) => { const n = Number(e.target.value.replace(/\D/g, "")); if (n) patch(cur.id, { durationMs: Math.min(60, Math.max(2, n)) * 1000 }); }} /></label>
            <label className="ax-toggle"><input type="checkbox" checked={!cur.hidden} onChange={(e) => patch(cur.id, { hidden: !e.target.checked })} /> show this scene</label>
            <span className="grow" />
            {(cur.analysisId || cur.source === "model" || cur.type === "sample" || cur.type === "objective") && <button className="btn small" disabled={busy === cur.id} onClick={() => void regenerate(cur.id)} data-testid="ax-story-regenerate">{busy === cur.id ? "Rebuilding…" : "↻ Regenerate this scene"}</button>}
            <button className="btn small" onClick={() => remove(cur.id)}>Delete scene</button>
          </div>
        </div>
      )}
      <div className="card" style={{ padding: 12 }}>
        <div className="flabel">Export</div>
        <div className="row" style={{ gap: 10, flexWrap: "wrap", alignItems: "center" }}>
          <button className="btn primary" disabled={dirty || busy === "export"} data-testid="ax-story-export"
            onClick={async () => { setBusy("export"); setMsg(null); try { const { notes } = await api.exportStory(reportId, narrate); setMsg({ kind: "ok", text: `Story downloaded. ${notes.join(" ")}` }); } catch (e) { setMsg({ kind: "error", text: (e as Error).message }); } finally { setBusy(null); } }}>{busy === "export" ? "Preparing…" : "Download animated story (HTML)"}</button>
          <label className="ax-toggle"><input type="checkbox" checked={narrate} onChange={(e) => setNarrate(e.target.checked)} /> add spoken narration (uses the workspace's speech provider; charged per character)</label>
        </div>
        {dirty && <div className="muted" style={{ fontSize: 12.5, marginTop: 4 }}>Save the report first — the file is made from the saved story and the latest computed results.</div>}
        <div className="muted" style={{ fontSize: 12.5, marginTop: 6 }}>Video (MP4) is not available: this workspace has no video renderer. The HTML story plays in any browser, works offline and can be screen-recorded if you need a video.</div>
      </div>
    </div>
  );
}

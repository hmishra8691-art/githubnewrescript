"use client";
import React from "react";
import { buildVariableDictionary } from "@rescript/engine";
import { pv, suggestKpis, trackWaves, trackerCsv, waveFromTable, type KpiMeasure, type KpiTrack, type TrackerKpi, type TrackerReport, type WaveData } from "@rescript/analytics";
import { useStudio } from "./store";
import { orderedWithMappings, readState, subscribeTracker, trackerSession, updateTracker, type TrackerState } from "../../lib/tracker/session";
import { trackerAnswer } from "../../lib/intelligent/trackerRequest";

/**
 * RESULTS → WAVE TRACKER (2026-11-09, Rapid Studio phase 3).
 *
 * Every wave of a tracker — uploaded files from wherever they were fielded, or this survey's own live completes — mapped
 * to the baseline (renamed variables, changed wording, changed scales, recoded answers), measured on the chosen KPIs,
 * tested wave on wave, against the baseline and for trend, and checked for sample composition: each KPI is re-computed
 * with every wave raked to the baseline's profile, so a change that comes from a different sample is reported as that.
 * Everything is computed by packages/analytics/src/waveTracker.ts; nothing is estimated by a model.
 *
 * A wave's rows are never responses of this survey: they cannot reach its quotas, Data tab or exports.
 */
const MEASURES: { key: KpiMeasure; label: string }[] = [
  { key: "share", label: "Share of chosen codes" }, { key: "top_box", label: "Top box" }, { key: "mean", label: "Mean" }, { key: "nps", label: "NPS (0–10)" },
];
const VERDICT: Record<string, { label: string; tone: string }> = {
  genuine_change: { label: "Genuine change", tone: "up" }, composition: { label: "Sample composition", tone: "warn" },
  not_comparable: { label: "Not comparable", tone: "bad" }, no_change: { label: "No significant change", tone: "flat" }, insufficient: { label: "Not enough data", tone: "flat" },
};
const SYSTEM = new Set(["RESP_ID", "SESSION_ID", "SURVEY_VERSION", "START_TIME", "STATUS", "ENVIRONMENT"]);

function useTracker(surveyId: string) {
  const [, force] = React.useReducer((x: number) => x + 1, 0);
  React.useEffect(() => subscribeTracker(force), []);
  return trackerSession(surveyId);
}

const pct = (k: TrackerKpi, v: number | null) => (v === null ? "—" : k.measure === "mean" || k.measure === "nps" ? String(v) : `${v}%`);
const signed = (k: TrackerKpi, v: number | null) => (v === null ? "—" : `${v > 0 ? "+" : ""}${v}${k.measure === "mean" || k.measure === "nps" ? "" : " pts"}`);

function LineChart({ track }: { track: KpiTrack }) {
  const W = 520, H = 170, P = { l: 40, r: 12, t: 12, b: 26 };
  const pts = track.points, adj = track.adjusted;
  const vals = [...pts, ...adj].flatMap((p) => [p.value, p.ci?.[0], p.ci?.[1]]).filter((v): v is number => typeof v === "number");
  if (!vals.length) return null;
  let lo = Math.min(...vals), hi = Math.max(...vals);
  if (hi - lo < 1) { lo -= 1; hi += 1; }
  const pad = (hi - lo) * 0.1; lo -= pad; hi += pad;
  const x = (i: number) => P.l + (pts.length === 1 ? (W - P.l - P.r) / 2 : (i * (W - P.l - P.r)) / (pts.length - 1));
  const y = (v: number) => P.t + ((hi - v) * (H - P.t - P.b)) / (hi - lo);
  const path = (ps: typeof pts) => ps.map((p, i) => (p.value === null ? "" : `${i && ps[i - 1].value !== null ? "L" : "M"}${x(i).toFixed(1)},${y(p.value).toFixed(1)}`)).join(" ");
  const showAdj = adj.some((p, i) => p.value !== pts[i].value);
  return (
    <svg viewBox={`0 0 ${W} ${H}`} className="wt-chart" role="img" aria-label={`${track.kpi.label} by wave`}>
      {[lo + pad, (lo + hi) / 2, hi - pad].map((v) => <g key={v}><line x1={P.l} x2={W - P.r} y1={y(v)} y2={y(v)} className="wt-grid" /><text x={P.l - 6} y={y(v) + 4} textAnchor="end" className="wt-axis">{Math.round(v * 10) / 10}</text></g>)}
      {pts.map((p, i) => p.ci && p.value !== null ? <line key={`ci${i}`} x1={x(i)} x2={x(i)} y1={y(p.ci[0])} y2={y(p.ci[1])} className="wt-ci" /> : null)}
      {showAdj && <path d={path(adj)} className="wt-line adj" />}
      <path d={path(pts)} className="wt-line" />
      {pts.map((p, i) => p.value !== null ? <circle key={`p${i}`} cx={x(i)} cy={y(p.value)} r={3.5} className="wt-dot"><title>{`${p.label}: ${pct(track.kpi, p.value)} (n=${p.n})`}</title></circle> : null)}
      {pts.map((p, i) => <text key={`l${i}`} x={x(i)} y={H - 8} textAnchor="middle" className="wt-axis">{p.label}</text>)}
    </svg>
  );
}

export function WaveTrackerPanel() {
  const s = useStudio();
  const sandbox = s.surveyDbId === "sandbox";
  const t = useTracker(s.surveyDbId);
  const [busy, setBusy] = React.useState<string | null>(null);
  const [newLabel, setNewLabel] = React.useState("");
  const [mapWaveId, setMapWaveId] = React.useState<string | null>(null);
  const [ask, setAsk] = React.useState("");
  const [answer, setAnswer] = React.useState<ReturnType<typeof trackerAnswer> | null>(null);
  const fileRef = React.useRef<HTMLInputElement>(null);
  const loaded = React.useRef<string | null>(null);

  const dictionary = React.useMemo(() => {
    try {
      return buildVariableDictionary(s.def).filter((v) => v.responseType !== "system").map((v) => ({ name: v.name, label: v.questionText || v.label, values: Object.entries(v.valueLabels ?? {}).map(([code, label]) => ({ code, label })) }));
    } catch { return []; }
  }, [s.def]);

  /* load what the project keeps (once per project) */
  React.useEffect(() => {
    if (sandbox || loaded.current === s.surveyDbId) return;
    loaded.current = s.surveyDbId;
    void (async () => {
      const r = await fetch(`/api/surveys/${encodeURIComponent(s.surveyDbId)}/tracker`, { cache: "no-store" }).catch(() => null);
      const j = r ? await r.json().catch(() => ({})) : {};
      if (r?.ok) updateTracker(s.surveyDbId, { waves: (j.waves ?? []) as WaveData[], state: readState(j.config), persisted: true, note: null });
      else updateTracker(s.surveyDbId, { persisted: false, note: j.error ?? "The tracker store could not be reached — waves stay in this session." });
    })();
  }, [s.surveyDbId, sandbox]);

  const saveState = async (state: TrackerState) => {
    updateTracker(s.surveyDbId, { state });
    if (!t.persisted) return;
    const r = await fetch(`/api/surveys/${encodeURIComponent(s.surveyDbId)}/tracker`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ action: "save_config", config: state }) }).catch(() => null);
    if (!r?.ok) s.toast("The tracker settings were not saved — they stay in this session.", "err");
  };

  const addWave = async (wave: WaveData, notes: string[], fileName: string | null) => {
    if (!wave.rows.length) { s.toast("That file has no rows.", "err"); return; }
    let id = wave.id;
    if (t.persisted) {
      const r = await fetch(`/api/surveys/${encodeURIComponent(s.surveyDbId)}/tracker`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ action: "add_wave", wave: { ...wave, fileName, notes } }) }).catch(() => null);
      const j = r ? await r.json().catch(() => ({})) : {};
      if (r?.ok && j.id) id = j.id;
      else { updateTracker(s.surveyDbId, { persisted: false, note: j.error ?? "The wave could not be stored — it stays in this session." }); }
    }
    const waves = [...trackerSession(s.surveyDbId).waves, { ...wave, id }];
    const st = trackerSession(s.surveyDbId).state;
    updateTracker(s.surveyDbId, { waves });
    if (!st.kpis.length && waves.length) {
      const base = [...waves].sort((a, b) => a.order - b.order)[0];
      const kpis = suggestKpis(base);
      if (kpis.length) await saveState({ ...st, kpis });
    }
    s.toast(`${wave.label} added — ${wave.rows.length} rows, ${wave.columns.length} variables${notes.length ? `. ${notes.join(" ")}` : ""}`, "ok");
    setNewLabel("");
  };

  const nextOrder = () => (t.waves.length ? Math.max(...t.waves.map((w) => w.order)) + 1 : 1);
  const labelFor = () => newLabel.trim() || `Wave ${nextOrder()}`;

  const onFile = async (f: File) => {
    setBusy("Reading the file…");
    try {
      const isXlsx = /\.xlsx?$/i.test(f.name);
      let body: Record<string, unknown> = { surveyId: s.surveyDbId };
      if (isXlsx) {
        const buf = new Uint8Array(await f.arrayBuffer());
        let bin = ""; for (let i = 0; i < buf.length; i += 0x8000) bin += String.fromCharCode(...buf.subarray(i, i + 0x8000));
        body = { ...body, xlsxBase64: btoa(bin) };
      } else body = { ...body, text: await f.text() };
      const r = await fetch("/api/tracker/parse", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) { s.toast(j.error ?? "The file could not be read.", "err"); return; }
      const { wave, notes } = waveFromTable({ id: `local-${Date.now()}`, label: labelFor(), order: nextOrder(), source: "upload" }, j.headers, j.rows, dictionary);
      await addWave(wave, notes, f.name);
    } finally { setBusy(null); if (fileRef.current) fileRef.current.value = ""; }
  };

  const addLive = async () => {
    setBusy("Reading this survey's live completes…");
    try {
      const r = await fetch(`/api/surveys/${encodeURIComponent(s.surveyDbId)}/responses?format=csv&include=live&dataset=clean&system=1`, { cache: "no-store" });
      if (!r.ok) { s.toast("This survey's live data could not be read.", "err"); return; }
      const p = await fetch("/api/tracker/parse", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ surveyId: s.surveyDbId, text: await r.text() }) });
      const j = await p.json().catch(() => ({}));
      if (!p.ok) { s.toast(j.error ?? "The live data could not be read.", "err"); return; }
      const rows = (j.rows as Record<string, unknown>[]).filter((x) => !("STATUS" in x) || String(x.STATUS) === "complete");
      const headers = (j.headers as string[]).filter((h) => !SYSTEM.has(h));
      const { wave, notes } = waveFromTable({ id: `local-${Date.now()}`, label: labelFor(), order: nextOrder(), source: "survey" }, headers, rows, dictionary);
      await addWave(wave, [`${rows.length} live completes (flagged responses excluded).`, ...notes], null);
    } finally { setBusy(null); }
  };

  const removeWave = async (w: WaveData) => {
    if (t.persisted && !w.id.startsWith("local-")) {
      const r = await fetch(`/api/surveys/${encodeURIComponent(s.surveyDbId)}/tracker`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ action: "remove_wave", waveId: w.id }) }).catch(() => null);
      if (!r?.ok) { s.toast("The wave was not removed.", "err"); return; }
    }
    const manual = { ...t.state.manual }; delete manual[w.id];
    updateTracker(s.surveyDbId, { waves: t.waves.filter((x) => x.id !== w.id) });
    if (t.state.manual[w.id]) await saveState({ ...t.state, manual });
  };
  const setOrder = (w: WaveData, order: number) => updateTracker(s.surveyDbId, { waves: t.waves.map((x) => (x.id === w.id ? { ...x, order } : x)) });

  const { waves, mappings } = React.useMemo(() => orderedWithMappings(t), [t]);
  const base = waves[0] ?? null;
  const variables = base?.columns.map((c) => c.name) ?? [];
  const report: TrackerReport | null = React.useMemo(() => {
    if (waves.length < 2 || !t.state.kpis.length) return null;
    try { return trackWaves(waves, mappings, { kpis: t.state.kpis, composition: t.state.composition, segment: t.state.segment, alpha: t.state.alpha }); } catch { return null; }
  }, [waves, mappings, t.state]);

  const st = t.state;
  const setKpi = (i: number, patch: Partial<TrackerKpi>) => void saveState({ ...st, kpis: st.kpis.map((k, j) => (j === i ? { ...k, ...patch } : k)) });
  const mapping = mapWaveId ? mappings[mapWaveId] : waves[1] ? mappings[waves[1].id] : null;
  const mapWave = waves.find((w) => w.id === (mapping?.waveId ?? ""));

  const exportCsv = () => {
    if (!report) return;
    const blob = new Blob(["﻿" + trackerCsv(report)], { type: "text/csv;charset=utf-8" });
    const a = document.createElement("a"); a.href = URL.createObjectURL(blob); a.download = `${(s.def.meta.code || "tracker").replace(/[^A-Za-z0-9_-]/g, "")}_wave_tracker.csv`;
    document.body.appendChild(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  };

  return (
    <div className="wt" data-testid="wave-tracker">
      <div className="panel-head">
        <h2>Wave tracker</h2>
        <p className="muted">Bring every wave of a tracking study together — uploaded files or this survey’s live data. Variables are matched to the baseline, KPIs are tested wave on wave, against the baseline and for trend, and changes caused by a different sample are separated from real ones. Waves are kept apart from this survey’s responses: they never reach its quotas, Data tab or exports.</p>
      </div>
      {(sandbox || t.note) && <div className="sd-warn" data-testid="wt-note">{sandbox ? "Sandbox: waves stay in this browser session. In a saved project they are kept with the project." : t.note}</div>}

      <section className="wt-ask">
        <form onSubmit={(e) => { e.preventDefault(); if (ask.trim()) setAnswer(trackerAnswer(ask, trackerSession(s.surveyDbId))); }}>
          <input value={ask} onChange={(e) => setAsk(e.target.value)} placeholder="Ask: is the change in awareness since the last wave real?" data-testid="wt-ask" aria-label="Ask about the waves" />
          <button className="btn small" type="submit" data-testid="wt-ask-go">Ask</button>
        </form>
        {answer && <div className="sd-advice" data-testid="wt-answer"><p>{answer.answer}</p>{answer.sections.slice(0, 2).map((sec) => <div key={sec.title}><strong>{sec.title}</strong><ul>{sec.items.map((it, i) => <li key={i}>{it.label}{it.detail ? <span className="muted"> — {it.detail}</span> : null}</li>)}</ul></div>)}</div>}
      </section>

      <section className="wt-card">
        <h3>1 · Waves</h3>
        {waves.length ? (
          <table className="wt-table" data-testid="wt-waves">
            <thead><tr><th>Order</th><th>Wave</th><th>Respondents</th><th>Variables</th><th>Source</th><th /></tr></thead>
            <tbody>{waves.map((w, i) => (
              <tr key={w.id}>
                <td><input type="number" min={0} value={w.order} onChange={(e) => setOrder(w, Number(e.target.value))} className="wt-num" aria-label={`Order of ${w.label}`} /></td>
                <td>{w.label}{i === 0 ? <span className="pill">baseline</span> : null}</td>
                <td>{w.rows.length}</td><td>{w.columns.length}</td>
                <td>{w.source === "survey" ? "this survey (live)" : "upload"}</td>
                <td><button className="btn small ghost" type="button" onClick={() => void removeWave(w)} data-testid={`wt-remove-${i}`}>Remove</button></td>
              </tr>
            ))}</tbody>
          </table>
        ) : <p className="muted">No waves yet. The first wave (lowest order) is the baseline.</p>}
        <div className="wt-add">
          <input value={newLabel} onChange={(e) => setNewLabel(e.target.value)} placeholder={`Label (default “Wave ${nextOrder()}”)`} data-testid="wt-label" aria-label="Wave label" />
          <input ref={fileRef} type="file" accept=".csv,.tsv,.txt,.xlsx,.xls" hidden onChange={(e) => { const f = e.target.files?.[0]; if (f) void onFile(f); }} data-testid="wt-file" />
          <button className="btn small" type="button" disabled={!!busy} onClick={() => fileRef.current?.click()} data-testid="wt-upload">Upload a wave (CSV / Excel)</button>
          <button className="btn small" type="button" disabled={!!busy || sandbox} title={sandbox ? "Needs a saved project with live data" : "Add this survey’s live completes as a wave"} onClick={() => void addLive()} data-testid="wt-live">Add this survey’s live data</button>
          {busy && <span className="muted">{busy}</span>}
        </div>
      </section>

      {waves.length >= 2 && mapping && mapWave && (
        <section className="wt-card">
          <h3>2 · Mapping to the baseline</h3>
          <div className="wt-add">
            <label>Wave <select value={mapWave.id} onChange={(e) => setMapWaveId(e.target.value)} data-testid="wt-map-wave">{waves.slice(1).map((w) => <option key={w.id} value={w.id}>{w.label}</option>)}</select></label>
            <span className="muted">{mapping.matches.filter((m) => m.other).length} of {mapping.matches.length} baseline variables matched · {mapping.matches.filter((m) => m.other && !m.comparable).length} not comparable · {mapping.added.length} new in this wave</span>
          </div>
          <table className="wt-table" data-testid="wt-mapping">
            <thead><tr><th>Baseline</th><th>In {mapWave.label}</th><th>Matched by</th><th>Changes</th></tr></thead>
            <tbody>{mapping.matches.map((m) => (
              <tr key={m.base} className={!m.other ? "missing" : !m.comparable ? "bad" : m.changes.length ? "warn" : ""}>
                <td><code>{m.base}</code></td>
                <td>
                  <select value={m.how === "manual" ? (m.other ?? "__none") : "__auto"} aria-label={`Match for ${m.base}`} data-testid={`wt-map-${m.base}`} onChange={(e) => {
                    const v = e.target.value; const cur = { ...(st.manual[mapWave.id] ?? {}) };
                    if (v === "__auto") delete cur[m.base]; else cur[m.base] = v === "__none" ? null : v;
                    void saveState({ ...st, manual: { ...st.manual, [mapWave.id]: cur } });
                  }}>
                    <option value="__auto">{m.how === "manual" ? "Automatic" : `Automatic: ${m.other ?? "none"}`}</option>
                    <option value="__none">Not asked in this wave</option>
                    {mapWave.columns.map((c) => <option key={c.name} value={c.name}>{c.name}{c.label ? ` — ${c.label.slice(0, 40)}` : ""}</option>)}
                  </select>
                </td>
                <td>{m.how.replace(/_/g, " ")}{m.confidence && m.confidence < 1 ? ` (${Math.round(m.confidence * 100)}%)` : ""}</td>
                <td>{m.changes.join("; ") || "—"}</td>
              </tr>
            ))}</tbody>
          </table>
          {mapping.added.length > 0 && <p className="muted">New in {mapWave.label}: {mapping.added.slice(0, 30).join(", ")}{mapping.added.length > 30 ? "…" : ""}</p>}
        </section>
      )}

      {base && (
        <section className="wt-card">
          <h3>{waves.length >= 2 ? "3" : "2"} · KPIs and checks</h3>
          <table className="wt-table" data-testid="wt-kpis">
            <thead><tr><th>KPI</th><th>Variable</th><th>Measure</th><th>Counts as</th><th /></tr></thead>
            <tbody>{st.kpis.map((k, i) => (
              <tr key={k.id}>
                <td><input value={k.label} onChange={(e) => setKpi(i, { label: e.target.value })} aria-label="KPI label" /></td>
                <td><select value={k.variable} onChange={(e) => setKpi(i, { variable: e.target.value })} aria-label="KPI variable">{variables.map((v) => <option key={v} value={v}>{v}</option>)}</select></td>
                <td><select value={k.measure} onChange={(e) => setKpi(i, { measure: e.target.value as KpiMeasure })} aria-label="KPI measure">{MEASURES.map((m) => <option key={m.key} value={m.key}>{m.label}</option>)}</select></td>
                <td>{k.measure === "share" ? <input value={(k.codes ?? ["1"]).join(",")} onChange={(e) => setKpi(i, { codes: e.target.value.split(",").map((x) => x.trim()).filter(Boolean) })} aria-label="Codes counted" className="wt-codes" /> : k.measure === "top_box" ? <label>top <input type="number" min={1} max={5} value={k.top ?? 2} onChange={(e) => setKpi(i, { top: Number(e.target.value) || 2 })} className="wt-num" /> points</label> : <span className="muted">—</span>}</td>
                <td><button type="button" className="btn small ghost" onClick={() => void saveState({ ...st, kpis: st.kpis.filter((_, j) => j !== i) })}>Remove</button></td>
              </tr>
            ))}</tbody>
          </table>
          <div className="wt-add">
            <button type="button" className="btn small" data-testid="wt-add-kpi" onClick={() => void saveState({ ...st, kpis: [...st.kpis, { id: `k${Date.now()}`, label: variables[0] ?? "KPI", variable: variables[0] ?? "", measure: "share", codes: ["1"] }] })}>Add KPI</button>
            <button type="button" className="btn small ghost" data-testid="wt-suggest" onClick={() => { const add = suggestKpis(base).filter((k) => !st.kpis.some((x) => x.variable === k.variable)); void saveState({ ...st, kpis: [...st.kpis, ...add] }); if (!add.length) s.toast("No further KPIs recognised — add them by hand.", "ok"); }}>Suggest KPIs</button>
          </div>
          <div className="sd-grid">
            <div className="f"><span>Composition checks (profile variables)</span>
              <div className="wt-checks" data-testid="wt-composition">{variables.filter((v) => !st.kpis.some((k) => k.variable === v)).slice(0, 60).map((v) => (
                <label key={v}><input type="checkbox" checked={st.composition.includes(v)} onChange={(e) => void saveState({ ...st, composition: e.target.checked ? [...st.composition, v].slice(0, 8) : st.composition.filter((x) => x !== v) })} /> {v}</label>
              ))}</div>
            </div>
            <label className="f"><span>Segment breakdown</span><select value={st.segment ?? ""} onChange={(e) => void saveState({ ...st, segment: e.target.value || null })} data-testid="wt-segment"><option value="">None</option>{variables.map((v) => <option key={v} value={v}>{v}</option>)}</select></label>
            <label className="f"><span>Significance level</span><select value={String(st.alpha)} onChange={(e) => void saveState({ ...st, alpha: Number(e.target.value) })}><option value="0.01">99 %</option><option value="0.05">95 %</option><option value="0.1">90 %</option></select></label>
          </div>
        </section>
      )}

      {report && (
        <section className="wt-card" data-testid="wt-results">
          <div className="wt-add"><h3 style={{ margin: 0 }}>Results</h3><button type="button" className="btn small" onClick={exportCsv} data-testid="wt-export">Download CSV</button></div>
          {report.kpis.map((k) => (
            <div key={k.kpi.id} className="wt-kpi" data-testid={`wt-kpi-${k.kpi.variable}`}>
              <div className="wt-kpi-head"><strong>{k.kpi.label}</strong><span className="muted">{MEASURES.find((m) => m.key === k.kpi.measure)?.label} · {k.kpi.variable}</span>
                {k.trend && <span className={`pill ${k.trend.p !== null && k.trend.p < st.alpha ? "up" : ""}`}>{k.trend.p !== null && k.trend.p < st.alpha ? `Trend ${k.trend.direction} (${pv(k.trend.p)})` : "No significant trend"}</span>}
              </div>
              <LineChart track={k} />
              {st.composition.length > 0 && <p className="muted wt-legend">Solid: as fielded. Dashed: every wave matched to the baseline on {st.composition.join(", ")}.</p>}
              <table className="wt-table">
                <thead><tr><th>Wave</th><th>Value</th><th>95 % CI</th><th>Base</th>{st.composition.length > 0 && <th>Matched</th>}<th>vs previous</th><th>vs baseline</th></tr></thead>
                <tbody>{k.points.map((p, i) => {
                  const prev = i ? k.waveOnWave[i - 1] : null, vb = i ? k.vsBaseline[i - 1] : null;
                  const cell = (c: typeof prev) => c ? <span className={`wt-v ${VERDICT[c.verdict].tone}`} title={c.why}>{signed(k.kpi, c.diff)}{c.adjustedDiff !== null ? ` · matched ${signed(k.kpi, c.adjustedDiff)}` : ""} · {VERDICT[c.verdict].label} ({pv(c.p)}{c.adjustedP !== null ? `; matched ${pv(c.adjustedP)}` : ""})</span> : <span className="muted">baseline</span>;
                  return <tr key={p.wave}><td>{p.label}</td><td>{pct(k.kpi, p.value)}</td><td>{p.ci ? `${p.ci[0]} – ${p.ci[1]}` : "—"}</td><td>{p.n}</td>{st.composition.length > 0 && <td>{pct(k.kpi, k.adjusted[i].value)}</td>}<td>{cell(prev)}</td><td>{cell(vb)}</td></tr>;
                })}</tbody>
              </table>
              {k.changes.length > 0 && <div className="sd-warn">{k.changes.join(" · ")}</div>}
            </div>
          ))}
          {report.composition.length > 0 && (
            <div><strong>Sample composition against the baseline</strong>
              <table className="wt-table" data-testid="wt-comp-table"><thead><tr><th>Variable</th><th>Wave</th><th>Largest difference</th><th>p (chi-square)</th><th /></tr></thead>
                <tbody>{report.composition.map((c) => <tr key={`${c.variable}${c.wave}`} className={c.shifted ? "warn" : ""}><td>{c.variable}</td><td>{c.wave}</td><td>{c.largest ? `code ${c.largest.code}: ${c.largest.base}% → ${c.largest.wave}%` : "—"}</td><td>{pv(c.p)}</td><td>{c.shifted ? "shifted" : "similar"}</td></tr>)}</tbody></table>
            </div>
          )}
          {report.segments.length > 0 && (
            <div><strong>By {st.segment}</strong>
              <table className="wt-table" data-testid="wt-segments"><thead><tr><th>KPI</th><th>{st.segment}</th>{report.waves.map((w) => <th key={w.id}>{w.label}</th>)}</tr></thead>
                <tbody>{report.segments.map((g) => { const k = st.kpis.find((x) => x.id === g.kpi)!; const lab = base?.columns.find((c) => c.name === st.segment)?.values?.find((v) => v.code === g.code)?.label ?? g.code; return <tr key={`${g.kpi}${g.code}`}><td>{k.label}</td><td>{lab}</td>{g.points.map((p) => <td key={p.wave} className={p.n < 50 ? "muted" : ""}>{pct(k, p.value)} <span className="muted">n={p.n}</span></td>)}</tr>; })}</tbody></table>
            </div>
          )}
          <div className="sd-advice"><strong>Recommended charts and tests</strong><ul>{report.recommendations.map((r) => <li key={r}>{r}</li>)}</ul></div>
        </section>
      )}
      {waves.length >= 2 && !st.kpis.length && <p className="muted">Choose at least one KPI to compare the waves.</p>}
    </div>
  );
}


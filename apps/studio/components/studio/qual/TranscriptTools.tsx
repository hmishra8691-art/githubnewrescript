"use client";
import React from "react";
import type { AutoCodeSettings, QualJob } from "@rescript/analytics";
import type { WorkspaceView } from "./qualApi";
import type { SynthesisApi } from "./synthesisApi";

/**
 * TRANSCRIPT TOOLS (2026-10-22): correcting a segment's words (the excerpts on it move, re-anchor or are
 * invalidated — never a quote that is not the text; every correction in the history), and the automatic coding
 * pipeline's settings and progress.
 */
type Run = <T>(label: string, fn: () => Promise<T>, done?: (v: T) => void) => Promise<T | undefined>;

/** the synthesis client, for components deep in the Transcripts tab */
export const SynApiContext = React.createContext<SynthesisApi | null>(null);

export function CorrectableText({ ws, api: given, run, transcriptId, segmentId, text, setWs, setNote }: { ws: WorkspaceView; api?: SynthesisApi | null; run: Run; transcriptId: string; segmentId: string; text: string; setWs: (w: WorkspaceView) => void; setNote?: (n: string) => void }) {
  const fromContext = React.useContext(SynApiContext);
  const api = given ?? fromContext;
  const [editing, setEditing] = React.useState(false);
  const [draft, setDraft] = React.useState(text);
  React.useEffect(() => { if (!editing) setDraft(text); }, [text, editing]);
  const anchored = ws.state.excerpts.filter((e) => e.sourceId === transcriptId && e.segmentId === segmentId && (e as { anchor?: { state: string } }).anchor?.state === "reanchored" && e.status !== "rejected");
  if (!editing) return (
    <span data-testid="qual-segment-text">{text}{anchored.length > 0 && <span className="badge warning" data-testid="qual-reanchored" title={anchored.map((e) => `was “${(e as { anchor?: { previousQuote: string } }).anchor?.previousQuote}”`).join("; ")}> {anchored.length} quote(s) corrected — check</span>}
      {api && ws.can.manage && ws.pii && <button type="button" className="btn ghost small" data-testid="qual-segment-edit" title="Correct what speech-to-text misheard" onClick={() => setEditing(true)}>✎</button>}</span>
  );
  return (
    <span className="ql-row" data-testid="qual-segment-editor">
      <textarea className="ta" rows={2} style={{ minWidth: 360 }} value={draft} data-testid="qual-segment-input" onChange={(e) => setDraft(e.target.value)} />
      <button type="button" className="btn small primary" data-testid="qual-segment-save" disabled={draft === text || !draft.trim()} onClick={() => api && run("Saving the correction", () => api.correct(transcriptId, segmentId, draft), (r) => { setWs(r.ws); setEditing(false); setNote?.(`Corrected: ${r.summary}.`); })}>Save correction</button>
      <button type="button" className="btn small" onClick={() => { setEditing(false); setDraft(text); }}>Cancel</button>
    </span>
  );
}

export function AutoCodePanel({ ws, api, run, setWs }: { ws: WorkspaceView; api: SynthesisApi; run: Run; setWs: (w: WorkspaceView) => void }) {
  const [settings, setSettings] = React.useState<AutoCodeSettings | null>(null);
  const [jobs, setJobs] = React.useState<QualJob[]>([]);
  React.useEffect(() => { if (!ws.can.code) return; void api.jobs().then((r) => { setSettings(r.settings); setJobs(r.jobs); }).catch(() => null); }, [api, ws.can.code]);
  /* while the workspace is open and auto-coding is on, open jobs are advanced (there is no background worker) */
  const sources = ws.transcripts.length;
  React.useEffect(() => {
    if (!settings?.enabled) return;
    let alive = true;
    const step = async () => { try { const r = await api.continueJobs(); if (!alive) return; if (r.jobs.length) setJobs((cur) => [...r.jobs, ...cur.filter((j) => !r.jobs.some((x) => x.id === j.id))].slice(0, 20)); if (r.ws) setWs(r.ws); } catch { /* the next tick tries again */ } };
    void step();
    const t = setInterval(() => void step(), 8000);
    return () => { alive = false; clearInterval(t); };
  }, [settings?.enabled, api, sources, setWs]);
  if (!ws.can.code || !settings) return null;
  const set = (patch: Partial<AutoCodeSettings>) => run("Saving", () => api.setAutoCode({ ...settings, ...patch }), setSettings);
  return (
    <div className="card ql-section" data-testid="qual-autocode" data-enabled={settings.enabled ? "1" : "0"}>
      <div className="eyebrow">Automatic coding of new sources</div>
      <p className="ql-muted">When on, each new transcript (imported, transcribed, an AI-moderated interview, a closed group session) is redacted and coded with the current codebook — or, with none yet, codes are proposed — as AI suggestions for review. Batched, metered per call, at most the set number of calls per source; it runs while this workspace is open.</p>
      <div className="ql-row">
        <label><input type="checkbox" checked={settings.enabled} data-testid="qual-autocode-toggle" disabled={!ws.can.manage} onChange={(e) => void set({ enabled: e.target.checked })} /> Code new sources automatically</label>
        <select className="select small" value={settings.mode} disabled={!ws.can.manage} onChange={(e) => void set({ mode: e.target.value as AutoCodeSettings["mode"] })}><option value="auto">Deductive when there are codes, else inductive</option><option value="deductive">Deductive (current codebook)</option><option value="inductive">Inductive (propose codes)</option></select>
        <label>at most <input className="input small" type="number" min={1} max={20} style={{ width: 60 }} value={settings.maxBatchesPerSource} disabled={!ws.can.manage} onChange={(e) => void set({ maxBatchesPerSource: Number(e.target.value) })} /> calls per source</label>
        <label><input type="checkbox" checked={settings.updateSummaries} disabled={!ws.can.manage} onChange={(e) => void set({ updateSummaries: e.target.checked })} /> regenerate the theme summaries it touches</label>
      </div>
      {jobs.length > 0 && <ul className="ql-list">{jobs.slice(0, 8).map((j) => <li key={j.id} data-testid="qual-job" data-status={j.status}>{ws.transcripts.find((t) => t.id === j.sourceIds[0])?.title ?? j.sourceIds[0]} — {j.status}{"batchesDone" in j.progress ? ` · ${String(j.progress.batchesDone)}/${String(j.progress.batchesTotal)} batches, ${String(j.progress.excerpts)} excerpts` : ""}{j.error ? ` · ${j.error}` : ""}</li>)}</ul>}
    </div>
  );
}

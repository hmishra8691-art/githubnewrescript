"use client";
import React from "react";
import { formatTimestamp, selectForReel, CLIP_NOTE } from "@rescript/analytics";
import { ClipPlayer } from "./ClipPlayer";
import { allSegments } from "@/lib/qual/qualWorkspace";
import type { WorkspaceView } from "./qualApi";
import { pickable, type SynthesisApi, type ReelView } from "./synthesisApi";

/**
 * HIGHLIGHT REELS (2026-10-22) — collect excerpts across sessions into a named reel ("pricing complaints"), order
 * them, note them, play each clip from its recording (saved projects with a recording and timestamps: a 15-minute
 * signed URL after the playback access check, played from the turn's start to its end), and export the list to
 * Word or PowerPoint. Joining clips into one video is not done.
 */
type Run = <T>(label: string, fn: () => Promise<T>, done?: (v: T) => void) => Promise<T | undefined>;

function save(blob: Blob, name: string) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url; a.download = name; document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
}

export function HighlightsTab({ ws, api, run }: { ws: WorkspaceView; api: SynthesisApi; run: Run }) {
  const [data, setData] = React.useState<{ reels: ReelView[]; can: { playback: boolean; edit: boolean; export: boolean } } | null>(null);
  const [topic, setTopic] = React.useState("");
  const [name, setName] = React.useState("");
  const [picked, setPicked] = React.useState<string[]>([]);
  const [filter, setFilter] = React.useState("");
  const [player, setPlayer] = React.useState<{ url: string; start: number; end: number; id: string; byWords?: boolean; approximate?: boolean } | null>(null);
  const segs = React.useMemo(() => allSegments(ws), [ws]);
  const options = React.useMemo(() => pickable(ws), [ws]);
  React.useEffect(() => { void run("Loading reels", () => api.reels(), setData); }, [api, run, ws.version]);
  const suggest = () => { const s = selectForReel(ws.state, segs, topic); setPicked(s.excerpts.map((e) => e.id)); if (!name) setName(topic.trim().replace(/^./, (c) => c.toUpperCase())); return s.note; };
  const [note, setNote] = React.useState<string | null>(null);
  const setReels = (reels: ReelView[]) => setData((d) => (d ? { ...d, reels } : d));
  return (
    <div data-testid="qual-highlights">
      {data?.can.edit !== false && ws.can.code && (
        <div className="card ql-section" data-testid="hl-form">
          <div className="eyebrow">Make a highlight reel</div>
          <div className="ql-row">
            <input className="input small" style={{ minWidth: 260 }} placeholder="a topic, e.g. pricing complaints" value={topic} data-testid="hl-topic" onChange={(e) => setTopic(e.target.value)} />
            <button type="button" className="btn small" data-testid="hl-suggest" disabled={!topic.trim()} onClick={() => setNote(suggest())}>Find excerpts</button>
            <input className="input small" placeholder="Reel name" value={name} data-testid="hl-name" onChange={(e) => setName(e.target.value)} />
            <button type="button" className="btn primary small" data-testid="hl-create" disabled={!name.trim()} onClick={() => run("Making the reel", () => api.createReel(name, picked), (r) => { setReels(r); setPicked([]); setName(""); setTopic(""); setNote(null); })}>Make reel ({picked.length})</button>
          </div>
          {note && <p className="ql-muted" data-testid="hl-note">{note}</p>}
          <input className="input small" placeholder="filter excerpts" value={filter} onChange={(e) => setFilter(e.target.value)} />
          <div className="ql-picker" style={{ maxHeight: 220, overflow: "auto" }}>
            {options.filter((o) => !filter || `${o.quote} ${o.where}`.toLowerCase().includes(filter.toLowerCase())).slice(0, 200).map((o) => (
              <label key={o.id} className="ql-row" data-testid="hl-option" data-id={o.id}><input type="checkbox" checked={picked.includes(o.id)} onChange={(e) => setPicked(e.target.checked ? [...picked, o.id] : picked.filter((x) => x !== o.id))} /> “{o.quote.slice(0, 120)}” <span className="ql-muted">{o.where}</span></label>
            ))}
          </div>
        </div>
      )}
      {player && <ClipPlayer clip={player} testId="hl-player" />}
      {data?.reels.length === 0 && <div className="empty">No highlight reels yet.</div>}
      {data?.reels.map((r) => (
        <div key={r.id} className="card ql-section" data-testid="hl-reel" data-name={r.name} data-items={r.items.length}>
          <div className="ql-row">
            <b>{r.name}</b><span className="chip">{r.items.length} quotes</span><span className="grow" />
            {data.can.export && ws.can.report && <><button type="button" className="btn small" data-testid="hl-export-docx" onClick={() => run("Exporting", () => api.exportReel(r, "docx"), (f) => save(f.blob, f.name))}>Word</button><button type="button" className="btn small" data-testid="hl-export-pptx" onClick={() => run("Exporting", () => api.exportReel(r, "pptx"), (f) => save(f.blob, f.name))}>PowerPoint</button></>}
            {ws.can.code && <button type="button" className="btn small danger" onClick={() => run("Deleting", () => api.deleteReel(r), setReels)}>Delete</button>}
          </div>
          <ol className="ql-list">
            {r.items.map((it, i) => (
              <li key={it.excerptId} data-testid="hl-item" data-id={it.excerptId} data-state={r.states[it.excerptId]}>
                “{it.snapshot.quote}” <span className="ql-muted">— {ws.transcripts.find((t) => t.id === it.snapshot.sourceId)?.title ?? "source"}{it.snapshot.speaker ? ` · ${it.snapshot.speaker}` : ""}{it.snapshot.group ? ` · ${it.snapshot.group}` : ""}{it.snapshot.start != null ? ` · ${formatTimestamp(it.snapshot.start)}–${formatTimestamp(it.snapshot.end)}` : ""}</span>
                {r.states[it.excerptId] !== "current" && <span className="badge warning">{r.states[it.excerptId] === "removed" ? "excerpt removed since" : "excerpt changed since"}</span>}
                {it.note && <div className="ql-muted">Note: {it.note}</div>}
                <span className="ql-row">
                  {ws.can.code && <><button type="button" className="btn ghost small" disabled={i === 0} data-testid="hl-up" onClick={() => run("Moving", () => api.reelOp(r, { op: "move", excerptId: it.excerptId, to: i - 1 }), setReels)}>↑</button>
                    <button type="button" className="btn ghost small" disabled={i === r.items.length - 1} onClick={() => run("Moving", () => api.reelOp(r, { op: "move", excerptId: it.excerptId, to: i + 1 }), setReels)}>↓</button>
                    <button type="button" className="btn ghost small" onClick={() => { const n = window.prompt("Note", it.note ?? ""); if (n !== null) void run("Saving", () => api.reelOp(r, { op: "note", excerptId: it.excerptId, note: n }), setReels); }}>Note</button>
                    <button type="button" className="btn ghost small" onClick={() => run("Removing", () => api.reelOp(r, { op: "remove", excerptId: it.excerptId }), setReels)}>Remove</button></>}
                  {data.can.playback && ws.can.playback && it.snapshot.start != null && <button type="button" className="btn small" data-testid="hl-play" onClick={() => run("Opening the clip", () => api.clip(it.excerptId), (c) => setPlayer({ ...c, id: it.excerptId }))}>Play clip</button>}
                </span>
              </li>
            ))}
          </ol>
          {ws.can.code && picked.length > 0 && <button type="button" className="btn small" data-testid="hl-add" onClick={() => run("Adding", () => api.reelOp(r, { op: "add", excerptIds: picked }), (x) => { setReels(x); setPicked([]); })}>Add the {picked.length} ticked excerpt(s)</button>}
        </div>
      ))}
      <p className="ql-muted">{CLIP_NOTE}</p>
    </div>
  );
}

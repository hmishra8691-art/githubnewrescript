"use client";
import React from "react";
import { SurveyDefinition } from "@rescript/schema";
import { useStudio } from "../store";
import { diffStats, itemAuditEntries, itemCode, lineDiff, type AuditEntryLike } from "@/lib/scripts/history.ts";

/**
 * S3b item 5 (audit MM-09) — "History" in a script editor's header: the S1c audit entries for THIS item, and a line
 * diff of this item's code between any two versions — the survey's saved versions (Versions panel), this session's
 * edits (the Studio's undo history) and what is in the editor now (unsaved). Code lines, not definition JSON.
 */
type Source = { id: string; label: string; load(): Promise<string | null> };

export function ScriptHistoryPanel({ itemKey, current, onClose }: { itemKey: string; current: string; onClose(): void }) {
  const s = useStudio();
  const [entries, setEntries] = React.useState<AuditEntryLike[] | null>(null);
  const [saved, setSaved] = React.useState<{ id: string; version: string; label: string | null; created_at: string }[]>([]);
  React.useEffect(() => {
    let live = true;
    fetch(`/api/surveys/${s.surveyDbId}/script-audit`, { cache: "no-store" }).then((r) => (r.ok ? r.json() : null))
      .then((d) => { if (live) setEntries(Array.isArray(d?.entries) ? itemAuditEntries(d.entries as AuditEntryLike[], itemKey) : []); }).catch(() => { if (live) setEntries([]); });
    fetch(`/api/surveys/${s.surveyDbId}/versions`, { cache: "no-store" }).then((r) => (r.ok ? r.json() : null))
      .then((d) => { if (live && Array.isArray(d?.versions)) setSaved(d.versions); }).catch(() => {});
    return () => { live = false; };
  }, [s.surveyDbId, itemKey]);

  /* the versions this item can be compared at — oldest first; consecutive identical codes of the session collapse */
  const sources: Source[] = React.useMemo(() => {
    const out: Source[] = [];
    for (const v of [...saved].reverse()) out.push({
      id: `v:${v.id}`, label: `saved v${v.version}${v.label ? ` “${v.label}”` : ""} (${new Date(v.created_at).toLocaleString()})`,
      load: () => fetch(`/api/surveys/${s.surveyDbId}/versions/${v.id}`).then((r) => r.json()).then((d) => { const p = SurveyDefinition.safeParse(d?.version?.definition); return p.success ? itemCode(p.data, itemKey) : null; }).catch(() => null),
    });
    let prev: string | null | undefined;
    s.editHistory.forEach((h, i) => {
      const code = itemCode(h.def, itemKey);
      if (code === prev) return;
      prev = code;
      out.push({ id: `h:${i}`, label: `this session — before “${h.label}”${code == null ? " (not there)" : ""}`, load: async () => code });
    });
    const now = itemCode(s.def, itemKey);
    out.push({ id: "saved", label: "now (stored)", load: async () => now });
    if (current !== now) out.push({ id: "editor", label: "now (this editor, not saved)", load: async () => current });
    return out;
  }, [saved, s.editHistory, s.def, itemKey, current, s.surveyDbId]);

  const [a, setA] = React.useState<string>("");
  const [b, setB] = React.useState<string>("");
  const [codes, setCodes] = React.useState<{ a: string | null; b: string | null } | null>(null);
  /* default: the last different version against now */
  React.useEffect(() => {
    if (!sources.length) return;
    setB((x) => (sources.some((y) => y.id === x) ? x : sources[sources.length - 1]!.id));
    setA((x) => (sources.some((y) => y.id === x) ? x : sources[Math.max(0, sources.length - 2)]!.id));
  }, [sources]);
  React.useEffect(() => {
    let live = true;
    const sa = sources.find((x) => x.id === a), sb = sources.find((x) => x.id === b);
    if (!sa || !sb) return;
    void Promise.all([sa.load(), sb.load()]).then(([ca, cb]) => { if (live) setCodes({ a: ca, b: cb }); });
    return () => { live = false; };
  }, [a, b, sources]);
  const diff = codes ? lineDiff(codes.a, codes.b) : null;
  const st = diff ? diffStats(diff) : null;
  return (
    <div className="code-history" data-testid="code-history" data-item={itemKey}>
      <div className="row" style={{ gap: 6 }}><b>History of this item</b><span className="grow" /><button type="button" className="btn sm ghost" onClick={onClose}>Close</button></div>
      <div style={{ margin: "4px 0" }}>
        <b style={{ fontSize: 11.5 }}>Audit log</b>
        {entries == null ? <p className="muted" style={{ margin: 2 }}>loading…</p> : entries.length === 0 ? <p className="muted" style={{ margin: 2 }} data-testid="code-history-noaudit">No audit entries for it yet (an entry is written when a save changes its code or switches it on / off).</p> : (
          <ul style={{ margin: "2px 0 0 16px" }} data-testid="code-history-audit">{entries.slice(0, 20).map((e, i) => <li key={i}>{new Date(e.at).toLocaleString()} — {e.text}</li>)}</ul>
        )}
      </div>
      <div className="row" style={{ gap: 6, flexWrap: "wrap", alignItems: "center" }}>
        <b style={{ fontSize: 11.5 }}>Compare</b>
        <select className="select" value={a} onChange={(e) => setA(e.target.value)} aria-label="From version" data-testid="code-history-a">{sources.map((x) => <option key={x.id} value={x.id}>{x.label}</option>)}</select>
        <span>→</span>
        <select className="select" value={b} onChange={(e) => setB(e.target.value)} aria-label="To version" data-testid="code-history-b">{sources.map((x) => <option key={x.id} value={x.id}>{x.label}</option>)}</select>
        {st && <span className="muted" data-testid="code-history-stats">+{st.added} −{st.removed}</span>}
      </div>
      {diff && (diff.length === 0 ? <p className="muted">Empty in both.</p> : st && !st.added && !st.removed ? <p className="muted" data-testid="code-history-same">The code is the same in both.</p> : (
        <div className="code-diff" data-testid="code-history-diff">
          {diff.map((d, i) => <div key={i} className={d.op === "same" ? undefined : d.op} data-op={d.op}><span className="muted">{String(d.a ?? "").padStart(3)} {String(d.b ?? "").padStart(3)} {d.op === "add" ? "+" : d.op === "del" ? "−" : " "}</span> {d.text}</div>)}
        </div>
      ))}
      {saved.length === 0 && <p className="muted" style={{ fontSize: 11 }}>No saved versions to compare here{s.surveyDbId === "sandbox" ? " (the sandbox keeps no versions)" : ""} — this session&apos;s edits and the editor are listed.</p>}
    </div>
  );
}

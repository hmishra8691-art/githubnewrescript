"use client";
import React from "react";
import { useStudio } from "./store";

/**
 * MESSAGES WITH RESPONDENTS (phase 6, 2026-11-20) — inside the Respondent portal section. The conversations of this
 * survey, unread first; one opens to read and reply. A reply tells the respondent there is a message; the notice
 * itself never carries the text. Shown only to members who may see contact details, and only when there is one.
 */
interface Thread { respondent: { id: string; name: string | null; email: string | null }; last: { body: string; at: string; fromStaff: boolean }; unread: number; count: number }
interface Msg { id: string; fromStaff: boolean; body: string; at: string }
const when = (iso: string) => new Date(iso).toLocaleString(undefined, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });

export function PortalMessagesPanel() {
  const s = useStudio();
  const [threads, setThreads] = React.useState<Thread[] | null>(null);
  const [open, setOpen] = React.useState<string | null>(null);
  const [msgs, setMsgs] = React.useState<Msg[]>([]);
  const [text, setText] = React.useState("");
  const [error, setError] = React.useState<string | null>(null);
  const [busy, setBusy] = React.useState(false);
  const base = `/api/surveys/${s.surveyDbId}/portal/messages`;
  const load = React.useCallback(async () => {
    if (!s.surveyDbId) return;
    const r = await fetch(base, { cache: "no-store" });
    if (!r.ok) { setThreads(null); return; }
    const j = await r.json();
    setThreads(j.available ? j.threads : null);
  }, [s.surveyDbId, base]);
  React.useEffect(() => { void load(); }, [load]);
  const show = async (id: string) => {
    setOpen(id); setError(null); setText("");
    const r = await fetch(`${base}?respondent=${encodeURIComponent(id)}`, { cache: "no-store" });
    const j = await r.json().catch(() => ({}));
    if (r.ok) { setMsgs(j.messages ?? []); void load(); } else setError(j.error ?? "Could not open the conversation.");
  };
  const send = async () => {
    if (!open) return;
    setBusy(true); setError(null);
    const r = await fetch(base, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ enrolmentId: open, text }) });
    const j = await r.json().catch(() => ({}));
    setBusy(false);
    if (!r.ok) { setError(j.error ?? `That did not work (${r.status}).`); return; }
    await show(open);
  };
  if (!threads || !threads.length) return null;
  const unread = threads.reduce((n, t) => n + t.unread, 0);
  return (
    <div style={{ marginTop: 18, paddingTop: 14, borderTop: "1px solid var(--c-border, #e5e7eb)" }} data-testid="portal-messages">
      <div className="row" style={{ gap: 10, flexWrap: "wrap" }}>
        <strong style={{ fontSize: 13.5 }}>Messages from respondents</strong>
        {unread > 0 ? <span className="chip warn">{unread} unread</span> : <span className="chip on">All read</span>}
      </div>
      {threads.map((t) => (
        <div key={t.respondent.id} className="card" style={{ padding: 10, marginTop: 8, fontSize: 12.5 }}>
          <div className="row" style={{ gap: 8, flexWrap: "wrap" }}>
            <strong>{t.respondent.name ?? t.respondent.email ?? "A respondent no longer on the list"}</strong>
            {t.unread > 0 && <span className="chip warn">{t.unread} new</span>}
            <span className="muted">{t.count} message{t.count === 1 ? "" : "s"} · {when(t.last.at)}</span>
            <span className="grow" />
            <button type="button" className="btn small" onClick={() => (open === t.respondent.id ? setOpen(null) : void show(t.respondent.id))}>{open === t.respondent.id ? "Close" : "Open"}</button>
          </div>
          {open !== t.respondent.id && <p className="muted" style={{ margin: "6px 0 0" }}>{t.last.fromStaff ? "You: " : ""}{t.last.body}</p>}
          {open === t.respondent.id && (
            <div style={{ marginTop: 8 }}>
              {msgs.map((m) => (<p key={m.id} style={{ margin: "4px 0", padding: "6px 10px", borderRadius: 8, background: m.fromStaff ? "var(--c-surface-2, #eef2ff)" : "var(--c-surface-1, #f3f4f6)", whiteSpace: "pre-wrap" }}><span className="muted">{m.fromStaff ? "Your team" : "Respondent"} · {when(m.at)}</span><br />{m.body}</p>))}
              {error && <div className="chip warn qd-note" style={{ marginTop: 6 }}>{error}</div>}
              <div className="row" style={{ gap: 6, marginTop: 6, alignItems: "flex-end" }}>
                <textarea className="input grow" rows={2} maxLength={4000} value={text} onChange={(e) => setText(e.target.value)} placeholder="Your reply" aria-label="Reply" />
                <button type="button" className="btn small" disabled={busy || !text.trim()} onClick={send}>Send reply</button>
              </div>
              <p className="muted" style={{ margin: "6px 0 0" }}>The respondent is told they have a message. The notification and email never contain its text.</p>
            </div>
          )}
        </div>
      ))}
    </div>
  );
}

"use client";
import React from "react";
import { api } from "@/lib/useSession";

/**
 * SUPPORT — Help escalations and Help usage (2026-11-10, /api/admin/support, migration 0095).
 *
 * The tickets people sent from the Help assistant, each with the conversation, the steps already tried (and which
 * level tried them), what the survey checks found and where the user was — so nobody asks them to explain it again.
 * Above them, what the Help router did over the period: how many answers needed no model at all, how many the cache
 * saved, what the model answers were charged, and how often people said an answer solved it.
 *
 * Platform administrators only, like the route.
 */
interface Ticket {
  id: string; reference: string; user_email: string | null; survey_id: string | null; subject: string; reason: string | null; message: string | null;
  transcript: { role: string; text: string; level?: number; sources?: string[] }[];
  diagnostics: { summary?: string; findings?: { severity: string; message: string }[] } | null;
  attempts: { level: number; reason: string; sources: string[]; modelUsed: boolean }[];
  context: Record<string, unknown> | null; status: string; resolution: string | null; emailed: boolean; created_at: string;
}
interface Usage {
  answers: number; byLevel: { 1: number; 2: number; 3: number; unrouted: number }; modelCalls: number; cacheHits: number; internalShare: number;
  charge: number; escalationsOffered: number; solved: { yes: number; no: number }; diagnosed: number;
}
const LEVEL = ["", "Guides", "Survey check", "AI"];
const when = (iso: string) => new Date(iso).toLocaleString([], { dateStyle: "medium", timeStyle: "short" });

export function SupportPanel() {
  const [status, setStatus] = React.useState("open");
  const [days, setDays] = React.useState(30);
  const [data, setData] = React.useState<{ tickets: Ticket[]; ticketsNote: string | null; usage: Usage; usageNote: string | null; cache: { size: number; hits: number; misses: number } } | null>(null);
  const [error, setError] = React.useState<string | null>(null);
  const [open, setOpen] = React.useState<string | null>(null);
  const [resolution, setResolution] = React.useState("");
  const [busy, setBusy] = React.useState(false);

  const load = React.useCallback(async () => {
    const r = await api(`/api/admin/support?status=${status}&days=${days}`);
    if (!r.ok) { setError(r.error); setData(null); return; }
    setError(null); setData(r.data);
  }, [status, days]);
  React.useEffect(() => { void load(); }, [load]);

  const update = async (id: string, patch: { status?: string; resolution?: string }) => {
    setBusy(true);
    try {
      const r = await api("/api/admin/support", { method: "PATCH", json: { id, ...patch } });
      if (!r.ok) { setError(r.error); return; }
      await load();
    } finally { setBusy(false); }
  };

  const u = data?.usage;
  return (
    <div data-testid="support-panel">
      <p className="muted" style={{ fontSize: 14, lineHeight: 1.55, maxWidth: 760 }}>
        What the Help assistant could not resolve, handed over by the people who asked — with the conversation, the steps
        already tried and what the checks of their survey found. Above: how Help answered over the period, and what it cost.
      </p>
      {error && <div className="auth-note err">{error}</div>}

      <div className="row" style={{ gap: 10, margin: "6px 0 10px", flexWrap: "wrap" }}>
        <strong className="grow">Help usage</strong>
        <label className="muted" style={{ fontSize: 13 }}>Period{" "}
          <select value={days} onChange={(e) => setDays(Number(e.target.value))} data-testid="support-days">
            {[7, 30, 90].map((d) => <option key={d} value={d}>last {d} days</option>)}
          </select>
        </label>
        <button className="btn small" onClick={() => void load()} disabled={busy}>Refresh</button>
      </div>
      {data?.usageNote && <div className="auth-note">{data.usageNote}</div>}
      {u && (
        <div className="row" style={{ gap: 18, flexWrap: "wrap", marginBottom: 16 }} data-testid="support-usage">
          <Stat label="Answers" value={String(u.answers)} />
          <Stat label="Guides (level 1)" value={String(u.byLevel[1])} />
          <Stat label="Survey checks (level 2)" value={String(u.byLevel[2])} />
          <Stat label="AI (level 3)" value={String(u.byLevel[3])} />
          {u.byLevel.unrouted > 0 && <Stat label="Before routing" value={String(u.byLevel.unrouted)} />}
          <Stat label="No model call" value={`${u.internalShare}%`} />
          <Stat label="Model calls" value={String(u.modelCalls)} />
          <Stat label="Cache hits" value={String(u.cacheHits)} />
          <Stat label="AI charge" value={u.charge.toFixed(4)} />
          <Stat label="Solved / not" value={`${u.solved.yes} / ${u.solved.no}`} />
          <Stat label="Escalation offered" value={String(u.escalationsOffered)} />
        </div>
      )}

      <div className="row" style={{ gap: 10, margin: "6px 0 8px" }}>
        <strong className="grow">Tickets</strong>
        <select value={status} onChange={(e) => setStatus(e.target.value)} data-testid="support-status">
          {["open", "in_progress", "resolved", "closed", "all"].map((s) => <option key={s} value={s}>{s.replace("_", " ")}</option>)}
        </select>
      </div>
      {data?.ticketsNote && <div className="auth-note">{data.ticketsNote}</div>}
      <div className="table-wrap">
        <table className="grid" data-testid="support-tickets">
          <thead><tr><th>Reference</th><th>Subject</th><th>From</th><th>Why</th><th>Status</th><th>Sent</th><th /></tr></thead>
          <tbody>
            {!data && !error && <tr><td colSpan={7} className="muted">Loading…</td></tr>}
            {data && data.tickets.length === 0 && <tr><td colSpan={7} className="muted">No {status === "all" ? "" : `${status.replace("_", " ")} `}tickets.</td></tr>}
            {(data?.tickets ?? []).map((t) => (
              <React.Fragment key={t.id}>
                <tr data-testid="support-ticket" className={open === t.id ? "on" : undefined}>
                  <td className="mono">{t.reference}</td>
                  <td style={{ whiteSpace: "normal" }}>{t.subject}</td>
                  <td>{t.user_email ?? "—"}{t.survey_id && <> · <a href={`/studio/${t.survey_id}`}>project</a></>}</td>
                  <td className="muted" style={{ whiteSpace: "normal" }}>{t.reason ?? "—"}</td>
                  <td><span className="chip">{t.status.replace("_", " ")}</span>{t.emailed && <span className="muted"> · e-mailed</span>}</td>
                  <td className="muted" style={{ whiteSpace: "nowrap" }}>{when(t.created_at)}</td>
                  <td><button className="btn small" onClick={() => { setOpen(open === t.id ? null : t.id); setResolution(t.resolution ?? ""); }}>{open === t.id ? "Close" : "Open"}</button></td>
                </tr>
                {open === t.id && (
                  <tr><td colSpan={7}>
                    <div className="card" style={{ padding: 14 }} data-testid="support-ticket-detail">
                      {t.message && <p><b>Their note:</b> {t.message}</p>}
                      {t.diagnostics && (
                        <div style={{ marginBottom: 10 }}>
                          <b>Survey check:</b> {t.diagnostics.summary}
                          <ul>{(t.diagnostics.findings ?? []).map((f, i) => <li key={i}>[{f.severity}] {f.message}</li>)}</ul>
                        </div>
                      )}
                      {t.attempts.length > 0 && (
                        <div style={{ marginBottom: 10 }}>
                          <b>Tried so far:</b>
                          <ol>{t.attempts.map((a, i) => <li key={i}>{LEVEL[a.level] ?? a.level}: {a.reason}{a.sources.length ? <span className="muted"> — {a.sources.join("; ")}</span> : null}</li>)}</ol>
                        </div>
                      )}
                      {t.context && <p className="muted" style={{ fontSize: 12 }}><b>Where they were:</b> <span className="mono">{JSON.stringify(t.context)}</span></p>}
                      <details>
                        <summary style={{ cursor: "pointer" }}>Conversation ({t.transcript.length} messages)</summary>
                        <div style={{ maxHeight: 360, overflow: "auto", marginTop: 6 }}>
                          {t.transcript.map((m, i) => (
                            <div key={i} style={{ margin: "6px 0", whiteSpace: "pre-wrap", fontSize: 13 }}>
                              <b>{m.role === "user" ? "User" : `Help${m.level ? ` (${LEVEL[m.level]})` : ""}`}:</b> {m.text}
                            </div>
                          ))}
                        </div>
                      </details>
                      <label style={{ display: "block", marginTop: 10 }}>
                        <span className="muted" style={{ fontSize: 12 }}>Resolution note (administrators only)</span>
                        <textarea value={resolution} onChange={(e) => setResolution(e.target.value)} rows={3} style={{ width: "100%" }} data-testid="support-resolution" />
                      </label>
                      <div className="row" style={{ gap: 8, marginTop: 8 }}>
                        <button className="btn small" disabled={busy} onClick={() => void update(t.id, { resolution })}>Save note</button>
                        {t.status !== "in_progress" && <button className="btn small" disabled={busy} onClick={() => void update(t.id, { status: "in_progress" })}>Mark in progress</button>}
                        {t.status !== "resolved" && <button className="btn small primary" disabled={busy} onClick={() => void update(t.id, { status: "resolved", resolution })}>Resolve</button>}
                        {t.status !== "closed" && <button className="btn small ghost" disabled={busy} onClick={() => void update(t.id, { status: "closed" })}>Close</button>}
                      </div>
                    </div>
                  </td></tr>
                )}
              </React.Fragment>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return <div><div className="muted" style={{ fontSize: 12 }}>{label}</div><div className="mono"><b>{value}</b></div></div>;
}

"use client";
import React from "react";
import { portalApi, when } from "./api";
import { Note } from "./Shell";

/**
 * MESSAGES WITH THE ORGANISER OF ONE ASSESSMENT (phase 6, 2026-11-20). Shown where the researcher allows writing,
 * or where there are replies to read. The server decides both; opening the conversation marks replies as read.
 */
interface Thread { canWrite: boolean; organiser: string; messages: { id: string; mine: boolean; body: string; at: string }[] }

export function Messages({ assessmentId }: { assessmentId: string }) {
  const [t, setT] = React.useState<Thread | null>(null);
  const [text, setText] = React.useState("");
  const [busy, setBusy] = React.useState(false);
  const [note, setNote] = React.useState<{ kind: "ok" | "bad"; text: string } | null>(null);
  const load = React.useCallback(async () => { const r = await portalApi<Thread>(`assessments/${assessmentId}?part=messages`); if (r.ok) setT(r.data); }, [assessmentId]);
  React.useEffect(() => { void load(); }, [load]);
  if (!t || (!t.canWrite && !t.messages.length)) return null;
  const send = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true); setNote(null);
    const r = await portalApi(`assessments/${assessmentId}`, { action: "message", text });
    setBusy(false);
    if (!r.ok) { setNote({ kind: "bad", text: r.error.error }); return; }
    setText(""); setNote({ kind: "ok", text: "Your message has been sent." }); await load();
  };
  return (
    <section className="pt-noprint" data-testid="pt-messages">
      <h2>Messages with {t.organiser}</h2>
      <div className="pt-card">
        {t.messages.length === 0 ? <p className="pt-why" style={{ marginTop: 0 }}>No messages yet.</p> : (
          <ol className="pt-thread">{t.messages.map((m) => (<li key={m.id} className={m.mine ? "is-mine" : "is-theirs"}><span className="pt-why">{m.mine ? "You" : t.organiser.charAt(0).toUpperCase() + t.organiser.slice(1)} · {when(m.at, true)}</span><p>{m.body}</p></li>))}</ol>
        )}
        {note && <Note kind={note.kind}>{note.text}</Note>}
        {t.canWrite ? (
          <form onSubmit={send}>
            <div className="pt-field"><label htmlFor="pt-msg">Write a message</label>
              <textarea id="pt-msg" className="pt-input" maxLength={4000} value={text} onChange={(e) => setText(e.target.value)} data-testid="pt-msg-text" />
              <span className="pt-hint">Do not use this for anything urgent. It is read during working hours and is not monitored for emergencies.</span></div>
            <button type="submit" className="pt-btn is-primary" disabled={busy || !text.trim()} data-testid="pt-msg-send">Send</button>
          </form>
        ) : <p className="pt-why">New messages cannot be sent for this assessment.</p>}
      </div>
    </section>
  );
}

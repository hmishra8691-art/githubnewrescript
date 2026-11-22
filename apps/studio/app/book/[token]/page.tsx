"use client";
import React from "react";

/**
 * /book/<token> — AN INTERVIEW INVITEE PICKS A TIME (Level 5 roadmap Q6). No account: the token is the credential,
 * checked by /api/book/[token]. Times are shown in the invitee's own time zone (the browser's), which the server
 * cannot know. Shows the study title, the invitee's booking and the open times — nothing about anyone else.
 */
interface State { study: string; name: string | null; status: string; booking: { slotId: string; startsAt: string; endsAt: string; withdrawn?: boolean } | null; slots: { id: string; startsAt: string; endsAt: string }[] }

const day = (iso: string) => new Date(iso).toLocaleDateString(undefined, { weekday: "long", day: "numeric", month: "long" });
const time = (iso: string) => new Date(iso).toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });
const zone = () => { try { return Intl.DateTimeFormat().resolvedOptions().timeZone; } catch { return "your local time"; } };

export default function BookPage({ params }: { params: { token: string } }) {
  const [s, setS] = React.useState<State | null>(null);
  const [error, setError] = React.useState<string | null>(null);
  const [note, setNote] = React.useState<string | null>(null);
  const [busy, setBusy] = React.useState(false);

  const load = React.useCallback(async () => {
    try {
      const r = await fetch(`/api/book/${params.token}`, { cache: "no-store" });
      const j = await r.json();
      if (!r.ok) { setError(j.error ?? "This invitation could not be opened."); setS(null); return; }
      setError(null); setS(j as State);
    } catch { setError("This invitation could not be opened. Please try again."); }
  }, [params.token]);
  React.useEffect(() => { void load(); }, [load]);

  const act = async (body: Record<string, unknown>, done: string) => {
    setBusy(true); setNote(null);
    try {
      const r = await fetch(`/api/book/${params.token}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
      const j = await r.json();
      if (!r.ok) setNote(j.error ?? "That did not work; please try again.");
      else setNote(done || null);
      await load();
    } finally { setBusy(false); }
  };

  const groups = new Map<string, State["slots"]>();
  for (const sl of s?.slots ?? []) { const k = day(sl.startsAt); groups.set(k, [...(groups.get(k) ?? []), sl]); }

  return (
    <div className="auth-shell">
      <div className="auth-card" data-testid="book-page" style={{ maxWidth: 520 }}>
        <div className="auth-brand">INTERVIEW BOOKING</div>
        {error && <div className="auth-note err" data-testid="book-error">{error}</div>}
        {!s && !error && <p className="auth-sub">Loading…</p>}
        {s && (
          <>
            <h1 className="auth-title">{s.name ? `Hello ${s.name}` : "Pick a time"}</h1>
            <p className="auth-sub">A conversation about {s.study}. Times are shown in {zone()}.</p>
            {note && <div className="auth-note ok" data-testid="book-note">{note}</div>}
            {s.status === "attended" || s.status === "no_show" ? (
              <p className="auth-sub">This session has already taken place. Thank you.</p>
            ) : (
              <>
                {s.booking && (
                  <div className="auth-note ok" data-testid="book-current" style={{ marginBottom: 12 }}>
                    Booked: {day(s.booking.startsAt)}, {time(s.booking.startsAt)}–{time(s.booking.endsAt)}
                    {s.booking.withdrawn && <div style={{ marginTop: 6 }}>The research team has withdrawn this time; please pick another below.</div>}
                    <div style={{ marginTop: 8 }}><button className="btn" disabled={busy} onClick={() => void act({ action: "cancel" }, "Your time is cancelled.")} data-testid="book-cancel">Cancel this time</button></div>
                  </div>
                )}
                {(s.status === "cancelled" || s.status === "late_cancel") && !s.booking && <p className="auth-sub">You cancelled your time. You can pick a new one below.</p>}
                {groups.size === 0 ? <p className="auth-sub">There are no open times right now. The research team may add more; this link will show them.</p> : (
                  <div data-testid="book-slots">
                    <p className="auth-sub" style={{ marginBottom: 6 }}>{s.booking ? "Or move to another time:" : "Open times:"}</p>
                    {[...groups].map(([d, list]) => (
                      <div key={d} style={{ marginBottom: 10 }}>
                        <div style={{ fontWeight: 600, marginBottom: 4 }}>{d}</div>
                        <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
                          {list.map((sl) => <button key={sl.id} className="btn" disabled={busy || s.booking?.slotId === sl.id} onClick={() => void act({ action: "book", slotId: sl.id }, "")}>{time(sl.startsAt)}</button>)}
                        </div>
                      </div>
                    ))}
                  </div>
                )}
              </>
            )}
          </>
        )}
      </div>
    </div>
  );
}

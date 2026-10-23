"use client";
import React from "react";

/**
 * THE ALERT BELL (2026-10-22, G3) — my in-app alerts (distress flags, quotas, the cost cap …) with an unread count.
 * Polls every 20 seconds while the page is visible; opening the list marks what is shown as read. Each alert links
 * to where it happened (an AI interview's live view, the study's alerts). The sandbox has its own single person.
 */
interface Alert { id: string; title: string; text: string; link: string | null; severity: string; createdAt: string; read: boolean }

export function AlertBell() {
  const [alerts, setAlerts] = React.useState<Alert[]>([]);
  const [unread, setUnread] = React.useState(0);
  const [open, setOpen] = React.useState(false);
  const [off, setOff] = React.useState(false);
  const load = React.useCallback(async () => {
    try {
      const r = await fetch("/api/notify/inbox", { cache: "no-store" });
      if (r.status === 401 || r.status === 403 || r.status === 409) { setOff(true); return; }
      const b = await r.json();
      if (b?.ok) { setAlerts(b.alerts ?? []); setUnread(b.unread ?? 0); setOff(false); }
    } catch { /* offline: keep what we have */ }
  }, []);
  React.useEffect(() => {
    void load();
    const t = setInterval(() => { if (document.visibilityState === "visible") void load(); }, 20_000);
    return () => clearInterval(t);
  }, [load]);
  /* Escape closes the list (keyboard users) */
  React.useEffect(() => {
    if (!open) return;
    const k = (e: KeyboardEvent) => { if (e.key === "Escape") setOpen(false); };
    window.addEventListener("keydown", k);
    return () => window.removeEventListener("keydown", k);
  }, [open]);
  if (off) return null;
  const toggle = async () => {
    const next = !open;
    setOpen(next);
    if (next) { await load(); if (unread) { await fetch("/api/notify/inbox", { method: "POST", headers: { "content-type": "application/json" }, body: "{}" }).catch(() => null); setUnread(0); } }
  };
  return (
    <span className="menu-anchor" data-testid="bell">
      <button type="button" className="btn small" aria-haspopup="dialog" aria-expanded={open} onClick={toggle} title="Alerts" data-testid="bell-button">
        🔔{unread > 0 && <span className="badge error" data-testid="bell-count" style={{ marginLeft: 4 }}>{unread}</span>}
      </button>
      {open && (
        <>
          <div className="menu-scrim" onClick={() => setOpen(false)} />
          <div className="menu" role="dialog" aria-label="Alerts" style={{ width: 380, maxHeight: 420, overflow: "auto", right: 0 }} data-testid="bell-list">
            {!alerts.length && <div className="menu-item ql-muted">No alerts.</div>}
            {alerts.map((a) => (
              <a key={a.id} className="menu-item" href={a.link ?? "#"} data-testid="bell-item" data-severity={a.severity} data-read={a.read ? "1" : "0"} style={{ display: "block", whiteSpace: "normal" }}>
                <b style={{ color: a.severity === "critical" ? "var(--red, #b42318)" : undefined }}>{a.title}</b>
                <div style={{ fontSize: 12 }}>{a.text}</div>
                <div className="ql-muted" style={{ fontSize: 11 }}>{new Date(a.createdAt).toLocaleString()}</div>
              </a>
            ))}
          </div>
        </>
      )}
    </span>
  );
}

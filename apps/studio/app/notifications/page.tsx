"use client";
import React from "react";
import { AccountHeader } from "@/components/AccountHeader";
import { api, useSession } from "@/lib/useSession";

/**
 * NOTIFICATIONS (§39) — the list behind the header's "N new" badge.
 *
 * Platform audit 2026-11-05, finding 3: /api/notifications existed, the header counted its unread rows and
 * linked to /profile, and /profile never mentioned notifications. 160 notifications sat unread with no screen
 * able to show or clear them; the badge read a number that could only grow. This is the screen. The sentence for
 * each row is the one `describeEvent` writes for the project activity log, so a shared project or a released
 * lock reads the same in both places; an alert (lib/notify) carries its own words and also appears in the
 * header's bell.
 *
 * Opening the page marks nothing. "Mark all as read" does, and so does marking one row — a count that clears
 * itself on a visit the reader did not finish is a count nobody trusts.
 */

interface Row {
  id: string;
  surveyId: string | null;
  project: string | null;
  action: string;
  text: string;
  createdAt: string;
  read: boolean;
}

function when(iso: string): string {
  const ms = Date.parse(iso);
  if (Number.isNaN(ms)) return "—";
  const d = new Date(ms);
  const sameDay = new Date().toDateString() === d.toDateString();
  return sameDay ? d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }) : d.toLocaleString([], { dateStyle: "medium", timeStyle: "short" });
}

/** where a notification leads: the project it is about, or nowhere */
function linkFor(n: Row): string | null {
  return n.surveyId ? `/studio/${n.surveyId}` : null;
}

export default function NotificationsPage() {
  const { state, signOut, reload } = useSession({ redirectOnSignOut: true });
  const [rows, setRows] = React.useState<Row[] | null>(null);
  const [unread, setUnread] = React.useState(0);
  const [error, setError] = React.useState<string | null>(null);
  const [busy, setBusy] = React.useState(false);
  const [filter, setFilter] = React.useState<"all" | "unread">("all");

  const load = React.useCallback(async () => {
    const r = await api<{ notifications: Row[]; unread: number }>("/api/notifications");
    if (!r.ok) {
      if (r.status !== 401 && r.status !== 403) setError(r.error);
      return;
    }
    setError(null);
    setRows(r.data.notifications);
    setUnread(r.data.unread);
  }, []);

  React.useEffect(() => { void load(); }, [load]);
  React.useEffect(() => {
    const id = setInterval(() => { if (document.visibilityState === "visible") void load(); }, 30_000);
    return () => clearInterval(id);
  }, [load]);

  const markRead = async (ids?: string[]) => {
    setBusy(true);
    try {
      const r = await api<{ ok: true }>("/api/notifications", { method: "POST", json: ids ? { ids } : {} });
      if (!r.ok) { setError(r.error); return; }
      await load();
      /* the header badge reads /api/auth/me — refresh it so the count it shows is the count that is left */
      await reload();
    } finally {
      setBusy(false);
    }
  };

  const user = state.kind === "signed_in" ? state.user : null;
  const shown = (rows ?? []).filter((n) => filter === "all" || !n.read);

  return (
    <div className="acct-shell">
      <AccountHeader active="notifications" user={user} onSignOut={signOut} />

      <p className="muted" style={{ fontSize: 14, lineHeight: 1.55, maxWidth: 720 }}>
        What happened on your projects while you were elsewhere — a project shared with you, a lock released, an
        invitation accepted, an alert from the field. The fifty most recent are kept here; alerts also appear in
        the bell at the top of every page.
      </p>

      {error && <div className="auth-note err">{error}</div>}

      <div className="row" style={{ margin: "6px 0 10px", gap: 8 }}>
        <strong className="grow" data-testid="notifications-count">
          {rows === null ? "Loading…" : unread ? `${unread} unread` : "Nothing unread"}
        </strong>
        <div className="seg" role="tablist" aria-label="Show">
          <button type="button" role="tab" aria-selected={filter === "all"} className={`btn small ${filter === "all" ? "primary" : ""}`} onClick={() => setFilter("all")}>All</button>
          <button type="button" role="tab" aria-selected={filter === "unread"} className={`btn small ${filter === "unread" ? "primary" : ""}`} onClick={() => setFilter("unread")}>Unread</button>
        </div>
        <button className="btn small" onClick={() => void load()} disabled={busy}>Refresh</button>
        <button className="btn small" data-testid="notifications-read-all" onClick={() => void markRead()} disabled={busy || !unread}>Mark all as read</button>
      </div>

      {rows && (
        <div className="table-wrap">
          <table className="grid" data-testid="notifications-list">
            <thead>
              <tr>
                <th style={{ width: 150 }}>When</th>
                <th>What</th>
                <th>Project</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {shown.length === 0 && (
                <tr><td colSpan={4} className="muted">{filter === "unread" ? "Nothing unread." : "No notifications yet."}</td></tr>
              )}
              {shown.map((n) => {
                const link = linkFor(n);
                return (
                  <tr key={n.id} data-testid="notification-row" data-read={n.read ? "1" : "0"} style={{ fontWeight: n.read ? undefined : 600 }}>
                    <td className="muted" style={{ whiteSpace: "nowrap", fontWeight: 400 }}>{when(n.createdAt)}</td>
                    <td style={{ whiteSpace: "normal" }}>
                      {!n.read && <span className="dot" aria-label="unread" style={{ display: "inline-block", width: 8, height: 8, borderRadius: 4, background: "var(--accent, #2563eb)", marginRight: 8, verticalAlign: "middle" }} />}
                      {n.text}
                    </td>
                    <td style={{ whiteSpace: "normal", fontWeight: 400 }}>
                      {link ? <a href={link}>{n.project ?? "Open project"}</a> : <span className="muted">—</span>}
                    </td>
                    <td style={{ whiteSpace: "nowrap" }}>
                      {!n.read && <button className="btn small" onClick={() => void markRead([n.id])} disabled={busy}>Mark read</button>}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

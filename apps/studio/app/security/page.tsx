"use client";
import React from "react";
import { AccountHeader } from "@/components/AccountHeader";
import { api, useSession } from "@/lib/useSession";

/**
 * SIGN-IN & SESSIONS (§8).
 *
 * This screen exists because of the single-session rule. Someone whose laptop
 * died is told "already signed in elsewhere" at the login screen and has no
 * way to see what that means; here they can see the session, see that it has
 * gone quiet, and release it themselves. The one sentence at the top is doing
 * most of the work — the point is that nobody is ever permanently locked out,
 * and the timeout that guarantees it is stated in minutes rather than left as
 * a policy nobody reads.
 *
 * The numbers come from the response, not from a constant here. §7 makes them
 * configurable and a hardcoded "15 minutes" in the prose would start lying the
 * first time an operator changed the setting.
 */

interface SessionRow {
  sessionId: string;
  current: boolean;
  status: string;
  hint: string;
  device: string | null;
  loginAt: string | null;
  lastActivity: string | null;
  endedAt: string | null;
  endedReason: string | null;
  revocable: boolean;
}

interface SessionsPayload {
  userId: string;
  userCode: string;
  currentSessionId: string;
  policy: {
    idleAfterSeconds: number;
    staleAfterSeconds: number;
    absoluteLifetimeSeconds: number;
    singleSession: boolean;
  };
  sessions: SessionRow[];
}

const STATUS_WORDS: Record<string, string> = {
  active: "Active",
  idle: "Idle",
  expired: "Released",
  logged_out: "Signed out",
  revoked: "Revoked",
};

function whenLabel(iso: string | null | undefined): string {
  if (!iso) return "—";
  const ms = Date.parse(iso);
  return Number.isNaN(ms) ? "—" : new Date(ms).toLocaleString();
}

function minutes(seconds: number): string {
  const m = Math.max(1, Math.round(seconds / 60));
  return `${m} minute${m === 1 ? "" : "s"}`;
}

function hours(seconds: number): string {
  const h = seconds / 3600;
  if (h < 1) return minutes(seconds);
  const rounded = Math.round(h * 10) / 10;
  return `${rounded} hour${rounded === 1 ? "" : "s"}`;
}

export default function SecurityPage() {
  const { state, signOut } = useSession({ redirectOnSignOut: true });
  const [data, setData] = React.useState<SessionsPayload | null>(null);
  const [error, setError] = React.useState<string | null>(null);
  const [note, setNote] = React.useState<string | null>(null);
  const [busyId, setBusyId] = React.useState<string | null>(null);
  /** which row's destructive button is armed — a second click confirms it */
  const [armed, setArmed] = React.useState<string | null>(null);

  const load = React.useCallback(async () => {
    const r = await api<SessionsPayload>("/api/sessions");
    if (!r.ok) {
      if (r.status !== 401 && r.status !== 403) setError(r.error);
      return;
    }
    setError(null);
    setData(r.data);
  }, []);

  React.useEffect(() => { void load(); }, [load]);

  // a session list goes out of date on its own — someone else's heartbeat
  // stops, or an admin revokes a row — so it refreshes without being asked
  React.useEffect(() => {
    const id = setInterval(() => { void load(); }, 20000);
    return () => clearInterval(id);
  }, [load]);

  /*
   * An armed button disarms itself. Without this a "Confirm?" left over from
   * a stray click sits there for the rest of the visit, and the next click —
   * possibly aimed at a refreshed row in the same place — ends a session
   * nobody meant to touch.
   */
  React.useEffect(() => {
    if (!armed) return;
    const id = setTimeout(() => setArmed(null), 5000);
    return () => clearTimeout(id);
  }, [armed]);

  const revoke = async (sessionId: string) => {
    setBusyId(sessionId);
    setNote(null);
    try {
      const r = await api<{ ok: true }>("/api/sessions", { method: "DELETE", json: { sessionId } });
      if (!r.ok) { setError(r.error); return; }
      setError(null);
      setNote("That session has been signed out.");
      setArmed(null);
      await load();
    } finally {
      setBusyId(null);
    }
  };

  const signOutHere = async () => {
    setBusyId("self");
    try {
      await fetch("/api/auth/logout", { method: "POST" });
    } catch {
      /* the cookie may already be gone; the login screen is the right place either way */
    }
    window.location.href = "/login";
  };

  const user = state.kind === "signed_in" ? state.user : null;
  const policy = data?.policy;

  return (
    <div className="acct-shell">
      <AccountHeader active="security" user={user} onSignOut={signOut} />

      {policy && (
        <p className="muted" style={{ fontSize: 13, lineHeight: 1.55, maxWidth: 720 }}>
          {policy.singleSession
            ? "This platform allows one active session per account."
            : "You can be signed in on more than one device at a time."}{" "}
          A session goes quiet after {minutes(policy.idleAfterSeconds)} without activity and is
          released automatically after {minutes(policy.staleAfterSeconds)}, so if your browser
          closes unexpectedly you are never locked out — wait that long, or release the session
          yourself below. Every session ends after {hours(policy.absoluteLifetimeSeconds)} regardless
          of activity.
        </p>
      )}

      {error && <div className="auth-note err">{error}</div>}
      {note && !error && <div className="auth-note ok">{note}</div>}

      <div className="row" style={{ margin: "6px 0 10px" }}>
        <strong className="grow">Sessions on this account</strong>
        <button className="btn small" onClick={() => void load()}>Refresh</button>
      </div>

      {!data && !error && <p className="muted">Loading…</p>}

      {data && (
        <div className="table-wrap">
          <table className="grid" data-testid="security-sessions">
            <thead>
              <tr>
                <th>Session</th>
                <th>Status</th>
                <th>Device</th>
                <th>Login time</th>
                <th>Last activity</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {data.sessions.length === 0 && (
                <tr><td colSpan={6} className="muted">No sessions recorded.</td></tr>
              )}
              {data.sessions.map((s) => {
                const isArmed = armed === s.sessionId;
                return (
                  <tr key={s.sessionId} data-testid="security-row" data-session-id={s.sessionId}>
                    <td className="mono" style={{ whiteSpace: "nowrap" }}>
                      {s.sessionId.slice(0, 8)}
                      {s.current && (
                        <>
                          {" "}
                          <span className="chip on" data-testid="security-current">This device</span>
                        </>
                      )}
                    </td>
                    <td>
                      <div>{STATUS_WORDS[s.status] ?? s.status}</div>
                      {s.hint && <div className="muted" style={{ fontSize: 11 }}>{s.hint}</div>}
                    </td>
                    <td>{s.device || "Unrecognised device"}</td>
                    <td>{whenLabel(s.loginAt)}</td>
                    <td>{whenLabel(s.lastActivity)}</td>
                    <td style={{ whiteSpace: "nowrap" }}>
                      {s.current ? (
                        <button
                          className="btn small danger"
                          data-testid="security-signout"
                          disabled={busyId !== null}
                          onClick={() => (isArmed ? void signOutHere() : setArmed(s.sessionId))}
                        >
                          {isArmed ? "Confirm?" : "Sign out"}
                        </button>
                      ) : s.revocable ? (
                        <button
                          className="btn small danger"
                          data-testid="security-revoke"
                          disabled={busyId !== null}
                          onClick={() => (isArmed ? void revoke(s.sessionId) : setArmed(s.sessionId))}
                        >
                          {busyId === s.sessionId ? "Revoking…" : isArmed ? "Confirm?" : "Revoke"}
                        </button>
                      ) : (
                        <span className="muted" style={{ fontSize: 11 }}>
                          {s.endedReason ? `Ended (${s.endedReason})` : "Already ended"}
                        </span>
                      )}
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

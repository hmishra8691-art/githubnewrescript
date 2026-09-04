"use client";
import React from "react";
import { AccountHeader } from "@/components/AccountHeader";
import { api, useSession } from "@/lib/useSession";

/**
 * ADMINISTRATION (§9).
 *
 * Two operational screens behind one door: who is signed in right now, and
 * every account on the installation.
 *
 * The rule this page is built around is that the server refuses some of these
 * actions — you cannot disable yourself, and you cannot demote the last
 * platform admin — and it says WHY in `immutableReason`. So the controls for
 * those rows are disabled here with that same sentence next to them. A live
 * button that returns a 409 teaches an administrator to distrust the screen;
 * a dead button with a reason teaches them the rule.
 */

interface AdminSessionRow {
  sessionId: string;
  user: { userId: string; userCode: string; name: string; email: string; organization: string | null };
  accountStatus: string;
  platformRole: string;
  loginTime: string | null;
  lastActivity: string | null;
  status: string;
  hint: string;
  device: string | null;
  isMine: boolean;
}

interface AdminSessionsPayload {
  sessions: AdminSessionRow[];
  stale: number;
}

interface AccountRow {
  userId: string;
  userCode: string;
  name: string;
  email: string;
  organization: string | null;
  jobTitle: string | null;
  platformRole: string;
  accountStatus: string;
  createdAt: string | null;
  lastLogin: string | null;
  lockedUntil: string | null;
  session: { sessionId: string; status: string; since: string; lastActivity: string; device: string | null } | null;
  isSelf: boolean;
  immutableReason: string | null;
}

interface AccountsPayload {
  accounts: AccountRow[];
  platformRoles: string[];
}

const STATUS_WORDS: Record<string, string> = {
  active: "Active",
  idle: "Idle",
  expired: "Released",
  logged_out: "Signed out",
  revoked: "Revoked",
};

const ROLE_WORDS: Record<string, string> = {
  platform_admin: "Platform administrator",
  programmer: "Programmer",
  researcher: "Researcher",
  client: "Client",
  viewer: "Viewer",
};

function whenLabel(iso: string | null | undefined): string {
  if (!iso) return "—";
  const ms = Date.parse(iso);
  return Number.isNaN(ms) ? "—" : new Date(ms).toLocaleString();
}

export default function AdminPage() {
  const { state, signOut } = useSession({ redirectOnSignOut: true });
  const [tab, setTab] = React.useState<"sessions" | "accounts">("sessions");

  const [sessions, setSessions] = React.useState<AdminSessionsPayload | null>(null);
  const [accounts, setAccounts] = React.useState<AccountsPayload | null>(null);
  const [error, setError] = React.useState<string | null>(null);
  const [note, setNote] = React.useState<string | null>(null);
  const [busy, setBusy] = React.useState<string | null>(null);

  /** the row whose revoke is armed, plus the optional reason typed into it */
  const [armed, setArmed] = React.useState<string | null>(null);
  const [reason, setReason] = React.useState("");

  const [search, setSearch] = React.useState("");
  const [query, setQuery] = React.useState("");

  const user = state.kind === "signed_in" ? state.user : null;
  const denied = state.kind === "signed_in" && !state.user.isPlatformAdmin;

  const loadSessions = React.useCallback(async () => {
    const r = await api<AdminSessionsPayload>("/api/admin/sessions");
    if (!r.ok) {
      if (r.status !== 401 && r.status !== 403) setError(r.error);
      return;
    }
    setError(null);
    setSessions(r.data);
  }, []);

  const loadAccounts = React.useCallback(async (q: string) => {
    const r = await api<AccountsPayload>(`/api/admin/accounts${q ? `?q=${encodeURIComponent(q)}` : ""}`);
    if (!r.ok) {
      if (r.status !== 401 && r.status !== 403) setError(r.error);
      return;
    }
    setError(null);
    setAccounts(r.data);
  }, []);

  // the search box types faster than the query can answer, so the fetch waits
  // for a pause rather than firing per keystroke
  React.useEffect(() => {
    const id = setTimeout(() => setQuery(search.trim()), 300);
    return () => clearTimeout(id);
  }, [search]);

  React.useEffect(() => {
    if (denied) return;
    if (tab === "sessions") void loadSessions();
    else void loadAccounts(query);
  }, [denied, tab, query, loadSessions, loadAccounts]);

  // the active-sessions view is the one an admin watches while someone is on
  // the phone to them, so it keeps itself current
  React.useEffect(() => {
    if (denied || tab !== "sessions") return;
    const id = setInterval(() => { void loadSessions(); }, 20000);
    return () => clearInterval(id);
  }, [denied, tab, loadSessions]);

  React.useEffect(() => {
    if (!armed) return;
    const id = setTimeout(() => setArmed(null), 12000);
    return () => clearTimeout(id);
  }, [armed]);

  const revokeSession = async (sessionId: string) => {
    setBusy(sessionId);
    try {
      const r = await api<{ ok: true; revoked: number; message?: string; note?: string }>("/api/admin/sessions", {
        method: "POST",
        json: { sessionId, reason: reason.trim() || undefined },
      });
      if (!r.ok) { setError(r.error); setNote(null); return; }
      setError(null);
      setNote(r.data.message ?? r.data.note ?? "Session ended.");
      setArmed(null);
      setReason("");
      await loadSessions();
    } finally {
      setBusy(null);
    }
  };

  /**
   * Account actions all POST to one endpoint, and only `disable` returns
   * anything to report — so the confirmation sentence is written here from
   * what was asked for rather than read back from the response.
   */
  const accountAction = async (row: AccountRow, action: "disable" | "enable" | "unlock" | "set_role", role?: string) => {
    setBusy(`${row.userId}:${action}`);
    try {
      const r = await api<{ ok: true; sessionsEnded?: number; role?: string }>("/api/admin/accounts", {
        method: "POST",
        json: { userId: row.userId, action, role },
      });
      if (!r.ok) { setError(r.error); setNote(null); return; }
      setError(null);
      const ended = r.data.sessionsEnded ?? 0;
      setNote(
        action === "disable"
          ? `${row.name} has been disabled. ${ended} session${ended === 1 ? "" : "s"} ended.`
          : action === "enable"
            ? `${row.name} can sign in again.`
            : action === "unlock"
              ? `The sign-in lockout on ${row.name} has been cleared.`
              : `${row.name} is now ${ROLE_WORDS[r.data.role ?? role ?? ""] ?? r.data.role ?? role}.`,
      );
      await loadAccounts(query);
    } finally {
      setBusy(null);
    }
  };

  if (denied) {
    return (
      <div className="acct-shell">
        <AccountHeader active="admin" user={user} onSignOut={signOut} />
        <div className="auth-note err" data-testid="admin-denied">
          <strong>This area is for platform administrators.</strong>
          <div style={{ marginTop: 4 }}>
            Your account does not have that role. If you need it, ask an administrator.{" "}
            <a href="/">Back to projects</a>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="acct-shell">
      <AccountHeader active="admin" user={user} onSignOut={signOut} />

      <div className="acct-nav">
        <button
          type="button"
          data-testid="admin-tab-sessions"
          className={tab === "sessions" ? "active" : undefined}
          onClick={() => { setTab("sessions"); setNote(null); }}
        >
          Active sessions
        </button>
        <button
          type="button"
          data-testid="admin-tab-accounts"
          className={tab === "accounts" ? "active" : undefined}
          onClick={() => { setTab("accounts"); setNote(null); }}
        >
          Accounts
        </button>
      </div>

      {error && <div className="auth-note err">{error}</div>}
      {note && !error && <div className="auth-note ok">{note}</div>}

      {tab === "sessions" && (
        <>
          <div className="row" style={{ marginBottom: 10 }}>
            <strong className="grow">Signed in right now</strong>
            {!!sessions?.stale && (
              <span className="chip warn">
                {`${sessions.stale} session${sessions.stale === 1 ? "" : "s"} ${sessions.stale === 1 ? "has" : "have"} gone quiet past the inactivity threshold`}
              </span>
            )}
            <button className="btn small" onClick={() => void loadSessions()}>Refresh</button>
          </div>

          {!sessions && !error && <p className="muted">Loading…</p>}

          {sessions && (
            <div className="table-wrap">
              <table className="grid" data-testid="admin-sessions">
                <thead>
                  <tr>
                    <th>User</th>
                    <th>Email</th>
                    <th>Login time</th>
                    <th>Last activity</th>
                    <th>Status</th>
                    <th>Device</th>
                    <th />
                  </tr>
                </thead>
                <tbody>
                  {sessions.sessions.length === 0 && (
                    <tr><td colSpan={7} className="muted">Nobody is signed in.</td></tr>
                  )}
                  {sessions.sessions.map((s) => {
                    const isArmed = armed === s.sessionId;
                    return (
                      <tr key={s.sessionId} data-session-id={s.sessionId}>
                        <td>
                          <div>{s.user.name || "—"}</div>
                          <div className="mono muted" style={{ fontSize: 11 }}>{s.user.userCode}</div>
                        </td>
                        <td>{s.user.email || "—"}</td>
                        <td>{whenLabel(s.loginTime)}</td>
                        <td>{whenLabel(s.lastActivity)}</td>
                        <td>
                          <div>{STATUS_WORDS[s.status] ?? s.status}</div>
                          {s.hint && <div className="muted" style={{ fontSize: 11 }}>{s.hint}</div>}
                        </td>
                        <td>{s.device || "Unrecognised device"}</td>
                        <td style={{ whiteSpace: "nowrap" }}>
                          {isArmed ? (
                            <span className="row" style={{ gap: 6 }}>
                              <input
                                className="input"
                                style={{ width: 150, fontSize: 11.5 }}
                                placeholder="Reason (optional)"
                                autoFocus
                                value={reason}
                                onChange={(e) => setReason(e.target.value)}
                              />
                              <button
                                className="btn small danger"
                                disabled={busy !== null}
                                onClick={() => void revokeSession(s.sessionId)}
                              >
                                {busy === s.sessionId ? "Ending…" : "Confirm"}
                              </button>
                              <button className="btn small" onClick={() => { setArmed(null); setReason(""); }}>
                                Cancel
                              </button>
                            </span>
                          ) : (
                            <button
                              className="btn small danger"
                              data-testid="admin-revoke"
                              disabled={busy !== null}
                              title={s.isMine ? "This is your own session." : undefined}
                              onClick={() => { setArmed(s.sessionId); setReason(""); }}
                            >
                              {s.isMine ? "Revoke session (yours)" : "Revoke session"}
                            </button>
                          )}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </>
      )}

      {tab === "accounts" && (
        <>
          <div className="row" style={{ marginBottom: 10 }}>
            <input
              className="input grow"
              placeholder="Search by name, email or User ID…"
              aria-label="Search accounts"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
            />
            <button className="btn small" onClick={() => void loadAccounts(query)}>Refresh</button>
          </div>

          {!accounts && !error && <p className="muted">Loading…</p>}

          {accounts && (
            <div className="table-wrap">
              <table className="grid" data-testid="admin-accounts">
                <thead>
                  <tr>
                    <th>User</th>
                    <th>Email</th>
                    <th>Organization</th>
                    <th>Platform role</th>
                    <th>Account status</th>
                    <th>Last login</th>
                    <th>Session</th>
                    <th />
                  </tr>
                </thead>
                <tbody>
                  {accounts.accounts.length === 0 && (
                    <tr><td colSpan={8} className="muted">No accounts match that search.</td></tr>
                  )}
                  {accounts.accounts.map((a) => {
                    const frozen = !!a.immutableReason;
                    const disabled = a.accountStatus !== "active";
                    const locked = !!a.lockedUntil && Date.parse(a.lockedUntil) > Date.now();
                    return (
                      <tr key={a.userId} data-user-id={a.userId}>
                        <td>
                          <div>{a.name || "—"}</div>
                          <div className="mono muted" style={{ fontSize: 11 }}>{a.userCode}</div>
                        </td>
                        <td>{a.email || "—"}</td>
                        <td>{a.organization || <span className="muted">—</span>}</td>
                        <td>
                          <select
                            className="select"
                            data-testid="admin-role"
                            aria-label={`Platform role for ${a.name || a.userCode}`}
                            value={a.platformRole}
                            disabled={frozen || busy !== null}
                            title={a.immutableReason ?? undefined}
                            onChange={(e) => void accountAction(a, "set_role", e.target.value)}
                          >
                            {accounts.platformRoles.map((r) => (
                              <option key={r} value={r}>{ROLE_WORDS[r] ?? r}</option>
                            ))}
                          </select>
                        </td>
                        <td>
                          <span className={a.accountStatus === "active" ? "chip on" : "chip warn"}>
                            {a.accountStatus}
                          </span>
                          {locked && (
                            <div className="muted" style={{ fontSize: 11 }}>
                              Locked until {whenLabel(a.lockedUntil)}
                            </div>
                          )}
                        </td>
                        <td>{whenLabel(a.lastLogin)}</td>
                        <td>
                          {a.session ? (
                            <>
                              <div>{STATUS_WORDS[a.session.status] ?? a.session.status}</div>
                              <div className="muted" style={{ fontSize: 11 }}>
                                {a.session.device || "Unrecognised device"}
                              </div>
                            </>
                          ) : (
                            <span className="muted">Not signed in</span>
                          )}
                        </td>
                        <td style={{ whiteSpace: "nowrap" }}>
                          <div className="row" style={{ gap: 6 }}>
                            <button
                              className={disabled ? "btn small" : "btn small danger"}
                              data-testid="admin-disable"
                              disabled={frozen || busy !== null}
                              title={a.immutableReason ?? undefined}
                              onClick={() => void accountAction(a, disabled ? "enable" : "disable")}
                            >
                              {disabled ? "Enable" : "Disable"}
                            </button>
                            <button
                              className="btn small"
                              disabled={frozen || busy !== null || !locked}
                              title={a.immutableReason ?? (locked ? undefined : "This account is not locked.")}
                              onClick={() => void accountAction(a, "unlock")}
                            >
                              Unlock
                            </button>
                          </div>
                          {a.immutableReason && (
                            <span className="locked-field">
                              <span className="why">{a.immutableReason}</span>
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
        </>
      )}
    </div>
  );
}

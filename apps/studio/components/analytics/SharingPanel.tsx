"use client";
import React from "react";
import { AxApi, type Row } from "./api";

/** MANAGE SHARED REPORTS (§21, §22): every link, who it reaches, its state, its history; revoke / reshare / change access. */
export function SharingPanel({ api, shares, reports, onChange }: { api: AxApi; shares: Row[]; reports: Row[]; onChange: () => void }) {
  const [history, setHistory] = React.useState<{ id: string; events: Row[] } | null>(null);
  const [editing, setEditing] = React.useState<Row | null>(null);
  const [error, setError] = React.useState<string | null>(null);
  const name = (id: string) => reports.find((r) => r.id === id)?.name ?? "—";
  const status = (s: Row) => (s.revoked_at ? "Revoked" : s.expires_at && new Date(s.expires_at) < new Date() ? "Expired" : "Active");
  const act = async (fn: () => Promise<unknown>) => { setError(null); try { await fn(); onChange(); } catch (e) { setError((e as Error).message); } };
  return (
    <div className="ax-panel" data-testid="ax-sharing">
      <div className="row" style={{ marginBottom: 10 }}><h2 style={{ margin: 0 }}>Manage shared reports</h2><span className="muted" style={{ fontSize: 13 }}>Every link shows a published, read-only snapshot. Revoking takes effect immediately.</span></div>
      {error && <div className="ax-error">{error}</div>}
      <table className="ax-table" data-testid="ax-shares-table">
        <thead><tr><th>Report</th><th>Shared with</th><th>Type</th><th>Permission</th><th>Version</th><th>Status</th><th>Expires</th><th className="num">Views</th><th>Actions</th></tr></thead>
        <tbody>
          {shares.map((s) => (
            <tr key={s.id} data-testid="ax-share-row" data-status={status(s)}>
              <td>{name(s.report_id)}{s.label ? <span className="muted"> · {s.label}</span> : null}</td>
              <td>{s.access === "link" ? "Anyone with link" : s.access === "users" ? (s.allowed_emails?.length ? s.allowed_emails.join(", ") : `${s.allowed_user_ids?.length ?? 0} users`) : "Project members"}</td>
              <td>{s.access === "link" ? "Public" : s.access === "users" ? "Specific users" : "Private"}{s.has_password ? " · password" : ""}</td>
              <td>{s.permission === "download" ? "Download only" : "Viewer"}</td>
              <td>{s.report_version ? `v${s.report_version} (pinned)` : "latest published"}</td>
              <td><span className={`ax-status ${status(s).toLowerCase()}`}>{status(s)}</span></td>
              <td>{s.expires_at ? new Date(s.expires_at).toLocaleDateString() : "Never"}</td>
              <td className="num">{s.view_count ?? 0}</td>
              <td className="ax-actions">
                {!s.revoked_at && <button className="btn small" onClick={() => navigator.clipboard?.writeText(`${window.location.origin}/share/${s.token}`)}>Copy link</button>}
                {!s.revoked_at && <button className="btn small" onClick={() => setEditing(s)}>Edit</button>}
                {!s.revoked_at ? <button className="btn small danger" onClick={() => act(() => api.patch("shares", s.id, { revoke: true }))} data-testid="ax-share-revoke">Revoke</button> : <button className="btn small" onClick={() => act(() => api.patch("shares", s.id, { reshare: true }))}>Reshare (new link)</button>}
                <button className="btn small" onClick={async () => { const r = await api.access(s.id); setHistory({ id: s.id, events: r.events }); }}>History</button>
              </td>
            </tr>
          ))}
          {!shares.length && <tr><td colSpan={9} className="muted">No shares yet. Publish a report, then use Share.</td></tr>}
        </tbody>
      </table>
      {history && <div className="card" style={{ marginTop: 10 }}><div className="row"><div className="card-title">Access history</div><span className="grow" /><button className="btn small" onClick={() => setHistory(null)}>Close</button></div>{history.events.length ? <table className="ax-table dense"><thead><tr><th>When</th><th>Event</th><th>Viewer</th></tr></thead><tbody>{history.events.map((e) => <tr key={e.id}><td>{new Date(e.created_at).toLocaleString()}</td><td>{e.event}</td><td>{e.viewer_email ?? (e.viewer_user_id ? "signed-in user" : "anonymous")}</td></tr>)}</tbody></table> : <div className="muted">No access recorded yet.</div>}</div>}
      {editing && <EditShare api={api} share={editing} onClose={() => setEditing(null)} onSaved={() => { setEditing(null); onChange(); }} />}
    </div>
  );
}

function EditShare({ api, share, onClose, onSaved }: { api: AxApi; share: Row; onClose: () => void; onSaved: () => void }) {
  const [access, setAccess] = React.useState(share.access as string);
  const [permission, setPermission] = React.useState(share.permission as string);
  const [expires, setExpires] = React.useState(share.expires_at ? String(share.expires_at).slice(0, 10) : "");
  const [emails, setEmails] = React.useState((share.allowed_emails ?? []).join(", "));
  const [password, setPassword] = React.useState<string | null>(null);
  const [pin, setPin] = React.useState<string>(share.report_version ? String(share.report_version) : "");
  const [error, setError] = React.useState<string | null>(null);
  const save = async () => { try { await api.patch("shares", share.id, { access, permission, expiresAt: expires ? new Date(expires).toISOString() : null, emails: access === "users" ? emails.split(/[,\s]+/).filter(Boolean) : undefined, password: password === null ? undefined : password, pinVersion: pin ? Number(pin) : null }); onSaved(); } catch (e) { setError((e as Error).message); } };
  return (
    <div className="modal-back" onClick={onClose}><div className="modal" onClick={(e) => e.stopPropagation()}>
      <h2>Edit share</h2>
      <div className="ax-cust-grid">
        <label className="ax-field"><span>Sharing</span><select className="select small" value={access} onChange={(e) => setAccess(e.target.value)}><option value="private">Private</option><option value="users">Specific users</option><option value="link">Anyone with link</option></select></label>
        <label className="ax-field"><span>Permission</span><select className="select small" value={permission} onChange={(e) => setPermission(e.target.value)}><option value="viewer">Viewer</option><option value="download">Download only</option></select></label>
        <label className="ax-field"><span>Expires</span><input className="input small" type="date" value={expires} onChange={(e) => setExpires(e.target.value)} /></label>
        <label className="ax-field"><span>Pinned version (blank = latest)</span><input className="input small" type="number" min={1} value={pin} onChange={(e) => setPin(e.target.value)} /></label>
        <label className="ax-field"><span>Password (blank keeps current; “-” removes)</span><input className="input small" value={password ?? ""} onChange={(e) => setPassword(e.target.value === "-" ? "" : e.target.value)} placeholder={share.has_password ? "•••••• (set)" : "none"} /></label>
      </div>
      {access === "users" && <label className="ax-field"><span>Emails</span><textarea className="ta" rows={2} value={emails} onChange={(e) => setEmails(e.target.value)} /></label>}
      <div className="row" style={{ marginTop: 12 }}>{error && <span className="ax-error">{error}</span>}<span className="grow" /><button className="btn" onClick={onClose}>Cancel</button><button className="btn primary" onClick={save}>Save</button></div>
    </div></div>
  );
}

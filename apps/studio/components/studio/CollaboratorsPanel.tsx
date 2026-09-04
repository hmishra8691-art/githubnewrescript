"use client";
import React from "react";
import { useStudio } from "./store";
import { api } from "@/lib/useSession";

/**
 * PROJECT COLLABORATORS + SHARING (§10, §11, §20, §21, §22).
 *
 * The share box takes an email address OR a User ID in one field, because to
 * the person sharing it is one act. It LOOKS THE PERSON UP FIRST and shows who
 * it found — "User Found: Sarah Lee, USR-10591" — before anything is granted,
 * so a mistyped code cannot quietly invite a stranger, and an unknown email
 * offers an invitation instead of an error.
 *
 * Roles are described, not just named. "Programmer" and "Deployment manager"
 * mean specific things in a research team and the difference matters when
 * you are handing someone access to a live study, so the descriptions come
 * from the server (which reads them from the shared access model) rather than
 * being re-worded here.
 */

interface Member {
  userId: string; userCode: string; name: string; email: string; organization: string | null;
  role: string; roleLabel: string; isOwner: boolean; accountStatus: string;
  addedAt: string; lastActivity: string | null; currentlyActive: boolean;
  activity: string | null; initials: string; hue: number; isMe: boolean; changeable: boolean;
}
interface Invitation { id: string; email: string | null; userCode: string | null; role: string; roleLabel: string; invitedAt: string; expiresAt: string }
interface RoleOption { value: string; label: string; description: string }
interface MembersPayload {
  project: { id: string; code: string; title: string };
  owner: Member | null;
  members: Member[];
  groups: { role: string; label: string; description: string; members: Member[] }[];
  invitations: Invitation[];
  myRole: string | null;
  canManage: boolean;
  grantableRoles: RoleOption[];
}
interface Lookup {
  found: boolean;
  invitable?: boolean;
  note?: string;
  identifier?: string;
  user?: { userId: string; userCode: string; name: string; email: string; organization: string | null; disabled: boolean };
  alreadyHasAccess?: boolean;
  currentRole?: string | null;
  differentOrganization?: boolean;
}

const when = (iso: string | null) => (iso ? new Date(iso).toLocaleString([], { dateStyle: "medium", timeStyle: "short" }) : "—");

function Avatar({ m }: { m: { initials: string; hue: number; name: string } }) {
  return <span className="avatar" style={{ background: `hsl(${m.hue} 62% 45%)` }} title={m.name} aria-hidden="true">{m.initials}</span>;
}

export function CollaboratorsPanel({ canShare }: { canShare: boolean }) {
  const s = useStudio();
  const [data, setData] = React.useState<MembersPayload | null>(null);
  const [note, setNote] = React.useState<{ text: string; ok: boolean } | null>(null);
  const [q, setQ] = React.useState("");
  const [role, setRole] = React.useState("programmer");
  const [lookup, setLookup] = React.useState<Lookup | null>(null);
  const [busy, setBusy] = React.useState<string | null>(null);
  const [confirmRemove, setConfirmRemove] = React.useState<string | null>(null);
  const [transferTo, setTransferTo] = React.useState<string | null>(null);

  const load = React.useCallback(async () => {
    const r = await api<MembersPayload>(`/api/surveys/${s.surveyDbId}/members`);
    if (r.ok) setData(r.data);
    else setNote({ text: r.error, ok: false });
  }, [s.surveyDbId]);
  React.useEffect(() => { void load(); }, [load]);

  /* the lookup is explicit, not debounced-as-you-type: a User ID is short and
     a partial one resolves to somebody else's account */
  const doLookup = async () => {
    if (!q.trim()) return;
    setBusy("lookup"); setNote(null);
    const r = await api<Lookup>(`/api/surveys/${s.surveyDbId}/share?q=${encodeURIComponent(q.trim())}`);
    setBusy(null);
    if (r.ok) setLookup(r.data);
    else setNote({ text: r.error, ok: false });
  };

  const doShare = async () => {
    setBusy("share"); setNote(null);
    const r = await api<{ message?: string; kind?: string; inviteUrl?: string }>(
      `/api/surveys/${s.surveyDbId}/share`,
      { method: "POST", json: { identifier: q.trim(), role } },
    );
    setBusy(null);
    if (!r.ok) { setNote({ text: r.error, ok: false }); return; }
    setNote({
      text: r.data.message ?? "Shared.",
      ok: true,
    });
    // an invitation cannot be emailed without SMTP configured, so the link is
    // handed over instead of being silently dropped
    if (r.data.kind === "invited" && r.data.inviteUrl) {
      setNote({ text: `${r.data.message} If they do not receive an email, send them this link: ${r.data.inviteUrl}`, ok: true });
    }
    setQ(""); setLookup(null);
    void load();
  };

  const changeRole = async (userId: string, newRole: string) => {
    setBusy(userId); setNote(null);
    const r = await api<{ lockReleased?: boolean }>(`/api/surveys/${s.surveyDbId}/members`, {
      method: "PATCH", json: { userId, role: newRole },
    });
    setBusy(null);
    if (!r.ok) { setNote({ text: r.error, ok: false }); return; }
    setNote({
      text: r.data.lockReleased
        ? "Role changed. They were editing, so the edit lock was released."
        : "Role changed.",
      ok: true,
    });
    void load();
  };

  const remove = async (userId: string) => {
    setBusy(userId); setNote(null);
    const r = await api(`/api/surveys/${s.surveyDbId}/members`, { method: "DELETE", json: { userId } });
    setBusy(null); setConfirmRemove(null);
    setNote(r.ok ? { text: "Access removed.", ok: true } : { text: r.error, ok: false });
    void load();
  };

  const transfer = async (userId: string) => {
    setBusy(userId); setNote(null);
    const r = await api<{ message?: string }>(`/api/surveys/${s.surveyDbId}/transfer`, { method: "POST", json: { userId } });
    setBusy(null); setTransferTo(null);
    setNote(r.ok ? { text: r.data.message ?? "Ownership transferred.", ok: true } : { text: r.error, ok: false });
    void load();
  };

  const revokeInvite = async (invitationId: string) => {
    setBusy(invitationId);
    const r = await api(`/api/surveys/${s.surveyDbId}/share`, { method: "DELETE", json: { invitationId } });
    setBusy(null);
    setNote(r.ok ? { text: "Invitation revoked.", ok: true } : { text: r.error, ok: false });
    void load();
  };

  if (!data) return <div className="muted">Loading collaborators…</div>;

  return (
    <div data-testid="collaborators-panel">
      <div className="row" style={{ marginBottom: 12, flexWrap: "wrap" }}>
        <h2 style={{ margin: 0, fontSize: 17 }}>Project collaborators</h2>
        <span className="chip">{data.members.length} {data.members.length === 1 ? "person" : "people"}</span>
        <span className="grow" />
        <button className="btn small" onClick={() => void load()}>↻ refresh</button>
      </div>

      {note && <div className={`auth-note ${note.ok ? "ok" : "err"}`} data-testid="collab-note">{note.text}</div>}

      {/* ------------------------------------------------ share */}
      {canShare && (
        <div className="card" data-testid="share-box">
          <div className="flabel">Share this project</div>
          <p className="muted" style={{ fontSize: 11.5, marginTop: 0 }}>
            Enter an email address or a User ID (for example <span className="mono">USR-10482</span>). Colleagues can find
            their own User ID on their profile page.
          </p>
          <div className="row" style={{ flexWrap: "wrap" }}>
            <input
              className="input" style={{ width: 260 }} value={q}
              placeholder="name@company.com or USR-10482"
              data-testid="share-identifier"
              onChange={(e) => { setQ(e.target.value); setLookup(null); }}
              onKeyDown={(e) => { if (e.key === "Enter") void doLookup(); }}
            />
            <select className="select" style={{ width: 180 }} value={role} data-testid="share-role" onChange={(e) => setRole(e.target.value)}>
              {data.grantableRoles.map((r) => <option key={r.value} value={r.value}>{r.label}</option>)}
            </select>
            <button className="btn small" data-testid="share-lookup" disabled={!q.trim() || busy === "lookup"} onClick={() => void doLookup()}>
              {busy === "lookup" ? "Looking…" : "Find"}
            </button>
          </div>
          <p className="muted" style={{ fontSize: 11, marginBottom: 0 }}>
            {data.grantableRoles.find((r) => r.value === role)?.description}
          </p>

          {lookup && (
            <div className="card" style={{ padding: 10, marginTop: 10, marginBottom: 0 }} data-testid="share-lookup-result">
              {lookup.found && lookup.user ? (
                <>
                  <div className="row">
                    <span className="chip on">User found</span>
                    <strong style={{ fontSize: 13 }}>{lookup.user.name}</strong>
                    <span className="mono muted">{lookup.user.userCode}</span>
                    <span className="muted" style={{ fontSize: 11.5 }}>{lookup.user.email}</span>
                  </div>
                  {lookup.alreadyHasAccess && (
                    <p className="muted" style={{ fontSize: 11.5 }}>
                      Already has access as <strong>{lookup.currentRole}</strong>. Sharing again changes their role.
                    </p>
                  )}
                  {lookup.differentOrganization && (
                    <p className="muted" style={{ fontSize: 11.5 }}>
                      This person is in a different organization. Sharing is what grants them access — they cannot see your
                      other projects.
                    </p>
                  )}
                  {lookup.user.disabled && <p style={{ fontSize: 11.5, color: "var(--red)" }}>Their account is disabled.</p>}
                  <button className="btn small primary" data-testid="share-submit" disabled={busy === "share" || lookup.user.disabled} onClick={() => void doShare()}>
                    {busy === "share" ? "Sharing…" : lookup.alreadyHasAccess ? "Change their role" : "Share project"}
                  </button>
                </>
              ) : (
                <>
                  <div className="row"><span className="chip warn">Not found</span></div>
                  <p className="muted" style={{ fontSize: 11.5 }}>{lookup.note}</p>
                  {lookup.invitable && (
                    <button className="btn small primary" data-testid="share-invite" disabled={busy === "share"} onClick={() => void doShare()}>
                      {busy === "share" ? "Inviting…" : "Send project invitation"}
                    </button>
                  )}
                </>
              )}
            </div>
          )}
        </div>
      )}

      {/* ------------------------------------------------ the roster */}
      {data.groups.map((g) => (
        <div className="collab-group" key={g.role}>
          <h4>{g.label}{g.members.length > 1 ? "s" : ""}</h4>
          <p className="desc">{g.description}</p>
          {g.members.map((m) => (
            <div className={`collab-row ${m.isMe ? "is-me" : ""}`} key={m.userId} data-testid="collab-member" data-user={m.userCode} data-role={m.role}>
              <Avatar m={m} />
              <span className="who">
                <span className="nm">
                  {m.name}{m.isMe ? " (you)" : ""}
                  {m.currentlyActive && <> <span className={`presence-dot ${m.activity === "editing" ? "editing" : ""}`} title={m.activity ?? "here now"} /></>}
                </span>
                <span className="meta">
                  <span className="mono">{m.userCode}</span> · {m.email}
                  {m.organization ? ` · ${m.organization}` : ""}
                  {" · "}
                  {m.currentlyActive ? "here now" : `last active ${when(m.lastActivity)}`}
                  {m.accountStatus !== "active" ? " · account disabled" : ""}
                </span>
              </span>

              {data.canManage && !m.isOwner && (
                <>
                  <select
                    className="select" style={{ width: 160 }} value={m.role}
                    data-testid="member-role" disabled={busy === m.userId}
                    onChange={(e) => void changeRole(m.userId, e.target.value)}
                  >
                    {data.grantableRoles.map((r) => <option key={r.value} value={r.value}>{r.label}</option>)}
                  </select>
                  {transferTo === m.userId ? (
                    <>
                      <span className="muted" style={{ fontSize: 11 }}>Make them the owner? You become an Editor.</span>
                      <button className="btn small danger" data-testid="transfer-confirm" onClick={() => void transfer(m.userId)}>Yes, transfer</button>
                      <button className="btn small" onClick={() => setTransferTo(null)}>Cancel</button>
                    </>
                  ) : (
                    <button className="btn small" data-testid="transfer-owner" onClick={() => setTransferTo(m.userId)}>Make owner</button>
                  )}
                  {confirmRemove === m.userId ? (
                    <>
                      <button className="btn small danger" data-testid="member-remove-confirm" onClick={() => void remove(m.userId)}>Confirm remove</button>
                      <button className="btn small" onClick={() => setConfirmRemove(null)}>Cancel</button>
                    </>
                  ) : (
                    <button className="btn small danger" data-testid="member-remove" onClick={() => setConfirmRemove(m.userId)}>Remove</button>
                  )}
                </>
              )}
              {m.isOwner && <span className="chip">owner</span>}
            </div>
          ))}
        </div>
      ))}

      {/* ------------------------------------------------ pending invitations */}
      {data.invitations.length > 0 && (
        <div className="collab-group">
          <h4>Invited</h4>
          <p className="desc">They will get access as soon as they create an account.</p>
          {data.invitations.map((i) => (
            <div className="collab-row collab-invite" key={i.id} data-testid="collab-invitation">
              <span className="avatar" style={{ background: "var(--border)" }} aria-hidden="true">✉</span>
              <span className="who">
                <span className="nm">{i.email ?? i.userCode}</span>
                <span className="meta">
                  {i.roleLabel} · invited {when(i.invitedAt)} · expires {when(i.expiresAt)}
                </span>
              </span>
              {data.canManage && (
                <button className="btn small danger" data-testid="invitation-revoke" disabled={busy === i.id} onClick={() => void revokeInvite(i.id)}>
                  Revoke
                </button>
              )}
            </div>
          ))}
        </div>
      )}

      {!canShare && (
        <p className="muted" style={{ fontSize: 12 }}>
          Only the project owner and editors can share this project.
        </p>
      )}
    </div>
  );
}

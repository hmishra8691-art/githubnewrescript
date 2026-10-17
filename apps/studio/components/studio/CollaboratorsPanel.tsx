"use client";
import React from "react";
import "./collaborators.css";
import { useStudio } from "./store";
import { api } from "@/lib/useSession";
import {
  accessLabel, diffAccess, escalation, isProjectRole, permissionsFromGrant,
  type CustomPermissions, type MemberGrant,
} from "@rescript/access";
import {
  AccessEditor, AccessPreviewBox, AccessSelect, draftBody, draftFrom, draftGrant, emptyDraft, type AccessDraft,
} from "./AccessEditor";

/**
 * PROJECT COLLABORATORS + SHARING (§10, §11, §20, §21, §22) — and, since
 * 2026-10-17, ADVANCED ACCESS: access levels under the names researchers use,
 * presets, per-module custom permissions with search, copy-from, expiry, a
 * preview before anything is saved, Resend / Cancel for invitations, and the
 * history of who was given what.
 *
 * ONE panel, three doors: the Studio's Collaborators tab, the "Collaborators"
 * item in a project card's ⋯ menu on the Research Workspace, and the avatar
 * button beside "Open programming" on the Project Overview. The two outside
 * the Studio open `CollaboratorsDialog`, which renders this same
 * `CollaboratorsManager` — there is no second panel to drift.
 *
 * The share box takes an email address OR a User ID in one field, because to
 * the person sharing it is one act. It LOOKS THE PERSON UP FIRST and shows who
 * it found — "User Found: Sarah Lee, USR-10591" — before anything is granted,
 * so a mistyped code cannot quietly invite a stranger, and an unknown email
 * offers an invitation instead of an error.
 *
 * Nothing here is the authority. The server re-checks every grant (and
 * refuses one the granter does not hold themselves); the panel only avoids
 * offering what would be refused.
 */

interface Member {
  userId: string; userCode: string; name: string; email: string; organization: string | null;
  role: string; roleLabel: string; isOwner: boolean; accountStatus: string;
  addedAt: string; lastActivity: string | null; currentlyActive: boolean;
  activity: string | null; initials: string; hue: number; isMe: boolean; changeable: boolean;
  /* 0062 — absent from an older server */
  accessLabel?: string; permissions?: CustomPermissions | null; expiresAt?: string | null;
  expired?: boolean; expiryText?: string | null; status?: string;
}
interface Invitation {
  id: string; email: string | null; userCode: string | null; role: string; roleLabel: string; invitedAt: string; expiresAt: string;
  accessLabel?: string; permissions?: unknown; accessExpiresAt?: string | null; resentAt?: string | null; resendCount?: number; linkExpired?: boolean;
}
interface RoleOption { value: string; label: string; description: string; accessLabel?: string }
interface HistoryEntry { id: string; action: string; text: string; at: string; actorName: string | null; changes: string[] }
interface MembersPayload {
  project: { id: string; code: string; title: string };
  owner: Member | null;
  members: Member[];
  groups?: { role: string; label: string; description: string; members: Member[] }[];
  invitations: Invitation[];
  myRole: string | null;
  myAccess?: { role: string | null; permissions: unknown; expiresAt: string | null };
  canManage: boolean;
  canShare?: boolean;
  isPlatformAdmin?: boolean;
  grantableRoles: RoleOption[];
  activity?: HistoryEntry[];
}
interface Lookup {
  found: boolean;
  invitable?: boolean;
  note?: string;
  identifier?: string;
  user?: { userId: string; userCode: string; name: string; email: string; organization: string | null; disabled: boolean };
  alreadyHasAccess?: boolean;
  currentRole?: string | null;
  currentAccessLabel?: string | null;
  differentOrganization?: boolean;
}

const when = (iso: string | null | undefined) => (iso ? new Date(iso).toLocaleString([], { dateStyle: "medium", timeStyle: "short" }) : "—");
const day = (iso: string | null | undefined) => (iso ? new Date(iso).toLocaleDateString([], { dateStyle: "medium" }) : "—");

function Avatar({ m, size = "" }: { m: { initials: string; hue: number; name: string }; size?: string }) {
  return <span className={`avatar ${size}`.trim()} style={{ background: `hsl(${m.hue} 62% 45%)`, color: "#fff" }} title={m.name} aria-hidden="true">{m.initials}</span>;
}

/* ================================================================== the Studio tab */

/** The Studio's Collaborators tab — the same manager, pointed at the open project. */
export function CollaboratorsPanel({ canShare }: { canShare: boolean }) {
  const s = useStudio();
  return <CollaboratorsManager surveyId={s.surveyDbId} canShare={canShare} />;
}

/* ================================================================== the panel */

export function CollaboratorsManager({
  surveyId, canShare: canShareProp, autoFocusInvite = false, onChanged,
}: {
  surveyId: string;
  /** what the Studio's collaboration poll says; outside the Studio the members payload decides */
  canShare?: boolean;
  autoFocusInvite?: boolean;
  /** told after anything changed, so a host (the Overview's avatar button) can refresh */
  onChanged?: () => void;
}) {
  const [data, setData] = React.useState<MembersPayload | null>(null);
  const [loadError, setLoadError] = React.useState<string | null>(null);
  const [note, setNote] = React.useState<{ text: string; ok: boolean } | null>(null);
  const [tab, setTab] = React.useState<"people" | "history">("people");
  const [history, setHistory] = React.useState<HistoryEntry[] | null>(null);
  const [q, setQ] = React.useState("");
  const [draft, setDraft] = React.useState<AccessDraft>(emptyDraft());
  const [showOptions, setShowOptions] = React.useState(false);
  const [lookup, setLookup] = React.useState<Lookup | null>(null);
  const [busy, setBusy] = React.useState<string | null>(null);
  const [confirmRemove, setConfirmRemove] = React.useState<string | null>(null);
  const [transferTo, setTransferTo] = React.useState<string | null>(null);
  const [menuFor, setMenuFor] = React.useState<string | null>(null);
  const [editing, setEditing] = React.useState<{ userId: string; draft: AccessDraft } | null>(null);
  const inviteRef = React.useRef<HTMLInputElement | null>(null);

  const load = React.useCallback(async () => {
    const r = await api<MembersPayload>(`/api/surveys/${surveyId}/members`);
    if (r.ok) { setData(r.data); setLoadError(null); } else setLoadError(r.error);
  }, [surveyId]);
  const loadHistory = React.useCallback(async () => {
    const r = await api<MembersPayload>(`/api/surveys/${surveyId}/members?include=activity`);
    if (r.ok) { setData(r.data); setHistory(r.data.activity ?? []); } else setNote({ text: r.error, ok: false });
  }, [surveyId]);
  React.useEffect(() => { void load(); }, [load]);
  React.useEffect(() => { if (tab === "history") void loadHistory(); }, [tab, loadHistory]);
  React.useEffect(() => { if (autoFocusInvite && data) inviteRef.current?.focus(); }, [autoFocusInvite, data]);

  const changed = () => { void load(); if (tab === "history") void loadHistory(); onChanged?.(); };
  const canShare = data?.canShare ?? canShareProp ?? false;
  const roles = (data?.grantableRoles ?? []).map((r) => r.value);

  /** why the signed-in person may not grant this — the server says the same, this only avoids offering it */
  const refusalFor = React.useCallback((target: MemberGrant): string | null => {
    if (!data?.myAccess || data.isPlatformAdmin || !isProjectRole(data.myAccess.role)) return null;
    const missing = escalation({ role: data.myAccess.role, permissions: data.myAccess.permissions, expiresAt: null }, target);
    return missing.length ? `You cannot grant permissions you do not have yourself (${missing.length}).` : null;
  }, [data]);
  const roleRefusal = (role: string) => (isProjectRole(role) && role !== "custom" ? refusalFor({ role }) : null);

  const pickRole = (role: string, current: AccessDraft): AccessDraft => ({
    ...current, role,
    permissions: role === "custom" ? current.permissions ?? permissionsFromGrant((isProjectRole(current.role) ? current.role : "viewer")) : null,
  });

  /* the lookup is explicit, not debounced-as-you-type: a User ID is short and
     a partial one resolves to somebody else's account */
  const doLookup = async () => {
    if (!q.trim()) return;
    setBusy("lookup"); setNote(null);
    const r = await api<Lookup>(`/api/surveys/${surveyId}/share?q=${encodeURIComponent(q.trim())}`);
    setBusy(null);
    if (r.ok) setLookup(r.data);
    else setNote({ text: r.error, ok: false });
  };

  const doShare = async () => {
    setBusy("share"); setNote(null);
    const r = await api<{ message?: string; kind?: string; inviteUrl?: string }>(
      `/api/surveys/${surveyId}/share`,
      { method: "POST", json: { identifier: q.trim(), ...draftBody(draft) } },
    );
    setBusy(null);
    if (!r.ok) { setNote({ text: r.error, ok: false }); return; }
    // an invitation cannot be emailed without mail configured, so the link is
    // handed over instead of being silently dropped
    setNote(r.data.kind === "invited" && r.data.inviteUrl
      ? { text: `${r.data.message} If they do not receive an email, send them this link: ${r.data.inviteUrl}`, ok: true }
      : { text: r.data.message ?? "Shared.", ok: true });
    setQ(""); setLookup(null); setDraft(emptyDraft(draft.role === "custom" ? "programmer" : draft.role)); setShowOptions(false);
    changed();
  };

  const patchMember = async (userId: string, body: Record<string, unknown>) => {
    setBusy(userId); setNote(null);
    const r = await api<{ lockReleased?: boolean; unchanged?: boolean; changes?: string[] }>(`/api/surveys/${surveyId}/members`, {
      method: "PATCH", json: { userId, ...body },
    });
    setBusy(null);
    if (!r.ok) { setNote({ text: r.error, ok: false }); return false; }
    setNote({
      text: r.data.unchanged ? "Nothing changed."
        : r.data.lockReleased ? "Access changed. They were editing, so the edit lock was released."
        : "Access changed.",
      ok: true,
    });
    changed();
    return true;
  };

  const remove = async (userId: string) => {
    setBusy(userId); setNote(null);
    const r = await api(`/api/surveys/${surveyId}/members`, { method: "DELETE", json: { userId } });
    setBusy(null); setConfirmRemove(null);
    setNote(r.ok ? { text: "Access removed.", ok: true } : { text: r.error, ok: false });
    changed();
  };

  const transfer = async (userId: string) => {
    setBusy(userId); setNote(null);
    const r = await api<{ message?: string }>(`/api/surveys/${surveyId}/transfer`, { method: "POST", json: { userId } });
    setBusy(null); setTransferTo(null);
    setNote(r.ok ? { text: r.data.message ?? "Ownership transferred.", ok: true } : { text: r.error, ok: false });
    changed();
  };

  const cancelInvite = async (invitationId: string) => {
    setBusy(invitationId);
    const r = await api(`/api/surveys/${surveyId}/share`, { method: "DELETE", json: { invitationId } });
    setBusy(null);
    setNote(r.ok ? { text: "Invitation cancelled.", ok: true } : { text: r.error, ok: false });
    changed();
  };

  const resendInvite = async (invitationId: string) => {
    setBusy(invitationId);
    const r = await api<{ message?: string; inviteUrl?: string; delivery?: string }>(`/api/surveys/${surveyId}/share`, { method: "PATCH", json: { invitationId, action: "resend" } });
    setBusy(null);
    setNote(r.ok
      ? { text: `${r.data.message ?? "Invitation sent again."}${r.data.delivery !== "sent" && r.data.inviteUrl ? ` Link: ${r.data.inviteUrl}` : ""}`, ok: true }
      : { text: r.error, ok: false });
    changed();
  };

  if (!data) {
    return loadError
      ? <div className="auth-note err" data-testid="collab-load-error">{loadError}</div>
      : <div className="muted">Loading collaborators…</div>;
  }

  const people = [...data.members].sort((a, b) => Number(b.isOwner) - Number(a.isOwner));
  const copyable = people.filter((m) => !m.isMe).map((m) => ({ userId: m.userId, name: m.name, role: m.role, permissions: m.permissions, isOwner: m.isOwner }));
  const amOwner = data.myRole === "owner";
  const inviteGrant = draftGrant(draft);
  const inviteRefusal = refusalFor(inviteGrant);
  const inviteBlocked = !!inviteRefusal || !!inviteGrant.expiryError;

  return (
    <div data-testid="collaborators-panel" className="cx-panel">
      <div className="cx-head">
        <h2>Project collaborators</h2>
        <span className="chip" data-testid="collab-count">{data.members.length} {data.members.length === 1 ? "person" : "people"}</span>
        <span className="grow" />
        <div className="cx-tabs" role="tablist" aria-label="Collaborators view">
          <button type="button" role="tab" className="cx-tab" aria-selected={tab === "people"} data-testid="collab-tab-people" onClick={() => setTab("people")}>People</button>
          <button type="button" role="tab" className="cx-tab" aria-selected={tab === "history"} data-testid="collab-tab-history" onClick={() => setTab("history")}>History</button>
        </div>
        <button className="btn small" onClick={() => changed()} aria-label="Refresh collaborators">↻ refresh</button>
      </div>

      {note && <div className={`auth-note ${note.ok ? "ok" : "err"}`} data-testid="collab-note" role="status">{note.text}</div>}

      {tab === "history" ? (
        <section aria-label="Access history" data-testid="collab-history">
          {!history && <p className="muted">Loading history…</p>}
          {history && history.length === 0 && <p className="muted" data-testid="history-empty">No access changes recorded yet.</p>}
          <ul className="cx-history">
            {(history ?? []).map((e) => (
              <li key={e.id} data-testid="history-entry" data-action={e.action}>
                <span className="cx-when" title={e.at}>{when(e.at)}</span>
                <span>{e.text}</span>
                {e.changes.length > 1 && <ul>{e.changes.map((c) => <li key={c}>{c}</li>)}</ul>}
              </li>
            ))}
          </ul>
        </section>
      ) : (
        <>
          {/* ------------------------------------------------ invite */}
          {canShare && (
            <div className="card" data-testid="share-box">
              <div className="flabel">Invite to this project</div>
              <p className="muted" style={{ fontSize: 13, marginTop: 0 }}>
                Enter an email address or a User ID (for example <span className="mono">USR-10482</span>). Colleagues can find
                their own User ID on their profile page.
              </p>
              <div className="cx-invite-row">
                <input
                  ref={inviteRef}
                  className="input" value={q} aria-label="Email address or User ID"
                  placeholder="name@company.com or USR-10482"
                  data-testid="share-identifier"
                  onChange={(e) => { setQ(e.target.value); setLookup(null); }}
                  onKeyDown={(e) => { if (e.key === "Enter") void doLookup(); }}
                />
                <AccessSelect value={draft.role} roles={roles} testId="share-role" refusal={roleRefusal}
                  onChange={(role) => { setDraft((d) => pickRole(role, d)); if (role === "custom") setShowOptions(true); }} />
                <button className="btn small" data-testid="share-lookup" disabled={!q.trim() || busy === "lookup"} onClick={() => void doLookup()}>
                  {busy === "lookup" ? "Looking…" : "Find"}
                </button>
              </div>
              <p className="muted" style={{ fontSize: 12.5, marginBottom: 0 }} data-testid="share-role-description">
                {draft.role === "custom" ? "Choose a level for each module below." : data.grantableRoles.find((r) => r.value === draft.role)?.description}
              </p>
              <button type="button" className="btn small cx-options-toggle" aria-expanded={showOptions || draft.role === "custom"}
                data-testid="access-options-toggle" onClick={() => setShowOptions((v) => !v)}>
                {showOptions || draft.role === "custom" ? "▾" : "▸"} Presets, custom permissions &amp; expiry
              </button>
              {(showOptions || draft.role === "custom") && (
                <AccessEditor draft={draft} onChange={setDraft} collaborators={copyable} idPrefix="invite" />
              )}

              {lookup && (
                <div className="card" style={{ padding: 10, marginTop: 10, marginBottom: 0 }} data-testid="share-lookup-result">
                  {lookup.found && lookup.user ? (
                    <>
                      <div className="row" style={{ flexWrap: "wrap" }}>
                        <span className="chip on">User found</span>
                        <strong style={{ fontSize: 14 }}>{lookup.user.name}</strong>
                        <span className="mono muted">{lookup.user.userCode}</span>
                        <span className="muted" style={{ fontSize: 13 }}>{lookup.user.email}</span>
                      </div>
                      {lookup.alreadyHasAccess && (
                        <p className="muted" style={{ fontSize: 13 }}>
                          Already has access as <strong>{lookup.currentAccessLabel ?? lookup.currentRole}</strong>. Sharing again changes their access.
                        </p>
                      )}
                      {lookup.differentOrganization && (
                        <p className="muted" style={{ fontSize: 13 }}>
                          This person is in a different organization. Sharing is what grants them access — they cannot see your
                          other projects.
                        </p>
                      )}
                      {lookup.user.disabled && <p style={{ fontSize: 13, color: "var(--red)" }}>Their account is disabled.</p>}
                      <AccessPreviewBox draft={draft} refusal={inviteRefusal} />
                      <button className="btn small primary" data-testid="share-submit" disabled={busy === "share" || lookup.user.disabled || inviteBlocked} onClick={() => void doShare()}>
                        {busy === "share" ? "Sharing…" : lookup.alreadyHasAccess ? "Change their access" : `Share as ${accessLabel(draft.role)}`}
                      </button>
                    </>
                  ) : (
                    <>
                      <div className="row"><span className="chip warn">Not found</span></div>
                      <p className="muted" style={{ fontSize: 13 }}>{lookup.note}</p>
                      {lookup.invitable && (
                        <>
                          <AccessPreviewBox draft={draft} refusal={inviteRefusal} />
                          <button className="btn small primary" data-testid="share-invite" disabled={busy === "share" || inviteBlocked} onClick={() => void doShare()}>
                            {busy === "share" ? "Inviting…" : "Send project invitation"}
                          </button>
                        </>
                      )}
                    </>
                  )}
                </div>
              )}
            </div>
          )}

          {/* ------------------------------------------------ the roster */}
          <div className="collab-group" data-testid="collab-roster">
            <h4>Collaborators</h4>
            {people.map((m) => {
              const label = m.isOwner ? "Owner" : m.accessLabel ?? m.roleLabel;
              const expiring = !m.expired && !!m.expiresAt;
              const isEditing = editing?.userId === m.userId;
              const before: MemberGrant = { role: isProjectRole(m.role) ? m.role : null, permissions: m.permissions ?? null, expiresAt: m.expiresAt ?? null };
              return (
                <div className="cx-row-wrap" key={m.userId}>
                  <div className={`collab-row ${m.isMe ? "is-me" : ""} ${m.expired ? "cx-is-expired" : ""}`} data-testid="collab-member" data-user={m.userCode} data-role={m.role} data-status={m.status ?? (m.isOwner ? "owner" : "active")}>
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
                      <span className="cx-member-access">
                        <span className={`chip ${m.isOwner ? "on" : ""}`} data-testid="member-access">{m.isOwner ? "🔒 Owner" : label}</span>
                        {m.expired && <span className="chip cx-expired" data-testid="member-expiry" data-state="expired">{m.expiryText ?? "Expired"}</span>}
                        {expiring && <span className="chip cx-expiring" data-testid="member-expiry" data-state="expiring">{m.expiryText ?? `Expires ${day(m.expiresAt)}`}</span>}
                      </span>
                    </span>

                    {data.canManage && m.changeable && !m.isOwner && (
                      <span className="cx-controls">
                        <AccessSelect value={m.role} roles={roles} testId="member-role" label={`Access for ${m.name}`} disabled={busy === m.userId} refusal={roleRefusal}
                          onChange={(role) => {
                            if (role === "custom") {
                              setEditing({ userId: m.userId, draft: { ...draftFrom(m), role: "custom", permissions: permissionsFromGrant(before) } });
                            } else void patchMember(m.userId, { role });
                          }} />
                        <span className="menu-anchor">
                          <button className="btn small" aria-haspopup="menu" aria-expanded={menuFor === m.userId} aria-label={`More actions for ${m.name}`}
                            data-testid="member-menu" onClick={() => setMenuFor((v) => (v === m.userId ? null : m.userId))}>⋮</button>
                          {menuFor === m.userId && (
                            <>
                              <div className="menu-scrim" onClick={() => setMenuFor(null)} />
                              <div className="menu" role="menu" style={{ right: 0, left: "auto" }}>
                                <button className="menu-item" role="menuitem" data-testid="member-edit"
                                  onClick={() => { setMenuFor(null); setEditing({ userId: m.userId, draft: draftFrom(m) }); }}>
                                  Change access &amp; expiry…
                                </button>
                                {amOwner && (
                                  <button className="menu-item" role="menuitem" data-testid="transfer-owner" onClick={() => { setMenuFor(null); setTransferTo(m.userId); }}>
                                    Make owner…
                                  </button>
                                )}
                                <div className="menu-sep" />
                                <button className="menu-item danger" role="menuitem" data-testid="member-menu-remove"
                                  onClick={() => { setMenuFor(null); setConfirmRemove(m.userId); }}>
                                  Remove access…
                                </button>
                              </div>
                            </>
                          )}
                        </span>
                        {transferTo === m.userId && (
                          <>
                            <span className="muted" style={{ fontSize: 12.5 }}>Make them the owner? You become an Editor.</span>
                            <button className="btn small danger" data-testid="transfer-confirm" onClick={() => void transfer(m.userId)}>Yes, transfer</button>
                            <button className="btn small" onClick={() => setTransferTo(null)}>Cancel</button>
                          </>
                        )}
                        {confirmRemove === m.userId ? (
                          <>
                            <button className="btn small danger" data-testid="member-remove-confirm" onClick={() => void remove(m.userId)}>Confirm remove</button>
                            <button className="btn small" onClick={() => setConfirmRemove(null)}>Cancel</button>
                          </>
                        ) : (
                          <button className="btn small danger" data-testid="member-remove" onClick={() => setConfirmRemove(m.userId)}>Remove</button>
                        )}
                      </span>
                    )}
                  </div>

                  {isEditing && editing && (
                    <div className="cx-edit" data-testid="member-editor">
                      <div className="cx-invite-row">
                        <span className="flabel" style={{ margin: 0 }}>Access for {m.name}</span>
                        <AccessSelect value={editing.draft.role} roles={roles} testId="edit-role" label={`Access for ${m.name}`} refusal={roleRefusal}
                          onChange={(role) => setEditing((e) => e && { ...e, draft: pickRole(role, e.draft) })} />
                      </div>
                      <AccessEditor draft={editing.draft} onChange={(d) => setEditing((e) => e && { ...e, draft: d })}
                        collaborators={copyable.filter((c) => c.userId !== m.userId)} idPrefix={`edit-${m.userId}`} />
                      <AccessPreviewBox draft={editing.draft} refusal={refusalFor(draftGrant(editing.draft))}
                        changes={diffAccess(before, draftGrant(editing.draft))} />
                      <div className="cx-edit-actions">
                        <button className="btn small" data-testid="edit-cancel" onClick={() => setEditing(null)}>Cancel</button>
                        <button className="btn small primary" data-testid="edit-save"
                          disabled={busy === m.userId || !!draftGrant(editing.draft).expiryError || !!refusalFor(draftGrant(editing.draft))}
                          onClick={async () => { if (await patchMember(m.userId, draftBody(editing.draft))) setEditing(null); }}>
                          Save access
                        </button>
                      </div>
                    </div>
                  )}
                </div>
              );
            })}
          </div>

          {/* ------------------------------------------------ pending invitations */}
          {data.invitations.length > 0 && (
            <div className="collab-group" data-testid="collab-invitations">
              <h4>Pending invitations</h4>
              <p className="desc">They get this access as soon as they accept — by the link, or by signing up with this address.</p>
              {data.invitations.map((i) => (
                <div className="collab-row collab-invite" key={i.id} data-testid="collab-invitation" data-email={i.email ?? ""}>
                  <span className="avatar" style={{ background: "var(--border)" }} aria-hidden="true">✉</span>
                  <span className="who">
                    <span className="nm">{i.email ?? i.userCode}</span>
                    <span className="meta">
                      {i.accessLabel ?? i.roleLabel} · invited {when(i.invitedAt)}
                      {i.resendCount ? ` · re-sent ${i.resendCount}×` : ""}
                      {" · "}{i.linkExpired ? "link expired" : `link valid until ${day(i.expiresAt)}`}
                      {i.accessExpiresAt ? ` · access until ${day(i.accessExpiresAt)}` : ""}
                    </span>
                  </span>
                  <span className="cx-controls">
                    {canShare && (
                      <button className="btn small" data-testid="invitation-resend" disabled={busy === i.id || i.linkExpired} onClick={() => void resendInvite(i.id)}>
                        Resend
                      </button>
                    )}
                    {data.canManage && (
                      <button className="btn small danger" data-testid="invitation-revoke" disabled={busy === i.id} onClick={() => void cancelInvite(i.id)}>
                        Cancel
                      </button>
                    )}
                  </span>
                </div>
              ))}
            </div>
          )}

          {!canShare && (
            <p className="muted" style={{ fontSize: 13 }}>
              Only the project&apos;s owner and the people they allow can share this project.
            </p>
          )}
        </>
      )}
    </div>
  );
}

/* ================================================================== the dialog (Workspace ⋯ menu, Overview) */

export function CollaboratorsDialog({
  surveyId, title, onClose, focusInvite = false, onChanged,
}: { surveyId: string; title?: string; onClose: () => void; focusInvite?: boolean; onChanged?: () => void }) {
  const ref = React.useRef<HTMLDivElement | null>(null);
  /* the latest onClose without re-running the effect: a host re-rendering must not steal focus back */
  const closeRef = React.useRef(onClose);
  closeRef.current = onClose;
  React.useEffect(() => {
    const opener = document.activeElement as HTMLElement | null;
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") closeRef.current(); };
    window.addEventListener("keydown", onKey);
    if (!focusInvite) ref.current?.querySelector<HTMLElement>("button, [href], input, select")?.focus();
    return () => { window.removeEventListener("keydown", onKey); opener?.focus?.(); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  return (
    <div className="modal-back" onClick={onClose} data-testid="collaborators-dialog">
      <div className="modal cx-dialog" role="dialog" aria-modal="true" aria-labelledby="cx-dialog-title" ref={ref}
        onClick={(e) => e.stopPropagation()}>
        <div className="cx-dialog-head">
          <h2 id="cx-dialog-title">Collaborators{title ? ` — ${title}` : ""}</h2>
          <button className="btn small" onClick={onClose} aria-label="Close" data-testid="collaborators-dialog-close">✕</button>
        </div>
        <div className="cx-dialog-body">
          <CollaboratorsManager surveyId={surveyId} autoFocusInvite={focusInvite} onChanged={onChanged} />
        </div>
      </div>
    </div>
  );
}

/* ================================================================== the Overview's avatar button */

/**
 * Beside "Open programming": who is on this project (avatars, "+N") and
 * "+ Invite". Both open the same dialog. Rendered only for someone who may
 * see the collaborator list (`project.read_members`); anyone else sees
 * nothing rather than a button that answers 403.
 */
export function CollaboratorsButton({ surveyId, title }: { surveyId: string; title?: string }) {
  const [data, setData] = React.useState<MembersPayload | null>(null);
  const [open, setOpen] = React.useState<null | "people" | "invite">(null);
  const load = React.useCallback(async () => {
    const r = await api<MembersPayload>(`/api/surveys/${surveyId}/members`);
    setData(r.ok ? r.data : null);
  }, [surveyId]);
  React.useEffect(() => { void load(); }, [load]);
  if (!data) return null;
  const shown = data.members.slice(0, 4);
  const more = data.members.length - shown.length;
  const canShare = data.canShare ?? data.canManage;
  return (
    <>
      <button type="button" className="btn cx-avatars-btn" data-testid="po-collaborators" onClick={() => setOpen("people")}
        aria-label={`Collaborators: ${data.members.map((m) => m.name).join(", ")}`} title="Collaborators and access">
        <span className="avatar-stack" aria-hidden="true">{shown.map((m) => <Avatar key={m.userId} m={m} size="sm" />)}</span>
        {more > 0 && <span className="cx-more" data-testid="po-collaborators-more">+{more}</span>}
      </button>
      {canShare && (
        <button type="button" className="btn" data-testid="po-invite" onClick={() => setOpen("invite")}>+ Invite</button>
      )}
      {open && (
        <CollaboratorsDialog surveyId={surveyId} title={title} focusInvite={open === "invite"}
          onClose={() => setOpen(null)} onChanged={() => void load()} />
      )}
    </>
  );
}

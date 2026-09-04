"use client";
import React from "react";
import { useStudio } from "./store";
import type { CollabState, CollabPresence } from "@/lib/useCollab";

/**
 * THE COLLABORATION BAR — what §14, §15 and §38 actually look like.
 *
 * One strip above the editor that answers, at a glance:
 *
 *     who else is in here      ● John Smith  Editing   ● Sarah Lee  Viewing
 *     what is my standing      Read-only · Reviewer
 *     what can I do about it   [ Enter edit mode ] / [ Request edit access ]
 *
 * The requirement's own wording is used deliberately — "You can view the
 * project, but editing is temporarily unavailable" — because a message that
 * says only "locked" leaves someone guessing whether it is broken or busy.
 *
 * Every fact here comes from the server's collaboration poll. The bar never
 * derives edit rights locally: if the server says read-only, this renders
 * read-only, whatever the client thinks happened.
 */

const clock = (iso: string | null | undefined) =>
  iso ? new Date(iso).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }) : "—";

function Avatar({ p, size = "" }: { p: { initials: string; hue: number; name: string }; size?: string }) {
  return (
    <span
      className={`avatar ${size}`.trim()}
      style={{ background: `hsl(${p.hue} 62% 45%)` }}
      title={p.name}
      aria-hidden="true"
    >
      {p.initials}
    </span>
  );
}

function Person({ p }: { p: CollabPresence }) {
  return (
    <span className="presence-person" data-testid="collab-person" data-user={p.userCode} data-activity={p.activity}>
      <Avatar p={p} size="sm" />
      <span className="who">
        <span className="nm">{p.isMe ? "You" : p.name}</span>
        <span className="act">
          <span className={`presence-dot ${p.activity === "editing" ? "editing" : ""}`} /> {p.activity}
        </span>
      </span>
    </span>
  );
}

export function CollabBar({
  collab, readOnly, busy, onEnter, onExit, onForce, onRequest, onOpenPanel,
}: {
  collab: CollabState | null;
  readOnly: boolean;
  busy: null | "acquire" | "release" | "force" | "request";
  onEnter: () => void;
  onExit: () => void;
  onForce: (reason?: string) => void;
  onRequest: (message?: string) => void;
  onOpenPanel: (panel: "collaborators" | "notes" | "activity") => void;
}) {
  const s = useStudio();
  const [confirmForce, setConfirmForce] = React.useState(false);
  const [requested, setRequested] = React.useState(false);

  // a fresh request is possible once the holder changes or the lock frees
  const holderId = collab?.lock.heldBy?.userId ?? null;
  React.useEffect(() => { setRequested(false); setConfirmForce(false); }, [holderId]);

  if (!collab) {
    return <div className="lockbar" data-testid="collab-bar"><span className="muted">Checking project access…</span></div>;
  }

  const { lock, me, presence } = collab;
  const others = presence.filter((p) => !p.isMe);
  const tone = lock.banner.tone;

  return (
    <div className={`lockbar ${tone}`} data-testid="collab-bar" data-tone={tone} data-readonly={readOnly ? "1" : "0"}>
      <span className="lock-icon" aria-hidden="true">
        {tone === "mine" ? "✎" : tone === "other" ? "🔒" : tone === "stale" ? "⚠" : "○"}
      </span>
      <span className="lb-title" data-testid="collab-title">{lock.banner.title}</span>
      {lock.banner.detail && <span className="lb-detail" data-testid="collab-detail">{lock.banner.detail}</span>}

      <span className="grow" />

      {/* who is here — the requirement's PROJECT USERS list, compressed to a
          strip and expandable into the full panel */}
      {others.length > 0 && (
        <button
          type="button"
          className="btn small"
          data-testid="collab-presence"
          title={others.map((p) => `${p.name} — ${p.activity}`).join("\n")}
          onClick={() => onOpenPanel("collaborators")}
        >
          <span className="avatar-stack">
            {others.slice(0, 4).map((p) => <Avatar key={p.userId + p.userCode} p={p} size="sm" />)}
          </span>
          {others.length > 4 ? ` +${others.length - 4}` : ""}
        </button>
      )}
      {others.length > 0 && (
        <span className="presence-bar" data-testid="collab-people">
          {others.slice(0, 2).map((p) => <Person key={p.userId + p.userCode} p={p} />)}
        </span>
      )}

      {collab.openComments > 0 && (
        <button type="button" className="btn small" data-testid="collab-notes-count" onClick={() => onOpenPanel("notes")}>
          {collab.openComments} open note{collab.openComments === 1 ? "" : "s"}
        </button>
      )}

      {/* my standing, said plainly rather than implied by greyed-out controls */}
      <span className={`chip ${readOnly ? "" : "on"} card-role`} data-testid="collab-role" title={me.roleSummary}>
        {readOnly ? "Read-only" : "Editing"} · {me.role ?? "no access"}
      </span>

      {/* ------------------------------------------------ the actions */}
      {!me.canEdit && (
        <span className="muted" style={{ fontSize: 11.5 }} data-testid="collab-cannot-edit">
          Your role cannot change this project.
        </span>
      )}

      {me.canEdit && lock.mine && (
        <button
          type="button" className="btn small" data-testid="collab-exit-edit"
          disabled={busy === "release"}
          onClick={() => {
            // an unsaved edit must not be dropped on the floor by handing the
            // lock over: flush first, then release (§28, §29)
            if (s.dirty) { void s.flushDraft().then(() => onExit()); return; }
            onExit();
          }}
        >
          {busy === "release" ? "Leaving…" : "Leave edit mode"}
        </button>
      )}

      {me.canEdit && !lock.mine && (tone === "free" || tone === "stale") && (
        <button
          type="button" className="btn small primary" data-testid="collab-enter-edit"
          disabled={busy === "acquire"}
          onClick={onEnter}
        >
          {busy === "acquire" ? "Starting…" : tone === "stale" ? "Take over editing" : "Enter edit mode"}
        </button>
      )}

      {/* someone else is genuinely working: ask, do not seize (§30) */}
      {me.canEdit && !lock.mine && tone === "other" && (
        requested ? (
          <span className="chip on" data-testid="collab-requested">Request sent to {lock.heldBy?.name}</span>
        ) : (
          <button
            type="button" className="btn small" data-testid="collab-request"
            disabled={busy === "request"}
            onClick={() => { onRequest(); setRequested(true); }}
          >
            {busy === "request" ? "Asking…" : "Request edit access"}
          </button>
        )
      )}

      {/* and only an owner or administrator may take it (§30), with a
          confirmation, because it interrupts somebody's work */}
      {me.canForceRelease && !lock.mine && (tone === "other" || tone === "stale") && (
        confirmForce ? (
          <>
            <span className="muted" style={{ fontSize: 11.5 }}>
              Release {lock.heldBy?.name}&apos;s lock? Their unsaved changes stay unsaved.
            </span>
            <button
              type="button" className="btn small danger" data-testid="collab-force-confirm"
              disabled={busy === "force"}
              onClick={() => { onForce("owner_takeover"); setConfirmForce(false); }}
            >
              {busy === "force" ? "Releasing…" : "Yes, release it"}
            </button>
            <button type="button" className="btn small" onClick={() => setConfirmForce(false)}>Cancel</button>
          </>
        ) : (
          <button type="button" className="btn small danger" data-testid="collab-force" onClick={() => setConfirmForce(true)}>
            Force release lock
          </button>
        )
      )}
    </div>
  );
}

/**
 * The in-panel read-only notice.
 *
 * The bar above says the same thing, but a programmer deep in the Questions
 * panel is not looking at the bar — they are looking at the field that will
 * not accept their typing. §19 asks for editing controls to be clearly
 * disabled; this is the sentence that explains why they are.
 */
export function ReadOnlyNotice({
  collab, onEnter, busy,
}: {
  collab: CollabState | null;
  onEnter: () => void;
  busy: null | "acquire" | "release" | "force" | "request";
}) {
  if (!collab || !collab.me.readOnly) return null;
  const { lock, me } = collab;
  const holder = lock.heldBy;
  /*
   * A lock whose holder has signed out belongs to nobody (P0-8). Naming them
   * as "currently editing" would send a colleague off to ask a question that
   * has no answer, and the project is in fact about to become available.
   */
  const holderIsPresent = !!holder && lock.status === "held" && holder.sessionLive !== false;

  return (
    <div className="readonly-banner" data-testid="readonly-notice">
      <span aria-hidden="true">🔒</span>
      <span>
        {holderIsPresent && !lock.mine ? (
          <>
            <strong>{holder!.name}</strong> is editing this project (since {clock(holder!.since)}). You can view
            everything, but changes are unavailable until the editing lock is released.
          </>
        ) : holder && !lock.mine ? (
          <>
            <strong>{holder.name}</strong> left this project open but is no longer signed in, so editing is
            becoming available again. Nothing of theirs is lost — their work was saved as they went.
          </>
        ) : !me.canEdit ? (
          <>
            {/*
              * WHERE the access came from, not just what it is (P0-1).
              *
              * This used to read "You have viewer access to this project" and
              * stop there. A colleague whose access came from a workspace
              * default would go looking for themselves in a member list that
              * has never mentioned them, conclude the sharing was broken, and
              * ask the owner to fix something the owner cannot see. Naming the
              * workspace points at a setting an administrator can change, and
              * naming a share points at the person who made it.
              */}
            You have <strong>{me.role}</strong> access to this project. {me.roleSummary}
            {me.roleSourceNote ? <> {me.roleSourceNote}</> : null}
            {me.roleSource === "workspace"
              ? <> To make changes, ask the project’s owner to share it with you directly.</>
              : null}
          </>
        ) : (
          // the collaboration poll is already asking for the lock; this is the
          // moment before it answers, not a workflow step to complete
          <>Preparing edit mode…{me.roleSourceNote ? <> {me.roleSourceNote}</> : null}</>
        )}
      </span>
      {me.canEdit && (!holderIsPresent || lock.mine) && (
        <button type="button" className="btn small primary" data-testid="readonly-enter" data-ro-ok disabled={busy === "acquire"} onClick={onEnter}>
          {busy === "acquire" ? "Starting…" : "Take editing"}
        </button>
      )}
    </div>
  );
}

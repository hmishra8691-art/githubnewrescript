"use client";
import React from "react";

/**
 * THE CLIENT SIDE OF COLLABORATION.
 *
 * One hook, one endpoint, one interval. It polls `/api/surveys/<id>/collab`,
 * which both reports this client's presence and returns everything that can
 * have changed underneath it: who is here, who is editing, whether this
 * client still holds the lock, and what its role permits.
 *
 * THE KEY INVARIANT: `readOnly` comes from the SERVER, every tick. The client
 * never decides it can edit. So when a lock is taken away, expires, or the
 * user's role is downgraded, this client drops into read-only within one
 * interval — without a refresh (§31, §38) — rather than staying editable
 * until a save is refused.
 *
 * Written so that swapping the transport for Supabase Realtime later changes
 * this file and nothing else: the shape the UI consumes would not move.
 */

export interface CollabPresence {
  userId: string;
  userCode: string;
  name: string;
  role: string;
  activity: "editing" | "viewing" | "reviewing" | "testing";
  lastSeenAt: string;
  initials: string;
  hue: number;
  isMe: boolean;
}

export interface CollabState {
  project: { id: string; code: string; title: string; status: string; locked: boolean };
  me: {
    userId: string; userCode: string; name: string; sessionId: string;
    role: string | null; roleSummary: string; viaAdmin: boolean;
    capabilities: string[];
    canEdit: boolean; canShare: boolean; canManageMembers: boolean;
    canForceRelease: boolean; canComment: boolean;
    readOnly: boolean;
  };
  lock: {
    status: "free" | "held" | "stale" | "released" | "expired";
    mine: boolean;
    banner: { tone: "free" | "mine" | "other" | "stale"; title: string; detail?: string };
    heldBy: { userId: string; name: string | null; userCode: string | null; since: string; lastActive: string; section: string | null } | null;
  };
  presence: CollabPresence[];
  openComments: number;
  poll: { presenceSeconds: number; lockSeconds: number; sessionSeconds: number };
}

export type CollabStatus = "loading" | "ready" | "denied" | "error";

export function useCollab(surveyId: string | null, opts: { section?: string | null } = {}) {
  const [state, setState] = React.useState<CollabState | null>(null);
  const [status, setStatus] = React.useState<CollabStatus>("loading");
  const [error, setError] = React.useState<string | null>(null);
  const [busy, setBusy] = React.useState<null | "acquire" | "release" | "force" | "request">(null);

  /**
   * What this client BELIEVES about its own edit mode, kept in a ref.
   *
   * It is sent to the server so the poll can double as the lock heartbeat, and
   * it is only ever a claim — the server's `readOnly` is what the UI obeys. A
   * client that thinks it is editing while the server disagrees simply stops
   * being sent lock heartbeats and falls back to read-only.
   */
  const editingRef = React.useRef(false);

  const poll = React.useCallback(async (report: boolean) => {
    if (!surveyId) return;
    const qs = new URLSearchParams();
    if (editingRef.current) qs.set("editing", "1");
    if (opts.section) qs.set("section", opts.section);
    try {
      const res = await fetch(`/api/surveys/${surveyId}/collab?${qs}`, {
        method: report ? "POST" : "GET",
        cache: "no-store",
      });
      if (res.status === 401) { setStatus("denied"); setError("Your session has ended."); return; }
      if (res.status === 403 || res.status === 404) {
        const j = await res.json().catch(() => ({}));
        setStatus("denied");
        setError(j?.error ?? "You do not have access to this project.");
        return;
      }
      if (!res.ok) { setStatus("error"); return; }
      const data = (await res.json()) as CollabState;
      // the server is the authority on whether we are editing
      editingRef.current = data.lock.mine;
      setState(data);
      setStatus("ready");
      setError(null);
    } catch {
      /* transient: keep the last known state rather than blanking the UI */
    }
  }, [surveyId, opts.section]);

  React.useEffect(() => { void poll(true); }, [poll]);

  React.useEffect(() => {
    if (!surveyId || status === "denied") return;
    const seconds = Math.max(3, state?.poll.presenceSeconds ?? 15);
    const id = setInterval(() => { void poll(true); }, seconds * 1000);
    return () => clearInterval(id);
  }, [surveyId, status, state?.poll.presenceSeconds, poll]);

  /*
   * Leaving the page gives the lock back at once (§29), so a colleague is not
   * made to wait out the stale timer just because someone closed a tab. Sent
   * with `keepalive` because an ordinary fetch is cancelled during unload.
   */
  React.useEffect(() => {
    if (!surveyId) return;
    const release = () => {
      if (!editingRef.current) return;
      try {
        fetch(`/api/surveys/${surveyId}/lock`, {
          method: "POST", keepalive: true,
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ action: "release", reason: "left_page" }),
        });
      } catch { /* nothing useful to do while the page is going away */ }
    };
    window.addEventListener("pagehide", release);
    return () => { window.removeEventListener("pagehide", release); release(); };
  }, [surveyId]);

  const act = React.useCallback(async (
    action: "acquire" | "release" | "force_release" | "request",
    extra: Record<string, unknown> = {},
  ) => {
    if (!surveyId) return { ok: false as const, error: "No project." };
    setBusy(action === "force_release" ? "force" : action === "request" ? "request" : action);
    try {
      const res = await fetch(`/api/surveys/${surveyId}/lock`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ action, section: opts.section ?? null, ...extra }),
      });
      const data = await res.json().catch(() => ({}));
      if (action === "acquire") editingRef.current = !!data?.acquired;
      if (action === "release" || action === "force_release") editingRef.current = false;
      // read the shared state back straight away, so the banner and the
      // presence list update in the same interaction rather than one tick later
      await poll(true);
      return res.ok
        ? { ok: true as const, data }
        : { ok: false as const, error: data?.error ?? `Failed (${res.status})`, data };
    } catch (e) {
      return { ok: false as const, error: (e as Error).message };
    } finally {
      setBusy(null);
    }
  }, [surveyId, opts.section, poll]);

  return {
    state,
    status,
    error,
    busy,
    /** the one flag the editor UI hangs off; read-only until proven otherwise */
    readOnly: state?.me.readOnly ?? true,
    enterEditMode: () => act("acquire"),
    exitEditMode: () => act("release"),
    forceRelease: (reason?: string) => act("force_release", { reason }),
    requestAccess: (message?: string) => act("request", { message }),
    refresh: () => poll(false),
  };
}

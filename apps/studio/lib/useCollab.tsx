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
    /** owner / member / workspace — why this user has the access they have (P0-1) */
    roleSource: "owner" | "member" | "workspace" | "none";
    roleSourceNote: string | null;
    capabilities: string[];
    canEdit: boolean; canShare: boolean; canManageMembers: boolean;
    canForceRelease: boolean; canComment: boolean;
    readOnly: boolean;
  };
  lock: {
    status: "free" | "held" | "stale" | "orphaned" | "released" | "expired";
    mine: boolean;
    banner: { tone: "free" | "mine" | "other" | "stale"; title: string; detail?: string };
    heldBy: {
      userId: string; name: string | null; userCode: string | null;
      since: string; lastActive: string; section: string | null;
      /** false when the holder has signed out — the lock is theirs in name only */
      sessionLive: boolean;
    } | null;
  };
  presence: CollabPresence[];
  openComments: number;
  poll: { presenceSeconds: number; lockSeconds: number; sessionSeconds: number };
}

export type CollabStatus = "loading" | "ready" | "denied" | "error";

export function useCollab(
  surveyId: string | null,
  opts: {
    section?: string | null;
    /**
     * What this client is here to DO.
     *
     * `"edit"` means "put me in edit mode if the project is free" — which is
     * what somebody who opened a survey to work on it wants, and what they
     * used to have to ask for by finding a button. `"view"` never touches the
     * lock, so a reviewer reading a project cannot take editing away from
     * anyone by opening it.
     */
    intent?: "edit" | "view";
  } = {},
) {
  const [state, setState] = React.useState<CollabState | null>(null);
  const [status, setStatus] = React.useState<CollabStatus>("loading");
  const [error, setError] = React.useState<string | null>(null);
  const [busy, setBusy] = React.useState<null | "acquire" | "release" | "force" | "request">(null);

  /**
   * WHETHER THIS CLIENT WANTS TO BE EDITING — which is not the same as whether
   * it is, and conflating the two was a bug.
   *
   * This ref used to be set from `data.lock.mine`: the client told the server
   * "I am editing" only once it already held the lock. Combined with a server
   * that acquires the lock for a client that says it is editing, that is a
   * deadlock — the flag could never turn on by itself, so a user who opened a
   * free project sat in read-only until they found the button, typed into a
   * form that was not going to save, or both.
   *
   * Intent and possession are now separate. This is the intent, and it is a
   * request; `holdsRef` is the possession, and only the server decides it.
   */
  const wantsEditRef = React.useRef(opts.intent === "edit");
  const holdsRef = React.useRef(false);

  // a change of intent (switching to an editing tab, say) takes effect on the
  // next tick without remounting the hook
  React.useEffect(() => {
    if (opts.intent === "edit") wantsEditRef.current = true;
    if (opts.intent === "view") wantsEditRef.current = false;
  }, [opts.intent]);

  const poll = React.useCallback(async (report: boolean) => {
    if (!surveyId) return;
    const qs = new URLSearchParams();
    if (wantsEditRef.current) qs.set("editing", "1");
    if (opts.section) qs.set("section", opts.section);
    try {
      const res = await fetch(`/api/surveys/${surveyId}/collab?${qs}`, {
        method: report ? "POST" : "GET",
        cache: "no-store",
      });
      if (res.status === 401) {
        /*
         * The session has ended. `denied` stops the polling, shows a banner
         * and — critically — does NOT navigate. Anything in the editor is
         * unsaved work, and throwing the page away to show a login form would
         * destroy it (§24). The server has already cleared the cookie, so
         * signing back in is one click and lands on a working login screen.
         */
        const j = await res.json().catch(() => ({}));
        setStatus("denied");
        setError(j?.error ?? "Your session has ended.");
        return;
      }
      if (res.status === 403 || res.status === 404) {
        const j = await res.json().catch(() => ({}));
        setStatus("denied");
        setError(j?.error ?? "You do not have access to this project.");
        return;
      }
      if (!res.ok) { setStatus("error"); return; }
      const data = (await res.json()) as CollabState;

      // possession: the server's word, never inferred
      holdsRef.current = data.lock.mine;

      /*
       * Somebody else is genuinely in there. Stop asking on every tick — the
       * server would refuse each attempt harmlessly, but the user's answer is
       * now a decision rather than a retry ("request access", or take over a
       * lock the policy allows), so the UI stops pretending it is about to
       * get in. Wanting to edit resumes the moment the project is free again.
       */
      if (!data.lock.mine && data.lock.status === "held" && data.lock.heldBy?.sessionLive) {
        wantsEditRef.current = false;
      } else if (opts.intent === "edit" && !data.lock.mine) {
        wantsEditRef.current = true;
      }

      setState(data);
      setStatus("ready");
      setError(null);
    } catch {
      /* transient: keep the last known state rather than blanking the UI */
    }
  }, [surveyId, opts.section, opts.intent]);

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
      // only give back a lock we actually hold; "wanted to edit" is not a
      // reason to send a release nobody asked for
      if (!holdsRef.current) return;
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
      /*
       * An explicit click is an explicit intent, and it overrides the
       * "somebody else has it, stop asking" rule above — that rule exists to
       * stop a background poll churning, not to stop a person trying.
       */
      if (action === "acquire") { wantsEditRef.current = true; holdsRef.current = !!data?.acquired; }
      if (action === "force_release") wantsEditRef.current = true;
      if (action === "release") { wantsEditRef.current = false; holdsRef.current = false; }
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

"use client";
import React from "react";

/**
 * THE CLIENT'S VIEW OF ITS OWN SESSION.
 *
 * Two jobs, and both are about honesty rather than convenience:
 *
 *   1. it sends the heartbeat, at the interval the SERVER chose. The cadence
 *      arrives in the `/api/auth/me` payload, so §7's "configurable rather
 *      than hardcoded" holds all the way to the browser — change the setting
 *      and every client picks it up on its next load without a deploy.
 *
 *   2. it notices when the session ends and says so. A revoked or expired
 *      session used to be discovered by the next real action failing, which
 *      leaves someone typing into a form that has quietly stopped working.
 *      Here it surfaces within one interval, with the reason, and the app can
 *      show the login screen instead.
 *
 * Nothing here is authoritative. The server decides; this only reflects.
 */

export interface SessionUser {
  userId: string;
  userCode: string;
  name: string;
  email: string;
  platformRole: string;
  isPlatformAdmin: boolean;
  sessionId: string;
  organization?: string | null;
  jobTitle?: string | null;
  createdAt?: string | null;
  lastLoginAt?: string | null;
  accountStatus?: string;
  unread?: number;
  policies: {
    heartbeatSeconds: number;
    lockHeartbeatSeconds: number;
    presenceHeartbeatSeconds: number;
    idleAfterSeconds: number;
    staleAfterSeconds: number;
    lockStaleAfterSeconds: number;
  };
}

export type SessionState =
  | { kind: "loading" }
  | { kind: "signed_in"; user: SessionUser }
  | { kind: "signed_out"; reason?: string; code?: string };

/** Signed out mid-session: the words differ, and which one shows matters. */
const REASONS: Record<string, string> = {
  session_revoked: "An administrator ended this session.",
  session_logged_out: "You have been signed out.",
  session_expired: "Your session expired after a period of inactivity.",
  /*
   * §12's other side. Telling somebody who signed in on their laptop thirty
   * seconds ago that their desktop session "expired after a period of
   * inactivity" reads as a bug and produces a support ticket; saying what
   * actually happened produces an "oh, right".
   */
  session_taken_over: "You signed in on another device, so this session was ended.",
  account_disabled: "This account has been disabled.",
  unknown_session: "Your session is no longer valid.",
  session_unavailable: "",
  no_session: "",
};

export function useSession(options: { redirectOnSignOut?: boolean } = {}) {
  const [state, setState] = React.useState<SessionState>({ kind: "loading" });
  const stateRef = React.useRef<SessionState>(state);
  stateRef.current = state;

  const load = React.useCallback(async () => {
    try {
      const r = await fetch("/api/auth/me", { cache: "no-store" });
      if (r.status === 401 || r.status === 403) {
        const j = await r.json().catch(() => ({}));
        setState({ kind: "signed_out", reason: REASONS[j?.code] ?? j?.error, code: j?.code });
        return;
      }
      /*
       * A transient failure is not a sign-out — and 503 is now explicitly
       * that: the gate answers 503 when it could not REACH the database, as
       * opposed to 401 when it checked and the session is gone. Treating
       * "cannot check" as "signed out" would empty every open tab on a blip.
       */
      if (!r.ok) return;
      setState({ kind: "signed_in", user: (await r.json()) as SessionUser });
    } catch {
      /* offline: keep whatever we had rather than throwing the user out */
    }
  }, []);

  React.useEffect(() => { void load(); }, [load]);

  // the heartbeat, at the server's interval
  React.useEffect(() => {
    if (state.kind !== "signed_in") return;
    const seconds = Math.max(10, state.user.policies.heartbeatSeconds);
    let cancelled = false;
    const tick = async () => {
      try {
        const r = await fetch("/api/auth/heartbeat", { method: "POST", cache: "no-store" });
        if (cancelled) return;
        if (r.status === 401) {
          const j = await r.json().catch(() => ({}));
          setState({ kind: "signed_out", reason: REASONS[`session_${j?.status}`] ?? "Your session has ended.", code: `session_${j?.status}` });
        }
      } catch {
        /* a missed heartbeat is not a sign-out; the next one will tell us */
      }
    };
    const id = setInterval(tick, seconds * 1000);
    return () => { cancelled = true; clearInterval(id); };
  }, [state.kind, state.kind === "signed_in" ? state.user.policies.heartbeatSeconds : 0]);

  React.useEffect(() => {
    if (state.kind === "signed_out" && options.redirectOnSignOut) {
      const reason = state.code && state.code !== "no_session" ? `?reason=${encodeURIComponent(state.code)}` : "";
      const next = typeof window !== "undefined" && window.location.pathname !== "/login"
        ? `${reason ? "&" : "?"}next=${encodeURIComponent(window.location.pathname)}`
        : "";
      window.location.href = `/login${reason}${next}`;
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state.kind]);

  const signOut = React.useCallback(async () => {
    try { await fetch("/api/auth/logout", { method: "POST" }); } catch { /* ignore */ }
    window.location.href = "/login";
  }, []);

  return { state, reload: load, signOut };
}

/**
 * A small helper for the many "fetch JSON and surface the error" call sites.
 *
 * The failure branch carries `retryAfterSeconds` because a 429 puts the wait
 * in the `retry-after` HEADER, not the body — an earlier version of this
 * helper discarded the response and left the login screen unable to show a
 * countdown without parsing it back out of the prose.
 */
export async function api<T = any>(
  url: string,
  init?: RequestInit & { json?: unknown },
): Promise<
  | { ok: true; data: T }
  | { ok: false; error: string; status: number; data?: any; retryAfterSeconds?: number }
> {
  try {
    const res = await fetch(url, {
      ...init,
      cache: "no-store",
      headers: init?.json ? { "content-type": "application/json", ...(init?.headers ?? {}) } : init?.headers,
      body: init?.json !== undefined ? JSON.stringify(init.json) : init?.body,
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      const retry = Number(res.headers.get("retry-after"));
      return {
        ok: false,
        error: data?.error ?? `Request failed (${res.status})`,
        status: res.status,
        data,
        retryAfterSeconds: Number.isFinite(retry) && retry > 0 ? retry : undefined,
      };
    }
    return { ok: true, data: data as T };
  } catch (e) {
    return { ok: false, error: (e as Error).message || "Network error", status: 0 };
  }
}

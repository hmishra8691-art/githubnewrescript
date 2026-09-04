"use client";
import React from "react";

/**
 * SIGN IN.
 *
 * The interesting screen here is not the happy path, it is the 409: the
 * account is already signed in somewhere else and the server refuses to
 * silently steal that session. Someone who hits it has typed the right
 * password and is still not in, so the screen has to answer three questions
 * without being asked — where is the other session, is it still being used,
 * and what do I do now.
 */

/** Why we are looking at this screen, when we arrived from somewhere else. */
const REASONS: Record<string, string> = {
  session_expired: "Your session expired after a period of inactivity. Please sign in again.",
  session_revoked: "An administrator ended your session.",
  session_logged_out: "You have been signed out.",
  account_disabled: "This account has been disabled.",
  /*
   * §12's other side. Somebody who signed in on a laptop and came back to a
   * desktop needs to be told what actually happened — being shown "your
   * session expired after a period of inactivity" when they were using it
   * thirty seconds ago reads as a bug and generates a support ticket.
   */
  session_taken_over: "You signed in on another device, so this session was ended. Sign in again to continue here.",
};

interface ExistingSession {
  device?: string | null;
  since?: string | null;
  lastActive?: string | null;
  status?: string | null;
}

interface Conflict {
  message: string;
  existing: ExistingSession;
  releasedAfterSeconds: number;
  /**
   * Whether this screen may offer to end the other session. The server always
   * sends it today (§12 requires a way through), but it is read defensively so
   * that a future policy which genuinely forbids takeover shows the wait-it-out
   * advice instead of a button that would be refused.
   */
  canConfirmTakeover?: boolean;
}

/**
 * Times are shown as a clock reading, because the whole point is "is that
 * other session live right now" — the full ISO stamp answers a question
 * nobody asked. A stamp from another day gets its date back, otherwise
 * "10:01" would quietly mean yesterday.
 */
function whenLabel(iso: string | null | undefined): string | null {
  if (!iso) return null;
  const ms = Date.parse(iso);
  if (Number.isNaN(ms)) return null;
  const d = new Date(ms);
  const time = d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  const sameDay = d.toDateString() === new Date().toDateString();
  return sameDay ? time : `${d.toLocaleDateString([], { day: "numeric", month: "short" })}, ${time}`;
}

function minutesLabel(seconds: number): string {
  const m = Math.max(1, Math.round(seconds / 60));
  return `${m} minute${m === 1 ? "" : "s"}`;
}

const STATUS_WORDS: Record<string, string> = {
  active: "in use right now",
  idle: "signed in but quiet",
  expired: "already released",
};

export default function LoginForm() {
  const [identifier, setIdentifier] = React.useState("");
  const [password, setPassword] = React.useState("");
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const [conflict, setConflict] = React.useState<Conflict | null>(null);
  const [notice, setNotice] = React.useState<string | null>(null);
  const [retryIn, setRetryIn] = React.useState(0);
  const [next, setNext] = React.useState("/");

  /*
   * The query string is read from `window.location` in an effect rather than
   * with `useSearchParams`, which would opt this page out of static rendering
   * and force a Suspense boundary for no gain: nothing here needs the value
   * before the first paint.
   */
  React.useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const reason = params.get("reason");
    if (reason && REASONS[reason]) setNotice(REASONS[reason]);
    const target = params.get("next");
    // only same-origin paths, and "//evil.example" is a URL, not a path
    if (target && target.startsWith("/") && !target.startsWith("//")) setNext(target);
  }, []);

  // the throttle countdown; one timer per remaining second keeps it honest
  // even if the tab was backgrounded and coalesced the ticks
  React.useEffect(() => {
    if (retryIn <= 0) return;
    const id = window.setTimeout(() => setRetryIn((n) => Math.max(0, n - 1)), 1000);
    return () => window.clearTimeout(id);
  }, [retryIn]);

  /**
   * `force` is the person saying "yes, end my other session".
   *
   * It only ever reaches here from a button the user pressed after being shown
   * which device and since when — never from a retry, and never by default.
   * That is the difference between §12's "the new session must work" and the
   * original requirement's "do not SILENTLY invalidate the first session":
   * this is not silent, it is asked.
   */
  const submit = async (e?: React.FormEvent, force = false) => {
    e?.preventDefault();
    if (busy || retryIn > 0) return;
    setBusy(true);
    setError(null);
    setConflict(null);
    setNotice(null);
    let leaving = false;
    try {
      /*
       * Deliberately a bare `fetch` rather than the `api()` helper: a 429
       * carries its wait in the `retry-after` HEADER and the helper hands back
       * only the parsed body, so the countdown would have to be guessed from
       * the prose of the message.
       */
      const res = await fetch("/api/auth/login", {
        method: "POST",
        cache: "no-store",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ identifier, password, force }),
      });
      const data = await res.json().catch(() => ({} as any));

      if (res.ok) {
        // a full navigation, not a router push — the session cookie was just
        // set and the middleware has to run again to see it
        leaving = true;
        window.location.href = next;
        return;
      }

      if (res.status === 409 && data?.code === "session_conflict") {
        setConflict({
          message: data?.error ?? "This account is already logged in elsewhere.",
          existing: (data?.existingSession ?? {}) as ExistingSession,
          releasedAfterSeconds: Number(data?.releasedAfterSeconds ?? 0),
          canConfirmTakeover: data?.canConfirmTakeover !== false,
        });
        return;
      }

      if (res.status === 429) {
        const header = Number(res.headers.get("retry-after"));
        setError(data?.error ?? "Too many sign-in attempts. Please try again later.");
        if (Number.isFinite(header) && header > 0) setRetryIn(Math.ceil(header));
        return;
      }

      setError(data?.error ?? `Sign-in failed (${res.status}).`);
    } catch {
      setError("Could not reach the server. Check your connection and try again.");
    } finally {
      // on success the page is already leaving; re-enabling the button would
      // only flash it back to life mid-navigation
      if (!leaving) setBusy(false);
    }
  };

  const since = whenLabel(conflict?.existing.since);
  const lastActive = whenLabel(conflict?.existing.lastActive);
  const statusWord = conflict?.existing.status ? STATUS_WORDS[conflict.existing.status] : null;

  return (
    <div className="auth-shell">
      <div className="auth-card">
        <div className="auth-brand">SURVEY PROGRAMMING PLATFORM</div>
        <h1 className="auth-title">Sign in</h1>
        <p className="auth-sub">Use your User ID or the email address on your account.</p>

        {notice && !error && !conflict && (
          <div className="auth-note info" data-testid="login-notice">{notice}</div>
        )}

        {conflict && (
          <div className="auth-note err" data-testid="login-conflict">
            <strong>{conflict.message}</strong>
            <div style={{ marginTop: 6 }}>
              {[
                conflict.existing.device || "An unrecognised device",
                since ? `signed in at ${since}` : null,
                lastActive ? `last active ${lastActive}` : null,
                statusWord,
              ]
                .filter(Boolean)
                .join(" · ")}
            </div>
            <div style={{ marginTop: 6 }}>
              You can sign in here and end that session, or sign out on that device first.
              Left alone, it releases itself after {minutesLabel(conflict.releasedAfterSeconds)} with
              no activity.
            </div>
            <div className="auth-actions" style={{ marginTop: 8 }}>
              {/*
                * THE WAY OUT. Without this the screen is a wall: correct
                * password, no entry, come back in fifteen minutes — which is
                * the P0-2 experience, and what §12 replaced. It is a separate,
                * explicitly-labelled button rather than a silent retry,
                * because ending a session that may hold unsaved work is the
                * user's decision to make and nobody else's.
                */}
              {conflict.canConfirmTakeover !== false && (
                <button
                  className="btn primary" type="button" data-testid="login-takeover"
                  onClick={() => void submit(undefined, true)} disabled={busy}
                >
                  {busy ? "Signing in…" : "Sign in here and end the other session"}
                </button>
              )}
              <button className="btn" type="button" data-testid="login-retry"
                onClick={() => void submit()} disabled={busy}>
                {busy ? "Trying…" : "Try again"}
              </button>
            </div>
            <div style={{ marginTop: 6, opacity: 0.85 }}>
              Anything unsaved on that device will not be saved.
            </div>
          </div>
        )}

        {error && <div className="auth-note err" data-testid="login-error">{error}</div>}

        <form onSubmit={submit} noValidate>
          <div className="auth-field">
            <label htmlFor="login-identifier">User ID or email address</label>
            <input
              id="login-identifier"
              data-testid="login-identifier"
              className="input"
              autoComplete="username"
              autoFocus
              value={identifier}
              onChange={(e) => setIdentifier(e.target.value)}
            />
          </div>

          <div className="auth-field">
            <label htmlFor="login-password">Password</label>
            <input
              id="login-password"
              data-testid="login-password"
              className="input"
              type="password"
              autoComplete="current-password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
            />
          </div>

          <div className="auth-actions">
            <button
              className="btn primary"
              type="submit"
              data-testid="login-submit"
              disabled={busy || retryIn > 0}
            >
              {busy ? "Signing in…" : retryIn > 0 ? `Try again in ${retryIn}s` : "Sign in"}
            </button>
          </div>
        </form>

        <div className="auth-alt">
          <a href="/forgot">Forgot password?</a>
          <a href="/signup">Create account</a>
        </div>
      </div>
    </div>
  );
}

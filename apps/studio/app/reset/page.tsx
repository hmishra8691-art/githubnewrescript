"use client";
import React from "react";

/**
 * WHERE THE RESET EMAIL LANDS — AND WHERE THE PASSWORD IS ACTUALLY SET.
 *
 * This page used to be an honest placeholder. The reset was Supabase Auth's,
 * the Studio never holds a Supabase access token, and so a form here would
 * have been a prop: a password field that cannot save a password is worse
 * than no page at all, and it said so.
 *
 * Since migration 0016 the reset is the platform's own — a token minted by
 * `/api/auth/password`, mailed by the platform's provider, and redeemed here
 * against `PUT /api/auth/password`, which sets the password with the service
 * role. So the form is real.
 *
 * The token stays in the query string and is never stored: it is spent by the
 * one request this page makes.
 */
export default function ResetPage() {
  const [token, setToken] = React.useState<string | null>(null);
  const [password, setPassword] = React.useState("");
  const [confirm, setConfirm] = React.useState("");
  const [show, setShow] = React.useState(false);
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const [done, setDone] = React.useState<string | null>(null);

  React.useEffect(() => {
    try {
      const t = new URLSearchParams(window.location.search).get("token");
      setToken(t && t.length >= 20 ? t : null);
    } catch { setToken(null); }
  }, []);

  /*
   * The strength rule is stated up front rather than after a rejected
   * attempt. Eight characters is the floor the API enforces; the encouragement
   * to use a passphrase is there because it is the advice that actually helps,
   * and because a rule that only demands a symbol produces "Password1!".
   */
  const tooShort = password.length > 0 && password.length < 8;
  const mismatch = confirm.length > 0 && confirm !== password;
  const ready = password.length >= 8 && confirm === password && !!token && !busy;

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!ready) return;
    setBusy(true); setError(null);
    try {
      const r = await fetch("/api/auth/password", {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ token, password }),
      });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) { setError(j.error ?? `That did not work (${r.status}).`); return; }
      setDone(j.message ?? "Your password has been changed.");
      setPassword(""); setConfirm("");
    } catch (err) {
      setError((err as Error).message || "That did not work.");
    } finally { setBusy(false); }
  };

  if (done) {
    return (
      <div className="auth-shell">
        <div className="auth-card" data-testid="reset-done">
          <div className="auth-brand">SURVEY PROGRAMMING PLATFORM</div>
          <h1 className="auth-title">Password changed</h1>
          <p className="auth-sub">{done}</p>
          <div className="auth-actions">
            <button className="btn primary" type="button" onClick={() => (window.location.href = "/login")}>
              Go to sign in
            </button>
          </div>
        </div>
      </div>
    );
  }

  /* arriving here without a token — a bookmarked page, or a mangled link */
  if (token === null) {
    return (
      <div className="auth-shell">
        <div className="auth-card" data-testid="reset-no-token">
          <div className="auth-brand">SURVEY PROGRAMMING PLATFORM</div>
          <h1 className="auth-title">Setting a new password</h1>
          <p className="auth-sub">
            This page needs the link from your reset email — open that link rather than this page. If the link has
            expired, or nothing arrived, ask for another.
          </p>
          <div className="auth-actions">
            <button className="btn primary" type="button" onClick={() => (window.location.href = "/forgot")}>
              Request a reset link
            </button>
          </div>
          <div className="auth-alt">
            <span className="muted">Remembered it?</span>
            <a href="/login">Sign in</a>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="auth-shell">
      <form className="auth-card" onSubmit={submit} data-testid="reset-form">
        <div className="auth-brand">SURVEY PROGRAMMING PLATFORM</div>
        <h1 className="auth-title">Choose a new password</h1>
        <p className="auth-sub">
          At least 8 characters. A short phrase you will remember beats a short password you will not.
        </p>

        {error && <div className="auth-note err" role="alert" data-testid="reset-error">{error}</div>}

        <div className={`auth-field${tooShort ? " bad" : ""}`}>
          <label htmlFor="reset-password">New password</label>
          <input
            id="reset-password" className="input" type={show ? "text" : "password"} autoFocus autoComplete="new-password"
            value={password} onChange={(e) => setPassword(e.target.value)}
            aria-describedby={tooShort ? "reset-short" : undefined}
            data-testid="reset-password"
          />
          {tooShort && <div className="hint" id="reset-short" data-testid="reset-too-short">That is under 8 characters.</div>}
        </div>

        <div className={`auth-field${mismatch ? " bad" : ""}`}>
          <label htmlFor="reset-confirm">Again, to be sure</label>
          <input
            id="reset-confirm" className="input" type={show ? "text" : "password"} autoComplete="new-password"
            value={confirm} onChange={(e) => setConfirm(e.target.value)}
            aria-describedby={mismatch ? "reset-mismatch-hint" : undefined}
            data-testid="reset-confirm"
          />
          {mismatch && <div className="hint" id="reset-mismatch-hint" data-testid="reset-mismatch">Those two do not match.</div>}
        </div>

        <label className="qs-check" style={{ marginBottom: 10 }}>
          <input type="checkbox" checked={show} onChange={(e) => setShow(e.target.checked)} />
          <span>Show what I am typing</span>
        </label>

        <div className="auth-actions">
          <button className="btn primary" type="submit" disabled={!ready} data-testid="reset-submit">
            {busy ? "Saving…" : "Set the new password"}
          </button>
        </div>

        <p className="muted" style={{ fontSize: 12.5, marginTop: 12 }}>
          Setting a new password signs you out everywhere else — which is the point, if somebody else had the old one.
        </p>
      </form>
    </div>
  );
}

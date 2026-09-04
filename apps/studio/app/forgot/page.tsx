"use client";
import React from "react";
import { api } from "@/lib/useSession";

/**
 * FORGOT PASSWORD.
 *
 * The server answers the same way whether or not the account exists, so this
 * screen must not add a hint of its own: it shows the server's sentence and
 * nothing more, and it hides the form afterwards so there is no invitation to
 * try a second address and compare the replies.
 */
export default function ForgotPage() {
  const [identifier, setIdentifier] = React.useState("");
  const [busy, setBusy] = React.useState(false);
  const [sent, setSent] = React.useState<string | null>(null);
  const [error, setError] = React.useState<string | null>(null);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (busy) return;
    setBusy(true);
    setError(null);
    const res = await api<{ ok: true; message: string }>("/api/auth/password", {
      method: "POST",
      json: { identifier },
    });
    setBusy(false);
    // a failure here is transport or an outage, never "no such account" — the
    // route has no unhappy path that says anything about the identifier
    if (res.ok) setSent(res.data.message);
    else setError(res.error);
  };

  return (
    <div className="auth-shell">
      <div className="auth-card">
        <div className="auth-brand">SURVEY PROGRAMMING PLATFORM</div>
        <h1 className="auth-title">Reset your password</h1>
        <p className="auth-sub">
          Tell us who you are and we will email a reset link to the address on the account.
        </p>

        {sent && <div className="auth-note ok" data-testid="forgot-done">{sent}</div>}
        {error && <div className="auth-note err">{error}</div>}

        {!sent && (
          <form onSubmit={submit} noValidate>
            <div className="auth-field">
              <label htmlFor="forgot-identifier">User ID or email address</label>
              <input
                id="forgot-identifier"
                data-testid="forgot-identifier"
                className="input"
                autoComplete="username"
                autoFocus
                value={identifier}
                onChange={(e) => setIdentifier(e.target.value)}
              />
            </div>
            <div className="auth-actions">
              <button className="btn primary" type="submit" data-testid="forgot-submit" disabled={busy}>
                {busy ? "Sending…" : "Send reset link"}
              </button>
            </div>
          </form>
        )}

        <div className="auth-alt">
          <a href="/login">Back to sign in</a>
        </div>
      </div>
    </div>
  );
}

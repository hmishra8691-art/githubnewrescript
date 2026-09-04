"use client";
import React from "react";

/**
 * WHERE THE RESET EMAIL LANDS.
 *
 * The reset is Supabase Auth's, not ours — the studio never holds a Supabase
 * access token, so there is nothing here that could set a new password even if
 * the link's fragment were read. A form on this page would therefore be a
 * prop, and a password field that cannot save a password is worse than no page
 * at all. So it says what actually happened and points back to sign-in.
 */
export default function ResetPage() {
  return (
    <div className="auth-shell">
      <div className="auth-card">
        <div className="auth-brand">SURVEY PROGRAMMING PLATFORM</div>
        <h1 className="auth-title">Setting a new password</h1>
        <p className="auth-sub">
          Password resets are handled by our authentication provider, not by the studio. The link
          in your email opens their secure page, where you choose the new password. Once you have
          set it there, come back and sign in with it.
        </p>
        <div className="auth-actions">
          <button className="btn primary" type="button" onClick={() => (window.location.href = "/login")}>
            Go to sign in
          </button>
        </div>
        <div className="auth-alt">
          <span className="muted">Link expired or nothing arrived?</span>
          <a href="/forgot">Request another</a>
        </div>
      </div>
    </div>
  );
}

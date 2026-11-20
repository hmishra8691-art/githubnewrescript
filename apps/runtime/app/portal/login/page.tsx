"use client";
import React from "react";
import { portalApi } from "@/components/portal/api";
import { Narrow, Note } from "@/components/portal/Shell";

const ENDED: Record<string, string> = {
  idle: "You were signed out because the page was not used for a while.",
  signed_out: "You have signed out.",
  password: "Your password has been changed. Please sign in with the new one.",
};

export default function PortalLogin() {
  const [login, setLogin] = React.useState("");
  const [password, setPassword] = React.useState("");
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const [ended, setEnded] = React.useState<string | null>(null);
  React.useEffect(() => { setEnded(ENDED[new URLSearchParams(window.location.search).get("ended") ?? ""] ?? null); }, []);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true); setError(null);
    const r = await portalApi<{ mustChangePassword: boolean }>("login", { login, password }, { redirectOn401: false });
    setBusy(false);
    if (!r.ok) { setError(r.error.error); setPassword(""); return; }
    window.location.assign(r.data.mustChangePassword ? "/portal/account?change=1" : "/portal");
  };

  return (
    <Narrow title="Sign in" lead="Use the Respondent ID or email address from your invitation.">
      {ended && !error && <Note kind="info">{ended}</Note>}
      {error && <Note kind="bad">{error}</Note>}
      <form onSubmit={submit} noValidate>
        <div className="pt-field">
          <label htmlFor="pt-login">Respondent ID or email</label>
          <input id="pt-login" className="pt-input" value={login} onChange={(e) => setLogin(e.target.value)} autoComplete="username" autoCapitalize="none" spellCheck={false} required data-testid="pt-login" />
        </div>
        <div className="pt-field">
          <label htmlFor="pt-password">Password</label>
          <input id="pt-password" className="pt-input" type="password" value={password} onChange={(e) => setPassword(e.target.value)} autoComplete="current-password" required data-testid="pt-password" />
        </div>
        <button className="pt-btn is-primary" type="submit" disabled={busy || !login.trim() || !password} data-testid="pt-signin">{busy ? "Signing in…" : "Sign in"}</button>
      </form>
      <p className="pt-why" style={{ marginTop: 16 }}><a href="/portal/reset">Forgotten your password?</a></p>
    </Narrow>
  );
}

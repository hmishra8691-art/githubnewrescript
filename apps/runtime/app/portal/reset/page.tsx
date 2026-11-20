"use client";
import React from "react";
import { portalApi, takeFragmentToken } from "@/components/portal/api";
import { Narrow, NewPassword, Note } from "@/components/portal/Shell";

/** /portal/reset — ask for a reset link; /portal/reset#token=… — the emailed link: choose a new password. */
export default function PortalReset() {
  const [token, setToken] = React.useState<string | null>(null);
  const [login, setLogin] = React.useState("");
  const [pw, setPw] = React.useState(""); const [again, setAgain] = React.useState("");
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const [done, setDone] = React.useState<"asked" | "changed" | null>(null);
  React.useEffect(() => { setToken(takeFragmentToken()); }, []);

  const ask = async (e: React.FormEvent) => {
    e.preventDefault(); setBusy(true); setError(null);
    const r = await portalApi("reset", { login }, { redirectOn401: false });
    setBusy(false);
    if (!r.ok) setError(r.error.error); else setDone("asked");
  };
  const change = async (e: React.FormEvent) => {
    e.preventDefault();
    if (pw !== again) { setError("The two passwords are not the same."); return; }
    setBusy(true); setError(null);
    const r = await portalApi("reset", { token, password: pw }, { redirectOn401: false });
    setBusy(false);
    if (!r.ok) setError(r.error.error); else setDone("changed");
  };

  if (done === "changed") return <Narrow title="Password changed"><Note kind="ok">Your password has been changed and you have been signed out everywhere.</Note><a className="pt-btn is-primary" href="/portal/login">Sign in</a></Narrow>;
  if (done === "asked") return (
    <Narrow title="Check your email">
      <Note kind="info">If that Respondent ID or email belongs to an account with an email address, a link to choose a new password is on its way. It works for one hour.</Note>
      <p className="pt-why">No email? Your account may have been set up without an address. Ask the organiser of your assessment to reset your access.</p>
      <a className="pt-btn" href="/portal/login">Back to sign in</a>
    </Narrow>
  );
  if (token) return (
    <Narrow title="Choose a new password">
      {error && <Note kind="bad">{error}</Note>}
      <form onSubmit={change} noValidate>
        <NewPassword value={pw} again={again} onChange={(a, b) => { setPw(a); setAgain(b); }} />
        <button className="pt-btn is-primary" type="submit" disabled={busy || pw.length < 10 || !again} data-testid="pt-reset-set">{busy ? "Saving…" : "Change password"}</button>
      </form>
    </Narrow>
  );
  return (
    <Narrow title="Forgotten your password?" lead="Enter your Respondent ID or email and we will send a link to choose a new one.">
      {error && <Note kind="bad">{error}</Note>}
      <form onSubmit={ask} noValidate>
        <div className="pt-field">
          <label htmlFor="pt-login">Respondent ID or email</label>
          <input id="pt-login" className="pt-input" value={login} onChange={(e) => setLogin(e.target.value)} autoComplete="username" autoCapitalize="none" spellCheck={false} required data-testid="pt-reset-login" />
        </div>
        <button className="pt-btn is-primary" type="submit" disabled={busy || !login.trim()} data-testid="pt-reset-ask">{busy ? "Sending…" : "Send the link"}</button>
      </form>
      <p className="pt-why" style={{ marginTop: 16 }}><a href="/portal/login">Back to sign in</a></p>
    </Narrow>
  );
}

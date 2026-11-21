"use client";
import React from "react";
import { portalApi, takeFragmentToken } from "@/components/portal/api";
import { Narrow, NewPassword, Note } from "@/components/portal/Shell";

/** /portal/invitation#token=… — the link in an invitation. The token is in the fragment, so it is never sent in a page request or kept in a server log. */
export default function PortalInvitation() {
  const [token, setToken] = React.useState<string | null>(null);
  const [info, setInfo] = React.useState<{ respondentId: string; name: string | null; notice?: { title: string; paragraphs: string[] } } | null>(null);
  const [state, setState] = React.useState<"checking" | "ready" | "invalid">("checking");
  const [pw, setPw] = React.useState(""); const [again, setAgain] = React.useState("");
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const [agreed, setAgreed] = React.useState(false);

  React.useEffect(() => {
    const t = takeFragmentToken();
    if (!t) { setState("invalid"); return; }
    setToken(t);
    void portalApi<{ respondentId: string; name: string | null; notice?: { title: string; paragraphs: string[] } }>("invitation", { token: t }, { redirectOn401: false }).then((r) => {
      if (r.ok) { setInfo(r.data); setState("ready"); } else setState("invalid");
    });
  }, []);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (pw !== again) { setError("The two passwords are not the same."); return; }
    setBusy(true); setError(null);
    const r = await portalApi("invitation", { token, password: pw, consent: agreed }, { redirectOn401: false });
    setBusy(false);
    if (!r.ok) { setError(r.error.error); return; }
    window.location.assign("/portal");
  };

  if (state === "checking") return <Narrow title="One moment…"><p className="pt-lead">Checking your invitation.</p></Narrow>;
  if (state === "invalid") return (
    <Narrow title="This invitation link cannot be used">
      <Note kind="bad">The link has expired or has already been used.</Note>
      <p>If you have already set a password, <a href="/portal/login">sign in</a>. Otherwise ask the organiser for a new invitation.</p>
    </Narrow>
  );
  return (
    <Narrow title={info?.name ? `Welcome, ${info.name}` : "Welcome"} lead="Choose a password to finish setting up your account.">
      <Note kind="info">Your Respondent ID is <strong data-testid="pt-rid">{info?.respondentId}</strong>. Keep it: you can sign in with it.</Note>
      {error && <Note kind="bad">{error}</Note>}
      <form onSubmit={submit} noValidate>
        <NewPassword value={pw} again={again} onChange={(a, b) => { setPw(a); setAgain(b); }} />
        {info?.notice && (
          <div className="pt-notice" data-testid="pt-notice">
            <p className="pt-q">{info.notice.title}</p>
            {info.notice.paragraphs.map((t, i) => <p key={i}>{t}</p>)}
            <label className="pt-check"><input type="checkbox" checked={agreed} onChange={(e) => setAgreed(e.target.checked)} data-testid="pt-agree" /> <span>I have read this and agree.</span></label>
          </div>
        )}
        <button className="pt-btn is-primary" type="submit" disabled={busy || pw.length < 10 || !again || !agreed} data-testid="pt-activate">{busy ? "Saving…" : "Set password and continue"}</button>
      </form>
    </Narrow>
  );
}

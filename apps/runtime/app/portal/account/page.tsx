"use client";
import React from "react";
import { portalApi, when } from "@/components/portal/api";
import { NewPassword, Note, Shell } from "@/components/portal/Shell";

interface Me { account: { respondentId: string; name: string | null; email: string | null }; sessions: { id: string; device: string | null; signedInAt: string; lastSeenAt: string; current: boolean }[] }

export default function PortalAccount() {
  const [me, setMe] = React.useState<Me | null>(null);
  const [name, setName] = React.useState("");
  const [current, setCurrent] = React.useState(""); const [pw, setPw] = React.useState(""); const [again, setAgain] = React.useState("");
  const [note, setNote] = React.useState<{ kind: "ok" | "bad"; text: string; where: "profile" | "password" | "sessions" } | null>(null);
  const [mustChange, setMustChange] = React.useState(false);
  const [busy, setBusy] = React.useState(false);
  const load = React.useCallback(async () => { const r = await portalApi<Me>("me"); if (r.ok) { setMe(r.data); setName(r.data.account.name ?? ""); } }, []);
  React.useEffect(() => { void load(); setMustChange(new URLSearchParams(window.location.search).get("change") === "1"); }, [load]);

  const act = async (where: "profile" | "password" | "sessions", body: Record<string, unknown>, ok: string) => {
    setBusy(true); setNote(null);
    const r = await portalApi("me", body);
    setBusy(false);
    if (!r.ok) { setNote({ kind: "bad", text: r.error.error, where }); return false; }
    setNote({ kind: "ok", text: ok, where }); await load(); return true;
  };
  const changePassword = async (e: React.FormEvent) => {
    e.preventDefault();
    if (pw !== again) { setNote({ kind: "bad", text: "The two passwords are not the same.", where: "password" }); return; }
    if (await act("password", { action: "password", current, next: pw }, "Your password has been changed. Other devices have been signed out.")) { setCurrent(""); setPw(""); setAgain(""); setMustChange(false); }
  };

  return (
    <Shell current="account" who={me?.account}>
      <h1>Profile and security</h1>
      <p className="pt-lead">Your details, your password, and where you are signed in.</p>
      {mustChange && <Note kind="info">Please choose your own password before you continue.</Note>}

      <h2>Your details</h2>
      <div className="pt-card">
        {note?.where === "profile" && <Note kind={note.kind}>{note.text}</Note>}
        <p style={{ marginTop: 0 }}>Respondent ID: <strong data-testid="pt-rid">{me?.account.respondentId ?? "…"}</strong>{me?.account.email ? <> · {me.account.email}</> : null}</p>
        <form onSubmit={(e) => { e.preventDefault(); void act("profile", { action: "profile", name }, "Your name has been saved."); }}>
          <div className="pt-field"><label htmlFor="pt-name">Name</label><input id="pt-name" className="pt-input" value={name} onChange={(e) => setName(e.target.value)} autoComplete="name" maxLength={200} data-testid="pt-name" /></div>
          <button className="pt-btn" type="submit" disabled={busy || !name.trim()} data-testid="pt-save-name">Save</button>
        </form>
      </div>

      <h2>Password</h2>
      <div className="pt-card">
        {note?.where === "password" && <Note kind={note.kind}>{note.text}</Note>}
        <form onSubmit={changePassword} noValidate>
          <div className="pt-field"><label htmlFor="pt-current">Current password</label><input id="pt-current" className="pt-input" type="password" autoComplete="current-password" value={current} onChange={(e) => setCurrent(e.target.value)} required data-testid="pt-current-password" /></div>
          <NewPassword value={pw} again={again} onChange={(a, b) => { setPw(a); setAgain(b); }} />
          <button className="pt-btn is-primary" type="submit" disabled={busy || !current || pw.length < 10 || !again} data-testid="pt-change-password">Change password</button>
        </form>
      </div>

      <h2>Where you are signed in</h2>
      <div className="pt-card">
        {note?.where === "sessions" && <Note kind={note.kind}>{note.text}</Note>}
        <table className="pt-table" data-testid="pt-sessions">
          <thead><tr><th>Device</th><th>Signed in</th><th>Last used</th><th /></tr></thead>
          <tbody>
            {(me?.sessions ?? []).map((s) => (
              <tr key={s.id}>
                <td>{s.device ?? "A device"}{s.current ? " (this one)" : ""}</td><td>{when(s.signedInAt, true)}</td><td>{when(s.lastSeenAt, true)}</td>
                <td>{!s.current && <button type="button" className="pt-btn is-quiet" disabled={busy} onClick={() => act("sessions", { action: "end_session", sessionId: s.id }, "That device has been signed out.")}>Sign out</button>}</td>
              </tr>
            ))}
          </tbody>
        </table>
        <p className="pt-why">You are signed out automatically after 30 minutes without activity.</p>
      </div>
    </Shell>
  );
}

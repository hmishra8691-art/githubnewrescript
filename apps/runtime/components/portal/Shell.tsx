"use client";
import React from "react";
import { portalApi } from "./api";

/** The portal's frame for signed-in pages: the name bar, the three places, and Sign out. */
export function Shell({ current, who, children }: { current: "overview" | "account" | "assessment"; who?: { respondentId: string; name: string | null } | null; children: React.ReactNode }) {
  const out = async () => { await portalApi("logout", {}, { redirectOn401: false }); window.location.assign("/portal/login?ended=signed_out"); };
  return (
    <div className="pt">
      <header className="pt-top">
        <div className="pt-top-in">
          <a className="pt-brand" href="/portal">My assessments</a>
          <nav className="pt-nav" aria-label="Portal">
            <a href="/portal" aria-current={current === "overview" || current === "assessment" ? "page" : undefined}>Overview</a>
            <a href="/portal/account" aria-current={current === "account" ? "page" : undefined}>Profile and security</a>
          </nav>
          {who && <span className="pt-who" data-testid="pt-who">{who.name ? `${who.name} · ` : ""}{who.respondentId}</span>}
          <button type="button" className="pt-btn is-quiet" onClick={out} data-testid="pt-signout">Sign out</button>
        </div>
      </header>
      <main className="pt-main">{children}</main>
    </div>
  );
}

export function Narrow({ title, lead, children }: { title: string; lead?: string; children: React.ReactNode }) {
  return (
    <div className="pt">
      <main className="pt-narrow">
        <h1>{title}</h1>
        {lead && <p className="pt-lead">{lead}</p>}
        <div className="pt-card">{children}</div>
      </main>
    </div>
  );
}

export function Note({ kind, children }: { kind: "bad" | "ok" | "info"; children: React.ReactNode }) {
  return <p className={`pt-note is-${kind}`} role={kind === "bad" ? "alert" : "status"}>{children}</p>;
}

/** a new password, typed twice, with the rule said before it is broken */
export function NewPassword({ value, again, onChange }: { value: string; again: string; onChange: (v: string, again: string) => void }) {
  return (
    <>
      <div className="pt-field">
        <label htmlFor="pt-new">New password</label>
        <input id="pt-new" className="pt-input" type="password" autoComplete="new-password" value={value} onChange={(e) => onChange(e.target.value, again)} minLength={10} required data-testid="pt-new-password" />
        <span className="pt-hint">At least 10 characters. A short sentence is a good password.</span>
      </div>
      <div className="pt-field">
        <label htmlFor="pt-again">New password, again</label>
        <input id="pt-again" className="pt-input" type="password" autoComplete="new-password" value={again} onChange={(e) => onChange(value, e.target.value)} required data-testid="pt-new-password-again" />
      </div>
    </>
  );
}

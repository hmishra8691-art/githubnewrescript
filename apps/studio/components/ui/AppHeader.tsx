"use client";
import React from "react";
import type { SessionUser } from "@/lib/useSession";
import { Icon } from "./Icon";

/**
 * THE TOP-LEVEL HEADER shared by the Dashboard and Data Analytics pages:
 * brand, the primary destinations, and the account area (name, user code,
 * Profile / Security / Administration / Sign out). Presentation only — every
 * link goes where the old buttons went and sign-out calls the same handler.
 */
export function AppHeader({ active, user, onSignOut, crumbs }: {
  active: "dashboard" | "analytics" | "account";
  user: SessionUser | null;
  onSignOut?: () => void;
  crumbs?: React.ReactNode;
}) {
  const [open, setOpen] = React.useState(false);
  const initials = (user?.name ?? "").trim().split(/\s+/).map((w) => w[0]).slice(0, 2).join("").toUpperCase() || "?";
  const hue = user ? [...user.userId].reduce((h, c) => (h * 31 + c.charCodeAt(0)) % 360, 0) : 230;
  return (
    <header className="apph" data-testid="app-header">
      <a href="/" className="apph-brand" title="Dashboard">
        <span className="logo-mark">R</span>
        <span className="apph-name">Rescript</span>
      </a>
      <nav className="apph-nav" aria-label="Primary">
        <a href="/" className={active === "dashboard" ? "on" : ""} aria-current={active === "dashboard" ? "page" : undefined}><Icon name="grid" size={16} /> Projects</a>
        <a href="/analytics" className={active === "analytics" ? "on" : ""} aria-current={active === "analytics" ? "page" : undefined} data-testid="dash-analytics"><Icon name="analytics" size={16} /> Data Analytics</a>
      </nav>
      {crumbs && <div className="apph-crumbs">{crumbs}</div>}
      <span className="grow" />
      {user && (
        <div className="apph-account" data-testid="dash-account">
          {active !== "account" && (
            <>
              {!!user.unread && <a className="btn small" href="/profile" title="You have unread notifications"><Icon name="bell" size={14} /> {user.unread} new</a>}
              <a className="btn small" href="/profile">Profile</a>
              <a className="btn small" href="/security">Security</a>
              <a className="btn small" href="/billing">My usage</a>
              {user.isPlatformAdmin && <a className="btn small" href="/admin">Administration</a>}
              <button className="btn small" data-testid="dash-signout" onClick={() => onSignOut?.()}>Sign out</button>
            </>
          )}
          <div className="menu-anchor">
            <button className={`apph-user ${open ? "on" : ""}`} onClick={() => setOpen(!open)} aria-haspopup="menu" aria-expanded={open} title={`${user.name} · ${user.userCode}`}>
              <span className="avatar sm" style={{ background: `hsl(${hue} 60% 48%)` }} aria-hidden="true">{initials}</span>
              <span className="apph-user-name">{user.name.split(" ")[0]}</span>
              <Icon name="chevron-down" size={14} />
            </button>
            {open && (
              <>
                <div className="menu-scrim" onClick={() => setOpen(false)} />
                <div className="menu apph-menu" role="menu">
                  <div className="apph-menu-head">
                    <span className="avatar lg" style={{ background: `hsl(${hue} 60% 48%)` }} aria-hidden="true">{initials}</span>
                    <div>
                      <div className="apph-menu-name">{user.name}</div>
                      <div className="apph-menu-code mono">{user.userCode}</div>
                      <div className="apph-menu-status"><span className="dot" /> Online</div>
                    </div>
                  </div>
                  <div className="menu-sep" />
                  <a className="menu-item" href="/profile" role="menuitem"><Icon name="user" size={15} /> Profile</a>
                  <a className="menu-item" href="/security" role="menuitem"><Icon name="shield" size={15} /> Security &amp; sessions</a>
                  <a className="menu-item" href="/billing" role="menuitem"><Icon name="chart" size={15} /> My usage</a>
                  <a className="menu-item" href="/" role="menuitem"><Icon name="grid" size={15} /> Projects</a>
                  {user.isPlatformAdmin && <a className="menu-item" href="/admin" role="menuitem"><Icon name="settings" size={15} /> Administration</a>}
                  <div className="menu-sep" />
                  <button className="menu-item" role="menuitem" onClick={() => { setOpen(false); onSignOut?.(); }}><Icon name="logout" size={15} /> Sign out</button>
                </div>
              </>
            )}
          </div>
        </div>
      )}
    </header>
  );
}

export function greeting(name?: string | null): string {
  const h = new Date().getHours();
  const part = h < 5 ? "Good evening" : h < 12 ? "Good morning" : h < 18 ? "Good afternoon" : "Good evening";
  const first = (name ?? "").trim().split(/\s+/)[0];
  return first ? `${part}, ${first}` : part;
}

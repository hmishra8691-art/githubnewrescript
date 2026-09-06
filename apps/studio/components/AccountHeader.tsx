"use client";
import React from "react";
import type { SessionUser } from "@/lib/useSession";
import { AppHeader } from "@/components/ui/AppHeader";

/**
 * THE CHROME ON TOP OF THE ACCOUNT SCREENS.
 *
 * Profile, Security and Administration are three views of one thing — "this
 * is who you are here" — so they share a header rather than each inventing
 * their own. It also carries the two exits every one of them needs: back to
 * the work, and out of the account entirely.
 *
 * Administration only appears for a platform admin. The endpoints refuse
 * anyone else anyway; leaving the link visible would only advertise a door
 * that does not open.
 */

export interface AccountHeaderProps {
  active: "profile" | "security" | "admin";
  user: SessionUser | null;
  onSignOut: () => void;
}

const TITLES: Record<AccountHeaderProps["active"], string> = {
  profile: "Your profile",
  security: "Sign-in & sessions",
  admin: "Administration",
};

/** Initials from whatever name we actually have — one word still gives two letters. */
function initialsOf(name: string | null | undefined): string {
  const parts = (name ?? "").trim().split(/\s+/).filter(Boolean);
  if (!parts.length) return "?";
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
}

/*
 * The same hash the presence avatars use, deliberately re-stated here rather
 * than imported: this is a client component and @rescript/access is the
 * server-side access package. The arithmetic matters more than the sharing —
 * a person has to be the same colour on this header as on the collaborators
 * list, and any other formula would give them two identities.
 */
function avatarHue(userId: string): number {
  let h = 0;
  for (let i = 0; i < userId.length; i++) h = (h * 31 + userId.charCodeAt(i)) % 360;
  return h;
}

export function AccountHeader({ active, user, onSignOut }: AccountHeaderProps) {
  const hue = user ? avatarHue(user.userId) : 0;

  return (
    <>
      {/* the same product header as the Dashboard and Data Analytics, so the
          account area never feels like a different application */}
      <AppHeader active="account" user={user} onSignOut={onSignOut} />
      <div className="acct-head">
        <div>
          <div className="eyebrow">Account</div>
          <h1>{TITLES[active]}</h1>
        </div>
        {user && (
          <span className="acct-who">
            <span
              className="avatar lg"
              style={{ background: `hsl(${hue} 62% 45%)` }}
              title={user.name}
              aria-hidden
            >
              {initialsOf(user.name)}
            </span>
            <span style={{ lineHeight: 1.3 }}>
              <span style={{ display: "block", fontSize: 15, fontWeight: 600 }}>{user.name}</span>
              <span className="mono muted" style={{ display: "block", fontSize: 13 }}>
                {user.userCode} <span className="acct-online"><span className="dot" /> Online</span>
              </span>
            </span>
          </span>
        )}
      </div>

      <nav className="acct-nav">
        <a href="/profile" className={active === "profile" ? "active" : undefined}>Profile</a>
        <a href="/security" className={active === "security" ? "active" : undefined}>Security</a>
        {user?.isPlatformAdmin && (
          <a href="/admin" className={active === "admin" ? "active" : undefined}>Administration</a>
        )}
        <span className="grow" />
        <a href="/">Back to projects</a>
        <button type="button" onClick={onSignOut}>Sign out</button>
      </nav>
    </>
  );
}

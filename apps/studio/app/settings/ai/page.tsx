"use client";
import React from "react";
import { AccountHeader } from "@/components/AccountHeader";
import { AiProviderConfig } from "@/components/settings/AiProviderConfig";
import { useSession } from "@/lib/useSession";

/** SETTINGS → AI & INTEGRATIONS → AI PROVIDER CONFIGURATION (see AiProviderConfig). */
export default function AiSettingsPage() {
  const { state, signOut } = useSession({ redirectOnSignOut: true });
  const user = state.kind === "signed_in" ? state.user : null;
  return (
    <div className="acct-shell">
      <AccountHeader active="ai" user={user} onSignOut={signOut} />
      <p className="muted" style={{ fontSize: 14, lineHeight: 1.55, maxWidth: 760 }}>
        Settings · AI &amp; Integrations · <strong>AI Provider Configuration</strong>
      </p>
      {user ? <AiProviderConfig /> : <p className="muted">Loading…</p>}
    </div>
  );
}

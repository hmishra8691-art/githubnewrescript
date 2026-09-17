"use client";
import React from "react";

/** One button: create the practice project and go straight into it. */
export function StartPractice({ templateKey }: { templateKey: string }) {
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  async function start() {
    setBusy(true); setError(null);
    const res = await fetch("/api/mock/start", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ template: templateKey }),
    });
    const reply = await res.json().catch(() => ({}));
    if (!res.ok || !reply.ok) { setBusy(false); setError(reply.error ?? "That could not be started."); return; }
    /* straight in — the link is the person's own, minted a moment ago */
    window.location.href = reply.link;
  }

  return (
    <div style={{ textAlign: "right" }}>
      <button className="btn" disabled={busy} onClick={() => void start()} data-testid="start-practice">
        {busy ? "Setting up…" : "Start"}
      </button>
      {error && <p className="tiny" style={{ color: "var(--bad, #b00)", marginTop: 6 }}>{error}</p>}
    </div>
  );
}

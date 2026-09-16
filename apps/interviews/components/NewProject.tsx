"use client";
import React from "react";

/** Create a project. Deliberately three fields — the rest has good defaults. */
export function NewProject() {
  const [open, setOpen] = React.useState(false);
  const [name, setName] = React.useState("");
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  async function create(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true); setError(null);
    const res = await fetch("/api/projects", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ name }),
    });
    const reply = await res.json().catch(() => ({}));
    setBusy(false);
    if (!res.ok || !reply.ok) { setError(reply.error ?? "That did not work."); return; }
    window.location.href = `/projects/${reply.project.id}`;
  }

  if (!open) {
    return (
      <p><button className="btn" onClick={() => setOpen(true)} data-testid="new-project">New project</button></p>
    );
  }
  return (
    <form className="card" onSubmit={create}>
      <label>
        <span>What are you hiring for?</span>
        <input value={name} onChange={(e) => setName(e.target.value)}
          placeholder="Senior backend engineer" autoFocus data-testid="project-name" />
      </label>
      {error && <p className="note bad">{error}</p>}
      <div className="row">
        <button className="btn" disabled={busy || !name.trim()} data-testid="project-create">
          {busy ? "Creating…" : "Create project"}
        </button>
        <button type="button" className="btn secondary" onClick={() => setOpen(false)}>Cancel</button>
      </div>
    </form>
  );
}

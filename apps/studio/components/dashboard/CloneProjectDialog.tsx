"use client";
import React from "react";

/**
 * CLONE A PROJECT — the confirmation.
 *
 * WHY THERE ARE NO CHECKBOXES OVER THE PROGRAMMING. A survey definition is
 * one interlocking document: the logic refers to the questions, the quotas
 * read the answers, the carry-forward names a source, the translations are
 * keyed to elements that must exist. "Copy the questions but not the logic"
 * does not describe a smaller survey — it describes a broken one, and a
 * dialog that offers the choice is promising something it cannot deliver.
 * So the programming travels as a unit and this list says exactly what that
 * unit contains, because a person about to copy a study is entitled to know
 * what they are getting without having to trust the word "everything".
 *
 * The two real choices are here, and both are decided the safe way:
 *
 *   · RESPONSES ARE NEVER COPIED. They belong to the original's fieldwork.
 *     Copying live records would put one set of respondents in two projects
 *     and count their completions twice.
 *
 *   · THE WALLET STARTS EMPTY, because duplicating a balance would be
 *     creating credits, and credits are only created by an administrator
 *     assigning them. The copy is refilled like any other project.
 */

const COPIED = [
  "Survey structure and blocks", "Questions and question types",
  "Options, matrix rows and columns", "Display, skip and branch logic",
  "Auto-punch and auto-select", "Masking and set logic",
  "List logic, List Fills and loops", "Piping and carry-forward",
  "Variables, calculations and embedded data", "Quotas and randomization",
  "Validation and quality checks", "Translations and audio",
  "AI configuration", "Theme and survey settings",
];

export function CloneProjectDialog({ project, onClose, onCloned }: {
  project: { id: string; title: string; code: string };
  onClose(): void;
  onCloned(created: { id: string; title: string }): void;
}) {
  const [title, setTitle] = React.useState(`${project.title} — Copy`);
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const [done, setDone] = React.useState<{ id: string; title: string } | null>(null);

  const submit = async () => {
    if (busy || !title.trim()) return;
    setBusy(true); setError(null);
    try {
      const r = await fetch(`/api/surveys/${project.id}/clone`, {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ title: title.trim() }),
      });
      const d = await r.json().catch(() => ({}));
      if (!r.ok || d?.error) { setError(d?.error ?? `Could not clone this project (${r.status}).`); return; }
      setDone({ id: d.id, title: d.title });
      onCloned({ id: d.id, title: d.title });
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="modal-back" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()} data-testid="clone-dialog" style={{ maxWidth: 520 }}>
        <h3 style={{ marginTop: 0 }}>Clone project</h3>
        <p className="muted" style={{ marginTop: -6 }}>
          {project.title} <span className="mono">{project.code}</span>
        </p>

        {done ? (
          <>
            <div className="alert success" data-testid="clone-done">
              {done.title} was created. It is a completely independent project — nothing in it refers back to {project.code}.
            </div>
            <div className="row" style={{ justifyContent: "flex-end", gap: 8, marginTop: 12 }}>
              <button className="btn" onClick={onClose}>Stay here</button>
              <button className="btn primary" data-testid="clone-open"
                onClick={() => { window.location.href = `/studio/${done.id}`; }}>
                Open the copy
              </button>
            </div>
          </>
        ) : (
          <>
            <label className="flabel" htmlFor="cl-title">New project name</label>
            <input id="cl-title" className="input" data-testid="clone-title" value={title} autoFocus
              onChange={(e) => setTitle(e.target.value)} />
            <p className="muted" style={{ fontSize: 12, marginTop: 4 }}>
              The copy gets its own project code; every question keeps its own code, so <span className="mono">Q1</span> is still
              <span className="mono"> Q1</span> in the copy.
            </p>

            <div className="flabel" style={{ marginTop: 10 }}>What is copied</div>
            <ul className="cl-list" data-testid="clone-copied">
              {COPIED.map((c) => <li key={c}>{c}</li>)}
            </ul>

            <div className="flabel">What is not</div>
            <div className="alert info" style={{ fontSize: 13 }} data-testid="clone-excluded">
              <strong>No responses.</strong> Live and test responses stay with {project.code} — they are its fieldwork, not its
              programming.<br />
              <strong>An empty wallet.</strong> The copy starts at $0.00. Credits are moved into it with Refill wallet, the same
              as any other project.
            </div>

            {error && <div className="alert error" style={{ marginTop: 10 }} data-testid="clone-error">{error}</div>}

            <div className="row" style={{ justifyContent: "flex-end", gap: 8, marginTop: 12 }}>
              <button className="btn" onClick={onClose}>Cancel</button>
              <button className="btn primary" data-testid="clone-confirm" disabled={busy || !title.trim()} onClick={submit}>
                {busy ? "Cloning…" : "Clone project"}
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}

"use client";
import React from "react";
import {
  MAX_RETENTION_DAYS, MIN_RETENTION_DAYS, PROJECT_STATUSES, STATUS_SAY, checkProject,
  type ProjectStatus,
} from "@rescript/interviews";

export interface BuilderProject {
  id: string;
  code: string;
  name: string;
  description: string | null;
  status: string;
  instructions: string | null;
  consent_text: string | null;
  retention_days: number | null;
}

/**
 * EVERYTHING ABOUT A PROJECT THAT USED TO NEED SQL.
 *
 * There was no edit route and no settings screen, so after `POST /api/projects`
 * accepted a name, the instructions a candidate reads, the consent text they
 * agree to, the status that decides whether their link works, and the retention
 * period that decides when their recording is destroyed were all unreachable
 * from the product.
 *
 * ## Two fields here are not like the others
 *
 * Consent text is a legal artefact. Each sitting snapshots what it displayed,
 * so editing this changes what the NEXT candidate agrees to and cannot reach
 * back into interviews already taken — which is the only honest thing an edit
 * could mean, and is said on screen rather than assumed.
 *
 * Retention decides when somebody's recording is destroyed, irreversibly, by a
 * scheduled job. A number typed into a form should not be the only warning
 * anybody gets, so a short window says out loud what it will do.
 */
export function SettingsPanel({ project: initial, mayEdit }: {
  project: BuilderProject;
  mayEdit: boolean;
}) {
  const [name, setName] = React.useState(initial.name);
  const [description, setDescription] = React.useState(initial.description ?? "");
  const [status, setStatus] = React.useState<ProjectStatus>(initial.status as ProjectStatus);
  const [instructions, setInstructions] = React.useState(initial.instructions ?? "");
  const [consentText, setConsentText] = React.useState(initial.consent_text ?? "");
  const [retentionDays, setRetentionDays] = React.useState(initial.retention_days ?? 90);
  const [busy, setBusy] = React.useState(false);
  const [saved, setSaved] = React.useState<string | null>(null);
  const [error, setError] = React.useState<string | null>(null);
  const [warnings, setWarnings] = React.useState<string[]>([]);

  const check = checkProject({ name, status, consentText, retentionDays });

  const dirty =
    name !== initial.name ||
    description !== (initial.description ?? "") ||
    status !== initial.status ||
    instructions !== (initial.instructions ?? "") ||
    consentText !== (initial.consent_text ?? "") ||
    retentionDays !== (initial.retention_days ?? 90);

  async function save(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true); setError(null); setSaved(null); setWarnings([]);
    const res = await fetch(`/api/projects/${initial.id}`, {
      method: "PATCH", headers: { "content-type": "application/json" },
      body: JSON.stringify({ name, description, status, instructions, consentText, retentionDays }),
    });
    const reply = await res.json().catch(() => ({}));
    setBusy(false);
    if (!res.ok || !reply.ok) { setError(reply.error ?? "Those changes could not be saved."); return; }
    setSaved("Saved.");
    setWarnings(reply.warnings ?? []);
  }

  return (
    <section className="card" data-testid="settings-panel">
      <h2 style={{ marginTop: 0 }}>Settings</h2>

      <form onSubmit={save}>
        <label>
          <span>Project name</span>
          <input value={name} onChange={(e) => setName(e.target.value)}
            disabled={!mayEdit} data-testid="project-name" />
        </label>

        <label>
          <span>Description (your team only — candidates never see this)</span>
          <input value={description} onChange={(e) => setDescription(e.target.value)}
            disabled={!mayEdit} data-testid="project-description" />
        </label>

        <label style={{ maxWidth: 320 }}>
          <span>Status</span>
          <select value={status} onChange={(e) => setStatus(e.target.value as ProjectStatus)}
            disabled={!mayEdit} data-testid="project-status">
            {PROJECT_STATUSES.map((s) => <option key={s} value={s}>{s}</option>)}
          </select>
          <span className="tiny muted">{STATUS_SAY[status]}</span>
        </label>

        <label>
          <span>What the candidate reads before they start</span>
          <textarea value={instructions} onChange={(e) => setInstructions(e.target.value)} rows={4}
            disabled={!mayEdit} data-testid="project-instructions"
            placeholder="You will be asked five questions. Each one is recorded. Take your time." />
        </label>

        <label>
          <span>What they agree to</span>
          <textarea value={consentText} onChange={(e) => setConsentText(e.target.value)} rows={5}
            disabled={!mayEdit} data-testid="project-consent" />
          <span className="tiny muted">
            Each interview keeps a copy of exactly what it showed, so changing this affects new
            invitations only. It never rewrites what somebody has already agreed to.
          </span>
        </label>

        <label style={{ maxWidth: 260 }}>
          <span>Delete recordings after (days)</span>
          <input type="number" min={MIN_RETENTION_DAYS} max={MAX_RETENTION_DAYS} value={retentionDays}
            onChange={(e) => setRetentionDays(Number(e.target.value))}
            disabled={!mayEdit} data-testid="project-retention" />
          <span className="tiny muted">
            Counted from when each interview finishes. A scheduled job removes the files from
            storage — this is a real deletion, not a hidden flag, and it cannot be undone.
          </span>
        </label>

        {check.errors.map((e) => (
          <p key={e} className="note bad" style={{ marginTop: 10 }} data-testid="settings-error">{e}</p>
        ))}
        {check.warnings.map((w) => (
          <p key={w} className="note warn" style={{ marginTop: 10 }} data-testid="settings-warning">{w}</p>
        ))}

        {mayEdit && (
          <div className="row" style={{ gap: 10, marginTop: 16, alignItems: "center" }}>
            <button className="btn" disabled={busy || !check.ok || !dirty} data-testid="save-settings">
              Save settings
            </button>
            {saved && <span className="muted small">{saved}</span>}
          </div>
        )}
      </form>

      {warnings.map((w) => (
        <p key={w} className="note" style={{ marginTop: 10 }} data-testid="settings-server-warning">{w}</p>
      ))}
      {error && <p className="note bad" style={{ marginTop: 10 }}>{error}</p>}
    </section>
  );
}

"use client";
import React from "react";
import { useStudio } from "./store";

interface Project {
  id: string;
  code: string;
  title: string;
  status: string;
  clientName: string | null;
  projectManager: string | null;
  fieldworkFrom: string | null;
  fieldworkTo: string | null;
  dueDate: string | null;
  costCentre: string | null;
  notes: string | null;
  locked: boolean;
  collaboration: { requireLockToEdit?: boolean; allowConcurrentViewers?: boolean; lockMinutes?: number };
  updatedAt?: string;
}

/**
 * THE PROJECT (§60).
 *
 * Everything in the Studio until now edited the survey DEFINITION — the
 * questionnaire, its logic, its branding, its deployment slugs. All of it is
 * versioned, and all of it is about what a respondent sees. A project is the
 * piece of work around the questionnaire: who it is for, who is running it,
 * when it is in field, when the deliverable is due. None of that belongs in a
 * version, and until this panel the platform had nowhere to put it — so it
 * went into project titles ("ACME brand tracker W4 — due 12 Mar") and into
 * `def.meta.description`, where nothing could sort or filter it.
 *
 * The panel also carries the two settings the platform has always ENFORCED
 * and never been able to switch:
 *
 *   THE FREEZE. `surveys.locked` arrived in migration 0008 and `lib/guard.ts`
 *   has honoured it ever since — a frozen project refuses every write, for
 *   everyone but the owner, with a 423. No screen could ever set it. The
 *   capability that governs it, `project.lock_settings`, was declared in
 *   `packages/access` and referenced by nothing.
 *
 *   THIS PROJECT'S COLLABORATION RULES. `surveys.collaboration` arrived in
 *   the same migration and was read and written by nothing at all. It now
 *   holds the overrides its name always promised, over the workspace policy.
 *
 * Both are owner-only, which is what `project.lock_settings` means.
 */
export function ProjectPanel() {
  const s = useStudio();
  const [p, setP] = React.useState<Project | null>(null);
  const [can, setCan] = React.useState<{ edit: boolean; lockSettings: boolean }>({ edit: false, lockSettings: false });
  const [available, setAvailable] = React.useState(true);
  const [note, setNote] = React.useState<{ text: string; ok: boolean } | null>(null);
  const [busy, setBusy] = React.useState(false);
  const [role, setRole] = React.useState<string | null>(null);
  /*
   * Why the project could not be read, when it could not. A panel that waits
   * for ever on "Reading this project…" is the worst of the three possible
   * states: the person cannot tell whether it is slow, broken, or refusing
   * them.
   */
  const [loadError, setLoadError] = React.useState<string | null>(null);

  const say = (text: string, ok = true) => { setNote({ text, ok }); setTimeout(() => setNote(null), 8000); };

  const refresh = React.useCallback(() => {
    setLoadError(null);
    fetch(`/api/surveys/${s.surveyDbId}/config`, { cache: "no-store" })
      .then(async (r) => {
        const d = await r.json().catch(() => ({}));
        if (!r.ok) {
          setLoadError(
            r.status === 401 || r.status === 403
              ? d.error ?? "You are not signed in to a project, so there is nothing to configure."
              : d.error ?? `The project could not be read (${r.status}).`,
          );
          return null;
        }
        return d;
      })
      .then((d) => {
        if (!d) return;
        setAvailable(d.available !== false);
        setCan(d.can ?? { edit: false, lockSettings: false });
        setRole(d.role ?? null);
        if (d.project) {
          setP({
            id: d.project.id, code: d.project.code, title: d.project.title, status: d.project.status,
            clientName: d.project.clientName ?? null, projectManager: d.project.projectManager ?? null,
            fieldworkFrom: d.project.fieldworkFrom ?? null, fieldworkTo: d.project.fieldworkTo ?? null,
            dueDate: d.project.dueDate ?? null, costCentre: d.project.costCentre ?? null,
            notes: d.project.notes ?? null, locked: !!d.project.locked,
            collaboration: d.project.collaboration ?? {}, updatedAt: d.project.updatedAt,
          });
        }
        if (d.note) setNote({ text: d.note, ok: false });
      })
      .catch((e) => setLoadError((e as Error).message || "The project could not be read."));
  }, [s.surveyDbId]);
  React.useEffect(refresh, [refresh]);

  const save = async (patch: Record<string, unknown>, message?: string) => {
    setBusy(true);
    try {
      const r = await fetch(`/api/surveys/${s.surveyDbId}/config`, {
        method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify(patch),
      });
      const j = await r.json();
      if (!r.ok) { say(j.error ?? `That could not be saved (${r.status})`, false); refresh(); return false; }
      if (j.project) setP((prev) => (prev ? { ...prev, ...j.project } : prev));
      say(j.note ?? message ?? "Saved.");
      return true;
    } catch (e) { say((e as Error).message, false); return false; }
    finally { setBusy(false); }
  };

  if (!p) {
    return (
      <div>
        <div className="row" style={{ marginBottom: 12 }}>
          <h2 style={{ margin: 0, fontSize: 17 }}>Project</h2>
          <span className="grow" />
          <button className="btn small" onClick={refresh}>↻ retry</button>
        </div>
        <p className="muted" style={{ fontSize: 13 }}>
          This is the project, not the questionnaire: who it is for, who is running it, when it is in field and when it
          is due. The questionnaire itself is under <strong>Survey Settings</strong>.
        </p>
        {loadError
          ? <div className="chip warn qd-note" data-testid="pj-unavailable">{loadError}</div>
          : <div className="muted" style={{ fontSize: 13 }}>Reading this project…</div>}
      </div>
    );
  }

  /* a text field that saves when it loses focus, like every other settings field here */
  const field = (
    key: keyof Project,
    label: string,
    opts: { placeholder?: string; type?: string; width?: number; hint?: string } = {},
  ) => (
    <label className="f" style={{ width: opts.width ?? 230 }}>
      <span>{label}</span>
      <input
        className="input"
        type={opts.type ?? "text"}
        defaultValue={(p[key] as string) ?? ""}
        placeholder={opts.placeholder}
        disabled={!can.edit || busy}
        data-testid={`pj-${String(key)}`}
        onBlur={(e) => {
          const value = e.target.value.trim();
          if (value === ((p[key] as string) ?? "")) return;
          void save({ [key]: value || null });
        }}
      />
      {opts.hint && <span className="muted" style={{ fontSize: 11.5 }}>{opts.hint}</span>}
    </label>
  );

  const days = p.dueDate ? Math.round((Date.parse(p.dueDate) - Date.now()) / 86_400_000) : null;

  return (
    <div>
      <div className="row" style={{ marginBottom: 12, flexWrap: "wrap" }}>
        <h2 style={{ margin: 0, fontSize: 17 }}>Project</h2>
        <span className="chip mono">{p.code}</span>
        <span className="chip">{p.status}</span>
        {p.locked && <span className="chip warn" data-testid="pj-frozen">frozen by the owner</span>}
        <span className="grow" />
        <button className="btn small" onClick={refresh}>↻ refresh</button>
      </div>

      <p className="muted" style={{ fontSize: 13 }}>
        This is the project, not the questionnaire. Nothing here is versioned and nothing here reaches a respondent —
        it is what the team files the work under, and what the dashboard can then answer questions about. The
        questionnaire itself is under <strong>Survey Settings</strong>.
      </p>

      {!available && (
        <div className="chip warn qd-note" data-testid="pj-migration-note">
          Project configuration needs migration 0015. The project&apos;s code, title and status work now; the rest
          appears once it is applied.
        </div>
      )}
      {!can.edit && available && (
        <div className="chip qd-note" data-testid="pj-readonly">
          Your role on this project ({role ?? "viewer"}) can read this but not change it.
        </div>
      )}
      {note && <div className={`chip ${note.ok ? "on" : "warn"} qd-note`} data-testid="pj-note">{note.text}</div>}

      <h3 className="sec">Who it is for</h3>
      <div className="card">
        <div className="row" style={{ flexWrap: "wrap", gap: 10 }}>
          {field("clientName", "Client", { placeholder: "Acme Foods", hint: "The end client — not your workspace, and not the URL slug." })}
          {field("projectManager", "Project manager", { placeholder: "Ada Lovelace", hint: "Free text: often somebody without a login here." })}
          {field("costCentre", "Cost centre", { placeholder: "RES-2026-014", width: 170 })}
        </div>
      </div>

      <h3 className="sec">Dates</h3>
      <div className="card">
        <div className="row" style={{ flexWrap: "wrap", gap: 10, alignItems: "flex-start" }}>
          {field("fieldworkFrom", "Fieldwork from", { type: "date", width: 175 })}
          {field("fieldworkTo", "Fieldwork to", { type: "date", width: 175 })}
          {field("dueDate", "Deliverable due", { type: "date", width: 175, hint: "Which is not when fieldwork closes." })}
          {days != null && (
            <span className={`chip ${days < 0 ? "warn" : days <= 3 ? "warn" : "on"}`} data-testid="pj-due-chip" style={{ marginTop: 22 }}>
              {days < 0 ? `${Math.abs(days)} day${Math.abs(days) === 1 ? "" : "s"} overdue` : days === 0 ? "due today" : `${days} day${days === 1 ? "" : "s"} to go`}
            </span>
          )}
        </div>
      </div>

      <h3 className="sec">Notes</h3>
      <div className="card">
        <label className="f">
          <span>Internal notes about the project</span>
          <textarea
            className="input" rows={4}
            defaultValue={p.notes ?? ""}
            disabled={!can.edit || busy}
            data-testid="pj-notes"
            placeholder="What this study is for, what was agreed, anything the next person to open it needs to know."
            onBlur={(e) => { if (e.target.value !== (p.notes ?? "")) void save({ notes: e.target.value || null }); }}
          />
          <span className="muted" style={{ fontSize: 11.5 }}>
            Separate from the questionnaire&apos;s own description, which is versioned with it and shown to nobody
            internal. For a discussion, use Internal notes — this is a standing description.
          </span>
        </label>
      </div>

      {/*
        * Owner-only, because `project.lock_settings` is granted to the owner
        * alone. Shown to everybody so that a person who cannot change the
        * freeze can still see that it exists and who could lift it.
        */}
      <h3 className="sec">Access to this project</h3>
      <div className="card" data-testid="pj-access">
        <label className="ax-toggle" style={{ marginBottom: 8 }}>
          <input
            type="checkbox" checked={p.locked} disabled={!can.lockSettings || busy}
            data-testid="pj-lock"
            onChange={(e) => void save({ locked: e.target.checked })}
          />
          <span>
            <strong>Freeze this project.</strong> Nobody but the owner can change anything — the survey, its responses,
            its deployment. The platform has enforced this since it was built; this is the switch.
          </span>
        </label>
        {!can.lockSettings && (
          <p className="muted" style={{ fontSize: 12.5, margin: "0 0 8px" }}>
            Only the project&apos;s owner can freeze or unfreeze it.
          </p>
        )}

        <div className="flabel" style={{ marginTop: 6 }}>This project&apos;s collaboration rules</div>
        <p className="muted" style={{ fontSize: 12.5, marginTop: 0 }}>
          Overrides for this project only. Anything left alone follows the workspace policy.
        </p>
        <label className="ax-toggle">
          <input
            type="checkbox" checked={p.collaboration.requireLockToEdit !== false}
            disabled={!can.lockSettings || busy}
            data-testid="pj-require-lock"
            onChange={(e) => void save({ collaboration: { ...p.collaboration, requireLockToEdit: e.target.checked } })}
          />
          <span>An editor must hold the edit lock before saving</span>
        </label>
        <label className="ax-toggle">
          <input
            type="checkbox" checked={p.collaboration.allowConcurrentViewers !== false}
            disabled={!can.lockSettings || busy}
            data-testid="pj-concurrent-viewers"
            onChange={(e) => void save({ collaboration: { ...p.collaboration, allowConcurrentViewers: e.target.checked } })}
          />
          <span>Others may open this project read-only while somebody is editing</span>
        </label>
        <label className="f" style={{ width: 210, marginTop: 6 }}>
          <span>The edit lock lasts (minutes)</span>
          <input
            className="input" type="number" min={1} max={480}
            defaultValue={p.collaboration.lockMinutes ?? ""}
            placeholder="workspace default"
            disabled={!can.lockSettings || busy}
            data-testid="pj-lock-minutes"
            onBlur={(e) => {
              const v = e.target.value === "" ? undefined : Number(e.target.value);
              if (v === p.collaboration.lockMinutes) return;
              const next = { ...p.collaboration };
              if (v === undefined) delete next.lockMinutes; else next.lockMinutes = v;
              void save({ collaboration: next });
            }}
          />
        </label>
      </div>

      <p className="muted" style={{ fontSize: 12, marginTop: 12 }}>
        Changes here save as you leave each field, and are recorded in the project&apos;s activity — a freeze most of
        all, because it is what somebody will be looking for when they ask why they cannot save.
      </p>
    </div>
  );
}

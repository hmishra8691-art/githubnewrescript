"use client";
import React from "react";
import { MAX_WEIGHT, checkRequirement } from "@rescript/interviews";

export interface BuilderRequirement {
  id: string;
  code: string;
  title: string;
  description: string | null;
  criteria: string | null;
  weight: number;
  position: number;
}

/**
 * WHAT THE INTERVIEW IS ACTUALLY ASSESSING.
 *
 * The input to the entire evaluation pipeline, and until now the only part of
 * the product with no way to create it at all. `interview_requirements` has
 * been read by the analysis prompt since 0030 and written by nothing, so every
 * analysis ever run was handed an empty list and asked to find evidence for
 * nothing in particular. That is why the evidence table was always empty.
 *
 * ## The criteria field is the one that matters
 *
 * `title` names the requirement. `criteria` is the only part the model is
 * shown as *what meeting it looks like*, and without it the model infers a
 * standard — which is the failure this product is most obliged to avoid, since
 * an inferred standard is then applied to a person. The form says so, every
 * time, and still lets the requirement be saved: a draft is worth keeping.
 */
export function RequirementsPanel({ projectId, requirements: initial, mayEdit }: {
  projectId: string;
  requirements: BuilderRequirement[];
  mayEdit: boolean;
}) {
  const [items, setItems] = React.useState(initial);
  const [editing, setEditing] = React.useState<string | null>(null);
  const [adding, setAdding] = React.useState(false);
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const [note, setNote] = React.useState<string | null>(null);

  async function save(draft: Partial<BuilderRequirement> & { id?: string }) {
    setBusy(true); setError(null); setNote(null);
    const isNew = !draft.id;
    const res = await fetch(
      isNew
        ? `/api/projects/${projectId}/requirements`
        : `/api/projects/${projectId}/requirements/${draft.id}`,
      {
        method: isNew ? "POST" : "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          title: draft.title, description: draft.description,
          criteria: draft.criteria, weight: draft.weight,
        }),
      },
    );
    const reply = await res.json().catch(() => ({}));
    setBusy(false);
    if (!res.ok || !reply.ok) { setError(reply.error ?? "That could not be saved."); return; }
    setItems((rs) => isNew
      ? [...rs, reply.requirement]
      : rs.map((r) => (r.id === reply.requirement.id ? reply.requirement : r)));
    if (reply.warnings?.length) setNote(reply.warnings.join(" "));
    setEditing(null); setAdding(false);
  }

  async function remove(r: BuilderRequirement) {
    setBusy(true); setError(null); setNote(null);
    const res = await fetch(`/api/projects/${projectId}/requirements/${r.id}`, { method: "DELETE" });
    const reply = await res.json().catch(() => ({}));
    setBusy(false);
    if (!res.ok || !reply.ok) {
      /*
       * The 409 here is not an error the interviewer did anything wrong to
       * cause — it is the product refusing to rewrite what was concluded about
       * somebody who has already interviewed. It reads as guidance, not as a
       * failure.
       */
      setError(reply.error ?? "That could not be removed.");
      return;
    }
    setItems((rs) => rs.filter((x) => x.id !== r.id));
  }

  return (
    <section className="card" data-testid="requirements-panel">
      <div className="row" style={{ justifyContent: "space-between", alignItems: "baseline" }}>
        <h2 style={{ margin: 0 }}>What you are assessing</h2>
        {mayEdit && !adding && (
          <button className="btn" onClick={() => { setAdding(true); setEditing(null); }}
            data-testid="add-requirement">Add a requirement</button>
        )}
      </div>

      <p className="muted small" style={{ marginTop: 4 }}>
        Each answer is compared against these, and every finding has to quote the words that
        support it. Without requirements an interview is still recorded and transcribed — it just
        is not evaluated.
      </p>

      {items.length === 0 && !adding && (
        <p className="note warn" data-testid="no-requirements">
          This interview has nothing to assess against yet, so no analysis will be produced.
        </p>
      )}

      {items.map((r) => (
        <div key={r.id} data-testid="requirement-row" data-code={r.code}
          style={{ borderTop: "1px solid var(--line)", paddingTop: 12, marginTop: 12 }}>
          {editing === r.id ? (
            <RequirementForm initial={r} busy={busy} onCancel={() => setEditing(null)}
              onSave={(d) => save({ ...d, id: r.id })} />
          ) : (
            <div className="row" style={{ justifyContent: "space-between", gap: 12, alignItems: "flex-start" }}>
              <div style={{ flex: 1 }}>
                <div className="row" style={{ gap: 8, alignItems: "baseline", flexWrap: "wrap" }}>
                  <strong><code>{r.code}</code></strong>
                  <span>{r.title}</span>
                  <span className="pill" title="How much this counts relative to the others">
                    {r.weight === 0 ? "not scored" : `weight ${r.weight}`}
                  </span>
                </div>
                {r.criteria
                  ? <p className="small muted" style={{ margin: "6px 0 0" }}>{r.criteria}</p>
                  : <p className="tiny warn" style={{ margin: "6px 0 0" }}>
                      No description of what meeting this looks like — the analysis will have to guess.
                    </p>}
              </div>
              {mayEdit && (
                <div className="row" style={{ gap: 6 }}>
                  <button className="btn small secondary" onClick={() => { setEditing(r.id); setAdding(false); }}
                    data-testid="edit-requirement">Edit</button>
                  <button className="btn small secondary" disabled={busy} onClick={() => void remove(r)}
                    data-testid="remove-requirement">Remove</button>
                </div>
              )}
            </div>
          )}
        </div>
      ))}

      {adding && (
        <div style={{ borderTop: "1px solid var(--line)", paddingTop: 12, marginTop: 12 }}>
          <RequirementForm busy={busy} onCancel={() => setAdding(false)} onSave={(d) => save(d)} />
        </div>
      )}

      {note && <p className="note" style={{ marginTop: 12 }} data-testid="requirement-note">{note}</p>}
      {error && <p className="note bad" style={{ marginTop: 12 }} data-testid="requirement-error">{error}</p>}
    </section>
  );
}

function RequirementForm({ initial, busy, onSave, onCancel }: {
  initial?: BuilderRequirement;
  busy: boolean;
  onSave: (d: Partial<BuilderRequirement>) => void;
  onCancel: () => void;
}) {
  const [title, setTitle] = React.useState(initial?.title ?? "");
  const [criteria, setCriteria] = React.useState(initial?.criteria ?? "");
  const [description, setDescription] = React.useState(initial?.description ?? "");
  const [weight, setWeight] = React.useState(initial?.weight ?? 1);

  const check = checkRequirement({ title, criteria, weight });

  return (
    <form data-testid="requirement-form"
      onSubmit={(e) => { e.preventDefault(); onSave({ title, criteria, description, weight }); }}>
      <label>
        <span>What are you assessing?</span>
        <input value={title} onChange={(e) => setTitle(e.target.value)}
          placeholder="Explains technical work to a non-technical audience"
          data-testid="requirement-title" />
      </label>

      <label>
        <span>What does meeting it look like?</span>
        <textarea value={criteria ?? ""} onChange={(e) => setCriteria(e.target.value)} rows={3}
          placeholder="Describes a project without jargon, checks the listener is following, and uses a concrete example rather than an abstraction."
          data-testid="requirement-criteria" />
        <span className="tiny muted">
          This is the part the analysis is actually shown. The more concrete it is, the less the
          model has to infer — and inference about a person is what we are trying to avoid.
        </span>
      </label>

      <label>
        <span>Notes for your team (optional — never sent to the model)</span>
        <input value={description ?? ""} onChange={(e) => setDescription(e.target.value)}
          data-testid="requirement-description" />
      </label>

      <label style={{ maxWidth: 220 }}>
        <span>Weight</span>
        <input type="number" min={0} max={MAX_WEIGHT} step={0.5} value={weight}
          onChange={(e) => setWeight(Number(e.target.value))} data-testid="requirement-weight" />
        <span className="tiny muted">
          A multiplier, not a percentage — adding a requirement later will not silently re-weight
          this one. Zero means assess it but do not let it move the score.
        </span>
      </label>

      {check.errors.map((e) => (
        <p key={e} className="note bad" style={{ marginTop: 10 }} data-testid="requirement-form-error">{e}</p>
      ))}
      {check.warnings.map((w) => (
        <p key={w} className="note warn" style={{ marginTop: 10 }} data-testid="requirement-form-warning">{w}</p>
      ))}

      <div className="row" style={{ gap: 10, marginTop: 14 }}>
        <button className="btn" disabled={busy || !check.ok} data-testid="save-requirement">
          {initial ? "Save changes" : "Add requirement"}
        </button>
        <button type="button" className="btn secondary" onClick={onCancel}>Cancel</button>
      </div>
    </form>
  );
}

"use client";
import React from "react";
import type { Condition } from "@rescript/schema";
import type { VariableMeta } from "@rescript/analytics";
import { AxApi, type Row } from "./api";
import { FilterBuilder, conditionText, emptyCondition, isEmptyCondition } from "./FilterBuilder";

/** Reusable segments and saved filters (§6, §7) — the same Condition object, two intents. */
export function SegmentsPanel({ api, variables, items, kind, onChange }: { api: AxApi; variables: VariableMeta[]; items: Row[]; kind: "segment" | "filter"; onChange: () => void }) {
  const [editing, setEditing] = React.useState<Row | null>(null);
  const [name, setName] = React.useState("");
  const [description, setDescription] = React.useState("");
  const [color, setColor] = React.useState("#2563eb");
  const [cond, setCond] = React.useState<Condition>(emptyCondition());
  const [error, setError] = React.useState<string | null>(null);
  const [busy, setBusy] = React.useState(false);
  const list = items.filter((s) => s.kind === kind);
  const start = (s?: Row) => { setEditing(s ?? { id: null }); setName(s?.name ?? ""); setDescription(s?.description ?? ""); setColor(s?.color ?? "#2563eb"); setCond((s?.condition as Condition) ?? emptyCondition()); setError(null); };
  const save = async () => {
    if (!name.trim()) return setError("Give it a name.");
    if (isEmptyCondition(cond)) return setError("Add at least one condition.");
    setBusy(true);
    try { const body = { name: name.trim(), description, color, condition: cond, kind }; if (editing?.id) await api.update("segments", editing.id, body); else await api.create("segments", body); setEditing(null); onChange(); } catch (e) { setError((e as Error).message); } finally { setBusy(false); }
  };
  const label = kind === "segment" ? "segment" : "filter";
  return (
    <div className="ax-panel" data-testid={`ax-${kind}s`}>
      <div className="row" style={{ marginBottom: 10 }}>
        <h2 style={{ margin: 0 }}>{kind === "segment" ? "Segments" : "Saved filters"}</h2>
        <span className="muted" style={{ fontSize: 12 }}>{kind === "segment" ? "Reusable respondent groups, available in every analysis, chart, table, report and dashboard." : "Reusable conditions applied before an analysis runs."}</span>
        <span className="grow" />
        <button className="btn primary small" onClick={() => start()} data-testid={`ax-new-${kind}`}>+ New {label}</button>
      </div>
      {editing && (
        <div className="card" data-testid="ax-segment-editor">
          <div className="row" style={{ marginBottom: 8, flexWrap: "wrap" }}>
            <input className="input" placeholder={`${kind === "segment" ? "Segment" : "Filter"} name`} value={name} onChange={(e) => setName(e.target.value)} style={{ maxWidth: 280 }} data-testid="ax-segment-name" />
            <input className="input" placeholder="Description (optional)" value={description} onChange={(e) => setDescription(e.target.value)} style={{ maxWidth: 360 }} />
            {kind === "segment" && <input type="color" value={color} onChange={(e) => setColor(e.target.value)} title="Colour" />}
          </div>
          <FilterBuilder value={cond} onChange={setCond} variables={variables} />
          {!isEmptyCondition(cond) && <div className="ax-summary">{conditionText(cond, variables)}</div>}
          <div className="row" style={{ marginTop: 10 }}>{error && <span className="ax-error">{error}</span>}<span className="grow" /><button className="btn small" onClick={() => setEditing(null)}>Cancel</button><button className="btn primary small" disabled={busy} onClick={save} data-testid="ax-segment-save">{editing.id ? "Save changes" : `Create ${label}`}</button></div>
        </div>
      )}
      <div className="ax-cards">
        {list.map((s) => (
          <div key={s.id} className="card ax-seg-card" data-testid="ax-segment-card">
            <div className="card-title">{kind === "segment" && <span className="ax-dot" style={{ background: s.color ?? "#2563eb" }} />}{s.name}</div>
            {s.description && <div className="muted" style={{ fontSize: 12 }}>{s.description}</div>}
            <div className="ax-summary" style={{ marginTop: 6 }}>{conditionText(s.condition as Condition, variables) || "—"}</div>
            <div className="card-actions" style={{ marginTop: 8 }}><button className="btn small" onClick={() => start(s)}>Edit</button><button className="btn small danger" onClick={async () => { if (confirm(`Delete ${label} “${s.name}”? Saved analyses that reference it keep their inline copy.`)) { await api.remove("segments", s.id); onChange(); } }}>Delete</button><span className="grow" /><span className="muted" style={{ fontSize: 11 }}>updated {new Date(s.updated_at).toLocaleDateString()}</span></div>
          </div>
        ))}
        {!list.length && !editing && <div className="muted">No {label}s yet.</div>}
      </div>
    </div>
  );
}

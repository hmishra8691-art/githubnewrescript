"use client";
import React from "react";
import type { AnalysisDefinition, CatalogueEntry, ChartSpec, VariableMeta } from "@rescript/analytics";
import { ConfigEditor } from "./ConfigEditor";
import { InterpretationPanel } from "../InterpretationPanel";
import type { AxApi } from "../api";
import { useDetail } from "../detail";
import type { Row, RunResult } from "../api";
import { STATUS_WORD } from "./Explorer";

/**
 * PROPERTIES — the Architect's right pane, for the entry in focus.
 *
 *   What it is        the research label, what it answers and why, the hypotheses it serves, its state
 *   Recommended       the charts the engine recommends for this result, with its reason, one click to switch
 *   Configuration     the definition as the builder holds it — edited here (ConfigEditor) and saved through the
 *                     builder's own route, so a change recomputes the result in place
 *   Technical         the ids: question codes, variable names, the saved name, kind, method, analysis id, hash —
 *                     kept, never used as the label
 */
export function Properties(p: { entry: CatalogueEntry | null; result: RunResult | undefined; analysis: Row | undefined; spec: ChartSpec | null; onSpec: (s: ChartSpec) => void; canEdit: boolean; onOpenInBuilder: (id: string) => void; variables: VariableMeta[]; onSaveDefinition: (analysisId: string, d: AnalysisDefinition) => Promise<void>; api: AxApi; /** bumps when the analysis was saved or the dataset changed */ nonce: string }) {
  const { level } = useDetail();
  const [tech, setTech] = React.useState(level === "advanced");
  React.useEffect(() => { setTech(level === "advanced"); }, [level]);
  const [editing, setEditing] = React.useState(false);
  const [saving, setSaving] = React.useState(false);
  React.useEffect(() => { setEditing(false); }, [p.entry?.key]);
  const e = p.entry;
  if (!e) return <div className="axa-props muted" data-testid="axa-properties" style={{ padding: 12, fontSize: 13 }}>Select an entry to see what it answers, why it exists and how it is configured.</div>;
  const def = p.analysis?.definition as { rows?: string[]; columns?: string[]; layers?: string[]; measure?: string; options?: Record<string, unknown>; filter?: unknown; weighting?: unknown } | undefined;
  const varLabel = (n: string) => e.technical.variables.find((v) => v.name === n)?.researchLabel ?? n;
  return (
    <div className="axa-props" data-testid="axa-properties">
      <section className="axa-prop-sec">
        <div className="eyebrow">What it is</div>
        <div className="axa-prop-label">{e.label}</div>
        <p className="axa-prop-descr">{e.description}</p>
        {e.redundantOf && <p className="axa-warning" data-testid="axa-redundant">Repeats another analysis on the same variables — one of the two can go.</p>}
        <dl className="axa-dl">
          <dt>State</dt><dd><span className={`axa-dot ${e.status}`} /> {STATUS_WORD[e.status] || "—"}{e.verdict ? ` · ${e.verdict.replace("_", " ")}` : ""}</dd>
          {e.hypotheses.length > 0 && <><dt>Serves</dt><dd>{e.hypotheses.join(", ")}</dd></>}
          {p.result && <><dt>Base</dt><dd>n = {p.result.base.n.toLocaleString("en-US")}{p.result.base.weightedN && p.result.base.weightedN !== p.result.base.n ? ` (weighted ${Math.round(p.result.base.weightedN).toLocaleString("en-US")})` : ""}</dd></>}
          {e.findings ? <><dt>Findings</dt><dd>{e.findings} significant</dd></> : null}
          {e.updatedAt && <><dt>Updated</dt><dd>{new Date(e.updatedAt).toLocaleString()}</dd></>}
        </dl>
      </section>
      {e.analysisId && p.result && (
        <section className="axa-prop-sec" data-testid="axa-interpretation">
          <div className="eyebrow">Interpretation</div>
          <InterpretationPanel api={p.api} analysisId={e.analysisId} nonce={p.nonce} compact />
        </section>
      )}
      {p.result && p.result.recommendations.length > 0 && (
        <section className="axa-prop-sec" data-testid="axa-recommended">
          <div className="eyebrow">Recommended charts</div>
          {p.result.recommendations.slice(0, 5).map((r) => (
            <button key={r.type} className={`axa-rec ${p.spec?.type === r.type ? "on" : ""}`} onClick={() => p.onSpec({ ...(p.spec ?? { type: r.type, options: {} }), type: r.type })} title={r.reason}>
              <span className="axa-rec-type">{r.type.replace(/_/g, " ")}</span>
              <span className="axa-rec-why">{r.reason}</span>
            </button>
          ))}
        </section>
      )}
      {def && (
        <section className="axa-prop-sec" data-testid="axa-config">
          <div className="eyebrow" style={{ display: "flex", alignItems: "center", gap: 8 }}>Configuration<span className="grow" />{p.canEdit && e.analysisId && !editing && <button className="btn small ghost" onClick={() => setEditing(true)} data-testid="axa-config-edit">Edit</button>}</div>
          {editing && p.analysis && (
            <ConfigEditor definition={p.analysis.definition as AnalysisDefinition} variables={p.variables} labelOf={varLabel} saving={saving}
              onSave={async (d) => { setSaving(true); try { await p.onSaveDefinition(e.analysisId!, d); setEditing(false); } finally { setSaving(false); } }} onCancel={() => setEditing(false)} />
          )}
          {!editing && <>
          <dl className="axa-dl">
            {def.rows?.length ? <><dt>Rows</dt><dd>{def.rows.map(varLabel).join(", ")}</dd></> : null}
            {def.columns?.length ? <><dt>Columns</dt><dd>{def.columns.map(varLabel).join(", ")}</dd></> : null}
            {def.layers?.length ? <><dt>Layers</dt><dd>{def.layers.map(varLabel).join(", ")}</dd></> : null}
            {!def.rows?.length && e.technical.variables.length ? <><dt>Variables</dt><dd>{e.technical.variables.map((v) => v.researchLabel).join(", ")}</dd></> : null}
            {def.measure && <><dt>Measure</dt><dd>{def.measure.replace("_", " ")}</dd></>}
            {def.filter ? <><dt>Filter</dt><dd>applied</dd></> : null}
            {def.weighting ? <><dt>Weighting</dt><dd>applied</dd></> : null}
            {def.options && Object.keys(def.options).filter((k) => k !== "planned").map((k) => <React.Fragment key={k}><dt>{k}</dt><dd>{String(def.options![k])}</dd></React.Fragment>)}
          </dl>
          {p.canEdit && e.analysisId && <button className="btn small ghost" onClick={() => p.onOpenInBuilder(e.analysisId!)}>Everything else, in the builder</button>}
          </>}
        </section>
      )}
      <section className="axa-prop-sec">
        <button className="axa-tech-toggle" onClick={() => setTech((t) => !t)} aria-expanded={tech} data-testid="axa-tech-toggle">Technical details {tech ? "▾" : "▸"}</button>
        {tech && (
          <dl className="axa-dl mono" data-testid="axa-tech">
            {e.technical.name && <><dt>Saved as</dt><dd>{e.technical.name}</dd></>}
            {e.technical.kind && <><dt>Kind</dt><dd>{e.technical.kind}</dd></>}
            {e.technical.method && <><dt>Method</dt><dd>{e.technical.method}</dd></>}
            {e.technical.chartType && <><dt>Chart</dt><dd>{e.technical.chartType}</dd></>}
            {e.technical.variables.map((v) => <React.Fragment key={v.name}><dt>{v.code ?? "var"}</dt><dd>{v.name}{v.construct ? ` · ${v.construct}` : ""}{v.kpi ? ` · KPI ${v.kpi}` : ""}</dd></React.Fragment>)}
            {e.analysisId && <><dt>Analysis id</dt><dd>{e.analysisId}</dd></>}
            {e.planned && <><dt>Plan item</dt><dd>{e.planned}</dd></>}
            {e.technical.hash && <><dt>Hash</dt><dd>{e.technical.hash}</dd></>}
            {e.technical.missing?.length ? <><dt>Missing</dt><dd>{e.technical.missing.join(", ")}</dd></> : null}
            <dt>Key</dt><dd>{e.key}</dd>
          </dl>
        )}
      </section>
    </div>
  );
}

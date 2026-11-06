"use client";
import React from "react";
import type { AnalysisDefinition, VariableMeta } from "@rescript/analytics";
import type { Condition } from "@rescript/schema";
import { FilterBuilder, conditionText, emptyCondition, isEmptyCondition } from "../FilterBuilder";

/**
 * THE CONFIGURATION, EDITED FROM PROPERTIES (M4). The common shape of every analysis — which variables, in which
 * slot (rows / columns / layers, outcome / groups, dependent / predictors), the measure, the test or method, the
 * filter — edited beside the result without leaving Architect, and saved through the same route the builder
 * saves through (`PUT analyses/<id>`), so Builder, Results and Architect never disagree. Everything the slots do
 * not cover (weighting, segments, per-kind options) is one click away in the full builder.
 */
const SLOTS: Record<string, { key: "rows" | "columns" | "layers" | "variables"; label: string; max?: number; index?: number; hint?: string }[]> = {
  crosstab: [{ key: "rows", label: "Rows" }, { key: "columns", label: "Columns" }, { key: "layers", label: "Layers", max: 1 }],
  test: [{ key: "variables", label: "Outcome", index: 0, max: 1 }, { key: "variables", label: "Groups / second variable", index: 1, max: 1 }],
  correlation: [{ key: "variables", label: "Variables" }],
  regression: [{ key: "variables", label: "Dependent", index: 0, max: 1 }, { key: "variables", label: "Predictors", index: 1 }],
};
const TESTS = ["auto", "chi_square", "fisher", "t_independent", "t_paired", "t_one_sample", "anova_one_way", "mann_whitney", "wilcoxon", "kruskal_wallis", "friedman", "proportion"];
const MEASURES: { v: NonNullable<AnalysisDefinition["measure"]>; l: string }[] = [{ v: "pct_col", l: "Column %" }, { v: "pct_row", l: "Row %" }, { v: "pct_total", l: "Total %" }, { v: "count", l: "Counts" }, { v: "mean", l: "Means" }];

export function ConfigEditor(p: { definition: AnalysisDefinition; variables: VariableMeta[]; labelOf: (name: string) => string; saving: boolean; onSave: (d: AnalysisDefinition) => Promise<void>; onCancel: () => void }) {
  const [d, setD] = React.useState<AnalysisDefinition>(() => structuredClone(p.definition));
  const [filterOpen, setFilterOpen] = React.useState(false);
  const [search, setSearch] = React.useState("");
  const [picking, setPicking] = React.useState<string | null>(null);
  const slots = SLOTS[d.kind] ?? [{ key: "variables" as const, label: "Variables" }];
  const usable = React.useMemo(() => p.variables.filter((v) => !v.hidden && v.role !== "complex" && v.role !== "system"), [p.variables]);
  const dirty = JSON.stringify(d) !== JSON.stringify(p.definition);

  const slotValues = (s: (typeof slots)[number]): string[] => {
    if (s.key === "variables" && s.index != null) return s.max === 1 ? d.variables.slice(s.index, s.index + 1) : d.variables.slice(s.index);
    return (d[s.key] ?? []) as string[];
  };
  const setSlot = (s: (typeof slots)[number], names: string[]) => {
    setD((cur) => {
      const next = { ...cur };
      if (s.key === "variables" && s.index != null) {
        const vars = [...cur.variables];
        if (s.max === 1) vars.splice(s.index, 1, ...names.slice(0, 1)); else vars.splice(s.index, vars.length - s.index, ...names);
        next.variables = vars.filter(Boolean);
      } else {
        next[s.key] = names as never;
        if (s.key !== "variables") next.variables = [...new Set([...(next.rows ?? []), ...(next.columns ?? []), ...(next.layers ?? [])])];
      }
      return next;
    });
  };
  const slotId = (s: (typeof slots)[number]) => `${s.key}:${s.index ?? ""}`;
  const q = search.trim().toLowerCase();
  const choices = q ? usable.filter((v) => [v.name, v.label, v.questionCode ?? "", v.itemLabel ?? ""].join(" ").toLowerCase().includes(q)).slice(0, 40) : usable.slice(0, 40);

  return (
    <div className="axa-config" data-testid="axa-config-editor">
      {slots.map((s) => {
        const vals = slotValues(s);
        const open = picking === slotId(s);
        return (
          <div key={slotId(s)} className="axa-config-slot">
            <div className="axa-config-label">{s.label}</div>
            <div className="ax-chips">
              {vals.map((n) => <span key={n} className="ax-chip on" title={n}>{p.labelOf(n)} <button className="ax-explore-x" aria-label={`Remove ${n}`} onClick={() => setSlot(s, vals.filter((x) => x !== n))}>×</button></span>)}
              {(s.max == null || vals.length < s.max) && <button className="ax-chip" onClick={() => { setPicking(open ? null : slotId(s)); setSearch(""); }} data-testid={`axa-config-add-${s.key}${s.index ?? ""}`}>{open ? "close" : "+ add"}</button>}
            </div>
            {open && (
              <div className="axa-config-pick">
                <input className="input small" autoFocus placeholder="Find a variable…" value={search} onChange={(e) => setSearch(e.target.value)} />
                <div className="axa-config-pick-list">
                  {choices.filter((v) => !vals.includes(v.name)).map((v) => <button key={v.name} className="axa-config-pick-row" onClick={() => { setSlot(s, s.max === 1 ? [v.name] : [...vals, v.name]); if (s.max === 1) setPicking(null); }}><span className="mono muted">{v.questionCode ?? v.name}</span> {v.itemLabel ? `${v.label} — ${v.itemLabel}` : v.label}</button>)}
                </div>
              </div>
            )}
          </div>
        );
      })}
      {d.kind === "crosstab" && (
        <div className="axa-config-slot"><div className="axa-config-label">Measure</div>
          <select className="select small" value={d.measure ?? "pct_col"} onChange={(e) => setD({ ...d, measure: e.target.value as AnalysisDefinition["measure"] })} data-testid="axa-config-measure">{MEASURES.map((m) => <option key={m.v} value={m.v}>{m.l}</option>)}</select></div>
      )}
      {d.kind === "test" && (
        <div className="axa-config-slot"><div className="axa-config-label">Test</div>
          <select className="select small" value={String(d.options?.test ?? "auto")} onChange={(e) => setD({ ...d, options: { ...d.options, test: e.target.value } })} data-testid="axa-config-test">{TESTS.map((t) => <option key={t} value={t}>{t === "auto" ? "the test that fits" : t.replace(/_/g, " ")}</option>)}</select></div>
      )}
      {d.kind === "correlation" && (
        <div className="axa-config-slot"><div className="axa-config-label">Method</div>
          <select className="select small" value={String(d.options?.method ?? "pearson")} onChange={(e) => setD({ ...d, options: { ...d.options, method: e.target.value } })}>{["pearson", "spearman", "kendall"].map((t) => <option key={t} value={t}>{t}</option>)}</select></div>
      )}
      {d.kind === "regression" && (
        <div className="axa-config-slot"><div className="axa-config-label">Model</div>
          <select className="select small" value={String(d.options?.model ?? "linear")} onChange={(e) => setD({ ...d, options: { ...d.options, model: e.target.value } })}>{["linear", "logistic", "multinomial", "mediation"].map((t) => <option key={t} value={t}>{t}</option>)}</select></div>
      )}
      <div className="axa-config-slot">
        <div className="axa-config-label">Filter <button className="btn small ghost" onClick={() => setFilterOpen((o) => !o)} data-testid="axa-config-filter">{filterOpen ? "hide" : d.filter && !isEmptyCondition(d.filter) ? "edit" : "add"}</button></div>
        {!filterOpen && <div className="muted" style={{ fontSize: 12.5 }}>{d.filter && !isEmptyCondition(d.filter) ? conditionText(d.filter, p.variables) : "none — every complete in the dataset"}</div>}
        {filterOpen && <FilterBuilder value={(d.filter as Condition | null) ?? emptyCondition()} onChange={(c) => setD({ ...d, filter: isEmptyCondition(c) ? null : c })} variables={p.variables} />}
      </div>
      <div className="row" style={{ gap: 6, marginTop: 8 }}>
        <button className="btn primary small" disabled={!dirty || p.saving || !d.variables.length} onClick={() => void p.onSave(d)} data-testid="axa-config-save">{p.saving ? "Saving…" : "Save & recompute"}</button>
        <button className="btn small ghost" onClick={p.onCancel}>Cancel</button>
      </div>
    </div>
  );
}

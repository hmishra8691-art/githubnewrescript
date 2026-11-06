"use client";
import React from "react";
import type { AnalysisCatalogue, CatalogueEntry } from "@rescript/analytics";
import { CATALOGUE_CATEGORIES } from "@rescript/analytics";
import type { ExplorerCategory, Selection } from "@/lib/analyticsArchitect";

/**
 * THE ANALYSIS EXPLORER — the Architect's left pane. Categories with counts and an "All" view; a filter that
 * reads research labels, codes and variable names; one row per entry with a tick (what the Combined view shows
 * and what a bulk export takes), a status mark, and the research label. Clicking a row opens it in Focus.
 */
export const STATUS_WORD: Record<CatalogueEntry["status"], string> = { ready: "ready", planned: "planned, not run", stale: "stale — the plan changed", blocked: "cannot run", unknown: "" };

export function Explorer(p: {
  catalogue: AnalysisCatalogue | null;
  category: ExplorerCategory; onCategory: (c: ExplorerCategory) => void;
  filter: string; onFilter: (s: string) => void;
  entries: CatalogueEntry[];
  selection: Selection; onToggle: (key: string) => void; onFocus: (key: string) => void;
  onSelectAll: () => void; onSelectNone: () => void;
}) {
  const c = p.catalogue;
  const total = c?.all.length ?? 0;
  const selected = new Set(p.selection.keys);
  const inView = p.entries.filter((e) => selected.has(e.key)).length;
  return (
    <div className="axa-explorer" data-testid="axa-explorer">
      <div className="axa-cats" role="tablist" aria-label="Analysis categories">
        <button role="tab" aria-selected={p.category === "all"} className={`axa-cat ${p.category === "all" ? "on" : ""}`} onClick={() => p.onCategory("all")} data-testid="axa-cat-all">
          <span>All</span><span className="axa-count">{total}</span>
        </button>
        {CATALOGUE_CATEGORIES.map((k) => (
          <button key={k.key} role="tab" aria-selected={p.category === k.key} className={`axa-cat ${p.category === k.key ? "on" : ""}`} onClick={() => p.onCategory(k.key)} title={k.description} data-testid={`axa-cat-${k.key}`}>
            <span>{k.label}</span><span className="axa-count">{c?.counts[k.key] ?? 0}</span>
          </button>
        ))}
      </div>
      <div className="axa-filter">
        <input className="input" value={p.filter} onChange={(e) => p.onFilter(e.target.value)} placeholder="Find by label, code or variable…" aria-label="Filter the Explorer" data-testid="axa-filter" />
      </div>
      <div className="axa-select-row">
        <span className="muted" style={{ fontSize: 12 }}>{p.entries.length} shown{inView ? ` · ${inView} ticked` : ""}</span>
        <span className="grow" />
        <button className="btn small ghost" onClick={p.onSelectAll} disabled={!p.entries.length} data-testid="axa-select-all">All</button>
        <button className="btn small ghost" onClick={p.onSelectNone} disabled={!p.selection.keys.length} data-testid="axa-select-none">None</button>
      </div>
      <div className="axa-list" role="list">
        {!c && <div className="muted" style={{ padding: 10, fontSize: 13 }}>Loading the catalogue…</div>}
        {c && !p.entries.length && <div className="muted" style={{ padding: 10, fontSize: 13 }}>{p.filter ? "Nothing matches." : "Nothing here yet."}</div>}
        {p.entries.map((e) => {
          const on = selected.has(e.key); const focused = p.selection.focus === e.key;
          return (
            <div key={e.key} role="listitem" className={`axa-row ${focused ? "focus" : ""} ${on ? "on" : ""}`} data-testid="axa-entry" data-key={e.key} data-status={e.status}>
              <input type="checkbox" checked={on} onChange={() => p.onToggle(e.key)} aria-label={`Select ${e.label}`} data-testid="axa-tick" />
              <button className="axa-row-main" onClick={() => p.onFocus(e.key)} title={e.description}>
                <span className={`axa-dot ${e.status}`} title={STATUS_WORD[e.status]} />
                <span className="axa-row-label">{e.label}</span>
                {p.category === "all" && <span className="axa-row-cat">{CATALOGUE_CATEGORIES.find((k) => k.key === e.category)?.label}</span>}
                {e.verdict && e.verdict !== "untested" && <span className={`axa-verdict ${e.verdict}`}>{e.verdict.replace("_", " ")}</span>}
                {!!e.findings && <span className="axa-sig" title={`${e.findings} significant finding${e.findings === 1 ? "" : "s"}`}>★{e.findings}</span>}
              </button>
            </div>
          );
        })}
      </div>
    </div>
  );
}

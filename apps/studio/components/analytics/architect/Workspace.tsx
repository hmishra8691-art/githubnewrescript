"use client";
import React from "react";
import type { AnalysisCatalogue, CatalogueEntry, ChartSpec, ReportTheme } from "@rescript/analytics";
import type { Row, RunResult } from "../api";
import { Chart, ResultTableView } from "../charts/Chart";
import { ResultView } from "../ResultView";
import type { ResultsState } from "./useResults";
import type { Selection } from "@/lib/analyticsArchitect";
import { renderable } from "@/lib/analyticsArchitect";

/**
 * THE LIVE WORKSPACE — the Architect's centre pane.
 *
 *   COMBINED   every ticked entry that can be drawn, as a card: the chart, the first table, the engine's first
 *              insight — so a set of crosstabs reads as one page rather than one at a time
 *   FOCUS      one entry in full: the chart workbench, the tables, the tests and the insights (ResultView, the
 *              same one the builder uses); for a hypothesis, report, dashboard or theme — its detail
 *
 * Nothing is computed in the browser: every result comes from `useResults`.
 */
export type WorkspaceView = "combined" | "focus";

export function specFor(entry: CatalogueEntry, charts: Row[], result: RunResult | undefined): ChartSpec {
  if (entry.category === "charts") {
    const c = charts.find((x) => x.id === entry.id);
    if (c?.spec) return c.spec as ChartSpec;
  }
  const saved = charts.find((x) => x.analysis_id === entry.analysisId);
  if (saved?.spec) return saved.spec as ChartSpec;
  return { type: result?.recommendations[0]?.type ?? result?.recommendedCharts[0] ?? "bar_vertical", options: { title: entry.label } };
}

export function Workspace(p: {
  catalogue: AnalysisCatalogue | null; charts: Row[]; selection: Selection; view: WorkspaceView; onView: (v: WorkspaceView) => void;
  results: ResultsState; retry: (id: string) => void; themes: { id: string; name: string; theme: ReportTheme }[];
  onFocus: (key: string | null) => void; onOpenInBuilder: (analysisId: string) => void; canEdit: boolean;
  /** the Focus view's chart spec, kept by the shell so Properties can show it */
  spec: ChartSpec | null; onSpec: (s: ChartSpec) => void;
}) {
  const c = p.catalogue;
  const focused = c && p.selection.focus ? c.all.find((e) => e.key === p.selection.focus) ?? null : null;
  const cards = c ? renderable(c, p.selection) : [];
  const theme = (id: string | null | undefined) => p.themes.find((t) => t.id === id)?.theme ?? null;

  return (
    <div className="axa-work" data-testid="axa-workspace">
      {p.view === "combined" && (
        <div className="axa-combined" data-testid="axa-combined">
          {!cards.length && (
            <div className="axa-empty">
              <b>Nothing on the page yet.</b>
              <p className="muted">Tick analyses or charts in the Explorer to lay them out here together, or click one to open it in Focus. Hypotheses, reports and dashboards open in Focus only.</p>
            </div>
          )}
          {cards.map((e) => {
            const r = p.results.results[e.analysisId!];
            const st = p.results.status[e.analysisId!];
            return (
              <section key={e.key} className="axa-card" data-testid="axa-card" data-key={e.key}>
                <header className="axa-card-head">
                  <button className="axa-card-title" onClick={() => p.onFocus(e.key)} title="Open in Focus">{e.label}</button>
                  {e.hypotheses.length > 0 && <span className="axa-chip">{e.hypotheses.join(", ")}</span>}
                  <span className="grow" />
                  {r && <span className="muted" style={{ fontSize: 12 }}>n = {r.base.n.toLocaleString("en-US")}</span>}
                </header>
                {st === "loading" && !r && <div className="muted" style={{ padding: 20 }}>Computing…</div>}
                {st === "error" && <div className="ax-error" style={{ margin: 8 }}>{p.results.errors[e.analysisId!] ?? "Could not compute."} <button className="btn small" onClick={() => p.retry(e.analysisId!)}>Retry</button></div>}
                {r && (
                  <div className="axa-card-body">
                    <div className="axa-card-chart"><Chart result={r} spec={specFor(e, p.charts, r)} theme={theme(specFor(e, p.charts, r).themeId)} compact height={240} /></div>
                    <div className="axa-card-side">
                      <ResultTableView table={r.tables[0]} dense maxRows={8} />
                      {r.insights[0] && <p className="axa-insight">{r.insights[0]}</p>}
                      {r.warnings[0] && <p className="axa-warning">{r.warnings[0]}</p>}
                    </div>
                  </div>
                )}
              </section>
            );
          })}
        </div>
      )}
      {p.view === "focus" && (
        <div className="axa-focus" data-testid="axa-focus">
          {!focused && <div className="axa-empty"><b>Nothing in focus.</b><p className="muted">Click an entry in the Explorer to open it here.</p></div>}
          {focused && <FocusBody entry={focused} charts={p.charts} results={p.results} retry={p.retry} themes={p.themes} spec={p.spec} onSpec={p.onSpec} onOpenInBuilder={p.onOpenInBuilder} canEdit={p.canEdit} catalogue={c!} onFocus={p.onFocus} />}
        </div>
      )}
    </div>
  );
}

function FocusBody(p: { entry: CatalogueEntry; charts: Row[]; results: ResultsState; retry: (id: string) => void; themes: { id: string; name: string; theme: ReportTheme }[]; spec: ChartSpec | null; onSpec: (s: ChartSpec) => void; onOpenInBuilder: (id: string) => void; canEdit: boolean; catalogue: AnalysisCatalogue; onFocus: (key: string) => void }) {
  const e = p.entry;
  if (e.analysisId && (e.category === "crosstabs" || e.category === "tests" || e.category === "models" || e.category === "correlations" || e.category === "charts")) {
    const r = p.results.results[e.analysisId];
    const st = p.results.status[e.analysisId];
    if (!r) return st === "error"
      ? <div className="ax-error">{p.results.errors[e.analysisId] ?? "Could not compute."} <button className="btn small" onClick={() => p.retry(e.analysisId!)}>Retry</button></div>
      : <div className="muted" style={{ padding: 20 }}>Computing {e.label}…</div>;
    const spec = p.spec ?? specFor(e, p.charts, r);
    return (
      <div>
        <div className="axa-focus-head">
          <h2 className="axa-focus-title">{e.label}</h2>
          <span className="grow" />
          {p.canEdit && <button className="btn small" onClick={() => p.onOpenInBuilder(e.analysisId!)} data-testid="axa-open-builder" title="Edit the definition in the analysis builder">Edit in builder</button>}
        </div>
        <p className="muted axa-focus-descr">{e.description}</p>
        <ResultView result={r} recommendations={r.recommendations} advice={r.advice} spec={spec} onSpec={p.onSpec} theme={p.themes.find((t) => t.id === spec.themeId)?.theme ?? null} themes={p.themes} />
      </div>
    );
  }
  /* hypotheses, planned items without an analysis, themes, reports, dashboards: the detail */
  const related = e.category === "hypotheses" ? p.catalogue.all.filter((x) => x.category !== "hypotheses" && x.hypotheses.includes(e.id)) : [];
  return (
    <div className="axa-detail" data-testid="axa-detail">
      <div className="axa-focus-head"><h2 className="axa-focus-title">{e.label}</h2></div>
      {e.verdict && <div className={`axa-verdict big ${e.verdict}`} data-testid="axa-verdict">{e.verdict.replace("_", " ")}</div>}
      <p className="axa-focus-descr">{e.description}</p>
      {e.technical.missing?.length ? <p className="axa-warning">Cannot run: {e.technical.missing.join(", ")} {e.technical.missing.length === 1 ? "is" : "are"} not in the survey.</p> : null}
      {e.category === "hypotheses" && (
        <div className="axa-related">
          <div className="eyebrow">Tested by</div>
          {!related.length && <p className="muted">Nothing in the plan tests this hypothesis yet.</p>}
          {related.map((x) => <button key={x.key} className="axa-related-row" onClick={() => p.onFocus(x.key)}><span className={`axa-dot ${x.status}`} /> {x.label} <span className="muted">· {x.category}</span>{x.findings ? <span className="axa-sig">★{x.findings}</span> : null}</button>)}
        </div>
      )}
      {(e.category === "reports" || e.category === "dashboards") && <p className="muted">Open it from Deliver in Classic view to edit; Architect lists it here so it can be exported with the rest.</p>}
    </div>
  );
}

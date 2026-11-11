"use client";
import React from "react";
import type { AnalysisCatalogue, CatalogueEntry, ChartSpec, ReportTheme } from "@rescript/analytics";
import type { AxApi, Row, RunResult } from "../api";
import { InterpretationPanel } from "../InterpretationPanel";
import { Chart } from "../charts/Chart";
import { ResultView } from "../ResultView";
import { ProTable } from "../ProTable";
import { BaseCaption } from "../BaseCaption";
import { Warnings } from "../Warnings";
import type { ResultsState } from "./useResults";
import type { Selection } from "@/lib/analyticsArchitect";
import { isRenderable } from "@/lib/analyticsArchitect";

/**
 * THE LIVE WORKSPACE — the Architect's centre pane (M4).
 *
 *   FOCUS   one entry, four ways:
 *             Combined  the chart and the table together — a crosstab shows its TABLE, its CHART and its HEATMAP,
 *                       the three synchronized (one result, one spec), the pictures sticky beside a long table
 *             Table     every table of the result, with the formatting controls
 *             Chart     the visualization workbench (why this chart, the gallery, customize)
 *             Details   methodology, the tests with their statistics, the engine's insights, the configuration
 *           a hypothesis, report, dashboard or theme shows its detail and what it is tied to
 *   ALL     every ticked entry — or, with nothing ticked, every entry on show in the Explorer — one after another
 *           with section separators and a jump list; each section's result is computed when it scrolls into view
 *           (IntersectionObserver), so a project with hundreds of tables opens at once
 *
 * Nothing is computed in the browser: every result comes from `useResults`.
 */
export type WorkspaceView = "focus" | "all";
export type FocusView = "combined" | "table" | "chart" | "details";

export function specFor(entry: CatalogueEntry, charts: Row[], result: RunResult | undefined): ChartSpec {
  if (entry.category === "charts") {
    const c = charts.find((x) => x.id === entry.id);
    if (c?.spec) return c.spec as ChartSpec;
  }
  const saved = charts.find((x) => x.analysis_id === entry.analysisId);
  if (saved?.spec) return saved.spec as ChartSpec;
  return { type: result?.recommendations[0]?.type ?? result?.recommendedCharts[0] ?? "bar_vertical", options: { title: entry.label } };
}

const HEAT: Record<string, ChartSpec["type"]> = { crosstab: "heatmap_crosstab", correlation: "heatmap_correlation" };

export function Workspace(p: {
  api: AxApi; nonce: string;
  catalogue: AnalysisCatalogue | null; charts: Row[]; selection: Selection; view: WorkspaceView; focusView: FocusView;
  /** the entries the Explorer shows — the All view's page when nothing is ticked */
  shown: CatalogueEntry[];
  results: ResultsState; retry: (id: string) => void; themes: { id: string; name: string; theme: ReportTheme }[];
  onFocus: (key: string | null) => void; onOpenInBuilder: (analysisId: string) => void; canEdit: boolean;
  spec: ChartSpec | null; onSpec: (s: ChartSpec) => void;
  /** the All view tells the shell which analyses are on screen, so they are computed */
  onVisible: (analysisId: string, visible: boolean) => void;
  /** open a table large (the shell's dialog) */
  onExpandTable?: (analysisId: string, tableId?: string) => void;
}) {
  const c = p.catalogue;
  const focused = c && p.selection.focus ? c.all.find((e) => e.key === p.selection.focus) ?? null : null;
  const theme = (id: string | null | undefined) => p.themes.find((t) => t.id === id)?.theme ?? null;

  if (p.view === "all") {
    const ticked = new Set(p.selection.keys);
    const page = (ticked.size ? (c?.all ?? []).filter((e) => ticked.has(e.key)) : p.shown).filter((e) => e.category !== "charts" || !ticked.size);
    return (
      <div className="axa-work" data-testid="axa-all">
        {!page.length && <div className="axa-empty"><b>Nothing to show.</b><p className="muted">Tick entries in the Explorer, or open a category: everything in it is laid out here, one section after another.</p></div>}
        {page.length > 1 && (
          <nav className="axa-jump" aria-label="Sections" data-testid="axa-jump">
            {page.map((e, i) => <a key={e.key} href={`#axa-sec-${i}`} className="axa-jump-link" title={e.label}><span className={`axa-dot ${e.status}`} /> {e.label}</a>)}
          </nav>
        )}
        {page.map((e, i) => <AllSection key={e.key} index={i} entry={e} charts={p.charts} results={p.results} retry={p.retry} theme={theme} onFocus={p.onFocus} onVisible={p.onVisible} catalogue={c!} />)}
      </div>
    );
  }

  return (
    <div className="axa-work" data-testid="axa-focus">
      {!focused && <div className="axa-empty"><b>Nothing in focus.</b><p className="muted">Click an entry in the Explorer to open it here — its chart and table together, or one of them, or the details behind it.</p></div>}
      {focused && <FocusBody onExpandTable={p.onExpandTable} api={p.api} nonce={p.nonce} entry={focused} focusView={p.focusView} charts={p.charts} results={p.results} retry={p.retry} themes={p.themes} theme={theme} spec={p.spec} onSpec={p.onSpec} onOpenInBuilder={p.onOpenInBuilder} canEdit={p.canEdit} catalogue={c!} onFocus={p.onFocus} />}
    </div>
  );
}

/* ------------------------------------------------------------ the All view's sections */

function AllSection(p: { index: number; entry: CatalogueEntry; charts: Row[]; results: ResultsState; retry: (id: string) => void; theme: (id: string | null | undefined) => ReportTheme | null; onFocus: (key: string) => void; onVisible: (id: string, visible: boolean) => void; catalogue: AnalysisCatalogue }) {
  const e = p.entry;
  const ref = React.useRef<HTMLElement | null>(null);
  const id = e.analysisId;
  React.useEffect(() => {
    if (!id || !isRenderable(e) || typeof IntersectionObserver === "undefined") return;
    const el = ref.current; if (!el) return;
    const io = new IntersectionObserver((entries) => { for (const x of entries) p.onVisible(id, x.isIntersecting); }, { rootMargin: "400px 0px" });
    io.observe(el);
    return () => { io.disconnect(); p.onVisible(id, false); };
  }, [id]); // eslint-disable-line react-hooks/exhaustive-deps
  const r = id ? p.results.results[id] : undefined;
  const st = id ? p.results.status[id] : undefined;
  return (
    <section ref={ref} id={`axa-sec-${p.index}`} className="axa-section" data-testid="axa-section" data-key={e.key}>
      <header className="axa-section-head">
        <span className="axa-section-n">{p.index + 1}</span>
        <button className="axa-card-title" onClick={() => p.onFocus(e.key)} title="Open in Focus">{e.label}</button>
        {e.hypotheses.length > 0 && <span className="axa-chip">{e.hypotheses.join(", ")}</span>}
        {e.verdict && e.verdict !== "untested" && <span className={`axa-verdict ${e.verdict}`}>{e.verdict.replace("_", " ")}</span>}
        <span className="grow" />
        {r && <span className="muted" style={{ fontSize: 12 }}>n = {r.base.n.toLocaleString("en-US")}</span>}
        <button className="btn small ghost" onClick={() => p.onFocus(e.key)}>Focus</button>
      </header>
      <p className="axa-section-descr muted">{e.description}</p>
      {isRenderable(e) && id && (
        <>
          {!r && st !== "error" && <div className="axa-placeholder muted">{st === "loading" ? "Computing…" : "Scroll to compute"}</div>}
          {st === "error" && <div className="ax-error" style={{ margin: 8 }}>{p.results.errors[id] ?? "Could not compute."} <button className="btn small" onClick={() => p.retry(id)}>Retry</button></div>}
          {r && <Combined entry={e} result={r} spec={specFor(e, p.charts, r)} theme={p.theme} compact />}
        </>
      )}
      {e.category === "hypotheses" && <HypothesisDetail entry={e} catalogue={p.catalogue} onFocus={p.onFocus} />}
    </section>
  );
}

/* ------------------------------------------------------------ the Combined presentation */

/** the chart and the table together; a crosstab adds its heatmap — one result, synchronized */
function Combined(p: { entry: CatalogueEntry; result: RunResult; spec: ChartSpec; theme: (id: string | null | undefined) => ReportTheme | null; compact?: boolean; onSpec?: (s: ChartSpec) => void; onExpand?: (tableId?: string) => void }) {
  const r = p.result;
  /* a heatmap only where there is a matrix to colour: a crosstab, or a correlation of three or more variables (one pair has nothing to draw) */
  const heat = r.kind === "correlation" && (r.tables[0]?.rows.length ?? 0) < 2 ? undefined : HEAT[r.kind];
  const [picture, setPicture] = React.useState<"chart" | "heatmap">("chart");
  const shownSpec: ChartSpec = picture === "heatmap" && heat ? { ...p.spec, type: heat } : p.spec;
  const h = p.compact ? 240 : 340;
  return (
    <div className={`axa-combined ${p.compact ? "compact" : ""}`} data-testid="axa-combined-view">
      <div className="axa-combined-table">
        <ProTable table={r.tables[0]} formatting={{ dense: !!p.compact, heat: !p.compact && r.kind === "crosstab" }} maxHeight={p.compact ? 300 : 460} />
        {(p.onExpand || r.tables.length > 1) && (
          <div className="ax-tv-foot">
            {r.tables.length > 1 && <span className="muted">{r.tables.length - 1} more table{r.tables.length === 2 ? "" : "s"}{p.compact ? "" : " in the Table view"}</span>}
            <span className="grow" />
            {p.onExpand && r.tables.length > 0 && <button type="button" className="btn small" onClick={() => p.onExpand!(r.tables[0].id)} data-testid="axa-table-expand">Expand table ⤢</button>}
          </div>
        )}
      </div>
      <div className="axa-combined-side">
        {heat && (
          <div className="axa-seg small" role="tablist" aria-label="Picture">
            <button role="tab" aria-selected={picture === "chart"} className={`axa-seg-btn ${picture === "chart" ? "on" : ""}`} onClick={() => setPicture("chart")} data-testid="axa-pic-chart">Chart</button>
            <button role="tab" aria-selected={picture === "heatmap"} className={`axa-seg-btn ${picture === "heatmap" ? "on" : ""}`} onClick={() => setPicture("heatmap")} data-testid="axa-pic-heatmap">Heatmap</button>
          </div>
        )}
        <Chart result={r} spec={shownSpec} theme={p.theme(shownSpec.themeId)} compact={p.compact} height={h} />
        {!p.compact && heat && picture === "chart" && <div className="axa-combined-heat"><Chart result={r} spec={{ ...p.spec, type: heat, options: { ...p.spec.options, title: "Heatmap" } }} theme={p.theme(p.spec.themeId)} compact height={Math.max(160, h - 100)} /></div>}
        {r.insights[0] && <p className="axa-insight">{r.insights[0]}</p>}
        {r.warnings[0] && <p className="axa-warning">{r.warnings[0]}</p>}
      </div>
    </div>
  );
}

/* ------------------------------------------------------------ Focus */

function FocusBody(p: { onExpandTable?: (analysisId: string, tableId?: string) => void; api: AxApi; nonce: string; entry: CatalogueEntry; focusView: FocusView; charts: Row[]; results: ResultsState; retry: (id: string) => void; themes: { id: string; name: string; theme: ReportTheme }[]; theme: (id: string | null | undefined) => ReportTheme | null; spec: ChartSpec | null; onSpec: (s: ChartSpec) => void; onOpenInBuilder: (id: string) => void; canEdit: boolean; catalogue: AnalysisCatalogue; onFocus: (key: string) => void }) {
  const e = p.entry;
  if (e.analysisId && isRenderable(e)) {
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
          {p.canEdit && <button className="btn small" onClick={() => p.onOpenInBuilder(e.analysisId!)} data-testid="axa-open-builder" title="Open the full builder">Open in builder</button>}
        </div>
        <p className="muted axa-focus-descr">{e.description}</p>
        {p.focusView === "combined" && (
          <>
            <div className="row" style={{ gap: 6, alignItems: "baseline", flexWrap: "wrap", marginBottom: 6 }}><BaseCaption result={r} style={{ fontSize: 13 }} /></div>
            <Warnings items={r.warnings} />
            <Combined entry={e} result={r} spec={spec} theme={p.theme} onSpec={p.onSpec} onExpand={p.onExpandTable ? (tableId) => p.onExpandTable!(e.analysisId!, tableId) : undefined} />
          </>
        )}
        {p.focusView === "table" && <TablesOnly result={r} onExpand={p.onExpandTable ? (tableId) => p.onExpandTable!(e.analysisId!, tableId) : undefined} />}
        {p.focusView === "chart" && <ResultView result={r} recommendations={r.recommendations} advice={r.advice} spec={spec} onSpec={p.onSpec} theme={p.theme(spec.themeId)} themes={p.themes} view="chart" />}
        {p.focusView === "details" && <Details entry={e} result={r} api={p.api} nonce={p.nonce} />}
      </div>
    );
  }
  /* hypotheses, planned items without an analysis, themes, reports, dashboards: the detail */
  return (
    <div className="axa-detail" data-testid="axa-detail">
      <div className="axa-focus-head"><h2 className="axa-focus-title">{e.label}</h2></div>
      {e.verdict && <div className={`axa-verdict big ${e.verdict}`} data-testid="axa-verdict">{e.verdict.replace("_", " ")}</div>}
      <p className="axa-focus-descr">{e.description}</p>
      {e.technical.missing?.length ? <p className="axa-warning">Cannot run: {e.technical.missing.join(", ")} {e.technical.missing.length === 1 ? "is" : "are"} not in the survey.</p> : null}
      {e.category === "hypotheses" && <HypothesisDetail entry={e} catalogue={p.catalogue} onFocus={p.onFocus} />}
      {(e.category === "reports" || e.category === "dashboards") && <p className="muted">Open it from Present to edit; Architect lists it here so it can be exported with the rest.</p>}
    </div>
  );
}

function TablesOnly({ result: r, onExpand }: { result: RunResult; onExpand?: (tableId: string) => void }) {
  const [f, setF] = React.useState<{ heat?: boolean; showCounts?: boolean; dense?: boolean; decimals?: number }>({ heat: r.kind === "crosstab" });
  return (
    <div className="axa-tables" data-testid="axa-tables">
      <div className="ax-fmt" style={{ marginBottom: 8 }}>
        <label className="ax-toggle"><input type="checkbox" checked={!!f.heat} onChange={(e) => setF({ ...f, heat: e.target.checked })} /> Heat</label>
        <label className="ax-toggle"><input type="checkbox" checked={!!f.showCounts} onChange={(e) => setF({ ...f, showCounts: e.target.checked })} /> Counts</label>
        <label className="ax-toggle"><input type="checkbox" checked={!!f.dense} onChange={(e) => setF({ ...f, dense: e.target.checked })} /> Dense</label>
        <label className="ax-toggle">Dec. <input className="input small" type="number" min={0} max={4} style={{ width: 52 }} value={f.decimals ?? ""} placeholder="1" onChange={(e) => setF({ ...f, decimals: e.target.value === "" ? undefined : Number(e.target.value) })} /></label>
      </div>
      {r.tables.map((t) => <div key={t.id} className="card ax-table-card"><div className="card-title">{t.title}<span className="grow" />{onExpand && <button type="button" className="btn small" onClick={() => onExpand(t.id)}>Expand ⤢</button>}</div><ProTable table={t} formatting={f} maxHeight={520} /></div>)}
      {!r.tables.length && <div className="muted">This analysis produced no table.</div>}
    </div>
  );
}

/** methodology, the tests, the engine's insights, the configuration and provenance */
function Details({ entry: e, result: r, api, nonce }: { entry: CatalogueEntry; result: RunResult; api: AxApi; nonce: string }) {
  return (
    <div className="axa-details" data-testid="axa-details">
      <section className="card">
        <div className="card-title">Interpretation</div>
        <InterpretationPanel api={api} analysisId={e.analysisId} nonce={nonce} statsOpen />
      </section>
      <section className="card">
        <div className="card-title">Methodology</div>
        <p style={{ margin: "4px 0" }}>{e.description}</p>
        <dl className="axa-dl">
          <dt>Kind</dt><dd>{e.technical.kind}</dd>
          {e.technical.method && <><dt>Method</dt><dd>{e.technical.method}</dd></>}
          <dt>Base</dt><dd><BaseCaption result={r} style={{ fontSize: 13 }} /></dd>
          {r.provenance && <><dt>Computed</dt><dd>{new Date(r.computedAt).toLocaleString()}{"durationMs" in r.provenance && typeof (r.provenance as { durationMs?: number }).durationMs === "number" ? ` · ${(r.provenance as { durationMs: number }).durationMs} ms` : ""}</dd></>}
          {e.technical.variables.length > 0 && <><dt>Variables</dt><dd>{e.technical.variables.map((v) => `${v.researchLabel}${v.code ? ` (${v.code})` : ""}`).join(", ")}</dd></>}
        </dl>
      </section>
      <section className="card">
        <div className="card-title">Statistical tests</div>
        {r.tests.length ? (
          <table className="ax-table"><thead><tr><th>Test</th><th className="num">Statistic</th><th>df</th><th>p-value</th><th>Effect size</th><th>Note</th></tr></thead>
            <tbody>{r.tests.map((t, i) => <tr key={i}><td>{t.test.replace(/_/g, " ")}</td><td className="num">{t.statistic == null ? "—" : t.statistic.toFixed(3)}</td><td>{Array.isArray(t.df) ? t.df.map((d) => Math.round(d * 10) / 10).join(", ") : t.df == null ? "" : Math.round(t.df * 10) / 10}</td><td className={t.p != null && t.p < 0.05 ? "ax-sig-p" : ""}>{t.p == null ? "—" : t.p < 0.001 ? "< .001" : t.p.toFixed(3)}</td><td>{t.effectSize ? `${t.effectSize.name} = ${t.effectSize.value?.toFixed(3) ?? "—"}` : ""}</td><td className="muted">{t.note ?? ""}</td></tr>)}</tbody></table>
        ) : <div className="muted">No statistical test is attached to this analysis.</div>}
      </section>
      <section className="card">
        <div className="card-title">What the engine reads in it</div>
        {r.insights.length ? <ul className="ax-insights">{r.insights.map((s, i) => <li key={i}>{s}</li>)}</ul> : <div className="muted">No insight was generated.</div>}
        {r.warnings.length > 0 && <ul className="ax-insights" style={{ color: "var(--c-warning-fg)" }}>{r.warnings.map((s, i) => <li key={i}>{s}</li>)}</ul>}
        <div className="muted" style={{ fontSize: 12.5, marginTop: 6 }}>Every statement is computed from the tables of this analysis (n = {r.base.n.toLocaleString("en-US")}). Interpretation in plain language is in the Properties panel.</div>
      </section>
    </div>
  );
}

/**
 * THE HYPOTHESIS, DRIVEN BY ITS EVIDENCE (M5): supported / partially supported (mixed) / not supported /
 * inconclusive / not testable — and why: the analyses that test it, the findings the verdict rests on with their
 * evidence lines, the variables that are missing when it cannot be tested. Never a manufactured verdict: an
 * untested hypothesis says what it is waiting for.
 */
function HypothesisDetail({ entry: e, catalogue, onFocus }: { entry: CatalogueEntry; catalogue: AnalysisCatalogue; onFocus: (key: string) => void }) {
  const related = catalogue.all.filter((x) => x.category !== "hypotheses" && x.hypotheses.includes(e.id));
  const blocked = related.filter((x) => x.technical.missing?.length);
  const word = e.verdict === "supported" ? "Supported" : e.verdict === "not_supported" ? "Not supported" : e.verdict === "mixed" ? "Partially supported" : e.verdict === "inconclusive" ? "Inconclusive" : e.untestable ? "Not testable with the available data" : related.length ? "Not yet tested — the plan has not been run" : "Not testable yet";
  return (
    <div className="axa-hyp" data-testid="axa-hypothesis" data-verdict={e.verdict ?? "untested"}>
      <div className="axa-hyp-verdict"><span className={`axa-verdict big ${e.verdict ?? "untested"}`}>{word}</span></div>
      {e.untestable && <p className="axa-warning" data-testid="axa-hyp-untestable">{e.untestable}{e.untestable.includes("no question") ? " Add a question that measures it (Research design → constructs), and the plan can test it." : e.untestable.includes("No construct") ? " Name the constructs on each side of the hypothesis in the research design." : " Add a crosstab or a test for it in the analysis plan, or let the engine propose the plan."}</p>}
      {blocked.length > 0 && <p className="axa-warning">{blocked.length === 1 ? "One planned analysis" : `${blocked.length} planned analyses`} cannot run: {[...new Set(blocked.flatMap((x) => x.technical.missing ?? []))].join(", ")} {blocked.flatMap((x) => x.technical.missing ?? []).length === 1 ? "is" : "are"} not in the survey.</p>}
      {e.evidence && e.evidence.length > 0 && (
        <div className="axa-related">
          <div className="eyebrow">Evidence</div>
          {e.evidence.map((f) => {
            const target = catalogue.all.find((x) => (f.analysisId && x.analysisId === f.analysisId && x.category !== "charts") || (!f.analysisId && f.planned && x.planned === f.planned));
            return (
              <button key={f.id} className="axa-related-row" onClick={() => target && onFocus(target.key)} disabled={!target} data-testid="axa-hyp-evidence" data-holds={f.holds}>
                <span className={`axa-dot ${f.holds ? "ready" : "planned"}`} title={f.holds ? "holds after correction" : "does not hold"} />
                <span style={{ flex: "1 1 auto", minWidth: 0 }}>{f.headline}<div className="mono muted" style={{ fontSize: 11 }}>{f.evidence}</div></span>
              </button>
            );
          })}
        </div>
      )}
      <div className="axa-related">
        <div className="eyebrow">Tested by</div>
        {!related.length && <p className="muted">Nothing in the plan tests this hypothesis yet.</p>}
        {related.map((x) => <button key={x.key} className="axa-related-row" onClick={() => onFocus(x.key)}><span className={`axa-dot ${x.status}`} /> {x.label} <span className="muted">· {x.category}</span>{x.findings ? <span className="axa-sig">★{x.findings}</span> : null}</button>)}
      </div>
    </div>
  );
}


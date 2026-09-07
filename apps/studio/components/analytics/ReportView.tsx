"use client";
import React from "react";
import type { AnalysisResult, ChartSpec, DashboardWidget, ReportBlock, ReportTheme } from "@rescript/analytics";
import { DEFAULT_THEME, executiveSummary, methodologyLines, reportPages } from "@rescript/analytics";
import { Chart, ResultTableView } from "./charts/Chart";

/**
 * READ-ONLY REPORT / DASHBOARD RENDERER (§12, §16, §19, §20). Draws a report's
 * blocks or a dashboard's widgets from a bag of results. It has no notion of
 * editing: the builder wraps it with controls, the share page shows it bare.
 * Interaction is confined to what a viewer is allowed — segment switching and
 * cross-filter highlighting — and never writes anywhere.
 */

export interface ReportViewProps {
  title: string;
  subtitle?: string;
  blocks?: ReportBlock[];
  widgets?: DashboardWidget[];
  crossFilter?: boolean;
  results: Record<string, AnalysisResult>;
  theme?: ReportTheme | null;
  mode: "live" | "snapshot";
  version?: number | null;
  publishedAt?: string | null;
  branding?: { showLogo?: boolean; footer?: string; header?: string };
  viewerSegments?: string[];
  /**
   * §36 — filters a viewer may apply, each with its own pre-computed results.
   *
   * Frozen at publish time (`analytics_report_versions.variants`), so
   * switching filter swaps one bag of results for another rather than
   * recomputing: a shared report still has no dataset access, and a public
   * page still cannot compose a condition.
   */
  viewerFilters?: { id: string; name: string }[];
  filterResults?: Record<string, Record<string, AnalysisResult>> | null;
  toolbar?: React.ReactNode;
  onBlockAction?: (blockId: string, action: "up" | "down" | "remove" | "edit") => void;
  /**
   * Draw page boundaries (§36). On in the viewer and on the share page, so
   * what is on screen is what prints; off in the builder's own preview would
   * only hide the decision the author is making.
   */
  showPages?: boolean;
}

function mdToHtml(md: string): string {
  return md.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/^### (.*)$/gm, "<h4>$1</h4>").replace(/^## (.*)$/gm, "<h3>$1</h3>").replace(/^# (.*)$/gm, "<h2>$1</h2>").replace(/\*\*(.+?)\*\*/g, "<b>$1</b>").replace(/\*(.+?)\*/g, "<i>$1</i>").replace(/^- (.*)$/gm, "<li>$1</li>").replace(/(<li>.*<\/li>\n?)+/g, (m) => `<ul>${m}</ul>`).replace(/\n{2,}/g, "<br/><br/>");
}

export function ReportView(p: ReportViewProps) {
  const theme = p.theme ?? DEFAULT_THEME;
  const [selected, setSelected] = React.useState<string | null>(null);
  const [segIdx, setSegIdx] = React.useState<Record<string, number | null>>({});
  /*
   * §36 — which allowed filter the viewer has picked. "" is the base report,
   * and it is the default: a shared report must open on the numbers its
   * author published, not on whichever filter happens to be first.
   */
  const [viewerFilter, setViewerFilter] = React.useState<string>("");
  const filtered = viewerFilter ? p.filterResults?.[viewerFilter] : undefined;
  const results = filtered ?? p.results;
  const usedIds = new Set<string>();
  for (const b of p.blocks ?? []) { if ("analysisId" in b && b.analysisId) usedIds.add(b.analysisId); if ("analysisIds" in b) b.analysisIds.forEach((id) => usedIds.add(id)); }
  for (const w of p.widgets ?? []) if (w.analysisId) usedIds.add(w.analysisId);
  const segmentsAvailable = [...usedIds].map((id) => results[id]).filter(Boolean).flatMap((r) => r.segments ?? []).map((s) => s.name);
  const [globalSeg, setGlobalSeg] = React.useState<string>("");
  const segFor = (id: string): number | undefined => { const r = results[id]; if (!r?.segments) return undefined; const local = segIdx[id]; if (local != null) return local; if (globalSeg) { const i = r.segments.findIndex((s) => s.name === globalSeg); return i >= 0 ? i : undefined; } return undefined; };
  const font = theme.fontFamily;
  const style: React.CSSProperties = { fontFamily: font, color: theme.colors.text, background: theme.colors.background };
  const Actions = ({ id }: { id: string }) => p.onBlockAction ? <span className="ax-block-actions"><button onClick={() => p.onBlockAction!(id, "up")} title="Move up">↑</button><button onClick={() => p.onBlockAction!(id, "down")} title="Move down">↓</button><button onClick={() => p.onBlockAction!(id, "edit")} title="Edit">✎</button><button onClick={() => p.onBlockAction!(id, "remove")} title="Remove">×</button></span> : null;
  const Missing = ({ id }: { id: string }) => !id
    ? <div className="ax-missing" data-testid="ax-unfilled">Waiting for an analysis. Open this block and pick one.</div>
    : <div className="ax-missing">Analysis {id.slice(0, 8)}… is not available{p.mode === "snapshot" ? " in this published version" : " (deleted or not yet computed)"}.</div>;

  const renderChart = (id: string, spec: ChartSpec, height?: number) => {
    /*
     * An unfilled placeholder from a template has no analysis yet, which is a
     * normal state for a report being built rather than an error — say so,
     * instead of reporting a missing analysis nobody chose.
     */
    if (!id) return <div className="ax-missing" data-testid="ax-unfilled">Waiting for an analysis. Open this block and pick one.</div>;
    const r = results[id]; if (!r) return <Missing id={id} />;
    const si = segFor(id);
    const sp = si != null ? { ...spec, options: { ...spec.options, segmentIndex: si } } : spec;
    return <Chart result={r} spec={sp} theme={theme} height={height} onSelect={p.crossFilter ? setSelected : undefined} selected={p.crossFilter ? selected : undefined} />;
  };

  /*
   * One block, rendered. Hoisted out of the JSX so the same function serves
   * the flat list and the page-wrapped list (§36) — two copies of a switch
   * this size is how a block type ends up rendering differently depending on
   * whether pages are on.
   */
  const renderBlock = (b: ReportBlock) => {
        switch (b.type) {
          case "cover": return <section key={b.id} className="ax-block ax-cover" style={{ background: theme.cover?.background ?? theme.colors.primary, color: theme.cover?.textColor ?? "#fff", textAlign: theme.cover?.layout === "center" ? "center" : "left" }}><Actions id={b.id} />{theme.logoUrl && p.branding?.showLogo !== false && <img src={theme.logoUrl} alt="" className="ax-logo" />}<h1 style={{ fontFamily: theme.headingFontFamily ?? font }}>{b.title || p.title}</h1>{(b.subtitle ?? p.subtitle) && <p>{b.subtitle ?? p.subtitle}</p>}<div className="ax-cover-meta">{b.date ?? (p.publishedAt ? new Date(p.publishedAt).toLocaleDateString() : new Date().toLocaleDateString())}{b.author ? ` · ${b.author}` : ""}</div></section>;
          case "section": return <section key={b.id} className="ax-block ax-section" style={{ borderColor: theme.colors.primary }}><Actions id={b.id} /><h2 style={{ color: theme.colors.primary, fontFamily: theme.headingFontFamily ?? font }}>{b.title}</h2>{b.subtitle && <p className="muted">{b.subtitle}</p>}</section>;
          case "text": return <section key={b.id} className="ax-block ax-text"><Actions id={b.id} />{b.title && <h3>{b.title}</h3>}<div dangerouslySetInnerHTML={{ __html: mdToHtml(b.markdown) }} /></section>;
          case "chart": return <section key={b.id} className="ax-block"><Actions id={b.id} />{b.title && <h3>{b.title}</h3>}{renderChart(b.analysisId, b.chart)}{results[b.analysisId]?.segments?.length ? <div className="row" style={{ marginTop: 4 }}><select className="select small" value={segIdx[b.analysisId] ?? ""} onChange={(e) => setSegIdx({ ...segIdx, [b.analysisId]: e.target.value === "" ? null : Number(e.target.value) })}><option value="">Segment: follow report</option>{results[b.analysisId].segments!.map((s, i) => <option key={i} value={i}>{s.name} (n = {s.n})</option>)}</select></div> : null}{b.caption && <p className="ax-caption">{b.caption}</p>}</section>;
          case "table": { const r = results[b.analysisId]; const t = r ? (b.tableId ? r.tables.find((x) => x.id === b.tableId) ?? r.tables[0] : r.tables[0]) : undefined; return <section key={b.id} className="ax-block"><Actions id={b.id} /><h3>{b.title ?? t?.title ?? "Table"}</h3>{r ? <ResultTableView table={t} /> : <Missing id={b.analysisId} />}{b.caption && <p className="ax-caption">{b.caption}</p>}</section>; }
          case "kpi": { const r = results[b.analysisId]; return <section key={b.id} className="ax-block"><Actions id={b.id} />{b.title && <h3>{b.title}</h3>}{r ? <Chart result={r} spec={{ type: r.chart.kpis && r.chart.kpis.length === 1 ? "gauge" : "kpi_card", options: { showBase: true } }} theme={theme} height={160} /> : <Missing id={b.analysisId} />}</section>; }
          case "insights": return <section key={b.id} className="ax-block"><Actions id={b.id} /><h3>{b.title ?? "Key insights"}</h3><ul className="ax-insights">{(b.analysisIds ?? []).flatMap((id) => (results[id]?.insights ?? []).map((s, i) => <li key={`${id}-${i}`}>{s}</li>))}</ul></section>;
          case "executive_summary": { const items = executiveSummary((b.analysisIds ?? []).map((id) => ({ name: results[id]?.name ?? id, result: results[id] })).filter((x) => x.result)); return <section key={b.id} className="ax-block ax-exec"><Actions id={b.id} /><h3>{b.title ?? "Executive summary"}</h3>{b.text && <p>{b.text}</p>}{items.map((it) => <div key={it.analysis} className="ax-exec-item"><strong>{it.analysis}</strong> — {it.headline} <span className="muted">({it.base})</span></div>)}{!items.length && <p className="muted">Add analyses to this summary.</p>}</section>; }
          /*
           * §36 — a page break is a boundary, not a thing on the page. It
           * draws a marker in the builder, where the author needs to see the
           * decision they made, and nothing at all once pages are drawn.
           */
          case "page_break":
            return p.onBlockAction
              ? <section key={b.id} className="ax-block ax-pagebreak" data-testid="ax-pagebreak"><Actions id={b.id} /><span style={{ color: theme.colors.subtle }}>— page break —</span></section>
              : null;
          /*
           * §36 — the methodology, as the team wrote it. `methodologyLines`
           * is the same function both exports use, so the slide, the sheet
           * and the page cannot disagree about what this study's method was.
           */
          case "methodology": {
            const lines = methodologyLines(b);
            return (
              <section key={b.id} className="ax-block ax-methodology" data-testid="ax-methodology">
                <Actions id={b.id} />
                <h3>{b.title ?? "Methodology"}</h3>
                <ul className="ax-insights">{lines.map((l, i) => <li key={i}>{l}</li>)}</ul>
              </section>
            );
          }
          default: return null;
        }
  };

  return (
    <div className="ax-report" style={style} data-testid="ax-report" data-mode={p.mode}>
      <div className="ax-report-bar">
        <span className={`ax-mode ${p.mode}`} title={p.mode === "snapshot" ? "Frozen at publish time — the numbers do not change until the owner republishes." : "Recomputed from current response data every time it is opened."}>{p.mode === "snapshot" ? `Snapshot${p.version ? ` · v${p.version}` : ""}${p.publishedAt ? ` · published ${new Date(p.publishedAt).toLocaleDateString()}` : ""}` : "Live data"}</span>
        {(p.viewerSegments?.length || segmentsAvailable.length) ? <select className="select small" value={globalSeg} onChange={(e) => { setGlobalSeg(e.target.value); setSegIdx({}); }} data-testid="ax-viewer-segment"><option value="">All respondents</option>{[...new Set(segmentsAvailable)].filter((s) => !p.viewerSegments?.length || p.viewerSegments.includes(s)).map((s) => <option key={s} value={s}>{s}</option>)}</select> : null}
        {p.viewerFilters?.length && p.filterResults ? (
          <select className="select small" value={viewerFilter} data-testid="ax-viewer-filter"
            onChange={(e) => { setViewerFilter(e.target.value); setSegIdx({}); }}
            title="Each of these was computed when the report was published">
            <option value="">Whole sample</option>
            {p.viewerFilters.filter((f) => p.filterResults?.[f.id]).map((f) => <option key={f.id} value={f.id}>{f.name}</option>)}
          </select>
        ) : null}
        {viewerFilter && (
          <span className="chip" data-testid="ax-viewer-filter-on">
            Filtered: {p.viewerFilters?.find((f) => f.id === viewerFilter)?.name}
          </span>
        )}
        {p.crossFilter && selected && <button className="btn small" onClick={() => setSelected(null)}>Clear highlight: {selected}</button>}
        <span className="grow" />
        {p.toolbar}
      </div>
      {p.branding?.header && <div className="ax-report-header" style={{ color: theme.colors.subtle }}>{p.branding.header}</div>}
      {p.showPages && p.blocks?.length ? (
        /*
         * §36 — the same blocks, wrapped one page at a time. The pages are
         * derived from `page_break` markers by the engine's own
         * `reportPages`, so the screen, the print stylesheet and any future
         * PDF all agree about where a page ends — rather than each deciding
         * for itself, which is how a report that looks right in the browser
         * prints with a chart split across two leaves.
         */
        reportPages(p.blocks).map((page) => (
          <div key={page.number} className="ax-page" data-testid="ax-page" data-page={page.number}>
            {page.blocks.map(renderBlock)}
            <div className="ax-page-foot" style={{ color: theme.colors.subtle }}>
              {page.section ? <span>{page.section}</span> : <span />}
              <span>{page.number}</span>
            </div>
          </div>
        ))
      ) : p.blocks?.map(renderBlock)}
      {p.widgets && (
        <div className="ax-dashboard" data-testid="ax-dashboard">
          {p.widgets.map((w) => {
            const r = w.analysisId ? results[w.analysisId] : undefined;
            const style: React.CSSProperties = { gridColumn: `span ${Math.min(12, Math.max(2, w.w))}`, minHeight: w.h * 60 };
            return <div key={w.id} className="ax-widget" style={style}>
              <Actions id={w.id} />
              {w.title && <div className="ax-widget-title">{w.title}</div>}
              {w.type === "text" && <div dangerouslySetInnerHTML={{ __html: mdToHtml(w.text ?? "") }} />}
              {w.type === "kpi" && (r ? <Chart result={r} spec={{ type: r.chart.kpis && r.chart.kpis.length === 1 ? "gauge" : "kpi_card", options: { showBase: false } }} theme={theme} height={Math.max(120, w.h * 60 - 30)} /> : w.analysisId ? <Missing id={w.analysisId} /> : null)}
              {w.type === "chart" && w.analysisId && (r ? renderChart(w.analysisId, w.chart ?? { type: r.recommendedCharts[0] ?? "bar_vertical", options: {} }, Math.max(160, w.h * 60 - 30)) : <Missing id={w.analysisId} />)}
              {w.type === "table" && w.analysisId && (r ? <ResultTableView table={r.tables[0]} dense maxRows={Math.max(4, w.h * 2)} /> : <Missing id={w.analysisId} />)}
              {w.type === "filter" && <div className="muted" style={{ fontSize: 13 }}>Segment switch: use the selector in the bar above.</div>}
            </div>;
          })}
        </div>
      )}
      {p.branding?.footer && <div className="ax-report-footer" style={{ color: theme.colors.subtle }}>{p.branding.footer}</div>}
      {theme.footer && !p.branding?.footer && <div className="ax-report-footer" style={{ color: theme.colors.subtle }}>{theme.footer}</div>}
    </div>
  );
}

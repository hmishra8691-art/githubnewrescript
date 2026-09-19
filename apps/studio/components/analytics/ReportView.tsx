"use client";
import React from "react";
import type { AnalysisResult, ChartSpec, DashboardBand, DashboardHero, DashboardWidget, ReportBlock, ReportTheme } from "@rescript/analytics";
import {
  DEFAULT_THEME, executiveSummary, methodologyLines, reportPages, seriesForChart,
  DASHBOARD_COLUMNS, DASHBOARD_GAP_PX, DASHBOARD_ROW_PX, clampBox, heroRows, layoutRows, normalizeBands,
  normalizeLayout, overlayTextColor, scrimFor, sortByPosition, themeSurfaces,
  type LayoutBox,
} from "@rescript/analytics";
import { Chart, ResultTableView } from "./charts/Chart";
import { Icon, IconPictogram } from "./charts/Icons";

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
  /** §41 — the banner above the canvas, and the backgrounds behind rows of it */
  hero?: DashboardHero;
  bands?: DashboardBand[];
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
   * §40 — a widget was moved or resized on the dashboard canvas.
   *
   * Its presence is what makes the canvas editable at all: the share page
   * passes nothing, so the same component draws the same layout with no
   * grips, no handles and no pointer listeners.
   */
  onLayout?: (widgetId: string, box: LayoutBox) => void;
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

/**
 * A CSS `url()` that survives whatever the author pasted. An unquoted url()
 * breaks on a data: URI, on a space, and on a parenthesis in a filename, and
 * it fails by drawing nothing — no error, just a widget with no picture.
 */
const cssUrl = (u: string) => 'url("' + u.replace(/["\\]/g, "\\$&") + '")';

/** "+2%" → up, "-2%" → down, "0%" or unsigned → flat — the colour convention the photo tile's trend chip follows. */
function trendTone(s: string): "up" | "down" | "flat" {
  const t = s.trim();
  if (t.startsWith("+") || (t.startsWith("↑"))) return "up";
  if (t.startsWith("-") || t.startsWith("−") || t.startsWith("↓")) return "down";
  return "flat";
}
const fmtV = (v: number | null | undefined, pct?: boolean) => (v == null || !Number.isFinite(v) ? "—" : `${Math.round(v).toLocaleString("en-US")}${pct ? "%" : ""}`);

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

  /*
   * §40 — THE DASHBOARD CANVAS.
   *
   * `normalizeLayout` runs on the way in, every time, for both the builder and
   * the share page: it is what gives a dashboard saved before this feature a
   * real arrangement (all its widgets sit at 0,0) and what guarantees nothing
   * is hidden underneath anything else. It is idempotent, so a dashboard that
   * has been positioned is handed back untouched.
   *
   * Rendering goes in reading order rather than array order, so the DOM order
   * is what the eye sees — which is what the phone layout stacks and what a
   * screen reader announces.
   */
  const laidOut = React.useMemo(() => normalizeLayout(p.widgets ?? []), [p.widgets]);
  const bands = React.useMemo(() => normalizeBands(p.bands), [p.bands]);
  const gridRef = React.useRef<HTMLDivElement | null>(null);
  const [drag, setDrag] = React.useState<{ id: string; mode: "move" | "resize"; origin: LayoutBox; box: LayoutBox; startX: number; startY: number; colStep: number; rowStep: number } | null>(null);

  const beginDrag = (e: React.PointerEvent, w: DashboardWidget, mode: "move" | "resize") => {
    const grid = gridRef.current;
    if (!p.onLayout || !grid) return;
    e.preventDefault();
    e.stopPropagation();
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    const cs = getComputedStyle(grid);
    const contentW = grid.clientWidth - parseFloat(cs.paddingLeft || "0") - parseFloat(cs.paddingRight || "0");
    const origin = { x: w.x, y: w.y, w: w.w, h: w.h };
    setDrag({
      id: w.id, mode, origin, box: origin,
      startX: e.clientX, startY: e.clientY,
      // one column costs its own width plus the gap that follows it
      colStep: Math.max(1, (contentW + DASHBOARD_GAP_PX) / DASHBOARD_COLUMNS),
      rowStep: DASHBOARD_ROW_PX + DASHBOARD_GAP_PX,
    });
  };

  const onDragMove = (e: React.PointerEvent) => {
    if (!drag) return;
    const dx = Math.round((e.clientX - drag.startX) / drag.colStep);
    const dy = Math.round((e.clientY - drag.startY) / drag.rowStep);
    const box = drag.mode === "move"
      ? clampBox({ ...drag.origin, x: drag.origin.x + dx, y: drag.origin.y + dy })
      : clampBox({ ...drag.origin, w: drag.origin.w + dx, h: drag.origin.h + dy });
    if (box.x !== drag.box.x || box.y !== drag.box.y || box.w !== drag.box.w || box.h !== drag.box.h) setDrag({ ...drag, box });
  };

  const endDrag = () => {
    if (!drag) return;
    const { id, box, origin } = drag;
    setDrag(null);
    // a click that moved nothing is not an edit, and must not mark the report dirty
    if (box.x !== origin.x || box.y !== origin.y || box.w !== origin.w || box.h !== origin.h) p.onLayout?.(id, box);
  };

  /* Arrows move a focused widget a cell at a time: a canvas that can only be
   * driven by dragging cannot be driven from a keyboard at all. */
  const onGripKey = (e: React.KeyboardEvent, w: DashboardWidget) => {
    if (!p.onLayout) return;
    const step: Record<string, [number, number]> = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] };
    const d = step[e.key];
    if (!d) return;
    e.preventDefault();
    const box = clampBox({ x: w.x + d[0], y: w.y + d[1], w: e.shiftKey ? w.w + d[0] : w.w, h: e.shiftKey ? w.h + d[1] : w.h });
    p.onLayout(w.id, e.shiftKey ? { ...box, x: w.x, y: w.y } : box);
  };
  const segFor = (id: string): number | undefined => { const r = results[id]; if (!r?.segments) return undefined; const local = segIdx[id]; if (local != null) return local; if (globalSeg) { const i = r.segments.findIndex((s) => s.name === globalSeg); return i >= 0 ? i : undefined; } return undefined; };
  const font = theme.fontFamily;
  /*
   * §42 — the theme's surfaces, published as CSS variables so the stylesheet
   * follows the theme instead of only the inline styles doing so. Without
   * this a dark theme produced a dark page carrying white widget cards: the
   * page colour came from the theme, every card from the stylesheet.
   */
  const surfaces = themeSurfaces(theme);
  const style: React.CSSProperties = {
    fontFamily: font, color: surfaces.text, background: surfaces.background,
    ["--ax-surface" as string]: surfaces.surface,
    ["--ax-border" as string]: surfaces.border,
    ["--ax-text" as string]: surfaces.text,
    ["--ax-subtle" as string]: surfaces.subtle,
  };
  const Actions = ({ id }: { id: string }) => p.onBlockAction ? <span className="ax-block-actions"><button onClick={() => p.onBlockAction!(id, "up")} title="Move up">↑</button><button onClick={() => p.onBlockAction!(id, "down")} title="Move down">↓</button><button onClick={() => p.onBlockAction!(id, "edit")} title="Edit">✎</button><button onClick={() => p.onBlockAction!(id, "remove")} title="Remove">×</button></span> : null;
  const Missing = ({ id, hint }: { id: string; hint?: string }) => !id
    ? <div className="ax-missing" data-testid="ax-unfilled">{hint ? `${hint} — open this widget and pick the analysis.` : "Waiting for an analysis. Open this block and pick one."}</div>
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
          /*
           * §37 — a panel grid: a headline sentence, then several analyses
           * side by side. Each panel is drawn exactly the way a lone chart
           * or table block is (same `renderChart`, same `Missing`), so a
           * funnel next to its sources, or eight small trend lines in a row,
           * behave on screen exactly as the export draws them.
           */
          case "panel_grid": {
            const nPanels = b.panels.length || 1;
            const cols = b.columns ?? (nPanels <= 2 ? nPanels : nPanels === 3 ? 3 : nPanels <= 4 ? 2 : 4);
            return (
              <section key={b.id} className="ax-block ax-panelgrid" data-testid="ax-panelgrid">
                <Actions id={b.id} />
                {b.title && <h3>{b.title}</h3>}
                {b.headline && <p className="ax-panelgrid-headline">{b.headline}</p>}
                <div className="ax-panelgrid-grid" style={{ gridTemplateColumns: `repeat(${Math.max(1, Math.min(cols, nPanels))}, minmax(0, 1fr))` }}>
                  {b.panels.map((panel) => {
                    const r = panel.analysisId ? results[panel.analysisId] : undefined;
                    const table = r ? (panel.tableId ? r.tables.find((t) => t.id === panel.tableId) ?? r.tables[0] : r.tables[0]) : undefined;
                    return (
                      <div key={panel.id} className="ax-panel" data-testid="ax-panel">
                        {panel.title && <div className="ax-panel-title">{panel.title}</div>}
                        {!r ? <Missing id={panel.analysisId} /> : panel.chart ? renderChart(panel.analysisId, panel.chart, 180) : <ResultTableView table={table} dense maxRows={8} />}
                        {panel.caption ? <p className="ax-caption">{panel.caption}</p> : r ? <p className="ax-caption muted">n = {r.base.n}</p> : null}
                      </div>
                    );
                  })}
                  {!b.panels.length && <div className="muted" style={{ padding: 8 }}>No panels yet. Open this block and add one.</div>}
                </div>
              </section>
            );
          }
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
    <div className="ax-report" style={style} data-testid="ax-report" data-mode={p.mode} data-dark={surfaces.dark ? "1" : undefined}>
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
          <div key={page.number} className="ax-report-page" data-testid="ax-page" data-page={page.number}>
            {page.blocks.map(renderBlock)}
            <div className="ax-page-foot" style={{ color: theme.colors.subtle }}>
              {page.section ? <span>{page.section}</span> : <span />}
              <span>{page.number}</span>
            </div>
          </div>
        ))
      ) : p.blocks?.map(renderBlock)}
      {/*
        * §41 — THE HERO. The banner across the top of a dashboard: the single
        * biggest difference between a grid of charts and the branded,
        * photograph-led dashboards this was modelled on. The scrim between
        * the picture and the words is not decoration — see `scrimFor`.
        */}
      {p.widgets && heroRows(p.hero) > 0 && (() => {
        const hero = p.hero!;
        const rows = heroRows(hero);
        const hasImage = !!hero.imageUrl;
        const scrim = scrimFor(hasImage, hero.scrim);
        return (
          <div className="ax-hero" data-testid="ax-hero"
            style={{
              height: rows * DASHBOARD_ROW_PX + (rows - 1) * DASHBOARD_GAP_PX,
              backgroundImage: hasImage ? cssUrl(hero.imageUrl!) : undefined,
              backgroundColor: hasImage ? undefined : theme.colors.background,
              // the banner is a column flex box, so justify-content moves the
              // text VERTICALLY: setting it from `align` pinned the title to the
              // top and did nothing for left/centre. Horizontal alignment is the
              // text's own, and the box stays bottom-anchored.
              textAlign: hero.align === "center" ? "center" : "left",
            }}>
            {scrim > 0 && <span className="ax-hero-scrim" style={{ background: `rgba(19,26,43,${scrim / 100})` }} />}
            <div className="ax-hero-text" style={{ color: overlayTextColor(hasImage, theme.colors.text, hero.textColor) }}>
              {hero.title && <div className="ax-hero-title" style={{ fontFamily: theme.headingFontFamily ?? font }}>{hero.title}</div>}
              {hero.subtitle && <div className="ax-hero-sub">{hero.subtitle}</div>}
            </div>
          </div>
        );
      })()}
      {p.widgets && (
        <div className="ax-dashboard" data-testid="ax-dashboard" ref={gridRef} data-editable={p.onLayout ? "1" : undefined}
          style={{
            gridTemplateColumns: `repeat(${DASHBOARD_COLUMNS}, minmax(0, 1fr))`,
            gridAutoRows: `${DASHBOARD_ROW_PX}px`,
            gap: DASHBOARD_GAP_PX,
            // room to drop a widget below the last row while editing, and for
            // any band that reaches past the lowest widget
            minHeight: (Math.max(layoutRows(laidOut), ...bands.map((b) => b.toRow + 1), 0) + (p.onLayout ? 2 : 0)) * (DASHBOARD_ROW_PX + DASHBOARD_GAP_PX),
          }}>
          {/*
            * §41 — the bands, drawn first so they sit UNDER the widgets. They
            * are grid items like everything else, spanning every column of
            * their row range, which is why a cluster of widgets can sit on a
            * photograph without any of them overlapping each other.
            */}
          {bands.map((b) => {
            const hasImage = !!b.imageUrl;
            const scrim = scrimFor(hasImage, b.scrim);
            return (
              <div key={b.id} className="ax-band" data-testid="ax-band" data-from={b.fromRow} data-to={b.toRow}
                style={{
                  gridColumn: "1 / -1", gridRow: `${b.fromRow + 1} / ${b.toRow + 2}`,
                  backgroundImage: hasImage ? cssUrl(b.imageUrl!) : undefined,
                  backgroundColor: b.color || undefined,
                }}>
                {scrim > 0 && <span className="ax-band-scrim" style={{ background: `rgba(19,26,43,${scrim / 100})` }} />}
                {b.title && <span className="ax-band-title" style={{ color: overlayTextColor(hasImage, theme.colors.subtle) }}>{b.title}</span>}
              </div>
            );
          })}
          {sortByPosition(laidOut).map((w) => {
            const r = w.analysisId ? results[w.analysisId] : undefined;
            const live = drag?.id === w.id ? drag.box : w;
            const style: React.CSSProperties = {
              gridColumn: `${live.x + 1} / span ${live.w}`,
              gridRow: `${live.y + 1} / span ${live.h}`,
            };
            const bgScrim = w.backgroundImageUrl ? scrimFor(true, w.backgroundScrim) : 0;
            return <div key={w.id} className={`ax-widget${drag?.id === w.id ? " dragging" : ""}${w.backgroundImageUrl ? " has-bg" : ""}`} style={style}
              data-testid="ax-widget" data-id={w.id} data-x={live.x} data-y={live.y} data-w={live.w} data-h={live.h}>
              {/* §41 — a photograph behind this widget's own content, with its wash over it */}
              {w.backgroundImageUrl && <span className="ax-widget-bg" style={{ backgroundImage: cssUrl(w.backgroundImageUrl) }} />}
              {bgScrim > 0 && <span className="ax-widget-bg-scrim" style={{ background: `rgba(19,26,43,${bgScrim / 100})` }} />}
              <Actions id={w.id} />
              {/*
                * §40 — the grip and the corner handle. Dragging is confined to
                * these rather than to the widget's whole body: a chart inside
                * a widget has its own click-to-cross-filter and legend
                * toggles, and a body-wide drag would swallow both.
                */}
              {p.onLayout && (
                <button type="button" className="ax-widget-grip" data-testid="ax-widget-grip" title="Drag to move — arrow keys nudge, shift + arrows resize"
                  onPointerDown={(e) => beginDrag(e, w, "move")} onPointerMove={onDragMove} onPointerUp={endDrag} onPointerCancel={endDrag}
                  onKeyDown={(e) => onGripKey(e, w)} aria-label={`Move ${w.title ?? w.type} widget`}>⠿</button>
              )}
              {p.onLayout && (
                <span className="ax-widget-resize" data-testid="ax-widget-resize" title="Drag to resize"
                  onPointerDown={(e) => beginDrag(e, w, "resize")} onPointerMove={onDragMove} onPointerUp={endDrag} onPointerCancel={endDrag} />
              )}
              {w.title && <div className="ax-widget-title">{w.title}</div>}
              {w.type === "text" && <div dangerouslySetInnerHTML={{ __html: mdToHtml(w.text ?? "") }} />}
              {w.type === "kpi" && (r ? <Chart result={r} spec={{ type: r.chart.kpis && r.chart.kpis.length === 1 ? "gauge" : "kpi_card", options: { showBase: false } }} theme={theme} height={Math.max(120, live.h * DASHBOARD_ROW_PX - 30)} /> : <Missing id={w.analysisId ?? ""} hint={w.placeholder} />)}
              {w.type === "chart" && (w.analysisId && r ? renderChart(w.analysisId, w.chart ?? { type: r.recommendedCharts[0] ?? "bar_vertical", options: {} }, Math.max(160, live.h * DASHBOARD_ROW_PX - 30)) : <Missing id={w.analysisId ?? ""} hint={w.placeholder} />)}
              {w.type === "table" && (w.analysisId && r ? <ResultTableView table={r.tables[0]} dense maxRows={Math.max(4, live.h * 2)} /> : <Missing id={w.analysisId ?? ""} hint={w.placeholder} />)}
              {w.type === "filter" && <div className="muted" style={{ fontSize: 13 }}>Segment switch: use the selector in the bar above.</div>}
              {/*
                * §38 — the operational-dashboard widgets, modelled on
                * Forsta/Dapresy-style CX/EX dashboards: a photo tile with an
                * overlay figure (StayLux's room ratings, Hotel's "77%
                * satisfied"), a pictogram breakdown (Junicom's person-icon
                * panel), a numbered process panel (CarFix's 1-2-3), and an
                * iconed ranked list. The chart/table/kpi widgets above stay
                * the analytical core; these are the photography- and
                * icon-heavy dressing the gallery is full of.
                */}
              {w.type === "photo" && (
                <div className="ax-photo-tile" style={{ backgroundImage: w.imageUrl ? cssUrl(w.imageUrl) : undefined, backgroundSize: w.fit === "contain" ? "contain" : "cover" }} data-testid="ax-widget-photo">
                  {!w.imageUrl && <div className="ax-photo-empty muted">{w.placeholder ? `${w.placeholder} — open this widget and choose one.` : "No image yet — open this widget and choose one."}</div>}
                  {(w.overlayValue || w.overlayTrend) && (
                    <div className="ax-photo-overlay">
                      {w.overlayValue && <div className="ax-photo-value">{w.overlayValue}</div>}
                      {w.overlayTrend && <span className={`ax-photo-trend ax-trend-${trendTone(w.overlayTrend)}`}>{w.overlayTrend}</span>}
                    </div>
                  )}
                </div>
              )}
              {w.type === "icon_panel" && (w.analysisId ? (r ? (() => {
                const series = seriesForChart(r, w.chart ?? { type: "bar_horizontal", options: {} })[0];
                if (!series) return <div className="muted" style={{ fontSize: 13 }}>No categories to show.</div>;
                return (
                  <div className="ax-icon-panel" data-testid="ax-widget-icon-panel">
                    {series.labels.map((label, i) => {
                      const v = series.values[i];
                      return (
                        <div key={label} className="ax-icon-row">
                          <IconPictogram icon={w.icon ?? "person"} pct={Math.max(0, Math.min(100, v ?? 0))} color={theme.colors.primary} />
                          <span className="ax-icon-label">{label}</span>
                          <span className="ax-icon-value">{fmtV(v, series.meta?.pct)}</span>
                        </div>
                      );
                    })}
                  </div>
                );
              })() : <Missing id={w.analysisId} />) : <Missing id="" hint={w.placeholder} />)}
              {w.type === "steps" && (
                <div className="ax-steps" data-testid="ax-widget-steps">
                  {(w.steps ?? []).map((s, i) => (
                    <div key={i} className="ax-step">
                      <div className="ax-step-badge" style={{ background: theme.colors.primary }}>{i + 1}</div>
                      {s.icon && <Icon name={s.icon} size={20} color={theme.colors.primary} />}
                      <div className="ax-step-title">{s.title}</div>
                      {s.description && <div className="ax-step-desc muted">{s.description}</div>}
                    </div>
                  ))}
                  {!(w.steps ?? []).length && <div className="muted" style={{ fontSize: 13 }}>No steps yet — open this widget and add one.</div>}
                </div>
              )}
              {w.type === "ranked_list" && (w.analysisId ? (r ? (() => {
                const series = seriesForChart(r, w.chart ?? { type: "bar_horizontal", options: { sort: "desc" } })[0];
                if (!series) return <div className="muted" style={{ fontSize: 13 }}>No categories to show.</div>;
                const max = Math.max(1, ...series.values.map((v) => v ?? 0));
                return (
                  <ol className="ax-ranked-list" data-testid="ax-widget-ranked-list">
                    {series.labels.map((label, i) => {
                      const v = series.values[i] ?? 0;
                      return (
                        <li key={label} className="ax-ranked-row">
                          <span className="ax-ranked-rank">{i + 1}</span>
                          {w.icon && <Icon name={w.icon} size={15} color={theme.colors.subtle} />}
                          <span className="ax-ranked-label">{label}</span>
                          <span className="ax-ranked-bar-track"><span className="ax-ranked-bar" style={{ width: `${Math.max(4, (v / max) * 100)}%`, background: theme.colors.palette[i % theme.colors.palette.length] }} /></span>
                          <span className="ax-ranked-value">{fmtV(v, series.meta?.pct)}</span>
                        </li>
                      );
                    })}
                  </ol>
                );
              })() : <Missing id={w.analysisId} />) : <Missing id="" hint={w.placeholder} />)}
            </div>;
          })}
        </div>
      )}
      {p.branding?.footer && <div className="ax-report-footer" style={{ color: theme.colors.subtle }}>{p.branding.footer}</div>}
      {theme.footer && !p.branding?.footer && <div className="ax-report-footer" style={{ color: theme.colors.subtle }}>{theme.footer}</div>}
    </div>
  );
}

/**
 * POWERPOINT EXPORT (§18, §19). Native, editable PowerPoint charts and tables
 * built with pptxgenjs from analysis results — a cover, optional executive
 * summary, one section per report block, chart or table slides with base
 * sizes and footnotes, a methodology slide. The Report Theme supplies colours,
 * fonts and logo; nothing here reads survey branding.
 */
import PptxModule from "pptxgenjs";
// pptxgenjs ships CJS-style typings; under Node ESM the default import is the class itself,
// while TypeScript sees the module namespace — resolve both shapes to the constructor.
type PptxCtorType = typeof PptxModule extends { default: infer D } ? D : typeof PptxModule;
const PptxCtor = (((PptxModule as unknown as { default?: unknown }).default ?? PptxModule) as unknown) as PptxCtorType;
type Pres = InstanceType<PptxCtorType>;
type Slide = ReturnType<Pres["addSlide"]>;
type ChartName = Extract<Parameters<Slide["addChart"]>[0], string>;
import type { AnalysisResult, ChartSpec, ChartType, ExportSettings, ReportBlock, ReportDefinition, ReportTheme, ResultTable } from "../types.js";
import { DEFAULT_EXPORT_SETTINGS, DEFAULT_THEME } from "../types.js";
import { executiveSummary } from "../summary.js";
import { chartTitleFor, seriesForChart } from "./shared.js";
import { methodologyBlock, methodologyLines } from "../reportPages.js";

export interface ExportItem { title: string; result: AnalysisResult; chart?: ChartSpec; caption?: string; tableId?: string }

export interface PptxInput {
  report: Pick<ReportDefinition, "title" | "subtitle" | "blocks" | "branding"> & { author?: string; date?: string };
  results: Record<string, AnalysisResult>;
  theme?: ReportTheme | null;
  settings?: Partial<ExportSettings>;
  /** survey / dataset metadata for the methodology slide */
  meta?: { survey?: string; environment?: string; dataset?: string; responses?: number; generatedBy?: string; weighting?: string };
  /**
   * §43 — pictures of blocks PowerPoint cannot draw, keyed by block id.
   *
   * A map is the case this exists for: pptxgenjs has no map chart, and the
   * only thing that can draw one is the renderer that already did, in the
   * browser. So the client rasterises what is on screen and hands it over,
   * and the deck carries the real map instead of the ranked bars it used to
   * substitute. No image supplied (an export started from a tab where the
   * report is not rendered) falls back to those bars, with the note.
   */
  images?: Record<string, string>;
}

/**
 * A data URI this builder is willing to put in a deck: a PNG or JPEG, base64,
 * and small enough not to be a way of stuffing a file with something else.
 * Anything failing that is dropped rather than embedded — the export is a
 * document the customer sends on, not a channel for arbitrary bytes.
 */
export const MAX_EMBEDDED_IMAGE_BYTES = 6 * 1024 * 1024;
export function isEmbeddableImage(uri: unknown): uri is string {
  if (typeof uri !== "string") return false;
  if (!/^data:image\/(png|jpeg);base64,[A-Za-z0-9+/=]+$/.test(uri)) return false;
  const b64 = uri.slice(uri.indexOf(",") + 1);
  return b64.length > 64 && (b64.length * 3) / 4 <= MAX_EMBEDDED_IMAGE_BYTES;
}

const hex = (c: string) => c.replace("#", "").slice(0, 6).toUpperCase();

function pptChartType(p: Pres, type: ChartType): { type: ChartName; opts: Record<string, unknown> } {
  const T = p.ChartType;
  switch (type) {
    case "bar_horizontal": case "ranking_bar": case "lollipop": case "dot_plot": case "maxdiff_utility": case "maxdiff_preference": case "attribute_importance": case "coefficient_plot": case "forest": case "keyword_bar":
      return { type: T.bar, opts: { barDir: "bar" } };
    case "bar_grouped": case "column_clustered": case "bar_vertical": case "histogram": case "target_actual": case "segment_comparison": case "segment_profile": case "preference_share": case "maxdiff_best_worst": case "diff_means": case "diff_proportions": case "mean_ci": case "error_bar": case "ci_plot": case "sentiment_distribution": case "wave_trend":
      return { type: T.bar, opts: { barDir: "col", barGrouping: "clustered" } };
    case "bar_stacked": case "funnel": case "funnel_brand": case "funnel_purchase": case "funnel_awareness": case "funnel_dropout": case "waterfall":
      return { type: T.bar, opts: { barDir: "col", barGrouping: "stacked" } };
    case "bar_stacked_100": case "diverging_likert":
      return { type: T.bar, opts: { barDir: "bar", barGrouping: "percentStacked" } };
    case "pie": return { type: T.pie, opts: {} };
    case "donut": case "donut_semi": case "donut_nested": case "donut_radial": case "segment_size": return { type: T.doughnut, opts: { holeSize: 55 } };
    case "line": case "line_multi": case "spline": case "step_line": case "rolling_average": case "yoy_trend": case "mom_trend": case "trend" as never: case "sentiment_trend": case "demand_curve": case "purchase_probability": case "revenue_curve": case "price_elasticity": case "price_sensitivity": case "bump":
      return { type: T.line, opts: { lineSize: 2, lineDataSymbolSize: 6 } };
    case "area": case "area_stacked": return { type: T.area, opts: {} };
    case "radar": case "spider": case "radar_multi": case "radar_brand": case "radar_segment": return { type: T.radar, opts: { radarStyle: "marker" } };
    case "scatter": case "scatter_trendline": case "scatter_ci": case "bubble": case "heatmap_ipa": case "segment_bubble": return { type: T.scatter, opts: { lineSize: 0, lineDataSymbolSize: 8 } };
    default: return { type: T.bar, opts: { barDir: "col" } };
  }
}

function addTable(slide: Slide, table: ResultTable, theme: ReportTheme, box: { x: number; y: number; w: number }, maxRows = 14, fontSize = 9): number {
  const cols = table.columns;
  const head = cols.map((c) => ({ text: c.label, options: { bold: true, color: "FFFFFF", fill: { color: hex(theme.colors.primary) }, fontSize, align: "center" as const } }));
  const body = table.rows.slice(0, maxRows).map((r, i) => cols.map((c) => {
    const v = r[c.key];
    const sig = r[`${c.key}__sig`];
    const ctype = (r.__format as string | undefined) ?? c.type;
    const text = v == null ? "" : typeof v === "number" ? (ctype === "pct" ? `${v.toFixed(c.decimals ?? 1)}%` : ctype === "count" ? String(Math.round(v)) : v.toFixed(c.decimals ?? 2)) : String(v);
    return { text: sig ? `${text} ${sig}` : text, options: { fontSize, align: (typeof v === "number" ? "right" : "left") as "left" | "right", fill: { color: i % 2 ? "F5F7FA" : "FFFFFF" }, color: hex(theme.colors.text) } };
  }));
  const rowsAll = [head, ...body];
  const h = Math.min((fontSize / 9) * 0.32 * rowsAll.length, 4.6);
  slide.addTable(rowsAll as never, { x: box.x, y: box.y, w: box.w, h, colW: cols.map((_, i) => (i === 0 ? box.w * 0.3 : (box.w * 0.7) / Math.max(1, cols.length - 1))), border: { type: "solid", pt: 0.5, color: "D9DEE6" }, fontFace: theme.fontFamily.split(",")[0].trim() });
  return box.y + h + 0.15;
}

/**
 * Draw one analysis as a chart or table inside an arbitrary box (§37).
 *
 * This is the same decision the "chart" block has always made — a table
 * when the spec says table, or the data is empty, or the chart type is
 * inherently a table (heatmap, word cloud, …) — factored out so a panel in a
 * `panel_grid` gets exactly the same drawing logic as a full-slide chart
 * block, just inside a smaller box. `tableBox` defaults to the full-width
 * table geometry the export has always used, so an existing "chart" block
 * that happens to fall back to a table renders pixel-identical to before.
 */
function drawAnalysisVisual(
  p: Pres, s: Slide, result: AnalysisResult, spec: ChartSpec, theme: ReportTheme,
  box: { x: number; y: number; w: number; h: number },
  ctx: { font: string; text: string; subtle: string; primary: string; palette: string[] },
  opts: { tableBox?: { x: number; w: number }; fontSize?: number; maxRows?: number; image?: string } = {},
): void {
  /*
   * §43 — a picture of this block, rendered by the only thing that can draw
   * it. It replaces the chart entirely rather than sitting beside it.
   */
  if (opts.image && isEmbeddableImage(opts.image)) {
    s.addImage({ data: opts.image, x: box.x, y: box.y, w: box.w, h: box.h, sizing: { type: "contain", w: box.w, h: box.h } } as never);
    return;
  }
  const data = seriesForChart(result, spec);
  const isTable = spec.type === "table" || !data.length || ["heatmap", "heatmap_crosstab", "heatmap_correlation", "correlation_matrix", "word_cloud", "treemap", "sunburst", "dendrogram", "network", "sankey", "kpi_card", "gauge", "scorecard", "table"].includes(spec.type);
  if (isTable) {
    const table = result.tables[0];
    const tb = opts.tableBox ?? { x: 0.5, w: 9 };
    if (table) addTable(s, table, theme, { x: tb.x, y: box.y, w: tb.w }, opts.maxRows ?? 14, opts.fontSize ?? 9);
    return;
  }
  const { type, opts: chartOpts } = pptChartType(p, spec.type);
  /*
   * §39 — PowerPoint has no map. A geographic chart therefore leaves this
   * export as ranked bars of the same numbers, which is a fair substitute but
   * NOT what the author laid out on screen. It says so on the slide: a reader
   * handed a deck of bars, when the analyst was looking at a choropleth, has
   * no other way to know the two are the same chart. (Drawing the map as a
   * picture in the deck is the next step, not a silent one.)
   */
  const isGeo = ["map_country", "map_state", "choropleth", "map_bubble", "map_heat"].includes(spec.type);
  // §43 — the note is only honest when the substitution actually happened; with
  // a picture from the renderer the slide carries the real map.
  if (isGeo) {
    s.addText("Shown as ranked bars — PowerPoint has no map chart; the map is on the dashboard.", {
      x: box.x, y: Math.max(0.1, box.y - 0.22), w: box.w, h: 0.2,
      fontSize: 8, italic: true, color: ctx.subtle, fontFace: ctx.font,
    });
  }
  const pctAxis = data[0]?.meta?.pct;
  const isScatter = type === p.ChartType.scatter;
  const chartData = isScatter && result.chart.points?.length
    ? [{ name: "X", values: result.chart.points.map((pt) => pt.x) }, { name: spec.options.yLabel ?? "Y", values: result.chart.points.map((pt) => pt.y) }]
    : data.map((d) => ({ name: d.name, labels: d.labels, values: d.values.map((v) => v ?? 0) }));
  const fs = opts.fontSize ?? 9;
  s.addChart(type, chartData as never, {
    x: box.x, y: box.y, w: box.w, h: box.h, ...chartOpts,
    chartColors: spec.options.colors?.map(hex) ?? ctx.palette,
    showValue: spec.options.dataLabels ?? theme.chart?.dataLabels ?? true,
    dataLabelFormatCode: pctAxis ? '0.0"%"' : `0${(spec.options.decimals ?? theme.chart?.decimals ?? 0) > 0 ? "." + "0".repeat(spec.options.decimals ?? theme.chart?.decimals ?? 1) : ""}`,
    dataLabelFontSize: fs, dataLabelColor: ctx.text, dataLabelFontFace: ctx.font,
    showLegend: (spec.options.legend ?? (data.length > 1 ? "bottom" : "none")) !== "none", legendPos: (spec.options.legend === "right" ? "r" : spec.options.legend === "top" ? "t" : "b") as "r" | "t" | "b", legendFontSize: fs + 1, legendFontFace: ctx.font,
    catAxisLabelFontSize: fs + 1, valAxisLabelFontSize: fs, catAxisLabelFontFace: ctx.font, valAxisLabelFontFace: ctx.font,
    valGridLine: (spec.options.gridLines ?? theme.chart?.gridLines) === false ? { style: "none" } : { color: "E5E9F0", style: "solid", size: 0.5 },
    catAxisTitle: spec.options.xLabel, showCatAxisTitle: !!spec.options.xLabel, valAxisTitle: spec.options.yLabel, showValAxisTitle: !!spec.options.yLabel,
    valAxisMaxVal: pctAxis && ["bar_stacked_100", "diverging_likert"].includes(spec.type) ? 100 : undefined,
    ...(type === p.ChartType.pie || type === p.ChartType.doughnut ? { showLegend: true, legendPos: "r" as const, showValue: !!pctAxis, showPercent: !pctAxis, dataLabelPosition: "bestFit", dataLabelFormatCode: pctAxis ? '0"%"' : "0%" } : {}),
  } as never);
}

/**
 * A `panel_grid` block (§37): a headline sentence, then N analyses laid out
 * in a grid on one slide — the shape a tracker snapshot or a monthly trend
 * page actually needs, built from the same chart/table drawing every other
 * block uses. A panel with no analysis yet (or one that isn't in this bag of
 * results) draws a labelled placeholder instead of being skipped silently,
 * the same "say what is missing" choice `ReportView` makes on screen.
 */
function panelGridSlide(
  p: Pres, decorate: (s: Slide, title?: string) => void,
  block: Extract<ReportBlock, { type: "panel_grid" }>,
  results: Record<string, AnalysisResult>,
  theme: ReportTheme, W: number, H: number,
  ctx: { font: string; text: string; subtle: string; primary: string; palette: string[] },
): void {
  const s = p.addSlide();
  decorate(s, block.title);
  let top = 1.05;
  if (block.headline) {
    s.addText(block.headline, { x: 0.6, y: top, w: W - 1.2, h: 0.42, fontSize: 13, italic: true, color: ctx.primary, fontFace: ctx.font, valign: "top" });
    top += 0.52;
  }
  const panels = block.panels.length ? block.panels : [{ id: "empty", analysisId: "" }];
  const n = panels.length;
  const cols = Math.max(1, Math.min(n, block.columns ?? (n <= 2 ? n : n === 3 ? 3 : n <= 4 ? 2 : 4)));
  const rows = Math.ceil(n / cols);
  const gap = 0.22;
  const areaW = W - 1.2, areaH = Math.max(1, H - 0.55 - top);
  const panelW = (areaW - gap * (cols - 1)) / cols;
  const panelH = (areaH - gap * (rows - 1)) / rows;
  panels.forEach((panel, i) => {
    const col = i % cols, row = Math.floor(i / cols);
    const x = 0.6 + col * (panelW + gap);
    const y = top + row * (panelH + gap);
    const hasLabel = !!panel.title;
    if (hasLabel) s.addText(panel.title!, { x, y, w: panelW, h: 0.26, fontSize: 10.5, bold: true, color: ctx.text, fontFace: ctx.font });
    const bodyY = y + (hasLabel ? 0.28 : 0);
    const bodyH = Math.max(0.3, panelH - (hasLabel ? 0.28 : 0) - 0.2);
    const result = panel.analysisId ? results[panel.analysisId] : undefined;
    if (!result) {
      s.addShape(p.ShapeType.roundRect, { x, y: bodyY, w: panelW, h: bodyH, fill: { color: "F5F7FA" }, line: { color: "E5E9F0" }, rectRadius: 0.05 });
      s.addText(panel.analysisId ? "Not available" : "No analysis selected yet", { x, y: bodyY, w: panelW, h: bodyH, fontSize: 9, color: ctx.subtle, align: "center", valign: "middle", fontFace: ctx.font });
    } else if (panel.chart) {
      drawAnalysisVisual(p, s, result, panel.chart, theme, { x, y: bodyY, w: panelW, h: bodyH }, ctx, { tableBox: { x, w: panelW }, fontSize: 7.5, maxRows: 8 });
    } else {
      const table = panel.tableId ? result.tables.find((t) => t.id === panel.tableId) ?? result.tables[0] : result.tables[0];
      if (table) addTable(s, table, theme, { x, y: bodyY, w: panelW }, 8, 7.5);
    }
    const noteY = y + panelH - 0.19;
    if (panel.caption) s.addText(panel.caption, { x, y: noteY, w: panelW, h: 0.19, fontSize: 6.5, color: ctx.subtle, fontFace: ctx.font });
    else if (result) s.addText(`n = ${result.base.n}`, { x, y: noteY, w: panelW, h: 0.19, fontSize: 6.5, color: ctx.subtle, fontFace: ctx.font });
  });
}

export async function buildPptx(input: PptxInput): Promise<Buffer> {
  const theme = input.theme ?? DEFAULT_THEME;
  const settings: ExportSettings = { ...DEFAULT_EXPORT_SETTINGS, ...input.settings, include: { ...DEFAULT_EXPORT_SETTINGS.include, ...input.settings?.include }, pptx: { ...DEFAULT_EXPORT_SETTINGS.pptx, ...input.settings?.pptx } };
  const px = settings.pptx!;
  const p = new PptxCtor();
  p.layout = px.slideSize === "4x3" ? "LAYOUT_4x3" : px.slideSize === "16x10" ? "LAYOUT_16x10" : "LAYOUT_16x9";
  p.title = input.report.title;
  p.author = input.report.author ?? "Rescript";
  const font = (px.fontFamily ?? theme.fontFamily).split(",")[0].trim();
  const W = px.slideSize === "4x3" ? 10 : 10, H = px.slideSize === "4x3" ? 7.5 : px.slideSize === "16x10" ? 6.25 : 5.625;
  const primary = hex(theme.colors.primary), text = hex(theme.colors.text), subtle = hex(theme.colors.subtle);
  const palette = theme.colors.palette.map(hex);
  const footer = px.footer ?? theme.footer ?? input.report.branding?.footer ?? "";
  let slideNo = 0;
  const decorate = (s: Slide, title?: string) => {
    slideNo++;
    s.background = { color: hex(px.background ?? theme.colors.background) };
    if (title) {
      s.addText(title, { x: 0.5, y: 0.25, w: W - 1, h: 0.6, fontSize: theme.typography?.titleSize ?? 20, bold: true, color: text, fontFace: font });
      s.addShape(p.ShapeType.rect, { x: 0.5, y: 0.9, w: 1.2, h: 0.05, fill: { color: primary }, line: { color: primary } });
    }
    if (footer) s.addText(footer, { x: 0.5, y: 5.25, w: W - 2.5, h: 0.3, fontSize: 8, color: subtle, fontFace: font });
    if (px.slideNumbers) s.addText(String(slideNo), { x: W - 1.2, y: 5.25, w: 0.7, h: 0.3, fontSize: 8, color: subtle, align: "right", fontFace: font });
    if (theme.logoUrl && theme.logoUrl.startsWith("data:") && input.report.branding?.showLogo !== false) s.addImage({ data: theme.logoUrl, x: W - 1.6, y: 0.2, w: 1.1, h: 0.5 });
  };

  // cover
  const cover = p.addSlide();
  slideNo++;
  cover.background = { color: hex(theme.cover?.background ?? theme.colors.primary) };
  const coverText = hex(theme.cover?.textColor ?? "#ffffff");
  cover.addText(input.report.title, { x: 0.6, y: 1.6, w: W - 1.2, h: 1.2, fontSize: 34, bold: true, color: coverText, fontFace: font, align: theme.cover?.layout === "center" ? "center" : "left" });
  if (input.report.subtitle) cover.addText(input.report.subtitle, { x: 0.6, y: 2.8, w: W - 1.2, h: 0.6, fontSize: 16, color: coverText, fontFace: font, align: theme.cover?.layout === "center" ? "center" : "left" });
  cover.addText(`${input.report.date ?? new Date().toISOString().slice(0, 10)}${input.report.author ? " · " + input.report.author : ""}`, { x: 0.6, y: 4.6, w: W - 1.2, h: 0.4, fontSize: 11, color: coverText, fontFace: font, align: theme.cover?.layout === "center" ? "center" : "left" });
  if (theme.logoUrl && theme.logoUrl.startsWith("data:")) cover.addImage({ data: theme.logoUrl, x: 0.6, y: 0.5, w: 1.6, h: 0.7 });

  // executive summary
  const usedResults = input.report.blocks.flatMap((b) => ("analysisId" in b && b.analysisId ? [{ name: ("title" in b && b.title) || input.results[b.analysisId]?.name || b.analysisId, result: input.results[b.analysisId] }] : "analysisIds" in b ? b.analysisIds.map((id) => ({ name: input.results[id]?.name ?? id, result: input.results[id] })) : [])).filter((x) => x.result);
  if (settings.include.executiveSummary) {
    const items = executiveSummary(usedResults.filter((x, i, a) => a.findIndex((y) => y.result === x.result) === i));
    if (items.length) {
      const chunks: typeof items[] = [];
      for (let i = 0; i < items.length; i += 5) chunks.push(items.slice(i, i + 5));
      chunks.forEach((chunk, ci) => {
        const s = p.addSlide(); decorate(s, `Executive summary${chunks.length > 1 ? ` (${ci + 1}/${chunks.length})` : ""}`);
        s.addText(chunk.map((it) => ({ text: `${it.analysis}: ${it.headline} (${it.base})`, options: { bullet: true, fontSize: 12, color: text, fontFace: font, paraSpaceAfter: 6, breakLine: true } })), { x: 0.6, y: 1.1, w: W - 1.2, h: 4, valign: "top" });
      });
    }
  }

  // blocks
  for (const block of input.report.blocks) {
    if (block.type === "cover") continue;
    if (block.type === "section") { if (!px.sectionDividers) continue; const s = p.addSlide(); slideNo++; s.background = { color: hex(theme.colors.secondary) }; s.addText(block.title, { x: 0.6, y: 2.0, w: W - 1.2, h: 1, fontSize: 28, bold: true, color: "FFFFFF", fontFace: font }); if (block.subtitle) s.addText(block.subtitle, { x: 0.6, y: 3.0, w: W - 1.2, h: 0.6, fontSize: 14, color: "FFFFFF", fontFace: font }); continue; }
    if (block.type === "text") { const s = p.addSlide(); decorate(s, block.title ?? ""); s.addText(block.markdown.replace(/[#*_`>]/g, ""), { x: 0.6, y: 1.1, w: W - 1.2, h: 4, fontSize: 12, color: text, fontFace: font, valign: "top" }); continue; }
    if (block.type === "executive_summary") { const s = p.addSlide(); decorate(s, block.title ?? "Executive summary"); const items = executiveSummary(block.analysisIds.map((id) => ({ name: input.results[id]?.name ?? id, result: input.results[id] })).filter((x) => x.result)); s.addText((block.text ? [{ text: block.text, options: { fontSize: 12, color: text, fontFace: font, breakLine: true, paraSpaceAfter: 8 } }] : []).concat(items.map((it) => ({ text: `${it.analysis}: ${it.headline}`, options: { bullet: true, fontSize: 12, color: text, fontFace: font, breakLine: true, paraSpaceAfter: 6 } as never }))), { x: 0.6, y: 1.1, w: W - 1.2, h: 4, valign: "top" }); continue; }
    if (block.type === "insights") { const s = p.addSlide(); decorate(s, block.title ?? "Key insights"); const lines = block.analysisIds.flatMap((id) => input.results[id]?.insights ?? []); s.addText(lines.map((l) => ({ text: l, options: { bullet: true, fontSize: 12, color: text, fontFace: font, breakLine: true, paraSpaceAfter: 6 } })), { x: 0.6, y: 1.1, w: W - 1.2, h: 4, valign: "top" }); continue; }
    /*
     * §36 — a page break is already a slide boundary here, since every block
     * gets its own slide; it is skipped rather than rendered. The METHODOLOGY
     * block is not rendered in place either: it is the last slide of the deck
     * (below), where a methodology belongs and where this export has always
     * put it.
     */
    if (block.type === "page_break" || block.type === "methodology") continue;
    /*
     * §37 — a panel grid has no single `analysisId` (it has one per panel),
     * so it is drawn before the generic lookup below rather than falling
     * through it.
     */
    if (block.type === "panel_grid") { panelGridSlide(p, decorate, block, input.results, theme, W, H, { font, text, subtle, primary, palette }); continue; }
    const result = input.results[block.analysisId];
    if (!result) continue;
    if (block.type === "kpi") {
      const s = p.addSlide(); decorate(s, block.title ?? result.name);
      const kpis = result.chart.kpis ?? [];
      kpis.slice(0, 4).forEach((k, i) => { const x = 0.6 + i * ((W - 1.2) / Math.min(4, kpis.length)); s.addShape(p.ShapeType.roundRect, { x, y: 1.6, w: (W - 1.2) / Math.min(4, kpis.length) - 0.2, h: 1.8, fill: { color: "F5F7FA" }, line: { color: "D9DEE6" }, rectRadius: 0.1 }); s.addText(`${typeof k.value === "number" ? k.value.toLocaleString() : k.value}${k.unit ?? ""}`, { x, y: 1.7, w: (W - 1.2) / Math.min(4, kpis.length) - 0.2, h: 1, fontSize: 30, bold: true, color: primary, align: "center", fontFace: font }); s.addText(k.label, { x, y: 2.7, w: (W - 1.2) / Math.min(4, kpis.length) - 0.2, h: 0.5, fontSize: 12, color: subtle, align: "center", fontFace: font }); });
      s.addText(`Base: n = ${result.base.n}`, { x: 0.6, y: 4.8, w: W - 1.2, h: 0.3, fontSize: 9, color: subtle, fontFace: font });
      continue;
    }
    if (block.type === "chart" && settings.include.charts) {
      const spec = block.chart;
      const s = p.addSlide(); decorate(s, block.title ?? chartTitleFor(result, spec));
      const chartW = px.chartWidth ?? W - 1.2, chartH = px.chartHeight ?? 3.7;
      drawAnalysisVisual(p, s, result, spec, theme, { x: 0.6, y: 1.1, w: chartW, h: chartH }, { font, text, subtle, primary, palette }, { image: input.images?.[block.id] });
      const notes = [`Base: n = ${result.base.n}${result.base.weightedN !== result.base.n ? ` (weighted ${result.base.weightedN})` : ""}`, ...(block.caption ? [block.caption] : []), ...(spec.options.footnote ? [spec.options.footnote] : []), ...(settings.include.footnotes ? (result.tables[0]?.notes ?? []).slice(0, 2) : []), ...(settings.include.tests && result.tests[0] ? [`${result.tests[0].test.replace(/_/g, " ")}: p ${result.tests[0].p == null ? "—" : result.tests[0].p < 0.001 ? "< .001" : "= " + result.tests[0].p.toFixed(3)}`] : [])];
      s.addText(notes.join("  ·  "), { x: 0.6, y: 4.85, w: W - 1.2, h: 0.35, fontSize: 8, color: subtle, fontFace: font });
      continue;
    }
    if (block.type === "table" && settings.include.tables) {
      const table = block.tableId ? result.tables.find((t) => t.id === block.tableId) ?? result.tables[0] : result.tables[0];
      if (!table) continue;
      const perSlide = 14;
      for (let start = 0; start < Math.max(1, table.rows.length); start += perSlide) {
        const s = p.addSlide(); decorate(s, `${block.title ?? table.title}${table.rows.length > perSlide ? ` (${Math.floor(start / perSlide) + 1}/${Math.ceil(table.rows.length / perSlide)})` : ""}`);
        addTable(s, { ...table, rows: table.rows.slice(start, start + perSlide) }, theme, { x: 0.5, y: 1.1, w: 9 }, perSlide);
        s.addText([`Base: n = ${table.base?.n ?? result.base.n}`, ...(settings.include.footnotes ? table.notes ?? [] : [])].join("  ·  "), { x: 0.6, y: 4.95, w: W - 1.2, h: 0.3, fontSize: 8, color: subtle, fontFace: font });
      }
    }
  }

  // sample profile
  if (settings.include.sampleProfile && usedResults.length) {
    const s = p.addSlide(); decorate(s, "Sample");
    const first = usedResults[0].result;
    s.addText([
      { text: `Responses analysed: ${first.base.total}`, options: { bullet: true, breakLine: true } },
      { text: `After filters: ${first.base.filtered}`, options: { bullet: true, breakLine: true } },
      ...(input.meta?.environment ? [{ text: `Environment: ${input.meta.environment === "LIVE" ? "Production" : input.meta.environment}`, options: { bullet: true, breakLine: true } }] : []),
      ...(input.meta?.dataset ? [{ text: `Dataset: ${input.meta.dataset}`, options: { bullet: true, breakLine: true } }] : []),
      ...(input.meta?.weighting ? [{ text: `Weighting: ${input.meta.weighting}`, options: { bullet: true, breakLine: true } }] : []),
    ].map((t) => ({ ...t, options: { ...t.options, fontSize: 13, color: text, fontFace: font, paraSpaceAfter: 6 } })), { x: 0.6, y: 1.1, w: W - 1.2, h: 3.5, valign: "top" });
  }
  if (settings.include.methodology) {
    /*
     * §36 — THE TEAM'S OWN METHODOLOGY, WHEN THEY HAVE WRITTEN ONE.
     *
     * This slide used to be four lines of boilerplate: who generated the
     * deck, that percentages are of valid responses, and how the
     * significance letters work. Every one of those is a claim about how the
     * study was run, and only the research team knows whether it is true of
     * THIS study — its fieldwork dates, its sample frame, its weighting, what
     * was excluded from the clean base. A report can now carry a methodology
     * block saying so, and `methodologyLines` puts the team's words above the
     * statistical notes, falling back to exactly the old boilerplate when the
     * report says nothing. So a deck never loses the slide it had, and a team
     * that fills the block in stops shipping our assumptions as their method.
     */
    const authored = methodologyBlock(input.report.blocks);
    const s = p.addSlide(); decorate(s, authored?.title ?? "Methodology & notes");
    const lines = [
      ...methodologyLines(authored, { survey: input.meta?.survey, generatedBy: input.meta?.generatedBy }),
      ...usedResults.filter((x) => x.result.warnings.length).slice(0, 4).map((x) => `${x.name}: ${x.result.warnings[0]}`),
    ];
    s.addText(lines.map((l) => ({ text: l, options: { bullet: true, fontSize: 11, color: text, fontFace: font, breakLine: true, paraSpaceAfter: 6 } })), { x: 0.6, y: 1.1, w: W - 1.2, h: 4, valign: "top" });
  }
  return (await p.write({ outputType: "nodebuffer" })) as Buffer;
}

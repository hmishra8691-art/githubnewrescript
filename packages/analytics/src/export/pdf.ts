/**
 * THE PDF EXPORT (Analytics upgrade 2026-11-06, M6) — a report definition drawn with pdfkit: cover, sections,
 * text, every chart as vector graphics (bars, stacked bars, donut, lines, heatmap, scatter — the same shapes the
 * animated story draws), every table paginated, the insights, the executive summary, a methodology page. The
 * interpretation a caller attaches to a block (the engine's plain reading, or the model's gated one, marked as
 * such) is printed under it. Nothing is rasterised and nothing is fetched: the file is complete and self-contained.
 */
import PDFDocument from "pdfkit";
import type { AnalysisResult, ChartSpec, ChartType, ReportBlock, ReportDefinition, ReportTheme, ResultTable } from "../types.js";
import { DEFAULT_THEME } from "../types.js";
import { executiveSummary } from "../summary.js";
import { summaryAnalysisIds } from "../blockRefs.js";
import { chartTitleFor, seriesForChart } from "./shared.js";
import { stackShares } from "../chartLayout.js";
import { methodologyLines } from "../reportPages.js";

export interface PdfInput {
  report: Pick<ReportDefinition, "title" | "subtitle" | "blocks"> & { author?: string; date?: string };
  results: Record<string, AnalysisResult>;
  theme?: ReportTheme | null;
  meta?: { survey?: string; environment?: string; dataset?: string; responses?: number; generatedBy?: string; weighting?: string };
  /** text printed under a block, by block id — the interpretation; each entry is one paragraph */
  notes?: Record<string, string[]>;
  settings?: { include?: { charts?: boolean; tables?: boolean; methodology?: boolean } };
}

type Kind = "hbar" | "vbar" | "stack" | "donut" | "line" | "heat" | "scatter";
const KIND: Partial<Record<ChartType, Kind>> = {
  bar_horizontal: "hbar", ranking_bar: "hbar", lollipop: "hbar", dot_plot: "hbar", pareto: "hbar",
  bar_vertical: "vbar", bar_grouped: "vbar", column_clustered: "vbar", histogram: "vbar",
  bar_stacked: "stack", bar_stacked_100: "stack", diverging_likert: "stack",
  pie: "donut", donut: "donut", donut_semi: "donut",
  line: "line", line_multi: "line", area: "line", spline: "line", wave_trend: "line", yoy_trend: "line", mom_trend: "line",
  heatmap: "heat", heatmap_crosstab: "heat", heatmap_correlation: "heat", correlation_matrix: "heat",
  scatter: "scatter", scatter_trendline: "scatter", bubble: "scatter",
};

const PAGE = { w: 595.28, h: 841.89, m: 48 }; // A4 portrait, points
const num = (v: number | null | undefined, pct: boolean, d = 1): string => (v == null || !Number.isFinite(v) ? "—" : `${v.toLocaleString("en-US", { maximumFractionDigits: d, minimumFractionDigits: 0 })}${pct ? "%" : ""}`);
const hex = (c: string | undefined, fallback: string) => (c && /^#[0-9a-f]{6}$/i.test(c) ? c : fallback);

export async function buildPdf(input: PdfInput): Promise<Buffer> {
  const theme = input.theme ?? DEFAULT_THEME;
  const palette = (theme.colors.palette?.length ? theme.colors.palette : ["#4f46e5", "#0ea5e9", "#10b981", "#f59e0b", "#ef4444", "#8b5cf6", "#14b8a6", "#f97316"]).map((c) => hex(c, "#4f46e5"));
  const primary = hex(theme.colors.primary, "#4f46e5"), text = hex(theme.colors.text, "#111827"), subtle = "#6b7280", grid = "#e5e7eb";
  const include = { charts: true, tables: true, methodology: true, ...(input.settings?.include ?? {}) };
  const doc = new PDFDocument({ size: "A4", margin: PAGE.m, info: { Title: input.report.title, Author: input.report.author ?? input.meta?.generatedBy ?? "Rescript", Creator: "Rescript Analytics" } });
  const chunks: Buffer[] = [];
  doc.on("data", (c: Buffer) => chunks.push(c));
  const done = new Promise<Buffer>((resolve, reject) => { doc.on("end", () => resolve(Buffer.concat(chunks))); doc.on("error", reject); });
  const W = PAGE.w - PAGE.m * 2;
  let pageNo = 1;
  /* the footer sits inside the bottom margin; pdfkit would start a new page for text below the margin, so the margin is lifted for the one line */
  const footer = () => { doc.save(); const m = doc.page.margins.bottom; doc.page.margins.bottom = 0; doc.fontSize(8).fillColor(subtle).text(`${input.report.title} · ${pageNo}`, PAGE.m, PAGE.h - 30, { width: W, align: "right", lineBreak: false }); doc.page.margins.bottom = m; doc.restore(); };
  const newPage = () => { doc.addPage(); pageNo++; };
  const ensure = (h: number) => { if (doc.y + h > PAGE.h - PAGE.m - 20) { footer(); newPage(); } };
  const heading = (s: string, size = 15) => { ensure(size + 14); doc.x = PAGE.m; doc.moveDown(0.4); doc.fontSize(size).fillColor(text).font("Helvetica-Bold").text(s, { width: W }); doc.font("Helvetica").moveDown(0.3); };
  const para = (s: string, size = 10.5, color = text) => { if (!s) return; ensure(size * 3); doc.x = PAGE.m; doc.fontSize(size).fillColor(color).text(s, { width: W, lineGap: 2 }); doc.moveDown(0.4); };
  const bullets = (lines: string[]) => { doc.x = PAGE.m; for (const l of lines) { ensure(30); doc.fontSize(10.5).fillColor(text).text(`•  ${l}`, { width: W, indent: 0, lineGap: 2 }); } doc.moveDown(0.4); };
  const notesFor = (id: string) => { const ns = input.notes?.[id]; if (ns?.length) { doc.moveDown(0.1); for (const n of ns) para(n, 10, "#374151"); } };

  /* cover */
  const cover = input.report.blocks.find((b): b is Extract<ReportBlock, { type: "cover" }> => b.type === "cover");
  doc.rect(0, 0, PAGE.w, 220).fill(primary);
  doc.fillColor("#ffffff").font("Helvetica-Bold").fontSize(26).text(cover?.title ?? input.report.title, PAGE.m, 90, { width: W });
  doc.font("Helvetica").fontSize(13).text(cover?.subtitle ?? input.report.subtitle ?? "", PAGE.m, doc.y + 6, { width: W });
  doc.fillColor(subtle).fontSize(10).text([cover?.date ?? input.report.date ?? new Date().toISOString().slice(0, 10), cover?.author ?? input.report.author ?? input.meta?.generatedBy, input.meta?.survey].filter(Boolean).join(" · "), PAGE.m, 250, { width: W });
  doc.y = 290;

  for (const block of input.report.blocks) {
    if (block.type === "cover" || block.type === "page_break") continue;
    if (block.type === "section") { footer(); newPage(); doc.rect(PAGE.m, 120, 6, 60).fill(primary); doc.fillColor(text).font("Helvetica-Bold").fontSize(22).text(block.title, PAGE.m + 18, 130, { width: W - 18 }); if (block.subtitle) doc.font("Helvetica").fontSize(12).fillColor(subtle).text(block.subtitle, PAGE.m + 18, doc.y + 4, { width: W - 18 }); doc.font("Helvetica"); doc.y = 220; continue; }
    if (block.type === "text") { if (block.title) heading(block.title, 13); para(block.markdown.replace(/[#*_`>]/g, "")); continue; }
    if (block.type === "executive_summary") {
      heading(block.title ?? "Executive summary");
      if (block.text) para(block.text);
      const items = executiveSummary(summaryAnalysisIds(block, input.report as ReportDefinition).map((id) => ({ name: input.results[id]?.name ?? id, result: input.results[id] })).filter((x) => x.result));
      bullets(items.map((it) => `${it.analysis}: ${it.headline}`));
      continue;
    }
    if (block.type === "insights") { heading(block.title ?? "Key insights", 13); bullets(summaryAnalysisIds(block, input.report as ReportDefinition).flatMap((id) => input.results[id]?.insights ?? [])); continue; }
    if (block.type === "kpi") {
      const r = input.results[block.analysisId]; if (!r) continue;
      const k = r.chart.kpis?.find((x) => !block.metric || x.label === block.metric) ?? r.chart.kpis?.[0];
      heading(block.title ?? r.name, 13);
      if (k) { ensure(60); doc.x = PAGE.m; doc.fontSize(28).fillColor(primary).font("Helvetica-Bold").text(`${typeof k.value === "number" ? num(k.value, false, 1) : k.value}${k.unit ?? ""}`, { width: W }); doc.font("Helvetica").fontSize(10).fillColor(subtle).text(`${k.label} · n = ${r.base.n.toLocaleString("en-US")}`); doc.moveDown(0.6); }
      notesFor(block.id);
      continue;
    }
    if (block.type === "chart" && include.charts) {
      const r = input.results[block.analysisId];
      if (r && !r.error) ensure(320);
      heading(block.title ?? (r ? chartTitleFor(r, block.chart) : "Chart"), 13);
      if (!r || r.error) { para(r?.error?.message ?? "This analysis is not available.", 10, subtle); continue; }
      const y0 = doc.y;
      drawChart(doc, r, block.chart, { x: PAGE.m, y: y0, w: W, h: 240 }, { palette, text, subtle, grid });
      /* pdfkit moves the cursor with every positioned text; the block's own flow resumes under the chart */
      doc.x = PAGE.m; doc.y = y0 + 250;
      doc.fontSize(9).fillColor(subtle).text(`n = ${r.base.n.toLocaleString("en-US")}${r.base.label ? ` · ${r.base.label}` : ""}`, PAGE.m, doc.y, { width: W });
      doc.moveDown(0.3);
      if (block.caption) para(block.caption, 10, "#374151");
      notesFor(block.id);
      continue;
    }
    if (block.type === "table" && include.tables) {
      const r = input.results[block.analysisId];
      const t = r ? (block.tableId ? r.tables.find((x) => x.id === block.tableId) : r.tables[0]) ?? r.tables[0] : undefined;
      ensure(90);
      heading(block.title ?? t?.title ?? r?.name ?? "Table", 13);
      if (!t) { para("No table for this analysis.", 10, subtle); continue; }
      drawTable(doc, t, { x: PAGE.m, w: W, ensure, text, subtle, grid, primary });
      if (block.caption) para(block.caption, 10, "#374151");
      notesFor(block.id);
      continue;
    }
  }

  if (include.methodology) {
    const mb = input.report.blocks.find((b): b is Extract<ReportBlock, { type: "methodology" }> => b.type === "methodology");
    const lines = methodologyLines(mb, { survey: input.meta?.survey, generatedBy: input.meta?.generatedBy });
    if (lines.length) { footer(); newPage(); heading("Methodology"); bullets(lines); }
  }
  footer();
  doc.end();
  return done;
}

/* ------------------------------------------------------------ charts, as vectors */

type Box = { x: number; y: number; w: number; h: number };
type Colors = { palette: string[]; text: string; subtle: string; grid: string };

function drawChart(doc: PDFKit.PDFDocument, r: AnalysisResult, spec: ChartSpec, box: Box, c: Colors) {
  const kind = KIND[spec.type] ?? (r.chart.matrix ? "heat" : r.chart.points?.length ? "scatter" : "vbar");
  const S = seriesForChart(r, spec).slice(0, 6);
  const pct = !!S[0]?.meta?.pct || r.chart.valueFormat === "pct";
  doc.save();
  const legend = (names: string[]) => { if (names.length < 2) return 0; names.slice(0, 6).forEach((n, i) => { const x = box.x + i * Math.min(120, box.w / Math.min(6, names.length)); doc.rect(x, box.y, 8, 8).fill(c.palette[i % c.palette.length]); doc.fontSize(8).fillColor(c.text).text(n.slice(0, 22), x + 11, box.y - 1, { width: box.w / 6 - 14, lineBreak: false }); }); return 16; };
  if (kind === "heat" && (r.chart.matrix || S.length)) { heat(doc, r, S, box, c, pct); doc.restore(); return; }
  if (kind === "scatter" && r.chart.points?.length) { scatter(doc, r.chart.points, box, c); doc.restore(); return; }
  if (!S.length || !S[0].labels.length) { doc.fontSize(10).fillColor(c.subtle).text("No chart data for this result.", box.x, box.y + box.h / 2, { width: box.w, align: "center" }); doc.restore(); return; }
  const top = legend(S.map((s) => s.name));
  const inner = { x: box.x, y: box.y + top, w: box.w, h: box.h - top };
  const cats = S[0].labels.slice(0, 14);
  const max = Math.max(1e-9, ...S.flatMap((s) => s.values.slice(0, 14).map((v) => v ?? 0)));
  if (kind === "hbar") {
    const labelW = Math.min(170, inner.w * 0.35), rowH = inner.h / cats.length, bh = Math.min(18, (rowH - 4) / S.length);
    cats.forEach((cat, i) => {
      doc.fontSize(8.5).fillColor(c.text).text(cat.slice(0, 34), inner.x, inner.y + i * rowH + rowH / 2 - 5, { width: labelW - 8, align: "right", lineBreak: false });
      S.forEach((s, j) => { const v = s.values[i] ?? 0, w = (v / max) * (inner.w - labelW - 50), y = inner.y + i * rowH + (rowH - bh * S.length) / 2 + j * bh;
        doc.rect(inner.x + labelW, y, Math.max(0, w), bh - 2).fill(c.palette[j % c.palette.length]);
        doc.fontSize(8).fillColor(c.text).text(num(v, pct), inner.x + labelW + w + 4, y + bh / 2 - 5, { lineBreak: false }); });
    });
  } else if (kind === "vbar") {
    const base = inner.y + inner.h - 24, area = inner.h - 40, colW = inner.w / cats.length, bw = Math.min(44, (colW - 8) / S.length);
    doc.moveTo(inner.x, base).lineTo(inner.x + inner.w, base).strokeColor(c.grid).stroke();
    cats.forEach((cat, i) => {
      S.forEach((s, j) => { const v = s.values[i] ?? 0, h = (v / max) * area, x = inner.x + i * colW + (colW - bw * S.length) / 2 + j * bw;
        doc.rect(x, base - h, bw - 2, h).fill(c.palette[j % c.palette.length]);
        doc.fontSize(7.5).fillColor(c.text).text(num(v, pct), x - 6, base - h - 10, { width: bw + 12, align: "center", lineBreak: false }); });
      doc.fontSize(8).fillColor(c.subtle).text(cat.slice(0, colW < 50 ? 8 : 16), inner.x + i * colW, base + 4, { width: colW, align: "center", lineBreak: false });
    });
  } else if (kind === "stack") {
    const labelW = Math.min(170, inner.w * 0.35), rowH = inner.h / Math.min(cats.length, 12), bh = Math.min(20, rowH - 6), span = inner.w - labelW - 10;
    cats.slice(0, 12).forEach((cat, i) => {
      const vals = S.map((s) => Math.max(0, s.values[i] ?? 0)); const shares = stackShares(vals);
      const y = inner.y + i * rowH + (rowH - bh) / 2;
      doc.fontSize(8.5).fillColor(c.text).text(cat.slice(0, 34), inner.x, y + bh / 2 - 5, { width: labelW - 8, align: "right", lineBreak: false });
      let x = inner.x + labelW;
      shares.forEach((sh, j) => { const w = (sh / 100) * span; doc.rect(x, y, w, bh).fill(c.palette[j % c.palette.length]); if (w > 28) doc.fontSize(7.5).fillColor("#ffffff").text(num(vals[j], false, 0), x, y + bh / 2 - 4, { width: w, align: "center", lineBreak: false }); x += w; });
    });
  } else if (kind === "donut") {
    const vals = cats.map((_, i) => Math.max(0, S[0].values[i] ?? 0)); const tot = vals.reduce((a, b) => a + b, 0) || 1;
    const cx = inner.x + 110, cy = inner.y + inner.h / 2, R = Math.min(95, inner.h / 2 - 6), ri = R * 0.55;
    let a0 = -Math.PI / 2;
    vals.forEach((v, i) => { const a1 = a0 + (v / tot) * Math.PI * 2; if (v > 0) { doc.save(); doc.path(arcPath(cx, cy, R, ri, a0, a1)).fill(c.palette[i % c.palette.length]); doc.restore(); }
      doc.rect(inner.x + 240, inner.y + 8 + i * 20, 9, 9).fill(c.palette[i % c.palette.length]); doc.fontSize(8.5).fillColor(c.text).text(`${cats[i].slice(0, 30)} — ${num(v, pct)}`, inner.x + 254, inner.y + 7 + i * 20, { width: inner.w - 260, lineBreak: false }); a0 = a1; });
  } else if (kind === "line") {
    const pts = S[0].labels.slice(0, 40); const all = S.flatMap((s) => s.values.slice(0, 40)).filter((v): v is number => v != null);
    const lo = Math.min(0, ...all), hi = Math.max(1e-9, ...all), left = inner.x + 36, base = inner.y + inner.h - 22, topY = inner.y + 8, step = pts.length > 1 ? (inner.w - 50) / (pts.length - 1) : 0;
    const y = (v: number) => base - ((v - lo) / (hi - lo || 1)) * (base - topY);
    doc.moveTo(left, base).lineTo(left + (pts.length - 1) * step, base).strokeColor(c.grid).stroke();
    S.forEach((s, j) => { let started = false; s.values.slice(0, 40).forEach((v, i) => { if (v == null) return; const px = left + i * step, py = y(v); if (!started) { doc.moveTo(px, py); started = true; } else doc.lineTo(px, py); }); doc.lineWidth(2).strokeColor(c.palette[j % c.palette.length]).stroke(); s.values.slice(0, 40).forEach((v, i) => { if (v != null) doc.circle(left + i * step, y(v), 2.5).fill(c.palette[j % c.palette.length]); }); });
    pts.forEach((cat, i) => { if (pts.length <= 12 || i % Math.ceil(pts.length / 12) === 0) doc.fontSize(7.5).fillColor(c.subtle).text(cat.slice(0, 10), left + i * step - 20, base + 4, { width: 40, align: "center", lineBreak: false }); });
    doc.fontSize(7.5).fillColor(c.subtle).text(num(hi, pct), inner.x, y(hi) - 4, { lineBreak: false }).text(num(lo, pct), inner.x, y(lo) - 4, { lineBreak: false });
  }
  doc.restore();
}

function arcPath(cx: number, cy: number, R: number, ri: number, a0: number, a1: number): string {
  const end = Math.min(a1, a0 + Math.PI * 2 - 1e-4); const large = end - a0 > Math.PI ? 1 : 0;
  const p = (r: number, a: number) => `${(cx + r * Math.cos(a)).toFixed(2)} ${(cy + r * Math.sin(a)).toFixed(2)}`;
  return `M ${p(R, a0)} A ${R} ${R} 0 ${large} 1 ${p(R, end)} L ${p(ri, end)} A ${ri} ${ri} 0 ${large} 0 ${p(ri, a0)} Z`;
}

function heat(doc: PDFKit.PDFDocument, r: AnalysisResult, S: ReturnType<typeof seriesForChart>, box: Box, c: Colors, pct: boolean) {
  const m = r.chart.matrix ?? { rows: S[0].labels, columns: S.map((s) => s.name), values: S[0].labels.map((_, i) => S.map((s) => s.values[i])) };
  const rows = m.rows.slice(0, 16), cols = m.columns.slice(0, 10);
  const flat = m.values.flat().filter((v): v is number => v != null); const min = Math.min(...flat), max = Math.max(...flat);
  const labelW = Math.min(150, box.w * 0.3), top = 18, cw = (box.w - labelW) / cols.length, rh = Math.min(22, (box.h - top) / rows.length);
  cols.forEach((col, j) => doc.fontSize(7.5).fillColor(c.subtle).text(col.slice(0, 14), box.x + labelW + j * cw, box.y, { width: cw, align: "center", lineBreak: false }));
  rows.forEach((row, i) => {
    doc.fontSize(8).fillColor(c.text).text(row.slice(0, 30), box.x, box.y + top + i * rh + rh / 2 - 4, { width: labelW - 6, align: "right", lineBreak: false });
    cols.forEach((_, j) => { const v = m.values[i]?.[j]; const t = v == null || max === min ? 0 : (v - min) / (max - min); const [pr, pg, pb] = rgb(c.palette[0]);
      doc.rect(box.x + labelW + j * cw, box.y + top + i * rh, cw - 1, rh - 1).fill(mix([pr, pg, pb], 0.1 + t * 0.85));
      doc.fontSize(7.5).fillColor(t > 0.55 ? "#ffffff" : c.text).text(num(v, pct, 0), box.x + labelW + j * cw, box.y + top + i * rh + rh / 2 - 4, { width: cw - 1, align: "center", lineBreak: false }); });
  });
}

function scatter(doc: PDFKit.PDFDocument, pts: NonNullable<AnalysisResult["chart"]["points"]>, box: Box, c: Colors) {
  const xs = pts.map((p) => p.x), ys = pts.map((p) => p.y);
  const x0 = Math.min(...xs), x1 = Math.max(...xs), y0 = Math.min(...ys), y1 = Math.max(...ys);
  const left = box.x + 30, base = box.y + box.h - 18, topY = box.y + 6;
  const X = (x: number) => left + ((x - x0) / (x1 - x0 || 1)) * (box.w - 40), Y = (y: number) => base - ((y - y0) / (y1 - y0 || 1)) * (base - topY);
  doc.moveTo(left, base).lineTo(box.x + box.w, base).moveTo(left, topY).lineTo(left, base).strokeColor(c.grid).stroke();
  pts.slice(0, 2000).forEach((p) => doc.circle(X(p.x), Y(p.y), 2.2).fillOpacity(0.6).fill(c.palette[0]));
  doc.fillOpacity(1).fontSize(7.5).fillColor(c.subtle).text(num(x1, false), box.x + box.w - 40, base + 4, { width: 40, align: "right", lineBreak: false }).text(num(y1, false), box.x, topY, { lineBreak: false });
}

const rgb = (h: string): [number, number, number] => [parseInt(h.slice(1, 3), 16), parseInt(h.slice(3, 5), 16), parseInt(h.slice(5, 7), 16)];
const mix = ([r, g, b]: [number, number, number], a: number): string => `#${[r, g, b].map((v) => Math.round(v * a + 255 * (1 - a)).toString(16).padStart(2, "0")).join("")}`;

/* ------------------------------------------------------------ tables */

function drawTable(doc: PDFKit.PDFDocument, t: ResultTable, o: { x: number; w: number; ensure: (h: number) => void; text: string; subtle: string; grid: string; primary: string }) {
  const cols = t.columns.filter((c) => !/^__/.test(c.key)).slice(0, 9);
  const widths = cols.map((c, i) => (i === 0 ? Math.min(o.w * 0.34, 200) : (o.w - Math.min(o.w * 0.34, 200)) / Math.max(1, cols.length - 1)));
  const rowH = 16;
  const header = () => { o.ensure(rowH * 2); let x = o.x; const yy = doc.y; doc.rect(o.x, yy, o.w, rowH).fill("#f3f4f6"); cols.forEach((c, i) => { doc.fontSize(8).fillColor(o.text).font("Helvetica-Bold").text(String(c.label).slice(0, 40), x + 3, yy + 4, { width: widths[i] - 6, align: i === 0 ? "left" : "right", lineBreak: false }); x += widths[i]; }); doc.font("Helvetica"); doc.x = o.x; doc.y = yy + rowH; };
  header();
  for (const row of t.rows.slice(0, 400)) {
    if (doc.y + rowH > PAGE.h - PAGE.m - 24) { o.ensure(PAGE.h); header(); }
    let x = o.x; const yy = doc.y;
    const kind = row.__kind as string | undefined;
    if (kind === "group") doc.rect(o.x, yy, o.w, rowH).fill("#eef2ff");
    cols.forEach((c, i) => {
      const v = row[c.key]; const fmt = (row.__format as string | undefined) ?? c.type;
      const sig = typeof row[`${c.key}__sig`] === "string" && row[`${c.key}__sig`] ? ` ${row[`${c.key}__sig`]}` : "";
      const txt = typeof v === "number" ? `${num(v, fmt === "pct", c.decimals ?? (fmt === "count" ? 0 : 1))}${sig}` : String(v ?? "").slice(0, 60);
      doc.fontSize(8).fillColor(kind === "base" ? o.subtle : o.text).text(txt, x + 3, yy + 4, { width: widths[i] - 6, align: i === 0 ? "left" : "right", lineBreak: false });
      x += widths[i];
    });
    doc.moveTo(o.x, yy + rowH).lineTo(o.x + o.w, yy + rowH).strokeColor(o.grid).lineWidth(0.5).stroke();
    doc.x = o.x; doc.y = yy + rowH;
  }
  doc.x = o.x; doc.y += 4;
  if (t.rows.length > 400) doc.fontSize(8).fillColor(o.subtle).text(`${t.rows.length - 400} more rows in the spreadsheet export.`, o.x, doc.y, { width: o.w });
  if (t.base) doc.fontSize(8).fillColor(o.subtle).text(`Base: n = ${t.base.n.toLocaleString("en-US")}${t.base.label ? ` (${t.base.label})` : ""}`, o.x, doc.y, { width: o.w });
  for (const n of t.notes ?? []) doc.fontSize(8).fillColor(o.subtle).text(n, o.x, doc.y, { width: o.w });
  doc.moveDown(0.8);
}

/** a built PDF, checked: the header, the trailer, at least one page */
export function checkPdf(buf: Buffer): { ok: boolean; problems: string[] } {
  const problems: string[] = [];
  if (!buf || buf.length < 800) problems.push("the file is empty");
  else {
    if (buf.subarray(0, 5).toString("latin1") !== "%PDF-") problems.push("not a PDF header");
    const tail = buf.subarray(Math.max(0, buf.length - 1024)).toString("latin1");
    if (!/%%EOF\s*$/.test(tail)) problems.push("no %%EOF trailer");
    if (!/\/Type\s*\/Page[^s]/.test(buf.toString("latin1"))) problems.push("no page");
  }
  return { ok: !problems.length, problems };
}

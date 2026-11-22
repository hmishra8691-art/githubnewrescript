import { AlignmentType, BorderStyle, Document, Footer, HeadingLevel, ImageRun, Packer, PageBreak, PageNumber, Paragraph, ShadingType, Table, TableCell, TableRow, TextRun, WidthType } from "docx";
import type { AnalysisResult, ReportBlock, ReportDefinition, ReportTheme, ResultTable } from "../types.js";
import { DEFAULT_THEME } from "../types.js";
import { summaryAnalysisIds } from "../blockRefs.js";
import { executiveSummary } from "../summary.js";
import { methodologyBlock, methodologyLines } from "../reportPages.js";
import { expandPanels } from "../reportModel.js";
import { chartTitleFor, isEmbeddableImage, seriesForChart } from "./shared.js";

/**
 * A REPORT AS A WORD DOCUMENT (Level 5 roadmap R1). The same `ReportDefinition` the PowerPoint, PDF and Excel builders
 * read, rendered block by block: cover, sections (each starts a page), text, executive summary, insights, KPIs,
 * tables, charts, panel grids (headline then panels) and the methodology.
 *
 * Word has no chart the docx writer can make editable, so a chart is its DATA TABLE (categories × series, with the
 * base) — or, when the caller passes a picture the renderer already drew for that block (`images`, PNG / JPEG data
 * URIs, the same check as the deck), that picture above the data. Nothing about a chart is invented here.
 */
export interface ReportDocxInput {
  report: Pick<ReportDefinition, "title" | "subtitle" | "blocks" | "branding"> & { author?: string; date?: string };
  results: Record<string, AnalysisResult>;
  theme?: ReportTheme | null;
  meta?: { survey?: string; generatedBy?: string };
  /** text under a block, by block id — one entry per paragraph */
  notes?: Record<string, string[]>;
  images?: Record<string, string>;
  settings?: { include?: { charts?: boolean; tables?: boolean; methodology?: boolean } };
}

const hex = (c: string | undefined, d: string) => (c && /^#?[0-9a-f]{6}$/i.test(c) ? c.replace("#", "").toUpperCase() : d);
const num = (v: number | null | undefined, pct: boolean, d = 1) => (v == null || !Number.isFinite(v) ? "—" : `${v.toLocaleString("en-US", { maximumFractionDigits: d, minimumFractionDigits: 0 })}${pct ? "%" : ""}`);
const plain = (md: string) => md.replace(/[*_`>#]/g, "").trim();

export async function buildReportDocx(input: ReportDocxInput): Promise<Buffer> {
  const theme = input.theme ?? DEFAULT_THEME;
  const primary = hex(theme.colors.primary, "4F46E5"), text = hex(theme.colors.text, "131A2B"), subtle = hex(theme.colors.subtle, "6B7690");
  const font = (theme.fontFamily || "Calibri").split(",")[0].replace(/["']/g, "").trim() || "Calibri";
  const include = { charts: input.settings?.include?.charts ?? true, tables: input.settings?.include?.tables ?? true, methodology: input.settings?.include?.methodology ?? true };
  const out: (Paragraph | Table)[] = [];
  const p = (t: string, o: { size?: number; color?: string; bold?: boolean; italics?: boolean } = {}) => new Paragraph({ spacing: { after: 120 }, children: [new TextRun({ text: t, font, size: o.size ?? 22, color: o.color ?? text, bold: o.bold, italics: o.italics })] });
  const h = (t: string, level: 1 | 2 = 2) => new Paragraph({ heading: level === 1 ? HeadingLevel.HEADING_1 : HeadingLevel.HEADING_2, spacing: { before: 240, after: 120 }, children: [new TextRun({ text: t, font, color: level === 1 ? primary : text, bold: true, size: level === 1 ? 32 : 26 })] });
  const bullet = (t: string) => new Paragraph({ bullet: { level: 0 }, spacing: { after: 60 }, children: [new TextRun({ text: t, font, size: 22, color: text })] });
  const notesFor = (id: string) => { for (const n of input.notes?.[id] ?? []) out.push(p(n)); };
  const base = (r: AnalysisResult) => p(`n = ${r.base.n.toLocaleString("en-US")}${r.base.label ? ` · ${r.base.label}` : ""}`, { size: 18, color: subtle });

  /* the cover */
  const cover = input.report.blocks.find((b): b is Extract<ReportBlock, { type: "cover" }> => b.type === "cover");
  out.push(new Paragraph({ spacing: { before: 2400, after: 200 }, children: [new TextRun({ text: cover?.title ?? input.report.title, font, size: 56, bold: true, color: primary })] }));
  const sub = cover?.subtitle ?? input.report.subtitle;
  if (sub) out.push(p(sub, { size: 28, color: subtle }));
  const byline = [cover?.author ?? input.report.author, cover?.date ?? input.report.date].filter(Boolean).join(" · ");
  if (byline) out.push(p(byline, { size: 20, color: subtle }));
  out.push(new Paragraph({ children: [new PageBreak()] }));

  for (const block of expandPanels(input.report.blocks)) {
    switch (block.type) {
      case "cover": case "methodology": break;
      case "page_break": out.push(new Paragraph({ children: [new PageBreak()] })); break;
      case "section": {
        if (out.length > 4) out.push(new Paragraph({ children: [new PageBreak()] }));
        out.push(h(block.title, 1));
        if (block.subtitle) out.push(p(block.subtitle, { color: subtle }));
        break;
      }
      case "text": {
        if (block.title) out.push(h(block.title));
        for (const para of block.markdown.split(/\n{2,}/).map(plain).filter(Boolean)) {
          if (/^[-•]\s/.test(para)) for (const l of para.split(/\n/)) out.push(bullet(l.replace(/^[-•]\s*/, "")));
          else out.push(p(para));
        }
        break;
      }
      case "executive_summary": {
        out.push(h(block.title ?? "Executive summary", 1));
        if (block.text) out.push(p(block.text));
        const items = executiveSummary(summaryAnalysisIds(block, input.report).map((id) => ({ name: input.results[id]?.name ?? id, result: input.results[id] })).filter((x) => x.result));
        for (const it of items) out.push(bullet(`${it.analysis}: ${it.headline} (${it.base})`));
        if (!items.length && !block.text) out.push(p("No finding is available for the analyses this summary covers.", { color: subtle, italics: true }));
        break;
      }
      case "insights": {
        out.push(h(block.title ?? "Key insights"));
        const lines = summaryAnalysisIds(block, input.report).flatMap((id) => input.results[id]?.insights ?? []);
        for (const l of lines) out.push(bullet(l));
        if (!lines.length) out.push(p("No insight is available for these analyses.", { color: subtle, italics: true }));
        notesFor(block.id);
        break;
      }
      case "kpi": {
        const r = input.results[block.analysisId];
        out.push(h(block.title ?? r?.name ?? "KPI"));
        const k = r?.chart.kpis?.find((x) => !block.metric || x.label === block.metric) ?? r?.chart.kpis?.[0];
        if (!r || r.error || !k) { out.push(p(r?.error?.message ?? "This figure is not available.", { color: subtle, italics: true })); break; }
        out.push(new Paragraph({ spacing: { after: 60 }, children: [new TextRun({ text: `${typeof k.value === "number" ? num(k.value, false, 1) : k.value}${k.unit ?? ""}`, font, size: 56, bold: true, color: primary })] }));
        out.push(p(`${k.label} · n = ${r.base.n.toLocaleString("en-US")}`, { size: 18, color: subtle }));
        notesFor(block.id);
        break;
      }
      case "chart": {
        if (!include.charts) break;
        const r = input.results[block.analysisId];
        out.push(h(block.title ?? (r ? chartTitleFor(r, block.chart) : "Chart")));
        if (!r || r.error) { out.push(p(r?.error?.message ?? "This analysis is not available.", { color: subtle, italics: true })); break; }
        const img = input.images?.[block.id];
        const picture = img && isEmbeddableImage(img) ? pictureRun(img) : null;
        if (picture) out.push(new Paragraph({ alignment: AlignmentType.CENTER, children: [picture] }));
        const series = seriesForChart(r, block.chart);
        if (series.length) out.push(dataTable(series, { font, text, subtle, primary }));
        else if (!picture) out.push(p("This chart has no category data to tabulate; see the analysis in the Studio.", { color: subtle, italics: true }));
        out.push(base(r));
        if (block.caption) out.push(p(block.caption));
        notesFor(block.id);
        break;
      }
      case "table": {
        if (!include.tables) break;
        const r = input.results[block.analysisId];
        const t = r ? (block.tableId ? r.tables.find((x) => x.id === block.tableId) : undefined) ?? r.tables[0] : undefined;
        out.push(h(block.title ?? t?.title ?? r?.name ?? "Table"));
        if (!t) { out.push(p(r?.error?.message ?? "No table for this analysis.", { color: subtle, italics: true })); break; }
        out.push(resultTable(t, { font, text, subtle, primary }));
        if (t.base) out.push(p(`n = ${t.base.n.toLocaleString("en-US")}${t.base.label ? ` · ${t.base.label}` : ""}`, { size: 18, color: subtle }));
        for (const n of t.notes ?? []) out.push(p(n, { size: 18, color: subtle }));
        if (block.caption) out.push(p(block.caption));
        notesFor(block.id);
        break;
      }
    }
  }

  if (include.methodology) {
    const lines = methodologyLines(methodologyBlock(input.report.blocks), { survey: input.meta?.survey, generatedBy: input.meta?.generatedBy });
    if (lines.length) { out.push(new Paragraph({ children: [new PageBreak()] }), h("Methodology", 1)); for (const l of lines) out.push(bullet(l)); }
  }

  const footerText = input.report.branding?.footer ?? theme.footer ?? "";
  const doc = new Document({
    creator: input.report.author ?? input.meta?.generatedBy ?? "Rescript",
    title: input.report.title,
    styles: { default: { document: { run: { font, size: 22, color: text } } } },
    sections: [{
      footers: { default: new Footer({ children: [new Paragraph({ alignment: AlignmentType.CENTER, children: [new TextRun({ text: footerText ? `${footerText} · ` : "", font, size: 16, color: subtle }), new TextRun({ children: [PageNumber.CURRENT], font, size: 16, color: subtle })] })] }) },
      children: out,
    }],
  });
  return Buffer.from(await Packer.toBuffer(doc));
}

type Look = { font: string; text: string; subtle: string; primary: string };
const cell = (t: string, look: Look, o: { header?: boolean; right?: boolean; muted?: boolean } = {}) => new TableCell({
  shading: o.header ? { type: ShadingType.CLEAR, color: "auto", fill: "F3F4F6" } : undefined,
  children: [new Paragraph({ alignment: o.right ? AlignmentType.RIGHT : AlignmentType.LEFT, children: [new TextRun({ text: t, font: look.font, size: 18, bold: o.header, color: o.muted ? look.subtle : look.text })] })],
});
const borders = { top: { style: BorderStyle.SINGLE, size: 4, color: "D1D5DB" }, bottom: { style: BorderStyle.SINGLE, size: 4, color: "D1D5DB" }, left: { style: BorderStyle.NONE, size: 0, color: "FFFFFF" }, right: { style: BorderStyle.NONE, size: 0, color: "FFFFFF" }, insideHorizontal: { style: BorderStyle.SINGLE, size: 2, color: "E5E7EB" }, insideVertical: { style: BorderStyle.NONE, size: 0, color: "FFFFFF" } };

function resultTable(t: ResultTable, look: Look): Table {
  const cols = t.columns.filter((c) => !/^__/.test(c.key)).slice(0, 12);
  const rows = [new TableRow({ tableHeader: true, children: cols.map((c, i) => cell(String(c.label), look, { header: true, right: i > 0 })) })];
  for (const row of t.rows.slice(0, 500)) {
    rows.push(new TableRow({
      children: cols.map((c, i) => {
        const v = row[c.key]; const fmt = (row.__format as string | undefined) ?? c.type;
        const sig = typeof row[`${c.key}__sig`] === "string" && row[`${c.key}__sig`] ? ` ${row[`${c.key}__sig`]}` : "";
        return cell(typeof v === "number" ? `${num(v, fmt === "pct", c.decimals ?? (fmt === "count" ? 0 : 1))}${sig}` : String(v ?? ""), look, { right: i > 0, muted: row.__kind === "base" });
      }),
    }));
  }
  return new Table({ width: { size: 100, type: WidthType.PERCENTAGE }, borders, rows });
}

function dataTable(series: ReturnType<typeof seriesForChart>, look: Look): Table {
  const labels = series[0].labels;
  const rows = [new TableRow({ tableHeader: true, children: [cell("", look, { header: true }), ...series.slice(0, 10).map((s) => cell(s.name, look, { header: true, right: true }))] })];
  labels.slice(0, 60).forEach((l, i) => rows.push(new TableRow({ children: [cell(l, look), ...series.slice(0, 10).map((s) => cell(`${num(s.values[i], !!s.meta?.pct)}${s.sig?.[i] ? ` ${s.sig[i]}` : ""}`, look, { right: true }))] })));
  return new Table({ width: { size: 100, type: WidthType.PERCENTAGE }, borders, rows });
}

function pictureRun(uri: string): ImageRun | null {
  const m = /^data:image\/(png|jpe?g);base64,(.+)$/i.exec(uri);
  if (!m) return null;
  const data = Buffer.from(m[2], "base64");
  const size = imageSize(data, m[1].toLowerCase());
  if (!size) return null;
  const w = Math.min(600, size.w), hgt = Math.round(size.h * (w / size.w));
  return new ImageRun({ type: m[1].toLowerCase() === "png" ? "png" : "jpg", data, transformation: { width: w, height: hgt } });
}

/** pixel size from the PNG header or the first JPEG frame marker */
function imageSize(b: Buffer, kind: string): { w: number; h: number } | null {
  if (kind === "png") return b.length > 24 && b.readUInt32BE(12) === 0x49484452 ? { w: b.readUInt32BE(16), h: b.readUInt32BE(20) } : null;
  let i = 2;
  while (i + 9 < b.length) {
    if (b[i] !== 0xff) return null;
    const marker = b[i + 1], len = b.readUInt16BE(i + 2);
    if (marker >= 0xc0 && marker <= 0xc3) return { h: b.readUInt16BE(i + 5), w: b.readUInt16BE(i + 7) };
    i += 2 + len;
  }
  return null;
}

/**
 * THE STORY REPORT AS AN EDITABLE POWERPOINT.
 *
 * Built from the same composed pages as the video — the positions, sizes,
 * wrapped text and colours the layout engine settled on, at their final
 * state (the slide shows what the video's scene ends on). Nothing is a
 * picture of a slide: titles and bullets are text boxes, charts are native
 * PowerPoint charts carrying the frozen numbers (edit the data, the chart
 * follows), tables are native tables, cards and bands are shapes. The only
 * pictures are the logo and any image the report itself contains.
 *
 * Geometry: the 16:9 canvas is 1920 × 1080 px and the slide is 13.333 ×
 * 7.5 in, so 144 px is an inch and a px of type is half a point.
 */
import type { Block, ComposedPage } from "../story/index.js";
import type { Scene, StoryReport } from "../story/types.js";
import { formatValue, valueDomain } from "../story/charts.js";
import { mix } from "../story/design.js";
import { tableCellText } from "../story/layout.js";
import { PptxCtor, hex, type Slide } from "./pptx.js";

const PX = 144;
const inch = (px: number) => Math.round((px / PX) * 10000) / 10000;
const pt = (px: number) => Math.round(px * 0.5 * 10) / 10;

export interface StoryPptxInput {
  report: StoryReport;
  /** pages composed for the "pptx" target (16:9, main story and appendix) */
  pages: ComposedPage[];
  author?: string;
  /** the version this file was made from, written into the file's properties */
  version?: number;
}

/** the PowerPoint number format for a chart's values */
function numberFormat(fmt: string, decimals: number): string {
  const d = decimals > 0 ? `.${"0".repeat(decimals)}` : "";
  return fmt === "pct" ? `0${d}"%"` : `#,##0${d}`;
}

function notesFor(scene: Scene, report: StoryReport): string {
  const out: string[] = [];
  const said = scene.voiceover ?? scene.body;
  if (said) out.push(said);
  if (scene.visual.type === "chart" && scene.visual.recommendation) out.push(`Chart: ${scene.visual.recommendation.why}`);
  for (const s of scene.notes.sources) out.push(`Source: ${s.name}${s.runId ? ` (run ${s.runId})` : ""}`);
  if (scene.visual.type === "chart") out.push(`Base: n = ${scene.visual.data.base ?? "—"}${scene.visual.data.significanceTested ? "; significance tested at 95%" : "; descriptive, no significance test"}`);
  for (const f of scene.notes.footnotes) out.push(f);
  for (const c of scene.notes.caveats) out.push(`Caveat: ${c}`);
  out.push(`Report “${report.title}”, data computed ${report.createdFrom.computedAt.slice(0, 10)}, n = ${report.createdFrom.n}.`);
  return out.join("\n");
}

function addChart(pres: InstanceType<typeof PptxCtor>, slide: Slide, b: Extract<Block, { type: "chart" }>, page: ComposedPage, report: StoryReport) {
  const d = report.design;
  const data = b.data;
  const s = data.series.length;
  const ct = pres.ChartType;
  const type = b.chart === "line" ? ct.line : b.chart === "donut" ? ct.doughnut : ct.bar;
  const series = data.series.map((x) => ({ name: x.name, labels: data.categories, values: x.values.map((v) => (v == null ? null : v)) as number[] }));
  /* a highlighted category on a single series: the others as they end in the video (dimmed to 35%) */
  let colors = b.colors.map(hex);
  if (b.highlight?.length && s === 1 && (b.chart === "bar" || b.chart === "hbar")) colors = data.categories.map((c) => hex(b.highlight!.includes(c) ? d.colors.highlight : mix(b.colors[0], d.colors.background, 0.65)));
  else if (b.chart === "donut") colors = data.categories.map((_, i) => hex(d.colors.chart[i % d.colors.chart.length]));
  const dom = valueDomain(data, b.chart);
  const font = d.typography.body;
  const textC = hex(d.colors.text), mutedC = hex(d.colors.textMuted), gridC = hex(d.colors.grid);
  const fmt = numberFormat(data.valueFormat, b.decimals);
  const size = pt(b.labelSize);
  /* the plot area pinned where the layout put it, so annotations land on their bars */
  const layout = { x: (b.plot.x - b.box.x) / b.box.w, y: (b.plot.y - b.box.y) / b.box.h, w: b.plot.w / b.box.w, h: b.plot.h / b.box.h };
  const opts: Record<string, unknown> = {
    x: inch(b.box.x), y: inch(b.box.y), w: inch(b.box.w), h: inch(b.box.h),
    chartColors: colors, showLegend: b.legend && (s > 1 || b.chart === "donut"), legendPos: "b", legendFontFace: font, legendFontSize: size, legendColor: textC,
    showValue: b.showValues, dataLabelFormatCode: fmt, dataLabelFontFace: d.typography.numeric, dataLabelFontSize: size, dataLabelFontBold: true, dataLabelColor: textC,
    catAxisLabelFontFace: font, catAxisLabelFontSize: size, catAxisLabelColor: textC, valAxisLabelFontFace: font, valAxisLabelFontSize: size, valAxisLabelColor: mutedC,
    valGridLine: { color: gridC, size: 0.75 }, catGridLine: { style: "none" }, valAxisLabelFormatCode: fmt,
    altText: `${b.chart === "donut" ? "Donut" : b.chart === "line" ? "Line" : "Bar"} chart: ${data.categories.map((c, i) => `${c} ${data.series.map((x) => formatValue(x.values[i], data)).join(" / ")}`).join("; ")}. Base n = ${data.base ?? "—"}.`,
  };
  if (b.chart !== "donut") Object.assign(opts, { layout, valAxisMinVal: dom.min, valAxisMaxVal: dom.max, barGapWidthPct: 60 });
  if (b.chart === "bar" || b.chart === "grouped_bar" || b.chart === "hbar" || b.chart === "stacked_100") {
    Object.assign(opts, { barDir: b.orientation === "horizontal" ? "bar" : "col", barGrouping: b.chart === "stacked_100" ? "percentStacked" : "clustered", dataLabelPosition: b.chart === "stacked_100" ? "ctr" : "outEnd" });
    /* horizontal bars read top to bottom in the same order as the video */
    if (b.orientation === "horizontal") Object.assign(opts, { catAxisOrientation: "maxMin", valAxisHidden: b.showValues, valGridLine: b.showValues ? { style: "none" } : { color: gridC, size: 0.75 } });
    if (b.chart === "stacked_100") Object.assign(opts, { dataLabelColor: "FFFFFF", valAxisMaxVal: 1, valAxisMinVal: 0, valAxisLabelFormatCode: "0%" });
  }
  if (b.chart === "line") Object.assign(opts, { lineSize: 3, lineDataSymbol: "circle", lineDataSymbolSize: 8, dataLabelPosition: "t" });
  if (b.chart === "donut") Object.assign(opts, { holeSize: 58, showPercent: false, showValue: true, dataLabelColor: "FFFFFF", showLeaderLines: false, legendPos: "r" });
  slide.addChart(type, series, opts as never);

  /* significance letters beside the native value labels, where the layout placed them */
  if (data.significanceTested) {
    for (const e of page.elements) {
      if (e.kind !== "text" || e.role !== "value" || !e.meta || e.meta.series === undefined || e.meta.cat === undefined) continue;
      const letter = data.series[e.meta.series]?.sig?.[e.meta.cat];
      if (!letter) continue;
      const lw = e.size * 0.62 * (letter.length + 1);
      const x = e.align === "center" ? e.box.x + e.box.w / 2 + e.size * 1.6 : e.box.x + e.size * 3.2;
      slide.addText(letter, { x: inch(x), y: inch(e.box.y), w: inch(lw + 8), h: inch(e.size * 1.3), fontFace: d.typography.numeric, fontSize: pt(e.size * 0.8), bold: true, color: hex(d.colors.accent), margin: 0, valign: "middle", altText: `significantly higher than column ${letter}` } as never);
    }
  }
}

function addTableBlock(slide: Slide, b: Extract<Block, { type: "table" }>, family: string) {
  const header = b.columns.map((c) => ({ text: c.label, options: { bold: true, color: hex(b.headerText), fill: { color: hex(b.headerBg) }, align: c.numeric ? "right" : "left" } }));
  const rows = b.rows.map((r, ri) => {
    const hl = b.columns.some((c) => typeof r[c.key] === "string" && !!b.highlight?.includes(String(r[c.key])));
    return b.columns.map((c, ci) => ({ text: tableCellText(r, c), options: { color: hex(b.text), bold: hl && ci === 0, align: c.numeric ? "right" : "left", ...(ri % 2 === 1 || hl ? { fill: { color: hex(b.zebra) } } : {}) } }));
  });
  slide.addTable([header, ...rows] as never, {
    x: inch(b.box.x), y: inch(b.box.y), w: inch(b.widths.reduce((a, w) => a + w, 0)), colW: b.widths.map(inch),
    rowH: [inch(b.rowHeight * 1.15), ...b.rows.map(() => inch(b.rowHeight))], fontFace: family, fontSize: pt(b.size), valign: "middle",
    border: { type: "solid", pt: 0.5, color: hex(b.grid) }, margin: [0.02, inch(8), 0.02, inch(8)], autoPage: false,
  } as never);
}

/** Build the PowerPoint from composed pages. Every slide is native and editable. */
export async function buildStoryPptx(input: StoryPptxInput): Promise<Buffer> {
  const { report, pages } = input;
  const pres = new PptxCtor();
  pres.layout = "LAYOUT_WIDE";
  pres.title = report.title;
  pres.subject = report.subtitle ?? "Research report";
  pres.author = input.author ?? "Rescript";
  pres.company = report.design.name ?? "Rescript";
  if (input.version) pres.revision = String(input.version);
  for (const page of pages) {
    const scene = report.scenes[page.sceneIndex];
    const slide = pres.addSlide();
    for (const b of page.blocks) {
      switch (b.type) {
        case "background": slide.background = { color: hex(b.color) }; break;
        case "band": slide.addShape(pres.ShapeType.rect, { x: inch(b.box.x), y: inch(b.box.y), w: inch(b.box.w), h: inch(b.box.h), fill: { color: hex(b.color) }, line: { type: "none" } } as never); break;
        case "shape": {
          const rounded = (b.radius ?? 0) > 0;
          slide.addShape(rounded ? pres.ShapeType.roundRect : pres.ShapeType.rect, { x: inch(b.box.x), y: inch(b.box.y), w: inch(b.box.w), h: inch(b.box.h), fill: { color: hex(b.color) }, line: { type: "none" }, ...(rounded ? { rectRadius: inch(b.radius!) } : {}) } as never);
          break;
        }
        case "text": {
          const base = { fontFace: b.family, fontSize: pt(b.size), bold: b.weight >= 600, color: hex(b.color), align: b.align, lineSpacing: pt(b.size * b.lineHeight), ...(b.tracking ? { charSpacing: pt(b.tracking) } : {}) };
          /* a little slack on the width: PowerPoint's own wrapping should never break a line the layout did not */
          const box = { x: inch(b.box.x), y: inch(b.box.y), w: inch(b.box.w + Math.max(6, b.size * 0.3)), h: inch(b.box.h + b.size * 0.2), margin: 0, valign: "top", fit: "none", wrap: true };
          if (b.bullets) slide.addText(b.lines.map((l, k) => ({ text: l, options: { bullet: { indent: pt(b.size * 1.1) }, paraSpaceAfter: pt(b.size * 0.45), breakLine: k < b.lines.length - 1 } })) as never, { ...box, ...base } as never);
          else slide.addText(b.text, { ...box, ...base } as never);
          break;
        }
        case "image": slide.addImage({ data: b.href, x: inch(b.box.x), y: inch(b.box.y), w: inch(b.box.w), h: inch(b.box.h), sizing: { type: "contain", w: inch(b.box.w), h: inch(b.box.h) }, altText: "logo" } as never); break;
        case "chart": addChart(pres, slide, b, page, report); break;
        case "table": addTableBlock(slide, b, report.design.typography.body); break;
      }
    }
    slide.addNotes(notesFor(scene, report));
  }
  return (await pres.write({ outputType: "nodebuffer" })) as Buffer;
}

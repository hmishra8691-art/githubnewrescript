/**
 * IS THE POWERPOINT WHAT THE REPORT SAYS IT IS?
 *
 * Read back from the file itself (the zip and its XML), not from the plan:
 * one slide per composed page; every shape inside the slide; no two text
 * boxes overlapping; charts are native chart parts (editable) whose cached
 * numbers equal the report's frozen values; tables are native tables; the
 * only pictures are the report's own images (no slide is a screenshot);
 * fonts are the report's; every slide has speaker notes; the page numbers
 * run in order.
 */
import { inflateRawSync } from "node:zlib";
import type { Block, ComposedPage, StoryReport } from "@rescript/analytics/story";

export interface PptxCheck { code: string; severity: "critical" | "warning"; slide?: number; message: string }
export interface PptxQa { ok: boolean; slides: number; charts: number; tables: number; pictures: number; textBoxes: number; fonts: string[]; valuesChecked: number; checks: PptxCheck[] }

/** the entries of a zip, by its central directory */
export function unzip(buf: Buffer): Map<string, Buffer> {
  const out = new Map<string, Buffer>();
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 70000); i--) if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  if (eocd < 0) throw new Error("not a zip file");
  let p = buf.readUInt32LE(eocd + 16);
  while (p + 46 <= buf.length && buf.readUInt32LE(p) === 0x02014b50) {
    const method = buf.readUInt16LE(p + 10), comp = buf.readUInt32LE(p + 20), nameLen = buf.readUInt16LE(p + 28), extraLen = buf.readUInt16LE(p + 30), commentLen = buf.readUInt16LE(p + 32), local = buf.readUInt32LE(p + 42);
    const name = buf.subarray(p + 46, p + 46 + nameLen).toString("utf8");
    p += 46 + nameLen + extraLen + commentLen;
    const ln = buf.readUInt16LE(local + 26), le = buf.readUInt16LE(local + 28);
    const data = buf.subarray(local + 30 + ln + le, local + 30 + ln + le + comp);
    out.set(name, method === 8 ? inflateRawSync(data) : Buffer.from(data));
  }
  return out;
}

const EMU = 914400;
interface Shape { kind: "sp" | "graphicFrame" | "pic"; x: number; y: number; w: number; h: number; text: string; hasText: boolean }

function shapesOf(xml: string): Shape[] {
  const out: Shape[] = [];
  const re = /<p:(sp|graphicFrame|pic)>([\s\S]*?)<\/p:\1>/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(xml))) {
    const body = m[2];
    const off = /<a:off x="(-?\d+)" y="(-?\d+)"\/>/.exec(body), ext = /<a:ext cx="(\d+)" cy="(\d+)"\/>/.exec(body);
    if (!off || !ext) continue;
    const text = [...body.matchAll(/<a:t>([^<]*)<\/a:t>/g)].map((x) => x[1]).join(" ").trim();
    out.push({ kind: m[1] as Shape["kind"], x: Number(off[1]) / EMU, y: Number(off[2]) / EMU, w: Number(ext[1]) / EMU, h: Number(ext[2]) / EMU, text, hasText: m[1] === "sp" && text.length > 0 });
  }
  return out;
}

const decode = (s: string) => s.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, "\"").replace(/&apos;/g, "'").replace(/&amp;/g, "&");

export function inspectStoryPptx(buf: Buffer, report: StoryReport, pages: ComposedPage[]): PptxQa {
  const zip = unzip(buf);
  const checks: PptxCheck[] = [];
  const crit = (code: string, message: string, slide?: number) => checks.push({ code, severity: "critical", message, ...(slide ? { slide } : {}) });
  const warn = (code: string, message: string, slide?: number) => checks.push({ code, severity: "warning", message, ...(slide ? { slide } : {}) });
  const pres = zip.get("ppt/presentation.xml")?.toString("utf8") ?? "";
  const size = /<p:sldSz cx="(\d+)" cy="(\d+)"/.exec(pres);
  const W = size ? Number(size[1]) / EMU : 13.333, H = size ? Number(size[2]) / EMU : 7.5;
  const slideNames = [...zip.keys()].filter((k) => /^ppt\/slides\/slide\d+\.xml$/.test(k)).sort((a, b) => Number(/(\d+)\.xml/.exec(a)![1]) - Number(/(\d+)\.xml/.exec(b)![1]));
  if (slideNames.length !== pages.length) crit("slide_count", `${slideNames.length} slides, ${pages.length} pages composed`);
  let charts = 0, tables = 0, pictures = 0, textBoxes = 0, valuesChecked = 0;
  const fonts = new Set<string>();
  const allowed = new Set([report.design.typography.heading, report.design.typography.body, report.design.typography.numeric]);
  slideNames.forEach((name, i) => {
    const n = i + 1;
    const xml = zip.get(name)!.toString("utf8");
    const rels = zip.get(name.replace("slides/", "slides/_rels/") + ".rels")?.toString("utf8") ?? "";
    const page = pages[i];
    const shapes = shapesOf(xml);
    for (const s of shapes) {
      if (s.x < -0.01 || s.y < -0.01 || s.x + s.w > W + 0.02 || s.y + s.h > H + 0.02) crit("out_of_bounds", `a ${s.kind === "sp" ? "shape" : s.kind} (“${s.text.slice(0, 40)}”) extends outside the slide`, n);
    }
    const texts = shapes.filter((s) => s.hasText);
    textBoxes += texts.length;
    /* overlapping text boxes: shrink each by its slack (the exporter adds a little width) before comparing */
    for (let a = 0; a < texts.length; a++) for (let b = a + 1; b < texts.length; b++) {
      const A = texts[a], B = texts[b];
      const ix = Math.min(A.x + A.w * 0.97, B.x + B.w * 0.97) - Math.max(A.x, B.x);
      const iy = Math.min(A.y + A.h * 0.85, B.y + B.h * 0.85) - Math.max(A.y, B.y);
      if (ix > 0.02 && iy > 0.02) crit("text_overlap", `text “${A.text.slice(0, 30)}” overlaps “${B.text.slice(0, 30)}”`, n);
    }
    for (const f of xml.matchAll(/<a:latin typeface="([^"]+)"/g)) fonts.add(decode(f[1]));
    const tbl = (xml.match(/<a:tbl>/g) ?? []).length; tables += tbl;
    const pics = (xml.match(/<p:pic>/g) ?? []).length; pictures += pics;
    const expectedImages = page?.blocks.filter((b) => b.type === "image").length ?? 0;
    if (pics > expectedImages) crit("picture_slide", `slide ${n} has ${pics} pictures where the report has ${expectedImages} — charts and text must be native, not images`, n);
    const chartBlocks = (page?.blocks.filter((b) => b.type === "chart") ?? []) as Extract<Block, { type: "chart" }>[];
    const chartRels = [...rels.matchAll(/Target="(?:\.\.)?\/(?:ppt\/)?charts\/(chart\d+\.xml)"/g)].map((x) => x[1]);
    charts += chartRels.length;
    if (chartRels.length !== chartBlocks.length) crit("chart_missing", `slide ${n}: ${chartRels.length} native charts, ${chartBlocks.length} expected`, n);
    chartRels.forEach((c, k) => {
      const cx = zip.get(`ppt/charts/${c}`)?.toString("utf8") ?? "";
      const block = chartBlocks[k];
      if (!block) return;
      const sers = [...cx.matchAll(/<c:ser>([\s\S]*?)<\/c:ser>/g)].map((x) => x[1]);
      if (sers.length !== block.data.series.length) { crit("chart_series", `slide ${n}: chart has ${sers.length} series, the report ${block.data.series.length}`, n); return; }
      sers.forEach((ser, si) => {
        const val = /<c:val>([\s\S]*?)<\/c:val>/.exec(ser)?.[1] ?? "";
        const pts = new Map([...val.matchAll(/<c:pt idx="(\d+)">\s*<c:v>([^<]*)<\/c:v>/g)].map((x) => [Number(x[1]), x[2]]));
        block.data.series[si].values.forEach((v, ci) => {
          const got = pts.get(ci);
          valuesChecked++;
          if (v == null) { if (got !== undefined && got !== "") crit("chart_value", `slide ${n}: “${block.data.categories[ci]}” is missing in the data but ${got} in the chart`, n); return; }
          if (got === undefined || Math.abs(Number(got) - v) > 1e-9) crit("chart_value", `slide ${n}: “${block.data.categories[ci]}” is ${v} in the report and ${got ?? "absent"} in the chart`, n);
        });
        const cats = [...(/<c:cat>([\s\S]*?)<\/c:cat>/.exec(ser)?.[1] ?? "").matchAll(/<c:v>([^<]*)<\/c:v>/g)].map((x) => decode(x[1]));
        if (cats.join("|") !== block.data.categories.join("|")) crit("chart_categories", `slide ${n}: chart categories differ from the report's`, n);
      });
      if (block.chart !== "donut" && block.chart !== "line" && !/<c:barChart>/.test(cx)) crit("chart_type", `slide ${n}: expected a bar chart`, n);
      if (block.chart === "donut" && !/<c:doughnutChart>/.test(cx)) crit("chart_type", `slide ${n}: expected a doughnut chart`, n);
      if (block.chart === "line" && !/<c:lineChart>/.test(cx)) crit("chart_type", `slide ${n}: expected a line chart`, n);
      const minV = /<c:valAx>[\s\S]*?<c:min val="(-?[\d.]+)"/.exec(cx)?.[1];
      if ((block.chart === "bar" || block.chart === "hbar" || block.chart === "grouped_bar") && minV !== undefined && Number(minV) > 0) crit("axis_not_zero", `slide ${n}: the bar chart's axis starts at ${minV}`, n);
    });
    /* every bullet is its own paragraph, every text block's words are on the slide */
    const paras = new Set([...xml.matchAll(/<a:p>([\s\S]*?)<\/a:p>/g)].map((p) => decode([...p[1].matchAll(/<a:t>([^<]*)<\/a:t>/g)].map((x) => x[1]).join("")).trim()));
    const slideText = decode([...xml.matchAll(/<a:t>([^<]*)<\/a:t>/g)].map((x) => x[1]).join(" "));
    for (const b of page?.blocks ?? []) {
      if (b.type !== "text") continue;
      if (b.bullets) { for (const item of b.lines) if (!paras.has(item.trim())) crit("bullet_merged", `slide ${n}: the point “${item.slice(0, 40)}” is not its own paragraph`, n); }
      else if (!slideText.replace(/\s+/g, " ").includes(b.text.replace(/\s+/g, " ").trim())) crit("text_missing", `slide ${n}: “${b.text.slice(0, 40)}” is missing`, n);
    }
    const tableBlocks = page?.blocks.filter((b) => b.type === "table").length ?? 0;
    if (tbl !== tableBlocks) crit("table_missing", `slide ${n}: ${tbl} native tables, ${tableBlocks} expected`, n);
    /* notes */
    const notesRel = /Target="(?:\.\.)?\/(?:ppt\/)?notesSlides\/(notesSlide\d+\.xml)"/.exec(rels)?.[1];
    const notes = notesRel ? zip.get(`ppt/notesSlides/${notesRel}`)?.toString("utf8") ?? "" : "";
    if (!/<a:t>[^<]{3,}/.test(notes)) warn("no_notes", `slide ${n} has no speaker notes`, n);
    /* page numbers, when the design shows them on this slide */
    if (report.design.footer.pageNumbers && i > 0) {
      const pn = new RegExp(`>${n} / ${slideNames.length}<`);
      if (!pn.test(xml)) warn("page_number", `slide ${n} does not show “${n} / ${slideNames.length}”`, n);
    }
  });
  for (const f of fonts) if (!allowed.has(f as never)) warn("font", `the font “${f}” is not one of the report's fonts`);
  if ([...fonts].length) warn("fonts_installed", `the PowerPoint uses ${[...fonts].join(", ")} (free, open-licence fonts); PowerPoint substitutes a similar font where they are not installed — install them from the report's font files for an exact match`);
  return { ok: !checks.some((c) => c.severity === "critical"), slides: slideNames.length, charts, tables, pictures, textBoxes, fonts: [...fonts], valuesChecked, checks };
}

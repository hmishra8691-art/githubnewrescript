/**
 * THE SCENE LAYOUT ENGINE — one scene, one design, one canvas → positioned
 * elements (what the video frames draw), semantic blocks (what the
 * PowerPoint builder places, in the same boxes) and the animation schedule.
 *
 * Every size is in px on a canvas whose short side is 1080 (1920×1080,
 * 1080×1920, 1080×1080); output resolutions scale it. Text is measured with
 * the report's font files and wrapped, shrunk to a role's minimum size, and
 * otherwise reported — never cut. Charts are drawn from the frozen numbers:
 * bars from zero, labels formatted from the value they sit on, significance
 * letters only where a test produced them.
 *
 * `LayoutOptions` carries the repairs the quality engine may ask for
 * (horizontal bars for long labels, labels on two or three lines, the
 * decoration or the logo moved out of the way). A repair never changes a
 * number or drops a word.
 */
import type { AspectRatio, DesignConfig, FontFamilyId, FrozenChartData, FrozenTable, Scene, StoryChartType, StoryReport } from "./types.js";
import { contrast, ensureContrast, isDark, mix } from "./design.js";
import { displayDecimals } from "./charts.js";
import { formatValue, valueDomain } from "./charts.js";
import { fitText, type Measurer } from "./measure.js";

/* ------------------------------------------------------------ geometry */

export interface Box { x: number; y: number; w: number; h: number }
export const canvasFor = (aspect: AspectRatio) => (aspect === "9:16" ? { w: 1080, h: 1920 } : aspect === "1:1" ? { w: 1080, h: 1080 } : { w: 1920, h: 1080 });
export const overlap = (a: Box, b: Box) => Math.max(0, Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x)) * Math.max(0, Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y));

/* ------------------------------------------------------------ elements */

export interface Anim {
  /** seconds from the start of the scene */
  start: number;
  dur: number;
  type: "fade" | "rise" | "slide" | "grow_up" | "grow_right" | "reveal" | "sweep" | "count" | "dim";
  /** grow: the zero baseline (y for up, x for right); rise: distance; dim: the opacity it ends at; count: the value counted to */
  param?: number;
}

export type TextRole = "kicker" | "title" | "subtitle" | "body" | "bullet" | "label" | "value" | "axis" | "legend" | "footer" | "source" | "stat" | "cell" | "header" | "badge" | "kpi_value" | "kpi_label" | "fact_label" | "fact_value";
export const MIN_SIZE: Record<TextRole, number> = { kicker: 16, title: 36, subtitle: 22, body: 22, bullet: 22, label: 16, value: 16, axis: 15, legend: 16, footer: 15, source: 15, stat: 60, cell: 16, header: 16, badge: 16, kpi_value: 40, kpi_label: 18, fact_label: 15, fact_value: 20 };

export type El =
  | { kind: "rect"; id: string; box: Box; fill: string; radius?: number; opacity?: number; role: "background" | "band" | "card" | "bar" | "rule" | "swatch" | "badge" | "decor" | "row" | "header_row" | "grid"; anim?: Anim[]; meta?: { series?: number; cat?: number; value?: number | null; highlight?: boolean } }
  | { kind: "text"; id: string; box: Box; lines: string[]; family: FontFamilyId; weight: number; size: number; color: string; align: "left" | "center" | "right"; lineHeight: number; tracking?: number; role: TextRole; fits: boolean; text: string; anim?: Anim[]; over?: string; meta?: { value?: number | null; series?: number; cat?: number } }
  | { kind: "line"; id: string; points: [number, number][]; stroke: string; width: number; role: "series" | "grid" | "axis" | "rule"; dash?: number[]; anim?: Anim[]; box: Box }
  | { kind: "circle"; id: string; cx: number; cy: number; r: number; fill: string; role: "marker" | "bullet" | "decor"; anim?: Anim[]; box: Box }
  | { kind: "arc"; id: string; cx: number; cy: number; r0: number; r1: number; a0: number; a1: number; fill: string; role: "slice"; anim?: Anim[]; box: Box; meta?: { cat?: number; value?: number | null } }
  | { kind: "image"; id: string; box: Box; href: string; role: "logo"; anim?: Anim[] };

/** what the PowerPoint builder places — the same boxes, as editable objects */
export type Block =
  | { type: "background"; color: string }
  | { type: "band"; box: Box; color: string }
  | { type: "text"; role: TextRole; box: Box; text: string; lines: string[]; size: number; family: FontFamilyId; weight: number; color: string; align: "left" | "center" | "right"; lineHeight: number; tracking?: number; bullets?: boolean }
  | { type: "shape"; box: Box; color: string; radius?: number; role: string }
  | { type: "chart"; box: Box; plot: Box; chart: StoryChartType; orientation: "vertical" | "horizontal"; data: FrozenChartData; colors: string[]; showValues: boolean; decimals: number; labelSize: number; legend: boolean; highlight?: string[] }
  | { type: "table"; box: Box; columns: FrozenTable["columns"]; rows: FrozenTable["rows"]; widths: number[]; rowHeight: number; size: number; headerBg: string; headerText: string; text: string; grid: string; zebra: string; highlight?: string[] }
  | { type: "image"; box: Box; href: string };

/** a table cell as printed — the same text in the frame, the slide and the check */
export function tableCellText(r: Record<string, string | number | null>, c: FrozenTable["columns"][number]): string { const v = r[c.key]; if (v == null) return "—"; if (typeof v === "number" && (r.__format === "count" || r.__format === "integer")) return Math.round(v).toLocaleString("en-US"); if (typeof v === "number") return `${v.toLocaleString("en-US", { minimumFractionDigits: c.decimals ?? 0, maximumFractionDigits: c.decimals ?? (c.pct ? 1 : 2) })}${c.pct ? "%" : ""}`; return v; }

export interface LayoutIssue { code: string; severity: "critical" | "warning"; element?: string; message: string; repair?: keyof LayoutOptions }

export interface LaidOutScene {
  sceneId: string;
  page: number;
  canvas: { w: number; h: number };
  background: string;
  elements: El[];
  blocks: Block[];
  issues: LayoutIssue[];
  /** when every entrance has finished, in seconds */
  settleAt: number;
  /** words a viewer has to read, and numbers, for the hold time */
  reading: { words: number; numbers: number };
  /** appendix tables: rows that did not fit on this page (the next page starts there) */
  tableRemaining?: number;
}

export interface LayoutOptions {
  /** draw vertical bars horizontally (long category labels) */
  horizontalBars?: boolean;
  /** category labels may wrap to three lines instead of two */
  labelLines?: 2 | 3;
  /** move the logo to the other corner */
  logoAlt?: boolean;
  /** drop decorative shapes (never content) */
  noDecor?: boolean;
  /** a narrower text column, a wider visual */
  wideVisual?: boolean;
  /** appendix tables: the first row on this page */
  rowOffset?: number;
}

export interface LayoutContext {
  design: DesignConfig;
  measure: Measurer;
  /** the canvas; PowerPoint is always 16:9 */
  aspect: AspectRatio;
  /** page number of this scene */
  page: number;
  /** total pages, for "n / N" */
  pages: number;
  report: Pick<StoryReport, "title">;
  options?: LayoutOptions;
}

/* ------------------------------------------------------------ timing */

interface Motion { rise: number; k: number; stagger: number; on: boolean; fadeIn: boolean; slide: boolean }
function motionOf(d: DesignConfig, scene: Scene): Motion {
  const style = d.motion.style;
  const transition = scene.motion.transition === "inherit" ? d.motion.transition : scene.motion.transition;
  const k = 1 / d.motion.speed * (style === "expressive" ? 1.15 : style === "subtle" ? 0.8 : 1);
  return { rise: style === "expressive" ? 40 : style === "standard" ? 24 : 0, k, stagger: style === "expressive" ? 0.08 : 0.05, on: style !== "none" && scene.motion.enter !== "none", fadeIn: transition !== "cut" && style !== "none", slide: transition === "slide" && style !== "none" };
}

/* ------------------------------------------------------------ the engine */

let uid = 0;
const nid = (p: string) => `${p}${++uid}`;

export function layoutScene(scene: Scene, ctx: LayoutContext): LaidOutScene {
  uid = 0;
  const d = ctx.design, m = ctx.measure, o = ctx.options ?? {};
  const C = canvasFor(ctx.aspect);
  const portrait = C.h > C.w, square = C.h === C.w;
  const sc = d.typography.scale;
  const M = (portrait || square ? { airy: 84, balanced: 72, dense: 60 } : { airy: 124, balanced: 104, dense: 84 })[d.density];
  const gap = d.density === "dense" ? 28 : d.density === "airy" ? 48 : 36;
  const col = d.colors;
  /* brand colours used as TEXT are darkened or lightened just enough to read (4.5:1); as marks they stay as given */
  const inkPrimary = ensureContrast(col.primary, col.background, 4.5), inkPrimaryOnSurface = ensureContrast(col.primary, col.surface, 4.5);
  const els: El[] = [];
  const blocks: Block[] = [];
  const issues: LayoutIssue[] = [];
  const mo = motionOf(d, scene);
  const A = (start: number, dur: number, type: Anim["type"], param?: number): Anim[] => (mo.on ? [{ start: start * mo.k, dur: dur * mo.k, type, ...(param !== undefined ? { param } : {}) }] : []);
  const enter = (start: number): Anim[] => (mo.on ? [...A(start, 0.5, "fade"), ...(mo.rise && scene.motion.enter === "rise" ? A(start, 0.55, "rise", mo.rise) : [])] : []);
  let settle = 0;
  const track = (anims?: Anim[]) => { for (const a of anims ?? []) settle = Math.max(settle, a.start + a.dur); };
  const reading = { words: 0, numbers: 0 };
  let tableRemaining: number | undefined;
  const count = (t: string) => { reading.words += t.split(/\s+/).filter(Boolean).length; reading.numbers += (t.match(/\d+(\.\d+)?%?/g) ?? []).length; };

  /* text placement: fit, emit an element and a block */
  const text = (role: TextRole, s: string, box: Box, opt: { size: number; family?: FontFamilyId; weight?: number; color?: string; align?: "left" | "center" | "right"; lineHeight?: number; maxLines?: number; tracking?: number; anim?: Anim[]; over?: string; block?: boolean; valign?: "top" | "middle" | "bottom"; meta?: { value?: number | null; series?: number; cat?: number }; minSize?: number }): Extract<El, { kind: "text" }> => {
    const family = opt.family ?? d.typography.body;
    const weight = opt.weight ?? 400;
    const lh = opt.lineHeight ?? (role === "title" || role === "stat" || role === "kpi_value" ? 1.12 : 1.32);
    const f = fitText(m, s, { family, weight, size: opt.size, minSize: Math.min(opt.size, opt.minSize ?? MIN_SIZE[role]), maxWidth: box.w, maxHeight: box.h, lineHeight: lh, maxLines: opt.maxLines, tracking: opt.tracking });
    const used = f.lines.length * f.size * lh;
    const y = opt.valign === "middle" ? box.y + Math.max(0, (box.h - used) / 2) : opt.valign === "bottom" ? box.y + Math.max(0, box.h - used) : box.y;
    const el: Extract<El, { kind: "text" }> = { kind: "text", id: nid(role), box: { x: box.x, y, w: box.w, h: used }, lines: f.lines, family, weight, size: f.size, color: opt.color ?? col.text, align: opt.align ?? "left", lineHeight: lh, ...(opt.tracking ? { tracking: opt.tracking } : {}), role, fits: f.fits, text: s, ...(opt.anim?.length ? { anim: opt.anim } : {}), ...(opt.over ? { over: opt.over } : {}), ...(opt.meta ? { meta: opt.meta } : {}) };
    if (!f.fits) issues.push({ code: "text_overflow", severity: "critical", element: el.id, message: `${role} text does not fit its area even at ${f.size}px: “${s.slice(0, 80)}${s.length > 80 ? "…" : ""}”` });
    else if (f.shrunk && role !== "label" && role !== "value") issues.push({ code: "text_shrunk", severity: "warning", element: el.id, message: `${role} text was set at ${f.size}px instead of ${opt.size}px to fit` });
    els.push(el); track(opt.anim);
    if (opt.block !== false) blocks.push({ type: "text", role, box: el.box, text: s, lines: f.lines, size: f.size, family, weight, color: el.color, align: el.align, lineHeight: lh, ...(opt.tracking ? { tracking: opt.tracking } : {}) });
    if (["title", "subtitle", "body", "bullet", "kpi_label", "fact_value", "stat"].includes(role)) count(s);
    return el;
  };
  const rect = (role: Extract<El, { kind: "rect" }>["role"], box: Box, fill: string, extra: Partial<Extract<El, { kind: "rect" }>> = {}, block = true) => {
    const el: El = { kind: "rect", id: nid(role), box, fill, role, ...extra };
    els.push(el); track(extra.anim);
    if (block && role !== "bar" && role !== "swatch" && role !== "grid") blocks.push({ type: "shape", box, color: fill, ...(extra.radius ? { radius: extra.radius } : {}), role });
    return el;
  };

  /* ---------------------------------------------------- background, decoration, header */
  blocks.push({ type: "background", color: col.background });
  els.push({ kind: "rect", id: "bg", box: { x: 0, y: 0, w: C.w, h: C.h }, fill: col.background, role: "background" });

  const isCover = scene.layout === "title" || scene.layout === "closing";
  if (d.imagery === "geometric" && !o.noDecor) {
    /* quiet geometry in the corner the text never uses; removed by repair if anything overlaps it */
    const r = isCover ? Math.round(C.h * 0.36) : Math.round(Math.min(C.w, C.h) * 0.12);
    const cx = C.w - (isCover ? r * 0.55 : r * 0.35), cy = isCover ? C.h * 0.5 : r * 0.35;
    els.push({ kind: "circle", id: "decor1", cx, cy, r, fill: mix(col.background, col.primary, isDark(col.background) ? 0.16 : 0.07), role: "decor", box: { x: cx - r, y: cy - r, w: 2 * r, h: 2 * r }, anim: A(0, 0.8, "fade") });
    els.push({ kind: "circle", id: "decor2", cx: cx - r * 0.45, cy: cy + r * 0.35, r: r * 0.45, fill: mix(col.background, col.accent, isDark(col.background) ? 0.14 : 0.06), role: "decor", box: { x: cx - r * 0.9, y: cy - r * 0.1, w: r * 0.9, h: r * 0.9 }, anim: A(0.1, 0.8, "fade") });
  }

  const contentW = C.w - 2 * M;
  let top = M * 0.75;
  const footerH = 30;
  const footerY = C.h - M * 0.5 - footerH;
  const headingFamily = d.typography.heading;
  const onBand = d.titleStyle === "band" && !isCover;
  const bandText = onBand ? (contrast("#FFFFFF", col.primary) >= 4.5 ? "#FFFFFF" : "#111111") : col.text;

  /* ---------------------------------------------------- footer and sources (laid out first: the content fills what is left) */
  const footerEls: El[] = [];
  const logoBox = (): Box | null => {
    if (!d.logo || !d.footer.showLogo) return null;
    const hMax = isCover ? 96 : 54, wMax = isCover ? 320 : 200;
    const ratio = d.logo.width / Math.max(1, d.logo.height);
    let w = Math.min(wMax, hMax * ratio), h = w / ratio;
    if (h > hMax) { h = hMax; w = h * ratio; }
    const placement = o.logoAlt ? (d.logo.placement === "bottom_left" ? "bottom_right" : d.logo.placement === "bottom_right" ? "top_right" : "bottom_right") : d.logo.placement;
    if (isCover) return { x: M, y: M * 0.7, w, h };
    if (placement === "top_right") return { x: C.w - M - w, y: M * 0.6, w, h };
    if (placement === "bottom_left") return { x: M, y: footerY + footerH - h, w, h };
    return { x: C.w - M - w, y: footerY + footerH - h, w, h };
  };
  const lb = logoBox();
  if (lb && d.logo) { els.push({ kind: "image", id: "logo", box: lb, href: d.logo.dataUri, role: "logo", anim: A(0.1, 0.5, "fade") }); blocks.push({ type: "image", box: lb, href: d.logo.dataUri }); }
  if (!isCover) {
    const pageW = d.footer.pageNumbers ? 120 : 0;
    const rightReserve = lb && lb.y > C.h / 2 && lb.x > C.w / 2 ? lb.w + 24 : 0;
    const leftReserve = lb && lb.y > C.h / 2 && lb.x < C.w / 2 ? lb.w + 24 : 0;
    const footerText = d.footer.text || ctx.report.title;
    if (footerText) footerEls.push(text("footer", footerText, { x: M + leftReserve, y: footerY, w: contentW - pageW - rightReserve - leftReserve - 24, h: footerH }, { size: sc.caption, color: col.textMuted, maxLines: 1, anim: A(0.2, 0.4, "fade") }));
    if (d.footer.pageNumbers) footerEls.push(text("footer", `${ctx.page} / ${ctx.pages}`, { x: C.w - M - pageW - rightReserve, y: footerY, w: pageW, h: footerH }, { size: sc.caption, color: col.textMuted, align: "right", maxLines: 1, anim: A(0.2, 0.4, "fade") }));
  }
  /* sources and notes, above the footer */
  let bottom = isCover ? C.h - M : footerY - 16;
  if (!isCover && d.footer.sources) {
    const lines: string[] = [];
    const v = scene.visual;
    const base = v.type === "chart" ? v.data.base : v.type === "table" ? v.table.base : null;
    const srcNames = [...new Set(scene.notes.sources.map((s) => s.name))].slice(0, 2);
    if (srcNames.length || base != null) lines.push([srcNames.length ? `Source: ${srcNames.join("; ")}` : "", base != null ? `Base: n = ${base.toLocaleString()}` : "", v.type === "chart" ? `Values: ${v.data.measure}` : ""].filter(Boolean).join(" · "));
    if (v.type === "chart" && v.data.significanceTested && v.data.series.some((s) => s.sig?.some(Boolean))) lines.push("Letters mark a value significantly higher than the column with that letter (95% confidence).");
    for (const f of scene.notes.footnotes.slice(0, 2)) lines.push(f);
    for (const c of scene.notes.caveats.slice(0, 2)) lines.push(`Note: ${c}`);
    if (lines.length) {
      const h = Math.min(lines.length * sc.caption * 1.35 + 4, 140);
      const t = text("source", lines.join("\n"), { x: M, y: bottom - h, w: contentW, h }, { size: sc.caption, color: col.textMuted, lineHeight: 1.3, anim: A(0.3, 0.4, "fade"), valign: "bottom" });
      bottom = t.box.y - 14;
    }
  }

  /* ---------------------------------------------------- header */
  let headerBottom = top;
  if (!isCover) {
    const logoTop = lb && lb.y < C.h / 2 ? lb : null;
    const headW = contentW - (logoTop ? logoTop.w + 32 : 0) - (portrait ? 0 : 0);
    let y = top;
    if (onBand) {
      /* the band is sized after the title is fitted, below */
    }
    const kickerText = scene.kicker ? scene.kicker.toUpperCase() : "";
    if (kickerText && d.titleStyle !== "centered") {
      const k = text("kicker", kickerText, { x: M + (d.titleStyle === "left_rule" ? 28 : 0), y: y + (onBand ? 18 : 0), w: headW, h: sc.caption * 1.4 }, { size: sc.caption, weight: 700, color: onBand ? bandText : inkPrimary, tracking: 2.5, maxLines: 1, anim: enter(0.05), over: onBand ? "band" : undefined });
      y = k.box.y + k.box.h + 10;
    }
    const titleBox = { x: M + (d.titleStyle === "left_rule" ? 28 : 0), y, w: headW - (d.titleStyle === "left_rule" ? 28 : 0), h: sc.title * 1.12 * (portrait ? 3 : 2) };
    const t = text("title", scene.title, titleBox, { size: sc.title, family: headingFamily, weight: d.typography.headingWeight, color: onBand ? bandText : col.text, maxLines: portrait ? 3 : 2, align: d.titleStyle === "centered" ? "center" : "left", anim: enter(0.15), over: onBand ? "band" : undefined });
    if (d.titleStyle === "left_rule") rect("rule", { x: M, y: (kickerText ? top : t.box.y) + 4, w: 8, h: t.box.y + t.box.h - (kickerText ? top : t.box.y) - 8 }, col.primary, { anim: A(0.05, 0.5, "grow_up", t.box.y + t.box.h) });
    headerBottom = t.box.y + t.box.h;
    if (scene.subtitle) { const st = text("subtitle", scene.subtitle, { x: titleBox.x, y: headerBottom + 10, w: titleBox.w, h: sc.headline * 2.8 }, { size: Math.round(sc.headline * 0.8), color: onBand ? bandText : col.textMuted, maxLines: 2, anim: enter(0.25), over: onBand ? "band" : undefined }); headerBottom = st.box.y + st.box.h; }
    if (onBand) {
      const band: Box = { x: 0, y: 0, w: C.w, h: headerBottom + 28 };
      els.splice(1, 0, { kind: "rect", id: "band", box: band, fill: col.primary, role: "band", anim: A(0, 0.4, "fade") });
      blocks.splice(1, 0, { type: "band", box: band, color: col.primary });
      headerBottom = band.h;
    }
    top = headerBottom + gap;
  }

  const area: Box = { x: M, y: top, w: contentW, h: Math.max(80, bottom - top) };
  if (!isCover && area.h < 160) issues.push({ code: "no_room", severity: "critical", message: `the content area is only ${Math.round(area.h)}px tall after the title and notes — shorten the title or the notes` });

  /* ---------------------------------------------------- content */
  const v = scene.visual;
  const evidenceBadge = (box: Box): number => {
    if (!scene.evidence) return box.y;
    const words: Record<string, string> = { significant: "Statistically significant", not_significant: "Not statistically significant", descriptive: "Descriptive", mixed: "Mixed: does not hold after correction", exploratory: "Exploratory, beyond the plan" };
    const label = words[scene.evidence];
    const fill = scene.evidence === "significant" ? col.accent : scene.evidence === "not_significant" || scene.evidence === "mixed" ? col.textMuted : mix(col.textMuted, col.background, 0.25);
    const tc = contrast("#FFFFFF", fill) >= 4.5 ? "#FFFFFF" : "#111111";
    const size = sc.caption;
    const w = Math.min(box.w, m.width(label, d.typography.body, 700, size) + 36);
    const b: Box = { x: box.x, y: box.y, w, h: size * 1.9 };
    rect("badge", b, fill, { radius: b.h / 2, anim: enter(0.35) });
    text("badge", label, { x: b.x + 18, y: b.y + (b.h - size * 1.3) / 2, w: w - 36, h: size * 1.3 }, { size, weight: 700, color: tc, maxLines: 1, anim: enter(0.35), over: "badge" });
    return b.y + b.h + 22;
  };

  const bullets = (items: string[], box: Box, startAt = 0.45) => {
    if (!items.length) return;
    let size = sc.body;
    const lh = 1.34;
    /* one size for every bullet: shrink together until all fit */
    for (; size >= MIN_SIZE.bullet; size -= 2) {
      const gapB = size * 0.7;
      const total = items.reduce((a, it) => a + fitText(m, it, { family: d.typography.body, weight: 400, size, minSize: size, maxWidth: box.w - size * 1.4, maxHeight: 99999, lineHeight: lh }).lines.length * size * lh + gapB, 0) - gapB;
      if (total <= box.h) break;
    }
    size = Math.max(size, MIN_SIZE.bullet);
    let y = box.y;
    items.forEach((it, i) => {
      const dot = size * 0.32;
      const anim = enter(startAt + i * 0.16);
      const t = text("bullet", it, { x: box.x + size * 1.4, y, w: box.w - size * 1.4, h: Math.max(size * lh, box.y + box.h - y) }, { size, minSize: size, anim, lineHeight: lh, block: false });
      els.push({ kind: "circle", id: nid("dot"), cx: box.x + dot + 2, cy: y + size * lh / 2, r: dot, fill: col.primary, role: "bullet", box: { x: box.x + 2, y: y + size * lh / 2 - dot, w: dot * 2, h: dot * 2 }, anim });
      y = t.box.y + t.box.h + size * 0.7;
    });
    blocks.push({ type: "text", role: "bullet", box: { ...box, h: y - box.y }, text: items.join("\n"), lines: items, size, family: d.typography.body, weight: 400, color: col.text, align: "left", lineHeight: lh, bullets: true });
    if (y - size * 0.7 > box.y + box.h + 1) issues.push({ code: "text_overflow", severity: "critical", message: `the bullet list needs ${Math.round(y - box.y)}px but has ${Math.round(box.h)}px even at ${size}px` });
  };

  switch (scene.layout) {
    case "title": case "closing": {
      const w = portrait ? contentW : Math.min(contentW * 0.68, 1240);
      const lbH = lb ? lb.h + 48 : 0;
      const y0 = M + lbH;
      if (scene.kicker) text("kicker", scene.kicker.toUpperCase(), { x: M, y: y0, w, h: sc.caption * 1.5 }, { size: sc.caption + 2, weight: 700, color: inkPrimary, tracking: 3, maxLines: 1, anim: enter(0.1) });
      const tY = y0 + (scene.kicker ? sc.caption * 1.5 + 18 : 0);
      const tt = text("title", scene.title, { x: M, y: tY, w, h: C.h - tY - M - 180 }, { size: scene.layout === "closing" ? sc.title + 6 : sc.display, family: headingFamily, weight: 700, maxLines: portrait ? 6 : 4, anim: enter(0.25), lineHeight: 1.08 });
      rect("rule", { x: M, y: tt.box.y + tt.box.h + 30, w: 120, h: 8 }, col.accent, { anim: A(0.6, 0.5, "grow_right", M) });
      if (scene.subtitle) text("subtitle", scene.subtitle, { x: M, y: tt.box.y + tt.box.h + 64, w, h: sc.headline * 3 }, { size: Math.round(sc.headline * 0.82), color: col.textMuted, maxLines: 3, anim: enter(0.55) });
      if (scene.body) text("body", scene.body, { x: M, y: C.h - M - sc.body * 3, w, h: sc.body * 2.8 }, { size: sc.body, color: col.textMuted, maxLines: 2, anim: enter(0.7) });
      break;
    }
    case "text": {
      const items = v.type === "bullets" ? v.items : [];
      let y = area.y;
      if (scene.body) { const b = text("body", scene.body, { x: area.x, y, w: Math.min(area.w, 1500), h: sc.body * 4.2 }, { size: sc.body + 2, color: col.textMuted, maxLines: 3, anim: enter(0.35) }); y = b.box.y + b.box.h + gap * 0.7; }
      bullets(items, { x: area.x, y, w: Math.min(area.w, portrait ? area.w : 1540), h: area.y + area.h - y });
      break;
    }
    case "facts": {
      const items = v.type === "facts" ? v.items : [];
      const cols = portrait ? 1 : 2;
      const rows = Math.ceil(items.length / cols);
      const cw = (area.w - (cols - 1) * gap) / cols, ch = Math.min(170, (area.h - (rows - 1) * 18) / Math.max(1, rows));
      items.forEach((it, i) => {
        const cx = area.x + (i % cols) * (cw + gap), cy = area.y + Math.floor(i / cols) * (ch + 18);
        const anim = enter(0.35 + i * 0.1);
        rect("card", { x: cx, y: cy, w: cw, h: ch }, col.surface, { radius: 14, anim });
        const l = text("fact_label", it.label.toUpperCase(), { x: cx + 26, y: cy + 18, w: cw - 52, h: sc.caption * 1.4 }, { size: sc.caption, weight: 700, color: col.textMuted, tracking: 1.5, maxLines: 1, anim, over: "card" });
        text("fact_value", it.value, { x: cx + 26, y: l.box.y + l.box.h + 8, w: cw - 52, h: ch - (l.box.y + l.box.h + 8 - cy) - 14 }, { size: sc.body, color: col.text, anim, over: "card" });
      });
      break;
    }
    case "kpi_row": {
      const items = v.type === "kpis" ? v.items : [];
      const cols = portrait ? Math.min(2, items.length) : Math.min(4, items.length);
      const rows = Math.ceil(items.length / Math.max(1, cols));
      const cw = (area.w - (cols - 1) * gap) / Math.max(1, cols), ch = Math.min(360, (area.h - (rows - 1) * gap) / Math.max(1, rows));
      items.forEach((it, i) => {
        const cx = area.x + (i % cols) * (cw + gap), cy = area.y + Math.floor(i / cols) * (ch + gap);
        const anim = enter(0.4 + i * 0.12);
        rect("card", { x: cx, y: cy, w: cw, h: ch }, col.surface, { radius: 16, anim });
        const vt = text("kpi_value", it.value, { x: cx + 28, y: cy + 26, w: cw - 56, h: sc.stat * 0.62 }, { size: Math.round(sc.stat * 0.5), family: d.typography.numeric, weight: 700, color: inkPrimaryOnSurface, maxLines: 1, anim, over: "card" });
        const lt = text("kpi_label", it.label, { x: cx + 28, y: vt.box.y + vt.box.h + 10, w: cw - 56, h: sc.body * 2.8 }, { size: sc.body - 4, weight: 700, maxLines: 2, anim, over: "card" });
        if (it.detail) text("body", it.detail, { x: cx + 28, y: lt.box.y + lt.box.h + 8, w: cw - 56, h: cy + ch - (lt.box.y + lt.box.h + 8) - 18 }, { size: sc.caption, color: col.textMuted, anim, over: "card" });
        reading.numbers++;
      });
      break;
    }
    case "stat_center": {
      if (v.type !== "stat") break;
      const sv = text("stat", v.value, { x: area.x, y: area.y + area.h * 0.08, w: area.w, h: sc.stat * 1.2 }, { size: sc.stat, family: d.typography.numeric, weight: 700, color: inkPrimary, align: "center", maxLines: 1, anim: [...enter(0.3), ...(mo.on ? A(0.3, 0.8, "count") : [])] });
      const sl = text("subtitle", v.label, { x: area.x + area.w * 0.1, y: sv.box.y + sv.box.h + 18, w: area.w * 0.8, h: sc.headline * 2.6 }, { size: sc.headline, weight: 700, align: "center", maxLines: 2, anim: enter(0.6) });
      text("body", v.detail, { x: area.x + area.w * 0.1, y: sl.box.y + sl.box.h + 14, w: area.w * 0.8, h: sc.body * 2.8 }, { size: sc.body, color: col.textMuted, align: "center", maxLines: 2, anim: enter(0.75) });
      if (scene.body) text("body", scene.body, { x: area.x + area.w * 0.1, y: area.y + area.h - sc.body * 2.8, w: area.w * 0.8, h: sc.body * 2.7 }, { size: sc.body - 2, color: col.textMuted, align: "center", maxLines: 2, anim: enter(0.9) });
      break;
    }
    case "verdicts": {
      const items = v.type === "verdicts" ? v.items : [];
      const rowH = Math.min(176 * (portrait ? 1.9 : square ? 1.4 : 1) * Math.max(1, sc.body / 30), (area.h - (items.length - 1) * 14) / Math.max(1, items.length));
      const vfill: Record<string, string> = { supported: col.positive, not_supported: col.negative, mixed: col.accent, inconclusive: col.textMuted, untested: mix(col.textMuted, col.background, 0.3) };
      const vword: Record<string, string> = { supported: "Supported", not_supported: "Not supported", mixed: "Mixed", inconclusive: "Inconclusive", untested: "Untested" };
      const badgeW = 250;
      items.forEach((it, i) => {
        const y = area.y + i * (rowH + 14);
        const anim = enter(0.4 + i * 0.18);
        rect("card", { x: area.x, y, w: area.w, h: rowH }, col.surface, { radius: 14, anim });
        const fill = vfill[it.verdict];
        const tc = contrast("#FFFFFF", fill) >= 4.5 ? "#FFFFFF" : "#111111";
        const bh = sc.caption * 2.1;
        rect("badge", { x: area.x + 22, y: y + 22, w: badgeW, h: bh }, fill, { radius: bh / 2, anim });
        text("badge", vword[it.verdict], { x: area.x + 22, y: y + 22 + (bh - sc.caption * 1.32) / 2, w: badgeW, h: sc.caption * 1.32 }, { size: sc.caption + 1, weight: 700, color: tc, align: "center", maxLines: 1, anim, over: "badge" });
        const tx = area.x + 22 + badgeW + 28, tw = area.w - (tx - area.x) - 24;
        const tt = text("body", `${it.label} — ${it.text}`, { x: tx, y: y + 18, w: tw, h: Math.max(sc.body * 1.4, rowH * 0.5) }, { size: sc.body - 2, weight: 700, maxLines: 2, anim, over: "card" });
        text("label", it.reason, { x: tx, y: tt.box.y + tt.box.h + 6, w: tw, h: y + rowH - (tt.box.y + tt.box.h + 6) - 12 }, { size: sc.caption + 1, color: col.textMuted, anim, over: "card" });
      });
      break;
    }
    case "visual_right": case "visual_full": case "table": {
      const stacked = portrait || square || scene.layout !== "visual_right" || v.type === "table";
      let visualBox: Box;
      if (stacked) {
        let y = area.y;
        if (scene.layout !== "table" || scene.body) {
          y = evidenceBadge({ x: area.x, y, w: area.w, h: 60 });
          if (scene.body) { const b = text("body", scene.body, { x: area.x, y, w: area.w, h: sc.body * (portrait ? 5.6 : 2.8) }, { size: sc.body, maxLines: portrait ? 4 : 2, anim: enter(0.45) }); y = b.box.y + b.box.h + gap * 0.7; }
        }
        visualBox = { x: area.x, y, w: area.w, h: area.y + area.h - y };
      } else {
        const textW = Math.round(area.w * (o.wideVisual ? 0.28 : 0.34));
        let y = evidenceBadge({ x: area.x, y: area.y, w: textW, h: 60 });
        if (scene.body) text("body", scene.body, { x: area.x, y, w: textW, h: area.y + area.h - y }, { size: sc.body, anim: enter(0.45) });
        visualBox = { x: area.x + textW + gap * 1.4, y: area.y, w: area.w - textW - gap * 1.4, h: area.h };
      }
      if (v.type === "chart") chartLayout(v.chart, v.data, visualBox, v.highlight);
      else if (v.type === "table") tableLayout(v.table, visualBox, scene.section === "appendix");
      else if (v.type === "bullets") bullets(v.items, visualBox, 0.6);
      break;
    }
  }

  /* ---------------------------------------------------- charts */
  function chartLayout(type: StoryChartType, data: FrozenChartData, box: Box, highlight?: string[]) {
    const s = data.series.length, n = data.categories.length;
    const labelSize = sc.label;
    const colors = data.series.map((_, i) => d.colors.chart[i % d.colors.chart.length]);
    const showValues = d.dataLabels.show;
    const dec = displayDecimals(data, d.dataLabels.decimals);
    const fmt = (v: number | null) => formatValue(v, data, dec);
    const start = 0.75;
    let y = box.y;
    /* legend */
    const legend = s > 1 || type === "donut";
    if (legend && type !== "donut") {
      let lx = box.x, ly = y;
      const items = data.series.map((ser, i) => ({ name: ser.name + (data.seriesBases?.[i] != null ? ` (n=${data.seriesBases[i]})` : ""), i }));
      for (const it of items) {
        const w = m.width(it.name, d.typography.body, 400, labelSize) + labelSize * 1.6 + 26;
        if (lx + w > box.x + box.w && lx > box.x) { lx = box.x; ly += labelSize * 1.6; }
        const anim = A(start - 0.2, 0.4, "fade");
        rect("swatch", { x: lx, y: ly + labelSize * 0.2, w: labelSize, h: labelSize }, colors[it.i], { radius: 3, anim });
        text("legend", it.name, { x: lx + labelSize * 1.5, y: ly, w: w - labelSize * 1.5, h: labelSize * 1.45 }, { size: labelSize, color: col.textMuted, maxLines: 1, anim, block: false });
        lx += w;
      }
      y = ly + labelSize * 1.9;
    }
    /* the measure, above the plot */
    const mt = text("axis", data.measure.charAt(0).toUpperCase() + data.measure.slice(1), { x: box.x, y, w: box.w, h: labelSize * 1.3 }, { size: labelSize - 2, color: col.textMuted, maxLines: 1, anim: A(start - 0.2, 0.4, "fade"), block: false });
    y = mt.box.y + mt.box.h + 10;
    const plotBox: Box = { x: box.x, y, w: box.w, h: box.y + box.h - y };
    if (plotBox.h < 140) issues.push({ code: "chart_too_small", severity: "critical", message: `the chart has only ${Math.round(plotBox.h)}px of height — shorten the text around it` });
    const dom = valueDomain(data, type);
    const vertical = (type === "bar" && !o.horizontalBars) || (type === "grouped_bar" && !o.horizontalBars && n * s <= 14 && !data.categories.some((c) => c.length > 22));
    const isHighlighted = (cat: string) => !!highlight?.includes(cat);
    const dimAfter = start + 0.9 + Math.min(n * s, 12) * mo.stagger + 0.3;
    let plot: Box = plotBox;

    if (type === "donut") {
      const ser = data.series[0];
      const total = ser.values.reduce<number>((a, v) => a + Math.max(0, v ?? 0), 0) || 1;
      const r = Math.min(plotBox.h, plotBox.w * 0.5) / 2 - 6;
      const cx = plotBox.x + r + 6, cy = plotBox.y + plotBox.h / 2;
      let a = -Math.PI / 2;
      ser.values.forEach((v, i) => {
        const sweep = (Math.max(0, v ?? 0) / total) * Math.PI * 2;
        els.push({ kind: "arc", id: nid("slice"), cx, cy, r0: r * 0.58, r1: r, a0: a, a1: a + sweep, fill: d.colors.chart[i % d.colors.chart.length], role: "slice", box: { x: cx - r, y: cy - r, w: 2 * r, h: 2 * r }, anim: A(start, 1.0, "sweep"), meta: { cat: i, value: v } });
        a += sweep;
      });
      track(A(start, 1.0, "sweep"));
      const lx = cx + r + 48, lw = plotBox.x + plotBox.w - lx;
      const rowH = Math.min(labelSize * 2.6, plotBox.h / n);
      data.categories.forEach((c, i) => {
        const ly = plotBox.y + (plotBox.h - rowH * n) / 2 + i * rowH;
        const anim = A(start + 0.3 + i * 0.08, 0.4, "fade");
        rect("swatch", { x: lx, y: ly + rowH / 2 - labelSize * 0.5, w: labelSize, h: labelSize }, d.colors.chart[i % d.colors.chart.length], { radius: 3, anim });
        const vw = m.width(fmt(ser.values[i]), d.typography.numeric, 700, labelSize + 4) + 8;
        text("legend", c, { x: lx + labelSize * 1.6, y: ly + (rowH - labelSize * 1.35) / 2, w: lw - labelSize * 1.6 - vw - 12, h: labelSize * 1.35 }, { size: labelSize, maxLines: 1, anim, block: false });
        text("value", fmt(ser.values[i]), { x: lx + lw - vw, y: ly + (rowH - (labelSize + 4) * 1.35) / 2, w: vw, h: (labelSize + 4) * 1.35 }, { size: labelSize + 4, family: d.typography.numeric, weight: 700, align: "right", maxLines: 1, anim, block: false, meta: { value: ser.values[i], series: 0, cat: i } });
        reading.numbers++;
      });
      plot = { x: cx - r, y: cy - r, w: 2 * r, h: 2 * r };
      blocks.push({ type: "chart", box, plot, chart: type, orientation: "vertical", data, colors: d.colors.chart.slice(0, n), showValues, decimals: dec, labelSize, legend: true, ...(highlight ? { highlight } : {}) });
      return;
    }

    if (vertical) {
      /* value axis on the left */
      const ticks = [0, 0.25, 0.5, 0.75, 1].map((t) => dom.min + t * (dom.max - dom.min));
      const tickW = Math.max(...ticks.map((t) => m.width(formatValue(t, data, data.valueFormat === "mean" ? 1 : 0), d.typography.body, 400, labelSize - 2))) + 12;
      const labelLines = o.labelLines ?? 2;
      const catH = (labelSize * 1.3) * labelLines + 10;
      const valueH = showValues ? labelSize * 1.5 : 0;
      plot = { x: plotBox.x + tickW, y: plotBox.y + valueH, w: plotBox.w - tickW, h: plotBox.h - catH - valueH };
      const yOf = (v: number) => plot.y + plot.h - ((v - dom.min) / (dom.max - dom.min || 1)) * plot.h;
      for (const t of ticks) {
        const yy = yOf(t);
        els.push({ kind: "line", id: nid("grid"), points: [[plot.x, yy], [plot.x + plot.w, yy]], stroke: t === 0 ? mix(col.grid, col.text, 0.35) : col.grid, width: t === 0 ? 2 : 1, role: t === 0 ? "axis" : "grid", box: { x: plot.x, y: yy - 1, w: plot.w, h: 2 }, anim: A(start - 0.3, 0.4, "fade") });
        text("axis", formatValue(t, data, data.valueFormat === "mean" ? 1 : 0), { x: plotBox.x, y: yy - labelSize * 0.7, w: tickW - 10, h: labelSize * 1.3 }, { size: labelSize - 2, color: col.textMuted, align: "right", maxLines: 1, anim: A(start - 0.3, 0.4, "fade"), block: false });
      }
      const band = plot.w / n, groupW = band * (s > 1 ? 0.82 : 0.62), barW = groupW / s;
      data.categories.forEach((cat, ci) => {
        const gx = plot.x + ci * band + (band - groupW) / 2;
        data.series.forEach((ser, si) => {
          const v = ser.values[ci];
          const x = gx + si * barW + (s > 1 ? 2 : 0), w = barW - (s > 1 ? 4 : 0);
          const y0 = yOf(0), y1 = v == null ? y0 : yOf(v);
          const hl = isHighlighted(cat);
          const anim = [...A(start + (ci * s + si) * mo.stagger, 0.9, "grow_up", y0), ...(highlight?.length && s === 1 && !hl ? A(dimAfter, 0.45, "dim", 0.35) : [])];
          rect("bar", { x, y: Math.min(y0, y1), w, h: Math.max(v == null ? 0 : 1, Math.abs(y1 - y0)) }, hl ? col.highlight : colors[si], { radius: Math.min(6, w / 4), anim, meta: { series: si, cat: ci, value: v, highlight: hl } });
          if (showValues) {
            const sig = data.significanceTested ? (ser.sig?.[ci] ?? "") : "";
            const label = v == null ? "—" : fmt(v);
            const lw = m.width(label + (sig ? ` ${sig}` : ""), d.typography.numeric, 700, labelSize);
            const avail = band / s - 2;
            const t = text("value", sig ? `${label} ${sig}` : label, { x: x + w / 2 - Math.max(avail, lw) / 2, y: (v != null && v < 0 ? y0 : Math.min(y0, y1)) - labelSize * 1.4, w: Math.max(avail, lw), h: labelSize * 1.3 }, { size: labelSize, family: d.typography.numeric, weight: 700, align: "center", maxLines: 1, anim: A(start + 0.6 + (ci * s + si) * mo.stagger, 0.4, "fade"), block: false, meta: { value: v, series: si, cat: ci } });
            if (lw > avail + 0.5) issues.push({ code: "value_label_collision", severity: "critical", element: t.id, message: `the value label “${label}” is wider than its bar (${Math.round(lw)} > ${Math.round(avail)}px)`, repair: "horizontalBars" });
            reading.numbers++;
          }
        });
        const ct = text("label", cat, { x: plot.x + ci * band + 4, y: plot.y + plot.h + 10, w: band - 8, h: catH - 10 }, { size: labelSize, maxLines: labelLines, align: "center", color: col.text, anim: A(start - 0.1, 0.4, "fade"), block: false, minSize: MIN_SIZE.label });
        if (!ct.fits) { issues.pop(); issues.push({ code: "category_label_collision", severity: "critical", element: ct.id, message: `the category label “${cat}” does not fit under its bar`, repair: o.labelLines === 3 ? "horizontalBars" : "labelLines" }); }
      });
      track(A(start + Math.min(n * s, 30) * mo.stagger, 0.9, "grow_up"));
      if (highlight?.length && s === 1) track(A(dimAfter, 0.45, "dim"));
      blocks.push({ type: "chart", box, plot, chart: type === "grouped_bar" ? "grouped_bar" : "bar", orientation: "vertical", data, colors, showValues, decimals: dec, labelSize, legend: s > 1, ...(highlight ? { highlight } : {}) });
      return;
    }

    if (type === "line") {
      const ticks = [0, 0.25, 0.5, 0.75, 1].map((t) => dom.min + t * (dom.max - dom.min));
      const tickW = Math.max(...ticks.map((t) => m.width(formatValue(t, data, 0), d.typography.body, 400, labelSize - 2))) + 12;
      const catH = labelSize * 2.8;
      plot = { x: plotBox.x + tickW, y: plotBox.y + labelSize * 1.6, w: plotBox.w - tickW - 24, h: plotBox.h - catH - labelSize * 1.6 };
      const yOf = (v: number) => plot.y + plot.h - ((v - dom.min) / (dom.max - dom.min || 1)) * plot.h;
      const xOf = (i: number) => plot.x + (n === 1 ? plot.w / 2 : (i / (n - 1)) * plot.w);
      for (const t of ticks) { const yy = yOf(t); els.push({ kind: "line", id: nid("grid"), points: [[plot.x, yy], [plot.x + plot.w, yy]], stroke: col.grid, width: 1, role: "grid", box: { x: plot.x, y: yy, w: plot.w, h: 1 }, anim: A(start - 0.3, 0.4, "fade") }); text("axis", formatValue(t, data, 0), { x: plotBox.x, y: yy - labelSize * 0.7, w: tickW - 10, h: labelSize * 1.3 }, { size: labelSize - 2, color: col.textMuted, align: "right", maxLines: 1, block: false, anim: A(start - 0.3, 0.4, "fade") }); }
      data.series.forEach((ser, si) => {
        const pts = ser.values.map((v, i) => (v == null ? null : [xOf(i), yOf(v)] as [number, number])).filter((p): p is [number, number] => !!p);
        els.push({ kind: "line", id: nid("series"), points: pts, stroke: colors[si], width: 5, role: "series", box: plot, anim: A(start + si * 0.2, 1.1, "reveal") });
        ser.values.forEach((v, i) => {
          if (v == null) return;
          const anim = A(start + si * 0.2 + (i / Math.max(1, n - 1)) * 1.1, 0.3, "fade");
          els.push({ kind: "circle", id: nid("marker"), cx: xOf(i), cy: yOf(v), r: 7, fill: colors[si], role: "marker", box: { x: xOf(i) - 7, y: yOf(v) - 7, w: 14, h: 14 }, anim });
          if (showValues && n <= 8 && (s === 1 || i === n - 1)) { text("value", fmt(v), { x: xOf(i) - 60, y: yOf(v) - labelSize * 1.6, w: 120, h: labelSize * 1.3 }, { size: labelSize, family: d.typography.numeric, weight: 700, align: "center", maxLines: 1, anim, block: false, meta: { value: v, series: si, cat: i } }); reading.numbers++; }
        });
      });
      track(A(start + s * 0.2, 1.1, "reveal"));
      data.categories.forEach((c, i) => { const t = text("label", c, { x: xOf(i) - plot.w / n / 2, y: plot.y + plot.h + 12, w: plot.w / n, h: catH - 12 }, { size: labelSize, align: "center", maxLines: 2, block: false, anim: A(start - 0.1, 0.4, "fade") }); if (!t.fits) { issues.pop(); issues.push({ code: "category_label_collision", severity: "critical", element: t.id, message: `the axis label “${c}” does not fit` }); } });
      blocks.push({ type: "chart", box, plot, chart: "line", orientation: "vertical", data, colors, showValues, decimals: dec, labelSize, legend: s > 1 });
      return;
    }

    /* horizontal bars: hbar, grouped (horizontal), stacked_100, or a vertical type repaired to horizontal */
    const stacked = type === "stacked_100";
    const lines = o.labelLines ?? 2;
    const labelW = Math.min(plotBox.w * 0.4, Math.max(...data.categories.map((c) => Math.min(m.width(c, d.typography.body, 400, labelSize), plotBox.w * 0.4))) + 16);
    const valueW = stacked || !showValues ? 0 : Math.max(...data.series.flatMap((ser) => ser.values.map((v) => m.width(fmt(v) + (data.significanceTested ? " ab" : ""), d.typography.numeric, 700, labelSize)))) + 18;
    plot = { x: plotBox.x + labelW + 12, y: plotBox.y, w: plotBox.w - labelW - 12 - valueW, h: plotBox.h };
    const rowH = plot.h / n;
    const barT = stacked ? rowH * 0.62 : (rowH * (s > 1 ? 0.84 : 0.62)) / s;
    if (barT < 8 || rowH < labelSize * 1.25) issues.push({ code: "rows_too_dense", severity: "critical", message: `${n} rows in ${Math.round(plot.h)}px leave ${Math.round(rowH)}px per row — too dense to read; show fewer categories on this scene and the rest in a table` });
    const xOf = (v: number) => plot.x + ((v - (stacked ? 0 : dom.min)) / ((stacked ? 100 : dom.max - dom.min) || 1)) * plot.w;
    const x0 = xOf(0);
    els.push({ kind: "line", id: nid("axis"), points: [[x0, plot.y], [x0, plot.y + plot.h]], stroke: mix(col.grid, col.text, 0.35), width: 2, role: "axis", box: { x: x0 - 1, y: plot.y, w: 2, h: plot.h }, anim: A(start - 0.3, 0.4, "fade") });
    let omittedSegments = false;
    data.categories.forEach((cat, ci) => {
      const ry = plot.y + ci * rowH;
      const hl = isHighlighted(cat);
      const lt = text("label", cat, { x: plotBox.x, y: ry + (rowH - Math.min(rowH, labelSize * 1.3 * lines)) / 2, w: labelW - 4, h: Math.min(rowH, labelSize * 1.3 * lines) }, { size: labelSize, align: "right", maxLines: lines, weight: hl ? 700 : 400, block: false, anim: A(start - 0.1, 0.4, "fade") });
      if (!lt.fits) { issues.pop(); issues.push({ code: "category_label_collision", severity: "critical", element: lt.id, message: `the row label “${cat}” does not fit beside its bar`, repair: o.labelLines === 3 ? undefined : "labelLines" }); }
      if (stacked) {
        let acc = 0;
        data.series.forEach((ser, si) => {
          const v = Math.max(0, ser.values[ci] ?? 0);
          const x = xOf(acc), w = xOf(acc + v) - x;
          const anim = A(start + ci * mo.stagger * 2 + si * 0.05, 0.8, "grow_right", plot.x);
          rect("bar", { x, y: ry + (rowH - barT) / 2, w: Math.max(0, w), h: barT }, colors[si], { anim, meta: { series: si, cat: ci, value: ser.values[ci] } });
          const label = fmt(ser.values[ci]);
          const lw = m.width(label, d.typography.numeric, 700, labelSize - 2);
          if (showValues && w >= lw + 12) { const fill = colors[si]; text("value", label, { x, y: ry + (rowH - (labelSize - 2) * 1.3) / 2, w, h: (labelSize - 2) * 1.3 }, { size: labelSize - 2, family: d.typography.numeric, weight: 700, color: contrast("#FFFFFF", fill) >= 4.5 ? "#FFFFFF" : "#111111", align: "center", maxLines: 1, block: false, anim: A(start + 0.7 + ci * mo.stagger * 2, 0.4, "fade"), over: "bar", meta: { value: ser.values[ci], series: si, cat: ci } }); reading.numbers++; }
          else if (showValues && v > 0) omittedSegments = true;
          acc += v;
        });
      } else {
        data.series.forEach((ser, si) => {
          const v = ser.values[ci];
          const by = ry + (rowH - barT * s) / 2 + si * barT;
          const xv = v == null ? x0 : xOf(v);
          const anim = [...A(start + (ci * s + si) * mo.stagger, 0.9, "grow_right", x0), ...(highlight?.length && s === 1 && !hl ? A(dimAfter, 0.45, "dim", 0.35) : [])];
          rect("bar", { x: Math.min(x0, xv), y: by + (s > 1 ? 2 : 0), w: Math.max(v == null ? 0 : 1, Math.abs(xv - x0)), h: barT - (s > 1 ? 4 : 0) }, hl ? col.highlight : colors[si], { radius: Math.min(6, barT / 4), anim, meta: { series: si, cat: ci, value: v, highlight: hl } });
          if (showValues) {
            const sig = data.significanceTested ? (ser.sig?.[ci] ?? "") : "";
            const label = v == null ? "—" : fmt(v);
            const vh = Math.min(barT * 1.1, labelSize * 1.3);
            const fs = Math.max(MIN_SIZE.value, Math.min(labelSize, Math.floor(vh / 1.25)));
            text("value", sig ? `${label} ${sig}` : label, { x: Math.max(x0, xv) + 10, y: by + (barT - fs * 1.25) / 2, w: valueW + (plot.x + plot.w - Math.max(x0, xv)) - 10, h: fs * 1.25 }, { size: fs, family: d.typography.numeric, weight: 700, maxLines: 1, block: false, anim: A(start + 0.6 + (ci * s + si) * mo.stagger, 0.4, "fade"), meta: { value: v, series: si, cat: ci } });
            reading.numbers++;
          }
        });
      }
    });
    if (omittedSegments) {
      /* a segment too narrow for its label: the number is not dropped silently — the note says where it is */
      const note = "Segments too narrow to label are given in the table in the appendix.";
      if (!scene.notes.footnotes.includes(note)) issues.push({ code: "segment_labels_omitted", severity: "warning", message: note });
    }
    track(A(start + Math.min(n * s, 30) * mo.stagger, 0.9, "grow_right"));
    if (highlight?.length && s === 1) track(A(dimAfter, 0.45, "dim"));
    blocks.push({ type: "chart", box, plot, chart: stacked ? "stacked_100" : s > 1 ? "grouped_bar" : "hbar", orientation: "horizontal", data, colors, showValues, decimals: dec, labelSize, legend: s > 1, ...(highlight ? { highlight } : {}) });
  }

  /* ---------------------------------------------------- tables */
  function tableLayout(t: FrozenTable, box: Box, appendixPage: boolean) {
    const size0 = Math.min(sc.label + 2, 24);
    let size = size0;
    const cellText = tableCellText;
    const offset = o.rowOffset ?? 0;
    let widths: number[] = [];
    for (; size >= MIN_SIZE.cell; size -= 2) {
      widths = t.columns.map((c, ci) => Math.max(m.width(c.label, d.typography.body, 700, size), ...t.rows.map((r) => m.width(cellText(r, c), d.typography.body, ci === 0 ? 400 : 400, size))) + 28);
      const first = Math.min(widths[0], box.w * 0.42);
      if (first + widths.slice(1).reduce((a, w) => a + w, 0) <= box.w) { widths[0] = Math.max(first, box.w - widths.slice(1).reduce((a, w) => a + w, 0)); break; }
    }
    if (size < MIN_SIZE.cell) { size = MIN_SIZE.cell; issues.push({ code: "table_too_wide", severity: "critical", message: `the table's ${t.columns.length} columns do not fit across ${Math.round(box.w)}px even at ${size}px — split it or show it in the appendix` }); }
    const rowH = Math.round(size * 2.0);
    const headerH = Math.round(size * 2.3) * (t.columns.some((c) => m.width(c.label, d.typography.body, 700, size) > (widths[t.columns.indexOf(c)] ?? 0) - 28) ? 2 : 1);
    const fitRows = Math.max(1, Math.floor((box.h - headerH - size * 1.8) / rowH));
    const wanted = appendixPage ? t.rows.slice(offset) : t.rows.slice(0, t.mainRows ?? t.rows.length);
    const shown = wanted.slice(0, fitRows);
    const more = (appendixPage ? t.rows.length - offset : t.rows.length) - shown.length;
    let x = box.x;
    const anim0 = 0.7;
    rect("header_row", { x: box.x, y: box.y, w: widths.reduce((a, w) => a + w, 0), h: headerH }, col.tableHeaderBg, { anim: A(anim0 - 0.2, 0.4, "fade") }, false);
    t.columns.forEach((c, ci) => { text("header", c.label, { x: x + 14, y: box.y + (headerH - Math.min(headerH, size * 1.25 * (headerH > size * 2.4 ? 2 : 1))) / 2, w: widths[ci] - 28, h: Math.min(headerH, size * 1.25 * 2) }, { size, weight: 700, color: col.tableHeaderText, align: c.numeric ? "right" : "left", maxLines: 2, block: false, over: "header_row", anim: A(anim0 - 0.2, 0.4, "fade") }); x += widths[ci]; });
    const zebra = mix(col.background, col.text, isDark(col.background) ? 0.06 : 0.035);
    shown.forEach((r, ri) => {
      const ry = box.y + headerH + ri * rowH;
      const hl = t.columns.some((c) => typeof r[c.key] === "string" && !!(scene.visual.type === "table" && scene.visual.highlight?.includes(String(r[c.key]))));
      const anim = A(anim0 + ri * Math.min(0.06, mo.stagger), 0.35, "fade");
      if (ri % 2 === 1 || hl) rect("row", { x: box.x, y: ry, w: widths.reduce((a, w) => a + w, 0), h: rowH }, hl ? mix(col.background, col.highlight, 0.18) : zebra, { anim }, false);
      let cx = box.x;
      t.columns.forEach((c, ci) => { const tx = cellText(r, c); text("cell", tx, { x: cx + 14, y: ry + (rowH - size * 1.25) / 2, w: widths[ci] - 28, h: size * 1.25 }, { size, minSize: size, weight: ci === 0 && hl ? 700 : 400, align: c.numeric ? "right" : "left", maxLines: 1, block: false, anim, over: ri % 2 === 1 || hl ? "row" : undefined, meta: typeof r[c.key] === "number" ? { value: r[c.key] as number } : undefined }); cx += widths[ci]; if (c.numeric) reading.numbers += 0.2; });
    });
    track(A(anim0 + shown.length * Math.min(0.06, mo.stagger), 0.35, "fade"));
    if (more > 0) text("source", appendixPage ? `Continued on the next page (${more} more row${more === 1 ? "" : "s"}).` : `+ ${more} more row${more === 1 ? "" : "s"} — the full table is in the appendix.`, { x: box.x, y: box.y + headerH + shown.length * rowH + 8, w: box.w, h: size * 1.5 }, { size: Math.max(MIN_SIZE.source, size - 4), color: col.textMuted, maxLines: 1, anim: A(anim0 + 0.4, 0.4, "fade") });
    blocks.push({ type: "table", box: { x: box.x, y: box.y, w: widths.reduce((a, w) => a + w, 0), h: headerH + shown.length * rowH }, columns: t.columns, rows: shown, widths, rowHeight: rowH, size, headerBg: col.tableHeaderBg, headerText: col.tableHeaderText, text: col.text, grid: col.grid, zebra, ...(scene.visual.type === "table" && scene.visual.highlight ? { highlight: scene.visual.highlight } : {}) });
    tableRemaining = more;
  }

  /* ---------------------------------------------------- the scene's entrance and exit */
  if (mo.slide) for (const el of els) if (el.kind !== "rect" || (el.role !== "background" && el.role !== "band")) el.anim = [...(el.anim ?? []), { start: 0, dur: 0.55 * mo.k, type: "slide", param: 80 }];
  void footerEls;
  return { sceneId: scene.id, page: ctx.page, canvas: C, background: col.background, elements: els, blocks, issues, settleAt: Math.max(settle, mo.on ? 0.6 : 0), reading, ...(tableRemaining !== undefined ? { tableRemaining } : {}) };
}

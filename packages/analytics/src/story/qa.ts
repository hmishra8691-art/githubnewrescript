/**
 * THE VISUAL QUALITY ENGINE — nothing leaves until it passes.
 *
 * A laid-out scene is checked as geometry, not as a picture: every element
 * inside the canvas and the safe area; no two texts on top of each other;
 * no text under a decoration or the logo; every text readable against what
 * is actually behind it; no character the font cannot draw; no text below
 * its role's minimum at the output resolution; and every number a chart or
 * table shows equal to the frozen value it stands for, with bar lengths in
 * the same order as their values.
 *
 * `composeReport` lays out every page, runs the checks, applies the repairs
 * a failure names (horizontal bars for crowded labels, three-line labels,
 * the decoration removed, the logo moved, a wider visual), and lays out
 * again — up to four passes. What still fails is reported for a person to
 * review. A repair never changes a number, drops a word or distorts a chart.
 */
import type { AspectRatio, Scene, StoryReport } from "./types.js";
import { contrast } from "./design.js";
import { formatValue } from "./charts.js";
import type { Measurer } from "./measure.js";
import { canvasFor, layoutScene, overlap, type Box, type El, type LaidOutScene, type LayoutIssue, type LayoutOptions, MIN_SIZE } from "./layout.js";

export interface QaIssue extends LayoutIssue { sceneId: string; page: number }

export interface QaReport {
  pages: number;
  critical: QaIssue[];
  warnings: QaIssue[];
  /** repairs applied, in words, per scene */
  repairs: { sceneId: string; repair: string }[];
  /** numbers checked against their source values */
  valuesVerified: number;
  ok: boolean;
}

const inside = (b: Box, c: { w: number; h: number }, pad = 0) => b.x >= pad - 0.5 && b.y >= pad - 0.5 && b.x + b.w <= c.w - pad + 0.5 && b.y + b.h <= c.h - pad + 0.5;
const center = (b: Box) => ({ x: b.x + b.w / 2, y: b.y + b.h / 2 });
const contains = (b: Box, p: { x: number; y: number }) => p.x >= b.x && p.x <= b.x + b.w && p.y >= b.y && p.y <= b.y + b.h;

/** what is behind a text: the topmost filled shape under its centre, or the background */
function behind(els: El[], t: Extract<El, { kind: "text" }>, bg: string): string {
  const c = center(t.box);
  let fill = bg;
  for (const e of els) {
    if (e === t) break;
    if (e.kind === "rect" && e.role !== "grid" && e.role !== "rule" && contains(e.box, c)) fill = e.fill;
  }
  return fill;
}

/** The checks on one laid-out page. `outputShort` is the output's short side in px (1080 for slides). */
export function checkScene(page: LaidOutScene, scene: Scene, m: Measurer, outputShort: number): LayoutIssue[] {
  const out: LayoutIssue[] = [...page.issues];
  const C = page.canvas;
  const scale = outputShort / Math.min(C.w, C.h);
  const texts = page.elements.filter((e): e is Extract<El, { kind: "text" }> => e.kind === "text");
  const safe = 24;

  for (const e of page.elements) {
    if (e.kind === "rect" && (e.role === "background" || e.role === "band")) continue;
    if (e.kind === "circle" && e.role === "decor") continue;
    if (!inside(e.box, C)) out.push({ code: "out_of_bounds", severity: "critical", element: e.id, message: `${e.kind} ${"role" in e ? e.role : ""} extends outside the canvas` });
    else if (e.kind === "text" && !inside(e.box, C, safe)) out.push({ code: "outside_safe_area", severity: "critical", element: e.id, message: `text “${e.text.slice(0, 40)}” is within ${safe}px of the edge` });
  }

  /* text on text */
  for (let i = 0; i < texts.length; i++) for (let j = i + 1; j < texts.length; j++) {
    const a = texts[i], b = texts[j];
    if (overlap(a.box, b.box) > 6) out.push({ code: "text_collision", severity: "critical", element: a.id, message: `“${a.text.slice(0, 40)}” (${a.role}) overlaps “${b.text.slice(0, 40)}” (${b.role})` });
  }
  /* text under a decoration or the logo; value labels on other bars */
  for (const t of texts) {
    for (const e of page.elements) {
      if (e.kind === "circle" && e.role === "decor" && overlap(t.box, e.box) > 0) {
        /* a circle's box is a square: test the text's corners against the circle itself */
        const corners = [[t.box.x, t.box.y], [t.box.x + t.box.w, t.box.y], [t.box.x, t.box.y + t.box.h], [t.box.x + t.box.w, t.box.y + t.box.h], [t.box.x + t.box.w / 2, t.box.y + t.box.h / 2]];
        if (corners.some(([x, y]) => (x - e.cx) ** 2 + (y - e.cy) ** 2 < e.r ** 2)) out.push({ code: "text_under_decoration", severity: "critical", element: t.id, message: `“${t.text.slice(0, 40)}” sits on a decorative shape`, repair: "noDecor" });
      }
      if (e.kind === "image" && overlap(t.box, e.box) > 0) out.push({ code: "text_under_logo", severity: "critical", element: t.id, message: `“${t.text.slice(0, 40)}” collides with the logo`, repair: "logoAlt" });
      if (t.role === "value" && e.kind === "rect" && e.role === "bar" && t.over !== "bar" && e.meta && t.meta && (e.meta.cat !== t.meta.cat || e.meta.series !== t.meta.series) && overlap(t.box, e.box) > 4) out.push({ code: "label_on_bar", severity: "critical", element: t.id, message: `the value label “${t.text}” overlaps another bar`, repair: "horizontalBars" });
      if ((t.role === "legend" || t.role === "axis") && e.kind === "rect" && e.role === "bar" && overlap(t.box, e.box) > 4) out.push({ code: "legend_over_data", severity: "critical", element: t.id, message: `“${t.text}” covers part of the chart` });
    }
    /* readability */
    const bg = behind(page.elements, t, page.background);
    const need = t.size >= 36 || (t.weight >= 700 && t.size >= 28) ? 3 : 4.5;
    const cr = contrast(t.color, bg);
    if (cr < need) out.push({ code: "low_contrast", severity: "critical", element: t.id, message: `“${t.text.slice(0, 40)}” has ${cr.toFixed(1)}:1 contrast on ${bg} (needs ${need}:1)` });
    const missing = m.missing(t.text, t.family, t.weight);
    if (missing.length) out.push({ code: "missing_glyphs", severity: "critical", element: t.id, message: `the font has no glyph for ${missing.map((c) => `“${c}” (U+${c.codePointAt(0)!.toString(16).toUpperCase()})`).join(", ")} in “${t.text.slice(0, 40)}”` });
    const px = t.size * scale;
    const floor = t.role === "label" || t.role === "value" || t.role === "axis" || t.role === "legend" || t.role === "source" || t.role === "footer" || t.role === "cell" || t.role === "header" ? 12 : 16;
    if (px < floor - 0.01) out.push({ code: "too_small_at_resolution", severity: "warning", element: t.id, message: `“${t.text.slice(0, 30)}” renders at ${px.toFixed(1)}px at ${outputShort}p (below ${floor}px) — use a higher resolution or larger labels` });
    if (t.size < (MIN_SIZE[t.role] ?? 12) - 0.01) out.push({ code: "below_minimum_size", severity: "critical", element: t.id, message: `${t.role} text at ${t.size}px is below its ${MIN_SIZE[t.role]}px minimum` });
  }

  /* the numbers: every value label equals the frozen value it stands for */
  const v = scene.visual;
  if (v.type === "chart") {
    const bars = page.elements.filter((e): e is Extract<El, { kind: "rect" }> => e.kind === "rect" && e.role === "bar");
    for (const t of texts.filter((x) => x.role === "value" && x.meta && x.meta.series !== undefined && x.meta.cat !== undefined)) {
      const src = v.data.series[t.meta!.series!]?.values[t.meta!.cat!];
      const blk = page.blocks.find((b) => b.type === "chart");
      const dec = blk && blk.type === "chart" ? blk.decimals : v.data.decimals;
      const expect = formatValue(src ?? null, v.data, dec);
      if (!t.text.startsWith(expect)) out.push({ code: "value_mismatch", severity: "critical", element: t.id, message: `a label shows “${t.text}” where the source value is ${src} (${expect})` });
    }
    /* bar lengths in the order of their values, series by series */
    for (let si = 0; si < v.data.series.length; si++) {
      const own = bars.filter((b) => b.meta?.series === si && b.meta.value != null);
      const len = (b: (typeof own)[number]) => Math.max(b.box.w, b.box.h) * (v.chart === "stacked_100" ? 1 : 1);
      for (let i = 0; i < own.length; i++) for (let j = 0; j < own.length; j++) {
        const a = own[i], b = own[j];
        if (v.chart === "stacked_100") continue;
        const va = Math.abs(a.meta!.value!), vb = Math.abs(b.meta!.value!);
        const horizontal = a.box.h < a.box.w && v.chart !== "bar";
        const la = horizontal ? a.box.w : a.box.h, lb = horizontal ? b.box.w : b.box.h;
        if (va > vb + 1e-9 && la < lb - 0.75) out.push({ code: "bar_scale_mismatch", severity: "critical", message: `a bar for ${va} is drawn shorter than one for ${vb}` });
        void len;
      }
    }
  }
  if (v.type === "table") {
    /* numeric cells right-aligned on one edge per column */
    const cells = texts.filter((t) => t.role === "cell" && t.meta?.value !== undefined);
    const edges = new Map<number, Set<number>>();
    for (const c of cells) { const right = Math.round(c.box.x + c.box.w); const col = Math.round(c.box.x); if (c.align !== "right") out.push({ code: "table_alignment", severity: "warning", element: c.id, message: `numeric cell “${c.text}” is not right-aligned` }); const s = edges.get(col) ?? new Set(); s.add(right); edges.set(col, s); }
    for (const [, s] of edges) if (s.size > 1) out.push({ code: "table_alignment", severity: "warning", message: "numbers in one column do not share a right edge" });
  }
  return out;
}

/* ------------------------------------------------------------ composing the whole report */

export interface ComposedPage extends LaidOutScene { sceneIndex: number; repairs: string[]; checks: LayoutIssue[] }
export interface Composed { target: "video" | "pptx"; aspect: AspectRatio; pages: ComposedPage[]; qa: QaReport }

const REPAIR_WORDS: Record<keyof LayoutOptions, string> = {
  horizontalBars: "drew the bars horizontally so every label fits",
  labelLines: "let category labels wrap to three lines",
  logoAlt: "moved the logo out of the way of the text",
  noDecor: "removed a decorative shape that sat under text",
  wideVisual: "widened the chart",
  rowOffset: "continued the table on another page",
};

/**
 * Lay out every page of the report for a target, with the checks and the
 * repairs. Video: the main scenes in the aspect asked for. PowerPoint: the
 * main scenes and the appendix (long tables over as many pages as they
 * need), always 16:9.
 */
export function composeReport(report: StoryReport, m: Measurer, target: "video" | "pptx"): Composed {
  const aspect: AspectRatio = target === "pptx" ? "16:9" : report.design.video.aspect;
  const outputHeight = target === "pptx" ? 1080 : report.design.video.height;
  const scenes = report.scenes.map((s, i) => ({ s, i })).filter(({ s }) => target === "pptx" || s.section === "main");
  /* first pass to count pages (appendix tables may need several) */
  const plan: { s: Scene; i: number; offset?: number }[] = [];
  for (const { s, i } of scenes) {
    if (target === "pptx" && s.kind === "appendix_table" && s.visual.type === "table") {
      let offset = 0;
      for (let guard = 0; guard < 40; guard++) {
        plan.push({ s, i, offset });
        const probe = layoutScene(s, { design: report.design, measure: m, aspect, page: 1, pages: 1, report, options: { rowOffset: offset } });
        const rest = probe.tableRemaining ?? 0;
        if (rest <= 0) break;
        offset = s.visual.table.rows.length - rest;
      }
    } else plan.push({ s, i });
  }
  const pages: ComposedPage[] = [];
  const all: QaIssue[] = [];
  const repairsAll: QaReport["repairs"] = [];
  let verified = 0;
  plan.forEach(({ s, i, offset }, pi) => {
    const opts: LayoutOptions = offset !== undefined ? { rowOffset: offset } : {};
    const repairs: string[] = [];
    const chartLocked = s.locked.includes("chart");
    let page: LaidOutScene = layoutScene(s, { design: report.design, measure: m, aspect, page: pi + 1, pages: plan.length, report, options: opts });
    let checks = checkScene(page, s, m, outputHeight);
    for (let pass = 0; pass < 4; pass++) {
      const wanted = new Set(checks.filter((c) => c.severity === "critical" && c.repair).map((c) => c.repair!));
      /* a person chose this chart: it is not switched to another type behind their back */
      if (chartLocked) wanted.delete("horizontalBars");
      if (s.visual.type === "chart" && !["bar", "grouped_bar"].includes(s.visual.chart)) wanted.delete("horizontalBars");
      const fresh = [...wanted].filter((k) => !opts[k]);
      if (!fresh.length) break;
      for (const k of fresh) { (opts as Record<string, unknown>)[k] = k === "labelLines" ? 3 : true; repairs.push(REPAIR_WORDS[k]); }
      page = layoutScene(s, { design: report.design, measure: m, aspect, page: pi + 1, pages: plan.length, report, options: opts });
      checks = checkScene(page, s, m, outputHeight);
    }
    if (s.visual.type === "chart") verified += page.elements.filter((e) => e.kind === "text" && e.role === "value").length;
    if (s.visual.type === "table") verified += page.elements.filter((e) => e.kind === "text" && e.role === "cell" && e.meta?.value !== undefined).length;
    for (const r of repairs) repairsAll.push({ sceneId: s.id, repair: r });
    for (const c of checks) all.push({ ...c, sceneId: s.id, page: pi + 1 });
    pages.push({ ...page, sceneIndex: i, repairs, checks });
  });
  const critical = all.filter((x) => x.severity === "critical");
  return { target, aspect, pages, qa: { pages: pages.length, critical, warnings: all.filter((x) => x.severity === "warning"), repairs: repairsAll, valuesVerified: verified, ok: critical.length === 0 } };
}

/* ------------------------------------------------------------ timing */

export interface SceneTiming { sceneId: string; enter: number; hold: number; outro: number; total: number; minimum: number; extended: boolean; audio?: number }

/** seconds into a scene the narration starts */
export function audioLead(enter: number): number { return Math.round(Math.max(0.4, enter * 0.4) * 100) / 100; }

/** how long a scene has to stay on screen: its entrances, then long enough to read what it says */
export function sceneTiming(page: LaidOutScene, scene: Scene, report: StoryReport, audioSeconds?: number): SceneTiming {
  const d = report.design;
  const enter = page.settleAt;
  const transition = scene.motion.transition === "inherit" ? d.motion.transition : scene.motion.transition;
  const outro = transition === "cut" || d.motion.style === "none" ? 0 : 0.4;
  const read = Math.max(scene.layout === "title" || scene.layout === "closing" ? 3.5 : 2.5, page.reading.words / 3.2 + Math.min(page.reading.numbers, 24) * 0.3);
  /* the narration starts as the scene settles in (see AUDIO_LEAD) and must finish before the scene leaves */
  const spoken = audioSeconds ? audioLead(enter) + audioSeconds + 0.6 + outro : 0;
  const minimum = Math.round(Math.max(enter + read + outro, spoken) * 10) / 10;
  let total = scene.duration === "auto" ? minimum : scene.duration;
  let extended = false;
  if (total < minimum) { total = minimum; extended = scene.duration !== "auto"; }
  total = Math.round(total * 10) / 10;
  return { sceneId: scene.id, enter, hold: total - enter - outro, outro, total, minimum, extended, ...(audioSeconds ? { audio: audioSeconds } : {}) };
}

/** pacing against a target length: hold times shortened toward their minimum, never below it */
export function fitToDuration(timings: SceneTiming[], target: number | undefined): { timings: SceneTiming[]; total: number; overBy: number; note?: string } {
  const total = timings.reduce((a, t) => a + t.total, 0);
  if (!target || total <= target) {
    if (target && total < target * 0.85) {
      /* room to breathe: spread the spare time over the holds, at most doubling any */
      const spare = target - total;
      const weight = timings.reduce((a, t) => a + t.hold, 0) || 1;
      const out = timings.map((t) => { const add = Math.min(t.hold, (t.hold / weight) * spare); return { ...t, hold: t.hold + add, total: Math.round((t.total + add) * 10) / 10 }; });
      return { timings: out, total: Math.round(out.reduce((a, t) => a + t.total, 0) * 10) / 10, overBy: 0 };
    }
    return { timings, total: Math.round(total * 10) / 10, overBy: 0 };
  }
  const floor = timings.reduce((a, t) => a + t.minimum, 0);
  if (floor >= target) return { timings: timings.map((t) => ({ ...t, total: t.minimum, hold: t.minimum - t.enter - t.outro })), total: Math.round(floor * 10) / 10, overBy: Math.round((floor - target) * 10) / 10, note: `At the shortest readable pace the video is ${Math.round(floor)}s — ${Math.round(floor - target)}s over the ${target}s target. Move scenes to the appendix (or remove them) to shorten it further.` };
  const k = (target - floor) / (total - floor);
  const out = timings.map((t) => { const tot = Math.round((t.minimum + (t.total - t.minimum) * k) * 10) / 10; return { ...t, total: tot, hold: tot - t.enter - t.outro }; });
  return { timings: out, total: Math.round(out.reduce((a, t) => a + t.total, 0) * 10) / 10, overBy: 0 };
}

/** subtitles (SRT) from the voice-over, sentence by sentence, timed across each scene's audio */
export function subtitlesFor(items: { text: string; start: number; duration: number }[]): string {
  const ts = (s: number) => { const h = Math.floor(s / 3600), mm = Math.floor((s % 3600) / 60), ss = Math.floor(s % 60), ms = Math.round((s - Math.floor(s)) * 1000); return `${String(h).padStart(2, "0")}:${String(mm).padStart(2, "0")}:${String(ss).padStart(2, "0")},${String(ms).padStart(3, "0")}`; };
  const cues: string[] = [];
  let n = 0;
  for (const it of items) {
    const sentences = it.text.match(/[^.!?]+[.!?]*/g)?.map((x) => x.trim()).filter(Boolean) ?? [];
    const chars = sentences.reduce((a, s) => a + s.length, 0) || 1;
    let t = it.start;
    for (const s of sentences) { const d = (s.length / chars) * it.duration; cues.push(`${++n}\n${ts(t)} --> ${ts(t + d)}\n${s}\n`); t += d; }
  }
  return cues.join("\n");
}

/** the words a narrator reads for a scene */
export function voiceoverFor(scene: Scene): string {
  if (scene.voiceover) return scene.voiceover;
  const v = scene.visual;
  const extra = v.type === "bullets" ? v.items.slice(0, 3).join(". ") : v.type === "verdicts" ? v.items.map((x) => `${x.label}: ${x.verdict.replace("_", " ")}`).join(". ") : v.type === "stat" ? `${v.label}: ${v.value}` : v.type === "kpis" ? v.items.map((k) => `${k.label}: ${k.value}`).join(". ") : "";
  return [scene.title, scene.body, extra].filter(Boolean).join(". ").replace(/\.\./g, ".");
}

export { canvasFor };

/**
 * ONE FRAME OF A SCENE, AS SVG.
 *
 * `renderFrame(page, t)` draws a laid-out page as it looks `t` seconds into
 * its scene: entrances eased in, bars grown from their baseline, lines
 * drawn, a donut swept, the highlighted category lifted by dimming the
 * others, the scene faded in from (and out to) its background. The same
 * function draws the in-browser preview, the thumbnails and every frame of
 * the video, so the preview is the video. At the end of its entrances a
 * scene is still: its frames are identical, which the encoder uses to
 * rasterise a hold once.
 *
 * Numbers that count up (a statistic) show intermediate values only while
 * moving; every frame from `settleAt` on shows exactly the laid-out text.
 */
import type { Anim, El, LaidOutScene } from "./layout.js";
import type { Measurer } from "./measure.js";

export interface FrameOptions {
  /** the scene's length, for the fade out */
  total: number;
  /** seconds of fade in and out (0 for a cut) */
  fadeIn: number;
  fadeOut: number;
  /** output size in px; the canvas is scaled to it */
  width: number;
  height: number;
  measure: Pick<Measurer, "metrics">;
  /** draw every element in its final state (thumbnails, slide previews, the QA reference) */
  final?: boolean;
}

const ease = (p: number) => 1 - (1 - Math.max(0, Math.min(1, p))) ** 3;
const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
const r2 = (n: number) => Math.round(n * 100) / 100;

interface State { opacity: number; dx: number; dy: number; grow: number; growBase?: number; growDir?: "up" | "right"; reveal: number; sweep: number; count: number; dim: number; started: boolean }
function stateAt(anims: Anim[] | undefined, t: number, final: boolean): State {
  const s: State = { opacity: 1, dx: 0, dy: 0, grow: 1, reveal: 1, sweep: 1, count: 1, dim: 1, started: true };
  if (!anims?.length) return s;
  /* the final state is every animation run to its end (a dimmed bar stays dimmed), so it equals the settled frame */
  if (final) t = Number.POSITIVE_INFINITY;
  for (const a of anims) {
    const p = a.dur <= 0 || !Number.isFinite(t) ? (t >= a.start ? 1 : 0) : ease((t - a.start) / a.dur);
    switch (a.type) {
      case "fade": s.opacity *= p; break;
      case "rise": s.dy += (1 - p) * (a.param ?? 24); break;
      case "slide": s.dx += (1 - p) * (a.param ?? 80); s.opacity *= Math.min(1, 0.2 + p); break;
      case "grow_up": s.grow = p; s.growBase = a.param; s.growDir = "up"; break;
      case "grow_right": s.grow = p; s.growBase = a.param; s.growDir = "right"; break;
      case "reveal": s.reveal = p; break;
      case "sweep": s.sweep = p; break;
      case "count": s.count = p; break;
      case "dim": s.dim = 1 - (1 - (a.param ?? 0.35)) * p; break;
    }
  }
  return s;
}

function arcPath(cx: number, cy: number, r0: number, r1: number, a0: number, a1: number): string {
  if (a1 - a0 >= Math.PI * 2 - 1e-6) a1 = a0 + Math.PI * 2 - 1e-4;
  const large = a1 - a0 > Math.PI ? 1 : 0;
  const p = (r: number, a: number) => `${r2(cx + r * Math.cos(a))} ${r2(cy + r * Math.sin(a))}`;
  return `M ${p(r1, a0)} A ${r2(r1)} ${r2(r1)} 0 ${large} 1 ${p(r1, a1)} L ${p(r0, a1)} A ${r2(r0)} ${r2(r0)} 0 ${large} 0 ${p(r0, a0)} Z`;
}

/** a number in a label counted from zero, keeping its decimals, prefix and suffix */
function counted(text: string, p: number): string {
  const m = /^(.*?)(-?[\d,]+(?:\.\d+)?)(.*)$/.exec(text);
  if (!m || p >= 1) return text;
  const raw = Number(m[2].replace(/,/g, ""));
  const dec = (m[2].split(".")[1] ?? "").length;
  return `${m[1]}${(raw * p).toLocaleString("en-US", { minimumFractionDigits: dec, maximumFractionDigits: dec })}${m[3]}`;
}

function el(e: El, t: number, o: FrameOptions): string {
  const s = stateAt(e.anim, t, !!o.final);
  if (s.opacity <= 0.001 && e.kind !== "rect") return "";
  const op = s.opacity * s.dim;
  const tr = s.dx || s.dy ? ` transform="translate(${r2(s.dx)} ${r2(s.dy)})"` : "";
  const opa = op < 0.999 ? ` opacity="${r2(op)}"` : "";
  switch (e.kind) {
    case "rect": {
      if (e.role === "background") return `<rect x="0" y="0" width="${e.box.w}" height="${e.box.h}" fill="${e.fill}"/>`;
      if (op <= 0.001) return "";
      let { x, y, w, h } = e.box;
      if (s.grow < 1 && s.growDir === "up" && s.growBase !== undefined) { const base = s.growBase; if (y < base - 0.5) { y = base - (base - y) * s.grow; h = h * s.grow; } else h = h * s.grow; }
      if (s.grow < 1 && s.growDir === "right" && s.growBase !== undefined) { const base = s.growBase; if (x >= base - 0.5) w = w * s.grow; else { x = base - (base - x) * s.grow; w = w * s.grow; } }
      if (w <= 0.05 || h <= 0.05) return "";
      const rx = e.radius ? ` rx="${r2(Math.min(e.radius, w / 2, h / 2))}"` : "";
      return `<rect x="${r2(x)}" y="${r2(y)}" width="${r2(w)}" height="${r2(h)}"${rx} fill="${e.fill}"${e.opacity !== undefined ? ` fill-opacity="${e.opacity}"` : ""}${opa}${tr}/>`;
    }
    case "circle":
      return `<circle cx="${r2(e.cx)}" cy="${r2(e.cy)}" r="${r2(e.r)}" fill="${e.fill}"${opa}${tr}/>`;
    case "line": {
      let pts = e.points;
      if (s.reveal < 1 && pts.length > 1) {
        const segs = pts.slice(1).map((p, i) => Math.hypot(p[0] - pts[i][0], p[1] - pts[i][1]));
        const total = segs.reduce((a, b) => a + b, 0);
        let left = total * s.reveal;
        const out: [number, number][] = [pts[0]];
        for (let i = 0; i < segs.length && left > 0; i++) { const f = Math.min(1, left / (segs[i] || 1)); const a = pts[i], b = pts[i + 1]; out.push([a[0] + (b[0] - a[0]) * f, a[1] + (b[1] - a[1]) * f]); left -= segs[i]; }
        pts = out;
      }
      if (pts.length < 2) return "";
      return `<polyline points="${pts.map((p) => `${r2(p[0])},${r2(p[1])}`).join(" ")}" fill="none" stroke="${e.stroke}" stroke-width="${e.width}" stroke-linejoin="round" stroke-linecap="round"${e.dash ? ` stroke-dasharray="${e.dash.join(" ")}"` : ""}${opa}${tr}/>`;
    }
    case "arc": {
      let a1 = e.a1;
      if (s.sweep < 1) { const g = -Math.PI / 2 + Math.PI * 2 * s.sweep; if (g <= e.a0) return ""; a1 = Math.min(e.a1, g); }
      if (a1 - e.a0 < 1e-4) return "";
      return `<path d="${arcPath(e.cx, e.cy, e.r0, e.r1, e.a0, a1)}" fill="${e.fill}"${opa}${tr}/>`;
    }
    case "image":
      return `<image href="${e.href}" x="${r2(e.box.x)}" y="${r2(e.box.y)}" width="${r2(e.box.w)}" height="${r2(e.box.h)}" preserveAspectRatio="xMidYMid meet"${opa}${tr}/>`;
    case "text": {
      const met = o.measure.metrics(e.family, e.weight);
      const lh = e.size * e.lineHeight;
      const anchor = e.align === "center" ? "middle" : e.align === "right" ? "end" : "start";
      const x = e.align === "center" ? e.box.x + e.box.w / 2 : e.align === "right" ? e.box.x + e.box.w : e.box.x;
      const lines = s.count < 1 ? e.lines.map((l) => counted(l, s.count)) : e.lines;
      const spans = lines.map((line, i) => {
        const base = e.box.y + i * lh + (lh - (met.ascent - met.descent) * e.size) / 2 + met.ascent * e.size;
        return `<text x="${r2(x)}" y="${r2(base)}" font-family="${e.family}" font-weight="${e.weight}" font-size="${e.size}"${e.tracking ? ` letter-spacing="${e.tracking}"` : ""} text-anchor="${anchor}" fill="${e.color}">${esc(line)}</text>`;
      }).join("");
      return opa || tr ? `<g${opa}${tr}>${spans}</g>` : spans;
    }
  }
}

/** The SVG of a page `t` seconds into its scene. */
export function renderFrame(page: LaidOutScene, t: number, o: FrameOptions): string {
  const body = page.elements.map((e) => el(e, t, o)).join("");
  let veil = "";
  if (!o.final) {
    const vin = o.fadeIn > 0 && t < o.fadeIn ? 1 - ease(t / o.fadeIn) : 0;
    const vout = o.fadeOut > 0 && t > o.total - o.fadeOut ? ease((t - (o.total - o.fadeOut)) / o.fadeOut) : 0;
    const v = Math.max(vin, vout);
    if (v > 0.001) veil = `<rect x="0" y="0" width="${page.canvas.w}" height="${page.canvas.h}" fill="${page.background}" opacity="${r2(v)}"/>`;
  }
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${o.width}" height="${o.height}" viewBox="0 0 ${page.canvas.w} ${page.canvas.h}">${body}${veil}</svg>`;
}

/** output pixel size for a design's video settings (the `height` setting is the short side) */
export function outputSize(aspect: "16:9" | "9:16" | "1:1", shortSide: number): { width: number; height: number } {
  const even = (n: number) => Math.round(n / 2) * 2;
  if (aspect === "9:16") return { width: shortSide, height: even(shortSide * 16 / 9) };
  if (aspect === "1:1") return { width: shortSide, height: shortSide };
  return { width: even(shortSide * 16 / 9), height: shortSide };
}

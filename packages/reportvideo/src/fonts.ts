/**
 * THE REPORT FONTS ON THE SERVER, AND SVG → PIXELS.
 *
 * The same OFL font files measure the text (layout, QA) and draw it
 * (resvg), so what the checks passed is what the frame shows. System fonts
 * are never loaded: a frame cannot silently fall back to a face the layout
 * did not measure.
 */
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { Resvg } from "@resvg/resvg-js";
import { REPORT_FONTS, createMeasurer, type Measurer } from "@rescript/analytics/story";

export interface ReportFonts { dir: string; files: string[]; measurer: Measurer }

const loaded = new Map<string, ReportFonts>();

/** load the report fonts from `dir` (default: REPORT_FONTS_DIR, else the Studio's public/report-fonts) */
export function loadReportFonts(dir?: string): ReportFonts {
  const d = dir ?? process.env.REPORT_FONTS_DIR ?? join(process.cwd(), "public", "report-fonts");
  const hit = loaded.get(d);
  if (hit) return hit;
  const files = REPORT_FONTS.map((f) => join(d, f.file));
  const missing = files.filter((f) => !existsSync(f));
  if (missing.length) throw new Error(`report fonts missing: ${missing.map((f) => f.split("/").pop()).join(", ")}`);
  const measurer = createMeasurer(REPORT_FONTS.map((f, i) => ({ family: f.family, weight: f.weight, data: readFileSync(files[i]) })));
  const out = { dir: d, files, measurer };
  loaded.set(d, out);
  return out;
}

/** draw an SVG (with its own width/height) to RGBA pixels */
export function rasterize(svg: string, fonts: ReportFonts): { width: number; height: number; pixels: Buffer } {
  const r = new Resvg(svg, { font: { fontFiles: fonts.files, loadSystemFonts: false, defaultFontFamily: "Inter" } });
  const img = r.render();
  return { width: img.width, height: img.height, pixels: Buffer.from(img.pixels) };
}

export function rasterizePng(svg: string, fonts: ReportFonts): Buffer {
  const r = new Resvg(svg, { font: { fontFiles: fonts.files, loadSystemFonts: false, defaultFontFamily: "Inter" } });
  return Buffer.from(r.render().asPng());
}

/** RGBA → RGB, for comparing with frames ffmpeg decodes */
export function rgbaToRgb(rgba: Buffer, background: [number, number, number] = [255, 255, 255]): Buffer {
  const out = Buffer.alloc((rgba.length / 4) * 3);
  for (let i = 0, j = 0; i < rgba.length; i += 4, j += 3) {
    const a = rgba[i + 3] / 255;
    out[j] = Math.round(rgba[i] * a + background[0] * (1 - a));
    out[j + 1] = Math.round(rgba[i + 1] * a + background[1] * (1 - a));
    out[j + 2] = Math.round(rgba[i + 2] * a + background[2] * (1 - a));
  }
  return out;
}

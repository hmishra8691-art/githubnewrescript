/**
 * TEXT MEASUREMENT FROM THE FONT FILES THEMSELVES.
 *
 * Layout, the quality checks and the renderer all measure text with the same
 * font files the video frames are drawn with (the OFL fonts in
 * `apps/studio/public/report-fonts`), parsed by opentype.js — in Node for
 * rendering and in the browser for the preview. A line that fits in the
 * check fits in the frame, because it is the same advance widths.
 */
import opentype from "opentype.js";
import type { FontFamilyId } from "./types.js";

export interface FontSource { family: FontFamilyId; weight: 400 | 700; file: string }
/** the faces the report uses, by file name in the fonts directory */
export const REPORT_FONTS: FontSource[] = [
  { family: "Inter", weight: 400, file: "Inter_400Regular.ttf" },
  { family: "Inter", weight: 700, file: "Inter_700Bold.ttf" },
  { family: "Source Serif 4", weight: 400, file: "SourceSerif4_400Regular.ttf" },
  { family: "Source Serif 4", weight: 700, file: "SourceSerif4_700Bold.ttf" },
  { family: "Montserrat", weight: 400, file: "Montserrat_400Regular.ttf" },
  { family: "Montserrat", weight: 700, file: "Montserrat_700Bold.ttf" },
];

export interface Measurer {
  /** advance width of `text` in px at `size`, with `tracking` px added between letters */
  width(text: string, family: FontFamilyId, weight: number, size: number, tracking?: number): number;
  /** ascender and descender as fractions of the size (descender negative) */
  metrics(family: FontFamilyId, weight: number): { ascent: number; descent: number };
  /** characters the face has no glyph for */
  missing(text: string, family: FontFamilyId, weight: number): string[];
  /** whether this measurer reads real font files (false for the approximate fallback) */
  readonly exact: boolean;
}

type Face = { font: opentype.Font; cache: Map<string, number>; upm: number };

/** a measurer from loaded font files: bytes per face */
export function createMeasurer(faces: { family: FontFamilyId; weight: number; data: ArrayBuffer | Uint8Array }[]): Measurer {
  const byKey = new Map<string, Face>();
  for (const f of faces) {
    const buf = f.data instanceof Uint8Array ? f.data.buffer.slice(f.data.byteOffset, f.data.byteOffset + f.data.byteLength) : f.data;
    const font = opentype.parse(buf as ArrayBuffer);
    byKey.set(`${f.family}:${f.weight >= 600 ? 700 : 400}`, { font, cache: new Map(), upm: font.unitsPerEm });
  }
  const face = (family: FontFamilyId, weight: number): Face => {
    const w = weight >= 600 ? 700 : 400;
    const hit = byKey.get(`${family}:${w}`) ?? byKey.get(`${family}:${w === 700 ? 400 : 700}`) ?? byKey.get(`Inter:${w}`) ?? [...byKey.values()][0];
    if (!hit) throw new Error("no fonts loaded");
    return hit;
  };
  return {
    exact: true,
    width(text, family, weight, size, tracking = 0) {
      const f = face(family, weight);
      let units = f.cache.get(text);
      if (units === undefined) {
        units = 0;
        const glyphs = f.font.stringToGlyphs(text);
        for (let i = 0; i < glyphs.length; i++) {
          units += glyphs[i].advanceWidth ?? 0;
          if (i < glyphs.length - 1) units += f.font.getKerningValue(glyphs[i], glyphs[i + 1]);
        }
        if (f.cache.size > 20000) f.cache.clear();
        f.cache.set(text, units);
      }
      return (units / f.upm) * size + Math.max(0, [...text].length - 1) * tracking;
    },
    metrics(family, weight) { const f = face(family, weight); return { ascent: f.font.ascender / f.upm, descent: f.font.descender / f.upm }; },
    missing(text, family, weight) {
      const f = face(family, weight);
      const out = new Set<string>();
      for (const ch of text) { if (ch === " " || ch === "\n") continue; const g = f.font.charToGlyph(ch); if (!g || g.index === 0) out.add(ch); }
      return [...out];
    },
  };
}

/**
 * An approximate measurer (average glyph widths) for when the fonts have not
 * loaded yet — the preview shows a draft with it; nothing is rendered, checked
 * or exported with it.
 */
export function approximateMeasurer(): Measurer {
  const wide = /[MWmw@%]/, narrow = /[iljtfrI.,:;'!|() ]/;
  return {
    exact: false,
    width(text, _family, weight, size, tracking = 0) {
      let u = 0;
      for (const ch of text) u += wide.test(ch) ? 0.85 : narrow.test(ch) ? 0.3 : /[A-Z0-9]/.test(ch) ? 0.64 : 0.54;
      return u * size * (weight >= 600 ? 1.05 : 1) + Math.max(0, [...text].length - 1) * tracking;
    },
    metrics() { return { ascent: 0.93, descent: -0.24 }; },
    missing() { return []; },
  };
}

/* ------------------------------------------------------------ wrapping */

export interface WrapResult { lines: string[]; widths: number[]; fits: boolean; brokeWord: boolean }

/** greedy word wrap into `maxWidth`; a single word longer than the line is broken at characters (and reported) */
export function wrapText(m: Measurer, text: string, family: FontFamilyId, weight: number, size: number, maxWidth: number, maxLines = Infinity, tracking = 0): WrapResult {
  const lines: string[] = [];
  let brokeWord = false;
  for (const para of text.split("\n")) {
    const words = para.split(/\s+/).filter(Boolean);
    let line = "";
    for (const w of words) {
      const candidate = line ? `${line} ${w}` : w;
      if (m.width(candidate, family, weight, size, tracking) <= maxWidth) { line = candidate; continue; }
      if (line) lines.push(line);
      if (m.width(w, family, weight, size, tracking) <= maxWidth) { line = w; continue; }
      /* a word wider than the line: break it */
      brokeWord = true;
      let part = "";
      for (const ch of w) { if (m.width(part + ch, family, weight, size, tracking) > maxWidth && part) { lines.push(part); part = ch; } else part += ch; }
      line = part;
    }
    lines.push(line);
  }
  const widths = lines.map((l) => m.width(l, family, weight, size, tracking));
  return { lines, widths, fits: lines.length <= maxLines && widths.every((w) => w <= maxWidth + 0.5), brokeWord };
}

export interface FitResult extends WrapResult { size: number; shrunk: boolean }

/**
 * Fit text into a box: wrap at the preferred size, shrink in 2 px steps down
 * to `minSize`, and report whether it fits. Never truncates — text that does
 * not fit at the minimum size is returned whole with `fits: false`, for the
 * quality check to flag.
 */
export function fitText(m: Measurer, text: string, o: { family: FontFamilyId; weight: number; size: number; minSize: number; maxWidth: number; maxHeight: number; lineHeight: number; maxLines?: number; tracking?: number }): FitResult {
  for (let size = o.size; size >= o.minSize; size -= 2) {
    const lh = size * o.lineHeight;
    const maxLines = Math.min(o.maxLines ?? Infinity, Math.max(1, Math.floor((o.maxHeight + 0.5) / lh)));
    const w = wrapText(m, text, o.family, o.weight, size, o.maxWidth, maxLines, o.tracking);
    if (w.fits && !w.brokeWord) return { ...w, size, shrunk: size < o.size };
  }
  const size = o.minSize;
  const w = wrapText(m, text, o.family, o.weight, size, o.maxWidth, Math.max(1, Math.floor(o.maxHeight / (size * o.lineHeight))), o.tracking);
  return { ...w, size, shrunk: true, fits: w.fits && !w.brokeWord };
}

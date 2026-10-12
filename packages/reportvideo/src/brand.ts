/**
 * WHAT A BRAND FILE TELLS US — read on our own server, never sent anywhere.
 *
 * Logos (PNG, JPEG, SVG): the colours that make up the mark, its size, and
 * whether it has a transparent background (a solid white box on a dark
 * slide is the commonest way a logo goes wrong). PowerPoint decks and
 * templates (.pptx/.potx): the theme's colour scheme and its heading and
 * body fonts. PDF guidelines: hex codes and font names written in the
 * document. Font files: the family name and the licence's embedding
 * permission — the report never draws with an uploaded font (it maps it to
 * the nearest bundled open-licence face and says so), which keeps the
 * fonts' licences intact. Anything we cannot read is reported in words.
 */
import { inflateSync } from "node:zlib";
import opentype from "opentype.js";
import { Resvg } from "@resvg/resvg-js";
import { nearestFamily, distinguishable, luminance, type FontFamilyId } from "@rescript/analytics/story";
import { unzip } from "./pptxQa.js";

export interface BrandAnalysis {
  kind: "logo" | "deck" | "guidelines" | "font" | "photo" | "unsupported";
  name: string;
  colors: { hex: string; share: number; role?: string }[];
  fonts: { name: string; mappedTo: FontFamilyId; note: string }[];
  logo?: { dataUri: string; width: number; height: number; transparent: boolean };
  notes: string[];
  problems: string[];
}

const hex2 = (n: number) => n.toString(16).padStart(2, "0");
const toHex = (r: number, g: number, b: number) => `#${hex2(r)}${hex2(g)}${hex2(b)}`.toUpperCase();

function sizeOf(bytes: Uint8Array): { width: number; height: number; type: "png" | "jpeg" | "gif" | "webp" } | null {
  const b = Buffer.from(bytes);
  if (b.length > 24 && b.readUInt32BE(0) === 0x89504e47) return { width: b.readUInt32BE(16), height: b.readUInt32BE(20), type: "png" };
  if (b.length > 10 && b[0] === 0x47 && b[1] === 0x49 && b[2] === 0x46) return { width: b.readUInt16LE(6), height: b.readUInt16LE(8), type: "gif" };
  if (b.length > 30 && b.toString("ascii", 0, 4) === "RIFF" && b.toString("ascii", 8, 12) === "WEBP") {
    const chunk = b.toString("ascii", 12, 16);
    if (chunk === "VP8X") return { width: 1 + b.readUIntLE(24, 3), height: 1 + b.readUIntLE(27, 3), type: "webp" };
    if (chunk === "VP8 ") return { width: b.readUInt16LE(26) & 0x3fff, height: b.readUInt16LE(28) & 0x3fff, type: "webp" };
    if (chunk === "VP8L") { const v = b.readUInt32LE(21); return { width: (v & 0x3fff) + 1, height: ((v >> 14) & 0x3fff) + 1, type: "webp" }; }
  }
  if (b.length > 4 && b[0] === 0xff && b[1] === 0xd8) {
    let p = 2;
    while (p + 9 < b.length) {
      if (b[p] !== 0xff) { p++; continue; }
      const marker = b[p + 1];
      const len = b.readUInt16BE(p + 2);
      if ((marker >= 0xc0 && marker <= 0xc3) || (marker >= 0xc5 && marker <= 0xc7) || (marker >= 0xc9 && marker <= 0xcb) || (marker >= 0xcd && marker <= 0xcf)) return { height: b.readUInt16BE(p + 5), width: b.readUInt16BE(p + 7), type: "jpeg" };
      p += 2 + len;
    }
  }
  return null;
}

/** the colours of an image, by drawing it (resvg decodes PNG, JPEG, GIF, WebP) */
function pixelsOf(svg: string): { pixels: Buffer; width: number; height: number } {
  const img = new Resvg(svg, { font: { loadSystemFonts: false } }).render();
  return { pixels: Buffer.from(img.pixels), width: img.width, height: img.height };
}

function dominant(pixels: Buffer): { colors: { hex: string; share: number }[]; transparent: boolean; whiteBox: boolean } {
  const buckets = new Map<number, { n: number; r: number; g: number; b: number }>();
  let opaque = 0, clear = 0, edgeWhite = 0;
  const total = pixels.length / 4;
  for (let i = 0; i < pixels.length; i += 4) {
    const a = pixels[i + 3];
    if (a < 128) { clear++; continue; }
    opaque++;
    const r = pixels[i], g = pixels[i + 1], b = pixels[i + 2];
    const key = ((r >> 3) << 10) | ((g >> 3) << 5) | (b >> 3);
    const e = buckets.get(key) ?? { n: 0, r: 0, g: 0, b: 0 };
    e.n++; e.r += r; e.g += g; e.b += b; buckets.set(key, e);
  }
  /* the corners tell a white box from a white mark */
  const side = Math.round(Math.sqrt(total));
  for (const idx of [0, side - 1, total - side, total - 1]) { const i = Math.max(0, Math.min(total - 1, idx)) * 4; if (pixels[i + 3] > 200 && pixels[i] > 240 && pixels[i + 1] > 240 && pixels[i + 2] > 240) edgeWhite++; }
  const sorted = [...buckets.values()].sort((a, b) => b.n - a.n).map((e) => ({ hex: toHex(Math.round(e.r / e.n), Math.round(e.g / e.n), Math.round(e.b / e.n)), share: e.n / Math.max(1, opaque) }));
  const picked: { hex: string; share: number }[] = [];
  for (const c of sorted) {
    if (c.share < 0.01 || picked.length >= 6) break;
    const l = luminance(c.hex);
    if (l > 0.93 || l < 0.004) continue; // paper white and pure black are backgrounds and ink, not brand colours
    if (picked.every((p) => distinguishable(p.hex, c.hex))) picked.push({ hex: c.hex, share: Math.round(c.share * 1000) / 1000 });
  }
  return { colors: picked, transparent: clear / total > 0.05, whiteBox: edgeWhite >= 3 };
}

function svgColors(svg: string): string[] {
  const out = new Map<string, number>();
  for (const m of svg.matchAll(/(?:fill|stroke|stop-color|color)\s*[:=]\s*["']?\s*(#[0-9a-fA-F]{3,8})\b/g)) {
    let h = m[1].slice(1);
    if (h.length === 3 || h.length === 4) h = h.slice(0, 3).split("").map((c) => c + c).join("");
    const k = `#${h.slice(0, 6).toUpperCase()}`;
    out.set(k, (out.get(k) ?? 0) + 1);
  }
  return [...out.entries()].sort((a, b) => b[1] - a[1]).map(([k]) => k);
}

function fontEntry(name: string): BrandAnalysis["fonts"][number] {
  const mapped = nearestFamily(name) ?? "Inter";
  return { name, mappedTo: mapped, note: mapped.toLowerCase() === name.toLowerCase() ? "available" : `drawn with ${mapped}, the closest bundled open-licence face` };
}

export function analyzeBrandAsset(bytes: Uint8Array, mimeType: string, name: string): BrandAnalysis {
  const lower = name.toLowerCase();
  const base: BrandAnalysis = { kind: "unsupported", name, colors: [], fonts: [], notes: [], problems: [] };
  try {
    /* SVG logo */
    if (mimeType.includes("svg") || lower.endsWith(".svg")) {
      const text = Buffer.from(bytes).toString("utf8");
      if (/<script|on\w+\s*=|<foreignObject/i.test(text)) return { ...base, problems: ["This SVG contains scripts or embedded HTML and was not used. Export the logo again as a plain SVG or PNG."] };
      const declared = svgColors(text);
      const r = new Resvg(text, { fitTo: { mode: "width", value: 800 }, font: { loadSystemFonts: false } });
      const img = r.render();
      const dom = dominant(Buffer.from(img.pixels));
      const png = Buffer.from(img.asPng());
      const colors = (declared.length ? declared.filter((h) => { const l = luminance(h); return l < 0.93 && l > 0.004; }).slice(0, 6).map((hex) => ({ hex, share: dom.colors.find((c) => c.hex === hex)?.share ?? 0 })) : dom.colors);
      return { ...base, kind: "logo", colors, logo: { dataUri: `data:image/png;base64,${png.toString("base64")}`, width: img.width, height: img.height, transparent: dom.transparent }, notes: [`Logo read from SVG (${colors.length} colour${colors.length === 1 ? "" : "s"}).`] };
    }
    /* raster images */
    const dim = sizeOf(bytes);
    if (dim) {
      const uri = `data:image/${dim.type};base64,${Buffer.from(bytes).toString("base64")}`;
      const scale = Math.min(1, 400 / Math.max(dim.width, dim.height));
      const w = Math.max(1, Math.round(dim.width * scale)), h = Math.max(1, Math.round(dim.height * scale));
      const px = pixelsOf(`<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" width="${w}" height="${h}"><image href="${uri}" width="${w}" height="${h}" preserveAspectRatio="none"/></svg>`);
      const dom = dominant(px.pixels);
      const photo = /photo|image|picture|img_|dsc/i.test(lower) || dim.type === "jpeg" && dim.width >= 1200;
      const problems: string[] = [];
      const notes: string[] = [];
      if (!photo && Math.max(dim.width, dim.height) < 300) problems.push(`The logo is only ${dim.width}×${dim.height} px and will look soft on a 1080p slide. Upload a larger PNG or an SVG.`);
      if (!photo && !dom.transparent && dom.whiteBox) notes.push("This logo has a solid white background. On a light theme that is invisible; on a dark theme it shows as a white box — a transparent PNG or an SVG avoids that.");
      if (photo) return { ...base, kind: "photo", colors: dom.colors.slice(0, 4), notes: [`Photo ${dim.width}×${dim.height} px; its colours can guide the theme. Photos are only used as decoration, never inside a chart.`], problems };
      if (dim.type === "webp" || dim.type === "gif") {
        /* PowerPoint and the frame renderer both take PNG reliably: convert */
        const r = new Resvg(`<svg xmlns="http://www.w3.org/2000/svg" width="${dim.width}" height="${dim.height}"><image href="${uri}" width="${dim.width}" height="${dim.height}"/></svg>`, { font: { loadSystemFonts: false } });
        const png = Buffer.from(r.render().asPng());
        return { ...base, kind: "logo", colors: dom.colors, logo: { dataUri: `data:image/png;base64,${png.toString("base64")}`, width: dim.width, height: dim.height, transparent: dom.transparent }, notes: [...notes, `Converted from ${dim.type.toUpperCase()} to PNG.`], problems };
      }
      return { ...base, kind: "logo", colors: dom.colors, logo: { dataUri: uri, width: dim.width, height: dim.height, transparent: dom.transparent }, notes, problems };
    }
    /* PowerPoint deck or template: the theme */
    if (/\.(pptx|potx|ppsx)$/.test(lower) || mimeType.includes("presentationml")) {
      const zip = unzip(Buffer.from(bytes));
      const themeName = [...zip.keys()].filter((k) => /^ppt\/theme\/theme\d+\.xml$/.test(k)).sort()[0];
      if (!themeName) return { ...base, problems: ["This PowerPoint file has no theme to read colours and fonts from."] };
      const xml = zip.get(themeName)!.toString("utf8");
      const scheme = /<a:clrScheme[^>]*>([\s\S]*?)<\/a:clrScheme>/.exec(xml)?.[1] ?? "";
      const roles = ["dk1", "lt1", "dk2", "lt2", "accent1", "accent2", "accent3", "accent4", "accent5", "accent6"];
      const colors: BrandAnalysis["colors"] = [];
      for (const role of roles) {
        const m = new RegExp(`<a:${role}>[\\s\\S]*?(?:srgbClr val="([0-9A-Fa-f]{6})"|lastClr="([0-9A-Fa-f]{6})")`).exec(scheme);
        const h = m?.[1] ?? m?.[2];
        if (h) colors.push({ hex: `#${h.toUpperCase()}`, share: 0, role });
      }
      const major = /<a:majorFont>[\s\S]*?<a:latin typeface="([^"]*)"/.exec(xml)?.[1];
      const minor = /<a:minorFont>[\s\S]*?<a:latin typeface="([^"]*)"/.exec(xml)?.[1];
      const fonts = [major, minor].filter((f): f is string => !!f && !f.startsWith("+")).map(fontEntry);
      const media = [...zip.keys()].filter((k) => /^ppt\/media\//.test(k)).length;
      return { ...base, kind: "deck", colors: colors.filter((c) => c.role!.startsWith("accent") || c.role === "dk2"), fonts, notes: [`Theme colours and fonts read from “${name}”.`, ...(media ? [`It contains ${media} picture${media === 1 ? "" : "s"}; upload the logo separately to use it.`] : [])] };
    }
    /* PDF guidelines: hex codes and font names */
    if (/\.pdf$/.test(lower) || mimeType === "application/pdf") {
      const b = Buffer.from(bytes);
      const texts: string[] = [b.toString("latin1")];
      for (const m of b.toString("latin1").matchAll(/stream\r?\n/g)) {
        const start = m.index! + m[0].length;
        const end = b.indexOf("endstream", start, "latin1");
        if (end < 0) continue;
        try { texts.push(inflateSync(b.subarray(start, end)).toString("latin1")); } catch { /* not flate */ }
        if (texts.length > 400) break;
      }
      const all = texts.join("\n");
      const hexes = new Map<string, number>();
      for (const m of all.matchAll(/#\s?([0-9A-Fa-f]{6})\b/g)) { const k = `#${m[1].toUpperCase()}`; hexes.set(k, (hexes.get(k) ?? 0) + 1); }
      /* hex written as TJ text arrays: (#1F3A5F) */
      for (const m of all.matchAll(/\(#([0-9A-Fa-f]{6})\)/g)) { const k = `#${m[1].toUpperCase()}`; hexes.set(k, (hexes.get(k) ?? 0) + 1); }
      const fontNames = [...new Set([...all.matchAll(/\/BaseFont\s*\/(?:[A-Z]{6}\+)?([A-Za-z0-9-]+)/g)].map((m) => m[1].replace(/-(Bold|Regular|Italic|Light|Medium|SemiBold|Black|Book)$/i, "").replace(/MT$|PS$/, "")))].slice(0, 4);
      const colors = [...hexes.entries()].sort((a, b) => b[1] - a[1]).map(([hex]) => hex).filter((h) => { const l = luminance(h); return l < 0.93 && l > 0.004; }).slice(0, 6).map((hex) => ({ hex, share: 0 }));
      if (!colors.length && !fontNames.length) return { ...base, kind: "guidelines", problems: ["No colour codes or font names could be read from this PDF (it may be scanned or its text is outlined). Type the brand colours in, or upload the logo."] };
      return { ...base, kind: "guidelines", colors, fonts: fontNames.map(fontEntry), notes: [`${colors.length} colour code${colors.length === 1 ? "" : "s"} and ${fontNames.length} font name${fontNames.length === 1 ? "" : "s"} found in the PDF's text. Check them — a guideline document also mentions colours it does not recommend.`] };
    }
    /* font files */
    if (/\.(ttf|otf|woff)$/.test(lower) || mimeType.startsWith("font/")) {
      const buf = Buffer.from(bytes);
      const f = opentype.parse(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength));
      const family = (f.names.fontFamily?.en ?? Object.values(f.names.fontFamily ?? {})[0] ?? name) as string;
      const fsType = (f.tables.os2 as { fsType?: number } | undefined)?.fsType ?? 0;
      const restricted = (fsType & 0x000e) === 0x0002;
      const licence = ((f.names as unknown as Record<string, Record<string, string>>).license?.en ?? "").slice(0, 160);
      const entry = fontEntry(family);
      return { ...base, kind: "font", fonts: [entry], notes: [
        `Font “${family}”${licence ? ` — licence: ${licence}${licence.length >= 160 ? "…" : ""}` : ""}.`,
        restricted ? "Its licence does not allow embedding, so it is not used in the video or the PowerPoint." : "Uploaded fonts are not drawn into the video or embedded in the PowerPoint — their licences vary.",
        `The report uses ${entry.mappedTo}, the closest bundled open-licence face, and names “${family}” in the theme.`,
      ] };
    }
    return { ...base, problems: [`“${name}” is not a format we can read for branding. Upload a logo (PNG, JPEG, SVG), a PowerPoint template (.pptx), a PDF guideline, or a font file.`] };
  } catch (e) {
    return { ...base, problems: [`“${name}” could not be read (${(e as Error).message.slice(0, 120)}). If it is a logo, export it again as PNG or SVG.`] };
  }
}

/** merge several analyses into the brand input the theme builder takes */
export function brandFrom(analyses: BrandAnalysis[]): { colors: string[]; fonts: { heading?: string; body?: string }; logo: BrandAnalysis["logo"] | null } {
  const colors: string[] = [];
  for (const a of [...analyses].sort((x, y) => (x.kind === "deck" || x.kind === "guidelines" ? -1 : 0) - (y.kind === "deck" || y.kind === "guidelines" ? -1 : 0)))
    for (const c of a.colors) if (colors.every((h) => distinguishable(h, c.hex))) colors.push(c.hex);
  const names = [...new Set(analyses.flatMap((a) => a.fonts.map((f) => f.name)))];
  const fonts = names.length ? { heading: names[0], body: names[1] ?? names[0] } : {};
  const logo = analyses.find((a) => a.kind === "logo" && a.logo)?.logo ?? null;
  return { colors: colors.slice(0, 6), fonts, logo };
}

import JSZip from "jszip";
import type { DeckMaster, ReportTheme } from "../types.js";
export type { DeckMaster };
import { unzipEntries } from "./docxCheck.js";

/**
 * A CLIENT'S POWERPOINT MASTER (Level 5 roadmap R4, 2026-11-22).
 *
 * `readClientMaster` reads a .pptx / .potx the client supplies, on our server, without a model:
 *   - the slide size;
 *   - the theme (colours, heading and body fonts) and the theme part itself;
 *   - the first slide master's background (a colour or a picture) and its pictures with their positions (logos,
 *     bars, artwork drawn as images);
 *   - where its title and body placeholders sit;
 *   - the names of its layouts (reported, not used).
 * `masterTheme` turns that into the deck theme; `buildPptx` with `theme.master` then builds every slide on a master
 * rebuilt from it — the background, the pictures where the client put them, titles where the client's title sits —
 * with native, editable PowerPoint charts in the client's accent colours; `applyClientTheme` puts the client's own
 * theme part into the finished file, so PowerPoint's theme colours and fonts are the client's.
 *
 * What it does NOT carry over is said in `notes`: shapes on the master that are not pictures (drawn lines, text
 * boxes), layouts other than the master itself, and pictures over the size cap.
 */

const EMU = 914400;
export const MAX_MASTER_PICTURE_BYTES = 1_500_000;
export const MAX_MASTER_PICTURES = 8;

const attr = (xml: string, name: string) => new RegExp(`\\b${name}="([^"]*)"`).exec(xml)?.[1];
const box = (xml: string) => {
  const off = /<a:off\s+x="(-?\d+)"\s+y="(-?\d+)"/.exec(xml), ext = /<a:ext\s+cx="(\d+)"\s+cy="(\d+)"/.exec(xml);
  return off && ext ? { x: +off[1] / EMU, y: +off[2] / EMU, w: +ext[1] / EMU, h: +ext[2] / EMU } : undefined;
};
const mime = (name: string) => (/\.png$/i.test(name) ? "image/png" : /\.jpe?g$/i.test(name) ? "image/jpeg" : null);

/** relationship id → target part, for one part's .rels */
function rels(zip: Map<string, Buffer>, part: string): Map<string, string> {
  const dir = part.slice(0, part.lastIndexOf("/"));
  const file = `${dir}/_rels/${part.slice(part.lastIndexOf("/") + 1)}.rels`;
  const xml = zip.get(file)?.toString("utf8") ?? "";
  const out = new Map<string, string>();
  for (const m of xml.matchAll(/<Relationship\b[^>]*>/g)) {
    const id = attr(m[0], "Id"), target = attr(m[0], "Target");
    if (!id || !target) continue;
    const parts = `${dir}/${target}`.split("/"), norm: string[] = [];
    for (const p of parts) { if (p === "..") norm.pop(); else if (p && p !== ".") norm.push(p); }
    out.set(id, target.startsWith("/") ? target.slice(1) : norm.join("/"));
  }
  return out;
}

export function readClientMaster(bytes: Uint8Array, name: string): { master: DeckMaster | null; problems: string[] } {
  let zip: Map<string, Buffer>;
  try { zip = unzipEntries(Buffer.from(bytes)); } catch (e) { return { master: null, problems: [`“${name}” is not a PowerPoint file (${(e as Error).message}).`] }; }
  const pres = zip.get("ppt/presentation.xml")?.toString("utf8");
  if (!pres) return { master: null, problems: [`“${name}” has no presentation part — save it from PowerPoint as .pptx or .potx.`] };
  const notes: string[] = [];
  const sz = /<p:sldSz\b[^>]*>/.exec(pres)?.[0] ?? "";
  const size = { w: Number(attr(sz, "cx") ?? 12192000) / EMU, h: Number(attr(sz, "cy") ?? 6858000) / EMU };

  const presRels = rels(zip, "ppt/presentation.xml");
  const masterId = /<p:sldMasterId\b[^>]*r:id="([^"]+)"/.exec(pres)?.[1];
  const masterPart = (masterId && presRels.get(masterId)) || [...zip.keys()].filter((k) => /^ppt\/slideMasters\/slideMaster\d+\.xml$/.test(k)).sort()[0];
  const mxml = masterPart ? zip.get(masterPart)?.toString("utf8") : undefined;
  if (!mxml || !masterPart) return { master: null, problems: [`“${name}” has no slide master.`] };
  const mrels = rels(zip, masterPart);

  /* the theme: the master's own, else the first */
  const themePart = [...mrels.values()].find((t) => /ppt\/theme\/theme\d+\.xml$/.test(t)) ?? [...zip.keys()].filter((k) => /^ppt\/theme\/theme\d+\.xml$/.test(k)).sort()[0];
  const txml = themePart ? zip.get(themePart)?.toString("utf8") : undefined;
  const scheme = txml ? /<a:clrScheme[^>]*>([\s\S]*?)<\/a:clrScheme>/.exec(txml)?.[1] ?? "" : "";
  const role = (r: string) => { const m = new RegExp(`<a:${r}>[\\s\\S]*?(?:srgbClr val="([0-9A-Fa-f]{6})"|lastClr="([0-9A-Fa-f]{6})")`).exec(scheme); const h = m?.[1] ?? m?.[2]; return h ? `#${h.toUpperCase()}` : undefined; };
  const colors = { dk1: role("dk1"), lt1: role("lt1"), dk2: role("dk2"), lt2: role("lt2"), accents: ["accent1", "accent2", "accent3", "accent4", "accent5", "accent6"].map(role).filter((c): c is string => !!c) };
  const font = (k: "majorFont" | "minorFont") => { const f = txml ? new RegExp(`<a:${k}>[\\s\\S]*?<a:latin typeface="([^"]*)"`).exec(txml)?.[1] : undefined; return f && !f.startsWith("+") ? f : undefined; };
  const fonts = { heading: font("majorFont"), body: font("minorFont") };
  if (!txml) notes.push("The file has no theme part: the deck keeps its own colours and fonts.");

  /*
   * The branding: the master's background, pictures and placeholders. A template that keeps its logo and background
   * on a LAYOUT rather than the master (common) gives them from its content layout ("Title and Content", else the
   * first layout that has any), and says so.
   */
  const fromMaster = readShapes(zip, masterPart, mxml, colors);
  const layoutParts = [...mrels.values()].filter((t) => /slideLayouts\/slideLayout\d+\.xml$/.test(t));
  const layoutName = (t: string) => /<p:cSld\b[^>]*name="([^"]*)"/.exec(zip.get(t)?.toString("utf8") ?? "")?.[1] ?? t.slice(t.lastIndexOf("/") + 1);
  const layouts = layoutParts.map(layoutName).slice(0, 40);
  let shapes = fromMaster;
  if (!fromMaster.pictures.length && !fromMaster.background.image) {
    const read = layoutParts.map((t) => ({ t, sh: readShapes(zip, t, zip.get(t)!.toString("utf8"), colors) }));
    const pick = read.find((x) => /title.*content|content/i.test(layoutName(x.t)) && (x.sh.pictures.length || x.sh.background.image)) ?? read.find((x) => x.sh.pictures.length || x.sh.background.image);
    if (pick) {
      shapes = { ...pick.sh, background: pick.sh.background.color || pick.sh.background.image ? pick.sh.background : fromMaster.background, title: pick.sh.title ?? fromMaster.title, body: pick.sh.body ?? fromMaster.body, notes: pick.sh.notes };
      notes.push(`The master itself has no pictures; the background and pictures come from the layout “${layoutName(pick.t)}”.`);
    }
  }
  notes.push(...shapes.notes);
  const { background, pictures, title, body } = shapes;
  if (layouts.length) notes.push(`${layouts.length} layout${layouts.length === 1 ? "" : "s"} in the file (${layouts.slice(0, 6).join(", ")}${layouts.length > 6 ? ", …" : ""}); every slide is built on one master rebuilt from it.`);

  return { master: { name: name.replace(/\.(pptx|potx)$/i, "").slice(0, 80), size, background, pictures, title, body, colors, fonts, themeXml: txml, layouts, notes }, problems: [] };
}

/** the deck theme for a master: its accents as the chart palette, its fonts, its dark colour as text */
export function masterTheme(m: DeckMaster, base: ReportTheme): ReportTheme {
  const acc = m.colors.accents.length ? m.colors.accents : base.colors.palette;
  /* text must read on the master's background: on a dark one (or a picture whose theme says dark), the light colours */
  const bgColor = m.background.color ?? m.colors.lt1 ?? "#FFFFFF";
  const dark = luminance(bgColor) < 0.35;
  const light = (c: string | undefined, d: string) => (c && luminance(c) > 0.6 ? c : d);
  const textColor = dark ? light(m.colors.lt1, "#FFFFFF") : m.colors.dk1 ?? base.colors.text;
  const subtle = dark ? light(m.colors.lt2, "#C9CED8") : base.colors.subtle;
  return {
    ...base,
    name: m.name || base.name,
    colors: { ...base.colors, primary: acc[0] ?? base.colors.primary, secondary: m.colors.dk2 ?? base.colors.secondary, accent: acc[1] ?? base.colors.accent, background: bgColor, text: textColor, subtle, palette: [...acc, ...base.colors.palette.filter((c) => !acc.includes(c))].slice(0, 10) },
    fontFamily: m.fonts.body ?? base.fontFamily,
    ...(m.fonts.heading ? { headingFontFamily: m.fonts.heading } : {}),
    master: m,
  };
}

/** the client's own theme part in a finished deck (pptxgenjs writes ppt/theme/theme1.xml) */
export async function applyClientTheme(deck: Buffer, themeXml: string | undefined): Promise<Buffer> {
  if (!themeXml || !/<a:theme\b/.test(themeXml)) return deck;
  const zip = await JSZip.loadAsync(deck);
  if (!zip.file("ppt/theme/theme1.xml")) return deck;
  zip.file("ppt/theme/theme1.xml", themeXml);
  return zip.generateAsync({ type: "nodebuffer", compression: "DEFLATE" });
}

type Shapes = { background: DeckMaster["background"]; pictures: DeckMaster["pictures"]; title?: DeckMaster["title"]; body?: DeckMaster["body"]; notes: string[] };

/** one master or layout part: background (a colour or a picture), pictures with positions, placeholder positions */
function readShapes(zip: Map<string, Buffer>, part: string, xml: string, colors: DeckMaster["colors"]): Shapes {
  const notes: string[] = [];
  const r = rels(zip, part);
  const bg = /<p:bg>([\s\S]*?)<\/p:bg>/.exec(xml)?.[1] ?? "";
  const background: DeckMaster["background"] = {};
  const solid = /<a:solidFill>\s*<a:srgbClr val="([0-9A-Fa-f]{6})"/.exec(bg)?.[1];
  const sch = /<a:solidFill>\s*<a:schemeClr val="(\w+)"/.exec(bg)?.[1];
  const byScheme: Record<string, string | undefined> = { bg1: colors.lt1, lt1: colors.lt1, bg2: colors.lt2, lt2: colors.lt2, tx1: colors.dk1, dk1: colors.dk1, tx2: colors.dk2, dk2: colors.dk2, accent1: colors.accents[0], accent2: colors.accents[1] };
  if (solid) background.color = `#${solid.toUpperCase()}`;
  else if (sch) background.color = byScheme[sch];
  const bgPic = /<a:blip\b[^>]*r:embed="([^"]+)"/.exec(bg)?.[1];
  if (bgPic) {
    const target = r.get(bgPic); const data = target ? zip.get(target) : undefined; const m = target ? mime(target) : null;
    if (data && m && data.length <= MAX_MASTER_PICTURE_BYTES) background.image = `data:${m};base64,${data.toString("base64")}`;
    else notes.push(data && data.length > MAX_MASTER_PICTURE_BYTES ? `The background picture is ${(data.length / 1e6).toFixed(1)} MB — over the ${MAX_MASTER_PICTURE_BYTES / 1e6} MB cap, so it is left out; save a smaller one in the master.` : "The background picture is not a PNG or JPEG, so it is left out.");
  }
  if (bg && !background.color && !background.image && /<p:bgRef/.test(bg)) notes.push("The background comes from the theme's background styles (a gradient or pattern), which is not carried over; slides use the theme's light colour.");
  const tree = /<p:spTree>([\s\S]*)<\/p:spTree>/.exec(xml)?.[1] ?? "";
  const pictures: DeckMaster["pictures"] = [];
  let skipped = 0;
  for (const pm of tree.matchAll(/<p:pic>([\s\S]*?)<\/p:pic>/g)) {
    const rid = /<a:blip\b[^>]*r:embed="([^"]+)"/.exec(pm[1])?.[1];
    const target = rid ? r.get(rid) : undefined; const data = target ? zip.get(target) : undefined; const m = target ? mime(target) : null; const b = box(pm[1]);
    if (!data || !m || !b || data.length > MAX_MASTER_PICTURE_BYTES || pictures.length >= MAX_MASTER_PICTURES) { skipped++; continue; }
    pictures.push({ dataUri: `data:${m};base64,${data.toString("base64")}`, ...b });
  }
  if (skipped) notes.push(`${skipped} picture${skipped === 1 ? "" : "s"} could not be carried over (not PNG/JPEG, over ${MAX_MASTER_PICTURE_BYTES / 1e6} MB, or more than ${MAX_MASTER_PICTURES}).`);
  let title: Shapes["title"], body: Shapes["body"], other = 0;
  for (const sm of tree.matchAll(/<p:sp>([\s\S]*?)<\/p:sp>/g)) {
    const ph = /<p:ph\b([^>]*)\/?>/.exec(sm[1]);
    const type = ph ? attr(ph[1], "type") ?? "body" : null;
    if (type === "title" || type === "ctrTitle") title ??= box(sm[1]);
    else if (type === "body" || type === "obj") body ??= box(sm[1]);
    else if (!ph) other++;
  }
  if (other) notes.push(`${other} drawn shape${other === 1 ? "" : "s"} (lines, boxes, text) ${other === 1 ? "is" : "are"} not carried over — only pictures, the background and the placeholder positions are.`);
  return { background, pictures, title, body, notes };
}

/** relative luminance of a #RRGGBB colour (WCAG) */
function luminance(hex: string): number {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex.trim());
  if (!m) return 1;
  const [r, g, b] = [0, 2, 4].map((i) => parseInt(m[1].slice(i, i + 2), 16) / 255).map((c) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4));
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

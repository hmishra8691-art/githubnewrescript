import { inflateSync, inflateRawSync } from "node:zlib";

/**
 * TEXT OUT OF A PDF — lines, in reading order, per page.
 *
 * Enough of the format to read the questionnaires people actually send:
 * cross-reference-free object scanning (so a damaged xref does not matter),
 * object streams (PDF 1.5+, which is what Word's "Save as PDF" writes),
 * FlateDecode, the page tree, fonts' ToUnicode CMaps (so text set in a
 * subset font comes out as text, not glyph ids), and the text operators
 * Tj / TJ / ' / " with the positioning ones that decide where a line ends.
 *
 * What it does NOT do: render, OCR, or decrypt. A scanned questionnaire has
 * no text layer; `extractPdfText` says so (`scanned: true`) so the importer
 * can report that OCR is needed instead of importing nothing silently. An
 * encrypted file is reported the same way.
 */

export interface PdfText { pages: string[][]; scanned: boolean; encrypted: boolean; errors: string[] }

type PdfVal = number | string | boolean | null | PdfName | PdfRef | PdfVal[] | PdfDict | PdfStr;
interface PdfName { n: string }
interface PdfRef { ref: number }
interface PdfStr { s: Uint8Array }
type PdfDict = { [k: string]: PdfVal } & { __dict: true };

const isName = (v: unknown): v is PdfName => !!v && typeof v === "object" && "n" in (v as object);
const isRef = (v: unknown): v is PdfRef => !!v && typeof v === "object" && "ref" in (v as object);
const isDict = (v: unknown): v is PdfDict => !!v && typeof v === "object" && "__dict" in (v as object);
const isStr = (v: unknown): v is PdfStr => !!v && typeof v === "object" && "s" in (v as object);

/* ------------------------------------------------------------ object syntax */

class Lexer {
  i = 0;
  constructor(public b: Uint8Array) {}
  ws() { const b = this.b; while (this.i < b.length) { const c = b[this.i]; if (c === 0x25) { while (this.i < b.length && b[this.i] !== 0x0a && b[this.i] !== 0x0d) this.i++; } else if (c === 0x20 || c === 0x0a || c === 0x0d || c === 0x09 || c === 0x0c || c === 0x00) this.i++; else break; } }
  peek() { this.ws(); return this.b[this.i]; }
  value(): PdfVal | undefined {
    this.ws();
    const b = this.b; const c = b[this.i];
    if (c === undefined) return undefined;
    if (c === 0x2f) { // /Name
      let j = this.i + 1; while (j < b.length && !isDelim(b[j])) j++;
      const n = latin(b.subarray(this.i + 1, j)).replace(/#([0-9a-fA-F]{2})/g, (_, h) => String.fromCharCode(parseInt(h, 16))); this.i = j; return { n };
    }
    if (c === 0x3c && b[this.i + 1] === 0x3c) { // << dict >>
      this.i += 2; const d = { __dict: true } as PdfDict;
      for (;;) { this.ws(); if (b[this.i] === 0x3e && b[this.i + 1] === 0x3e) { this.i += 2; break; } const k = this.value(); if (k === undefined) break; if (!isName(k)) continue; d[k.n] = this.value() ?? null; }
      return d;
    }
    if (c === 0x5b) { this.i++; const arr: PdfVal[] = []; for (;;) { this.ws(); if (b[this.i] === 0x5d) { this.i++; break; } const v = this.value(); if (v === undefined) break; arr.push(v); } return arr; }
    if (c === 0x28) return { s: this.literal() };
    if (c === 0x3c) { let j = this.i + 1; let hex = ""; while (j < b.length && b[j] !== 0x3e) { hex += String.fromCharCode(b[j]); j++; } this.i = j + 1; return { s: hexBytes(hex) }; }
    // number, ref, keyword
    let j = this.i; while (j < b.length && !isDelim(b[j]) && !isWs(b[j])) j++;
    const tok = latin(b.subarray(this.i, j)); this.i = j;
    if (/^[+-]?(\d+\.?\d*|\.\d+)$/.test(tok)) {
      const num = Number(tok);
      // "n g R"
      const save = this.i; this.ws();
      const m = /^(\d+)\s+R(?![A-Za-z])/.exec(latin(b.subarray(this.i, this.i + 16)));
      if (m && Number.isInteger(num)) { this.i += m[0].length; return { ref: num }; }
      this.i = save; return num;
    }
    if (tok === "true") return true; if (tok === "false") return false; if (tok === "null") return null;
    return { n: `@${tok}` }; // an operator/keyword, marked so a dict never mistakes it for a name
  }
  literal(): Uint8Array {
    const b = this.b; const out: number[] = []; let depth = 0; this.i++;
    while (this.i < b.length) {
      const c = b[this.i++];
      if (c === 0x5c) {
        const d = b[this.i++];
        const map: Record<number, number> = { 0x6e: 10, 0x72: 13, 0x74: 9, 0x62: 8, 0x66: 12, 0x28: 0x28, 0x29: 0x29, 0x5c: 0x5c };
        if (d in map) out.push(map[d]);
        else if (d >= 0x30 && d <= 0x37) { let o = d - 0x30; for (let k = 0; k < 2 && b[this.i] >= 0x30 && b[this.i] <= 0x37; k++) o = o * 8 + (b[this.i++] - 0x30); out.push(o & 0xff); }
        else if (d === 0x0d) { if (b[this.i] === 0x0a) this.i++; }
        else if (d !== 0x0a) out.push(d);
      } else if (c === 0x28) { depth++; out.push(c); }
      else if (c === 0x29) { if (depth === 0) break; depth--; out.push(c); }
      else out.push(c);
    }
    return Uint8Array.from(out);
  }
}
const isWs = (c: number) => c === 0x20 || c === 0x0a || c === 0x0d || c === 0x09 || c === 0x0c || c === 0x00;
const isDelim = (c: number) => c === 0x2f || c === 0x3c || c === 0x3e || c === 0x5b || c === 0x5d || c === 0x28 || c === 0x29 || c === 0x7b || c === 0x7d || c === 0x25 || isWs(c);
const latin = (b: Uint8Array) => { let s = ""; for (let i = 0; i < b.length; i++) s += String.fromCharCode(b[i]); return s; };
function hexBytes(hex: string): Uint8Array { const h = hex.replace(/[^0-9a-fA-F]/g, ""); const p = h.length % 2 ? `${h}0` : h; const out = new Uint8Array(p.length / 2); for (let i = 0; i < out.length; i++) out[i] = parseInt(p.slice(i * 2, i * 2 + 2), 16); return out; }

/* ------------------------------------------------------------ objects */

interface PdfObj { value: PdfVal; stream?: Uint8Array }

function inflate(data: Uint8Array): Uint8Array {
  try { return new Uint8Array(inflateSync(data)); } catch { /* fall through */ }
  try { return new Uint8Array(inflateRawSync(data)); } catch { /* fall through */ }
  // a stream truncated by a bad /Length: inflate what we can
  try { return new Uint8Array(inflateSync(data, { finishFlush: 2 /* Z_SYNC_FLUSH */ })); } catch { return new Uint8Array(); }
}

function decodeStream(dict: PdfDict, raw: Uint8Array): Uint8Array | null {
  const f = dict.Filter;
  const filters = Array.isArray(f) ? f : f ? [f] : [];
  let data = raw;
  for (const x of filters) {
    if (!isName(x)) return null;
    if (x.n === "FlateDecode" || x.n === "Fl") data = inflate(data);
    else return null; // DCT (images), LZW, ASCII85… not text we can read
  }
  return data;
}

function scanObjects(bytes: Uint8Array, errors: string[]): Map<number, PdfObj> {
  const objs = new Map<number, PdfObj>();
  const text = latin(bytes);
  const re = /(\d+)\s+(\d+)\s+obj\b/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text))) {
    const num = Number(m[1]);
    const lx = new Lexer(bytes); lx.i = m.index + m[0].length;
    let value: PdfVal | undefined;
    try { value = lx.value(); } catch (e) { errors.push(`object ${num}: ${(e as Error).message}`); continue; }
    if (value === undefined) continue;
    let stream: Uint8Array | undefined;
    lx.ws();
    if (isDict(value) && text.startsWith("stream", lx.i)) {
      let s = lx.i + 6;
      if (bytes[s] === 0x0d) s++;
      if (bytes[s] === 0x0a) s++;
      const len = typeof value.Length === "number" ? value.Length : -1;
      let e = len >= 0 && text.startsWith("endstream", skipWs(text, s + len)) ? s + len : text.indexOf("endstream", s);
      if (e < 0) e = bytes.length;
      stream = bytes.subarray(s, e);
      re.lastIndex = e;
    }
    objs.set(num, { value, stream });
  }
  // compressed object streams (PDF 1.5+): the page and font dictionaries often live in here
  for (const [, o] of [...objs]) {
    if (!isDict(o.value) || !(isName(o.value.Type) && o.value.Type.n === "ObjStm") || !o.stream) continue;
    const data = decodeStream(o.value, o.stream);
    if (!data) continue;
    const n = Number(o.value.N ?? 0), first = Number(o.value.First ?? 0);
    const head = latin(data.subarray(0, first)).trim().split(/\s+/).map(Number);
    for (let k = 0; k < n; k++) {
      const num = head[k * 2], off = head[k * 2 + 1];
      if (!Number.isFinite(num) || objs.has(num)) continue;
      const lx = new Lexer(data); lx.i = first + off;
      try { const v = lx.value(); if (v !== undefined) objs.set(num, { value: v }); } catch { /* skip */ }
    }
  }
  return objs;
}
const skipWs = (t: string, i: number) => { while (i < t.length && /\s/.test(t[i])) i++; return i; };

/* ------------------------------------------------------------ fonts */

interface FontMap { map: Map<number, string>; bytes: 1 | 2 }

function parseCMap(src: string): FontMap {
  const map = new Map<number, string>();
  let bytes: 1 | 2 = 1;
  const cs = /begincodespacerange\s*<([0-9a-fA-F]+)>/.exec(src);
  if (cs && cs[1].length >= 4) bytes = 2;
  const u16 = (hex: string) => { const b = hexBytes(hex); let s = ""; for (let i = 0; i + 1 < b.length; i += 2) s += String.fromCharCode((b[i] << 8) | b[i + 1]); return s; };
  for (const block of src.matchAll(/beginbfchar([\s\S]*?)endbfchar/g)) {
    for (const m of block[1].matchAll(/<([0-9a-fA-F]+)>\s*<([0-9a-fA-F]*)>/g)) map.set(parseInt(m[1], 16), u16(m[2]));
  }
  for (const block of src.matchAll(/beginbfrange([\s\S]*?)endbfrange/g)) {
    for (const m of block[1].matchAll(/<([0-9a-fA-F]+)>\s*<([0-9a-fA-F]+)>\s*(<[0-9a-fA-F]*>|\[[^\]]*\])/g)) {
      const lo = parseInt(m[1], 16), hi = parseInt(m[2], 16);
      if (m[3].startsWith("[")) {
        const items = [...m[3].matchAll(/<([0-9a-fA-F]*)>/g)].map((x) => u16(x[1]));
        for (let c = lo; c <= hi && c - lo < items.length; c++) map.set(c, items[c - lo]);
      } else {
        const base = u16(m[3].slice(1, -1));
        const last = base.charCodeAt(base.length - 1);
        for (let c = lo; c <= hi && c - lo < 65536; c++) map.set(c, base.slice(0, -1) + String.fromCharCode(last + (c - lo)));
      }
    }
  }
  return { map, bytes };
}

/* ------------------------------------------------------------ extraction */

export function extractPdfText(bytes: Uint8Array): PdfText {
  const errors: string[] = [];
  const head = latin(bytes.subarray(0, 1024));
  if (!head.includes("%PDF-")) return { pages: [], scanned: false, encrypted: false, errors: ["not a PDF"] };
  const objs = scanObjects(bytes, errors);
  const get = (v: PdfVal | undefined): PdfVal | undefined => (isRef(v) ? objs.get(v.ref)?.value : v);
  const encrypted = [...objs.values()].some((o) => isDict(o.value) && "Encrypt" in o.value) || /\/Encrypt\s/.test(latin(bytes.subarray(Math.max(0, bytes.length - 4096))));
  if (encrypted) return { pages: [], scanned: false, encrypted: true, errors: ["the PDF is encrypted"] };

  // the page tree, in order; fall back to every /Type /Page in object order
  const catalog = [...objs.values()].find((o) => isDict(o.value) && isName(o.value.Type) && o.value.Type.n === "Catalog");
  const pages: PdfDict[] = [];
  const seen = new Set<PdfVal>();
  const walk = (node: PdfVal | undefined, inherited: PdfVal | undefined) => {
    const d = get(node);
    if (!isDict(d) || seen.has(d)) return;
    seen.add(d);
    const res = d.Resources ?? inherited;
    if (isName(d.Type) && d.Type.n === "Pages" || Array.isArray(get(d.Kids))) { for (const k of (get(d.Kids) as PdfVal[]) ?? []) walk(k, res); return; }
    const page = { ...d } as PdfDict; if (!page.Resources && res) page.Resources = res; pages.push(page);
  };
  if (catalog && isDict(catalog.value)) walk(catalog.value.Pages, undefined);
  if (!pages.length) for (const o of objs.values()) if (isDict(o.value) && isName(o.value.Type) && o.value.Type.n === "Page") pages.push(o.value);

  const fontCache = new Map<PdfVal, FontMap | null>();
  const fontFor = (resources: PdfVal | undefined, name: string): FontMap | null => {
    const res = get(resources); if (!isDict(res)) return null;
    const fonts = get(res.Font); if (!isDict(fonts)) return null;
    const fref = fonts[name];
    const key = isRef(fref) ? fref.ref : fref;
    if (fontCache.has(key as PdfVal)) return fontCache.get(key as PdfVal)!;
    let fm: FontMap | null = null;
    const font = get(fref);
    if (isDict(font) && isRef(font.ToUnicode)) {
      const o = objs.get(font.ToUnicode.ref);
      if (o?.stream && isDict(o.value)) { const data = decodeStream(o.value, o.stream); if (data) fm = parseCMap(latin(data)); }
    }
    if (!fm && isDict(font) && isName(font.Subtype) && font.Subtype.n === "Type0") fm = { map: new Map(), bytes: 2 };
    fontCache.set(key as PdfVal, fm);
    return fm;
  };

  const out: string[][] = [];
  let totalChars = 0;
  for (const page of pages) {
    const contents = get(page.Contents);
    const parts = Array.isArray(contents) ? contents : [page.Contents];
    const chunks: Uint8Array[] = [];
    for (const p of parts) {
      const o = isRef(p) ? objs.get(p.ref) : undefined;
      if (!o?.stream || !isDict(o.value)) continue;
      const d = decodeStream(o.value, o.stream); if (d) chunks.push(d);
    }
    const lines = runContent(concat(chunks), (name) => fontFor(page.Resources, name));
    totalChars += lines.join("").length;
    out.push(lines);
  }
  // pages with (almost) no text layer: a scan, or text set as outlines — OCR's job, not ours
  const scanned = pages.length > 0 && totalChars < 10 * pages.length;
  return { pages: out, scanned, encrypted: false, errors };
}

function concat(chunks: Uint8Array[]): Uint8Array {
  const n = chunks.reduce((t, c) => t + c.length + 1, 0);
  const out = new Uint8Array(n); let o = 0;
  for (const c of chunks) { out.set(c, o); o += c.length; out[o++] = 0x0a; }
  return out;
}

const WINANSI: Record<number, string> = { 0x91: "‘", 0x92: "’", 0x93: "“", 0x94: "”", 0x95: "•", 0x96: "–", 0x97: "—", 0x85: "…", 0x80: "€", 0xa0: " " };

/** interpret a content stream's text operators into lines */
function runContent(data: Uint8Array, font: (name: string) => FontMap | null): string[] {
  const lx = new Lexer(data);
  const lines: string[] = [];
  let line = "";
  let fm: FontMap | null = null;
  let y: number | null = null;
  let lastX: number | null = null;
  const ops: PdfVal[] = [];
  const decode = (s: Uint8Array): string => {
    if (fm && fm.map.size) {
      let t = "";
      if (fm.bytes === 2) for (let i = 0; i + 1 < s.length; i += 2) t += fm.map.get((s[i] << 8) | s[i + 1]) ?? "";
      else for (let i = 0; i < s.length; i++) t += fm.map.get(s[i]) ?? String.fromCharCode(s[i]);
      return t;
    }
    if (fm?.bytes === 2) return ""; // a CID font with no ToUnicode: the codes are glyph ids, not text
    let t = ""; for (let i = 0; i < s.length; i++) t += WINANSI[s[i]] ?? String.fromCharCode(s[i]); return t;
  };
  const newline = () => { const t = line.replace(/\s+/g, " ").trim(); if (t) lines.push(t); line = ""; };
  const moveTo = (ny: number, nx?: number) => {
    if (y !== null && Math.abs(ny - y) > 1.5) newline();
    else if (nx !== undefined && lastX !== null && nx > lastX + 1 && line && !line.endsWith(" ")) line += " ";
    y = ny; if (nx !== undefined) lastX = nx;
  };
  for (;;) {
    const v = lx.value();
    if (v === undefined) break;
    if (!isName(v) || !v.n.startsWith("@")) { ops.push(v); continue; }
    const op = v.n.slice(1);
    const a = ops.splice(0);
    switch (op) {
      case "BT": lastX = null; break;
      case "Tf": if (isName(a[0])) fm = font(a[0].n); break;
      case "Td": case "TD": { const ty = Number(a[1] ?? 0); const tx = Number(a[0] ?? 0); if (Math.abs(ty) > 1.5) { newline(); y = (y ?? 0) + ty; lastX = tx; } else if (tx > 1 && line && !line.endsWith(" ")) line += " "; break; }
      case "Tm": moveTo(Number(a[5] ?? 0), Number(a[4] ?? 0)); break;
      case "T*": newline(); break;
      case "Tj": if (isStr(a[0])) line += decode(a[0].s); break;
      case "'": newline(); if (isStr(a[0])) line += decode(a[0].s); break;
      case "\"": newline(); if (isStr(a[2])) line += decode(a[2].s); break;
      case "TJ": for (const x of (Array.isArray(a[0]) ? a[0] : [])) { if (isStr(x)) line += decode(x.s); else if (typeof x === "number" && x < -180 && !line.endsWith(" ")) line += " "; } break;
      case "ET": break;
      case "BI": { // inline image: skip to EI
        const t = latin(data); const e = t.indexOf("EI", lx.i); lx.i = e < 0 ? data.length : e + 2; break;
      }
      default: break;
    }
  }
  newline();
  return lines;
}

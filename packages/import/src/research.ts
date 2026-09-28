import ExcelJS from "exceljs";
import { extractPdfText, type PdfImage } from "./pdf.js";
import { readDocx } from "./adapters/docx.js";
import { detectFormat } from "./detect.js";
import { isZip } from "./zip.js";

/**
 * RESEARCH MATERIAL FOR THE COPILOT — papers, reports, briefs, methodology
 * notes, questionnaires — turned into something a model can be given a
 * piece of at a time.
 *
 *   extractResearchDocument(bytes, name)   text by page, with headings kept,
 *                                          tables kept as tables, and — for a
 *                                          scanned PDF — the page images, so
 *                                          the caller can OCR them
 *   chunkResearchDocument(doc)             ~1,200-character passages on
 *                                          paragraph boundaries, each with its
 *                                          page and the heading it sits under
 *   ResearchIndex / retrieve(query, k)     BM25 over the passages (and cosine
 *                                          over embeddings, when the caller has
 *                                          them): only the passages a request
 *                                          needs are ever sent to a model
 *
 * Deterministic and model-free: extraction and retrieval cost nothing.
 * Summarising and OCR use the model and live with the caller, metered.
 */

export interface ResearchPage { n: number; text: string }
export interface ResearchTable { page?: number; caption?: string; rows: string[][] }
export interface ExtractedResearch {
  name: string;
  format: "pdf" | "docx" | "text" | "xlsx" | "csv" | "unknown";
  pages: ResearchPage[];
  tables: ResearchTable[];
  /** a PDF with no text layer on some or all pages */
  scanned: boolean;
  /** page images for OCR (scanned PDFs only) */
  images: PdfImage[];
  chars: number;
  warnings: string[];
}

const dec = new TextDecoder("utf-8", { fatal: false });

export async function extractResearchDocument(bytes: Uint8Array, name: string): Promise<ExtractedResearch> {
  const base = { name, pages: [] as ResearchPage[], tables: [] as ResearchTable[], scanned: false, images: [] as PdfImage[], chars: 0, warnings: [] as string[] };
  const detected = detectFormat(bytes, name);
  const fmt = detected.format;
  if (fmt === "pdf") {
    const pdf = extractPdfText(bytes, { images: true });
    if (pdf.encrypted) return { ...base, format: "pdf", warnings: ["The PDF is encrypted; its text cannot be read. Export an unprotected copy."] };
    const pages = pdf.pages.map((lines, i) => ({ n: i + 1, text: joinLines(lines) }));
    const textless = pages.filter((p) => p.text.replace(/\s/g, "").length < 20).map((p) => p.n);
    const images = pdf.images ?? [];
    const noImage = textless.filter((n) => !images.some((im) => im.page === n));
    const warnings = [...pdf.errors.slice(0, 3)];
    if (noImage.length) warnings.push(`Page${noImage.length === 1 ? "" : "s"} ${noImage.join(", ")} ha${noImage.length === 1 ? "s" : "ve"} no text and no image OCR can read.`);
    return { ...base, format: "pdf", pages, scanned: textless.length > 0, images, chars: pages.reduce((n, p) => n + p.text.length, 0), warnings };
  }
  if (fmt === "docx") {
    const { blocks, errors } = readDocx(bytes);
    const pages: ResearchPage[] = [];
    const tables: ResearchTable[] = [];
    let cur: string[] = [];
    let n = 1;
    let lastPara = "";
    const flush = () => { const t = cur.join("\n").trim(); if (t) pages.push({ n, text: t }); cur = []; };
    for (const b of blocks) {
      if (b.kind === "table") {
        tables.push({ page: n, caption: /^table\b/i.test(lastPara) ? lastPara : undefined, rows: b.rows });
        cur.push(tableText(b.rows));
        continue;
      }
      if (b.pageBreakBefore && cur.length) { flush(); n++; }
      const heading = /^heading|^title/.test(b.style ?? "");
      cur.push(heading ? `## ${b.text}` : b.list ? `- ${b.text}` : b.text);
      lastPara = b.text;
    }
    flush();
    return { ...base, format: "docx", pages, tables, chars: pages.reduce((k, p) => k + p.text.length, 0), warnings: errors.slice(0, 3) };
  }
  if (fmt === "xlsx") {
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(Buffer.from(bytes) as never);
    const tables: ResearchTable[] = [];
    const pages: ResearchPage[] = [];
    wb.eachSheet((ws, i) => {
      const rows: string[][] = [];
      ws.eachRow({ includeEmpty: false }, (row) => { const vals = (row.values as unknown[]).slice(1).map((v) => cell(v)); if (vals.some(Boolean)) rows.push(vals); });
      if (!rows.length) return;
      tables.push({ page: i, caption: ws.name, rows });
      pages.push({ n: i, text: `## ${ws.name}\n${tableText(rows)}` });
    });
    return { ...base, format: "xlsx", pages, tables, chars: pages.reduce((k, p) => k + p.text.length, 0) };
  }
  if (isZip(bytes) || fmt === "unknown" && /[\x00-\x08]/.test(dec.decode(bytes.subarray(0, 512)))) {
    return { ...base, format: "unknown", warnings: [`${name} is not a document this reader understands (${detected.label}). Upload PDF, Word, Excel, CSV or text.`] };
  }
  // text, markdown, CSV, and anything else that decodes as text; form feeds are page breaks
  const text = dec.decode(bytes).replace(/^﻿/, "").replace(/\r\n?/g, "\n");
  const pages = text.split("\f").map((t, i) => ({ n: i + 1, text: t.trim() })).filter((p) => p.text);
  const tables: ResearchTable[] = [];
  if (fmt === "csv") {
    const d = [",", ";", "\t", "|"].sort((a, b) => text.split("\n")[0].split(b).length - text.split("\n")[0].split(a).length)[0];
    tables.push({ rows: text.split("\n").filter((l) => l.trim()).slice(0, 500).map((l) => l.split(d).map((c) => c.replace(/^"|"$/g, "").trim())) });
  }
  return { ...base, format: fmt === "csv" ? "csv" : "text", pages, tables, chars: text.length };
}

function joinLines(lines: string[]): string {
  // PDF lines are visual lines: join those that continue a sentence, keep paragraph breaks
  const out: string[] = [];
  for (const l of lines.map((x) => x.replace(/\s+/g, " ").trim())) {
    if (!l) { out.push(""); continue; }
    const prev = out[out.length - 1];
    if (prev && !/[.:;!?)]$/.test(prev) && /^[a-z(]/.test(l)) out[out.length - 1] = prev.endsWith("-") ? prev.slice(0, -1) + l : `${prev} ${l}`;
    else out.push(l);
  }
  return out.join("\n").replace(/\n{3,}/g, "\n\n").trim();
}
const cell = (v: unknown): string => {
  if (v == null) return "";
  if (typeof v === "object") { const o = v as { text?: string; result?: unknown; richText?: { text: string }[] }; if (o.richText) return o.richText.map((r) => r.text).join(""); if (o.text) return String(o.text); if (o.result !== undefined) return String(o.result); }
  return String(v).trim();
};
function tableText(rows: string[][]): string {
  return rows.slice(0, 80).map((r) => `| ${r.map((c) => c.replace(/\s+/g, " ").trim()).join(" | ")} |`).join("\n");
}

/* ------------------------------------------------------------ chunks */

export interface ResearchChunk {
  /** `${docId}#${seq}` — what a model cites */
  id: string;
  docId: string;
  seq: number;
  page: number;
  heading?: string;
  kind: "text" | "table";
  text: string;
}

export function chunkResearchDocument(docId: string, doc: Pick<ExtractedResearch, "pages" | "tables">, opts: { target?: number; max?: number } = {}): ResearchChunk[] {
  const target = opts.target ?? 1200, max = opts.max ?? 2000;
  const chunks: ResearchChunk[] = [];
  let seq = 0;
  let heading: string | undefined;
  const push = (page: number, text: string, kind: ResearchChunk["kind"] = "text") => {
    const t = text.trim(); if (!t) return;
    chunks.push({ id: `${docId}#${++seq}`, docId, seq, page, ...(heading ? { heading } : {}), kind, text: t });
  };
  for (const p of doc.pages) {
    let buf = "";
    for (const para of blocksOf(p.text)) {
      const x = para.trim(); if (!x) continue;
      if (x.startsWith("## ")) { push(p.n, buf); buf = ""; heading = x.slice(3).trim(); continue; }
      if (x.startsWith("| ")) { push(p.n, buf); buf = ""; push(p.n, x, "table"); continue; }
      if (buf.length + x.length + 2 > target && buf) { push(p.n, buf); buf = ""; }
      if (x.length > max) { for (const piece of splitLong(x, target)) push(p.n, piece); continue; }
      buf = buf ? `${buf}\n\n${x}` : x;
    }
    push(p.n, buf);
  }
  return chunks;
}
/** paragraphs (blank-line separated), headings on their own, and each run of table rows as one block */
function blocksOf(text: string): string[] {
  const out: string[] = [];
  let buf: string[] = [];
  let table = false;
  const flush = () => { if (buf.length) out.push(buf.join("\n")); buf = []; };
  for (const line of text.split("\n")) {
    const isTable = line.trim().startsWith("| ");
    if (!line.trim()) { flush(); table = false; continue; }
    if (line.startsWith("## ")) { flush(); out.push(line); table = false; continue; }
    if (isTable !== table) { flush(); table = isTable; }
    buf.push(line);
  }
  flush();
  return out;
}

function splitLong(text: string, target: number): string[] {
  const out: string[] = [];
  let cur = "";
  for (const s of text.split(/(?<=[.!?])\s+/)) {
    if (cur.length + s.length + 1 > target && cur) { out.push(cur); cur = ""; }
    cur = cur ? `${cur} ${s}` : s;
  }
  if (cur) out.push(cur);
  return out;
}

/* ------------------------------------------------------------ retrieval */

const STOP = new Set("a an the and or of to in on for with by at from as is are was were be been being this that these those it its their there which who whom what when where how why not no than then so such can could may might will would should do does did has have had into over under about between among our we you your they them he she his her i me my also more most very".split(" "));
export function tokens(text: string): string[] {
  return text.toLowerCase().normalize("NFKD").replace(/[̀-ͯ]/g, "").split(/[^\p{L}\p{N}]+/u).filter((w) => w.length > 1 && !STOP.has(w)).map(stem);
}
function stem(w: string): string {
  if (w.length <= 4) return w;
  return w.replace(/(?:ies)$/, "y").replace(/(?:ing|edly|ed|ly|es|s)$/, "").replace(/(?:ation|ational)$/, "ate");
}

export interface Retrieved { chunk: ResearchChunk; score: number }

/**
 * BM25 over the passages, blended with cosine similarity when embeddings
 * are supplied (the caller computes them; this never calls a model). A
 * query that names a document ("the client brief") boosts that document.
 */
export class ResearchIndex {
  private df = new Map<string, number>();
  private tf: Map<string, number>[] = [];
  private len: number[] = [];
  private avg = 1;
  constructor(readonly chunks: ResearchChunk[], private embeddings?: Map<string, number[]>) {
    for (const c of chunks) {
      const t = tokens(`${c.heading ?? ""} ${c.text}`);
      const m = new Map<string, number>();
      for (const w of t) m.set(w, (m.get(w) ?? 0) + 1);
      for (const w of m.keys()) this.df.set(w, (this.df.get(w) ?? 0) + 1);
      this.tf.push(m); this.len.push(t.length);
    }
    this.avg = this.len.reduce((a, b) => a + b, 0) / Math.max(1, this.len.length) || 1;
  }
  retrieve(query: string, k = 6, opts: { queryEmbedding?: number[]; docBoost?: Map<string, number>; maxChars?: number } = {}): Retrieved[] {
    const q = [...new Set(tokens(query))];
    const N = this.chunks.length;
    const scored = this.chunks.map((chunk, i) => {
      let s = 0;
      for (const w of q) {
        const f = this.tf[i].get(w); if (!f) continue;
        const idf = Math.log(1 + (N - (this.df.get(w) ?? 0) + 0.5) / ((this.df.get(w) ?? 0) + 0.5));
        s += idf * (f * 2.2) / (f + 1.2 * (0.25 + 0.75 * this.len[i] / this.avg));
      }
      const e = opts.queryEmbedding && this.embeddings?.get(chunk.id);
      if (e) s = s * 0.5 + cosine(opts.queryEmbedding!, e) * 10;
      s *= opts.docBoost?.get(chunk.docId) ?? 1;
      return { chunk, score: s };
    }).filter((x) => x.score > 0).sort((a, b) => b.score - a.score);
    const out: Retrieved[] = [];
    let chars = 0;
    for (const r of scored) {
      if (out.length >= k) break;
      if (opts.maxChars && chars + r.chunk.text.length > opts.maxChars && out.length) break;
      out.push(r); chars += r.chunk.text.length;
    }
    return out;
  }
}
export function cosine(a: number[], b: number[]): number {
  let d = 0, x = 0, y = 0;
  for (let i = 0; i < Math.min(a.length, b.length); i++) { d += a[i] * b[i]; x += a[i] * a[i]; y += b[i] * b[i]; }
  return x && y ? d / Math.sqrt(x * y) : 0;
}

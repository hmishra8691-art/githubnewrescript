/**
 * A SMALL PDF WRITER (Respondent Intelligence Engine, phase 2, 2026-11-20) — for reports that are text, rules and
 * bars: a respondent's personal report. No dependency, no font file, runs anywhere (it returns bytes).
 *
 * WHAT IT CAN AND CANNOT WRITE. It uses the two fonts every PDF reader has (Helvetica and Helvetica Bold) in the
 * Western European encoding. So it can write English, French, German, Spanish, Portuguese, Italian, Dutch and the
 * Nordic languages — and it CANNOT write Hindi, Arabic, Chinese, Greek, Cyrillic or any other script. It never
 * writes a "?" in place of a letter: `pdfCanWrite(text)` says in advance whether a text fits, and `PdfDoc` throws
 * on one that does not. A caller with such a text offers the browser's "Print → Save as PDF" instead, which
 * handles every script.
 */
const CP1252_EXTRA: Record<string, number> = {
  "€": 0x80, "‚": 0x82, "ƒ": 0x83, "„": 0x84, "…": 0x85, "†": 0x86, "‡": 0x87, "ˆ": 0x88, "‰": 0x89, "Š": 0x8a, "‹": 0x8b, "Œ": 0x8c, "Ž": 0x8e,
  "‘": 0x91, "’": 0x92, "“": 0x93, "”": 0x94, "•": 0x95, "–": 0x96, "—": 0x97, "˜": 0x98, "™": 0x99, "š": 0x9a, "›": 0x9b, "œ": 0x9c, "ž": 0x9e, "Ÿ": 0x9f,
};
/* symbols with a plain equivalent, so a "≥" in a note does not rule the whole report out */
const PLAIN: Record<string, string> = { " ": " ", " ": " ", " ": " ", "→": "->", "←": "<-", "≥": ">=", "≤": "<=", "≠": "!=", "−": "-", "‑": "-", "‐": "-", "­": "", "​": "", "﻿": "", "\t": "    " };

/** the text as it will be written: whitespace tidied and a few symbols spelled out */
export function pdfText(s: string): string {
  return String(s ?? "").normalize("NFC").replace(/[   →←≥≤≠−‑‐­​﻿\t]/g, (c) => PLAIN[c] ?? c).replace(/\r\n?/g, "\n");
}
const byteOf = (ch: string): number | null => {
  const c = ch.codePointAt(0)!;
  if (c === 10) return 10;
  if (c >= 32 && c <= 126) return c;
  if (c >= 0xa0 && c <= 0xff) return c;
  return CP1252_EXTRA[ch] ?? null;
};
/** can every character of this text be written? (false for any script outside Western European) */
export function pdfCanWrite(s: string): boolean {
  for (const ch of pdfText(s)) if (byteOf(ch) === null) return false;
  return true;
}

/* advance widths (1/1000 em) of characters 32–126 */
const W_REGULAR = [278, 278, 355, 556, 556, 889, 667, 191, 333, 333, 389, 584, 278, 333, 278, 278, 556, 556, 556, 556, 556, 556, 556, 556, 556, 556, 278, 278, 584, 584, 584, 556, 1015, 667, 667, 722, 722, 667, 611, 778, 722, 278, 500, 667, 556, 833, 722, 778, 667, 778, 722, 667, 611, 722, 667, 944, 667, 667, 611, 278, 278, 278, 469, 556, 333, 556, 556, 500, 556, 556, 278, 556, 556, 222, 222, 500, 222, 833, 556, 556, 556, 556, 333, 500, 278, 556, 500, 722, 500, 500, 500, 334, 260, 334, 584];
const W_BOLD = [278, 333, 474, 556, 556, 889, 722, 238, 333, 333, 389, 584, 278, 333, 278, 278, 556, 556, 556, 556, 556, 556, 556, 556, 556, 556, 333, 333, 584, 584, 584, 611, 975, 722, 722, 722, 722, 667, 611, 778, 722, 278, 556, 722, 611, 833, 722, 778, 667, 778, 722, 667, 611, 722, 667, 944, 667, 667, 611, 333, 278, 333, 584, 556, 333, 556, 611, 556, 611, 556, 333, 611, 611, 278, 278, 556, 278, 889, 611, 611, 611, 611, 389, 556, 333, 611, 556, 778, 556, 556, 500, 389, 280, 389, 584];

/** the width of a text in points; accented letters are measured as a wide letter, so a line never overflows */
export function pdfTextWidth(s: string, size: number, bold = false): number {
  const w = bold ? W_BOLD : W_REGULAR;
  let total = 0;
  for (const ch of s) { const c = ch.codePointAt(0)!; total += c >= 32 && c <= 126 ? w[c - 32]! : bold ? 722 : 667; }
  return (total / 1000) * size;
}

export type Rgb = [number, number, number];
export interface TextStyle { size?: number; bold?: boolean; color?: Rgb; indent?: number; gapAfter?: number; align?: "left" | "right" }

const PAGE_W = 595.28, PAGE_H = 841.89, MARGIN = 54, FOOT = 40;
const INK: Rgb = [0.09, 0.13, 0.18], MUTED: Rgb = [0.36, 0.4, 0.46];
const n = (x: number) => (Math.round(x * 100) / 100).toString();
const rgb = (c: Rgb) => `${n(c[0])} ${n(c[1])} ${n(c[2])}`;

function literal(s: string): string {
  let out = "(";
  for (const ch of s) {
    const b = byteOf(ch);
    if (b === null) throw new Error(`pdf: the character ${JSON.stringify(ch)} cannot be written`);
    if (b === 0x28 || b === 0x29 || b === 0x5c) out += `\\${String.fromCharCode(b)}`;
    else if (b >= 32 && b <= 126) out += String.fromCharCode(b);
    else out += `\\${b.toString(8).padStart(3, "0")}`;
  }
  return `${out})`;
}

export class PdfDoc {
  private pages: string[][] = [[]];
  private y = PAGE_H - MARGIN;
  readonly width = PAGE_W - 2 * MARGIN;
  constructor(private meta: { title: string; footer?: string }) {}

  private get ops() { return this.pages[this.pages.length - 1]!; }
  /** start a new page unless `height` still fits on this one */
  need(height: number): void {
    if (this.y - height >= MARGIN + FOOT) return;
    this.pages.push([]);
    this.y = PAGE_H - MARGIN;
  }
  space(h: number): void { this.y -= h; }

  private put(line: string, x: number, size: number, bold: boolean, color: Rgb): void {
    this.ops.push(`BT /F${bold ? 2 : 1} ${n(size)} Tf ${rgb(color)} rg ${n(x)} ${n(this.y)} Td ${literal(line)} Tj ET`);
  }

  /** words wrapped to the width; a word longer than a line is broken */
  wrap(text: string, size: number, bold: boolean, width: number): string[] {
    const lines: string[] = [];
    for (const para of pdfText(text).split("\n")) {
      let line = "";
      for (const raw of para.split(/ +/)) {
        let word = raw;
        while (pdfTextWidth(word, size, bold) > width) {
          let cut = word.length - 1;
          while (cut > 1 && pdfTextWidth(word.slice(0, cut), size, bold) > width) cut--;
          if (line) { lines.push(line); line = ""; }
          lines.push(word.slice(0, cut)); word = word.slice(cut);
        }
        const next = line ? `${line} ${word}` : word;
        if (pdfTextWidth(next, size, bold) <= width) line = next;
        else { lines.push(line); line = word; }
      }
      lines.push(line);
    }
    return lines;
  }

  text(text: string, style: TextStyle = {}): void {
    const size = style.size ?? 10.5, bold = !!style.bold, indent = style.indent ?? 0;
    const lead = size * 1.38;
    for (const line of this.wrap(text, size, bold, this.width - indent)) {
      this.need(lead);
      this.y -= lead;
      const x = style.align === "right" ? MARGIN + this.width - pdfTextWidth(line, size, bold) : MARGIN + indent;
      if (line) this.put(line, x, size, bold, style.color ?? INK);
    }
    this.y -= style.gapAfter ?? 0;
  }

  /** a label on the left and a value on the right of the same line */
  pair(left: string, right: string, style: TextStyle = {}): void {
    const size = style.size ?? 12, lead = size * 1.38;
    const rw = pdfTextWidth(pdfText(right), size, true);
    const lines = this.wrap(left, size, true, this.width - rw - 12);
    this.need(lead * lines.length);
    lines.forEach((line, i) => {
      this.y -= lead;
      this.put(line, MARGIN, size, true, style.color ?? INK);
      if (i === 0 && right) this.put(pdfText(right), MARGIN + this.width - rw, size, true, style.color ?? INK);
    });
    this.y -= style.gapAfter ?? 0;
  }

  rule(): void {
    this.need(10);
    this.y -= 6;
    this.ops.push(`0.88 0.9 0.93 rg ${n(MARGIN)} ${n(this.y)} ${n(this.width)} 0.7 re f`);
    this.y -= 4;
  }

  /** a bar filled to `percent`, with an optional line at `mark` (both 0–100) */
  bar(percent: number, mark: number | null = null, fill: Rgb = [0.12, 0.31, 0.85]): void {
    const h = 8;
    this.need(h + 12);
    this.y -= h + 6;
    const p = Math.min(100, Math.max(0, percent));
    this.ops.push(`0.9 0.92 0.94 rg ${n(MARGIN)} ${n(this.y)} ${n(this.width)} ${h} re f`);
    if (p > 0) this.ops.push(`${rgb(fill)} rg ${n(MARGIN)} ${n(this.y)} ${n((this.width * p) / 100)} ${h} re f`);
    if (mark !== null) this.ops.push(`${rgb(INK)} rg ${n(MARGIN + (this.width * Math.min(100, Math.max(0, mark))) / 100 - 0.9)} ${n(this.y - 3)} 1.8 ${h + 6} re f`);
    this.y -= 6;
  }

  get pageCount() { return this.pages.length; }

  bytes(): Uint8Array {
    const objects: string[] = [];
    const add = (body: string) => { objects.push(body); return objects.length; };
    const catalog = add(""), pagesId = add("");
    const f1 = add("<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>");
    const f2 = add("<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold /Encoding /WinAnsiEncoding >>");
    const kids: number[] = [];
    this.pages.forEach((ops, i) => {
      const foot = `${this.meta.footer ? `${this.meta.footer}   ·   ` : ""}Page ${i + 1} of ${this.pages.length}`;
      const footOp = `BT /F1 8.5 Tf ${rgb(MUTED)} rg ${n(MARGIN)} ${n(MARGIN - 14)} Td ${literal(pdfText(foot))} Tj ET`;
      const stream = [...ops, footOp].join("\n");
      const content = add(`<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`);
      kids.push(add(`<< /Type /Page /Parent ${pagesId} 0 R /MediaBox [0 0 ${PAGE_W} ${PAGE_H}] /Resources << /Font << /F1 ${f1} 0 R /F2 ${f2} 0 R >> >> /Contents ${content} 0 R >>`));
    });
    objects[catalog - 1] = `<< /Type /Catalog /Pages ${pagesId} 0 R >>`;
    objects[pagesId - 1] = `<< /Type /Pages /Kids [${kids.map((k) => `${k} 0 R`).join(" ")}] /Count ${kids.length} >>`;
    const info = add(`<< /Title ${literal(pdfText(this.meta.title).replace(/\n/g, " "))} /Producer (Rescript) >>`);

    /* every byte written is 7-bit (other letters are octal escapes), so string length is byte length */
    let out = "%PDF-1.4\n";
    const offsets: number[] = [];
    objects.forEach((body, i) => { offsets.push(out.length); out += `${i + 1} 0 obj\n${body}\nendobj\n`; });
    const xref = out.length;
    out += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${offsets.map((o) => `${String(o).padStart(10, "0")} 00000 n \n`).join("")}`;
    out += `trailer\n<< /Size ${objects.length + 1} /Root ${catalog} 0 R /Info ${info} 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
    const bytes = new Uint8Array(out.length);
    for (let i = 0; i < out.length; i++) bytes[i] = out.charCodeAt(i);
    return bytes;
  }
}

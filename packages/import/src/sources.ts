import ExcelJS from "exceljs";
import { detectFormat, splitDelimited, type Detection } from "./detect.js";
import { fingerprint, type CanonicalSurvey, type Issue } from "./canonical.js";
import { readQsf } from "./adapters/qsf.js";
import { readDecipher } from "./adapters/decipher.js";
import { readDocx, type DocBlock } from "./adapters/docx.js";
import { readDocument } from "./adapters/document.js";
import { readTable } from "./adapters/table.js";
import { extractPdfText } from "./pdf.js";

/**
 * THE SOURCE ADAPTER LAYER (§41): bytes → detection → the right adapter →
 * a CanonicalSurvey. Adding a platform is one adapter and one line in the
 * switch below; the mapper, the validation and the report do not change.
 */
export interface ReadResult { detection: Detection; canonical: CanonicalSurvey | null; issues: Issue[] }

export async function readSource(bytes: Uint8Array, fileName: string): Promise<ReadResult> {
  const detection = detectFormat(bytes, fileName);
  const fp = fingerprint(bytes);
  const meta = { fileName, format: detection.format, fingerprint: fp };
  const text = () => new TextDecoder("utf-8").decode(bytes).replace(/^﻿/, "");
  try {
    switch (detection.format) {
      case "qsf": return { detection, canonical: readQsf(text(), fileName, fp), issues: [] };
      case "decipher": return { detection, canonical: readDecipher(text(), fileName, fp), issues: [] };
      case "docx": {
        const { blocks, errors } = readDocx(bytes);
        const c = readDocument(blocks, meta);
        for (const e of errors) c.issues.push({ location: fileName, type: "parse", severity: "low", message: `Word XML: ${e}`, autoAttempted: true });
        return { detection, canonical: c, issues: [] };
      }
      case "pdf": {
        const pdf = extractPdfText(bytes);
        if (pdf.encrypted) return { detection, canonical: null, issues: [{ location: fileName, type: "unsupported", severity: "high", message: "The PDF is encrypted, so its text cannot be read.", suggestion: "Remove the password (print to a new PDF) and upload again.", autoAttempted: false }] };
        if (pdf.scanned) return { detection, canonical: null, issues: [{ location: fileName, type: "unsupported", severity: "high", message: `The PDF has no text layer (${pdf.pages.length} page${pdf.pages.length === 1 ? "" : "s"} of images) — it is a scan.`, suggestion: "OCR is not configured on this Studio. Upload the original Word file, or run the PDF through OCR first.", autoAttempted: false }] };
        const blocks: DocBlock[] = pdf.pages.flatMap((lines) => lines.filter((l) => !/^\s*(?:page\s*)?\d+\s*(?:of\s*\d+)?\s*$/i.test(l)).map((t) => ({ kind: "para" as const, text: t })));
        const c = readDocument(blocks, meta);
        c.issues.push({ location: fileName, type: "inferred", severity: "info", message: `Read ${pdf.pages.length} PDF page${pdf.pages.length === 1 ? "" : "s"} of text. PDF layout (columns, tables) is flattened to lines, so check grids and multi-column option lists.`, autoAttempted: true });
        return { detection, canonical: c, issues: [] };
      }
      case "xlsx": {
        const wb = new ExcelJS.Workbook();
        await wb.xlsx.load(Buffer.from(bytes) as never);
        const sheets = wb.worksheets.map((ws) => {
          const rows: string[][] = [];
          ws.eachRow({ includeEmpty: true }, (row) => { const r: string[] = []; row.eachCell({ includeEmpty: true }, (cell, col) => { r[col - 1] = cellText(cell); }); rows.push(Array.from(r, (x) => x ?? "")); });
          return { name: ws.name, rows };
        });
        return { detection, canonical: readTable(sheets, meta), issues: [] };
      }
      case "csv": {
        const t = text();
        const first = t.split(/\r?\n/).find((l) => l.trim()) ?? "";
        const delim = ["\t", ";", ","].sort((a, b) => splitDelimited(first, b).length - splitDelimited(first, a).length)[0];
        const rows = splitCsvRows(t).map((l) => splitDelimited(l, delim));
        return { detection, canonical: readTable([{ name: fileName, rows }], meta), issues: [] };
      }
      case "text": {
        const blocks: DocBlock[] = text().split(/\r?\n/).map((t) => ({ kind: "para" as const, text: t })).filter((b) => b.text.trim());
        return { detection, canonical: readDocument(blocks, meta), issues: [] };
      }
      default:
        return { detection, canonical: null, issues: [{ location: fileName, type: "unsupported", severity: "high", message: `This file could not be imported: ${detection.label}.`, suggestion: "Supported: Qualtrics .qsf, Decipher .xml, Word .docx, Excel .xlsx, CSV, PDF and plain-text questionnaires.", autoAttempted: false }] };
    }
  } catch (e) {
    return { detection, canonical: null, issues: [{ location: fileName, type: "parse", severity: "high", message: `The ${detection.label} could not be read: ${(e as Error).message}`, autoAttempted: true }] };
  }
}

function cellText(cell: ExcelJS.Cell): string {
  const v = cell.value as unknown;
  if (v === null || v === undefined) return "";
  if (typeof v === "object") {
    const o = v as { richText?: { text: string }[]; text?: string; result?: unknown; formula?: string };
    if (o.richText) return o.richText.map((x) => x.text).join("");
    if (o.text !== undefined) return String(o.text);
    if (o.result !== undefined) return String(o.result);
    if (v instanceof Date) return v.toISOString().slice(0, 10);
  }
  return String(v);
}

/** CSV rows, honouring quoted newlines */
function splitCsvRows(t: string): string[] {
  const out: string[] = []; let cur = ""; let q = false;
  for (let i = 0; i < t.length; i++) {
    const c = t[i];
    if (c === '"') { q = !q; cur += c; }
    else if ((c === "\n" || c === "\r") && !q) { if (c === "\r" && t[i + 1] === "\n") i++; out.push(cur); cur = ""; }
    else cur += c;
  }
  if (cur) out.push(cur);
  return out;
}

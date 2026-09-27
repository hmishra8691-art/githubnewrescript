import { isZip, readZip } from "./zip.js";
import type { SourceFormat, SourcePlatform } from "./canonical.js";

/**
 * WHAT IS THIS FILE? — from its content, not its name (§3).
 *
 * The extension is a hint and nothing more: a `.xml` may be a Decipher
 * project or an Excel 2003 export; a `.txt` may be a QSF someone renamed; a
 * `.docx` is a zip, and so is an `.xlsx`. Each rule below looks at bytes and
 * structure and says why it decided, so the preview can show the reasoning
 * ("Qualtrics: JSON with SurveyEntry and 212 SurveyElements").
 */
export interface Detection {
  format: SourceFormat;
  platform: SourcePlatform;
  /** "Structured Survey Definition" | "Questionnaire document" | "Questionnaire spreadsheet" */
  importType: string;
  /** a plain sentence for the card */
  label: string;
  confidence: "high" | "medium" | "low";
  reasons: string[];
}

const dec = new TextDecoder("utf-8", { fatal: false });

export function detectFormat(bytes: Uint8Array, fileName = ""): Detection {
  const ext = (fileName.split(".").pop() ?? "").toLowerCase();
  const reasons: string[] = [];
  const d = (format: SourceFormat, platform: SourcePlatform, importType: string, label: string, confidence: Detection["confidence"]): Detection => ({ format, platform, importType, label, confidence, reasons });

  if (bytes.length === 0) { reasons.push("the file is empty"); return d("unknown", "unknown", "Nothing to import", "Empty file", "high"); }

  // PDF: the header, within the first KiB (some writers put junk first)
  const headAscii = dec.decode(bytes.subarray(0, Math.min(bytes.length, 1024)));
  if (headAscii.includes("%PDF-")) { reasons.push(`PDF header ${/%PDF-[\d.]+/.exec(headAscii)?.[0] ?? "%PDF-"}`); return d("pdf", "document", "Questionnaire document", "PDF questionnaire", "high"); }

  // Office Open XML: a zip whose parts say which application wrote it
  if (isZip(bytes)) {
    try {
      const zip = readZip(bytes);
      if (zip.has("word/document.xml")) { reasons.push("zip containing word/document.xml"); return d("docx", "document", "Questionnaire document", "Word questionnaire", "high"); }
      if (zip.has("xl/workbook.xml")) { reasons.push("zip containing xl/workbook.xml"); return d("xlsx", "spreadsheet", "Questionnaire spreadsheet", "Excel questionnaire", "high"); }
      reasons.push(`a zip archive with ${zip.size} entries, none of them a Word or Excel part`);
    } catch (e) { reasons.push(`looks like a zip but could not be read: ${(e as Error).message}`); }
    return d("unknown", "unknown", "Unsupported", "An archive that is not a Word or Excel file", "medium");
  }
  if (bytes[0] === 0xd0 && bytes[1] === 0xcf && bytes[2] === 0x11 && bytes[3] === 0xe0) {
    reasons.push("an OLE compound file — the pre-2007 .doc / .xls format");
    return d("unknown", "unknown", "Unsupported", "Legacy Office file (.doc / .xls) — save it as .docx or .xlsx and upload again", "high");
  }

  const text = dec.decode(bytes.subarray(0, Math.min(bytes.length, 2_000_000))).replace(/^﻿/, "");
  const trimmed = text.trimStart();

  // Qualtrics QSF: JSON with SurveyEntry + SurveyElements
  if (trimmed.startsWith("{")) {
    const hasEntry = /"SurveyEntry"\s*:/.test(text), hasElements = /"SurveyElements"\s*:/.test(text);
    if (hasEntry && hasElements) {
      const n = (text.match(/"Element"\s*:\s*"SQ"/g) ?? []).length;
      reasons.push(`JSON with SurveyEntry and SurveyElements (${n} question element${n === 1 ? "" : "s"})`);
      if (ext && ext !== "qsf" && ext !== "json") reasons.push(`the .${ext} extension was ignored — the content is a QSF`);
      return d("qsf", "qualtrics", "Structured Survey Definition", "Qualtrics survey (QSF)", "high");
    }
    if (/"questions"\s*:/.test(text) && /"flow"\s*:/.test(text) && /"meta"\s*:/.test(text)) {
      reasons.push("JSON with meta, questions and flow — a Rescript survey definition");
      return d("json", "rescript", "Rescript definition", "Rescript survey JSON", "high");
    }
    reasons.push("JSON, but neither a QSF nor a Rescript definition");
    return d("unknown", "unknown", "Unsupported", "JSON of an unknown shape", "medium");
  }

  // XML: a Decipher project is a <survey> root with Decipher's element vocabulary
  if (trimmed.startsWith("<")) {
    const root = /<(?!\?|!)([A-Za-z_][\w:.-]*)/.exec(trimmed)?.[1] ?? "";
    const decipherWords = ["radio", "checkbox", "select", "number", "text", "textarea", "suspend", "samplesources", "exec", "term", "quota"];
    const found = decipherWords.filter((w) => new RegExp(`<${w}[\\s>/]`).test(text));
    const markers = [/builder:/.test(text) && "builder: attributes", /compat="\d+"/.test(text) && "compat=", /<samplesources/.test(text) && "<samplesources>", /xmlns:ss=/.test(text) && "xmlns:ss"].filter(Boolean) as string[];
    if (root === "survey" && (found.length >= 2 || markers.length)) {
      reasons.push(`XML with a <survey> root and Decipher elements (${found.slice(0, 6).map((w) => `<${w}>`).join(", ")})${markers.length ? `; markers: ${markers.join(", ")}` : ""}`);
      return d("decipher", "decipher", "Structured Survey Definition", "Decipher project (XML)", found.length >= 3 || markers.length ? "high" : "medium");
    }
    if (/<Workbook[\s>]/.test(text) && /urn:schemas-microsoft-com:office:spreadsheet/.test(text)) {
      reasons.push("SpreadsheetML (Excel 2003 XML)");
      return d("unknown", "unknown", "Unsupported", "Excel 2003 XML — save it as .xlsx and upload again", "high");
    }
    reasons.push(`XML with a <${root || "?"}> root that is not a Decipher project`);
    return d("unknown", "unknown", "Unsupported", "XML of an unknown vocabulary", "medium");
  }

  // plain text: a delimited table, or a questionnaire written as prose
  const lines = text.split(/\r?\n/).filter((l) => l.trim()).slice(0, 60);
  if (lines.length >= 2) {
    for (const delim of [",", "\t", ";"]) {
      const counts = lines.map((l) => splitDelimited(l, delim).length);
      const common = mode(counts);
      const agree = counts.filter((c) => c === common).length / counts.length;
      if (common >= 3 && agree >= 0.8) {
        reasons.push(`${lines.length}+ lines of ${common} ${delim === "\t" ? "tab" : `“${delim}”`}-separated fields`);
        return d("csv", "spreadsheet", "Questionnaire spreadsheet", "Delimited questionnaire table (CSV)", ext === "csv" || ext === "tsv" ? "high" : "medium");
      }
    }
  }
  const qLike = lines.filter((l) => /^\s*(?:Q(?:uestion)?\s*)?\d+[a-z]?[.):]\s+\S/i.test(l)).length;
  reasons.push(qLike ? `plain text with ${qLike} numbered question-like lines` : "plain text");
  return d("text", "document", "Questionnaire document", "Text questionnaire", qLike >= 2 ? "medium" : "low");
}

export function splitDelimited(line: string, delim: string): string[] {
  const out: string[] = []; let cur = ""; let q = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (q) { if (c === '"' && line[i + 1] === '"') { cur += '"'; i++; } else if (c === '"') q = false; else cur += c; }
    else if (c === '"') q = true;
    else if (c === delim) { out.push(cur); cur = ""; }
    else cur += c;
  }
  out.push(cur);
  return out;
}
function mode(xs: number[]): number { const m = new Map<number, number>(); for (const x of xs) m.set(x, (m.get(x) ?? 0) + 1); let best = 0, n = 0; for (const [k, v] of m) if (v > n) { best = k; n = v; } return best; }

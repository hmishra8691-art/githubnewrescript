import ExcelJS from "exceljs";
import type { SurveyDefinition } from "@rescript/schema";
import { translationRows, type TranslationRow } from "@rescript/engine";
import { parseSpreadsheet } from "./spreadsheetImport.js";

/**
 * TRANSLATION FILES — the round trip with translators who work outside the
 * platform. One row per (element, target language), matched back by Element
 * ID, never by text.
 */
export const TRANSLATION_COLUMNS = ["Element ID", "Question ID", "Question", "Element", "Source Language", "Target Language", "Source Text", "Translation", "Status", "Audio URL"] as const;

export async function translationsToXlsx(def: SurveyDefinition, languages?: string[]): Promise<Buffer> {
  const rows = translationRows(def, languages);
  const wb = new ExcelJS.Workbook();
  wb.creator = "rescript";
  wb.created = new Date(0);
  const ws = wb.addWorksheet("Translations");
  ws.columns = TRANSLATION_COLUMNS.map((h) => ({ header: h, key: h, width: h === "Source Text" || h === "Translation" ? 60 : h === "Element ID" ? 28 : h === "Audio URL" ? 40 : 16 }));
  for (const r of rows) ws.addRow([r.elementKey, r.questionId, r.questionCode, r.element, r.sourceLanguage, r.targetLanguage, r.sourceText, r.translation, r.status, r.audioUrl]);
  ws.getRow(1).font = { bold: true };
  ws.views = [{ state: "frozen", ySplit: 1 }];
  ws.autoFilter = { from: { row: 1, column: 1 }, to: { row: 1, column: TRANSLATION_COLUMNS.length } };
  // the translator edits only Translation (and may set Status / Audio URL); the rest is the key
  ws.getColumn(8).eachCell((c, i) => { if (i > 1) c.fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FFFFF7E6" } }; });
  const about = wb.addWorksheet("About");
  about.columns = [{ header: "", key: "k", width: 22 }, { header: "", key: "v", width: 80 }];
  about.addRows([
    ["Survey", `${def.meta.code} — ${def.meta.title} (v${def.meta.version})`],
    ["Exported", new Date().toISOString()],
    ["Languages", (languages ?? [...new Set(rows.map((r) => r.targetLanguage))]).join(", ")],
    ["How to use", "Fill the Translation column. Keep every {{piping}} token and {parameter} exactly as in Source Text, and keep HTML tags. Do not change Element ID or Target Language — rows are matched by them. Status may be set to edited, reviewed or approved."],
  ]);
  return Buffer.from(await wb.xlsx.writeBuffer());
}

export type ImportedTranslationRow = Pick<TranslationRow, "elementKey" | "targetLanguage" | "translation"> & { status?: string; audioUrl?: string };

const norm = (h: string) => h.toLowerCase().replace(/[^a-z]/g, "");
const COLS: Record<string, keyof ImportedTranslationRow> = { elementid: "elementKey", elementkey: "elementKey", key: "elementKey", targetlanguage: "targetLanguage", language: "targetLanguage", target: "targetLanguage", translation: "translation", translatedtext: "translation", status: "status", audiourl: "audioUrl", audio: "audioUrl" };

/** Rows from an exported workbook (or any sheet with the same headers, in any order). */
export async function parseTranslationSheet(data: ArrayBuffer | Uint8Array | Buffer): Promise<ImportedTranslationRow[]> {
  const sheet = await parseSpreadsheet(data);
  return rowsFromRecords(sheet.headers, sheet.rows);
}

/** Rows from CSV text with the same headers. */
export function parseTranslationCsv(text: string): ImportedTranslationRow[] {
  const lines: string[][] = [];
  let cur: string[] = [], field = "", quoted = false;
  const src = text.replace(/^﻿/, "");
  for (let i = 0; i < src.length; i++) {
    const ch = src[i];
    if (quoted) { if (ch === '"') { if (src[i + 1] === '"') { field += '"'; i++; } else quoted = false; } else field += ch; }
    else if (ch === '"') quoted = true;
    else if (ch === ",") { cur.push(field); field = ""; }
    else if (ch === "\n" || ch === "\r") { if (ch === "\r" && src[i + 1] === "\n") i++; cur.push(field); lines.push(cur); cur = []; field = ""; }
    else field += ch;
  }
  if (field || cur.length) { cur.push(field); lines.push(cur); }
  const [head, ...body] = lines.filter((l) => l.some((c) => c.trim()));
  if (!head) return [];
  return rowsFromRecords(head, body.map((l) => Object.fromEntries(head.map((h, i) => [h, l[i] ?? ""]))));
}

function rowsFromRecords(headers: string[], records: Record<string, unknown>[]): ImportedTranslationRow[] {
  const map = new Map<string, keyof ImportedTranslationRow>();
  for (const h of headers) { const k = COLS[norm(String(h))]; if (k) map.set(String(h), k); }
  if (!map.has([...map.keys()].find((h) => map.get(h) === "elementKey") ?? "") ) return [];
  const out: ImportedTranslationRow[] = [];
  for (const rec of records) {
    const row: Partial<ImportedTranslationRow> = {};
    for (const [h, k] of map) { const v = rec[h]; if (v != null && v !== "") (row as Record<string, unknown>)[k] = String(v); }
    if (row.elementKey && row.targetLanguage) out.push({ elementKey: row.elementKey, targetLanguage: row.targetLanguage, translation: row.translation ?? "", status: row.status, audioUrl: row.audioUrl });
  }
  return out;
}

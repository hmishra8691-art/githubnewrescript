import type { Question, SurveyDefinition } from "@rescript/schema";
import { buildVariableDictionary } from "./variables.js";
import { htmlToText, validateQuestion } from "./validate.js";
import { createResponseState } from "./state.js";

/**
 * Importing response data — the VALIDATE → PREVIEW half.
 *
 * Nothing here touches a database. This module turns a spreadsheet the
 * researcher exported (or typed) into either a set of prepared rows that the
 * transactional importer can commit, or a list of problems with row numbers.
 * The commit is one SQL function (`rescript_import_responses`), so a file with
 * one bad row cannot leave half of itself in the data — this module's job is
 * to make sure the researcher sees that row before anything is written.
 *
 * Each cell is first coerced to the shape the question stores:
 *   single select   a valid option code, or its label ("Male" → "m")
 *   multi select    a list, split on , ; or |, each item a code or label
 *   numeric         a number
 *   date / time     an ISO-ish value the runtime would accept
 *   grid / matrix   one column per row variable (GRID_r1), assembled per row
 *   text            as written
 * and the assembled row is then handed to `validateQuestion` — the survey's
 * OWN validator, the one the runtime runs — so min/max, selection counts,
 * patterns and email rules are enforced by the same code that enforced them
 * while the survey was being answered, not by a second implementation here.
 * A column that matches nothing is reported, never guessed at.
 */

export type ImportMode = "create" | "update" | "upsert";

/** What a spreadsheet column maps onto. */
export type ColumnTarget =
  | { kind: "respondent_code" }
  | { kind: "session_id" }
  | { kind: "status" }
  | { kind: "started_at" }
  | { kind: "completed_at" }
  /** a question's answer; `rowCode` for one row of a grid */
  | { kind: "question"; questionId: string; rowCode?: string }
  | { kind: "embedded"; name: string }
  | { kind: "ignore" };

export type ColumnMapping = Record<string, ColumnTarget>;

export interface ImportIssue {
  /** 1-based row number as the researcher sees it in the file (header is not a row) */
  row: number;
  column: string;
  respondentCode?: string | null;
  value: unknown;
  expected: string;
  message: string;
  severity: "error" | "warning";
}

export interface PreparedRow {
  row: number;
  respondentCode: string | null;
  sessionId: string | null;
  status?: string;
  startedAt?: string;
  completedAt?: string;
  answers: Record<string, unknown>;
  embedded: Record<string, unknown>;
  /** this file also contains an earlier row with the same key */
  duplicateOf?: number;
}

export interface ImportPreview {
  mapping: ColumnMapping;
  rows: PreparedRow[];
  issues: ImportIssue[];
  summary: {
    detected: number;
    valid: number;
    warnings: number;
    errors: number;
    duplicates: number;
    /** rows carrying a key (respondent code / session id) */
    keyed: number;
    unkeyed: number;
  };
  /** columns in the file that map to nothing */
  unmapped: string[];
}

const norm = (s: string) => s.trim().toLowerCase().replace(/[\s_-]+/g, "");

/**
 * Guess what each column means, from the file's own headers.
 *
 * The order is deliberate: a survey's own variable names (what the export
 * writes) win over anything else, then question codes, then labels — so a
 * file that came out of this platform maps itself with no work, and a
 * hand-made file still stands a good chance.
 */
export function suggestMapping(def: SurveyDefinition, headers: string[]): ColumnMapping {
  const dict = buildVariableDictionary(def).filter((v) => v.responseType !== "system");
  const byVar = new Map<string, ColumnTarget>();
  for (const q of def.questions) {
    byVar.set(norm(q.variableName), { kind: "question", questionId: q.id });
    byVar.set(norm(q.code), { kind: "question", questionId: q.id });
    const text = htmlToText(q.text ?? "").trim();
    if (text) byVar.set(norm(text), { kind: "question", questionId: q.id });
    for (const r of q.rows ?? []) {
      // the export writes VAR_<rowCode>; a hand-made file may write "Q4: One"
      byVar.set(norm(`${q.variableName}_${r.code}`), { kind: "question", questionId: q.id, rowCode: String(r.code) });
      byVar.set(norm(`${q.code}_${r.code}`), { kind: "question", questionId: q.id, rowCode: String(r.code) });
      const rl = htmlToText(r.label ?? "").trim();
      if (rl) byVar.set(norm(`${q.code} ${rl}`), { kind: "question", questionId: q.id, rowCode: String(r.code) });
    }
  }
  for (const e of def.embeddedData) byVar.set(norm(e.name), { kind: "embedded", name: e.name });
  for (const v of dict) if (!byVar.has(norm(v.name))) byVar.set(norm(v.name), { kind: "ignore" });

  const mapping: ColumnMapping = {};
  for (const h of headers) {
    const n = norm(h);
    if (["respondentcode", "respondent", "respondentid", "responseid", "id"].includes(n)) { mapping[h] = { kind: "respondent_code" }; continue; }
    if (["sessionid", "session"].includes(n)) { mapping[h] = { kind: "session_id" }; continue; }
    if (n === "status") { mapping[h] = { kind: "status" }; continue; }
    if (["startedat", "started", "startdate"].includes(n)) { mapping[h] = { kind: "started_at" }; continue; }
    if (["completedat", "completed", "enddate", "submitted"].includes(n)) { mapping[h] = { kind: "completed_at" }; continue; }
    if (["surveyversion", "version", "environment", "istest"].includes(n)) { mapping[h] = { kind: "ignore" }; continue; }
    mapping[h] = byVar.get(n) ?? { kind: "ignore" };
  }
  return mapping;
}

const VALID_STATUS = ["in_progress", "complete", "screened", "quota_full", "terminated"];

function optionCode(q: Question, raw: string): string | null {
  const v = raw.trim();
  if (!v) return null;
  const opts = q.options ?? [];
  const byCode = opts.find((o) => String(o.code) === v);
  if (byCode) return String(byCode.code);
  const lower = v.toLowerCase();
  const byCodeCI = opts.find((o) => String(o.code).toLowerCase() === lower);
  if (byCodeCI) return String(byCodeCI.code);
  const byLabel = opts.find((o) => htmlToText(o.label ?? "").trim().toLowerCase() === lower);
  if (byLabel) return String(byLabel.code);
  return null;
}

const SPLIT = /[,;|]/;

/** Coerce one cell for one question. Returns the value, or an explanation. */
function coerce(q: Question, raw: unknown, rowCode?: string): { value: unknown } | { error: string; expected: string } {
  const text = raw === null || raw === undefined ? "" : String(raw).trim();
  if (text === "") return { value: undefined };
  const type = String(q.type);

  // a grid cell is coerced as if it were the grid's own response type
  const optionLike = (q.options?.length ?? 0) > 0;

  if (/^(multi_select|multi_dropdown|image_ranking|ranking)$/.test(type) || (rowCode && /^matrix_multi$/.test(type))) {
    const parts = text.split(SPLIT).map((p) => p.trim()).filter(Boolean);
    const codes: string[] = [];
    for (const p of parts) {
      const c = optionCode(q, p);
      if (c === null) return { error: `“${p}” is not an option of ${q.code}`, expected: `one of ${(q.options ?? []).map((o) => o.code).join(", ")}` };
      codes.push(c);
    }
    return { value: codes };
  }
  if (/^(single_select|dropdown|image_select)$/.test(type) || (rowCode && /^matrix_single|matrix_dropdown$/.test(type)) || (optionLike && !/numeric|text|date|time|slider|allocation/.test(type))) {
    const c = optionCode(q, text);
    if (c === null) return { error: `“${text}” is not an option of ${q.code}`, expected: `one of ${(q.options ?? []).map((o) => o.code).join(", ")}` };
    return { value: c };
  }
  if (/^(numeric|slider|nps|allocation)$/.test(type) || (rowCode && /^matrix_numeric$/.test(type))) {
    const n = Number(text.replace(/,/g, ""));
    if (!Number.isFinite(n)) return { error: `“${text}” is not a number`, expected: "a number" };
    // the range is the survey's business: validateQuestion enforces it below
    return { value: n };
  }
  if (type === "date") {
    const d = new Date(text);
    if (Number.isNaN(d.getTime())) return { error: `“${text}” is not a date`, expected: "a date, e.g. 2026-09-04" };
    return { value: text.length <= 10 ? text : d.toISOString().slice(0, 10) };
  }
  if (type === "time") {
    if (!/^\d{1,2}:\d{2}(:\d{2})?$/.test(text)) return { error: `“${text}” is not a time`, expected: "a time, e.g. 14:30" };
    return { value: text };
  }
  return { value: text };
}

/**
 * Validate a parsed file against the survey. `rows` are plain objects keyed by
 * the file's headers — this module never parses CSV or XLSX itself, so the
 * same validation serves every format the app can read.
 */
export function validateImportRows(
  def: SurveyDefinition,
  mapping: ColumnMapping,
  rows: Record<string, unknown>[],
  mode: ImportMode,
): ImportPreview {
  const issues: ImportIssue[] = [];
  const prepared: PreparedRow[] = [];
  const seenKey = new Map<string, number>();
  const byId = new Map(def.questions.map((q) => [q.id, q]));
  const unmapped = Object.entries(mapping).filter(([, t]) => t.kind === "ignore").map(([h]) => h);

  rows.forEach((raw, i) => {
    const rowNo = i + 1;
    const out: PreparedRow = { row: rowNo, respondentCode: null, sessionId: null, answers: {}, embedded: {} };
    const gridBuffer = new Map<string, Record<string, unknown>>();
    let rowErrors = 0;

    for (const [header, target] of Object.entries(mapping)) {
      if (target.kind === "ignore") continue;
      const cell = raw[header];
      const text = cell === null || cell === undefined ? "" : String(cell).trim();

      if (target.kind === "respondent_code") { out.respondentCode = text || null; continue; }
      if (target.kind === "session_id") { out.sessionId = text || null; continue; }
      if (target.kind === "status") {
        if (!text) continue;
        if (!VALID_STATUS.includes(text)) {
          issues.push({ row: rowNo, column: header, value: cell, expected: VALID_STATUS.join(", "), message: `“${text}” is not a response status`, severity: "error" });
          rowErrors++;
        } else out.status = text;
        continue;
      }
      if (target.kind === "started_at" || target.kind === "completed_at") {
        if (!text) continue;
        const d = new Date(text);
        if (Number.isNaN(d.getTime())) {
          issues.push({ row: rowNo, column: header, value: cell, expected: "a date and time", message: `“${text}” is not a date`, severity: "warning" });
        } else if (target.kind === "started_at") out.startedAt = d.toISOString();
        else out.completedAt = d.toISOString();
        continue;
      }
      if (target.kind === "embedded") { if (text) out.embedded[target.name] = text; continue; }

      const q = byId.get(target.questionId);
      if (!q) {
        issues.push({ row: rowNo, column: header, value: cell, expected: "a question in this survey", message: `column is mapped to a question that is no longer in the survey`, severity: "error" });
        rowErrors++;
        continue;
      }
      const res = coerce(q, cell, target.rowCode);
      if ("error" in res) {
        issues.push({ row: rowNo, column: header, respondentCode: out.respondentCode, value: cell, expected: res.expected, message: res.error, severity: "error" });
        rowErrors++;
        continue;
      }
      if (res.value === undefined) continue;
      if (target.rowCode) {
        const buf = gridBuffer.get(q.id) ?? {};
        buf[target.rowCode] = res.value;
        gridBuffer.set(q.id, buf);
      } else {
        out.answers[q.id] = res.value;
      }
    }
    for (const [qid, cells] of gridBuffer) out.answers[qid] = cells;

    /*
     * Now ask the survey itself. `required` is relaxed — an imported partial,
     * or a response that legitimately skipped a question, must be importable —
     * but every other rule the questionnaire carries applies, reported against
     * the column the value came from.
     */
    if (rowErrors === 0) {
      const state = createResponseState(def, { sessionId: out.sessionId ?? "import" });
      Object.assign(state.answers, out.answers as never);
      Object.assign(state.embedded, out.embedded as never);
      for (const qid of Object.keys(out.answers)) {
        const q = byId.get(qid);
        if (!q) continue;
        const errs = validateQuestion(def, { ...q, required: false } as typeof q, out.answers[qid], { def, state, loop: null });
        for (const e of errs) {
          const column = Object.entries(mapping).find(([, t]) => t.kind === "question" && t.questionId === qid)?.[0] ?? q.code;
          issues.push({ row: rowNo, column, respondentCode: out.respondentCode, value: out.answers[qid], expected: `a value ${q.code} accepts`, message: e.message, severity: "error" });
          rowErrors++;
        }
      }
    }

    // a key repeated inside the file itself: the second row would silently
    // overwrite the first, so it is reported before anything is committed
    const key = out.respondentCode ?? out.sessionId;
    if (key) {
      const prev = seenKey.get(key);
      if (prev !== undefined) {
        out.duplicateOf = prev;
        issues.push({ row: rowNo, column: "respondent_code", respondentCode: out.respondentCode, value: key, expected: "a key that appears once", message: `${key} also appears on row ${prev} of this file`, severity: "warning" });
      } else seenKey.set(key, rowNo);
    } else if (mode === "update") {
      issues.push({ row: rowNo, column: "respondent_code", value: "", expected: "a respondent code or session id", message: "this row has no key, so there is nothing to update", severity: "error" });
      rowErrors++;
    }

    if (rowErrors === 0) prepared.push(out);
  });

  const keyed = prepared.filter((r) => r.respondentCode || r.sessionId).length;
  return {
    mapping,
    rows: prepared,
    issues,
    unmapped,
    summary: {
      detected: rows.length,
      valid: prepared.length,
      warnings: issues.filter((i) => i.severity === "warning").length,
      errors: issues.filter((i) => i.severity === "error").length,
      duplicates: prepared.filter((r) => r.duplicateOf !== undefined).length,
      keyed,
      unkeyed: prepared.length - keyed,
    },
  };
}

/** Simple, strict CSV/TSV parse: quoted fields, embedded newlines, BOM. */
export function parseDelimited(text: string): { headers: string[]; rows: Record<string, string>[] } {
  const src = text.replace(/^﻿/, "");
  const first = src.slice(0, src.indexOf("\n") === -1 ? src.length : src.indexOf("\n"));
  const delim = (first.match(/\t/g)?.length ?? 0) > (first.match(/,/g)?.length ?? 0) ? "\t" : ",";
  const cells: string[][] = [];
  let row: string[] = [];
  let field = "";
  let quoted = false;
  for (let i = 0; i < src.length; i++) {
    const c = src[i];
    if (quoted) {
      if (c === '"') {
        if (src[i + 1] === '"') { field += '"'; i++; }
        else quoted = false;
      } else field += c;
      continue;
    }
    if (c === '"') { quoted = true; continue; }
    if (c === delim) { row.push(field); field = ""; continue; }
    if (c === "\r") continue;
    if (c === "\n") { row.push(field); cells.push(row); row = []; field = ""; continue; }
    field += c;
  }
  if (field !== "" || row.length) { row.push(field); cells.push(row); }
  const nonEmpty = cells.filter((r) => r.some((c) => c.trim() !== ""));
  if (!nonEmpty.length) return { headers: [], rows: [] };
  const headers = nonEmpty[0].map((h) => h.trim());
  const rows = nonEmpty.slice(1).map((r) => {
    const o: Record<string, string> = {};
    headers.forEach((h, i) => { o[h] = (r[i] ?? "").trim(); });
    return o;
  });
  return { headers, rows };
}

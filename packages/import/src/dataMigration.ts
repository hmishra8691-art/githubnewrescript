import type { SurveyDefinition, Question, VariableDef } from "@rescript/schema";
import { buildVariableDictionary, createResponseState, flattenVariables } from "@rescript/engine";
import { readSheets } from "./sources.js";
import { looksLikeDataFile, readCodebook } from "./adapters/dataFile.js";
import { detectFormat } from "./detect.js";

/**
 * DATA MIGRATION (Level 5 roadmap I4 — 2026-11-29).
 *
 * Legacy responses — a CSV / Excel / SPSS table of variables over rows — brought into a survey that was imported (or
 * rebuilt) here: each legacy column mapped to the new survey's variable, each value recoded to the new code, the
 * weight carried, and a reconciliation report that proves it, variable by variable.
 *
 *   planDataMigration   the variable map: legacy column → target variable (question, option or row), how it was
 *                       matched (same name, the same name under this survey's naming, the label), and the value
 *                       recoding (same code, label → code). Unmatched columns and values are listed, never guessed.
 *   migrateResponses    the rows as answers keyed by question id (the shape the runtime saves), the weight in
 *                       embedded data, and the reconciliation: for every mapped variable, the legacy distribution
 *                       beside the distribution read back from the migrated answers through the engine's own
 *                       flattening — so the check is against what analytics and exports will actually see.
 *
 * Nothing is written to a database here. A row that would lose an answer is reported, not dropped silently.
 */
export interface LegacyTable { header: string[]; rows: string[][]; labels?: Record<string, string>; valueLabels?: Record<string, [string, string][]> }
export type MatchHow = "name" | "name_folded" | "label";
export interface ColumnMap {
  column: string;
  target: string;
  questionId: string;
  questionCode: string;
  kind: "value" | "option_flag" | "row";
  optionCode?: string;
  rowCode?: string;
  how: MatchHow;
  /** legacy value → new code, where they differ */
  recode: Record<string, string>;
  unmappedValues: string[];
}
export interface MigrationPlan {
  columns: ColumnMap[];
  weight: string | null;
  /** the respondent id column, kept as the response's external reference */
  idColumn: string | null;
  unmatchedColumns: string[];
  unfilledQuestions: string[];
  notes: string[];
}

const fold = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, "");
const plain = (s: string) => s.replace(/<[^>]+>/g, "").replace(/\s+/g, " ").trim().toLowerCase();
const isEmpty = (v: string | undefined) => v == null || v.trim() === "" || v.trim() === ".";
const WEIGHT = /^(?:weight|wt|wgt|weights?_?\d*|final_?weight|rim_?weight)$/i;
const ID = /^(?:id|respid|resp_?id|respondent_?id|response_?id|record|uuid|serial|caseid)$/i;
const SYSTEM = /^(?:start(?:_?(?:date|time))?|end(?:_?(?:date|time))?|date|timestamp|duration\w*|status|ip\w*|user_?agent|progress|finished|lat\w*|long\w*)$/i;

function questionOf(def: SurveyDefinition, id: string | undefined): Question | undefined { return id ? def.questions.find((q) => q.id === id) : undefined; }

export function planDataMigration(def: SurveyDefinition, table: LegacyTable): MigrationPlan {
  const dict = buildVariableDictionary(def).filter((v) => v.questionId && !v.derived && v.responseType !== "system");
  const byName = new Map(dict.map((v) => [v.name, v]));
  const byFolded = new Map<string, VariableDef[]>();
  for (const v of dict) byFolded.set(fold(v.name), [...(byFolded.get(fold(v.name)) ?? []), v]);
  const byLabel = new Map<string, VariableDef[]>();
  for (const v of dict) if (v.label) byLabel.set(plain(v.label), [...(byLabel.get(plain(v.label)) ?? []), v]);
  const columns: ColumnMap[] = [], unmatched: string[] = [], notes: string[] = [];
  let weight: string | null = null, idColumn: string | null = null;
  const used = new Set<string>();
  table.header.forEach((col, ci) => {
    if (!weight && WEIGHT.test(col)) { weight = col; return; }
    if (!idColumn && ID.test(col)) { idColumn = col; return; }
    if (SYSTEM.test(col)) return;
    let v: VariableDef | undefined, how: MatchHow = "name";
    if (byName.has(col)) v = byName.get(col);
    else if ((byFolded.get(fold(col)) ?? []).length === 1) { v = byFolded.get(fold(col))![0]; how = "name_folded"; }
    else { const lab = table.labels?.[col]; const hits = lab ? byLabel.get(plain(lab)) ?? [] : []; if (hits.length === 1) { v = hits[0]; how = "label"; } }
    if (!v || used.has(v.name)) { unmatched.push(col); return; }
    used.add(v.name);
    const q = questionOf(def, v.questionId)!;
    const kind: ColumnMap["kind"] = v.optionCode != null && (q.type === "multi_select" || q.type === "multi_dropdown") ? "option_flag" : v.rowCode != null ? "row" : "value";
    /* the codes this variable takes: its question's options (or a matrix's options), else none (numbers / text) */
    const options = (q.type.startsWith("matrix_") && q.columns?.length ? q.columns.flatMap((c) => c.options) : q.options) ?? [];
    const recode: Record<string, string> = {}, unmapped = new Set<string>();
    if (kind !== "option_flag" && options.length && !/numeric|text/.test(q.type)) {
      const codes = new Set(options.map((o) => String(o.code)));
      const byLab = new Map(options.map((o) => [plain(o.label), String(o.code)]));
      const legacyLabels = new Map((table.valueLabels?.[col] ?? []).map(([c, l]) => [c, plain(l)]));
      for (const row of table.rows) {
        const raw = row[ci];
        if (isEmpty(raw)) continue;
        for (const val of q.type === "multi_select" ? raw!.split(/[;,|]\s*/) : [raw!]) {
          const t = val.trim();
          if (codes.has(t) || recode[t] !== undefined || unmapped.has(t)) continue;
          const viaLegacyLabel = legacyLabels.get(t);
          const hit = byLab.get(plain(t)) ?? (viaLegacyLabel ? byLab.get(viaLegacyLabel) : undefined);
          if (hit) recode[t] = hit; else unmapped.add(t);
        }
      }
    }
    columns.push({ column: col, target: v.name, questionId: q.id, questionCode: q.code, kind, ...(v.optionCode != null ? { optionCode: String(v.optionCode) } : {}), ...(v.rowCode != null ? { rowCode: String(v.rowCode) } : {}), how, recode, unmappedValues: [...unmapped] });
  });
  const filled = new Set(columns.map((c) => c.questionId));
  const unfilled = def.questions.filter((q) => !filled.has(q.id) && !/^(?:descriptive|text_block|info|hidden)/.test(q.type)).map((q) => q.code);
  if (!weight) notes.push("No weight column found (weight, wt, wgt…): every migrated response has weight 1.");
  if (unmatched.length) notes.push(`${unmatched.length} legacy column${unmatched.length === 1 ? "" : "s"} matched no variable of this survey; map them by hand or leave them out.`);
  return { columns, weight, idColumn, unmatchedColumns: unmatched, unfilledQuestions: unfilled, notes };
}

export interface MigratedRow { externalId: string | null; answers: Record<string, unknown>; embedded: Record<string, unknown>; lost: string[] }
export interface Reconciliation { variable: string; column: string; legacy: Record<string, number>; migrated: Record<string, number>; matches: boolean }
export interface MigrationResult { rows: MigratedRow[]; reconciliation: Reconciliation[]; summary: { rows: number; mappedColumns: number; variablesMatching: number; variablesDiffering: number; valuesLost: number; weighted: boolean } }

const num = (s: string) => (/^-?\d+(?:\.\d+)?$/.test(s.trim()) ? Number(s.trim()) : null);
const codeOut = (q: Question, c: string): string | number => { const o = (q.options ?? []).find((x) => String(x.code) === c) ?? (q.columns ?? []).flatMap((x) => x.options).find((x) => String(x.code) === c); return o ? o.code : (num(c) ?? c); };
const truthy = (s: string) => /^(?:1|true|yes|selected|checked|x)$/i.test(s.trim());

export function migrateResponses(def: SurveyDefinition, table: LegacyTable, plan: MigrationPlan): MigrationResult {
  const ci = new Map(table.header.map((h, i) => [h, i]));
  const rows: MigratedRow[] = [];
  const qById = new Map(def.questions.map((q) => [q.id, q]));
  for (const r of table.rows) {
    const answers: Record<string, unknown> = {}, embedded: Record<string, unknown> = {}, lost: string[] = [];
    for (const m of plan.columns) {
      const raw = r[ci.get(m.column)!];
      if (isEmpty(raw)) continue;
      const q = qById.get(m.questionId)!;
      const val = raw!.trim();
      const recoded = (t: string) => m.recode[t] ?? t;
      const valid = (t: string) => !m.unmappedValues.includes(t);
      if (m.kind === "option_flag") {
        if (truthy(val)) answers[q.id] = [...((answers[q.id] as unknown[]) ?? []), codeOut(q, m.optionCode!)];
        else if (!/^(?:0|false|no)$/i.test(val)) lost.push(`${m.column}=${val}`);
      } else if (m.kind === "row") {
        if (!valid(val)) { lost.push(`${m.column}=${val}`); continue; }
        const cur = (answers[q.id] as Record<string, unknown>) ?? {};
        cur[m.rowCode!] = /numeric|text/.test(q.type) ? (q.type.includes("numeric") ? num(val) ?? val : val) : codeOut(q, recoded(val));
        answers[q.id] = cur;
      } else if (q.type === "multi_select" || q.type === "multi_dropdown") {
        const parts = val.split(/[;,|]\s*/).filter(Boolean);
        const ok = parts.filter(valid);
        for (const p of parts.filter((p) => !valid(p))) lost.push(`${m.column}=${p}`);
        if (ok.length) answers[q.id] = ok.map((p) => codeOut(q, recoded(p)));
      } else if (q.type === "numeric" || q.type === "nps" || q.type.startsWith("rating") || q.type === "slider") {
        const n = num(recoded(val));
        if (n === null && !(q.options ?? []).length) { lost.push(`${m.column}=${val}`); continue; }
        answers[q.id] = (q.options ?? []).length ? codeOut(q, recoded(val)) : n;
      } else if (q.type === "open_text" || q.type === "long_text" || q.type === "date" || q.type === "time" || q.type === "email") {
        answers[q.id] = val;
      } else {
        if (!valid(val)) { lost.push(`${m.column}=${val}`); continue; }
        answers[q.id] = codeOut(q, recoded(val));
      }
    }
    if (plan.weight) { const w = num(r[ci.get(plan.weight)!] ?? ""); if (w !== null) embedded.WEIGHT = w; }
    rows.push({ externalId: plan.idColumn ? (r[ci.get(plan.idColumn)!] ?? null) : null, answers, embedded, lost });
  }
  const recon = reconcile(def, table, plan, rows);
  const lostN = rows.reduce((a, r) => a + r.lost.length, 0);
  return { rows, reconciliation: recon, summary: { rows: rows.length, mappedColumns: plan.columns.length, variablesMatching: recon.filter((x) => x.matches).length, variablesDiffering: recon.filter((x) => !x.matches).length, valuesLost: lostN, weighted: !!plan.weight } };
}

/** the reconciliation alone, re-runnable on rows that were edited or stored: legacy (recoded) beside the engine's reading of the answers */
export function reconcile(def: SurveyDefinition, table: LegacyTable, plan: MigrationPlan, rows: MigratedRow[]): Reconciliation[] {
  const ci = new Map(table.header.map((h, i) => [h, i]));
  const qById = new Map(def.questions.map((q) => [q.id, q]));
  const recon: Reconciliation[] = [];
  const flats = rows.map((row) => {
    const st = createResponseState(def, { sessionId: "migration", seed: 0 } as never);
    return flattenVariables(def, { ...st, answers: row.answers } as never) as Record<string, unknown>;
  });
  for (const m of plan.columns) {
    const i = ci.get(m.column)!;
    const legacy: Record<string, number> = {}, migrated: Record<string, number> = {};
    table.rows.forEach((r, k) => {
      const raw = r[i];
      if (!isEmpty(raw)) {
        const parts = m.kind === "value" && /multi/.test(qById.get(m.questionId)!.type) ? raw!.split(/[;,|]\s*/) : [raw!];
        for (const p of parts) {
          const t = p.trim();
          if (m.unmappedValues.includes(t)) continue;
          const key = m.kind === "option_flag" ? (truthy(t) ? "1" : "0") : String(m.recode[t] ?? t);
          if (m.kind === "option_flag" && key === "0" && !/^(?:0|false|no)$/i.test(t)) continue;
          legacy[key] = (legacy[key] ?? 0) + 1;
        }
      }
      const fv = flats[k]![m.target];
      const vals = Array.isArray(fv) ? fv : fv == null || fv === "" ? [] : [fv];
      for (const v of vals) migrated[String(v)] = (migrated[String(v)] ?? 0) + 1;
    });
    if (m.kind === "option_flag") { delete migrated["0"]; delete legacy["0"]; }
    const keys = new Set([...Object.keys(legacy), ...Object.keys(migrated)]);
    const matches = [...keys].every((x) => (legacy[x] ?? 0) === (migrated[x] ?? 0));
    recon.push({ variable: m.target, column: m.column, legacy, migrated, matches });
  }
  return recon;
}

/** a legacy data file (CSV or Excel, with an optional codebook sheet) as a table; an SPSS .sav is refused (its rows are not read here) */
export async function legacyTableFrom(bytes: Uint8Array, fileName: string): Promise<LegacyTable | { error: string }> {
  const d = detectFormat(bytes, fileName);
  if (d.format === "sav") return { error: "The rows of an SPSS .sav file are not read yet: export the data as CSV or Excel (with a codebook sheet for the labels) and upload that." };
  if (d.format !== "csv" && d.format !== "xlsx") return { error: `This is ${d.label}, not a data file: upload the responses as CSV or Excel.` };
  const sheets = await readSheets(bytes, fileName);
  const data = sheets.find((sh) => looksLikeDataFile(sh.rows)) ?? sheets[0];
  if (!data || data.rows.length < 2) return { error: "The file has no rows of responses under a header." };
  const codebook = sheets.filter((sh) => sh !== data).map((sh) => readCodebook(sh.rows)).find(Boolean) ?? null;
  const header = data.rows[0]!.map((h) => h.trim());
  const labels: Record<string, string> = {}, valueLabels: Record<string, [string, string][]> = {};
  for (const [name, e] of codebook ?? []) { if (e.label) labels[name] = e.label; if (e.values?.length) valueLabels[name] = e.values; }
  return { header, rows: data.rows.slice(1).filter((r) => r.some((c) => c.trim())), labels, valueLabels };
}

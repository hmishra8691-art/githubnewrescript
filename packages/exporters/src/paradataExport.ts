import type { SurveyDefinition } from "@rescript/schema";
import { listPages } from "@rescript/engine";
import { isRespondentQuestion, pageSeconds, questionSeconds, type ResponseTelemetry } from "@rescript/quality";
import { csvRow } from "./csvCell.js";

/**
 * S5b (TE-10) — PER-PAGE AND PER-QUESTION TIMING IN EXPORTS.
 *
 * The SYSTEM_* block carries the totals; a researcher modelling response latency needs the page and question
 * times themselves. Two shapes, both read from the stored telemetry (`responses.telemetry`) with the quality
 * engine's own arithmetic (`pageSeconds`: dwell minus out-of-focus time, summed over visits; `questionSeconds`:
 * page entry → last change on the answering visit, else an equal share of its page), so an export and the
 * quality review never disagree about how long something took:
 *
 * - LONG (a separate file): one row per respondent × page and per respondent × question, with visits, seconds,
 *   visible seconds, changes, idle seconds and scroll depth where the telemetry has them;
 * - WIDE (optional columns, `timing=1`): `PAGE_<ID>_SEC` and `Q_<VAR>_SEC` (upper case), appended LAST (after SYSTEM_*) in
 *   the CSV, SPSS, SAS, Stata and Excel files, with labels.
 *
 * Blank = not measured (no telemetry, timing switched off, never reached) — never zero.
 */

/** the stored telemetry, when a row carries it (rows exported before S5b, or with timing off, do not) */
export type TimingTelemetry = Pick<ResponseTelemetry, "pages" | "questions"> & Partial<ResponseTelemetry>;

export interface TimingColumn { name: string; label: string; kind: "page" | "question"; id: string }

/** upper case, letters / digits / underscores — the name every format (SPSS upper-cases) writes the same */
const safe = (s: string) => s.toUpperCase().replace(/[^A-Z0-9_]/g, "_").replace(/_+/g, "_").replace(/^_|_$/g, "");
const plain = (s: string | undefined) => (s ?? "").replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim();

/** the wide timing columns, in flow order: every page, then every respondent question placed on a page */
export function timingColumns(def: SurveyDefinition): TimingColumn[] {
  const pages = listPages(def.flow as unknown[] as any[]);
  const byId = new Map(def.questions.map((q) => [q.id, q]));
  const cols: TimingColumn[] = [];
  const used = new Set<string>();
  const add = (c: TimingColumn) => {
    let name = c.name.slice(0, 64);
    for (let i = 2; used.has(name.toUpperCase()); i++) name = `${c.name.slice(0, 60)}_${i}`;
    used.add(name.toUpperCase());
    cols.push({ ...c, name });
  };
  pages.forEach((p, i) => add({ name: `PAGE_${safe(p.node.id) || i + 1}_SEC`, label: `Seconds on page ${p.node.id}${p.node.title ? ` (${plain(p.node.title).slice(0, 60)})` : ""}`, kind: "page", id: p.node.id }));
  for (const p of pages) {
    for (const id of p.node.questionIds ?? []) {
      const q = byId.get(id);
      if (!q || !isRespondentQuestion(q) || q.type === "html" || q.settings?.hidden) continue;
      const v = q.variableName || q.code || q.id;
      add({ name: `Q_${safe(v) || safe(q.id)}_SEC`, label: `Seconds on ${v}: ${plain(q.text).slice(0, 80)}`, kind: "question", id: q.id });
    }
  }
  return cols;
}

const round1 = (n: number) => Math.round(n * 10) / 10;

/** the wide cells for one row: seconds, or "" when the telemetry did not measure it */
export function timingCells(cols: TimingColumn[], t: TimingTelemetry | null | undefined): (number | "")[] {
  if (!t || !Array.isArray(t.pages) || (t.disabled ?? []).includes("timing")) return cols.map(() => "");
  const ps = pageSeconds(t as ResponseTelemetry);
  const qs = questionSeconds(t as ResponseTelemetry);
  return cols.map((c) => {
    const v = c.kind === "page" ? ps[c.id] : qs[c.id];
    return typeof v === "number" && Number.isFinite(v) ? round1(v) : "";
  });
}

/** the label of a wide timing column, for the statistical files' variable labels */
export function timingLabel(def: SurveyDefinition | undefined, name: string): string | undefined {
  if (!def || !/^(PAGE|Q)_.*_SEC$/.test(name)) return undefined;
  return timingColumns(def).find((c) => c.name === name)?.label;
}

/* ------------------------------------------------------------------ long format */

export const TIMING_LONG_HEADER = [
  "SESSION_ID", "RESPONDENT_ID", "STATUS", "LEVEL", "PAGE_ID", "QUESTION_ID", "VARIABLE",
  "VISITS", "SECONDS", "VISIBLE_SECONDS", "CHANGES", "IDLE_SECONDS", "SCROLL_DEPTH_PCT",
] as const;

export interface TimingLongRow {
  sessionId: string;
  respondentId?: string | null;
  status?: string | null;
  telemetry: TimingTelemetry | null | undefined;
}

/**
 * One row per respondent × page (LEVEL=page) and per respondent × question (LEVEL=question), pages in flow
 * order, a respondent's questions after their pages. A respondent without telemetry contributes no rows;
 * pages / questions they never reached are left out (a long file lists what happened).
 */
export function timingLongRows(def: SurveyDefinition, rows: TimingLongRow[]): (string | number)[][] {
  const cols = timingColumns(def);
  const out: (string | number)[][] = [];
  const varOf = new Map(def.questions.map((q) => [q.id, q.variableName || q.code || q.id]));
  for (const r of rows) {
    const t = r.telemetry;
    if (!t || !Array.isArray(t.pages) || (t.disabled ?? []).includes("timing")) continue;
    const ps = pageSeconds(t as ResponseTelemetry);
    const qs = questionSeconds(t as ResponseTelemetry);
    const visits = new Map<string, { n: number; idle: number; depth: number | null }>();
    for (const v of t.pages) {
      const e = visits.get(v.pageId) ?? { n: 0, idle: 0, depth: null };
      e.n++;
      if (typeof v.idleMs === "number") e.idle += v.idleMs;
      if (typeof v.scrollDepth === "number") e.depth = Math.max(e.depth ?? 0, v.scrollDepth);
      visits.set(v.pageId, e);
    }
    const base = [r.sessionId, r.respondentId ?? "", r.status ?? ""];
    const measuredIdle = (t.measured ?? []).includes("idle");
    for (const c of cols) {
      if (c.kind !== "page" || ps[c.id] === undefined) continue;
      const e = visits.get(c.id);
      out.push([...base, "page", c.id, "", "", e?.n ?? 0, round1(ps[c.id]), "", "", measuredIdle ? round1((e?.idle ?? 0) / 1000) : "", e?.depth ?? ""]);
    }
    for (const c of cols) {
      if (c.kind !== "question" || qs[c.id] === undefined) continue;
      const qt = t.questions?.[c.id];
      const pageId = t.pages.find((v) => v.questionIds.includes(c.id))?.pageId ?? "";
      const vis = typeof qt?.visibleMs === "number" ? round1(qt.visibleMs / 1000) : "";
      out.push([...base, "question", pageId, c.id, varOf.get(c.id) ?? c.id, visits.get(pageId)?.n ?? 0, round1(qs[c.id]), vis, qt?.changes ?? 0, "", ""]);
    }
  }
  return out;
}

/** the long timing file as CSV (formula-guarded cells, LF and an optional BOM like every other CSV here) */
export function timingLongCSV(def: SurveyDefinition, rows: TimingLongRow[], opts: { bom?: boolean } = {}): string {
  const lines = [csvRow(TIMING_LONG_HEADER), ...timingLongRows(def, rows).map((r) => csvRow(r))];
  return (opts.bom ? "\uFEFF" : "") + lines.join("\n") + "\n";
}

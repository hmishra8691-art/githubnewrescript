/**
 * THE DATASET: stored responses → analysable cases.
 *
 * The analytics engine never sees a database. The API route streams the
 * survey's responses (already narrowed by environment / status / soft-delete
 * through `apps/studio/lib/responseData.ts`) into `buildDataset`, and every
 * analysis reads columns from the result. Column naming is the Variable
 * Dictionary's (`flattenVariables`) — the same names the researcher sees in
 * the data grid and the export — so an analysis of `Q5_2` means exactly what
 * the export's `Q5_2` means. Filters and segments are ordinary survey
 * `Condition`s evaluated by the survey engine itself (`matchesResponseCondition`),
 * so a filter can never disagree with the logic that produced the data.
 */
import type { Condition, SurveyDefinition, Question, VariableDef } from "@rescript/schema";
import { buildVariableDictionary, flattenVariables, matchesResponseCondition, rowToState, type ResponseRow } from "@rescript/engine";
import type { DatasetSpec, SegmentDef, WeightingSpec } from "./types.js";
import { rimWeights } from "./stats/multivariate.js";

/** A response row as the analytics route receives it (a superset of the engine's ResponseRow). */
export interface AnalyticsRow extends ResponseRow {
  id?: string;
  respondent_code?: string | null;
  is_test?: boolean;
  completed_at?: string | null;
  quality?: { classification?: string; qualityScore?: number; riskScore?: number; flags?: unknown } | null;
  review_status?: string | null;
}

export type VariableRole = "categorical" | "multi" | "numeric" | "scale" | "text" | "date" | "system" | "complex";

export interface VariableMeta {
  name: string;
  label: string;
  /** the option / row label alone, for battery items (“Speed” rather than “Q9 — rank of Speed”) */
  itemLabel?: string;
  role: VariableRole;
  questionId?: string;
  questionCode?: string;
  questionType?: string;
  /** code frame, when categorical / scale */
  categories?: { code: string; label: string }[];
  /** for a matrix / composite / option-flag column */
  rowCode?: string;
  optionCode?: string;
  derived: boolean;
  hidden: boolean;
  sectionId?: string;
}

export interface Case {
  id: string;
  code: string | null;
  status: string;
  environment: "TEST" | "LIVE";
  startedAt: string | null;
  completedAt: string | null;
  durationSec: number | null;
  quality: { classification: string; qualityScore: number | null; riskScore: number | null } | null;
  /** exported variable map */
  vars: Record<string, unknown>;
  /** raw answers keyed by question id — for conjoint / maxdiff / text objects */
  answers: Record<string, unknown>;
  calculated: Record<string, unknown>;
  embedded: Record<string, unknown>;
  flags: string[];
  weight: number;
}

export interface Dataset {
  def: SurveyDefinition;
  variables: VariableMeta[];
  byName: Map<string, VariableMeta>;
  cases: Case[];
  /** before dataset-level exclusions (status / quality) */
  total: number;
  weighted: boolean;
  weightInfo?: { efficiency: number; designEffect: number; min: number; max: number; converged: boolean } | null;
  spec: DatasetSpec;
}

/* ------------------------------------------------------------ variable metadata */

const SCALE_TYPES = new Set(["slider", "nps", "matrix_numeric"]);
const NUMERIC_TYPES = new Set(["numeric", "numeric_list", "allocation", "slider", "nps", "calculated", "matrix_numeric"]);
const TEXT_TYPES = new Set(["open_text", "long_text", "text_list", "matrix_text"]);
const COMPLEX_TYPES = new Set(["conjoint_task", "maxdiff_task", "hotspot", "annotation", "media_timeline", "upload", "repeating_group", "custom_component", "custom_table"]);

function roleFor(v: VariableDef, q: Question | undefined): VariableRole {
  if (v.responseType === "system") return "system";
  const t = q?.type ?? v.responseType;
  if (v.optionCode != null && (t === "multi_select" || t === "multi_dropdown" || t === "image_select" || t === "matrix_multi")) return "categorical"; // 0/1 flag
  if (t === "multi_select" || t === "multi_dropdown" || t === "matrix_multi") return "multi";
  if (t === "image_select" && ((q?.settings?.maxSelections ?? 1) as number) > 1) return "multi";
  if (COMPLEX_TYPES.has(t)) return "complex";
  if (v.dataType === "date" || v.dataType === "time") return "date";
  if (v.valueCodes.length && (t === "single_select" || t === "dropdown" || t === "matrix_single" || t === "matrix_dropdown" || t === "image_select")) {
    // an ordered numeric code frame is a scale (Likert), a text code frame is nominal
    const numeric = v.valueCodes.every((c) => Number.isFinite(Number(c)));
    return numeric && v.valueCodes.length >= 3 && v.valueCodes.length <= 11 && looksOrdinal(v) ? "scale" : "categorical";
  }
  if (t === "ranking" || t === "image_ranking") return "numeric";
  if (SCALE_TYPES.has(t)) return "scale";
  if (NUMERIC_TYPES.has(t) || v.dataType === "numeric") return v.valueCodes.length ? "categorical" : "numeric";
  if (TEXT_TYPES.has(t) || v.dataType === "text") return v.valueCodes.length ? "categorical" : "text";
  if (v.dataType === "boolean") return "categorical";
  return "text";
}

/**
 * A numeric code frame is only a SCALE when its labels say so: labels that are
 * the codes themselves ("1"…"5"), or agreement / satisfaction / likelihood
 * wording, or consecutive codes with an explicit ordered vocabulary. "1 North,
 * 2 South, 3 East" stays nominal.
 */
const ORDINAL_WORDS = /\b(strongly|somewhat|agree|disagree|satisf|dissatisf|likely|unlikely|never|rarely|sometimes|often|always|very|extremely|not at all|neutral|neither|poor|fair|good|excellent|low|high|important|unimportant|daily|weekly|monthly|yearly|definitely|probably)\b/i;
function looksOrdinal(v: VariableDef): boolean {
  const labels = v.valueCodes.map((c) => v.valueLabels[String(c)] ?? String(c));
  if (labels.every((l, i) => l.trim() === String(v.valueCodes[i]))) return true;
  const hits = labels.filter((l) => ORDINAL_WORDS.test(l)).length;
  return hits >= Math.ceil(labels.length / 2);
}

const SYSTEM_VARIABLES: VariableMeta[] = [
  { name: "_status", label: "Response status", role: "categorical", derived: true, hidden: false, categories: [{ code: "complete", label: "Complete" }, { code: "in_progress", label: "In progress" }, { code: "terminated", label: "Terminated" }, { code: "quota_full", label: "Quota full" }, { code: "screened_out", label: "Screened out" }] },
  { name: "_environment", label: "Environment", role: "categorical", derived: true, hidden: false, categories: [{ code: "TEST", label: "Test" }, { code: "LIVE", label: "Production" }] },
  { name: "_duration", label: "Duration (seconds)", role: "numeric", derived: true, hidden: false },
  { name: "_started_date", label: "Start date", role: "date", derived: true, hidden: false },
  { name: "_started_week", label: "Start week", role: "categorical", derived: true, hidden: false },
  { name: "_started_month", label: "Start month", role: "categorical", derived: true, hidden: false },
  { name: "_quality_class", label: "Quality classification", role: "categorical", derived: true, hidden: false },
  { name: "_quality_score", label: "Quality score", role: "numeric", derived: true, hidden: false },
  { name: "_risk_score", label: "Risk score", role: "numeric", derived: true, hidden: false },
];

export function variableMetadata(def: SurveyDefinition): VariableMeta[] {
  const qById = new Map(def.questions.map((q) => [q.id, q]));
  const out: VariableMeta[] = [];
  for (const v of buildVariableDictionary(def)) {
    if (v.responseType === "system") continue;
    const q = v.questionId ? qById.get(v.questionId) : undefined;
    const role = roleFor(v, q);
    const categories = v.valueCodes.length
      ? v.valueCodes.map((c) => ({ code: String(c), label: v.valueLabels[String(c)] ?? String(c) }))
      : role === "categorical" && v.optionCode != null ? [{ code: "0", label: "Not selected" }, { code: "1", label: "Selected" }] : undefined;
    const itemLabel = q && v.optionCode != null ? q.options.find((o) => String(o.code) === String(v.optionCode))?.label
      : q && v.rowCode != null ? q.rows.find((r) => String(r.code) === String(v.rowCode))?.label : undefined;
    out.push({
      name: v.name, label: v.label || v.name, itemLabel: itemLabel ? strip(itemLabel) : undefined, role, questionId: v.questionId, questionCode: v.questionCode, questionType: q?.type ?? v.responseType,
      categories, rowCode: v.rowCode, optionCode: v.optionCode, derived: v.derived, hidden: v.hidden, sectionId: v.sectionId,
    });
  }
  /*
   * QUESTION-LEVEL ENTRIES THE DICTIONARY DOES NOT DECLARE. A multi-select is
   * exported as `VAR_<code>` flags, but `flattenVariables` also writes `VAR`
   * as the array of chosen codes — the natural thing to crosstab or TURF. A
   * ranking or allocation has only per-option columns; the analyses want the
   * whole battery by the question's name. Insert those heads before their
   * children so a picker shows the question, then its parts.
   */
  const named = new Set(out.map((v) => v.name));
  const heads: { at: number; meta: VariableMeta }[] = [];
  for (const q of def.questions) {
    if (named.has(q.variableName)) continue;
    const first = out.findIndex((v) => v.questionId === q.id);
    if (first < 0) continue;
    const isMulti = q.type === "multi_select" || q.type === "multi_dropdown" || (q.type === "image_select" && ((q.settings?.maxSelections ?? 1) as number) > 1);
    const isBattery = q.type === "ranking" || q.type === "image_ranking" || q.type === "allocation" || q.type.startsWith("matrix_") || q.type === "composite";
    if (!isMulti && !isBattery) continue;
    heads.push({ at: first, meta: {
      name: q.variableName, label: `${q.code} — ${strip(q.text)}`, role: isMulti ? "multi" : "complex", questionId: q.id, questionCode: q.code, questionType: q.type,
      categories: isMulti ? q.options.map((o) => ({ code: String(o.code), label: o.label })) : undefined, derived: false, hidden: false, sectionId: out[first].sectionId,
    } });
  }
  for (const h of heads.sort((a, b) => b.at - a.at)) out.splice(h.at, 0, h.meta);
  return [...out, ...SYSTEM_VARIABLES];
}

const strip = (html: string) => html.replace(/<[^>]*>/g, "").replace(/\{\{[^}]*\}\}/g, "…").trim();

/* ------------------------------------------------------------ cases */

function isoWeek(d: Date): string {
  const t = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
  const day = t.getUTCDay() || 7;
  t.setUTCDate(t.getUTCDate() + 4 - day);
  const yearStart = new Date(Date.UTC(t.getUTCFullYear(), 0, 1));
  const week = Math.ceil(((t.getTime() - yearStart.getTime()) / 86400000 + 1) / 7);
  return `${t.getUTCFullYear()}-W${String(week).padStart(2, "0")}`;
}

export function rowToCase(def: SurveyDefinition, row: AnalyticsRow): Case {
  const state = rowToState(def, row);
  const vars = flattenVariables(def, state);
  const started = row.started_at ? new Date(row.started_at) : null;
  const completed = row.completed_at ? new Date(row.completed_at) : null;
  const duration = started && completed ? Math.max(0, (completed.getTime() - started.getTime()) / 1000) : null;
  const q = row.quality ?? null;
  vars._status = row.status ?? "complete";
  vars._environment = row.is_test ? "TEST" : "LIVE";
  vars._duration = duration;
  vars._started_date = started ? started.toISOString().slice(0, 10) : null;
  vars._started_week = started ? isoWeek(started) : null;
  vars._started_month = started ? started.toISOString().slice(0, 7) : null;
  vars._quality_class = q?.classification ?? null;
  vars._quality_score = q?.qualityScore ?? null;
  vars._risk_score = q?.riskScore ?? null;
  return {
    id: row.id ?? row.session_id ?? "",
    code: row.respondent_code ?? null,
    status: row.status ?? "complete",
    environment: row.is_test ? "TEST" : "LIVE",
    startedAt: row.started_at ?? null,
    completedAt: row.completed_at ?? null,
    durationSec: duration,
    quality: q ? { classification: q.classification ?? "UNKNOWN", qualityScore: q.qualityScore ?? null, riskScore: q.riskScore ?? null } : null,
    vars,
    answers: (row.answers ?? {}) as Record<string, unknown>,
    calculated: (row.calculated ?? {}) as Record<string, unknown>,
    embedded: (row.embedded ?? {}) as Record<string, unknown>,
    flags: Array.isArray(row.flags) ? (row.flags as string[]) : [],
    weight: 1,
  };
}

/* ------------------------------------------------------------ build */

export interface BuildOptions {
  spec: DatasetSpec;
  filter?: Condition | null;
  weighting?: WeightingSpec | null;
}

export function buildDataset(def: SurveyDefinition, rows: AnalyticsRow[], opts: BuildOptions): Dataset {
  const variables = variableMetadata(def);
  const byName = new Map(variables.map((v) => [v.name, v]));
  const statuses = opts.spec.statuses?.length ? new Set(opts.spec.statuses) : new Set(["complete"]);
  let cases: Case[] = [];
  for (const row of rows) {
    if (opts.spec.environment === "TEST" && !row.is_test) continue;
    if (opts.spec.environment === "LIVE" && row.is_test) continue;
    if (!statuses.has(row.status ?? "complete")) continue;
    if (opts.spec.dataset === "clean" && row.quality && row.quality.classification && row.quality.classification !== "CLEAN") continue;
    if (opts.spec.dataset === "custom" && opts.spec.qualityClasses?.length && !opts.spec.qualityClasses.includes(row.quality?.classification ?? "UNKNOWN")) continue;
    if (opts.filter && !matchesResponseCondition(def, opts.filter, row)) continue;
    cases.push(rowToCase(def, row));
  }
  const ds: Dataset = { def, variables, byName, cases, total: rows.length, weighted: false, spec: opts.spec, weightInfo: null };
  if (opts.weighting) applyWeighting(ds, opts.weighting);
  return ds;
}

export function applyWeighting(ds: Dataset, w: WeightingSpec): void {
  if (w.variable) {
    for (const c of ds.cases) { const v = Number(c.vars[w.variable]); c.weight = Number.isFinite(v) && v > 0 ? v : 0; }
    ds.weighted = true;
    const ws = ds.cases.map((c) => c.weight).filter((x) => x > 0);
    ds.weightInfo = ws.length ? summariseWeights(ws) : null;
    return;
  }
  if (w.rim?.length) {
    const targets = w.rim.map((r) => ({ variable: r.variable, targets: normaliseTargets(r.targets) }));
    const rows = ds.cases.map((c) => Object.fromEntries(targets.map((t) => [t.variable, c.vars[t.variable] == null ? null : String(c.vars[t.variable])])));
    const res = rimWeights(rows, targets, { cap: w.cap });
    ds.cases.forEach((c, i) => { c.weight = res.weights[i]; });
    ds.weighted = true;
    ds.weightInfo = { efficiency: res.efficiency, designEffect: res.designEffect, min: res.min, max: res.max, converged: res.converged };
  }
}

function normaliseTargets(t: Record<string, number>): Record<string, number> {
  const sum = Object.values(t).reduce((a, b) => a + b, 0);
  if (!sum) return t;
  const out: Record<string, number> = {};
  for (const [k, v] of Object.entries(t)) out[k] = v / sum;
  return out;
}

function summariseWeights(ws: number[]) {
  const n = ws.length, sum = ws.reduce((a, b) => a + b, 0), sq = ws.reduce((a, b) => a + b * b, 0);
  const eff = (sum * sum) / (n * sq);
  return { efficiency: eff * 100, designEffect: 1 / eff, min: Math.min(...ws), max: Math.max(...ws), converged: true };
}

/* ------------------------------------------------------------ subsets */

export function subset(ds: Dataset, cases: Case[]): Dataset {
  return { ...ds, cases };
}

export function filterDataset(ds: Dataset, condition: Condition | null | undefined): Dataset {
  if (!condition) return ds;
  const rows = ds.cases.filter((c) => matchesCase(ds.def, condition, c));
  return subset(ds, rows);
}

/** Evaluate a Condition on a built case — the same engine evaluator the survey ran. */
export function matchesCase(def: SurveyDefinition, condition: Condition, c: Case): boolean {
  return matchesResponseCondition(def, condition, {
    session_id: c.id, status: c.status, answers: c.answers, calculated: c.calculated, embedded: c.embedded, flags: c.flags, started_at: c.startedAt,
  });
}

/** Split into named segments (a case may belong to several). */
export function segmentDatasets(ds: Dataset, segments: SegmentDef[] | undefined): { segment: SegmentDef; data: Dataset }[] {
  if (!segments?.length) return [];
  return segments.map((s) => ({ segment: s, data: filterDataset(ds, s.condition) }));
}

/* ------------------------------------------------------------ columns */

export function numericColumn(ds: Dataset, name: string): (number | null)[] {
  return ds.cases.map((c) => {
    const v = c.vars[name];
    if (v == null || v === "") return null;
    if (Array.isArray(v)) return v.length ? Number(v[0]) : null;
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
  });
}

export function categoricalColumn(ds: Dataset, name: string): (string | string[] | null)[] {
  return ds.cases.map((c) => {
    const v = c.vars[name];
    if (v == null || v === "") return null;
    if (Array.isArray(v)) return v.map(String);
    if (typeof v === "object") return null;
    return String(v);
  });
}

export function textColumn(ds: Dataset, name: string): (string | null)[] {
  return ds.cases.map((c) => {
    const v = c.vars[name];
    if (v == null || v === "") return null;
    return typeof v === "string" ? v : Array.isArray(v) ? v.join(" ") : String(v);
  });
}

export function weights(ds: Dataset): number[] | undefined {
  return ds.weighted ? ds.cases.map((c) => c.weight) : undefined;
}

export function weightedN(ds: Dataset): number {
  return ds.weighted ? ds.cases.reduce((t, c) => t + c.weight, 0) : ds.cases.length;
}

/** Code frame for a variable, or derived from the data when none is programmed. */
export function categoriesOf(ds: Dataset, name: string): { code: string; label: string }[] {
  const meta = ds.byName.get(name);
  if (meta?.categories?.length) return meta.categories;
  const seen = new Set<string>();
  for (const v of categoricalColumn(ds, name)) {
    if (v == null) continue;
    for (const c of Array.isArray(v) ? v : [v]) seen.add(c);
  }
  return [...seen].sort((a, b) => Number(a) - Number(b) || a.localeCompare(b)).map((c) => ({ code: c, label: c }));
}

export function labelOf(ds: Dataset, name: string): string {
  return ds.byName.get(name)?.label ?? name;
}

/** Short label for a battery item: the option / row text when there is one. */
export function itemLabelOf(ds: Dataset, name: string): string {
  const m = ds.byName.get(name);
  return m?.itemLabel ?? m?.label ?? name;
}

/** Numeric codes of an ordered scale (for top/bottom box, NPS etc.) */
export function scaleCodes(ds: Dataset, name: string): number[] {
  return categoriesOf(ds, name).map((c) => Number(c.code)).filter((n) => Number.isFinite(n)).sort((a, b) => a - b);
}

/** Variables sharing a question (matrix rows, option flags) — a "battery". */
export function battery(ds: Dataset, questionId: string): VariableMeta[] {
  return ds.variables.filter((v) => v.questionId === questionId && !v.derived && v.role !== "multi" && v.role !== "complex");
}

/** Variables suitable for an analysis kind, for the variable picker. */
export function variablesForRoles(ds: Dataset, roles: VariableRole[]): VariableMeta[] {
  return ds.variables.filter((v) => roles.includes(v.role) && !v.hidden);
}

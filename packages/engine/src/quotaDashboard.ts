/**
 * QUOTA DASHBOARD MODEL — the read side of the quota system, as one pure function.
 *
 * The quota engine (`quotas.ts`) decides whether a respondent may continue;
 * the dashboard's job is to make the same configuration and the same counts
 * legible at a glance and to keep numeric edits safe. Nothing here is a second
 * quota model: every number is derived from `def.quotas` (the configuration
 * the Logic Builder writes) and `QuotaCounts` (the counters the runtime
 * increments), so the dashboard cannot disagree with what the engine enforces.
 *
 *   configuration  +  counts  →  quotaDashboard()  →  rows / summary / status
 *   configuration              →  quotaReferences() →  who depends on a quota
 *   an edit                    →  validateQuotaEdit() → errors + over-cap warnings
 *                              →  applyQuotaEdit()    → the new Quota, unchanged otherwise
 */
import type { Condition, ConditionRule, Quota, QuotaCell, SurveyDefinition } from "@rescript/schema";
import { effectiveLimit, type QuotaCounts } from "./quotas.js";
import { conditionSummary } from "./logicSummary.js";
import { getQuestionByCodeOrVar } from "./state.js";

/* ------------------------------------------------------------ status */

/**
 *   FULL        count has reached the maximum — a hard quota turns this cell away
 *   NEAR_FULL   at or above `nearFullPct` of the maximum (default 90 %)
 *   ACTIVE      open, with capacity to spare
 *   UNLIMITED   no effective maximum (limit 0, or a percent with no target total) — counts only
 */
export type QuotaCellState = "FULL" | "NEAR_FULL" | "ACTIVE" | "UNLIMITED";
/**
 * A quota adds INACTIVE: it is configured and counted, but nothing enforces it
 * — no `quota_check` node reads it and no List Fill consults it — so it can
 * never turn a respondent away. Configured-but-idle is the one state a
 * programmer most needs to notice, so it is named rather than inferred.
 */
export type QuotaState = QuotaCellState | "INACTIVE";

export const QUOTA_STATE_LABEL: Record<QuotaState, string> = {
  FULL: "FULL", NEAR_FULL: "NEAR FULL", ACTIVE: "ACTIVE", UNLIMITED: "UNLIMITED", INACTIVE: "INACTIVE",
};
/** the order the dashboard sorts by when the programmer has not chosen — what needs attention first */
export const QUOTA_STATE_SEVERITY: Record<QuotaState, number> = { FULL: 0, NEAR_FULL: 1, ACTIVE: 2, UNLIMITED: 3, INACTIVE: 4 };

/* ------------------------------------------------------------ rows */

export interface QuotaSourceQuestion {
  questionId: string;
  code: string;
  text: string;
  type: string;
  variableName: string;
}

export interface QuotaCellRow {
  quotaId: string;
  cellId: string;
  label: string;
  /** the cell's condition, in words */
  condition: string;
  /** as configured */
  limit: number;
  limitType: "count" | "percent";
  target?: number;
  /** resolved maximum in completes (percent × target total); 0 = unlimited */
  maximum: number;
  /** resolved target in completes, when a target is configured */
  targetCount: number | null;
  current: number;
  remainingToMaximum: number | null;
  remainingToTarget: number | null;
  /** 0–100+ against the maximum; null when unlimited */
  pct: number | null;
  state: QuotaCellState;
}

export interface QuotaReferences {
  /** `quota_check` flow nodes that read this quota */
  quotaChecks: { nodeId: string; onFull: string }[];
  /** List Fills that consult it — explicitly by id, or implicitly because they respect every hard quota */
  listFills: { id: string; name: string; explicit: boolean }[];
  /** rules anywhere in the definition that read the quota's count (`quota.<id>`) */
  conditions: { where: string }[];
}

export interface QuotaRow {
  id: string;
  name: string;
  mode: "hard" | "soft";
  onFull: string;
  targetTotal?: number;
  countStatus: string[];
  /** the questions the cell conditions read, in first-seen order */
  sources: QuotaSourceQuestion[];
  /** how many distinct questions the cells cross — 1 = simple, 2+ = multi-dimensional */
  dimensions: number;
  cells: QuotaCellRow[];
  current: number;
  /** sum of finite maximums; null when no cell has one */
  maximum: number | null;
  remaining: number | null;
  pct: number | null;
  state: QuotaState;
  references: QuotaReferences;
  enforced: boolean;
  updatedAt?: string;
}

export interface QuotaSummary {
  total: number;
  byState: Record<QuotaState, number>;
  /** sum of remaining-to-maximum over every limited cell */
  remainingCapacity: number;
  currentTotal: number;
  maximumTotal: number;
  /**
   * completes ÷ capacity over the limited cells — a weighted figure, so a
   * 10-person cell at 100 % does not read as "50 % overall" next to a
   * 1,000-person cell at 0 %. Null when nothing has a maximum.
   */
  utilization: number | null;
}

export interface QuotaDashboard {
  quotas: QuotaRow[];
  summary: QuotaSummary;
}

export interface QuotaDashboardOptions {
  /** percentage of the maximum from which a cell counts as NEAR_FULL (default 90) */
  nearFullPct?: number;
  /** when each quota's counters last changed, from storage */
  updatedAt?: Record<string, string>;
}

/* ------------------------------------------------------------ helpers */

function walkRules(c: Condition | undefined | null, visit: (r: ConditionRule) => void): void {
  if (!c) return;
  if (c.type === "rule") { visit(c); return; }
  for (const ch of c.children) walkRules(ch, visit);
}

/** every question a condition reads, resolved through id / code / variable name */
function questionsIn(def: SurveyDefinition, c: Condition | undefined): QuotaSourceQuestion[] {
  const out: QuotaSourceQuestion[] = [];
  const seen = new Set<string>();
  walkRules(c, (r) => {
    if (r.source.kind !== "question" && r.source.kind !== "variable") return;
    const q = getQuestionByCodeOrVar(def, r.source.ref);
    if (!q || seen.has(q.id)) return;
    seen.add(q.id);
    out.push({ questionId: q.id, code: q.code, text: q.text.replace(/<[^>]*>/g, ""), type: q.type, variableName: q.variableName });
  });
  return out;
}

export function cellState(current: number, maximum: number, nearFullPct: number): QuotaCellState {
  if (maximum <= 0) return "UNLIMITED";
  if (current >= maximum) return "FULL";
  if ((current / maximum) * 100 >= nearFullPct) return "NEAR_FULL";
  return "ACTIVE";
}

/* ------------------------------------------------------------ references */

/** Everything in the definition that depends on one quota. */
export function quotaReferences(def: SurveyDefinition, quotaId: string): QuotaReferences {
  const quota = def.quotas.find((q) => q.id === quotaId);
  const out: QuotaReferences = { quotaChecks: [], listFills: [], conditions: [] };

  const visitFlow = (nodes: any[]) => {
    for (const n of nodes ?? []) {
      if (n?.type === "quota_check" && (n.quotaIds ?? []).includes(quotaId)) out.quotaChecks.push({ nodeId: n.id, onFull: n.onFull?.kind ?? "terminate" });
      if (n?.visibleIf) conditionRefs(n.visibleIf, `${n.type} ${n.title ?? n.id}`);
      if (n?.when) conditionRefs(n.when, `${n.type} ${n.title ?? n.id}`);
      if (n?.eligibleIf) conditionRefs(n.eligibleIf, `loop ${n.loopVar}`);
      if (n?.children) visitFlow(n.children);
      if (n?.otherwise) visitFlow(n.otherwise);
      for (const b of n?.branches ?? []) { conditionRefs(b.when, `branch ${b.label ?? b.id}`); visitFlow(b.children); }
    }
  };
  const conditionRefs = (c: Condition | undefined, where: string) =>
    walkRules(c, (r) => { if (r.source.kind === "quota" && r.source.ref === quotaId) out.conditions.push({ where }); });

  visitFlow(def.flow as any[]);
  for (const q of def.questions) {
    conditionRefs(q.displayLogic, `${q.code} display logic`);
    for (const s of q.skipLogic ?? []) conditionRefs(s.when, `${q.code} skip logic`);
    for (const v of q.validation ?? []) conditionRefs(v.when, `${q.code} validation`);
    for (const o of q.options ?? []) { conditionRefs(o.visibleIf, `${q.code} option ${o.label}`); conditionRefs(o.logic?.when, `${q.code} option ${o.label}`); }
    for (const p of q.punches ?? []) conditionRefs(p.when, `${q.code} auto-punch`);
  }
  for (const c of def.calculations ?? []) conditionRefs(c.when, `calculation ${c.targetVariable}`);
  for (const r of def.displayRules ?? []) conditionRefs(r.when, `display rule ${r.label ?? r.id}`);
  for (const lf of def.listFills ?? []) {
    conditionRefs(lf.runWhen, `List Fill ${lf.name ?? lf.id}`);
    for (const o of lf.options ?? []) conditionRefs(o.eligibleWhen, `List Fill ${lf.name ?? lf.id} option ${o.label ?? o.code}`);
    if (!lf.enabled || !lf.tracking?.respectQuotas) continue;
    const explicit = (lf.tracking.quotaIds ?? []).includes(quotaId);
    // a List Fill with no ids consults EVERY hard quota — an implicit dependency
    const implicit = !(lf.tracking.quotaIds ?? []).length && quota?.mode === "hard";
    if (explicit || implicit) out.listFills.push({ id: lf.id, name: lf.name ?? lf.id, explicit });
  }
  return out;
}

/* ------------------------------------------------------------ the dashboard */

export function quotaCellRow(def: SurveyDefinition, quota: Quota, cell: QuotaCell, counts: QuotaCounts, nearFullPct = 90): QuotaCellRow {
  const current = counts[quota.id]?.[cell.id] ?? 0;
  const maximum = effectiveLimit(quota, cell.limit, cell.limitType);
  const targetCount = cell.target != null ? effectiveLimit(quota, cell.target, cell.limitType) : null;
  const state = cellState(current, maximum, nearFullPct);
  return {
    quotaId: quota.id, cellId: cell.id, label: cell.label,
    condition: conditionSummary(def, cell.when) || "every respondent",
    limit: cell.limit, limitType: cell.limitType, target: cell.target,
    maximum, targetCount, current,
    remainingToMaximum: maximum > 0 ? Math.max(0, maximum - current) : null,
    remainingToTarget: targetCount != null && targetCount > 0 ? Math.max(0, targetCount - current) : null,
    pct: maximum > 0 ? Math.round((current / maximum) * 1000) / 10 : null,
    state,
  };
}

export function quotaRow(def: SurveyDefinition, quota: Quota, counts: QuotaCounts, opts: QuotaDashboardOptions = {}): QuotaRow {
  const nearFullPct = opts.nearFullPct ?? 90;
  const cells = quota.cells.map((c) => quotaCellRow(def, quota, c, counts, nearFullPct));
  const sources: QuotaSourceQuestion[] = [];
  const seen = new Set<string>();
  for (const c of quota.cells) for (const s of questionsIn(def, c.when)) if (!seen.has(s.questionId)) { seen.add(s.questionId); sources.push(s); }
  // dimensions = the most questions any single cell crosses (Male × 25–34 = 2)
  const dimensions = quota.cells.reduce((m, c) => Math.max(m, questionsIn(def, c.when).length), 0);

  const limited = cells.filter((c) => c.maximum > 0);
  const current = cells.reduce((t, c) => t + c.current, 0);
  const maximum = limited.length ? limited.reduce((t, c) => t + c.maximum, 0) : null;
  const references = quotaReferences(def, quota.id);
  const enforced = references.quotaChecks.length > 0 || references.listFills.length > 0;

  let state: QuotaState;
  if (!enforced) state = "INACTIVE";
  else if (!limited.length) state = "UNLIMITED";
  else if (limited.every((c) => c.state === "FULL")) state = "FULL";
  else if (limited.some((c) => c.state === "FULL" || c.state === "NEAR_FULL")) state = "NEAR_FULL";
  else state = "ACTIVE";

  return {
    id: quota.id, name: quota.name, mode: quota.mode, onFull: quota.onFull.kind, targetTotal: quota.targetTotal,
    countStatus: quota.countStatus, sources, dimensions, cells, current, maximum,
    remaining: maximum != null ? limited.reduce((t, c) => t + (c.remainingToMaximum ?? 0), 0) : null,
    pct: maximum ? Math.round((current / maximum) * 1000) / 10 : null,
    state, references, enforced,
    updatedAt: opts.updatedAt?.[quota.id],
  };
}

export function quotaDashboard(def: SurveyDefinition, counts: QuotaCounts, opts: QuotaDashboardOptions = {}): QuotaDashboard {
  const quotas = def.quotas.map((q) => quotaRow(def, q, counts, opts));
  const byState: Record<QuotaState, number> = { FULL: 0, NEAR_FULL: 0, ACTIVE: 0, UNLIMITED: 0, INACTIVE: 0 };
  let remainingCapacity = 0, currentTotal = 0, maximumTotal = 0;
  for (const q of quotas) {
    byState[q.state]++;
    for (const c of q.cells) {
      if (c.maximum <= 0) continue;
      remainingCapacity += c.remainingToMaximum ?? 0;
      currentTotal += c.current;
      maximumTotal += c.maximum;
    }
  }
  return {
    quotas,
    summary: {
      total: quotas.length, byState, remainingCapacity, currentTotal, maximumTotal,
      utilization: maximumTotal > 0 ? Math.round((currentTotal / maximumTotal) * 1000) / 10 : null,
    },
  };
}

/* ------------------------------------------------------------ search / filter / sort */

export type QuotaFilter = "all" | "active" | "near_full" | "full" | "inactive" | "unlimited";
export type QuotaSort = "status" | "name" | "question" | "current" | "remaining" | "pct" | "updated";

/** everything a programmer might type to find a quota */
export function quotaSearchText(row: QuotaRow): string {
  return [
    row.name, row.id, row.mode, QUOTA_STATE_LABEL[row.state],
    ...row.sources.flatMap((s) => [s.code, s.text, s.variableName, s.questionId]),
    ...row.cells.flatMap((c) => [c.label, c.cellId, c.condition]),
  ].join(" ").toLowerCase();
}

export function filterQuotas(rows: QuotaRow[], search: string, filter: QuotaFilter): QuotaRow[] {
  const needle = search.trim().toLowerCase();
  return rows.filter((r) => {
    if (needle && !quotaSearchText(r).includes(needle)) return false;
    switch (filter) {
      case "active": return r.state === "ACTIVE";
      case "near_full": return r.state === "NEAR_FULL";
      case "full": return r.state === "FULL";
      case "inactive": return r.state === "INACTIVE";
      case "unlimited": return r.state === "UNLIMITED";
      default: return true;
    }
  });
}

export function sortQuotas(rows: QuotaRow[], sort: QuotaSort, direction: "asc" | "desc" = "asc"): QuotaRow[] {
  const dir = direction === "asc" ? 1 : -1;
  const cmpNum = (a: number | null, b: number | null) => (a ?? -1) - (b ?? -1);
  const out = [...rows].sort((a, b) => {
    switch (sort) {
      case "name": return dir * a.name.localeCompare(b.name);
      case "question": return dir * (a.sources[0]?.code ?? "").localeCompare(b.sources[0]?.code ?? "", undefined, { numeric: true });
      case "current": return dir * (a.current - b.current);
      case "remaining": return dir * cmpNum(a.remaining, b.remaining);
      case "pct": return dir * cmpNum(a.pct, b.pct);
      case "updated": return dir * (a.updatedAt ?? "").localeCompare(b.updatedAt ?? "");
      case "status":
      default: {
        const s = QUOTA_STATE_SEVERITY[a.state] - QUOTA_STATE_SEVERITY[b.state];
        // within a status, the fuller first — that is what "needs attention" means
        return dir * (s !== 0 ? s : cmpNum(b.pct, a.pct));
      }
    }
  });
  return out;
}

/* ------------------------------------------------------------ editing */

/** The numeric fields the dashboard may change directly — nothing the engine derives. */
export interface QuotaEdit {
  name?: string;
  targetTotal?: number | null;
  cells?: { cellId: string; label?: string; limit?: number; target?: number | null; limitType?: "count" | "percent" }[];
}

export interface QuotaEditIssue {
  cellId?: string;
  field: "name" | "targetTotal" | "limit" | "target" | "limitType";
  message: string;
}

export interface QuotaEditCheck {
  /** must be empty before the edit may be saved */
  errors: QuotaEditIssue[];
  /** allowed, but only after the programmer confirms (a new maximum below the current count) */
  warnings: QuotaEditIssue[];
  /** the quota as it would be after the edit */
  next: Quota;
}

const isInt = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v) && Math.floor(v) === v;

/** Apply an edit to a copy of the quota. Cells the edit does not mention are untouched. */
export function applyQuotaEdit(quota: Quota, edit: QuotaEdit): Quota {
  const next: Quota = structuredClone(quota);
  if (edit.name !== undefined) next.name = edit.name;
  if (edit.targetTotal !== undefined) {
    if (edit.targetTotal === null) delete next.targetTotal; else next.targetTotal = edit.targetTotal;
  }
  for (const e of edit.cells ?? []) {
    const cell = next.cells.find((c) => c.id === e.cellId);
    if (!cell) continue;
    if (e.label !== undefined) cell.label = e.label;
    if (e.limit !== undefined) cell.limit = e.limit;
    if (e.limitType !== undefined) cell.limitType = e.limitType;
    if (e.target !== undefined) { if (e.target === null) delete cell.target; else cell.target = e.target; }
  }
  return next;
}

/**
 * Validate an edit against the quota model AND against the counts already
 * collected. Errors block the save; warnings need a confirmation. Response
 * data is never touched by any of this — a maximum below the current count
 * only means the cell is full from now on.
 */
export function validateQuotaEdit(quota: Quota, edit: QuotaEdit, counts: QuotaCounts): QuotaEditCheck {
  const errors: QuotaEditIssue[] = [];
  const warnings: QuotaEditIssue[] = [];
  const next = applyQuotaEdit(quota, edit);

  if (!next.name.trim()) errors.push({ field: "name", message: "A quota needs a name." });
  if (next.targetTotal !== undefined && (!isInt(next.targetTotal) || next.targetTotal < 0))
    errors.push({ field: "targetTotal", message: "Target total must be a whole number of 0 or more." });

  const usesPercent = next.cells.some((c) => c.limitType === "percent");
  if (usesPercent && !(next.targetTotal && next.targetTotal > 0))
    errors.push({ field: "targetTotal", message: "Percent limits need a target total greater than 0, otherwise every percent cell is unlimited." });

  for (const cell of next.cells) {
    const touched = (edit.cells ?? []).find((e) => e.cellId === cell.id);
    const unit = cell.limitType === "percent" ? "%" : "";
    if (!isInt(cell.limit) || cell.limit < 0)
      errors.push({ cellId: cell.id, field: "limit", message: `${cell.label}: maximum must be a whole number of 0 or more.` });
    if (cell.limitType === "percent" && cell.limit > 100)
      errors.push({ cellId: cell.id, field: "limit", message: `${cell.label}: a percent maximum cannot exceed 100%.` });
    if (cell.target != null) {
      if (!isInt(cell.target) || cell.target < 0)
        errors.push({ cellId: cell.id, field: "target", message: `${cell.label}: target must be a whole number of 0 or more.` });
      else if (cell.limitType === "percent" && cell.target > 100)
        errors.push({ cellId: cell.id, field: "target", message: `${cell.label}: a percent target cannot exceed 100%.` });
      else if (cell.limit > 0 && cell.target > cell.limit)
        errors.push({ cellId: cell.id, field: "limit", message: `${cell.label}: Maximum (${cell.limit}${unit}) must be greater than or equal to Target (${cell.target}${unit}).` });
    }
    // over-cap: only for cells the edit changed, and only when the new maximum is finite
    if (touched && (touched.limit !== undefined || touched.limitType !== undefined || edit.targetTotal !== undefined)) {
      const current = counts[quota.id]?.[cell.id] ?? 0;
      const newMax = effectiveLimit(next, cell.limit, cell.limitType);
      const oldMax = effectiveLimit(quota, quota.cells.find((c) => c.id === cell.id)!.limit, quota.cells.find((c) => c.id === cell.id)!.limitType);
      if (newMax > 0 && current > newMax && !(oldMax > 0 && current > oldMax && newMax >= oldMax))
        warnings.push({ cellId: cell.id, field: "limit", message: `${cell.label}: the current response count (${current}) already exceeds the new maximum (${newMax}). This change may cause the quota to be considered full immediately. No responses are changed.` });
    }
  }
  return { errors, warnings, next };
}

/** A before/after record for the audit log — only the fields that changed. */
export function quotaEditDiff(before: Quota, after: Quota): Record<string, { before: unknown; after: unknown }> {
  const diff: Record<string, { before: unknown; after: unknown }> = {};
  if (before.name !== after.name) diff.name = { before: before.name, after: after.name };
  if (before.targetTotal !== after.targetTotal) diff.targetTotal = { before: before.targetTotal ?? null, after: after.targetTotal ?? null };
  for (const b of before.cells) {
    const a = after.cells.find((c) => c.id === b.id);
    if (!a) { diff[`cell.${b.id}`] = { before: { label: b.label, limit: b.limit }, after: null }; continue; }
    if (b.limit !== a.limit) diff[`cell.${b.id}.limit`] = { before: b.limit, after: a.limit };
    if ((b.target ?? null) !== (a.target ?? null)) diff[`cell.${b.id}.target`] = { before: b.target ?? null, after: a.target ?? null };
    if (b.limitType !== a.limitType) diff[`cell.${b.id}.limitType`] = { before: b.limitType, after: a.limitType };
    if (b.label !== a.label) diff[`cell.${b.id}.label`] = { before: b.label, after: a.label };
  }
  for (const a of after.cells) if (!before.cells.some((b) => b.id === a.id)) diff[`cell.${a.id}`] = { before: null, after: { label: a.label, limit: a.limit } };
  return diff;
}

import type { AnalysisResult, ChartData, ReportDefinition, ResultTable } from "./types.js";

/**
 * LIVE DASHBOARDS FOR PEOPLE WITHOUT AN ACCOUNT (Level 5 roadmap R2, 2026-11-22).
 *
 * A shared report or dashboard never reaches the dataset: every answer a viewer can ask for is computed when it is
 * published and frozen (pre-aggregated). Three things ride on that:
 *
 *   viewer filters   saved filters a viewer may apply (since §36) — one frozen result set per filter
 *   drill-down       the values of ONE variable a viewer may click into — one frozen result set per value
 *                    (`drillPlan`), at most 12
 *   minimum base     no number from fewer than `minBase` people leaves (`protectResult`): a whole result under the
 *                    base is withheld, a table column under it is blanked, a segment under it is removed — each
 *                    says so. (Small-cell suppression of counts is a different rule and is not applied here.) Filter and drill variants are protected
 *                    at 30 unless the report sets `minBase`; the main results only when the report sets it.
 *
 * Applied when publishing and again when a share is read, so a version published before this existed is protected
 * on its next view. Idempotent. Browser-safe.
 */
export const DEFAULT_VARIANT_MIN_BASE = 30;
export const MAX_DRILL_VALUES = 12;

export interface DrillDown { variable: string; label?: string; values: { value: string | number; label: string }[] }
export interface DrillVariants { variable: string; label: string; values: { value: string | number; label: string }[]; results: Record<string, Record<string, AnalysisResult>> }

/** the drill-down a report asks for, checked: a variable name and 1–12 labelled values (duplicates dropped) */
export function drillPlan(report: Pick<ReportDefinition, "drillDown">): { plan: DrillDown | null; problems: string[] } {
  const d = report.drillDown;
  if (!d) return { plan: null, problems: [] };
  const problems: string[] = [];
  if (typeof d.variable !== "string" || !/^[A-Za-z_][\w.]{0,63}$/.test(d.variable)) problems.push("The drill-down needs a variable name.");
  const seen = new Set<string>();
  const values = (Array.isArray(d.values) ? d.values : []).filter((v) => v && (typeof v.value === "string" || typeof v.value === "number") && !seen.has(String(v.value)) && seen.add(String(v.value))).map((v) => ({ value: v.value, label: String(v.label ?? v.value).slice(0, 80) }));
  if (!values.length) problems.push("The drill-down needs at least one value to open.");
  if (values.length > MAX_DRILL_VALUES) problems.push(`A drill-down opens at most ${MAX_DRILL_VALUES} values; ${values.length} were given.`);
  return problems.length ? { plan: null, problems } : { plan: { variable: d.variable, label: d.label?.slice(0, 80), values }, problems };
}

/** the condition a drill value filters by (the analytics condition grammar) */
export const drillCondition = (variable: string, value: string | number) => ({ type: "rule" as const, source: { kind: "variable" as const, ref: variable }, operator: "eq" as const, value });

const note = (n: number, min: number) => `Not shown: fewer than ${min} respondents (n = ${n}).`;
const emptyChart = (c: ChartData): ChartData => ({ ...(c.valueFormat ? { valueFormat: c.valueFormat } : {}) } as ChartData);

/** one result with every number under `minBase` withheld; `withheld` says what was taken out */
export function protectResult(r: AnalysisResult, minBase: number): { result: AnalysisResult; withheld: string[] } {
  if (!(minBase > 1) || r.error) return { result: r, withheld: [] };
  const n = r.base?.n ?? 0;
  if (n < minBase) {
    const msg = note(n, minBase);
    if (r.warnings?.includes(msg) && !r.tables.length) return { result: r, withheld: [] };
    return {
      result: { ...r, tables: [], chart: emptyChart(r.chart), tests: [], insights: [], segments: undefined, warnings: [msg], base: { ...r.base, n, weightedN: n } },
      withheld: [`${r.name}: whole result (n = ${n})`],
    };
  }
  const withheld: string[] = [];
  const tables = r.tables.map((t) => protectTable(t, minBase, (w) => withheld.push(`${r.name}: ${w}`)));
  /* a chart series is a table column by name ("North" is the column "North (a)": the significance letter is dropped) */
  const hiddenLabels = new Set(tables.flatMap((t) => t.columns.filter((c) => c.suppressed).flatMap((c) => [c.label, c.label.replace(/\s*\([a-z]{1,2}\)$/, "")])));
  let chart = r.chart;
  if (hiddenLabels.size && chart.series?.length) chart = { ...chart, series: chart.series.map((s) => (hiddenLabels.has(s.name) ? { ...s, values: s.values.map(() => null), ci: undefined, errors: undefined, sig: undefined } : s)) };
  let segments = r.segments;
  if (segments?.some((s) => s.n < minBase)) {
    for (const s of segments.filter((x) => x.n < minBase)) withheld.push(`${r.name}: segment ${s.name} (n = ${s.n})`);
    segments = segments.filter((s) => s.n >= minBase);
  }
  if (!withheld.length) return { result: r, withheld };
  const warn = `Some figures are not shown because they rest on fewer than ${minBase} respondents.`;
  return { result: { ...r, tables, chart, segments, warnings: r.warnings.includes(warn) ? r.warnings : [...r.warnings, warn] }, withheld };
}

function protectTable(t: ResultTable, min: number, said: (w: string) => void): ResultTable {
  const small = new Set(Object.entries(t.columnBases ?? {}).filter(([, n]) => n < min).map(([k]) => k));
  let changed = false;
  const columns = t.columns.map((c) => {
    if (!small.has(c.key) || c.suppressed) return c;
    changed = true; said(`column ${c.label} (n = ${t.columnBases![c.key]})`);
    return { ...c, suppressed: true };
  });
  /* a cell's own `__n` is its COUNT, not a base — a 10% from 144 people is fine — so only whole columns are blanked */
  const rows = !small.size ? t.rows : t.rows.map((row) => {
    let out: Record<string, unknown> | null = null;
    for (const k of small) if (typeof row[k] === "number") { out ??= { ...row }; out[k] = null; delete out[`${k}__sig`]; }
    return out ?? row;
  });
  if (!changed) return t;
  const msg = `Columns resting on fewer than ${min} respondents are blank.`;
  return { ...t, columns, rows, notes: (t.notes ?? []).includes(msg) ? t.notes : [...(t.notes ?? []), msg] };
}

/** a whole result set protected; `withheld` lists everything taken out, for the publisher */
export function protectSnapshot(results: Record<string, AnalysisResult>, minBase: number): { results: Record<string, AnalysisResult>; withheld: string[] } {
  const out: Record<string, AnalysisResult> = {};
  const withheld: string[] = [];
  for (const [id, r] of Object.entries(results ?? {})) { const p = protectResult(r, minBase); out[id] = p.result; withheld.push(...p.withheld); }
  return { results: out, withheld };
}

/** the minimum bases a report is published with: the main results only when the report sets one, variants always */
export function minBasesFor(report: Pick<ReportDefinition, "minBase">): { main: number; variants: number } {
  const set = typeof report.minBase === "number" && Number.isFinite(report.minBase) ? Math.max(0, Math.min(1000, Math.round(report.minBase))) : null;
  return { main: set ?? 0, variants: set ?? DEFAULT_VARIANT_MIN_BASE };
}

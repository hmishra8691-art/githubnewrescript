import type { Condition } from "@rescript/schema";
import type { AnalysisResult, DatasetSpec, ResultTable, WeightingSpec } from "./types.js";
import type { Dataset } from "./dataset.js";
import { runAnalysis } from "./analyses/index.js";

/**
 * TAB PLAN ENGINE (Level 5 roadmap M2 — 2026-11-29).
 *
 * A tab plan is the spec a data-processing team writes once and runs on every wave: one banner (the columns every
 * table shares), a list of stubs (the tables), and run-wide settings (filter, weighting, significance level,
 * decimals, minimum base). Each stub is a full crosstab — nets, top/bottom boxes, means, NPS, sorting — computed by
 * the same crosstab engine the rest of the product uses, so a figure in the tab book is the figure on screen.
 * Summary stubs put one statistic of many questions side by side (top-2 box of every attribute, the mean of every
 * rating, awareness of one brand across measures), optionally ranked. `autoTabPlan` drafts a plan from the
 * dataset; `runTabPlan` runs it and reports every stub it could not run instead of dropping it silently.
 */
export interface TabNet { variable: string; label: string; codes: (string | number)[] }
export interface TabBanner { columns: string[]; nets?: TabNet[] }
export type SummaryStat = "top1" | "top2" | "bottom1" | "bottom2" | "net" | "mean" | "nps" | { code: string };
export interface TableStub {
  kind?: "table"; id?: string; variable: string; title?: string;
  nets?: TabNet[]; summaryRows?: Exclude<SummaryStat, { code: string }>[];
  sortRows?: "none" | "desc" | "asc"; base?: "answered" | "all"; hideEmptyRows?: boolean; filter?: Condition | null;
}
export interface SummaryStub { kind: "summary"; id?: string; title: string; variables: string[]; statistic: SummaryStat; rank?: boolean; filter?: Condition | null }
export type TabStub = TableStub | SummaryStub;
export interface TabPlan {
  name: string; dataset: DatasetSpec; banner: TabBanner; stubs: TabStub[];
  filter?: Condition | null; weighting?: WeightingSpec | null;
  /** significance letters at this level (0.05 = 95%); false for none */
  alpha?: number | false; sigVsTotal?: boolean; decimals?: number; minBase?: number;
}
export interface TabTable { id: string; number: number; title: string; kind: "table" | "summary"; table: ResultTable; warnings: string[]; base: AnalysisResult["base"]; results: AnalysisResult[] }
export interface TabRun { plan: TabPlan; tables: TabTable[]; problems: string[]; computedAt: string }

const and = (a?: Condition | null, b?: Condition | null): Condition | null => (a && b ? ({ type: "group", op: "and", children: [a, b] } as unknown as Condition) : a ?? b ?? null);
const statName = (s: SummaryStat) => (typeof s === "object" ? `code ${s.code}` : s);
/** the summary row a statistic produces in a crosstab — matched by the row label the crosstab engine writes */
const rowMatches: Record<string, RegExp> = { top1: /^Top box/, top2: /^Top 2 box/, bottom1: /^Bottom box/, bottom2: /^Bottom 2 box/, net: /^Net \(top 2/, mean: /^Mean\b/, nps: /^NPS \(/ };

function crosstab(plan: TabPlan, ds: Dataset, variable: string, extra: Record<string, unknown>, filter?: Condition | null): AnalysisResult {
  const nets = [...(plan.banner.nets ?? []), ...((extra.nets as TabNet[] | undefined) ?? [])];
  const options: Record<string, unknown> = {
    ...extra, nets, layout: "banner", significance: plan.alpha !== false, ...(plan.alpha ? { alpha: plan.alpha } : {}),
    ...(plan.sigVsTotal ? { sigVsTotal: true } : {}), ...(plan.decimals != null ? { decimals: plan.decimals } : {}), ...(plan.minBase ? { minBase: plan.minBase } : {}),
  };
  return runAnalysis({ name: variable, kind: "crosstab", dataset: plan.dataset, variables: [], rows: [variable], columns: plan.banner.columns, filter: and(plan.filter, filter), weighting: plan.weighting ?? null, options }, ds);
}

export function checkTabPlan(plan: TabPlan, ds: Dataset): string[] {
  const p: string[] = [];
  if (!plan.banner.columns.length) p.push("The banner has no columns.");
  for (const c of plan.banner.columns) {
    const v = ds.byName.get(c);
    if (!v) p.push(`Banner variable ${c} is not in the data.`);
    else if (!["categorical", "multi", "scale"].includes(v.role)) p.push(`Banner variable ${c} is ${v.role}; a banner needs categories.`);
  }
  plan.stubs.forEach((s, i) => {
    const names = s.kind === "summary" ? s.variables : [s.variable];
    for (const n of names) if (!ds.byName.has(n)) p.push(`Table ${i + 1}: ${n} is not in the data.`);
    if (s.kind === "summary" && !s.variables.length) p.push(`Table ${i + 1} (${s.title}) lists no questions.`);
  });
  return p;
}

export function runTabPlan(plan: TabPlan, ds: Dataset): TabRun {
  const problems = checkTabPlan(plan, ds);
  const tables: TabTable[] = [];
  if (problems.some((x) => /^Banner|^The banner/.test(x))) return { plan, tables, problems, computedAt: new Date().toISOString() };
  plan.stubs.forEach((s, i) => {
    const id = s.id ?? `T${i + 1}`;
    if (s.kind === "summary") {
      const vars = s.variables.filter((v) => ds.byName.has(v));
      if (!vars.length) return;
      const results: AnalysisResult[] = [];
      let columns: ResultTable["columns"] | null = null;
      let columnBases: Record<string, number> | undefined;
      const rows: Record<string, unknown>[] = [];
      const warnings: string[] = [];
      for (const v of vars) {
        const stat = s.statistic;
        const r = crosstab(plan, ds, v, typeof stat === "object" ? {} : { summaryRows: [stat], autoNps: false }, s.filter);
        results.push(r);
        const t = r.tables[0];
        if (!t) { warnings.push(`${v}: no table.`); continue; }
        columns ??= t.columns; columnBases ??= t.columnBases;
        const label = ds.byName.get(v)!.itemLabel ?? ds.byName.get(v)!.label;
        const src = (t.rows as Record<string, unknown>[]).find((x) => typeof stat === "object" ? x.__kind === "category" && String(x.__code) === stat.code : rowMatches[stat]!.test(String(x.row ?? "")));
        if (!src) { warnings.push(`“${label}” has no ${statName(stat)} — ${r.warnings.find((w) => w.includes("not shown")) ?? "the statistic does not apply to it"}`); continue; }
        rows.push({ ...src, row: label, __kind: "category", __variable: v, ...(src.__format ? {} : {}) });
      }
      if (!columns) { problems.push(`${id} (${s.title}): nothing to show.`); return; }
      if (s.rank) {
        rows.sort((a, b) => ((b.__total as number) ?? -Infinity) - ((a.__total as number) ?? -Infinity));
        rows.forEach((r, k) => { r.__rank = k + 1; r.row = `${k + 1}. ${r.row}`; });
      }
      const isPct = !rows.some((r) => r.__format === "number");
      const table: ResultTable = {
        id, title: s.title, columns: columns.map((c, k) => (k === 0 ? { ...c, label: "" } : { ...c, type: isPct ? c.type : "number" })), rows, ...(columnBases ? { columnBases } : {}),
        notes: [`${statName(s.statistic) === "mean" ? "Means" : `${statName(s.statistic)}`} of ${rows.length} question${rows.length === 1 ? "" : "s"} side by side${s.rank ? ", ranked by the Total" : ""}. Each row is that question's own ${statName(s.statistic)} row, with its own base and significance letters.`, ...(results[0]?.tables[0]?.notes?.filter((n) => /Letters/.test(n)) ?? [])],
      };
      tables.push({ id, number: tables.length + 1, title: s.title, kind: "summary", table, warnings: [...warnings, ...new Set(results.flatMap((r) => r.warnings.filter((w) => !/Summary rows/.test(w))))], base: results[0]!.base, results });
      if (warnings.length) problems.push(...warnings.map((w) => `${id}: ${w}`));
    } else {
      if (!ds.byName.has(s.variable)) return;
      const r = crosstab(plan, ds, s.variable, { ...(s.nets ? { nets: s.nets } : {}), ...(s.summaryRows ? { summaryRows: s.summaryRows } : {}), ...(s.sortRows ? { sortRows: s.sortRows } : {}), ...(s.base ? { base: s.base } : {}), hideEmptyRows: s.hideEmptyRows ?? false }, s.filter);
      const t = r.tables[0];
      if (!t) { problems.push(`${id}: the crosstab returned no table${r.warnings[0] ? ` — ${r.warnings[0]}` : ""}.`); return; }
      const v = ds.byName.get(s.variable)!;
      const title = s.title ?? `${v.questionCode && !v.label.startsWith(v.questionCode) ? `${v.questionCode}. ` : ""}${v.label}`;
      tables.push({ id, number: tables.length + 1, title, kind: "table", table: { ...t, id, title }, warnings: r.warnings, base: r.base, results: [r] });
    }
  });
  return { plan, tables, problems, computedAt: new Date().toISOString() };
}

/** the system columns (status, environment, dates, quality) are not survey questions */
const isSystem = (name: string) => name.startsWith("_");
const orderedNumeric = (cats?: { code: string }[]) => !!cats && cats.length >= 3 && cats.every((c) => /^-?\d+$/.test(c.code));

/**
 * A first draft of a plan: one table per question that has categories (banner variables excepted), NPS rows on NPS
 * questions, top/bottom-2 boxes and a mean on numeric scales, and for each grid of scale items a top-2-box summary
 * and a ranked mean summary. A draft to edit, not a finished spec.
 */
export function autoTabPlan(ds: Dataset, banner: TabBanner, opts: { name?: string; dataset?: DatasetSpec } = {}): TabPlan {
  const stubs: TabStub[] = [];
  const inBanner = new Set(banner.columns);
  const grids = new Map<string, string[]>();
  for (const v of ds.variables) {
    if (isSystem(v.name) || v.hidden || inBanner.has(v.name)) continue;
    /* a multi-select's option flags (Q6 — Alpha, Q6 — Beta…) are already the rows of the question's own table */
    if (v.optionCode && ds.byName.get(v.name.replace(/_[^_]+$/, ""))?.role === "multi") continue;
    if (v.role !== "categorical" && v.role !== "multi" && v.role !== "scale") continue;
    const scale = (v.role === "scale" || v.role === "categorical") && orderedNumeric(v.categories);
    const stub: TableStub = { variable: v.name };
    if (v.nps) stub.summaryRows = ["nps"];
    else if (scale) stub.summaryRows = ["top2", "bottom2", "mean"];
    stubs.push(stub);
    if (scale && v.rowCode && v.questionId) grids.set(v.questionId, [...(grids.get(v.questionId) ?? []), v.name]);
  }
  for (const [qid, vars] of grids) {
    if (vars.length < 2) continue;
    const q = ds.variables.find((x) => x.questionId === qid)!;
    const label = (q.questionCode ? `${q.questionCode} ` : "") + "summary";
    stubs.push({ kind: "summary", title: `${label}: top 2 box`, variables: vars, statistic: "top2" });
    stubs.push({ kind: "summary", title: `${label}: mean, ranked`, variables: vars, statistic: "mean", rank: true });
  }
  return { name: opts.name ?? "Tab plan", dataset: opts.dataset ?? (ds.spec as DatasetSpec) ?? { environment: "LIVE", dataset: "all" }, banner, stubs, alpha: 0.05 };
}

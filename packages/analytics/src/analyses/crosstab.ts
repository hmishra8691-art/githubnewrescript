import type { AnalysisDefinition, AnalysisResult, ChartData, ResultColumn, ResultTable, CrosstabRowKind } from "../types.js";
import { categoricalColumn, categoriesOf, labelOf, numericColumn, weights, type Dataset } from "../dataset.js";
import { chiSquare, oneWayAnova, type TestResult } from "../stats/tests.js";
import { normalCdf } from "../stats/distributions.js";
import { fmtNum, fmtPct, makeResult, opt, pct, round } from "./common.js";

/**
 * THE CROSSTAB — the table a research studio lives in.
 *
 * One pass over the cases accumulates, per column, the weighted and
 * unweighted cell counts, the column base and Σw² (for the effective base
 * that weighted significance needs), and — for scale and numeric rows — the
 * moments a mean and its test need. Everything the table shows is derived
 * from that accumulator, so a percentage, its letter, its count and its mean
 * are always about the same respondents.
 *
 * Every option defaults to the behaviour a saved analysis had before this
 * module existed: one table per row × column variable, column percentages,
 * a Base (n) row, letters marking significantly higher columns, a chi-square.
 * The options a professional table needs sit on `def.options`:
 *
 *   layout        "separate" | "banner"   — banner puts every column variable side by side in one table
 *   stackRows     boolean                 — banner tables stack every row variable in one table (section rows)
 *   nestRows      boolean                 — rows[1] nested inside rows[0] (group rows, expandable in the UI)
 *   base          "answered" | "all"      — "all" bases on everyone in the column and adds a "No answer" row
 *   minBase       number                  — suppress cells of columns with fewer respondents than this
 *   sortRows      "none" | "desc" | "asc" — order category rows by their Total
 *   hideEmptyRows boolean                 — drop category rows that are 0 in every column
 *   summaryRows   ("mean"|"top1"|"top2"|"bottom1"|"bottom2"|"net")[] — for scale rows
 *   totalRow      boolean                 — a row summing column percentages (single-response rows)
 *   decimals      number                  — decimals for the % / mean cells
 *   significance  boolean, alpha number   — letters, and their level
 *   sigVsTotal    boolean                 — "+" / "−" on cells that differ from the Total
 *   showCounts    boolean                 — a UI hint; `<key>__n` is always written
 */

interface Acc { count: number; w: number; w2: number; sum: number; sumSq: number; vals: number[]; ws: number[] }
const acc = (): Acc => ({ count: 0, w: 0, w2: 0, sum: 0, sumSq: 0, vals: [], ws: [] });
const inc = (m: Map<string, Acc>, k: string, wt: number, v?: number | null) => {
  const c = m.get(k) ?? acc();
  c.count++; c.w += wt; c.w2 += wt * wt;
  if (v != null) { c.sum += v * wt; c.sumSq += v * v * wt; c.vals.push(v); c.ws.push(wt); }
  m.set(k, c);
};
/** effective base of a weighted column: (Σw)² / Σw² — equals the count when every weight is 1 */
const effN = (a: Acc | undefined) => (!a || !a.w2 ? 0 : (a.w * a.w) / a.w2);

/** a, b … z, aa, ab … — letters for as many columns as a banner carries */
export function columnLetter(j: number): string {
  const s = String.fromCharCode(97 + (j % 26));
  return j < 26 ? s : String.fromCharCode(97 + Math.floor(j / 26) - 1) + s;
}

/** two-sample z on weighted proportions with effective bases; null when either base is empty */
function zProportions(p1: number, n1: number, p2: number, n2: number): number | null {
  if (!n1 || !n2) return null;
  const pool = (p1 * n1 + p2 * n2) / (n1 + n2);
  const se = Math.sqrt(pool * (1 - pool) * (1 / n1 + 1 / n2));
  if (!se) return null;
  const z = (p1 - p2) / se;
  return 2 * (1 - normalCdf(Math.abs(z)));
}
/** Welch z on weighted means with effective bases */
function zMeans(a: Acc, b: Acc): number | null {
  const na = effN(a), nb = effN(b);
  if (na < 2 || nb < 2 || !a.w || !b.w) return null;
  const ma = a.sum / a.w, mb = b.sum / b.w;
  const va = Math.max(0, a.sumSq / a.w - ma * ma) * (na / (na - 1)), vb = Math.max(0, b.sumSq / b.w - mb * mb) * (nb / (nb - 1));
  const se = Math.sqrt(va / na + vb / nb);
  if (!se) return null;
  return 2 * (1 - normalCdf(Math.abs((ma - mb) / se)));
}

interface ColumnDef { key: string; label: string; code: string; variable: string; group: string; letter: string }

export function crosstab(def: AnalysisDefinition, ds: Dataset, totalCases: number): AnalysisResult {
  const rowVars = def.rows?.length ? def.rows : def.variables.slice(0, 1);
  const colVars = def.columns?.length ? def.columns : def.variables.slice(1, 2);
  const layerVar = def.layers?.[0];
  const measure = def.measure ?? "pct_col";
  const alpha = opt(def, "alpha", 0.05) as number;
  const showSig = opt(def, "significance", true) as boolean;
  const sigVsTotal = opt(def, "sigVsTotal", false) as boolean;
  const layout = opt(def, "layout", "separate") as "separate" | "banner";
  const stackRows = layout === "banner" && (opt(def, "stackRows", false) as boolean);
  const nestRows = (opt(def, "nestRows", false) as boolean) && rowVars.length >= 2;
  const baseMode = opt(def, "base", "answered") as "answered" | "all";
  const minBase = Math.max(0, Number(opt(def, "minBase", 0)) || 0);
  const sortRows = opt(def, "sortRows", "none") as "none" | "desc" | "asc";
  const hideEmpty = opt(def, "hideEmptyRows", false) as boolean;
  const summaryRows = (opt(def, "summaryRows", []) as string[]).filter(Boolean);
  const totalRow = opt(def, "totalRow", false) as boolean;
  const decimals = Math.min(4, Math.max(0, Number(opt(def, "decimals", 1)) || 0));
  const warnings: string[] = [];
  const tables: ResultTable[] = [];
  const tests: TestResult[] = [];
  const insights: string[] = [];
  let chart: ChartData = {};

  if (!rowVars.length || !colVars.length) {
    return makeResult(def, ds, { tables, chart, warnings: ["A crosstab needs at least one row variable and one column variable."], recommendedCharts: ["table"], totalCases });
  }
  for (const v of [...rowVars, ...colVars, ...(layerVar ? [layerVar] : [])]) if (!ds.byName.get(v)) warnings.push(`Variable ${v} is not in this survey's dictionary.`);

  const layers: { label: string; ds: Dataset }[] = layerVar
    ? categoriesOf(ds, layerVar).map((c) => ({ label: `${labelOf(ds, layerVar)}: ${c.label}`, ds: { ...ds, cases: ds.cases.filter((x) => String(x.vars[layerVar]) === c.code || (Array.isArray(x.vars[layerVar]) && (x.vars[layerVar] as unknown[]).map(String).includes(c.code))) } }))
    : [{ label: "", ds }];

  /** the column definitions of one table: Total, then each column variable's categories */
  const columnsFor = (cvs: string[]): ColumnDef[] => {
    const out: ColumnDef[] = [{ key: "__total", label: "Total", code: "__total", variable: "", group: "", letter: "" }];
    let j = 0;
    for (const cv of cvs) for (const c of categoriesOf(ds, cv)) {
      // separate tables keep the bare code as the key (what saved charts and exports read); a banner qualifies it
      out.push({ key: cvs.length > 1 ? `${cv}::${c.code}` : c.code, label: c.label, code: c.code, variable: cv, group: labelOf(ds, cv), letter: columnLetter(j++) });
    }
    return out;
  };

  /** one accumulation of (row variable, row filter) against a set of columns */
  interface Block {
    rv: string; label: string; level: number; groupKey?: string;
    rowsIsNumeric: boolean; meanMode: boolean;
    grid: Map<string, Map<string, Acc>>; colBase: Map<string, Acc>; rowBase: Map<string, Acc>; nums: Map<string, Acc>;
    noAnswer: Map<string, Acc>;
  }
  const accumulate = (layer: Dataset, rv: string, cols: ColumnDef[], cvs: string[], keep: (i: number) => boolean, level: number, label: string, groupKey?: string): Block => {
    const lw = weights(layer);
    const rMeta = ds.byName.get(rv);
    const rowsIsNumeric = rMeta?.role === "numeric" && !rMeta.categories;
    const meanMode = rowsIsNumeric || measure === "mean";
    const rVals = categoricalColumn(layer, rv);
    const rNum = meanMode ? numericColumn(layer, rv) : null;
    const colVals = cvs.map((cv) => categoricalColumn(layer, cv));
    const grid = new Map<string, Map<string, Acc>>(), colBase = new Map<string, Acc>(), rowBase = new Map<string, Acc>(), nums = new Map<string, Acc>(), noAnswer = new Map<string, Acc>();
    const keyOf = (cv: string, code: string) => (cvs.length > 1 ? `${cv}::${code}` : code);
    const known = new Set(cols.map((c) => c.key));
    layer.cases.forEach((_, i) => {
      if (!keep(i)) return;
      const wt = lw?.[i] ?? 1;
      // the columns this respondent falls in: Total when any column variable was answered
      const cks: string[] = [];
      cvs.forEach((cv, k) => { const cc = colVals[k][i]; if (cc == null) return; for (const code of Array.isArray(cc) ? cc : [cc]) { const key = keyOf(cv, code); if (known.has(key)) cks.push(key); } });
      if (!cks.length) return;
      cks.unshift("__total");
      if (meanMode) {
        const v = rNum![i];
        if (v == null) { if (baseMode === "all") for (const ck of cks) { inc(colBase, ck, wt); inc(noAnswer, ck, wt); } return; }
        for (const ck of cks) { inc(nums, ck, wt, v); inc(colBase, ck, wt); }
        return;
      }
      const rc = rVals[i];
      if (rc == null) { if (baseMode === "all") for (const ck of cks) { inc(colBase, ck, wt); inc(noAnswer, ck, wt); } return; }
      const rcs = Array.isArray(rc) ? rc : [rc];
      for (const ck of cks) inc(colBase, ck, wt);
      for (const r of rcs) {
        inc(rowBase, r, wt);
        const rowMap = grid.get(r) ?? new Map<string, Acc>();
        for (const ck of cks) inc(rowMap, ck, wt);
        grid.set(r, rowMap);
      }
    });
    return { rv, label, level, groupKey, rowsIsNumeric, meanMode, grid, colBase, rowBase, nums, noAnswer };
  };

  const cellType = measure === "mean" ? "number" as const : measure === "count" ? "count" as const : "pct" as const;
  const sigNote = `Letters mark columns significantly lower at the ${Math.round((1 - alpha) * 100)}% level (column proportion z-test${ds.weighted ? ", weighted, effective bases" : ""}).`;

  /** turn one block into table rows */
  const emitRows = (b: Block, cols: ColumnDef[], out: Record<string, unknown>[], suppressed: Set<string>) => {
    const rCats = categoriesOf(ds, b.rv);
    const tot = b.colBase.get("__total")?.w ?? 0;
    const val = (v: number | null) => (v == null ? null : cellType === "pct" ? pct(v, decimals) : round(v, decimals));
    const letters = (prop: (ck: string) => { p: number; n: number } | null) => {
      // within each column variable's group, the columns whose proportion is significantly LOWER than this one
      const out: Record<string, string> = {};
      for (const c of cols) {
        if (!c.variable || suppressed.has(c.key)) continue;
        const me = prop(c.key); if (!me) continue;
        const marks: string[] = [];
        for (const o of cols) {
          if (o.key === c.key || o.variable !== c.variable || suppressed.has(o.key)) continue;
          const them = prop(o.key); if (!them) continue;
          const p = zProportions(me.p, me.n, them.p, them.n);
          if (p != null && p < alpha && me.p > them.p) marks.push(o.letter);
        }
        out[c.key] = marks.join("");
      }
      return out;
    };
    const vsTotal = (prop: (ck: string) => { p: number; n: number } | null) => {
      const out: Record<string, string> = {};
      const t = prop("__total"); if (!t) return out;
      for (const c of cols) {
        if (!c.variable || suppressed.has(c.key)) continue;
        const me = prop(c.key); if (!me || t.n <= me.n) continue;
        // the column against its complement, so a large column is not tested against itself
        const rest = { p: (t.p * t.n - me.p * me.n) / (t.n - me.n), n: t.n - me.n };
        const p = zProportions(me.p, me.n, rest.p, rest.n);
        if (p != null && p < alpha) out[c.key] = me.p > rest.p ? "+" : "−";
      }
      return out;
    };
    const mark = (row: Record<string, unknown>, kind: CrosstabRowKind) => { row.__kind = kind; row.__level = b.level; if (b.groupKey) row.__group = b.groupKey; return row; };

    if (b.meanMode) {
      const meanRow = mark({ row: b.rowsIsNumeric ? "Mean" : `Mean (${b.label})`, __format: "number" }, "summary");
      const sdRow = mark({ row: "Std. deviation", __format: "number" }, "summary");
      const nRow = mark({ row: "n", __format: "count" }, "summary");
      const sig = showSig ? (() => { const out: Record<string, string> = {}; for (const c of cols) { if (!c.variable || suppressed.has(c.key)) continue; const a = b.nums.get(c.key); if (!a) continue; const marks: string[] = []; for (const o of cols) { if (o.key === c.key || o.variable !== c.variable || suppressed.has(o.key)) continue; const bb = b.nums.get(o.key); if (!bb) continue; const p = zMeans(a, bb); if (p != null && p < alpha && a.sum / a.w > bb.sum / bb.w) marks.push(o.letter); } out[c.key] = marks.join(""); } return out; })() : {};
      for (const c of cols) {
        const s = b.nums.get(c.key);
        if (suppressed.has(c.key)) { meanRow[c.key] = null; sdRow[c.key] = null; nRow[c.key] = s?.count ?? 0; continue; }
        const m = s && s.w ? s.sum / s.w : null;
        const variance = s && s.w && s.count > 1 ? Math.max(0, s.sumSq / s.w - (m ?? 0) ** 2) * (s.count / (s.count - 1)) : null;
        meanRow[c.key] = round(m, Math.max(decimals, 2)); sdRow[c.key] = round(variance == null ? null : Math.sqrt(variance), Math.max(decimals, 2)); nRow[c.key] = s?.count ?? 0;
        meanRow[`${c.key}__n`] = s?.count ?? 0;
        if (sig[c.key]) meanRow[`${c.key}__sig`] = sig[c.key];
      }
      out.push(meanRow, sdRow, nRow);
      if (baseMode === "all" && b.noAnswer.size) { const na = mark({ row: "No answer", __format: "count" }, "noanswer"); for (const c of cols) na[c.key] = b.noAnswer.get(c.key)?.count ?? 0; out.push(na); }
      return;
    }

    const prop = (rk: string) => (ck: string) => { const base = b.colBase.get(ck); if (!base || !base.w) return null; return { p: (b.grid.get(rk)?.get(ck)?.w ?? 0) / base.w, n: effN(base) }; };
    let keys = rCats.map((c) => c.code);
    if (hideEmpty) keys = keys.filter((rk) => (b.grid.get(rk)?.get("__total")?.count ?? 0) > 0);
    if (sortRows !== "none") keys = [...keys].sort((x, y) => { const a = b.grid.get(x)?.get("__total")?.w ?? 0, c = b.grid.get(y)?.get("__total")?.w ?? 0; return sortRows === "desc" ? c - a : a - c; });
    for (const rk of keys) {
      const label = rCats.find((c) => c.code === rk)?.label ?? rk;
      const row = mark({ row: label, __code: rk }, "category");
      const rowMap = b.grid.get(rk) ?? new Map<string, Acc>();
      const sig = showSig ? letters(prop(rk)) : {};
      const vs = sigVsTotal ? vsTotal(prop(rk)) : {};
      for (const c of cols) {
        const cell = rowMap.get(c.key) ?? acc();
        const base = b.colBase.get(c.key) ?? acc();
        let v: number | null;
        if (suppressed.has(c.key)) v = null;
        else if (measure === "count") v = round(cell.w, ds.weighted ? 1 : 0);
        else if (measure === "pct_row") v = b.rowBase.get(rk)?.w ? (cell.w / b.rowBase.get(rk)!.w) * 100 : 0;
        else if (measure === "pct_total") v = tot ? (cell.w / tot) * 100 : 0;
        else v = base.w ? (cell.w / base.w) * 100 : 0;
        row[c.key] = measure === "count" ? v : val(v);
        row[`${c.key}__n`] = cell.count;
        if (sig[c.key]) row[`${c.key}__sig`] = sig[c.key];
        if (vs[c.key]) row[`${c.key}__vs`] = vs[c.key];
      }
      out.push(row);
    }
    if (baseMode === "all" && b.noAnswer.size) {
      const na = mark({ row: "No answer" }, "noanswer");
      for (const c of cols) { const cell = b.noAnswer.get(c.key) ?? acc(); const base = b.colBase.get(c.key) ?? acc(); na[c.key] = suppressed.has(c.key) ? null : measure === "count" ? round(cell.w, ds.weighted ? 1 : 0) : measure === "pct_row" ? (cell.w ? 100 : 0) : measure === "pct_total" ? val(tot ? (cell.w / tot) * 100 : 0) : val(base.w ? (cell.w / base.w) * 100 : 0); na[`${c.key}__n`] = cell.count; }
      out.push(na);
    }
    const isMulti = ds.byName.get(b.rv)?.role === "multi";
    if (totalRow && !isMulti && measure !== "pct_row") {
      const t = mark({ row: "Total" }, "total");
      for (const c of cols) { if (suppressed.has(c.key)) { t[c.key] = null; continue; } let s = 0; for (const r of out) if (r.__kind === "category" || r.__kind === "noanswer") if (r.__level === b.level && (r.__group ?? "") === (b.groupKey ?? "") && typeof r[c.key] === "number") s += r[c.key] as number; t[c.key] = measure === "count" ? round(s, ds.weighted ? 1 : 0) : val(s); }
      out.push(t);
    }
    // summary rows for a numerically coded frame — mean, boxes, net
    const numericCodes = rCats.map((c) => Number(c.code));
    if (summaryRows.length && rCats.length >= 2 && numericCodes.every((n) => Number.isFinite(n))) {
      const ordered = [...rCats].map((c) => Number(c.code)).sort((a, b2) => a - b2);
      const topK = (k: number) => new Set(ordered.slice(-k).map(String)), botK = (k: number) => new Set(ordered.slice(0, k).map(String));
      const boxProp = (codes: Set<string>) => (ck: string) => { const base = b.colBase.get(ck); if (!base || !base.w) return null; let w = 0; for (const code of codes) w += b.grid.get(code)?.get(ck)?.w ?? 0; return { p: w / base.w, n: effN(base) }; };
      const boxRow = (name: string, codes: Set<string>, kind: CrosstabRowKind = "summary") => {
        const row = mark({ row: name, __format: "pct" }, kind);
        const pf = boxProp(codes);
        const sig = showSig ? letters(pf) : {};
        const vs = sigVsTotal ? vsTotal(pf) : {};
        for (const c of cols) { const p = pf(c.key); row[c.key] = suppressed.has(c.key) || !p ? null : pct(p.p * 100, decimals); let n = 0; for (const code of codes) n += b.grid.get(code)?.get(c.key)?.count ?? 0; row[`${c.key}__n`] = n; if (sig[c.key]) row[`${c.key}__sig`] = sig[c.key]; if (vs[c.key]) row[`${c.key}__vs`] = vs[c.key]; }
        return row;
      };
      const labelFor = (codes: Set<string>) => rCats.filter((c) => codes.has(c.code)).map((c) => c.label).join(" + ");
      const boxes: Record<string, Record<string, unknown>> = {};
      for (const s of summaryRows) {
        if (s === "top1") out.push(boxes.top1 = boxRow(`Top box (${labelFor(topK(1))})`, topK(1)));
        else if (s === "top2") out.push(boxes.top2 = boxRow(`Top 2 box (${labelFor(topK(2))})`, topK(2)));
        else if (s === "bottom1") out.push(boxes.bottom1 = boxRow(`Bottom box (${labelFor(botK(1))})`, botK(1)));
        else if (s === "bottom2") out.push(boxes.bottom2 = boxRow(`Bottom 2 box (${labelFor(botK(2))})`, botK(2)));
        else if (s === "net") {
          const t2 = boxes.top2 ?? boxRow("", topK(2)), b2 = boxes.bottom2 ?? boxRow("", botK(2));
          const row = mark({ row: "Net (top 2 − bottom 2)", __format: "number" }, "summary");
          for (const c of cols) row[c.key] = t2[c.key] == null || b2[c.key] == null ? null : round((t2[c.key] as number) - (b2[c.key] as number), decimals);
          out.push(row);
        } else if (s === "mean") {
          const row = mark({ row: "Mean", __format: "number" }, "summary");
          const moments = new Map<string, Acc>();
          for (const c of cols) { const a = acc(); for (const rc of rCats) { const cell = b.grid.get(rc.code)?.get(c.key); if (!cell) continue; const v = Number(rc.code); a.count += cell.count; a.w += cell.w; a.w2 += cell.w2; a.sum += v * cell.w; a.sumSq += v * v * cell.w; } moments.set(c.key, a); }
          for (const c of cols) {
            const a = moments.get(c.key)!;
            row[c.key] = suppressed.has(c.key) || !a.w ? null : round(a.sum / a.w, Math.max(decimals, 2));
            row[`${c.key}__n`] = a.count;
            if (showSig && c.variable && !suppressed.has(c.key)) { const marks: string[] = []; for (const o of cols) { if (o.key === c.key || o.variable !== c.variable || suppressed.has(o.key)) continue; const bb = moments.get(o.key)!; const p = zMeans(a, bb); if (p != null && p < alpha && a.w && bb.w && a.sum / a.w > bb.sum / bb.w) marks.push(o.letter); } if (marks.length) row[`${c.key}__sig`] = marks.join(""); }
          }
          out.push(row);
        }
      }
    }
  };

  /** the chart follows the first row × first column pair of the first layer */
  const chartFrom = (b: Block, cols: ColumnDef[], cv: string) => {
    if (chart.categories) return;
    const cc = cols.filter((c) => c.variable === cv);
    if (b.meanMode) { chart = { categories: cc.map((c) => c.label), series: [{ name: `Mean ${labelOf(ds, b.rv)}`, values: cc.map((c) => { const s = b.nums.get(c.key); return s && s.w ? round(s.sum / s.w) : null; }) }] }; return; }
    const rCats = categoriesOf(ds, b.rv);
    const p = (rk: string, ck: string) => { const base = b.colBase.get(ck)?.w ?? 0; return pct(base ? ((b.grid.get(rk)?.get(ck)?.w ?? 0) / base) * 100 : 0); };
    chart = {
      categories: rCats.map((c) => c.label),
      series: cc.map((c) => ({ name: c.label, values: rCats.map((r) => p(r.code, c.key)) })),
      matrix: { rows: rCats.map((c) => c.label), columns: cc.map((c) => c.label), values: rCats.map((r) => cc.map((c) => p(r.code, c.key))) },
      valueFormat: "pct",
    };
  };

  /** tests and insights for one row variable against one column variable */
  const testsFor = (b: Block, cols: ColumnDef[], cv: string) => {
    const cc = cols.filter((c) => c.variable === cv);
    const rCats = categoriesOf(ds, b.rv);
    if (b.meanMode) {
      const groups = cc.map((c) => ({ label: c.label, values: b.nums.get(c.key)?.vals ?? [] })).filter((g) => g.values.length > 1);
      if (groups.length >= 2) tests.push({ ...oneWayAnova(groups), note: `${labelOf(ds, b.rv)} by ${labelOf(ds, cv)}${ds.weighted ? " (unweighted)" : ""}` });
      return;
    }
    // chi-square over the raw counts — single-response rows and columns, and no empty rows or columns
    const rowKeys = rCats.map((c) => c.code);
    const liveCols = cc.filter((c) => (b.colBase.get(c.key)?.count ?? 0) > 0);
    const table = rowKeys.map((rk) => liveCols.map((c) => b.grid.get(rk)?.get(c.key)?.count ?? 0)).filter((r) => r.some((x) => x));
    if (table.length >= 2 && liveCols.length >= 2 && ds.byName.get(b.rv)?.role !== "multi" && ds.byName.get(cv)?.role !== "multi") {
      const cs = chiSquare(table);
      tests.push({ ...cs, note: `${labelOf(ds, b.rv)} × ${labelOf(ds, cv)}${ds.weighted ? " (unweighted counts)" : ""}` });
      if (cs.p != null) insights.push(`${labelOf(ds, b.rv)} ${cs.p < alpha ? "differs significantly" : "does not differ significantly"} by ${labelOf(ds, cv)} (χ² = ${fmtNum(cs.statistic, 2)}, p ${cs.p < 0.001 ? "< .001" : "= " + cs.p.toFixed(3)}${cs.effectSize?.value != null ? `, Cramér's V = ${cs.effectSize.value.toFixed(2)}` : ""}).`);
    }
    // the biggest gap to the total
    const totW = b.colBase.get("__total")?.w ?? 0;
    let best: { row: string; col: string; diff: number; total: number } | null = null;
    for (const rk of rowKeys) for (const c of cc) {
      const base = b.colBase.get(c.key); if (!base || base.count < 10 || !base.w) continue;
      const p = ((b.grid.get(rk)?.get(c.key)?.w ?? 0) / base.w) * 100, tot = totW ? ((b.grid.get(rk)?.get("__total")?.w ?? 0) / totW) * 100 : 0, diff = p - tot;
      if (!best || Math.abs(diff) > Math.abs(best.diff)) best = { row: rCats.find((x) => x.code === rk)?.label ?? rk, col: c.label, diff, total: tot };
    }
    if (best && Math.abs(best.diff) >= 5) insights.push(`Largest gap: “${best.row}” is ${fmtNum(Math.abs(best.diff), 1)} points ${best.diff > 0 ? "higher" : "lower"} among ${best.col} (${fmtPct(best.total + best.diff, 1)} vs ${fmtPct(best.total, 1)} overall).`);
  };

  /** build one table for a set of row variables against a set of column variables in one layer */
  const buildTable = (layer: { label: string; ds: Dataset }, rvs: string[], cvs: string[]) => {
    const cols = columnsFor(cvs);
    const out: Record<string, unknown>[] = [];
    const blocks: Block[] = [];
    const all = () => true;
    const emit = (rv: string, level: number, label: string, keep: (i: number) => boolean, groupKey?: string) => {
      const b = accumulate(layer.ds, rv, cols, cvs, keep, level, label, groupKey);
      blocks.push(b);
      return b;
    };
    // suppression is decided on the whole table's column bases (the top-level block)
    const top = accumulate(layer.ds, rvs[0], cols, cvs, all, 0, labelOf(ds, rvs[0]));
    const suppressed = new Set<string>();
    if (minBase > 0) for (const c of cols) if (c.variable && (top.colBase.get(c.key)?.count ?? 0) < minBase) suppressed.add(c.key);

    if (nestRows) {
      const [outer, inner] = rvs;
      const oVals = categoricalColumn(layer.ds, outer);
      blocks.push(top);
      for (const oc of categoriesOf(ds, outer)) {
        const keep = (i: number) => { const v = oVals[i]; return v != null && (Array.isArray(v) ? v.map(String).includes(oc.code) : String(v) === oc.code); };
        const groupKey = `${outer}:${oc.code}`;
        const head: Record<string, unknown> = { row: `${labelOf(ds, outer)}: ${oc.label}`, __kind: "group", __level: 0, __key: groupKey, __format: "count" };
        const b = emit(inner, 1, labelOf(ds, inner), keep, groupKey);
        for (const c of cols) head[c.key] = b.colBase.get(c.key)?.count ?? 0;
        out.push(head);
        emitRows(b, cols, out, suppressed);
      }
    } else if (stackRows && rvs.length > 1) {
      for (const rv of rvs) {
        const b = rv === rvs[0] ? (blocks.push(top), top) : emit(rv, 0, labelOf(ds, rv), all);
        out.push({ row: labelOf(ds, rv), __kind: "section", __level: 0, __key: `section:${rv}` });
        emitRows(b, cols, out, suppressed);
      }
    } else {
      blocks.push(top);
      emitRows(top, cols, out, suppressed);
    }

    const baseRow: Record<string, unknown> = { row: "Base (n)", __format: "count", __kind: "base", __level: 0 };
    for (const c of cols) baseRow[c.key] = top.colBase.get(c.key)?.count ?? 0;
    out.push(baseRow);
    if (ds.weighted) { const wb: Record<string, unknown> = { row: "Weighted base", __format: "number", __kind: "base", __level: 0 }; for (const c of cols) wb[c.key] = round(top.colBase.get(c.key)?.w, 1); out.push(wb); }

    const columns: ResultColumn[] = [
      { key: "row", label: rvs.length > 1 ? "" : labelOf(ds, rvs[0]) },
      ...cols.map((c) => ({ key: c.key, label: `${c.label}${showSig && c.variable ? ` (${c.letter})` : ""}${suppressed.has(c.key) ? " *" : ""}`, type: cellType, decimals: cellType === "number" ? Math.max(decimals, 2) : decimals, ...(c.group && cvs.length > 1 ? { group: c.group } : {}), ...(c.letter ? { letter: c.letter } : {}), ...(suppressed.has(c.key) ? { suppressed: true } : {}) })),
    ];
    const colBases: Record<string, number> = {}; for (const c of cols) colBases[c.key] = top.colBase.get(c.key)?.count ?? 0;
    const title = `${rvs.map((rv) => labelOf(ds, rv)).join(nestRows ? " › " : ", ")} × ${cvs.map((cv) => labelOf(ds, cv)).join(", ")}${layer.label ? ` — ${layer.label}` : ""}`;
    const notes = [
      measure === "pct_col" ? "Column percentages." : measure === "pct_row" ? "Row percentages." : measure === "pct_total" ? "Percent of total." : measure === "mean" ? "Column means." : ds.weighted ? "Weighted counts." : "Counts.",
      ...(baseMode === "all" ? ["Based on everyone in the column; “No answer” counts the respondents who did not answer the row question."] : []),
      ...(showSig ? [top.meanMode ? `Letters mark columns with a significantly lower mean at the ${Math.round((1 - alpha) * 100)}% level.` : sigNote] : []),
      ...(sigVsTotal ? ["+ / − mark cells significantly above / below the rest of the sample."] : []),
      ...(suppressed.size ? [`* Columns with fewer than ${minBase} respondents are suppressed.`] : []),
      ...(Object.entries(colBases).some(([k, b]) => k !== "__total" && b > 0 && b < 30) ? ["Some columns have a base below 30 — read with caution."] : []),
    ];
    for (const c of cols) { const b = colBases[c.key]; if (c.variable && b > 0 && b < 30 && !suppressed.has(c.key)) warnings.push(`Column “${c.label}” of ${c.group || labelOf(ds, c.variable)} has a base of ${b}.`); }
    const id = `xt_${rvs.join("+")}_${cvs.join("+")}${layerVar ? "_" + layer.label : ""}`;
    tables.push({ id, title, columns, rows: out, base: { n: top.colBase.get("__total")?.count ?? 0, weightedN: round(top.colBase.get("__total")?.w, 1) ?? 0 }, columnBases: colBases, notes });
    for (const cv of cvs) { testsFor(top, cols, cv); chartFrom(top, cols, cv); }
  };

  for (const layer of layers) {
    if (layout === "banner") {
      if (nestRows || stackRows) buildTable(layer, rowVars, colVars);
      else for (const rv of rowVars) buildTable(layer, [rv], colVars);
    } else {
      if (nestRows) for (const cv of colVars) buildTable(layer, rowVars, [cv]);
      else for (const rv of rowVars) for (const cv of colVars) buildTable(layer, [rv], [cv]);
    }
  }
  return makeResult(def, ds, {
    tables, chart, tests, insights, warnings: [...new Set(warnings)],
    recommendedCharts: ["bar_grouped", "bar_stacked_100", "heatmap_crosstab", "bar_horizontal", "table"],
    variablesUsed: [...rowVars, ...colVars, ...(layerVar ? [layerVar] : [])], totalCases,
    validN: layerVar ? undefined : tables[0]?.base?.n,
  });
}

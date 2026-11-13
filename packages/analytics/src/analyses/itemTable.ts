import type { AnalysisDefinition, AnalysisResult, ChartData, ResultColumn, ResultTable } from "../types.js";
import { categoriesOf, labelOf, weights, type Dataset, type VariableMeta } from "../dataset.js";
import { makeResult, opt, round } from "./common.js";

/**
 * THE ITEM TABLE — ONE ROW PER ITEM, ONE TABLE FOR THE WHOLE SET (2026-11-16).
 *
 * A crosstab draws one block of rows per variable. That is the wrong shape for the tables a tracker lives on:
 * twenty brands rated in a loop, or twelve statements of a grid, are twenty or twelve VARIABLES asking the same
 * thing, and what a researcher wants is one line per brand with its score — not twenty tables. `layout: "items"`
 * (still a crosstab: same rows / columns / filter / weighting, saved and exported the same way) draws that table.
 *
 *   rows      def.rows — the variables that ask the same thing. One line each, labelled by the item.
 *             A LOOP IS READ BY ITEM, NOT BY PASS: Q7_3 is "the third brand this respondent was shown", which is a
 *             different brand for different people. When the loop records which item each pass was
 *             (LOOP_<VAR>_ITEM_<n>_CODE), each answer is filed under the brand it was about, so the row "Nike" is
 *             everyone who rated Nike, whichever pass it came in.
 *   columns   none      → the PROFILE of each item: base, then the statistics (`itemStats`)
 *             a banner  → ONE statistic (`itemStat`) per banner column: NPS by brand × segment, in one table
 *   stats     "pct" (every answer category), "mean", "top2", "bottom2", "nps" (promoters, passives, detractors and
 *             the score). Left out, they are chosen from the scale: a 0–10 scale gets NPS and the mean, an ordered
 *             scale the mean and top-2 box, anything else its categories.
 *   transpose exchanges rows and columns of the finished table (items across the top).
 *
 * Weighted like every table (the base shown is the unweighted count). No significance letters: items are answered
 * by overlapping respondents, so the column tests of a crosstab do not apply — the table says so.
 */
export const NPS_GROUPS = { promoters: ["9", "10"], passives: ["7", "8"], detractors: ["0", "1", "2", "3", "4", "5", "6"] } as const;
/** exactly the codes 0…10 */
export function isNpsFrame(codes: string[]): boolean {
  if (codes.length !== 11) return false;
  const n = codes.map(Number).sort((a, b) => a - b);
  return n.every((v, i) => v === i);
}

/**
 * may this variable be read as NPS? A question programmed as NPS, whatever scores happen to have been given so far
 * (a dictionary without a code frame lists only the values seen), or any variable whose frame is exactly 0…10.
 */
export function npsCapable(meta: { nps?: boolean } | undefined, codes: string[]): boolean {
  if (isNpsFrame(codes)) return true;
  return meta?.nps === true && codes.length > 0 && codes.every((c) => { const n = Number(c); return Number.isInteger(n) && n >= 0 && n <= 10; });
}

export type ItemStat = "pct" | "mean" | "top2" | "bottom2" | "nps";
const STAT_WORDS: Record<ItemStat, string> = { pct: "% of each answer", mean: "Mean", top2: "Top 2 box %", bottom2: "Bottom 2 box %", nps: "NPS" };

interface Obs { case: number; value: string; w: number }
interface Item { key: string; label: string; section: string; frame: { code: string; label: string }[]; numeric: boolean; nps: boolean; obs: Obs[] }
interface Tally { n: number; w: number; sum: number; counts: Map<string, number> }
const tally = (): Tally => ({ n: 0, w: 0, sum: 0, counts: new Map() });

/** the loop's "which item was this pass" column for a looped variable, when the survey records it */
function loopItemVariable(ds: Dataset, v: VariableMeta): VariableMeta | null {
  if (!v.loopId || v.iteration == null) return null;
  for (const m of ds.variables) {
    if (m.loopId === v.loopId && m.iteration === v.iteration && /_ITEM_\d+_CODE$/.test(m.name) && (m.categories?.length ?? 0) > 0) return m;
  }
  return null;
}

/** the question a variable measures, without its loop pass: Q7_3 and Q7_5 are the same measurement */
const measureKey = (v: VariableMeta) => `${v.questionId ?? v.name}|${v.rowCode ?? ""}|${v.optionCode ?? ""}`;
const stripPass = (label: string) => label.replace(/\s*\([^()]*\b\d+\)\s*$/, "");

export function buildItems(ds: Dataset, rowVars: string[], warnings: string[]): Item[] {
  const lw = weights(ds);
  const items = new Map<string, Item>();
  const loopSections = new Set<string>();
  for (const name of rowVars) {
    const meta = ds.byName.get(name);
    if (!meta) { warnings.push(`Variable ${name} is not in this survey's dictionary.`); continue; }
    const frame = meta.role === "numeric" && !meta.categories ? [] : categoriesOf(ds, name);
    const numeric = meta.role === "numeric" && !meta.categories;
    const nps = npsCapable(meta, frame.map((c) => c.code));
    const itemVar = loopItemVariable(ds, meta);
    const section = itemVar ? stripPass(meta.label) : "";
    if (itemVar) loopSections.add(measureKey(meta));
    const put = (key: string, label: string, i: number, raw: unknown) => {
      const w = lw?.[i] ?? 1;
      if (!(w > 0)) return;
      let it = items.get(key);
      if (!it) { it = { key, label, section, frame, numeric, nps, obs: [] }; items.set(key, it); }
      for (const v of Array.isArray(raw) ? raw : [raw]) it.obs.push({ case: i, value: String(v), w });
    };
    if (itemVar) {
      const labels = new Map((itemVar.categories ?? []).map((c) => [c.code, c.label]));
      /* every possible item gets its row, in the list's order, even before anyone was shown it */
      for (const c of itemVar.categories ?? []) { const key = `${measureKey(meta)}::${c.code}`; if (!items.has(key)) items.set(key, { key, label: c.label, section, frame, numeric, nps, obs: [] }); }
      ds.cases.forEach((c, i) => {
        const raw = c.vars[name]; if (raw == null || raw === "") return;
        const code = c.vars[itemVar.name]; if (code == null || code === "") return;
        put(`${measureKey(meta)}::${String(code)}`, labels.get(String(code)) ?? String(code), i, raw);
      });
    } else {
      const label = meta.itemLabel ?? meta.label;
      if (!items.has(name)) items.set(name, { key: name, label, section, frame, numeric, nps, obs: [] });
      ds.cases.forEach((c, i) => { const raw = c.vars[name]; if (raw == null || raw === "" || (Array.isArray(raw) && !raw.length)) return; put(name, label, i, raw); });
    }
  }
  const out = [...items.values()];
  /* one looped question: its name is the table's subject, not a heading above every row */
  if (loopSections.size <= 1 && out.every((i) => i.section === out[0]?.section)) for (const i of out) i.section = "";
  return out;
}

function statsOf(item: Item, keep: ((caseIndex: number) => boolean) | null): Tally {
  const t = tally();
  const seen = new Set<number>();
  for (const o of item.obs) {
    if (keep && !keep(o.case)) continue;
    t.counts.set(o.value, (t.counts.get(o.value) ?? 0) + o.w);
    const num = Number(o.value);
    /* the base is respondents: once each per item, however many answers a multi-select gave */
    if (!seen.has(o.case)) { seen.add(o.case); t.n++; t.w += o.w; }
    if (Number.isFinite(num)) t.sum += num * o.w;
  }
  return t;
}
const share = (t: Tally, codes: readonly string[]) => (t.w ? (codes.reduce((s, c) => s + (t.counts.get(c) ?? 0), 0) / t.w) * 100 : null);

/** the value of one statistic for one tally of one item */
export function statValue(item: Item, t: Tally, stat: Exclude<ItemStat, "pct">, decimals: number): number | null {
  if (!t.w) return null;
  const ordered = [...item.frame].map((c) => c.code).sort((a, b) => Number(a) - Number(b));
  if (stat === "mean") { const answered = [...t.counts.entries()].filter(([k]) => Number.isFinite(Number(k))).reduce((s, [, w]) => s + w, 0); return answered ? round(t.sum / answered, Math.max(decimals, 2)) : null; }
  if (stat === "top2") return round(share(t, ordered.slice(-2)), decimals);
  if (stat === "bottom2") return round(share(t, ordered.slice(0, 2)), decimals);
  const p = share(t, NPS_GROUPS.promoters), d = share(t, NPS_GROUPS.detractors);
  return p == null || d == null ? null : round(p - d, decimals);
}

/** the statistics that suit a set of items when none were asked for */
export function defaultItemStats(items: Item[]): ItemStat[] {
  if (!items.length) return [];
  const codes = items[0].frame.map((c) => c.code);
  const same = items.every((i) => i.frame.length === codes.length && i.frame.every((c, k) => c.code === codes[k]));
  if (items.every((i) => i.numeric)) return ["mean"];
  if (items.every((i) => i.nps)) return ["nps", "mean"];
  const numericCodes = codes.length >= 3 && codes.every((c) => Number.isFinite(Number(c)));
  if (same && numericCodes) return ["pct", "mean", "top2"];
  return same ? ["pct"] : [];
}

/** rows ↔ columns of a finished table; a row's cells keep their own format */
export function transposeTable(t: ResultTable): ResultTable {
  const first = t.columns[0];
  const dataCols = t.columns.slice(1);
  const body = t.rows.filter((r) => r.__kind !== "section");
  const columns: ResultColumn[] = [{ key: first.key, label: first.label, type: "text" }, ...body.map((r, i) => ({ key: `r${i}`, label: String(r[first.key] ?? ""), type: "number" as const, ...(typeof r.__section === "string" && r.__section ? { group: r.__section } : {}) }))];
  const rows = dataCols.map((c) => {
    const row: Record<string, unknown> = { [first.key]: c.group ? `${c.group}: ${c.label}` : c.label, __kind: "category", __format: c.type ?? "number" };
    body.forEach((r, i) => { row[`r${i}`] = r[c.key] ?? null; if (r[`${c.key}__n`] != null) row[`r${i}__n`] = r[`${c.key}__n`]; });
    return row;
  });
  return { ...t, columns, rows, columnBases: undefined, notes: [...(t.notes ?? []), "Rows and columns are exchanged: each column is an item."] };
}

export function itemTable(def: AnalysisDefinition, ds: Dataset, totalCases: number): AnalysisResult {
  const rowVars = def.rows?.length ? def.rows : def.variables;
  const colVars = def.columns ?? [];
  const decimals = Math.min(4, Math.max(0, Number(opt(def, "decimals", 1)) || 0));
  const sortRows = opt(def, "sortRows", "none") as "none" | "desc" | "asc";
  const transpose = opt(def, "transpose", false) as boolean;
  const minBase = Math.max(0, Number(opt(def, "minBase", 0)) || 0);
  const warnings: string[] = [];
  if (!rowVars.length) return makeResult(def, ds, { tables: [], chart: {}, warnings: ["An item table needs the questions to list: add them to Rows."], recommendedCharts: ["table"], totalCases });

  const items = buildItems(ds, rowVars, warnings);
  const known = new Set<ItemStat>(["pct", "mean", "top2", "bottom2", "nps"]);
  const asked = (opt(def, "itemStats", []) as string[]).filter((s): s is ItemStat => known.has(s as ItemStat));
  let stats = asked.length ? asked : defaultItemStats(items);
  const sameFrame = items.length > 0 && items.every((i) => i.frame.length === items[0].frame.length && i.frame.every((c, k) => c.code === items[0].frame[k].code));
  const allNps = items.length > 0 && items.every((i) => i.nps);
  const numericCodes = items.length > 0 && items.every((i) => i.numeric || (i.frame.length >= 2 && i.frame.every((c) => Number.isFinite(Number(c.code)))));
  const drop = (s: ItemStat, why: string) => { if (stats.includes(s)) { stats = stats.filter((x) => x !== s); warnings.push(why); } };
  if (!allNps) drop("nps", "NPS is not shown: it needs 0–10 scales, and not every question listed is one.");
  if (!numericCodes) { drop("mean", "A mean is not shown: not every question listed has numeric codes."); drop("top2", "Top-2 box is not shown: not every question listed has an ordered numeric scale."); drop("bottom2", "Bottom-2 box is not shown: not every question listed has an ordered numeric scale."); }
  if (!sameFrame) drop("pct", "The answers are not shown as columns: the questions listed do not share one set of answers.");
  if (items.some((i) => i.numeric)) stats = stats.filter((s) => s === "mean");
  if (!stats.length) {
    return makeResult(def, ds, { tables: [], chart: {}, warnings: [...warnings, "These questions cannot be put in one item table: they share neither a scale nor a set of answers. Use a banner table with stacked rows instead."], recommendedCharts: ["table"], totalCases });
  }

  const rowLabel = { key: "row", label: items.some((i) => i.section) ? "Question / item" : "Item", type: "text" as const };
  const columns: ResultColumn[] = [rowLabel];
  const rows: Record<string, unknown>[] = [];
  const notes: string[] = [];
  let chart: ChartData = {};
  let title: string;
  const subject = (() => { const first = ds.byName.get(rowVars[0]); if (!first) return "Items"; if (first.loopId) return stripPass(first.label); const own = first.itemLabel && first.label.includes(first.itemLabel) ? first.label.replace(first.itemLabel, "").replace(/[\s—:·-]+$/, "").trim() : first.label; return own || first.questionCode || first.label; })();

  if (!colVars.length) {
    /* ---- the profile of each item ---- */
    columns.push({ key: "base", label: "Base (n)", type: "count" });
    const frame = items[0].frame;
    for (const s of stats) {
      if (s === "pct") for (const c of frame) columns.push({ key: `c_${c.code}`, label: c.label, type: "pct", decimals, group: "% answering" });
      else if (s === "nps") columns.push({ key: "promoters", label: "Promoters (9–10)", type: "pct", decimals, group: "NPS" }, { key: "passives", label: "Passives (7–8)", type: "pct", decimals, group: "NPS" }, { key: "detractors", label: "Detractors (0–6)", type: "pct", decimals, group: "NPS" }, { key: "nps", label: "NPS", type: "number", decimals, group: "NPS" });
      else columns.push({ key: s, label: STAT_WORDS[s], type: s === "mean" ? "number" : "pct", decimals: s === "mean" ? Math.max(decimals, 2) : decimals });
    }
    for (const it of items) {
      const t = statsOf(it, null);
      const row: Record<string, unknown> = { row: it.label, __kind: "category", __section: it.section, base: t.n };
      const small = minBase > 0 && t.n < minBase;
      for (const s of stats) {
        if (s === "pct") for (const c of frame) row[`c_${c.code}`] = small ? null : round(share(t, [c.code]), decimals);
        else if (s === "nps") { row.promoters = small ? null : round(share(t, NPS_GROUPS.promoters), decimals); row.passives = small ? null : round(share(t, NPS_GROUPS.passives), decimals); row.detractors = small ? null : round(share(t, NPS_GROUPS.detractors), decimals); row.nps = small ? null : statValue(it, t, "nps", decimals); }
        else row[s] = small ? null : statValue(it, t, s, decimals);
      }
      rows.push(row);
    }
    const lead = stats.includes("nps") ? "nps" : stats.find((s) => s !== "pct") ?? `c_${frame[frame.length - 1]?.code}`;
    if (sortRows !== "none") rows.sort((a, b) => ((Number(a[lead]) || -Infinity) - (Number(b[lead]) || -Infinity)) * (sortRows === "asc" ? 1 : -1));
    title = `${subject} — by item`;
    const leadCol = columns.find((c) => c.key === lead);
    chart = { categories: rows.map((r) => String(r.row)), series: [{ name: leadCol?.label ?? "Value", values: rows.map((r) => (typeof r[lead] === "number" ? (r[lead] as number) : null)) }], valueFormat: leadCol?.type === "pct" ? "pct" : "number" };
  } else {
    /* ---- one statistic per banner column ---- */
    const want = String(opt(def, "itemStat", ""));
    const single = stats.filter((s): s is Exclude<ItemStat, "pct"> => s !== "pct");
    const stat: Exclude<ItemStat, "pct"> | null = (single as string[]).includes(want) ? (want as Exclude<ItemStat, "pct">) : single[0] ?? null;
    if (!stat) return makeResult(def, ds, { tables: [], chart: {}, warnings: [...warnings, "With a banner, an item table shows one figure per cell (NPS, a mean or a box score). These questions have no numeric scale to take one from — remove the banner to see their answers as columns."], recommendedCharts: ["table"], totalCases });
    if (want && want !== stat) warnings.push(`“${want}” cannot be shown for these questions; the table shows ${STAT_WORDS[stat]}.`);
    const type = stat === "mean" || stat === "nps" ? "number" : "pct";
    const cellDecimals = stat === "mean" ? Math.max(decimals, 2) : decimals;
    const banner: { key: string; label: string; group: string; keep: ((i: number) => boolean) | null }[] = [{ key: "__total", label: "Total", group: "", keep: null }];
    for (const cv of colVars) {
      if (!ds.byName.get(cv)) { warnings.push(`Variable ${cv} is not in this survey's dictionary.`); continue; }
      for (const c of categoriesOf(ds, cv)) {
        const col = ds.cases.map((x) => x.vars[cv]);
        banner.push({ key: `${cv}::${c.code}`, label: c.label, group: labelOf(ds, cv), keep: (i) => { const v = col[i]; return Array.isArray(v) ? v.map(String).includes(c.code) : v != null && String(v) === c.code; } });
      }
    }
    for (const b of banner) columns.push({ key: b.key, label: b.label, type, decimals: cellDecimals, ...(b.group ? { group: b.group } : {}) });
    for (const it of items) {
      const row: Record<string, unknown> = { row: it.label, __kind: "category", __section: it.section };
      for (const b of banner) { const t = statsOf(it, b.keep); row[b.key] = minBase > 0 && t.n < minBase ? null : statValue(it, t, stat, decimals); row[`${b.key}__n`] = t.n; }
      rows.push(row);
    }
    if (sortRows !== "none") rows.sort((a, b) => ((Number(a.__total) || -Infinity) - (Number(b.__total) || -Infinity)) * (sortRows === "asc" ? 1 : -1));
    title = `${STAT_WORDS[stat]} — ${subject} by ${colVars.map((c) => labelOf(ds, c)).join(", ")}`;
    notes.push(`Each cell is the ${STAT_WORDS[stat]} of that item among the respondents of that column; its base is in the cell's detail.`);
    chart = { categories: rows.map((r) => String(r.row)), series: banner.slice(0, 7).map((b) => ({ name: b.label, values: rows.map((r) => (typeof r[b.key] === "number" ? (r[b.key] as number) : null)) })), valueFormat: type === "pct" ? "pct" : "number" };
  }

  /* section headings when several looped questions share the table */
  const sectioned: Record<string, unknown>[] = [];
  let last = "";
  for (const r of rows) { const sec = String(r.__section ?? ""); if (sec && sec !== last && sortRows === "none") { sectioned.push({ row: sec, __kind: "section" }); } last = sec; sectioned.push(r); }
  if (ds.byName.get(rowVars[0])?.loopId && items.some((i) => i.key.includes("::"))) notes.push("A looped question is read by item: each answer is counted under the item it was about, whichever pass of the loop it came in.");
  notes.push("Items are answered by overlapping respondents, so no significance letters are shown in this table.");
  if (minBase > 0) notes.push(`Figures on fewer than ${minBase} respondents are not shown.`);
  let table: ResultTable = { id: "items", title, columns, rows: sectioned, notes };
  if (transpose) table = transposeTable(table);
  const answered = new Set<number>(); for (const it of items) for (const o of it.obs) answered.add(o.case);
  const lw = weights(ds);
  return makeResult(def, ds, {
    tables: [table], chart, warnings, recommendedCharts: ["bar_horizontal", "table", "ranking_bar"], totalCases,
    variablesUsed: [...rowVars, ...colVars], validN: answered.size,
    ...(lw ? { validWeightedN: [...answered].reduce((s, i) => s + (lw[i] ?? 0), 0) } : {}),
  });
}

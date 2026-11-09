import { chiSquare, proportionTest, trendProportions, proportionCI } from "./stats/tests.js";
import { normalCdf, tCdf } from "./stats/distributions.js";

/**
 * MULTI-WAVE TRACKING ACROSS DATASETS (2026-11-09 — Rapid Studio phase 3).
 *
 * `waves.ts` compares two analysis runs of the SAME survey. A tracker lives longer than one questionnaire: wave 1 was
 * fielded on another platform, wave 3 renamed a variable, wave 4 moved from a 5- to a 7-point scale. This module takes
 * each wave's dataset as it is (an uploaded export, or this survey's own data) and:
 *
 *   maps       every baseline variable to its equivalent in each wave — the same name, a renamed one (wave suffixes,
 *              punctuation), the same question wording, or the same answer set — with a confidence and the CHANGES that
 *              matter for comparability (wording, scale points, answer labels, recoded codes); new and dropped variables
 *   harmonizes one long dataset (WAVE + the baseline's variable names), answers recoded by their labels where a wave
 *              coded them differently
 *   measures   each KPI per wave (share of chosen codes, top-box, mean, NPS) with its base and 95 % interval; wave on
 *              wave and against the baseline with the right test (two proportions, Welch's t, the NPS difference); the
 *              trend across all waves (Cochran–Armitage for shares); by segment
 *   explains   sample composition between waves (chi-square per profile variable) and each KPI re-computed with every
 *              wave RAKED to the baseline's profile — so a change that disappears once the samples are matched is
 *              reported as composition, not performance; a KPI whose question changed is "not comparable"
 *   recommends the charts and tests that fit the comparison
 *
 * Pure and deterministic; nothing here reads a database.
 */

export interface WaveColumn { name: string; label?: string; values?: { code: string; label: string }[] }
export interface WaveData { id: string; label: string; order: number; columns: WaveColumn[]; rows: Record<string, unknown>[]; source?: "upload" | "survey" }
export type MatchHow = "same_name" | "renamed" | "by_wording" | "by_values" | "manual" | "none";
export interface VariableMatch { base: string; other: string | null; how: MatchHow; confidence: number; changes: string[]; comparable: boolean; recode?: Record<string, string> }
export interface WaveMapping { waveId: string; matches: VariableMatch[]; added: string[]; removed: string[] }

const norm = (s: string) => String(s ?? "").toLowerCase().replace(/(?:[_\-. ]?(?:w|wave|wv)[_\-. ]?\d+|[_\-. ]?(?:19|20)\d\d(?:q[1-4])?|[_\-. ]?q[1-4][_\-. ]?(?:19|20)?\d\d)$/i, "").replace(/[^a-z0-9]/g, "");
const tokens = (s: string | undefined) => new Set(String(s ?? "").toLowerCase().replace(/<[^>]+>/g, " ").match(/[\p{L}\p{N}]{3,}/gu) ?? []);
const jaccard = (a: Set<string>, b: Set<string>) => { if (!a.size || !b.size) return 0; let i = 0; for (const x of a) if (b.has(x)) i++; return i / (a.size + b.size - i); };

/** the answers a column holds: its declared values, else the distinct values in the rows (up to 40) */
function valuesOf(w: WaveData, c: WaveColumn): { code: string; label: string }[] {
  if (c.values?.length) return c.values.map((v) => ({ code: String(v.code), label: String(v.label ?? v.code) }));
  const seen = new Set<string>();
  for (const r of w.rows) { const v = r[c.name]; if (v === null || v === undefined || v === "") continue; seen.add(String(v)); if (seen.size > 40) break; }
  return [...seen].sort((a, b) => (Number(a) - Number(b)) || a.localeCompare(b)).map((v) => ({ code: v, label: v }));
}
const numericRange = (vals: { code: string }[]) => { const ns = vals.map((v) => Number(v.code)).filter((n) => Number.isFinite(n)); return ns.length === vals.length && ns.length ? [Math.min(...ns), Math.max(...ns)] as const : null; };

/** what makes two columns not the same measurement */
function changesBetween(bw: WaveData, b: WaveColumn, ow: WaveData, o: WaveColumn): { changes: string[]; comparable: boolean; recode?: Record<string, string> } {
  const changes: string[] = [];
  let comparable = true;
  if (b.label && o.label) {
    const j = jaccard(tokens(b.label), tokens(o.label));
    if (j < 0.9 && b.label.trim() !== o.label.trim()) changes.push(`wording changed: “${b.label.slice(0, 80)}” → “${o.label.slice(0, 80)}”`);
    if (j < 0.5) comparable = false;
  }
  const bv = valuesOf(bw, b), ov = valuesOf(ow, o);
  const br = numericRange(bv), or = numericRange(ov);
  const labelled = (vs: { code: string; label: string }[]) => vs.some((v) => v.label !== v.code);
  let recode: Record<string, string> | undefined;
  if (labelled(bv) && labelled(ov)) {
    const byLabel = new Map(bv.map((v) => [v.label.trim().toLowerCase(), v.code]));
    const map: Record<string, string> = {};
    let differs = false, unmatched = 0;
    for (const v of ov) { const c = byLabel.get(v.label.trim().toLowerCase()); if (c === undefined) unmatched++; else { map[v.code] = c; if (c !== v.code) differs = true; } }
    if (differs && !unmatched) { recode = map; changes.push("answer codes differ — recoded by their labels"); }
    if (unmatched) { changes.push(`answer list changed: ${unmatched} answer${unmatched === 1 ? "" : "s"} with no equivalent`); if (unmatched / ov.length > 0.3) comparable = false; }
  }
  if (br && or && bv.length >= 3 && ov.length >= 3 && (br[0] !== or[0] || br[1] !== or[1]) && !recode) {
    const isScale = (r: readonly [number, number]) => r[1] - r[0] >= 2 && r[1] - r[0] <= 10;
    if (isScale(br) && isScale(or)) { changes.push(`scale changed: ${br[0]}–${br[1]} → ${or[0]}–${or[1]}`); comparable = false; }
  }
  return { changes, comparable, ...(recode ? { recode } : {}) };
}

/** every baseline variable → its equivalent in `wave` (manual choices win: a variable name, or null for "not asked") */
export function mapWave(base: WaveData, wave: WaveData, manual: Record<string, string | null> = {}): WaveMapping {
  const used = new Set<string>();
  const byName = new Map(wave.columns.map((c) => [c.name, c]));
  const byNorm = new Map<string, WaveColumn>();
  for (const c of wave.columns) if (!byNorm.has(norm(c.name))) byNorm.set(norm(c.name), c);
  const matches: VariableMatch[] = [];
  const pass: { b: WaveColumn; found: WaveColumn | null; how: MatchHow; conf: number }[] = base.columns.map((b) => ({ b, found: null, how: "none", conf: 0 }));
  for (const p of pass) {
    if (p.b.name in manual) { const m = manual[p.b.name]; p.found = m ? byName.get(m) ?? null : null; p.how = "manual"; p.conf = 1; if (p.found) used.add(p.found.name); continue; }
    const exact = byName.get(p.b.name);
    if (exact) { p.found = exact; p.how = "same_name"; p.conf = 1; used.add(exact.name); }
  }
  for (const p of pass) {
    if (p.found || p.how === "manual") continue;
    const r = byNorm.get(norm(p.b.name));
    if (r && !used.has(r.name)) { p.found = r; p.how = "renamed"; p.conf = 0.9; used.add(r.name); }
  }
  for (const p of pass) {
    if (p.found || p.how === "manual" || !p.b.label) continue;
    let best: { c: WaveColumn; j: number } | null = null;
    for (const c of wave.columns) { if (used.has(c.name) || !c.label) continue; const j = jaccard(tokens(p.b.label), tokens(c.label)); if (j >= 0.6 && (!best || j > best.j)) best = { c, j }; }
    if (best) { p.found = best.c; p.how = "by_wording"; p.conf = Math.round(best.j * 100) / 100; used.add(best.c.name); }
  }
  for (const p of pass) {
    if (p.found || p.how === "manual") continue;
    const bv = valuesOf(base, p.b).filter((v) => v.label !== v.code);
    if (bv.length < 3) continue;
    const sig = bv.map((v) => v.label.toLowerCase()).sort().join("|");
    const c = wave.columns.find((x) => !used.has(x.name) && valuesOf(wave, x).filter((v) => v.label !== v.code).map((v) => v.label.toLowerCase()).sort().join("|") === sig && norm(x.name).slice(0, 2) === norm(p.b.name).slice(0, 2));
    if (c) { p.found = c; p.how = "by_values"; p.conf = 0.6; used.add(c.name); }
  }
  for (const p of pass) {
    if (!p.found) { matches.push({ base: p.b.name, other: null, how: p.how === "manual" ? "manual" : "none", confidence: p.how === "manual" ? 1 : 0, changes: ["not in this wave"], comparable: false }); continue; }
    const ch = changesBetween(base, p.b, wave, p.found);
    if (p.how === "renamed" || (p.how !== "same_name" && p.found.name !== p.b.name)) ch.changes.unshift(`variable named ${p.found.name}`);
    matches.push({ base: p.b.name, other: p.found.name, how: p.how, confidence: p.conf, changes: ch.changes, comparable: ch.comparable, ...(ch.recode ? { recode: ch.recode } : {}) });
  }
  return { waveId: wave.id, matches, added: wave.columns.map((c) => c.name).filter((n) => !used.has(n)), removed: matches.filter((m) => !m.other).map((m) => m.base) };
}

/** one long dataset: WAVE + the baseline's variables, each wave's answers recoded to the baseline's codes */
export function harmonize(waves: WaveData[], mappings: Record<string, WaveMapping>): { rows: Record<string, unknown>[]; variables: string[] } {
  const ordered = [...waves].sort((a, b) => a.order - b.order);
  const base = ordered[0];
  const variables = base.columns.map((c) => c.name);
  const rows: Record<string, unknown>[] = [];
  for (const w of ordered) {
    const m = w.id === base.id ? null : mappings[w.id];
    for (const r of w.rows) {
      const out: Record<string, unknown> = { WAVE: w.label, __wave: w.id };
      for (const v of variables) {
        const mm = m?.matches.find((x) => x.base === v);
        const src = w.id === base.id ? v : mm?.other ?? null;
        if (!src) { out[v] = null; continue; }
        const raw = r[src];
        out[v] = mm?.recode && raw !== null && raw !== undefined && raw !== "" ? mm.recode[String(raw)] ?? raw : raw;
      }
      rows.push(out);
    }
  }
  return { rows, variables };
}

/* ------------------------------------------------------------ KPIs */

export type KpiMeasure = "share" | "top_box" | "mean" | "nps";
export interface TrackerKpi { id: string; label: string; variable: string; measure: KpiMeasure; codes?: string[]; top?: number }

/** KPIs a tracker usually reports, read from the baseline's variable names and wording */
export function suggestKpis(base: WaveData): TrackerKpi[] {
  const out: TrackerKpi[] = [];
  for (const c of base.columns) {
    const t = `${c.name} ${c.label ?? ""}`.toLowerCase();
    const vals = valuesOf(base, c);
    const r = numericRange(vals);
    const dummy = r && r[0] >= 0 && r[1] <= 1;
    const kind = /\bnps\b|recommend/.test(t) && r && r[1] === 10 ? "nps" : /aware|consider|prefer|usage|used|purchase|buy|recall|familiar/.test(t) && dummy ? "share" : /satisf|likel|agree|rating|intent/.test(t) && r && r[1] - r[0] >= 3 && r[1] - r[0] <= 10 ? "top_box" : null;
    if (!kind) continue;
    out.push({ id: `k_${c.name}`, label: c.label?.slice(0, 60) || c.name, variable: c.name, measure: kind, ...(kind === "share" ? { codes: ["1"] } : kind === "top_box" ? { top: 2 } : {}) });
    if (out.length >= 12) break;
  }
  return out;
}

export interface KpiPoint { wave: string; label: string; value: number | null; n: number; ci: [number, number] | null; x?: number; sd?: number; promoters?: number; detractors?: number }
const toNum = (v: unknown) => (v === null || v === undefined || v === "" ? null : Number(v));

/** a KPI on one set of rows (weights optional: raked or survey weights) */
export function measureKpi(k: TrackerKpi, rows: Record<string, unknown>[], weights?: number[], scaleMax?: number): Omit<KpiPoint, "wave" | "label"> {
  let wn = 0, wx = 0, wsum2 = 0, sumw = 0, sumw2 = 0, n = 0, pr = 0, de = 0;
  const vals: number[] = [];
  const max = scaleMax ?? Math.max(...rows.map((r) => toNum(r[k.variable])).filter((x): x is number => x !== null && Number.isFinite(x)), -Infinity);
  rows.forEach((r, i) => {
    const raw = r[k.variable];
    if (raw === null || raw === undefined || raw === "") return;
    const w = weights?.[i] ?? 1;
    const num = Number(raw);
    n++; sumw += w; sumw2 += w * w;
    if (k.measure === "share") { if ((k.codes ?? ["1"]).includes(String(raw))) wx += w; }
    else if (k.measure === "top_box") { if (Number.isFinite(num) && num > max - (k.top ?? 2)) wx += w; }
    else if (k.measure === "nps") { if (num >= 9) { pr += w; } else if (num <= 6) de += w; }
    else if (Number.isFinite(num)) { wx += w * num; wsum2 += w * num * num; vals.push(num); }
    wn += w;
  });
  if (!n || !wn) return { value: null, n: 0, ci: null };
  const neff = weights ? (sumw * sumw) / sumw2 : n;
  if (k.measure === "nps") {
    const p = pr / wn, d = de / wn, v = (p - d) * 100, varr = (p + d - (p - d) ** 2) / neff;
    const h = 1.96 * Math.sqrt(varr) * 100;
    return { value: Math.round(v * 10) / 10, n, ci: [Math.round((v - h) * 10) / 10, Math.round((v + h) * 10) / 10], promoters: p, detractors: d };
  }
  if (k.measure === "mean") {
    const m = wx / wn, sd = Math.sqrt(Math.max(0, wsum2 / wn - m * m));
    const h = 1.96 * sd / Math.sqrt(neff);
    return { value: Math.round(m * 100) / 100, n, ci: [Math.round((m - h) * 100) / 100, Math.round((m + h) * 100) / 100], sd };
  }
  const p = wx / wn;
  const ci = proportionCI(Math.round(p * neff), Math.round(neff));
  return { value: Math.round(p * 1000) / 10, n, ci: ci ? [Math.round(ci[0] * 1000) / 10, Math.round(ci[1] * 1000) / 10] : null, x: p };
}

/** is the difference between two points significant (the test that fits the measure, on effective bases) */
export function comparePoints(k: TrackerKpi, a: KpiPoint, b: KpiPoint): { diff: number | null; p: number | null; test: string } {
  if (a.value === null || b.value === null || !a.n || !b.n) return { diff: null, p: null, test: "—" };
  const diff = Math.round((b.value - a.value) * 10) / 10;
  if (k.measure === "nps") {
    const v = (x: KpiPoint) => ((x.promoters ?? 0) + (x.detractors ?? 0) - ((x.promoters ?? 0) - (x.detractors ?? 0)) ** 2) / x.n;
    const z = ((b.value - a.value) / 100) / Math.sqrt(v(a) + v(b) || 1e-9);
    return { diff, p: Math.min(1, 2 * (1 - normalCdf(Math.abs(z)))), test: "NPS difference (z)" };
  }
  if (k.measure === "mean") {
    const se = Math.sqrt((a.sd ?? 0) ** 2 / a.n + (b.sd ?? 0) ** 2 / b.n);
    if (!se) return { diff, p: null, test: "Welch's t" };
    const t = (b.value - a.value) / se;
    const df = Math.max(1, (((a.sd ?? 0) ** 2 / a.n + (b.sd ?? 0) ** 2 / b.n) ** 2) / (((a.sd ?? 0) ** 4) / (a.n * a.n * Math.max(1, a.n - 1)) + ((b.sd ?? 0) ** 4) / (b.n * b.n * Math.max(1, b.n - 1)) || 1));
    return { diff, p: Math.min(1, 2 * (1 - tCdf(Math.abs(t), df))), test: "Welch's t" };
  }
  const r = proportionTest(Math.round((a.value / 100) * a.n), a.n, Math.round((b.value / 100) * b.n), b.n);
  return { diff, p: r.p, test: "two-proportion z" };
}

/* ------------------------------------------------------------ composition */

/** raking (iterative proportional fitting) of `rows` to the target shares of each variable */
export function rake(rows: Record<string, unknown>[], targets: Record<string, Record<string, number>>, iterations = 50): number[] {
  const w = rows.map(() => 1);
  const vars = Object.keys(targets);
  for (let it = 0; it < iterations; it++) {
    let moved = 0;
    for (const v of vars) {
      const tot = w.reduce((a, x, i) => a + (rows[i][v] === null || rows[i][v] === undefined || rows[i][v] === "" ? 0 : x), 0);
      const have: Record<string, number> = {};
      rows.forEach((r, i) => { const c = r[v]; if (c === null || c === undefined || c === "") return; have[String(c)] = (have[String(c)] ?? 0) + w[i]; });
      rows.forEach((r, i) => {
        const c = r[v]; if (c === null || c === undefined || c === "") return;
        const target = targets[v][String(c)];
        if (target === undefined || !have[String(c)]) return;
        const f = (target * tot) / have[String(c)];
        moved = Math.max(moved, Math.abs(f - 1));
        w[i] *= f;
      });
    }
    if (moved < 1e-4) break;
  }
  const mean = w.reduce((a, b) => a + b, 0) / Math.max(1, w.length);
  return w.map((x) => Math.min(5, Math.max(0.2, x / (mean || 1))));
}
const sharesOf = (rows: Record<string, unknown>[], v: string): Record<string, number> => {
  const c: Record<string, number> = {}; let n = 0;
  for (const r of rows) { const x = r[v]; if (x === null || x === undefined || x === "") continue; c[String(x)] = (c[String(x)] ?? 0) + 1; n++; }
  return Object.fromEntries(Object.entries(c).map(([k, x]) => [k, x / Math.max(1, n)]));
};

export interface CompositionShift { variable: string; wave: string; p: number | null; largest: { code: string; base: number; wave: number } | null; shifted: boolean }
export function compositionShifts(base: Record<string, unknown>[], wave: Record<string, unknown>[], variables: string[], waveLabel: string): CompositionShift[] {
  return variables.map((v) => {
    const a = sharesOf(base, v), b = sharesOf(wave, v);
    const codes = [...new Set([...Object.keys(a), ...Object.keys(b)])];
    const count = (rows: Record<string, unknown>[], c: string) => rows.filter((r) => String(r[v]) === c).length;
    const table = [codes.map((c) => count(base, c)), codes.map((c) => count(wave, c))];
    const t = codes.length >= 2 ? chiSquare(table) : { p: null };
    const largest = codes.map((c) => ({ code: c, base: Math.round((a[c] ?? 0) * 1000) / 10, wave: Math.round((b[c] ?? 0) * 1000) / 10 })).sort((x, y) => Math.abs(y.wave - y.base) - Math.abs(x.wave - x.base))[0] ?? null;
    return { variable: v, wave: waveLabel, p: t.p, largest, shifted: t.p !== null && t.p < 0.05 && !!largest && Math.abs(largest.wave - largest.base) >= 5 };
  });
}

/* ------------------------------------------------------------ the comparison */

/** "p = 0.034" / "p < 0.001" */
export const pv = (p: number | null) => (p === null ? "p —" : p < 0.001 ? "p < 0.001" : `p = ${p.toFixed(3)}`);

export type ChangeVerdict = "genuine_change" | "composition" | "not_comparable" | "no_change" | "insufficient";
export interface KpiComparison { from: string; to: string; diff: number | null; p: number | null; test: string; adjustedDiff: number | null; adjustedP: number | null; verdict: ChangeVerdict; why: string }
export interface KpiTrack { kpi: TrackerKpi; points: KpiPoint[]; adjusted: KpiPoint[]; waveOnWave: KpiComparison[]; vsBaseline: KpiComparison[]; trend: { p: number | null; direction: string | null; test: string } | null; changes: string[] }
export interface TrackerReport {
  waves: { id: string; label: string; n: number }[];
  kpis: KpiTrack[];
  composition: CompositionShift[];
  segments: { kpi: string; segment: string; code: string; points: KpiPoint[] }[];
  recommendations: string[];
}

export interface TrackerConfig { kpis: TrackerKpi[]; composition?: string[]; segment?: string | null; alpha?: number }

export function trackWaves(waves: WaveData[], mappings: Record<string, WaveMapping>, cfg: TrackerConfig): TrackerReport {
  const alpha = cfg.alpha ?? 0.05;
  const ordered = [...waves].sort((a, b) => a.order - b.order);
  const base = ordered[0];
  const h = harmonize(ordered, mappings);
  const rowsOf = (id: string) => h.rows.filter((r) => r.__wave === id);
  const baseRows = rowsOf(base.id);
  const comp = (cfg.composition ?? []).filter((v) => h.variables.includes(v));
  const targets = Object.fromEntries(comp.map((v) => [v, sharesOf(baseRows, v)]));
  const weightsFor = (rows: Record<string, unknown>[], id: string) => (comp.length && id !== base.id ? rake(rows, targets) : undefined);
  const notComparable = (k: TrackerKpi, waveId: string) => { if (waveId === base.id) return null; const m = mappings[waveId]?.matches.find((x) => x.base === k.variable); return !m?.other ? "not asked in this wave" : !m.comparable ? m.changes.join("; ") : null; };
  const scaleMax = (k: TrackerKpi) => { const c = base.columns.find((x) => x.name === k.variable); const r = c ? numericRange(valuesOf(base, c)) : null; return r ? r[1] : undefined; };

  const kpis: KpiTrack[] = cfg.kpis.map((k) => {
    const max = scaleMax(k);
    const points: KpiPoint[] = ordered.map((w) => ({ wave: w.id, label: w.label, ...(notComparable(k, w.id) === "not asked in this wave" ? { value: null, n: 0, ci: null } : measureKpi(k, rowsOf(w.id), undefined, max)) }));
    const adjusted: KpiPoint[] = ordered.map((w) => { const rows = rowsOf(w.id); return { wave: w.id, label: w.label, ...(notComparable(k, w.id) === "not asked in this wave" ? { value: null, n: 0, ci: null } : measureKpi(k, rows, weightsFor(rows, w.id), max)) }; });
    const judge = (i: number, j: number): KpiComparison => {
      const a = points[i], b = points[j];
      const raw = comparePoints(k, a, b);
      const adj = comp.length ? comparePoints(k, adjusted[i], adjusted[j]) : raw;
      const nc = notComparable(k, ordered[j].id) ?? notComparable(k, ordered[i].id);
      let verdict: ChangeVerdict, why: string;
      if (raw.diff === null) { verdict = "insufficient"; why = "no data in one of the waves"; }
      else if (nc) { verdict = "not_comparable"; why = `the question changed — ${nc}`; }
      else if (comp.length) {
        const rawSig = raw.p !== null && raw.p < alpha, adjSig = adj.p !== null && adj.p < alpha;
        const on = comp.join(", ");
        if (rawSig && !adjSig) { verdict = "composition"; why = `significant as fielded (${pv(raw.p)}) but not once the samples are matched on ${on} (${pv(adj.p)}) — the samples differ, not the measure`; }
        else if (adjSig && !rawSig) { verdict = "genuine_change"; why = `hidden as fielded (${pv(raw.p)}) because the samples differ on ${on}; once they are matched the change is significant (${adj.test}, ${pv(adj.p)}, ${adj.diff !== null && adj.diff > 0 ? "+" : ""}${adj.diff})`; }
        else if (adjSig) { verdict = "genuine_change"; why = `significant (${raw.test}, ${pv(raw.p)}) and still after matching the samples on ${on} (${pv(adj.p)})`; }
        else { verdict = "no_change"; why = raw.p === null ? "not testable" : `within sampling error (${pv(raw.p)}; matched on ${on}: ${pv(adj.p)})`; }
      }
      else if (raw.p !== null && raw.p < alpha) { verdict = "genuine_change"; why = `significant (${raw.test}, ${pv(raw.p)})`; }
      else { verdict = "no_change"; why = raw.p === null ? "not testable" : `within sampling error (${pv(raw.p)})`; }
      return { from: ordered[i].label, to: ordered[j].label, diff: raw.diff, p: raw.p, test: raw.test, adjustedDiff: comp.length ? adj.diff : null, adjustedP: comp.length ? adj.p : null, verdict, why };
    };
    const waveOnWave = ordered.slice(1).map((_, k2) => judge(k2, k2 + 1));
    const vsBaseline = ordered.slice(1).map((_, k2) => judge(0, k2 + 1));
    let trend: KpiTrack["trend"] = null;
    if (ordered.length >= 3 && (k.measure === "share" || k.measure === "top_box")) {
      const ok = points.filter((p) => p.value !== null && p.n);
      const t = trendProportions(ok.map((p) => Math.round(((p.value ?? 0) / 100) * p.n)), ok.map((p) => p.n));
      trend = { p: t.p, direction: (t.detail as { direction?: string } | undefined)?.direction ?? null, test: "Cochran–Armitage trend" };
    }
    const changes = ordered.slice(1).flatMap((w) => { const m = mappings[w.id]?.matches.find((x) => x.base === k.variable); return m?.changes.length ? [`${w.label}: ${m.changes.join("; ")}`] : []; });
    return { kpi: k, points, adjusted, waveOnWave, vsBaseline, trend, changes };
  });

  const composition = ordered.slice(1).flatMap((w) => compositionShifts(baseRows, rowsOf(w.id), comp, w.label));
  const segments: TrackerReport["segments"] = [];
  if (cfg.segment && h.variables.includes(cfg.segment)) {
    const codes = Object.keys(sharesOf(baseRows, cfg.segment)).slice(0, 8);
    for (const k of cfg.kpis.slice(0, 6)) for (const code of codes) {
      segments.push({ kpi: k.id, segment: cfg.segment, code, points: ordered.map((w) => ({ wave: w.id, label: w.label, ...measureKpi(k, rowsOf(w.id).filter((r) => String(r[cfg.segment!]) === code), undefined, scaleMax(k)) })) });
    }
  }
  const recommendations = [
    `Line chart per KPI across the ${ordered.length} waves with 95 % intervals${ordered.length >= 3 ? "; the trend test (Cochran–Armitage) for shares" : ""}.`,
    ...(cfg.kpis.filter((k) => k.measure === "share").length >= 3 ? ["Funnel bars per wave (awareness → consideration → usage → preference) to show where conversion moved."] : []),
    "Wave-on-wave and vs-baseline significance: two-proportion z for shares and top-box, Welch's t for means, the NPS difference z for NPS.",
    ...(comp.length ? [`Each KPI also re-computed with every wave raked to the baseline's ${comp.join(" × ")} profile; a change that disappears after matching is sample composition.`] : ["Add the profile variables (age, gender, region…) as composition checks, so a change caused by a different sample is not read as brand performance."]),
    ...(cfg.segment ? [`Small multiples by ${cfg.segment} — segment bases are smaller; read only differences with n ≥ 50 per wave.`] : []),
    ...(kpis.some((t) => t.changes.length) ? ["Mark the waves where a KPI's question changed (a break in the line); do not test across the break."] : []),
  ];
  return { waves: ordered.map((w) => ({ id: w.id, label: w.label, n: w.rows.length })), kpis, composition, segments, recommendations };
}

/** the report as CSV (one row per KPI × wave): what a tracker deck is built from */
export function trackerCsv(r: TrackerReport): string {
  const esc = (v: unknown) => { const s = v === null || v === undefined ? "" : String(v); return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };
  const lines = [["KPI", "Measure", "Wave", "Value", "Base", "CI low", "CI high", "Adjusted value", "Change vs previous", "p (vs previous)", "Verdict vs previous", "Change vs baseline", "Verdict vs baseline"].join(",")];
  for (const t of r.kpis) t.points.forEach((p, i) => {
    const prev = i ? t.waveOnWave[i - 1] : null, vb = i ? t.vsBaseline[i - 1] : null;
    lines.push([t.kpi.label, t.kpi.measure, p.label, p.value, p.n, p.ci?.[0], p.ci?.[1], t.adjusted[i]?.value, prev?.diff, prev?.p?.toFixed(4), prev?.verdict, vb?.diff, vb?.verdict].map(esc).join(","));
  });
  return lines.join("\n");
}

/* ------------------------------------------------------------ reading a wave from a file */

export const WAVE_LIMITS = { rows: 20000, columns: 400 } as const;

/**
 * A parsed table (CSV / workbook rows) → a wave. Understands the two shapes trackers usually arrive in:
 *   · a second header row of question wording under the variable names (Qualtrics, Alchemer exports) — detected when
 *     most columns hold free text in row 1 and numbers below it, and removed from the data;
 *   · headers that carry both, "Q1 - Are you aware of…" or "Q1: Are you aware of…".
 * `dictionary` (from this survey's own variable dictionary) supplies labels and answer labels when known.
 */
export function waveFromTable(
  meta: { id: string; label: string; order: number; source?: "upload" | "survey" },
  headers: string[],
  rows: Record<string, unknown>[],
  dictionary: { name: string; label?: string; values?: { code: string; label: string }[] }[] = [],
): { wave: WaveData; notes: string[] } {
  const notes: string[] = [];
  let hs = headers.filter((h) => h && h.trim()).slice(0, WAVE_LIMITS.columns);
  if (headers.length > WAVE_LIMITS.columns) notes.push(`Only the first ${WAVE_LIMITS.columns} columns were kept.`);
  let data = rows;
  const labels: Record<string, string> = {};
  const isNum = (v: unknown) => v !== null && v !== undefined && v !== "" && Number.isFinite(Number(v));
  if (data.length >= 3) {
    const first = data[0];
    let wordy = 0, numericBelow = 0;
    for (const h of hs) {
      const v = first[h];
      if (typeof v === "string" && !isNum(v) && v.trim().split(/\s+/).length >= 2) {
        wordy++;
        if (data.slice(1, 21).filter((r) => isNum(r[h])).length >= Math.min(10, data.length - 1) * 0.6) numericBelow++;
      }
    }
    if (wordy >= hs.length * 0.5 && numericBelow >= 1) {
      for (const h of hs) if (typeof first[h] === "string" && String(first[h]).trim()) labels[h] = String(first[h]).trim();
      data = data.slice(1);
      /* Qualtrics adds a third row of import ids ({"ImportId":…}) */
      if (data.length && hs.filter((h) => /^\{.*importid/i.test(String(data[0][h] ?? ""))).length >= hs.length * 0.3) data = data.slice(1);
      notes.push("The row under the headers held question wording — read as labels, not as a respondent.");
    }
  }
  const renamed: Record<string, string> = {};
  hs = hs.map((h) => {
    const m = h.match(/^([A-Za-z][\w.]{0,40})\s*(?: - |: )\s*(.{3,})$/);
    if (!m) return h;
    renamed[h] = m[1];
    if (!labels[m[1]]) labels[m[1]] = m[2].trim();
    return m[1];
  });
  if (Object.keys(renamed).length) data = data.map((r) => { const o: Record<string, unknown> = { ...r }; for (const [from, to] of Object.entries(renamed)) { o[to] = r[from]; delete o[from]; } return o; });
  if (data.length > WAVE_LIMITS.rows) { notes.push(`Only the first ${WAVE_LIMITS.rows} rows were kept.`); data = data.slice(0, WAVE_LIMITS.rows); }
  const dict = new Map(dictionary.map((d) => [d.name, d]));
  const columns: WaveColumn[] = hs.map((name) => {
    const d = dict.get(name);
    return { name, ...(labels[name] || d?.label ? { label: labels[name] || d!.label } : {}), ...(d?.values?.length ? { values: d.values } : {}) };
  });
  const keep = new Set(hs);
  const clean = data.map((r) => { const o: Record<string, unknown> = {}; for (const k of keep) { const v = r[k]; o[k] = v === undefined ? null : v; } return o; }).filter((r) => Object.values(r).some((v) => v !== null && v !== ""));
  return { wave: { ...meta, columns, rows: clean }, notes };
}

import type { SurveyDefinition } from "@rescript/schema";
import { inferRole, segmentationQuestions, segmentVariableName } from "@rescript/engine";
import type { Dataset, VariableMeta } from "./dataset.js";
import { categoricalColumn, categoriesOf, numericColumn, labelOf, scaleCodes } from "./dataset.js";
import { chiSquare, oneWayAnova } from "./stats/tests.js";
import { quantile, weightedValues } from "./stats/descriptive.js";
import { MIN_BASE } from "./analyses/common.js";
import { adjustP, CORRECTION_WORDS, type CorrectionMethod } from "./posthoc.js";
import { strengthOf, type Finding, type Strength } from "./findings.js";

/**
 * FINDINGS BEYOND THE PLAN (Research Engine audit, Phase 4).
 *
 * The plan tests what the design said to test. A run can also LOOK: at
 * every outcome cut by every demographic the plan did not pair it with
 * (segment discovery), at the shape of each variable (anomalies — a scale
 * at its ceiling, a category almost nobody chose, outliers, missing
 * answers), and at the outcomes across the waves of fieldwork (trends).
 * What it finds is held to a higher bar than a planned test, because it
 * looked everywhere: the p-values of all the discoveries are corrected as
 * one family, and a difference counts only with an effect size to show
 * for it. Every discovery is a Finding like any other — same shape, same
 * evidence — marked by its kind (`segment`, `anomaly`, `trend`) and by
 * `analysis.planned` being absent.
 */
export interface Discoveries {
  segments: Finding[];
  anomalies: Finding[];
  trends: Finding[];
  /** what was looked at, for the record */
  looked: { outcomes: string[]; cuts: string[]; waves: { variable: string; buckets: string[] } | null; pairs: number };
  method: CorrectionMethod;
  summary: string;
}

const fmt = (x: number | null | undefined, d = 2) => (x == null || !Number.isFinite(x) ? "—" : x.toFixed(d));
const fmtP = (p: number | null | undefined) => (p == null ? "" : p < 0.001 ? "p < .001" : `p = ${p.toFixed(3).replace(/^0/, "")}`);
const pct = (x: number) => `${Math.round(x * 100)}%`;

const CEILING = 0.6;
const DOMINANT = 0.9;
const MISSING = 0.3;
const OUTLIERS = 0.02;
const WAVE_MIN = MIN_BASE;

/** a question's variable, or a derived score of one: never the system columns (`_duration`, `_quality_score` …) */
const usable = (v: VariableMeta) => !v.hidden && !v.name.startsWith("_") && v.role !== "system" && v.role !== "text" && v.role !== "complex" && v.role !== "date";
/** a column with no spread (an allocation's constant total, a one-answer question) has nothing to compare */
const varies = (xs: number[]) => xs.length >= 2 && xs.some((x) => x !== xs[0]);

/** the outcomes worth looking at: scale and numeric questions (and derived scores) that are not demographics or screeners */
function outcomeVariables(def: SurveyDefinition, ds: Dataset): VariableMeta[] {
  return ds.variables.filter((v) => {
    if (!usable(v) || (v.role !== "scale" && v.role !== "numeric" && v.role !== "categorical")) return false;
    if (v.derived) return v.role !== "categorical";
    const q = def.questions.find((x) => x.id === v.questionId);
    if (!q) return false;
    const role = inferRole(def, q);
    if (role === "segmentation" || role === "screening" || role === "control") return false;
    if (v.role === "categorical") return role === "dependent";
    return true;
  });
}

/** the cuts: the demographics and the plan's segments, categorical only */
function cutVariables(def: SurveyDefinition, ds: Dataset): VariableMeta[] {
  const demo = segmentationQuestions(def).map((q) => q.variableName);
  const segs = (def.research?.analysisPlan?.segments ?? []).map((s) => segmentVariableName(s));
  const names = [...new Set([...demo, ...segs])];
  return names.map((n) => ds.byName.get(n)).filter((v): v is VariableMeta => !!v && (v.role === "categorical" || v.role === "scale") && categoriesOf(ds, v.name).length >= 2 && categoriesOf(ds, v.name).length <= 12);
}

function plannedPairs(def: SurveyDefinition): Set<string> {
  const plan = def.research?.analysisPlan;
  const out = new Set<string>();
  const key = (a: string, b: string) => `${a}|${b}`;
  for (const x of plan?.crosstabs ?? []) for (const r of x.rows) for (const c of x.columns) out.add(key(r, c));
  for (const t of plan?.tests ?? []) { const y = t.outcome ?? t.variables[0]; const g = t.groupBy ?? t.variables[1]; if (y && g) out.add(key(y, g)); }
  return out;
}

function groupsOf(ds: Dataset, y: string, g: string): { label: string; values: number[] }[] {
  const cats = categoriesOf(ds, g);
  const yv = numericColumn(ds, y), gv = categoricalColumn(ds, g);
  const by = new Map<string, number[]>(cats.map((c) => [c.code, []]));
  yv.forEach((v, i) => { const c = gv[i]; if (v == null || c == null || Array.isArray(c)) return; by.get(c)?.push(v); });
  return cats.map((c) => ({ label: c.label, values: by.get(c.code) ?? [] })).filter((x) => x.values.length >= 2);
}
function table(ds: Dataset, a: string, b: string): { t: number[][]; rows: { label: string; shares: number[] }[]; cols: string[] } {
  const ca = categoriesOf(ds, a), cb = categoriesOf(ds, b);
  const av = categoricalColumn(ds, a), bv = categoricalColumn(ds, b);
  const t = ca.map(() => cb.map(() => 0));
  av.forEach((x, i) => { const y = bv[i]; if (x == null || y == null || Array.isArray(x) || Array.isArray(y)) return; const r = ca.findIndex((c) => c.code === x), c = cb.findIndex((c) => c.code === y); if (r >= 0 && c >= 0) t[r][c]++; });
  const colT = cb.map((_, j) => t.reduce((s, r) => s + r[j], 0));
  return { t, rows: ca.map((c, i) => ({ label: c.label, shares: cb.map((_, j) => (colT[j] ? t[i][j] / colT[j] : 0)) })), cols: cb.map((c) => c.label) };
}

type Raw = { id: string; headline: (pAdj: number | null) => string; detail?: string; p: number | null; effect?: { name: string; value: number }; n: number; variables: string[]; chart?: Finding["chart"]; groups?: Finding["evidence"]["groups"] };

const mk = (kind: Finding["kind"], r: Raw, pAdj: number | null, alpha: number, method: CorrectionMethod): Finding => {
  const strength = strengthOf(r.effect, pAdj ?? r.p, alpha);
  const significant = pAdj != null && pAdj < alpha;
  return {
    id: r.id, kind, strength, significant, headline: r.headline(pAdj), ...(r.detail ? { detail: r.detail } : {}),
    evidence: { ...(r.p != null ? { p: r.p } : {}), ...(pAdj != null ? { adjusted: { method, p: pAdj, significant, family: "discoveries" } } : {}), ...(r.effect ? { effect: r.effect } : {}), n: r.n, ...(r.groups ? { groups: r.groups } : {}) },
    variables: r.variables, hypotheses: [], analysis: { name: "Beyond the plan", kind, hash: r.id }, ...(r.chart ? { chart: r.chart } : {}),
  };
};

/** Every outcome by every cut the plan did not pair it with: the differences that hold after correction, with an effect to show. */
export function discoverSegments(def: SurveyDefinition, ds: Dataset, opts: { alpha?: number; method?: CorrectionMethod; max?: number } = {}): { findings: Finding[]; outcomes: string[]; cuts: string[]; pairs: number } {
  const alpha = opts.alpha ?? 0.05, method = opts.method ?? "holm";
  const outcomes = outcomeVariables(def, ds), cuts = cutVariables(def, ds);
  const skip = plannedPairs(def);
  const raws: Raw[] = [];
  for (const y of outcomes) for (const g of cuts) {
    if (y.name === g.name || skip.has(`${y.name}|${g.name}`) || skip.has(`${g.name}|${y.name}`)) continue;
    const vars = [y.name, g.name];
    if (y.role === "categorical") {
      const { t, rows, cols } = table(ds, y.name, g.name);
      const r = chiSquare(t);
      if (r.p == null) continue;
      const N = t.flat().reduce((a, b) => a + b, 0);
      // the row whose share differs most between its highest and lowest column
      const spread = rows.map((row) => ({ row, hi: Math.max(...row.shares), lo: Math.min(...row.shares), gap: Math.max(...row.shares) - Math.min(...row.shares) })).sort((a, b) => b.gap - a.gap)[0];
      const hiCol = spread ? cols[spread.row.shares.indexOf(spread.hi)] : "", loCol = spread ? cols[spread.row.shares.indexOf(spread.lo)] : "";
      raws.push({ id: `segment:${y.name}|${g.name}`, p: r.p, effect: r.effectSize && r.effectSize.value != null ? { name: r.effectSize.name, value: r.effectSize.value } : undefined, n: N, variables: vars, chart: "bar_stacked_100",
        headline: (pAdj) => `${labelOf(ds, y.name)} differs by ${labelOf(ds, g.name)}${spread ? `: “${spread.row.label}” is chosen by ${pct(spread.hi)} of ${hiCol} vs ${pct(spread.lo)} of ${loCol}` : ""} (chi-square, ${fmtP(pAdj)} ${CORRECTION_WORDS[method]}-adjusted${r.effectSize?.value != null ? `, ${r.effectSize.name} = ${fmt(r.effectSize.value)}` : ""}).` });
    } else {
      const groups = groupsOf(ds, y.name, g.name);
      if (groups.length < 2 || !varies(groups.flatMap((x) => x.values))) continue;
      const r = oneWayAnova(groups);
      if (r.p == null || !Number.isFinite(r.statistic ?? NaN)) continue;
      const means = groups.map((x) => ({ label: x.label, mean: x.values.reduce((a, b) => a + b, 0) / x.values.length, n: x.values.length })).sort((a, b) => b.mean - a.mean);
      const hi = means[0], lo = means[means.length - 1];
      raws.push({ id: `segment:${y.name}|${g.name}`, p: r.p, effect: r.effectSize && r.effectSize.value != null ? { name: r.effectSize.name, value: r.effectSize.value } : undefined, n: groups.reduce((s, x) => s + x.values.length, 0), variables: vars, chart: "bar_vertical", groups: means,
        headline: (pAdj) => `${labelOf(ds, y.name)} differs by ${labelOf(ds, g.name)}: ${hi.label} highest (${fmt(hi.mean)}), ${lo.label} lowest (${fmt(lo.mean)}) (ANOVA, ${fmtP(pAdj)} ${CORRECTION_WORDS[method]}-adjusted${r.effectSize?.value != null ? `, ${r.effectSize.name} = ${fmt(r.effectSize.value)}` : ""}).` });
    }
  }
  const adj = adjustP(raws.map((r) => r.p), method);
  const findings = raws.map((r, i) => mk("segment", r, adj[i], alpha, method)).filter((f) => f.significant && f.strength !== "none" && f.strength !== "weak")
    .sort((a, b) => (Math.abs(b.evidence.effect?.value ?? 0) - Math.abs(a.evidence.effect?.value ?? 0)) || ((a.evidence.adjusted?.p ?? 1) - (b.evidence.adjusted?.p ?? 1)))
    .slice(0, opts.max ?? 8);
  return { findings, outcomes: outcomes.map((v) => v.name), cuts: cuts.map((v) => v.name), pairs: raws.length };
}

/** The shape of each variable: ceilings and floors, a category almost everyone chose, thin categories, outliers, missing answers. */
export function findAnomalies(def: SurveyDefinition, ds: Dataset, opts: { max?: number } = {}): Finding[] {
  const out: Finding[] = [];
  const N = ds.cases.length;
  if (N < MIN_BASE) return out;
  const anomaly = (id: string, headline: string, variables: string[], n: number, detail?: string) => out.push({ id, kind: "anomaly", strength: "none", significant: false, headline, ...(detail ? { detail } : {}), evidence: { n }, variables, hypotheses: [], analysis: { name: "Beyond the plan", kind: "anomaly", hash: id } });
  for (const v of ds.variables.filter(usable)) {
    const q = def.questions.find((x) => x.id === v.questionId);
    if (!q && !v.derived) continue;
    const L = labelOf(ds, v.name);
    if (v.role === "scale" || v.role === "numeric") {
      const xs = numericColumn(ds, v.name);
      const vals = xs.filter((x): x is number => x != null);
      const missing = 1 - vals.length / N;
      if (missing >= MISSING) anomaly(`anomaly:missing:${v.name}`, `${L} is unanswered by ${pct(missing)} of respondents — a routing or a sensitive question worth checking.`, [v.name], vals.length);
      if (vals.length < MIN_BASE) continue;
      const codes = scaleCodes(ds, v.name);
      if (v.role === "scale" && codes.length >= 3) {
        const hi = Math.max(...codes), lo = Math.min(...codes);
        const top = vals.filter((x) => x === hi).length / vals.length, bottom = vals.filter((x) => x === lo).length / vals.length;
        if (top >= CEILING) anomaly(`anomaly:ceiling:${v.name}`, `${L} is at its ceiling: ${pct(top)} gave the top answer (${hi}) — the question does not discriminate; read it as a top-box share.`, [v.name], vals.length);
        else if (bottom >= CEILING) anomaly(`anomaly:floor:${v.name}`, `${L} is at its floor: ${pct(bottom)} gave the bottom answer (${lo}) — read it as a bottom-box share.`, [v.name], vals.length);
      } else if (v.role === "numeric" && new Set(vals).size > 10) {
        // a continuous measure only: a rank or a small integer scale has no tail to speak of
        const wv = weightedValues(vals).sort((a, b) => a.value - b.value);
        const q1 = quantile(wv, 0.25), q3 = quantile(wv, 0.75);
        if (q1 != null && q3 != null && q3 > q1) {
          const iqr = q3 - q1;
          const far = vals.filter((x) => x < q1 - 3 * iqr || x > q3 + 3 * iqr);
          if (far.length / vals.length >= OUTLIERS) anomaly(`anomaly:outliers:${v.name}`, `${L} has ${far.length} extreme values (${pct(far.length / vals.length)}, outside ${fmt(q1 - 3 * iqr, 0)}–${fmt(q3 + 3 * iqr, 0)}) — they pull the mean; the median (${fmt(quantile(wv, 0.5), 1)}) is the safer centre.`, [v.name], vals.length, `Range ${fmt(Math.min(...vals), 0)}–${fmt(Math.max(...vals), 0)}.`);
        }
      }
    } else if (v.role === "categorical") {
      const col = categoricalColumn(ds, v.name);
      const answered = col.filter((x) => x != null && !Array.isArray(x)) as string[];
      if (answered.length < MIN_BASE) continue;
      const cats = categoriesOf(ds, v.name);
      if (cats.length < 2) continue;
      const counts = cats.map((c) => ({ c, n: answered.filter((x) => x === c.code).length }));
      const top = [...counts].sort((a, b) => b.n - a.n)[0];
      // a multi-select's option column is "selected / not" by nature — nine in ten aware of a brand is a result, not an anomaly
      if (!v.optionCode && top.n / answered.length >= DOMINANT) anomaly(`anomaly:dominant:${v.name}`, `${L}: ${pct(top.n / answered.length)} answered “${top.c.label}” — there is almost no variation to analyse.`, [v.name], answered.length);
      const thin = counts.filter((x) => x.n > 0 && x.n < 5);
      if (thin.length && answered.length >= 100) anomaly(`anomaly:thin:${v.name}`, `${L}: ${thin.map((x) => `“${x.c.label}” (${x.n})`).join(", ")} ${thin.length === 1 ? "has" : "have"} fewer than five answers — too thin for a column or a cell; combine before cutting by it.`, [v.name], answered.length);
    }
  }
  return out.slice(0, opts.max ?? 10);
}

/** the wave variable: a question named wave, else the month of fieldwork, else the week — whichever has at least two buckets of a readable size */
export function waveVariable(def: SurveyDefinition, ds: Dataset): { variable: string; buckets: string[]; labels: string[] } | null {
  const candidates = [...def.questions.filter((q) => /\bwave\b/i.test(q.variableName) || /\bwave\b/i.test(String(q.code))).map((q) => q.variableName), "_started_month", "_started_week"];
  for (const name of candidates) {
    if (!ds.byName.has(name) && !ds.cases.some((c) => c.vars[name] != null)) continue;
    const counts = new Map<string, number>();
    for (const c of ds.cases) { const v = c.vars[name]; if (v == null || v === "") continue; const k = String(v); counts.set(k, (counts.get(k) ?? 0) + 1); }
    const buckets = [...counts.entries()].filter(([, n]) => n >= WAVE_MIN).map(([k]) => k).sort();
    if (buckets.length >= 2) {
      const cats = ds.byName.has(name) ? categoriesOf(ds, name) : [];
      return { variable: name, buckets, labels: buckets.map((b) => cats.find((c) => c.code === b)?.label ?? b) };
    }
  }
  return null;
}

/** Each outcome across the waves: the moves that hold after correction. */
export function waveTrends(def: SurveyDefinition, ds: Dataset, opts: { alpha?: number; method?: CorrectionMethod; max?: number } = {}): { findings: Finding[]; waves: { variable: string; buckets: string[] } | null } {
  const alpha = opts.alpha ?? 0.05, method = opts.method ?? "holm";
  const wave = waveVariable(def, ds);
  if (!wave) return { findings: [], waves: null };
  const outcomes = outcomeVariables(def, ds).filter((v) => v.role !== "categorical");
  const raws: Raw[] = [];
  for (const y of outcomes) {
    const yv = numericColumn(ds, y.name);
    const groups = wave.buckets.map((b, k) => ({ label: wave.labels[k], values: [] as number[] }));
    ds.cases.forEach((c, i) => { const v = yv[i]; const w = c.vars[wave.variable]; if (v == null || w == null) return; const k = wave.buckets.indexOf(String(w)); if (k >= 0) groups[k].values.push(v); });
    const kept = groups.filter((g) => g.values.length >= 2);
    if (kept.length < 2 || !varies(kept.flatMap((g) => g.values))) continue;
    const r = oneWayAnova(kept);
    if (r.p == null || !Number.isFinite(r.statistic ?? NaN)) continue;
    const means = kept.map((g) => ({ label: g.label, mean: g.values.reduce((a, b) => a + b, 0) / g.values.length, n: g.values.length }));
    const first = means[0], last = means[means.length - 1];
    const dir = last.mean > first.mean ? "rose" : last.mean < first.mean ? "fell" : "moved";
    raws.push({ id: `trend:${y.name}`, p: r.p, effect: r.effectSize && r.effectSize.value != null ? { name: r.effectSize.name, value: r.effectSize.value } : undefined, n: means.reduce((s, m) => s + m.n, 0), variables: [y.name, wave.variable], chart: "wave_trend", groups: means,
      headline: (pAdj) => `${labelOf(ds, y.name)} ${dir} across the waves: ${first.label} ${fmt(first.mean)} → ${last.label} ${fmt(last.mean)}${means.length > 2 ? ` (${means.map((m) => fmt(m.mean)).join(" → ")})` : ""} (ANOVA across ${means.length} waves, ${fmtP(pAdj)} ${CORRECTION_WORDS[method]}-adjusted).` });
  }
  const adj = adjustP(raws.map((r) => r.p), method);
  const findings = raws.map((r, i) => mk("trend", r, adj[i], alpha, method)).filter((f) => f.significant).sort((a, b) => (a.evidence.adjusted?.p ?? 1) - (b.evidence.adjusted?.p ?? 1)).slice(0, opts.max ?? 6);
  return { findings, waves: { variable: wave.variable, buckets: wave.buckets } };
}

/** All three, with what was looked at and a one-line summary. */
export function synthesize(def: SurveyDefinition, ds: Dataset, opts: { alpha?: number; method?: CorrectionMethod } = {}): Discoveries {
  const method = opts.method ?? "holm";
  const seg = discoverSegments(def, ds, opts);
  const anomalies = findAnomalies(def, ds);
  const tr = waveTrends(def, ds, opts);
  const parts = [seg.findings.length ? `${seg.findings.length} segment difference${seg.findings.length === 1 ? "" : "s"} the plan did not test` : "", anomalies.length ? `${anomalies.length} data anomal${anomalies.length === 1 ? "y" : "ies"}` : "", tr.findings.length ? `${tr.findings.length} trend${tr.findings.length === 1 ? "" : "s"} across waves` : ""].filter(Boolean);
  const summary = parts.length ? `Beyond the plan: ${parts.join(", ")} (${seg.pairs} outcome × cut pairs looked at${tr.waves ? `, ${tr.waves.buckets.length} waves` : ""}; p-values ${CORRECTION_WORDS[method]}-adjusted).`
    : `Beyond the plan: nothing notable in ${seg.pairs} outcome × cut pairs${tr.waves ? ` or across ${tr.waves.buckets.length} waves` : ""}; no data anomalies.`;
  return { segments: seg.findings, anomalies, trends: tr.findings, looked: { outcomes: seg.outcomes, cuts: seg.cuts, waves: tr.waves, pairs: seg.pairs }, method, summary };
}

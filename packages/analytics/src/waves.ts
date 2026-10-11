import type { SurveyDefinition } from "@rescript/schema";
import { categoricalColumn, categoriesOf, numericColumn, scaleCodes, weights, type Dataset } from "./dataset.js";
import { boxShares, describe } from "./stats/descriptive.js";
import { proportionTest } from "./stats/tests.js";
import { tCdf } from "./stats/distributions.js";
import { npsOf } from "./analyses/business.js";
import type { AnalysisRun, Finding, HypothesisVerdict } from "./findings.js";

/**
 * WAVES ACROSS RUNS (Phase 8).
 *
 * Phase 4's `waveTrends` reads one run: the fieldwork periods inside one
 * dataset. A tracker is also run again — the next wave, the next milestone —
 * and the question then is what moved since last time. This module gives each
 * run a KPI snapshot (every KPI of the research design, measured as the design
 * says on the run's own dataset) and compares a run with the previous
 * comparable one: the KPIs with their deltas and whether the move is
 * significant on the two samples, the planned findings matched by what they
 * test (stronger, weaker, reversed, new, gone), the verdicts that changed. The
 * comparison is attached to the run (`since`), so the Findings tab, the brief
 * the model reads, the report and the deck all tell the same story.
 */

export interface KpiSnapshot {
  name: string;
  variable?: string;
  /** what was measured: top-2-box share, mean, NPS, share (of an option), or why nothing could be */
  measure: string;
  value: number | null;
  /** valid answers the value rests on */
  n: number;
  /** the standard deviation, for a mean — what the comparison's test needs */
  sd?: number;
  target?: string;
  direction?: "higher" | "lower";
}

const r1 = (x: number) => Math.round(x * 10) / 10;

/** the KPI's measure on this dataset — the design's word first, else what the variable allows */
function measureKpi(ds: Dataset, variable: string, measure: string | undefined): Omit<KpiSnapshot, "name" | "variable" | "target" | "direction"> {
  const meta = ds.byName.get(variable);
  if (!meta) return { measure: "not in this run's data", value: null, n: 0 };
  const w = weights(ds);
  const want = (measure ?? "").toLowerCase();
  const codes = scaleCodes(ds, variable);
  const nums = numericColumn(ds, variable);
  const valid = nums.filter((v): v is number => typeof v === "number" && Number.isFinite(v));
  if (/nps/.test(want) || meta.questionType === "nps") {
    const b = npsOf(nums, w);
    return { measure: "NPS", value: b.nps === null ? null : r1(b.nps), n: b.n };
  }
  const box = /top[-\s]?(\d)|top\s*box/i.exec(want);
  if (box || (!want && codes.length >= 3 && !/mean|average/.test(want))) {
    const k = box?.[1] ? Number(box[1]) : /top\s*box/i.test(want) ? 1 : 2;
    if (codes.length >= Math.max(2, k)) { const s = boxShares(nums, w, codes, [k]); const v = s[`top${k}`]; return { measure: `top-${k}-box share`, value: v === undefined ? null : r1(v), n: s.n }; }
  }
  const share = /share|%|percent|proportion/.test(want) && !box;
  if (share) {
    // "share Yes", "% selecting Brand A": the option named after the word, else the first option
    const cats = categoriesOf(ds, variable);
    const named = want.replace(/^(?:share|%|percent(?:age)?|proportion)\s*(?:of|selecting|choosing|saying|who)?\s*/i, "").trim();
    const opt = cats.find((c) => c.label.toLowerCase() === named || c.code.toLowerCase() === named) ?? cats.find((c) => named && c.label.toLowerCase().includes(named)) ?? cats[0];
    if (opt) {
      const col = categoricalColumn(ds, variable);
      let hit = 0, base = 0;
      col.forEach((v, i) => { if (v === null || v === undefined) return; const wi = w?.[i] ?? 1; base += wi; if (Array.isArray(v) ? v.includes(opt.code) : v === opt.code) hit += wi; });
      return { measure: `share ${opt.label}`, value: base ? r1((hit / base) * 100) : null, n: col.filter((v) => v !== null && v !== undefined).length };
    }
  }
  if (valid.length) { const d = describe(nums, w); return { measure: "mean", value: d.mean === null ? null : Math.round(d.mean * 100) / 100, n: d.n, ...(d.sd !== null && d.sd !== undefined ? { sd: d.sd } : {}) }; }
  return { measure: "no numeric answers", value: null, n: 0 };
}

/** every KPI of the design, measured on this dataset */
export function kpiSnapshot(def: SurveyDefinition, ds: Dataset): KpiSnapshot[] {
  const kpis = def.research?.kpis ?? [];
  return kpis.map((k) => {
    if (!k.variable) return { name: k.name, measure: "no variable", value: null, n: 0, ...(k.target ? { target: k.target } : {}), ...(k.direction ? { direction: k.direction } : {}) };
    return { name: k.name, variable: k.variable, ...measureKpi(ds, k.variable, k.measure), ...(k.target ? { target: k.target } : {}), ...(k.direction ? { direction: k.direction } : {}) };
  });
}

/* ------------------------------------------------------------ the comparison */

export interface KpiDelta {
  name: string;
  measure: string;
  from: number | null;
  to: number | null;
  /** to − from, in the measure's unit (points of share, scale points, NPS points) */
  delta: number | null;
  /** the move's significance on the two samples, when both are large enough */
  p?: number;
  significant?: boolean;
  /** better / worse reads the KPI's direction (higher is better unless the design says lower); flat when it did not move */
  verdict: "better" | "worse" | "flat" | "unknown";
  n: { from: number; to: number };
}

export interface FindingChange {
  /** what the finding tests — the plan item and its variables */
  key: string;
  headline: string;
  change: "new" | "stronger" | "weaker" | "reversed" | "same";
  from?: { strength: Finding["strength"]; significant: boolean; effect?: number; p?: number };
  to: { strength: Finding["strength"]; significant: boolean; effect?: number; p?: number };
  hypotheses: string[];
}

export interface VerdictChange { label: string; text: string; from: HypothesisVerdict["verdict"]; to: HypothesisVerdict["verdict"] }

export interface WaveComparison {
  previous: { id?: string; computedAt: string; n: number; trigger: string };
  kpis: KpiDelta[];
  findings: FindingChange[];
  /** findings the previous run had that this one does not (the test was not run, or the finding did not reach the list) */
  gone: { key: string; headline: string }[];
  verdicts: VerdictChange[];
  summary: string;
}

export type RunForWaves = Pick<AnalysisRun, "computedAt" | "n" | "trigger" | "findings" | "verdicts"> & { id?: string; kpis?: KpiSnapshot[] };

const STRENGTH_RANK: Record<Finding["strength"], number> = { none: 0, weak: 1, moderate: 2, strong: 3 };

/** a finding's identity across runs: the plan item it came from and the variables it reads — never its hash, which the dataset spec is part of */
export function findingKey(f: Finding): string {
  const planned = f.analysis.planned ? `plan:${f.analysis.planned}` : f.analysis.name === "Beyond the plan" ? `beyond:${f.id}` : `name:${f.analysis.name}`;
  return `${f.kind}|${planned}|${[...f.variables].sort().join("+")}`;
}

const effectOf = (f: Finding) => (typeof f.evidence.effect?.value === "number" ? Math.abs(f.evidence.effect.value) : undefined);

function kpiTest(from: KpiSnapshot, to: KpiSnapshot): { p: number; significant: boolean } | null {
  if (from.value === null || to.value === null || from.n < 30 || to.n < 30) return null;
  if (/share|box|NPS/.test(to.measure)) {
    // shares in points of 100; NPS is promoters − detractors, compared as the share of the whole it is not — use the share test on the nearest proportion
    const p1 = Math.min(Math.max((/NPS/.test(to.measure) ? (from.value + 100) / 2 : from.value) / 100, 0), 1);
    const p2 = Math.min(Math.max((/NPS/.test(to.measure) ? (to.value + 100) / 2 : to.value) / 100, 0), 1);
    const t = proportionTest(Math.round(p1 * from.n), from.n, Math.round(p2 * to.n), to.n);
    return t.p === null ? null : { p: t.p, significant: t.p < 0.05 };
  }
  if (to.measure === "mean" && from.sd !== undefined && to.sd !== undefined) {
    // Welch's t from the two samples' summaries — the previous run's answers are not here, its mean, sd and n are
    const v1 = (from.sd ** 2) / from.n, v2 = (to.sd ** 2) / to.n;
    if (!(v1 + v2 > 0)) return null;
    const t = (to.value - from.value) / Math.sqrt(v1 + v2);
    const df = (v1 + v2) ** 2 / (v1 ** 2 / (from.n - 1) + v2 ** 2 / (to.n - 1));
    const p = 2 * (1 - tCdf(Math.abs(t), df));
    return { p, significant: p < 0.05 };
  }
  return null;
}

/** what moved since the previous comparable run */
export function compareRuns(current: RunForWaves, previous: RunForWaves): WaveComparison {
  const kpis: KpiDelta[] = (current.kpis ?? []).map((k) => {
    const was = (previous.kpis ?? []).find((p) => p.name === k.name && p.measure === k.measure);
    const from = was?.value ?? null;
    const delta = from !== null && k.value !== null ? Math.round((k.value - from) * 100) / 100 : null;
    const test = was ? kpiTest(was, k) : null;
    const moved = delta !== null && Math.abs(delta) >= 0.05;
    const better = k.direction === "lower" ? (delta ?? 0) < 0 : (delta ?? 0) > 0;
    return { name: k.name, measure: k.measure, from, to: k.value, delta, ...(test ? { p: test.p, significant: test.significant } : {}), verdict: delta === null ? "unknown" : !moved ? "flat" : better ? "better" : "worse", n: { from: was?.n ?? 0, to: k.n } };
  });
  const prevBy = new Map(previous.findings.map((f) => [findingKey(f), f]));
  const seen = new Set<string>();
  const findings: FindingChange[] = current.findings.filter((f) => !["inconclusive", "low_base", "anomaly"].includes(f.kind)).map((f) => {
    const key = findingKey(f);
    seen.add(key);
    const was = prevBy.get(key);
    const to = { strength: f.strength, significant: f.significant, ...(effectOf(f) !== undefined ? { effect: effectOf(f) } : {}), ...(typeof f.evidence.p === "number" ? { p: f.evidence.p } : {}) };
    if (!was) return { key, headline: f.headline, change: "new", to, hypotheses: f.hypotheses };
    const from = { strength: was.strength, significant: was.significant, ...(effectOf(was) !== undefined ? { effect: effectOf(was) } : {}), ...(typeof was.evidence.p === "number" ? { p: was.evidence.p } : {}) };
    let change: FindingChange["change"] = "same";
    if (was.evidence.direction && f.evidence.direction && was.evidence.direction !== f.evidence.direction && f.significant && was.significant) change = "reversed";
    else if (STRENGTH_RANK[f.strength] > STRENGTH_RANK[was.strength] || (f.significant && !was.significant)) change = "stronger";
    else if (STRENGTH_RANK[f.strength] < STRENGTH_RANK[was.strength] || (!f.significant && was.significant)) change = "weaker";
    return { key, headline: f.headline, change, from, to, hypotheses: f.hypotheses };
  });
  const gone = previous.findings.filter((f) => !["inconclusive", "low_base", "anomaly"].includes(f.kind) && !seen.has(findingKey(f))).map((f) => ({ key: findingKey(f), headline: f.headline }));
  const verdicts: VerdictChange[] = current.verdicts.flatMap((v) => { const was = previous.verdicts.find((p) => p.label === v.label); return was && was.verdict !== v.verdict ? [{ label: v.label, text: v.text, from: was.verdict, to: v.verdict }] : []; });
  const moved = kpis.filter((k) => k.verdict === "better" || k.verdict === "worse");
  const sig = moved.filter((k) => k.significant);
  const changed = findings.filter((f) => f.change !== "same");
  const parts = [
    `Since the previous run (${previous.computedAt.slice(0, 10)}, ${previous.n} completes → ${current.n})`,
    kpis.length ? (moved.length ? `${moved.length} of ${kpis.length} KPI${kpis.length === 1 ? "" : "s"} moved${sig.length ? ` (${sig.length} significantly)` : " (none significantly)"}: ${moved.map((k) => `${k.name} ${k.delta! > 0 ? "+" : ""}${k.delta}${/share|box/.test(k.measure) ? " pts" : ""}`).join(", ")}` : `${kpis.length} KPI${kpis.length === 1 ? "" : "s"} unchanged`) : "no KPIs in the design",
    changed.length ? `${changed.length} finding${changed.length === 1 ? "" : "s"} changed (${["new", "stronger", "weaker", "reversed"].map((c) => { const n = changed.filter((f) => f.change === c).length; return n ? `${n} ${c}` : ""; }).filter(Boolean).join(", ")})` : "the planned findings stand",
    verdicts.length ? `${verdicts.length} verdict${verdicts.length === 1 ? "" : "s"} changed: ${verdicts.map((v) => `${v.label} ${v.from} → ${v.to}`).join(", ")}` : "",
  ].filter(Boolean);
  return { previous: { ...(previous.id ? { id: previous.id } : {}), computedAt: previous.computedAt, n: previous.n, trigger: previous.trigger }, kpis, findings, gone, verdicts, summary: `${parts.join(" · ")}.` };
}

/** the numbers the comparison prints — what a narrative may cite */
export function waveNumbers(c: WaveComparison): number[] {
  const out: number[] = [c.previous.n];
  for (const k of c.kpis) for (const v of [k.from, k.to, k.delta]) if (typeof v === "number") out.push(v, Math.abs(v));
  return out;
}

/** the comparison in lines, for the brief the model reads and the report's "since the last wave" */
export function describeSince(c: WaveComparison, max = 8): string[] {
  const lines = [c.summary];
  for (const k of c.kpis) if (k.verdict !== "unknown") lines.push(`  KPI ${k.name} (${k.measure}): ${k.from} → ${k.to}${k.delta !== null ? ` (${k.delta > 0 ? "+" : ""}${k.delta})` : ""}${k.significant === true ? ", significant" : k.significant === false ? ", not significant" : ""} — ${k.verdict}`);
  for (const f of c.findings.filter((x) => x.change !== "same").slice(0, max)) lines.push(`  ${f.change.toUpperCase()}: ${f.headline}${f.from ? ` (was ${f.from.significant ? f.from.strength : "ns"}, now ${f.to.significant ? f.to.strength : "ns"})` : ""}`);
  for (const v of c.verdicts) lines.push(`  ${v.label}: ${v.from} → ${v.to}`);
  if (c.gone.length) lines.push(`  No longer found: ${c.gone.slice(0, 3).map((g) => g.headline).join("; ")}${c.gone.length > 3 ? ` (+${c.gone.length - 3})` : ""}`);
  return lines;
}

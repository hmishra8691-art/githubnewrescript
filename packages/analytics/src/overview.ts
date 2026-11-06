/**
 * THE EXECUTIVE OVERVIEW (Analytics upgrade 2026-11-06, M2) — what a reader who is not a statistician needs
 * first, built from the run and nothing else.
 *
 *   key findings    the strongest findings that HOLD (significant after the run's correction), one per relation,
 *                   each with a title in research terms, a plain-language explanation, the evidence line, the chart
 *                   the engine recommends, and why it matters (the hypothesis it bears on, or the objective)
 *   hypotheses      every verdict, in words
 *   correlations    the correlation findings, strongest first
 *   beyond the plan the run's discoveries (segments, trends, anomalies)
 *   kpis            the design's KPIs as the run measured them
 *   caveats         the run's warnings, and the base size when it is small
 *
 * Nothing here is written by a language model. The executive summary is the engine's (findingsReport); a model
 * may polish it elsewhere, through the gate. A finding that does not hold is never a key finding.
 */
import type { SurveyDefinition } from "@rescript/schema";
import type { ChartType } from "./types.js";
import type { AnalysisRun, Finding, HypothesisVerdict, Verdict } from "./findings.js";
import { dedupeFindings, holds } from "./findings.js";
import type { Discoveries } from "./synthesis.js";
import type { KpiSnapshot } from "./waves.js";
import { looksTechnical } from "./catalogue.js";

export type OverviewRun = Pick<AnalysisRun, "computedAt" | "trigger" | "environment" | "n" | "findings" | "verdicts" | "warnings"> & { discoveries?: Discoveries | null; kpis?: KpiSnapshot[] | null };

export interface KeyFinding {
  id: string;
  title: string;
  /** the plain-language reading — association, never causation */
  plain: string;
  /** the evidence in one line: test, statistic, p, effect, n */
  evidence: string;
  strength: Finding["strength"];
  chart: ChartType;
  /** why it matters to the study: the hypothesis it bears on, or the objective */
  why: string;
  hypotheses: string[];
  /** where to drill down: the saved analysis, or the planned item */
  analysisId: string | null;
  planned: string | null;
  analysisName: string;
  kind: Finding["kind"];
}

export interface OverviewVerdict { label: string; text: string; verdict: Verdict; word: string; reason: string; findings: number }

export interface Overview {
  run: { computedAt: string; trigger: string; environment: string; n: number } | null;
  objective: string | null;
  decision: string | null;
  keyFindings: KeyFinding[];
  hypotheses: OverviewVerdict[];
  hypothesisCounts: Record<Verdict, number>;
  correlations: KeyFinding[];
  beyondThePlan: { summary: string; items: { kind: string; headline: string }[] } | null;
  kpis: { name: string; measure: string; value: number | null; n: number; target?: string }[];
  caveats: string[];
  /** how many findings the run made, and how many hold */
  counts: { findings: number; holding: number; significant: number };
}

export const VERDICT_WORD: Record<Verdict, string> = { supported: "Supported", not_supported: "Not supported", mixed: "Mixed", inconclusive: "Inconclusive", untested: "Untested" };

const TEST_WORD: Record<string, string> = {
  chi_square: "chi-square", fisher: "Fisher's exact", t_independent: "t-test", t_paired: "paired t-test", t_one_sample: "one-sample t-test", anova_one_way: "one-way ANOVA", mann_whitney: "Mann-Whitney U", wilcoxon: "Wilcoxon", kruskal_wallis: "Kruskal-Wallis", friedman: "Friedman", proportion: "test of proportions", pearson: "Pearson correlation", spearman: "Spearman correlation", kendall: "Kendall correlation", regression: "regression", logistic: "logistic regression",
};
const fmtP = (p: number | null | undefined) => (p == null ? "" : p < 0.001 ? "p < 0.001" : `p = ${p.toFixed(3)}`);
const fmtN = (n: number) => n.toLocaleString("en-US");

/** the evidence of a finding in one line, exactly as the run holds it */
export function evidenceLine(f: Finding): string {
  const e = f.evidence;
  const parts: string[] = [];
  if (e.test) parts.push(TEST_WORD[e.test] ?? e.test.replace(/_/g, " "));
  if (e.statistic != null && Number.isFinite(e.statistic)) parts.push(`statistic ${Math.abs(e.statistic) >= 100 ? e.statistic.toFixed(0) : e.statistic.toFixed(2)}${e.df != null ? ` (df ${Array.isArray(e.df) ? e.df.join(", ") : e.df})` : ""}`);
  const p = fmtP(e.p); if (p) parts.push(p);
  if (e.adjusted) parts.push(`adjusted ${fmtP(e.adjusted.p)} (${e.adjusted.method})`);
  if (e.effect) parts.push(`${e.effect.name} = ${Math.abs(e.effect.value) < 10 ? e.effect.value.toFixed(2) : e.effect.value.toFixed(1)}`);
  parts.push(`n = ${fmtN(e.n)}`);
  return parts.join(" · ");
}

/** the finding's headline, read for a non-statistician: what relates to what, with the caution that it is an association */
export function plainReading(f: Finding): string {
  const h = f.headline.trim().replace(/\s+/g, " ");
  const base = /[.!?]$/.test(h) ? h : `${h}.`;
  const strength = f.strength === "strong" ? "a strong" : f.strength === "moderate" ? "a moderate" : f.strength === "weak" ? "a weak" : "no clear";
  switch (f.kind) {
    case "difference": return `${base} The groups differ on this measure — ${strength} difference in the data, not a cause.`;
    case "no_difference": return `${base} The data gives no reason to think the groups differ on this measure.`;
    case "correlation": return `${base} The two move together — ${strength} association; the data cannot say that one causes the other.`;
    case "no_correlation": return `${base} The two do not move together in any clear way.`;
    case "driver": return `${base} Holding the other predictors constant, this one is associated with the outcome — a statistical driver, not a proven cause.`;
    case "no_driver": return `${base} With the other predictors in the model, this one adds nothing clear.`;
    case "mediation": return `${base} Part of the relation appears to run through the mediator; this is a model's reading of associations, not an experiment.`;
    case "low_base": return `${base} Too few respondents to say anything reliable here.`;
    case "inconclusive": return `${base} The evidence does not settle it either way.`;
    default: return base;
  }
}

function titleOf(f: Finding): string {
  const name = f.analysis.name;
  if (name && !looksTechnical(name)) return name;
  const h = f.headline.replace(/\s*\(.*$/, "").replace(/[.:]\s*$/, "");
  return h.length > 90 ? `${h.slice(0, 87).replace(/\s+\S*$/, "")}…` : h;
}

function whyOf(f: Finding, def: SurveyDefinition, verdicts: readonly HypothesisVerdict[]): string {
  const r = def.research;
  if (f.hypotheses.length) {
    const v = verdicts.filter((x) => f.hypotheses.includes(x.label));
    const named = v.length ? v.map((x) => `${x.label} (${x.text.replace(/[.]$/, "")}) — ${VERDICT_WORD[x.verdict].toLowerCase()}`).join("; ") : f.hypotheses.join(", ");
    return `Bears on ${named}.`;
  }
  const kpi = (r?.kpis ?? []).find((k) => k.variable && f.variables.includes(k.variable));
  if (kpi) return `It moves the KPI “${kpi.name}”${kpi.target ? ` (target: ${kpi.target})` : ""}.`;
  if (r?.brief?.decision) return `Informs the decision: ${r.brief.decision.replace(/[.]$/, "")}.`;
  if (r?.objective) return `Part of the objective: ${r.objective.replace(/[.]$/, "")}.`;
  return "Found beyond any planned hypothesis — worth a look, not yet a conclusion.";
}

function keyFinding(f: Finding, def: SurveyDefinition, verdicts: readonly HypothesisVerdict[]): KeyFinding {
  return {
    id: f.id, title: titleOf(f), plain: plainReading(f), evidence: evidenceLine(f), strength: f.strength, chart: f.chart ?? "bar_vertical",
    why: whyOf(f, def, verdicts), hypotheses: f.hypotheses, analysisId: f.analysis.id ?? null, planned: f.analysis.planned ?? null, analysisName: f.analysis.name, kind: f.kind,
  };
}

const STRENGTH_RANK: Record<Finding["strength"], number> = { strong: 0, moderate: 1, weak: 2, none: 3 };

export function buildOverview(def: SurveyDefinition, run: OverviewRun | null, opts: { maxFindings?: number } = {}): Overview {
  const r = def.research;
  const objective = r?.objective?.trim() || null;
  const decision = r?.brief?.decision?.trim() || null;
  if (!run) {
    return { run: null, objective, decision, keyFindings: [], hypotheses: [], hypothesisCounts: { supported: 0, not_supported: 0, mixed: 0, inconclusive: 0, untested: 0 }, correlations: [], beyondThePlan: null, kpis: [], caveats: [], counts: { findings: 0, holding: 0, significant: 0 } };
  }
  const max = opts.maxFindings ?? 6;
  const all = dedupeFindings(run.findings);
  const holding = all.filter(holds).filter((f) => f.kind !== "low_base" && f.kind !== "inconclusive");
  const ranked = [...holding].sort((a, b) => STRENGTH_RANK[a.strength] - STRENGTH_RANK[b.strength] || (a.evidence.p ?? 1) - (b.evidence.p ?? 1) || b.evidence.n - a.evidence.n);
  const keyFindings = ranked.filter((f) => f.kind !== "correlation").slice(0, max).map((f) => keyFinding(f, def, run.verdicts));
  const correlations = ranked.filter((f) => f.kind === "correlation").slice(0, 4).map((f) => keyFinding(f, def, run.verdicts));
  const hypotheses: OverviewVerdict[] = run.verdicts.map((v) => ({ label: v.label, text: v.text, verdict: v.corrected?.verdict ?? v.verdict, word: VERDICT_WORD[v.corrected?.verdict ?? v.verdict], reason: v.corrected?.note ? `${v.reason} ${v.corrected.note}` : v.reason, findings: v.findings.filter(holds).length }));
  const hypothesisCounts: Record<Verdict, number> = { supported: 0, not_supported: 0, mixed: 0, inconclusive: 0, untested: 0 };
  for (const h of hypotheses) hypothesisCounts[h.verdict]++;
  const d = run.discoveries ?? null;
  const beyondThePlan = d ? { summary: d.summary, items: [...d.segments, ...d.trends, ...d.anomalies].filter(holds).slice(0, 5).map((f) => ({ kind: f.kind, headline: f.headline })) } : null;
  const kpis = (run.kpis ?? []).map((k) => ({ name: k.name, measure: k.measure, value: k.value, n: k.n, ...(r?.kpis?.find((x) => x.name === k.name)?.target ? { target: r!.kpis.find((x) => x.name === k.name)!.target! } : {}) }));
  const caveats = [...run.warnings];
  if (run.n < 30) caveats.unshift(`Only ${run.n} completes: nothing here is conclusive yet.`);
  else if (run.n < 100) caveats.unshift(`${run.n} completes: differences need to be large to show; small groups may not test.`);
  return {
    run: { computedAt: run.computedAt, trigger: run.trigger, environment: run.environment, n: run.n }, objective, decision,
    keyFindings, hypotheses, hypothesisCounts, correlations, beyondThePlan, kpis, caveats,
    counts: { findings: all.length, holding: holding.length, significant: all.filter((f) => f.significant).length },
  };
}

import type { SurveyDefinition } from "@rescript/schema";
import { hypothesisLabel } from "@rescript/schema";
import type { AnalysisDefinition, AnalysisResult, ChartType, DatasetSpec } from "./types.js";
import type { Dataset } from "./dataset.js";
import type { TestResult } from "./stats/tests.js";
import { runAnalysis } from "./analyses/index.js";
import { MIN_BASE } from "./analyses/common.js";
import { recommendCharts } from "./recommend.js";
import { plannedAnalyses, type PlannedAnalysis } from "./planBridge.js";
import { withPlannedVariables } from "./plannedVariables.js";
import { describeSince, kpiSnapshot, type KpiSnapshot, type WaveComparison } from "./waves.js";
import { buildAnalysisFramework, parseHypothesis, structuredHypotheses } from "@rescript/engine";
import { adjustP, pairwiseComparisons, CORRECTION_WORDS, type CorrectionMethod, type PairwiseResult } from "./posthoc.js";
import { adviseAnalysis, adviceSummary, type DataAdvice } from "./dataAdvice.js";
import { synthesize, type Discoveries } from "./synthesis.js";

/*
 * FINDINGS (research-intelligence Phase 5): what the data SAID, read from the
 * results structurally — the tests' p-values and effect sizes, the model's
 * coefficients, the correlation, the NPS — never from the insight sentences,
 * and never invented. Each finding carries its evidence (test, statistic,
 * p, effect, n) so every headline traces to a table; the hypotheses are
 * judged from the findings of the analyses planned for them; a run is the
 * whole plan executed once on one dataset, with the findings ranked and the
 * verdicts given, ready for the copilot to narrate and the Studio to show.
 *
 * Everything here is pure: a Dataset in, a run out. The Studio stores runs
 * and decides when to make them (a milestone of fieldwork, or on request).
 */

export type FindingKind = "difference" | "no_difference" | "driver" | "no_driver" | "correlation" | "no_correlation" | "mediation" | "nps" | "topbox" | "reliability" | "low_base" | "inconclusive"
  /** beyond the plan (Phase 4): a segment difference the plan did not test, a data anomaly, a move across waves */
  | "segment" | "anomaly" | "trend";
export type Strength = "strong" | "moderate" | "weak" | "none";

export interface FindingEvidence {
  test?: string; statistic?: number | null; df?: number | [number, number]; p?: number | null; effect?: { name: string; value: number }; n: number; direction?: "positive" | "negative";
  /** a comparison of groups: each group's mean, as the test's table printed it — which group is higher is read from here */
  groups?: { label: string; mean: number | null; n: number }[];
  /** the p adjusted for the family of tests it was made in (Phase 4); the raw p and `significant` stay as they are */
  adjusted?: { method: CorrectionMethod; p: number; significant: boolean; family: string };
  /** which pairs of groups differ, when the test compared three or more (Phase 4) */
  pairwise?: PairwiseResult;
}
export interface Finding {
  id: string;
  kind: FindingKind;
  strength: Strength;
  /** significant at the analysis' alpha */
  significant: boolean;
  headline: string;
  detail?: string;
  evidence: FindingEvidence;
  variables: string[];
  hypotheses: string[];
  analysis: { name: string; kind: string; hash: string; planned?: string; id?: string };
  chart?: ChartType;
}

export type Verdict = "supported" | "not_supported" | "mixed" | "inconclusive" | "untested";
export interface HypothesisVerdict {
  label: string; text: string; verdict: Verdict; reason: string; findings: Finding[]; analyses: number;
  /** the direction the hypothesis states, and how the significant evidence sided with it */
  direction?: HypothesisDirection & { agreeing: number; contradicting: number; unread: number };
  /** the verdict once the hypothesis' tests are corrected as a family, when it differs from the raw one (Phase 4) */
  corrected?: { verdict: Verdict; note: string };
}

export interface RunItem {
  definition: AnalysisDefinition;
  result: AnalysisResult;
  findings: Finding[];
  /** the chart the result is best shown as */
  chart?: ChartType;
  source?: PlannedAnalysis["source"];
  priority?: number;
  hypotheses: string[];
  /** what the data says about the method (Phase 4): the checks and the method it recommends */
  advice?: DataAdvice;
  /** this item was run because the data advice recommended its method beside a planned item */
  adaptedFrom?: string;
}
/** one family of tests corrected together (Phase 4) */
export interface CorrectionFamily { family: string; tests: number; /** findings significant before and after */ before: number; after: number; lost: string[] }
export interface AnalysisRun {
  computedAt: string;
  trigger: string;
  environment: DatasetSpec["environment"];
  /** complete responses in the dataset */
  n: number;
  items: RunItem[];
  /** every finding, strongest first */
  findings: Finding[];
  verdicts: HypothesisVerdict[];
  warnings: string[];
  /** the multiple-comparison correction applied to the planned tests, by family (Phase 4) */
  corrections?: { method: CorrectionMethod; families: CorrectionFamily[]; summary: string };
  /** the data advice, one entry per analysis that had something to say (Phase 4) */
  advice?: DataAdvice[];
  /** what the run found beyond the plan (Phase 4) */
  discoveries?: Discoveries;
  /** every KPI of the design measured on this run's data (Phase 8) */
  kpis?: KpiSnapshot[];
  /** what moved since the previous comparable run (Phase 8) — attached by whoever has the previous run */
  since?: WaveComparison;
}

/* ------------------------------------------------------------ strength */

/** effect sizes on their usual scales (Cohen, Cramér, Cohen's conventions for r and η²) */
export function strengthOf(effect: { name: string; value: number } | undefined, p: number | null | undefined, alpha = 0.05): Strength {
  if (p == null || !(p < alpha)) return "none";
  if (!effect || !Number.isFinite(effect.value)) return "weak";
  const v = Math.abs(effect.value);
  const n = effect.name.toLowerCase();
  const cut = (small: number, medium: number, large: number) => (v >= large ? "strong" : v >= medium ? "moderate" : v >= small ? "weak" : "weak");
  if (/cram|phi|^r$|rank-biserial|standardized|beta|β/.test(n)) return cut(0.1, 0.3, 0.5);
  if (/cohen's d|^d$|hedges/.test(n)) return cut(0.2, 0.5, 0.8);
  if (/η|eta|epsilon|ε|omega|r²|r2/.test(n)) return cut(0.01, 0.06, 0.14);
  if (/cohen's h|^h$/.test(n)) return cut(0.2, 0.5, 0.8);
  if (/odds/.test(n)) { const lo = v < 1 ? 1 / v : v; return lo >= 4.3 ? "strong" : lo >= 2.5 ? "moderate" : "weak"; }
  if (/kendall|w$/.test(n)) return cut(0.1, 0.3, 0.5);
  return "weak";
}
const RANK: Record<Strength, number> = { strong: 3, moderate: 2, weak: 1, none: 0 };
const WORD: Record<Strength, string> = { strong: "a strong", moderate: "a moderate", weak: "a small", none: "no" };

const parseP = (s: unknown): number | null => {
  if (typeof s === "number") return s;
  if (typeof s !== "string") return null;
  const t = s.trim();
  if (t === "< .001") return 0.0005;
  const n = Number(t.replace(/^\./, "0."));
  return Number.isFinite(n) ? n : null;
};
const fmtP = (p: number | null | undefined) => (p == null ? "" : p < 0.001 ? "p < .001" : `p = ${p.toFixed(3).replace(/^0/, "")}`);
const fmt = (x: number | null | undefined, d = 2) => (x == null || !Number.isFinite(x) ? "—" : x.toFixed(d));

/* ------------------------------------------------------------ findings */

const TEST_WORDS: Record<string, string> = {
  chi_square: "chi-square", fisher_exact: "Fisher's exact test", t_independent: "t-test", t_welch: "Welch's t-test", t_paired: "paired t-test", t_one_sample: "one-sample t-test",
  anova_one_way: "ANOVA", anova_two_way: "two-way ANOVA", mann_whitney: "Mann–Whitney", kruskal_wallis: "Kruskal–Wallis", wilcoxon: "Wilcoxon", wilcoxon_signed_rank: "Wilcoxon", friedman: "Friedman",
  proportion_one_sample: "proportion test", proportion_two_sample: "proportion test",
};

/** The findings one result supports — structurally, from its tests and tables. */
export function findingsFor(def: AnalysisDefinition, result: AnalysisResult, extra: { hypotheses?: string[]; id?: string; /** a variable's label, as the tables print it */ label?: (variable: string) => string } = {}): Finding[] {
  const L = (v: string) => extra.label?.(v) ?? v;
  const out: Finding[] = [];
  const alpha = typeof def.options?.alpha === "number" ? def.options.alpha : 0.05;
  const hypotheses = extra.hypotheses ?? ((def.options?.hypotheses as string[] | undefined) ?? []);
  const analysis = { name: def.name, kind: def.kind, hash: result.definitionHash, ...(def.options?.planned ? { planned: String(def.options.planned) } : {}), ...(extra.id ? { id: extra.id } : {}) };
  const n = result.base.n;
  const chart = result.recommendedCharts[0];
  const vars = result.variablesUsed.length ? result.variablesUsed : def.variables;
  let k = 0;
  const push = (f: Omit<Finding, "id" | "analysis" | "hypotheses" | "chart">) => out.push({ id: `${result.definitionHash}:${k++}`, analysis, hypotheses, ...(chart ? { chart } : {}), ...f });
  const low = n < MIN_BASE;
  if (n === 0) { push({ kind: "inconclusive", strength: "none", significant: false, headline: `${def.name}: no respondents in the data yet.`, evidence: { n }, variables: vars }); return out; }

  const outcome = vars[0] ?? def.variables[0] ?? "";
  const by = def.kind === "crosstab" ? (def.columns ?? vars.slice(1)) : vars.slice(1);

  /* a comparison of means prints each group's mean: kept as evidence, so a verdict can read WHICH group is higher */
  const groupTable = result.tables.find((x) => x.id === "groups");
  const groups = groupTable ? groupTable.rows.map((r) => ({ label: String(r.group ?? ""), mean: typeof r.mean === "number" ? r.mean : null, n: typeof r.n === "number" ? r.n : 0 })) : undefined;
  /* tests: a difference (or none) per test result */
  const testFindings = (tests: TestResult[], labelFor: (t: TestResult, i: number) => string, varsFor: (i: number) => string[] = () => vars) => {
    tests.forEach((t, i) => {
      if (t.p == null) return;
      const effectSize = t.effectSize && t.effectSize.value != null && Number.isFinite(t.effectSize.value) ? { name: t.effectSize.name, value: t.effectSize.value } : undefined;
      const strength = strengthOf(effectSize, t.p, alpha);
      const sig = t.p < alpha;
      const what = labelFor(t, i);
      const word = TEST_WORDS[t.test] ?? t.test.replace(/_/g, " ");
      push({
        kind: sig ? "difference" : "no_difference", strength, significant: sig,
        headline: sig ? `${what}: ${WORD[strength]} difference (${word}, ${fmtP(t.p)}${effectSize ? `, ${effectSize.name} = ${fmt(effectSize.value)}` : ""}).` : `${what}: no significant difference (${word}, ${fmtP(t.p)}${low ? "; the base is small" : ""}).`,
        ...(t.note ? { detail: t.note } : {}),
        evidence: { test: t.test, statistic: t.statistic, ...(t.df !== undefined ? { df: t.df } : {}), p: t.p, ...(effectSize ? { effect: effectSize } : {}), n, ...(groups && def.kind === "test" ? { groups } : {}) },
        variables: varsFor(i),
      });
    });
  };

  switch (def.kind) {
    case "crosstab": {
      const gap = result.insights.find((s) => /^Largest gap/.test(s));
      testFindings(result.tests, (t, i) => `${L(outcome)} by ${L(by[i] ?? by[0] ?? "the banner")}`, (i) => (by[i] ? [outcome, by[i]] : vars));
      if (gap && out.length) out[out.length - 1].detail = gap;
      break;
    }
    case "test": {
      testFindings(result.tests, () => by.length ? `${L(outcome)} across ${by.map(L).join(" and ")}` : L(outcome));
      break;
    }
    case "correlation": {
      const t = result.tables.find((x) => x.id === "corr" || x.id === "corr_pairs");
      for (const row of t?.rows ?? []) {
        const r = typeof row.r === "number" ? row.r : null; const p = parseP(row.p);
        if (r == null || p == null) continue;
        const pair = (row.pair as string) ?? `${row.a} × ${row.b}`;
        const strength = strengthOf({ name: "r", value: r }, p, alpha);
        const sig = p < alpha;
        push({ kind: sig ? "correlation" : "no_correlation", strength, significant: sig, headline: sig ? `${pair}: ${WORD[strength]} ${r > 0 ? "positive" : "negative"} correlation (r = ${fmt(r)}, ${fmtP(p)}).` : `${pair}: no significant correlation (r = ${fmt(r)}, ${fmtP(p)}).`, evidence: { test: "correlation", statistic: r, p, effect: { name: "r", value: r }, n: typeof row.n === "number" ? row.n : n, direction: r > 0 ? "positive" : "negative" }, variables: vars });
      }
      break;
    }
    case "regression": {
      const coef = result.tables.find((x) => x.id === "coef");
      const logistic = def.options?.model === "logistic";
      // a coefficient's term is the predictor's label (or "label = category" for a dummy): find the variable behind it
      const preds = vars.slice(1);
      const predictorOf = (term: string): string => {
        const direct = preds.find((v) => L(v) === term || term.startsWith(`${L(v)} = `));
        if (direct) return direct;
        const parts = term.split(/\s*[×*:]\s*/);
        if (parts.length > 1) return parts.map((part) => preds.find((v) => L(v) === part) ?? part).join(" × ");
        return term;
      };
      for (const row of coef?.rows ?? []) {
        const term = String(row.term ?? "");
        if (!term || /^\(?intercept\)?$/i.test(term) || /^const/i.test(term)) continue;
        const p = parseP(row.p); const est = typeof row.estimate === "number" ? row.estimate : null;
        if (p == null || est == null) continue;
        const std = typeof row.std === "number" ? row.std : null, or = typeof row.or === "number" ? row.or : null;
        const effect = logistic ? (or != null ? { name: "odds ratio", value: or } : undefined) : (std != null ? { name: "standardized β", value: std } : undefined);
        const strength = strengthOf(effect, p, alpha);
        const sig = p < alpha;
        const interaction = /×|\*|:/.test(term);
        push({
          kind: sig ? "driver" : "no_driver", strength, significant: sig,
          headline: sig
            ? `${term} ${interaction ? "changes the effect on" : est > 0 ? "raises" : "lowers"} ${L(outcome)}: ${WORD[strength]} ${interaction ? "interaction" : "effect"} (${logistic ? `OR = ${fmt(or)}` : `β = ${fmt(std)}`}, ${fmtP(p)}).`
            : `${term} does not predict ${L(outcome)} (${logistic ? `OR = ${fmt(or)}` : `β = ${fmt(std)}`}, ${fmtP(p)}).`,
          evidence: { test: logistic ? "logistic_regression" : "regression", statistic: est, p, ...(effect ? { effect } : {}), n, direction: est > 0 ? "positive" : "negative" },
          variables: [outcome, predictorOf(term)],
        });
      }
      const med = result.tables.find((x) => x.id === "mediation");
      if (med) {
        const ind = med.rows.find((r) => /indirect/i.test(String(r.path ?? "")));
        const p = parseP(ind?.p);
        if (ind && p != null) push({ kind: "mediation", strength: p < alpha ? "moderate" : "none", significant: p < alpha, headline: p < alpha ? `${med.title.replace(/^Mediation: /, "")}: the indirect path is significant (${fmtP(p)}) — part of the effect runs through the mediator.` : `${med.title.replace(/^Mediation: /, "")}: no significant indirect path (${fmtP(p)}).`, evidence: { test: "mediation", statistic: typeof ind.estimate === "number" ? ind.estimate : null, p, n }, variables: vars });
      }
      break;
    }
    case "nps": {
      const kpi = result.chart.kpis?.find((x) => x.label === "NPS");
      const npsValue = typeof kpi?.value === "number" ? kpi.value : null;
      if (kpi && npsValue != null) push({ kind: "nps", strength: "none", significant: false, headline: `NPS for ${L(outcome)} is ${npsValue}${kpi.target != null ? ` (target ${kpi.target})` : ""} on ${n} responses.`, evidence: { statistic: npsValue, n }, variables: vars });
      break;
    }
    case "topbox": {
      const first = result.insights[0];
      if (first) push({ kind: "topbox", strength: "none", significant: false, headline: first, evidence: { n }, variables: vars });
      break;
    }
    case "reliability": {
      const a = result.tables.find((x) => x.id === "alpha")?.rows.find((r) => /α/.test(String(r.stat ?? "")) && !/standard/i.test(String(r.stat ?? "")));
      const alphaVal = typeof a?.value === "number" ? a.value : null;
      if (alphaVal != null) push({ kind: "reliability", strength: alphaVal >= 0.8 ? "strong" : alphaVal >= 0.7 ? "moderate" : alphaVal >= 0.6 ? "weak" : "none", significant: alphaVal >= 0.7, headline: `${def.name}: Cronbach's α = ${fmt(alphaVal)} — ${alphaVal >= 0.8 ? "a reliable scale" : alphaVal >= 0.7 ? "acceptable reliability" : "the items do not hang together well"}.`, evidence: { statistic: alphaVal, effect: { name: "alpha", value: alphaVal }, n }, variables: vars });
      break;
    }
    default: {
      if (result.tests.length) testFindings(result.tests, () => def.name);
      break;
    }
  }
  if (low && out.length) out.forEach((f) => { f.detail = `${f.detail ? `${f.detail} ` : ""}Base ${n} < ${MIN_BASE}: read with caution.`; });
  if (low && !out.length) push({ kind: "low_base", strength: "none", significant: false, headline: `${def.name}: only ${n} respondents so far — too few to conclude.`, evidence: { n }, variables: vars });
  return out;
}

/** strongest first; a significant finding before a null one; a bigger base before a smaller */
export function rankFindings(fs: Finding[]): Finding[] {
  return [...fs].sort((a, b) => Number(b.significant) - Number(a.significant) || RANK[b.strength] - RANK[a.strength] || (a.evidence.p ?? 1) - (b.evidence.p ?? 1) || b.evidence.n - a.evidence.n);
}

/* ------------------------------------------------------------ verdicts */

const TESTED: FindingKind[] = ["difference", "no_difference", "driver", "no_driver", "correlation", "no_correlation", "mediation"];

/** does the hypothesis name this variable — by variable name, code, the question's words or its option labels? */
function mentions(def: SurveyDefinition, text: string, variable: string): boolean {
  const q = def.questions.find((x) => x.variableName === variable || String(x.code) === variable);
  const words = new Set(text.toLowerCase().match(/[\p{L}\p{N}]{3,}/gu) ?? []);
  const candidates = [variable, ...(q ? [String(q.code), q.variableName, ...(q.text.match(/[\p{L}\p{N}]{4,}/gu) ?? []), ...(q.options ?? []).flatMap((o) => o.label.match(/[\p{L}\p{N}]{4,}/gu) ?? [])] : [])].map((w) => w.toLowerCase());
  return candidates.some((c) => words.has(c) || (c.length >= 5 && [...words].some((w) => w.startsWith(c.slice(0, 5)) || c.startsWith(w.slice(0, 5)))));
}

/* ------------------------------------------------------------ direction */

export type DirectionKind = "positive" | "negative" | "group_higher" | "difference" | "none";
export interface HypothesisDirection {
  kind: DirectionKind;
  /** group_higher: the group said to be higher ("women" in "women are more satisfied than men") */
  group?: string;
  /** group_higher: the group said to be lower, when the hypothesis names one */
  lower?: string;
}

/**
 * THE DIRECTION A HYPOTHESIS STATES — read by the engine's hypothesis parser
 * (`parseHypothesis`, Phase 3), which is the one place the words of a
 * hypothesis are read; this keeps the verdicts' own vocabulary:
 *
 *   positive       increases / raises / drives / improves / more likely /
 *                  leads to higher — "trust increases intent"
 *   negative       decreases / reduces / lowers / less likely / fewer —
 *                  "price sensitivity reduces intent"
 *   group_higher   "A are more X than B" (and "B are less X than A"):
 *                  `group` is A, `lower` is B
 *   difference     differs / varies / affects / depends / is related —
 *                  a difference with no side
 *   none           nothing directional
 */
const toDirection = (p: { direction: string; group?: string; lower?: string }): HypothesisDirection => {
  if (p.group && p.lower) return { kind: "group_higher", group: p.group, lower: p.lower };
  if (p.direction === "positive" || p.direction === "negative") return { kind: p.direction };
  if (p.direction === "difference") return { kind: "difference" };
  return { kind: "none" };
};
export function hypothesisDirection(text: string): HypothesisDirection {
  return toDirection(parseHypothesis(text));
}
/** the direction of the design's i-th hypothesis: what was recorded on it (Phase 3), else its words */
function directionOf(def: SurveyDefinition, i: number, text: string): HypothesisDirection {
  const h = structuredHypotheses(def)[i];
  return h ? toDirection(h) : hypothesisDirection(text);
}

/* words for the same group: a hypothesis says "women", the option says "Female" */
const GROUP_SYNONYMS: [RegExp, string][] = [
  [/^(?:wom[ae]n|females?|ladies|lady|girls?)$/, "female"], [/^(?:m[ae]n|males?|gentlem[ae]n|boys?|guys?)$/, "male"],
  [/^(?:users?|customers?|clients?|buyers?|purchasers?)$/, "user"], [/^(?:non[- ]?users?|non[- ]?customers?|non[- ]?buyers?|lapsed)$/, "nonuser"],
  [/^(?:yes|aware|exposed|seen)$/, "yes"], [/^(?:no|unaware|unexposed)$/, "no"],
];
const stem = (w: string) => { const x = w.toLowerCase().replace(/['’]s$/, ""); for (const [re, k] of GROUP_SYNONYMS) if (re.test(x)) return k; return x.length > 4 ? x.replace(/(?:ies)$/, "y").replace(/(?:es|s)$/, "") : x; };
const wordsOf = (s: string) => (s.toLowerCase().match(/[\p{L}\p{N}'’-]+/gu) ?? []).map(stem);

/** which of a test's groups a hypothesis's phrase names — by its words, stemmed, case-insensitive; -1 when none or several equally */
export function matchGroup(phrase: string | undefined, labels: string[]): number {
  if (!phrase) return -1;
  const want = new Set(wordsOf(phrase).filter((w) => !["the", "and", "who", "with", "in", "of", "those", "people", "respondents", "group"].includes(w)));
  const scores = labels.map((l) => wordsOf(l).filter((w) => want.has(w)).length);
  const best = Math.max(0, ...scores);
  if (!best || scores.filter((s) => s === best).length > 1) return -1;
  return scores.indexOf(best);
}

/** how a significant finding sides with the hypothesis's direction */
function sideOf(def: SurveyDefinition, text: string, dir: HypothesisDirection, f: Finding, item: RunItem | undefined): "agree" | "contradict" | "unread" {
  if (dir.kind === "difference" || dir.kind === "none") return "agree";
  if (dir.kind === "group_higher") {
    const g = f.evidence.groups;
    if (!g || g.length < 2 || g.some((x) => x.mean == null)) return "unread";
    const labels = g.map((x) => x.label);
    const hi = matchGroup(dir.group, labels), lo = matchGroup(dir.lower, labels);
    if (hi < 0) return "unread";
    const mean = (i: number) => g[i].mean as number;
    if (lo >= 0 && lo !== hi) return mean(hi) > mean(lo) ? "agree" : mean(hi) < mean(lo) ? "contradict" : "unread";
    const top = Math.max(...g.map((x) => x.mean as number));
    return mean(hi) === top ? "agree" : "contradict";
  }
  // positive / negative: a model's coefficient or a correlation has a sign
  const d = f.evidence.direction;
  if (!d) return "unread";
  // a moderation's interaction term has a sign, but not the one the hypothesis states
  if (f.variables.some((v) => / × /.test(v))) return "unread";
  // judge only the predictors the hypothesis names, when it names any of the item's (a control variable's sign is not the hypothesis's)
  const preds = item ? item.definition.variables.slice(1) : [];
  const named = preds.filter((p) => mentions(def, text, p));
  const predictor = f.variables[1];
  if (named.length && predictor && !named.includes(predictor)) return "unread";
  return d === dir.kind ? "agree" : "contradict";
}

/** the evidence of a direction in a few characters: "β = -0.42", "r = -0.40", "Male 3.80 vs Female 3.00" */
function directionEvidence(f: Finding): string {
  const g = f.evidence.groups;
  if (g && g.length >= 2) { const s = [...g].filter((x) => x.mean != null).sort((a, b) => (b.mean as number) - (a.mean as number)); return `${s[0].label} ${fmt(s[0].mean)} vs ${s[s.length - 1].label} ${fmt(s[s.length - 1].mean)}`; }
  const e = f.evidence.effect;
  if (e) return `${/standardized/.test(e.name) ? "β" : e.name === "odds ratio" ? "OR" : e.name} = ${fmt(e.value)}`;
  return f.evidence.statistic != null ? `estimate ${fmt(f.evidence.statistic)}` : "";
}

/**
 * Each hypothesis judged from the findings of the analyses planned for it —
 * IN ITS DIRECTION. A significant finding is support only when it points the
 * way the hypothesis says: "trust increases intent" is not supported by a
 * significant NEGATIVE β, and "women are more satisfied than men" not by
 * men scoring higher. A significant result in the opposite direction counts
 * against it; a result whose direction the tables do not show (a crosstab, a
 * test without group means) neither confirms nor contradicts the direction —
 * it counts as significant, and the reason says the direction was not read.
 */
export function hypothesisVerdicts(def: SurveyDefinition, items: RunItem[]): HypothesisVerdict[] {
  return (def.research?.hypotheses ?? []).map((text, i) => {
    const label = hypothesisLabel(i);
    const mine = items.filter((it) => it.hypotheses.includes(label));
    /*
     * A crosstab tagged with a hypothesis may have several banner variables;
     * its finding about a banner counts for the hypothesis only when the
     * hypothesis names that variable, a planned test pairs the same two
     * variables, or the banner is the crosstab's only one — otherwise it is
     * context (shown), not evidence (judged).
     */
    const about = (it: RunItem, f: Finding) => {
      if (it.definition.kind !== "crosstab" || f.variables.length < 2) return true;
      const [outcome, banner] = f.variables;
      if ((it.definition.columns ?? []).length <= 1) return true;
      if (mentions(def, text, banner)) return true;
      return mine.some((o) => o !== it && o.definition.kind !== "crosstab" && o.definition.variables.includes(outcome) && o.definition.variables.includes(banner));
    };
    const fs = rankFindings(mine.flatMap((it) => it.findings.filter((f) => about(it, f))));
    const tested = fs.filter((f) => TESTED.includes(f.kind));
    const sig = tested.filter((f) => f.significant), ns = tested.filter((f) => !f.significant);
    const dir = directionOf(def, i, text);
    const itemOf = (f: Finding) => mine.find((it) => it.findings.includes(f));
    const sides = new Map(sig.map((f) => [f, sideOf(def, text, dir, f, itemOf(f))]));
    const agree = sig.filter((f) => sides.get(f) !== "contradict"), contra = sig.filter((f) => sides.get(f) === "contradict");
    const unread = sig.filter((f) => sides.get(f) === "unread").length;
    const directional = dir.kind === "positive" || dir.kind === "negative" || dir.kind === "group_higher";
    const lowBase = mine.length > 0 && mine.every((it) => it.result.base.n < MIN_BASE);
    let verdict: Verdict; let reason: string;
    const against = (f: Finding) => `significant, but in the opposite direction (${directionEvidence(f)})`;
    if (!mine.length) { verdict = "untested"; reason = "No analysis in the plan serves this hypothesis."; }
    else if (lowBase) { verdict = "inconclusive"; reason = `Only ${Math.max(...mine.map((it) => it.result.base.n))} respondents so far — below the ${MIN_BASE} needed to read a test.`; }
    else if (!tested.length) { verdict = "inconclusive"; reason = `${mine.length === 1 ? "The analysis" : `The ${mine.length} analyses`} planned for it describe${mine.length === 1 ? "s" : ""} the data but test${mine.length === 1 ? "s" : ""} nothing — add a test or a crosstab with significance.`; }
    else if (contra.length && !agree.length) {
      verdict = "not_supported";
      reason = `${contra.length === 1 ? "The planned test is" : `All ${contra.length} significant tests are`} ${against(contra[0])}: ${contra[0].headline}`;
    }
    else if (agree.length && !ns.length && !contra.length) {
      verdict = "supported";
      reason = `${agree.length === 1 ? "The planned test" : `All ${agree.length} planned tests`} ${agree.length === 1 ? "is" : "are"} significant: ${agree[0].headline}${directional ? (unread === agree.length ? " (the direction could not be read from these results)" : " — in the direction the hypothesis states") : ""}`;
    }
    else if (agree.length && contra.length) {
      verdict = "mixed";
      reason = `${agree.length} of ${tested.length} planned tests support it — ${agree[0].headline} — but ${contra.length === 1 ? "one is" : `${contra.length} are`} ${against(contra[0])}: ${contra[0].headline}`;
    }
    else if (agree.length && ns.length) { verdict = "mixed"; reason = `${agree.length} of ${tested.length} planned tests ${agree.length === 1 ? "is" : "are"} significant — ${agree[0].headline} — but ${ns[0].headline}`; }
    else { verdict = "not_supported"; reason = `${ns.length === 1 ? "The planned test is not" : `None of the ${ns.length} planned tests are`} significant: ${ns[0].headline}`; }
    return { label, text, verdict, reason, findings: fs, analyses: mine.length, ...(dir.kind !== "none" ? { direction: { ...dir, agreeing: agree.length - unread, contradicting: contra.length, unread } } : {}) };
  });
}

/* ------------------------------------------------------------ the run */

/* ------------------------------------------------------------ corrections (Phase 4) */

const CORRECTABLE: FindingKind[] = ["difference", "no_difference", "driver", "no_driver", "correlation", "no_correlation", "mediation"];

/**
 * The planned tests' p-values corrected by family: one family per hypothesis
 * (its tagged findings), and one for the findings that serve no hypothesis.
 * A finding in two hypotheses is corrected in the larger family. The raw p
 * and `significant` stay; `evidence.adjusted` says what holds.
 */
export function applyCorrections(items: RunItem[], method: CorrectionMethod = "holm", alpha = 0.05): { families: CorrectionFamily[]; summary: string } {
  const all = items.flatMap((it) => it.findings).filter((f) => CORRECTABLE.includes(f.kind) && typeof f.evidence.p === "number");
  const byFamily = new Map<string, Finding[]>();
  const labels = [...new Set(all.flatMap((f) => f.hypotheses))].sort();
  const sizeOf = new Map(labels.map((h) => [h, all.filter((f) => f.hypotheses.includes(h)).length]));
  for (const f of all) {
    const fam = f.hypotheses.length ? [...f.hypotheses].sort((a, b) => (sizeOf.get(b) ?? 0) - (sizeOf.get(a) ?? 0))[0] : "plan";
    byFamily.set(fam, [...(byFamily.get(fam) ?? []), f]);
  }
  const families: CorrectionFamily[] = [];
  for (const [family, fs] of byFamily) {
    const adj = adjustP(fs.map((f) => f.evidence.p), method);
    const lost: string[] = [];
    fs.forEach((f, i) => {
      const p = adj[i]; if (p == null) return;
      const significant = p < alpha;
      f.evidence.adjusted = { method, p, significant, family };
      if (f.significant && !significant) lost.push(f.id);
    });
    families.push({ family, tests: fs.length, before: fs.filter((f) => f.significant).length, after: fs.filter((f) => f.evidence.adjusted?.significant).length, lost });
  }
  families.sort((a, b) => (a.family === "plan" ? 1 : b.family === "plan" ? -1 : a.family.localeCompare(b.family)));
  const lostAll = families.reduce((n, f) => n + f.lost.length, 0);
  const summary = !all.length ? "" : `${CORRECTION_WORDS[method]} correction over ${families.map((f) => `${f.tests} test${f.tests === 1 ? "" : "s"} for ${f.family === "plan" ? "the plan" : f.family}`).join(", ")}: ${lostAll ? `${lostAll} finding${lostAll === 1 ? "" : "s"} significant on ${lostAll === 1 ? "its" : "their"} own ${lostAll === 1 ? "is" : "are"} not once corrected.` : "every significant finding holds."}`;
  return { families, summary };
}

/** the verdict with the family correction read: differs from the raw one only when a supporting test no longer holds */
export function correctedVerdict(v: HypothesisVerdict): HypothesisVerdict["corrected"] | undefined {
  const tested = v.findings.filter((f) => TESTED.includes(f.kind) && f.evidence.adjusted);
  if (!tested.length) return undefined;
  const lost = tested.filter((f) => f.significant && !f.evidence.adjusted!.significant);
  if (!lost.length) return undefined;
  const stillSig = tested.filter((f) => f.evidence.adjusted!.significant);
  const k = tested.length, method = CORRECTION_WORDS[tested[0].evidence.adjusted!.method];
  const verdict: Verdict = v.verdict === "not_supported" ? "not_supported" : stillSig.length ? "mixed" : "not_supported";
  if (verdict === v.verdict) return undefined;
  return { verdict, note: `After ${method} correction for ${k} test${k === 1 ? "" : "s"}, ${stillSig.length ? `${stillSig.length} of ${lost.length + stillSig.length} significant finding${lost.length + stillSig.length === 1 ? "" : "s"} still hold${stillSig.length === 1 ? "s" : ""}` : `no significant finding holds`} — ${verdict === "mixed" ? "mixed rather than supported" : "not supported"} on the corrected reading.` };
}

/** The whole plan, run once on a dataset. `items` lets the caller run saved definitions instead of (or as well as) the plan's. */
export function runPlan(def: SurveyDefinition, input: Dataset, opts: { trigger?: string; items?: PlannedAnalysis[]; primaries?: boolean; now?: string;
  /** the multiple-comparison correction (Phase 4): Holm by default; "none" leaves the raw p-values alone */
  correction?: CorrectionMethod | "none";
  /** run the method the data advice recommends beside the planned one (Phase 4) */
  adapt?: boolean;
  /** look beyond the plan — segment discovery, anomalies, wave trends (Phase 4); on by default */
  discover?: boolean;
} = {}): AnalysisRun {
  /*
   * The plan's derived variables and segments first, as columns of this run's
   * dataset — so a planned test of BRAND_TRUST_SCORE, or a crosstab by the
   * GENDER × AGE segment, runs on a column that exists. What could not be
   * computed, and any segment too small to read, joins the run's caveats.
   */
  const plan = def.research?.analysisPlan ?? buildAnalysisFramework(def);
  const prepared = withPlannedVariables(def, input, plan);
  const dataset = prepared.dataset;
  const planned = opts.items ?? plannedAnalyses(def, dataset.spec, { primaries: opts.primaries ?? false, plan });
  const method: CorrectionMethod | "none" = opts.correction ?? "holm";
  const corrMethod: CorrectionMethod = method === "none" ? "holm" : method;
  const runOne = (p: PlannedAnalysis, adaptedFrom?: string): RunItem => {
    const result = runAnalysis(p.definition, dataset);
    const findings = findingsFor(p.definition, result, { hypotheses: p.hypotheses, ...(p.definition.id ? { id: p.definition.id } : {}), label: (v) => dataset.byName.get(v)?.label ?? v });
    const chart = recommendCharts(result, 1)[0]?.type ?? result.recommendedCharts[0];
    /* which pairs differ, when a significant comparison had three or more groups (Phase 4) */
    if (p.definition.kind === "test" && dataset.cases.length >= MIN_BASE) {
      const [y, g] = p.definition.variables;
      const groups = result.tables.find((t) => t.id === "groups")?.rows.length ?? 0;
      const f = findings.find((x) => x.kind === "difference" && /anova|kruskal/.test(x.evidence.test ?? ""));
      if (f && y && g && groups >= 3) {
        const pw = pairwiseComparisons(dataset, y, g, { method: corrMethod, nonparametric: /kruskal/.test(f.evidence.test ?? "") });
        f.evidence.pairwise = pw;
        f.detail = `${f.detail ? `${f.detail} ` : ""}${pw.summary}`;
      }
    }
    const advice = adviseAnalysis(p.definition, dataset);
    return { definition: p.definition, result, findings, ...(chart ? { chart } : {}), source: p.source, priority: p.priority, hypotheses: p.hypotheses, ...(advice.ok ? {} : { advice }), ...(adaptedFrom ? { adaptedFrom } : {}) };
  };
  const items: RunItem[] = planned.map((p) => runOne(p));
  /* the recommended method beside the planned one, when asked (Phase 4) */
  if (opts.adapt) {
    for (const it of [...items]) {
      const rec = it.advice?.recommended;
      if (!rec || it.definition.kind !== "test" || !["mann_whitney", "kruskal_wallis", "t_welch", "fisher_exact"].includes(rec.test)) continue;
      const planned = it.definition.options?.planned ? String(it.definition.options.planned) : it.definition.name;
      const adapted: PlannedAnalysis = { definition: { ...it.definition, name: `${it.definition.name} (${rec.label})`, options: { ...(it.definition.options ?? {}), test: rec.test, planned: undefined } }, source: it.source ?? { kind: "test", id: planned }, priority: it.priority ?? 2, hypotheses: it.hypotheses, reason: rec.reason };
      items.push(runOne(adapted, planned));
    }
  }
  const corrections = method === "none" ? undefined : { method: corrMethod, ...applyCorrections(items, corrMethod) };
  const findings = rankFindings(items.flatMap((it) => it.findings));
  const verdicts = hypothesisVerdicts(def, items).map((v) => { const corrected = corrections ? correctedVerdict(v) : undefined; return corrected ? { ...v, corrected } : v; });
  const advice = items.map((it) => it.advice).filter((a): a is DataAdvice => !!a);
  const discoveries = opts.discover === false ? undefined : synthesize(def, dataset, { method: corrMethod });
  const warnings = [...new Set([...prepared.warnings, ...items.flatMap((it) => it.result.warnings)])];
  const kpis = kpiSnapshot(def, dataset);
  return { computedAt: opts.now ?? new Date().toISOString(), trigger: opts.trigger ?? "manual", environment: dataset.spec.environment, n: dataset.cases.length, items, findings, verdicts, warnings,
    ...(corrections ? { corrections } : {}), ...(advice.length ? { advice } : {}), ...(discoveries ? { discoveries } : {}), ...(kpis.length ? { kpis } : {}) };
}

/** the run without its results — what is stored and sent around */
export function compactRun(run: AnalysisRun): Omit<AnalysisRun, "items"> & { items: Omit<RunItem, "result">[] } {
  return { ...run, items: run.items.map(({ result: _r, ...rest }) => { void _r; return rest; }) };
}

/* ------------------------------------------------------------ for the copilot */

const VERDICT_WORDS: Record<Verdict, string> = { supported: "SUPPORTED", not_supported: "NOT SUPPORTED", mixed: "MIXED", inconclusive: "INCONCLUSIVE", untested: "UNTESTED" };

/** The run in a few lines the model (and a person) can read: verdicts, then the findings strongest first. */
export function briefText(run: Pick<AnalysisRun, "computedAt" | "n" | "findings" | "verdicts" | "warnings" | "environment" | "trigger">, opts: { maxFindings?: number } = {}): string {
  const max = opts.maxFindings ?? 15;
  const lines: string[] = [];
  lines.push(`Analysis run (${run.trigger}) on ${run.n} ${run.environment.toLowerCase()} completes, ${run.computedAt.slice(0, 16).replace("T", " ")}:`);
  for (const v of run.verdicts) lines.push(`  ${v.label} ${VERDICT_WORDS[v.verdict]} — ${v.text}. ${v.reason}${v.corrected ? ` ${v.corrected.note}` : ""}`);
  const shown = run.findings.filter((f) => f.kind !== "inconclusive").slice(0, max);
  const adj = (f: Finding) => (f.evidence.adjusted && f.significant && !f.evidence.adjusted.significant ? ` [not significant after ${CORRECTION_WORDS[f.evidence.adjusted.method]} correction, ${fmtP(f.evidence.adjusted.p)}]` : "");
  if (shown.length) { lines.push(`  Findings (strongest first):`); for (const f of shown) lines.push(`    [${f.significant ? f.strength : "ns"}] ${f.headline}${f.hypotheses.length ? ` (${f.hypotheses.join(", ")})` : ""}${adj(f)}${f.detail ? ` ${f.detail}` : ""}`); }
  if (run.findings.length > shown.length) lines.push(`    … and ${run.findings.length - shown.length} more`);
  const r = run as Partial<Pick<AnalysisRun, "corrections" | "advice" | "discoveries" | "kpis" | "since">>;
  if (r.kpis?.length) lines.push(`  KPIs: ${r.kpis.map((k) => `${k.name} ${k.value === null ? `— (${k.measure})` : `${k.value}${/share|box/.test(k.measure) ? "%" : ""} (${k.measure}, n=${k.n})`}${k.target ? `, target ${k.target}` : ""}`).join("; ")}`);
  if (r.since) for (const line of describeSince(r.since)) lines.push(`  ${line}`);
  if (r.corrections?.summary) lines.push(`  Corrections: ${r.corrections.summary}`);
  if (r.advice?.length) lines.push(`  Data advice: ${adviceSummary(r.advice)}`);
  if (r.discoveries) {
    lines.push(`  ${r.discoveries.summary}`);
    for (const f of [...r.discoveries.segments, ...r.discoveries.trends, ...r.discoveries.anomalies].slice(0, Math.max(5, Math.floor(max / 2)))) lines.push(`    [${f.kind}] ${f.headline}`);
  }
  if (run.warnings.length) lines.push(`  Caveats: ${run.warnings.slice(0, 4).join(" ")}`);
  return lines.join("\n");
}

/* ------------------------------------------------------------ when to run */

export type Milestone = "first_results" | "halfway" | "target_reached" | "field_end";

/**
 * The fieldwork milestones at which the plan runs by itself — once each:
 * the first readable base, half the target, the target, the end of the
 * field window. `done` are the triggers of the runs already made.
 */
export function nextMilestone(done: string[], state: { completes: number; target?: number | null; fieldEnd?: string | null; now?: string }): Milestone | null {
  const has = (m: Milestone) => done.includes(m);
  const now = state.now ? new Date(state.now).getTime() : Date.now();
  if (!has("first_results") && state.completes >= MIN_BASE) return "first_results";
  if (state.target && state.target > 0) {
    if (!has("halfway") && state.completes >= state.target / 2 && state.completes >= MIN_BASE) return "halfway";
    if (!has("target_reached") && state.completes >= state.target) return "target_reached";
  }
  if (state.fieldEnd && !has("field_end") && new Date(state.fieldEnd).getTime() <= now && state.completes >= MIN_BASE) return "field_end";
  return null;
}

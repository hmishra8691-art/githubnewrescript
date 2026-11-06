/**
 * THE ANALYSIS CATALOGUE — what the Architect's Explorer shows (Analytics Architect Mode, 2026-11-06, AA1).
 *
 * Everything the analytics module holds for a survey, in one tree a researcher can read: hypotheses, crosstabs,
 * statistical tests, models, correlations, charts, themes & insights, reports and dashboards. Each entry carries a
 * RESEARCH LABEL — "Purchase Intent by Brand Awareness", never "Q18 × Q14" — and a short description of what it
 * answers and why it exists (the plan's reason, the hypotheses it serves, the objective it supports). The
 * technical identity (variable names, question codes, analysis id, kind, hash) is kept on `technical`, for the
 * properties panel and for traceability; it is never the label.
 *
 * Naming reads the research design before the questionnaire: a KPI declared on a variable names it ("Net
 * Promoter Score"); a construct measured by its question names it ("Purchase Intent", "Brand Image — Trust" for a
 * battery item); otherwise the question's text, cleaned of its code, HTML and piping and cut to a phrase. The
 * code is never lost: it is on `technical.variables[].code`.
 *
 * Pure: a function of the rows and views the server already loads for the plan workspace. Nothing here is
 * AI-written and nothing is a finding — the entries describe what exists and what it is for.
 */
import type { SurveyDefinition } from "@rescript/schema";
import type { AnalysisDefinition, AnalysisKind, ChartSpec, ChartType, DashboardDefinition, ReportDefinition } from "./types.js";
import { ANALYSIS_KINDS } from "./types.js";
import type { VariableMeta } from "./dataset.js";
import type { Finding, HypothesisVerdict, Verdict } from "./findings.js";
import type { PlanItemView, SavedAnalysisRow, SavedChartRow } from "./planWorkspace.js";
import type { QualTheme } from "./qual/types.js";
import { evidenceLine } from "./evidence.js";

export type CatalogueCategory = "hypotheses" | "crosstabs" | "tests" | "models" | "correlations" | "charts" | "themes" | "reports" | "dashboards";

export const CATALOGUE_CATEGORIES: { key: CatalogueCategory; label: string; description: string }[] = [
  { key: "hypotheses", label: "Hypotheses", description: "What the study set out to test, and where each stands" },
  { key: "crosstabs", label: "Crosstabs", description: "How one thing breaks down by another" },
  { key: "tests", label: "Statistical tests", description: "Whether a difference or an association is more than chance" },
  { key: "models", label: "Models", description: "Drivers, segments, factors and reliability" },
  { key: "correlations", label: "Correlations", description: "How strongly measures move together" },
  { key: "charts", label: "Charts", description: "Saved pictures of results" },
  { key: "themes", label: "Themes & insights", description: "What the data and the open ends say, beyond any one table" },
  { key: "reports", label: "Reports", description: "Documents and decks built from the analyses" },
  { key: "dashboards", label: "Dashboards", description: "Live views for stakeholders" },
];

/** which Explorer category an analysis kind files under */
export function categoryOfKind(kind: AnalysisKind | string): Exclude<CatalogueCategory, "hypotheses" | "charts" | "themes" | "reports" | "dashboards"> {
  switch (kind) {
    case "crosstab": return "crosstabs";
    case "test": return "tests";
    case "correlation": return "correlations";
    default: return "models";
  }
}

export type CatalogueStatus = "ready" | "planned" | "stale" | "blocked" | "unknown";

export interface CatalogueVariableRef { name: string; code?: string; label: string; researchLabel: string; construct?: string; kpi?: string }

export interface CatalogueEntry {
  /** `<category>:<id>` — unique across the tree */
  key: string;
  category: CatalogueCategory;
  /** the stored id (analysis, chart, report, dashboard, theme) or the plan item / hypothesis label */
  id: string;
  /** the research label */
  label: string;
  /** what it answers / why it exists, one or two sentences */
  description: string;
  /** the hypotheses it serves (labels, "H1") */
  hypotheses: string[];
  status: CatalogueStatus;
  /** for a hypothesis: where it stands */
  verdict?: Verdict;
  /** the analysis this entry belongs to, when it is a chart or a planned item that was applied */
  analysisId?: string | null;
  /** the planned item this came from */
  planned?: string | null;
  /** significant findings the latest run made of it */
  findings?: number;
  /** for a hypothesis: every finding the verdict rests on, with its evidence line */
  evidence?: { id: string; headline: string; evidence: string; holds: boolean; analysisId: string | null; planned: string | null }[];
  /** for a hypothesis: why it cannot be tested, when it cannot (a construct without a question, no planned test) */
  untestable?: string | null;
  updatedAt?: string | null;
  technical: {
    kind?: string;
    method?: string;
    name?: string;
    variables: CatalogueVariableRef[];
    chartType?: ChartType;
    hash?: string | null;
    /** for an output: how many components it has and how many came from the plan */
    components?: number;
    planned_components?: number;
    missing?: string[];
  };
}

export interface CatalogueSection { category: CatalogueCategory; label: string; description: string; entries: CatalogueEntry[] }

export interface AnalysisCatalogue {
  sections: CatalogueSection[];
  /** every entry, in Explorer order, for the "All" view */
  all: CatalogueEntry[];
  counts: Record<CatalogueCategory, number>;
  objective: string | null;
}

export interface CatalogueInput {
  def: SurveyDefinition;
  dictionary: readonly VariableMeta[];
  analyses?: readonly SavedAnalysisRow[];
  charts?: readonly SavedChartRow[];
  planItems?: readonly PlanItemView[];
  hypotheses?: readonly { label: string; text: string; status?: string; items?: string[]; verdict?: HypothesisVerdict | null }[];
  findings?: readonly Finding[];
  /** reports and dashboards, as the analytics_reports rows hold them */
  outputs?: readonly { id: string; kind: string; name: string; updated_at?: string | null; definition: ReportDefinition | DashboardDefinition; published_version?: number | null }[];
  /** the qualitative phase's themes (reviewed ones are listed; AI-suggested are marked) */
  qualThemes?: readonly QualTheme[];
  /** cross-cutting discoveries from the run (segments, trends, anomalies) */
  discoveries?: readonly { kind: string; headline: string; detail?: string }[];
}

/* ------------------------------------------------------------ naming */

const stripMarkup = (s: string) => s.replace(/<[^>]+>/g, " ").replace(/\{\{[^}]*\}\}|\[\[[^\]]*\]\]|\$\{[^}]*\}/g, " ").replace(/\s+/g, " ").trim();
const stripCode = (s: string) => s.replace(/^[A-Za-z][A-Za-z0-9_.]*\s+[—–-]\s+/, "");
const cap = (s: string) => (s ? s[0]!.toUpperCase() + s.slice(1) : s);
const list = (xs: readonly string[]) => (xs.length <= 1 ? xs.join("") : xs.length === 2 ? `${xs[0]} and ${xs[1]}` : `${xs.slice(0, -1).join(", ")} and ${xs[xs.length - 1]}`);

/* the questionnaire's ways of asking, turned into the thing asked about */
const LEADS: [RegExp, string][] = [
  [/^how likely (?:are|would|is|were) (?:you|it|they)(?: to)? (?:be to )?/i, "Likelihood to "],
  [/^how (?:satisfied|happy|pleased) (?:are|were) you with /i, "Satisfaction with "],
  [/^how (?:important|much does) (?:is|are) /i, "Importance of "],
  [/^how often (?:do|did|have|would) you /i, "Frequency of "],
  [/^how (?:much|strongly) do you agree (?:or disagree )?(?:with|that) /i, "Agreement: "],
  [/^to what extent (?:do|would) you agree (?:or disagree )?(?:with|that) /i, "Agreement: "],
  [/^how would you rate /i, "Rating of "],
  [/^(?:please )?rate /i, "Rating of "],
  [/^how (?:familiar|aware) are you (?:with|of) /i, "Awareness of "],
  [/^which (?:one )?of (?:the following|these) /i, ""],
  [/^which (?:of the following )?/i, ""],
  [/^what is your /i, ""],
  [/^what /i, ""],
  [/^do you /i, ""],
  [/^have you (?:ever )?/i, ""],
  [/^(?:please )?(?:select|choose|tell us|indicate) /i, ""],
];

/** a question's text as the thing it measures: "How likely are you to buy Brand A?" → "Likelihood to buy Brand A" */
export function phraseFromQuestion(text: string): string {
  let t = stripCode(stripMarkup(text));
  t = t.split(/[?]/)[0]!.trim();
  for (const [re, lead] of LEADS) {
    if (re.test(t)) { t = lead + t.replace(re, ""); break; }
  }
  t = t.replace(/[.:,;]+$/, "").trim();
  if (t.length > 64) t = t.slice(0, 61).replace(/\s+\S*$/, "") + "…";
  return cap(t);
}

export interface NamingContext {
  byName: Map<string, VariableMeta>;
  constructByQuestion: Map<string, string>;
  kpiByVariable: Map<string, string>;
  questionText: Map<string, string>;
}

export function namingContext(def: SurveyDefinition, dictionary: readonly VariableMeta[]): NamingContext {
  const byName = new Map(dictionary.map((v) => [v.name, v]));
  const constructByQuestion = new Map<string, string>();
  for (const c of def.research?.constructs ?? []) for (const q of c.questionIds ?? []) if (!constructByQuestion.has(q)) constructByQuestion.set(q, c.name);
  const kpiByVariable = new Map<string, string>();
  for (const k of def.research?.kpis ?? []) if (k.variable && !kpiByVariable.has(k.variable)) kpiByVariable.set(k.variable, k.name);
  const questionText = new Map(def.questions.map((q) => [q.id, q.text ?? ""]));
  return { byName, constructByQuestion, kpiByVariable, questionText };
}

/** the research label of one variable, with the code kept beside it */
export function researchVariable(name: string, ctx: NamingContext): CatalogueVariableRef {
  const v = ctx.byName.get(name);
  if (!v) return { name, label: name, researchLabel: name };
  const kpi = ctx.kpiByVariable.get(name) ?? (v.questionId ? [...ctx.kpiByVariable.entries()].find(([k]) => k === v.questionCode)?.[1] : undefined);
  const construct = v.questionId ? ctx.constructByQuestion.get(v.questionId) : undefined;
  let researchLabel: string;
  if (kpi) researchLabel = kpi;
  else if (construct) researchLabel = v.itemLabel ? `${construct} — ${stripMarkup(v.itemLabel)}` : construct;
  else {
    const text = v.questionId ? ctx.questionText.get(v.questionId) : undefined;
    const base = text ? phraseFromQuestion(text) : cap(stripCode(stripMarkup(v.label)));
    researchLabel = v.itemLabel ? `${base} — ${stripMarkup(v.itemLabel)}` : base;
  }
  return { name, code: v.questionCode, label: v.label, researchLabel, ...(construct ? { construct } : {}), ...(kpi ? { kpi } : {}) };
}

/** the research label of an analysis definition — "Purchase Intent by Brand Awareness" */
export function researchLabel(def: AnalysisDefinition, ctx: NamingContext): { label: string; variables: CatalogueVariableRef[] } {
  const refs = new Map<string, CatalogueVariableRef>();
  const r = (n: string) => { let x = refs.get(n); if (!x) { x = researchVariable(n, ctx); refs.set(n, x); } return x.researchLabel; };
  const rows = (def.rows ?? []).map(r), cols = (def.columns ?? []).map(r), layers = (def.layers ?? []).map(r);
  const vars = def.variables.map(r);
  const uniq = (xs: string[]) => [...new Set(xs)];
  let label: string;
  switch (def.kind) {
    case "crosstab":
      label = rows.length && cols.length ? `${list(uniq(rows))} by ${list(uniq(cols))}${layers.length ? ` within ${list(uniq(layers))}` : ""}`
        : rows.length ? list(uniq(rows)) : list(uniq(vars));
      break;
    case "test": {
      const [a, b] = vars;
      label = a && b ? `${a} by ${b}` : a ?? def.name;
      break;
    }
    case "correlation":
      label = vars.length === 2 ? `${vars[0]} and ${vars[1]}` : vars.length ? `Correlations among ${list(uniq(vars))}` : def.name;
      break;
    case "regression": {
      const [y, ...xs] = vars;
      const model = String(def.options?.model ?? "linear");
      label = y ? (model === "mediation" && xs.length >= 2 ? `${xs[0]} → ${xs[1]} → ${y}` : `Drivers of ${y}`) : def.name;
      break;
    }
    case "cluster": label = vars.length ? `Segments from ${list(uniq(vars)).replace(/^(.{70}).+/, "$1…")}` : def.name; break;
    case "factor": label = vars.length ? `Underlying factors of ${list(uniq(vars)).replace(/^(.{70}).+/, "$1…")}` : def.name; break;
    case "reliability": label = vars.length ? `Reliability of ${list(uniq(vars)).replace(/^(.{70}).+/, "$1…")}` : def.name; break;
    case "descriptive": case "topbox": case "ranking": case "allocation":
      label = vars.length ? list(uniq(vars)) : def.name; break;
    case "nps": label = vars[0] ? `Net Promoter Score — ${vars[0]}` : "Net Promoter Score"; break;
    case "csat": label = vars[0] ? `Satisfaction — ${vars[0]}` : "Satisfaction"; break;
    default:
      label = def.name && !/^q\d+/i.test(def.name) ? def.name : (vars.length ? list(uniq(vars)) : def.name);
  }
  /* a saved name a person wrote wins over a derived one, unless it is only codes */
  if (def.name && !looksTechnical(def.name) && def.kind !== "crosstab" && def.kind !== "test" && def.kind !== "correlation" && def.kind !== "regression") label = def.name;
  return { label: cap(label), variables: [...refs.values()] };
}

/** "Q18 × Q14", "crosstab Q3 by Q7", "Q1" — a name made of codes, not of research */
export function looksTechnical(name: string): boolean {
  const t = name.trim();
  if (!t) return true;
  const stripped = t.replace(/\b(crosstab|test|by|×|x|vs\.?|and|of|for|the|a|an|\d+|,|:|-|—|–|\(|\)|\/)\b/gi, " ").replace(/\b[A-Za-z]{1,3}\d+[A-Za-z0-9_]*\b/g, " ").replace(/\b_[a-z_]+\b/g, " ").trim();
  return stripped.length < 3;
}

/* ------------------------------------------------------------ descriptions */

const kindInfo = (kind: string) => ANALYSIS_KINDS.find((k) => k.kind === kind);
const methodWords: Record<string, string> = {
  chi_square: "a chi-square test of association", fisher: "Fisher's exact test", t_independent: "an independent-samples t-test", t_paired: "a paired t-test", t_one_sample: "a one-sample t-test",
  anova_one_way: "a one-way ANOVA", mann_whitney: "a Mann-Whitney U test", wilcoxon: "a Wilcoxon signed-rank test", kruskal_wallis: "a Kruskal-Wallis test", friedman: "a Friedman test",
  proportion: "a test of proportions", proportion_one_sample: "a one-sample test of a proportion", auto: "the test that fits the variables",
};

function describeAnalysis(def: AnalysisDefinition, vars: CatalogueVariableRef[], item: PlanItemView | undefined, objective: string | null): string {
  const r = (i: number) => vars[i]?.researchLabel ?? def.variables[i] ?? "";
  const by = (xs: string[] | undefined) => (xs ?? []).map((n) => vars.find((v) => v.name === n)?.researchLabel ?? n);
  let what: string;
  switch (def.kind) {
    case "crosstab": what = `How ${list(by(def.rows)) || list(def.variables.map((_, i) => r(i)))} breaks down by ${list(by(def.columns)) || "the banner"}, with significance between columns.`; break;
    case "test": what = `Whether ${r(0)}${def.variables[1] ? ` differs by ${r(1)}` : " differs from the reference value"} — ${methodWords[String(def.options?.test ?? "auto")] ?? String(def.options?.test ?? "a statistical test")}.`; break;
    case "correlation": what = `How strongly ${list(def.variables.map((_, i) => r(i)))} move together (${String(def.options?.method ?? "pearson")}).`; break;
    case "regression": what = `Which of ${list(def.variables.slice(1).map((_, i) => r(i + 1)))} predict ${r(0)}, and by how much.`; break;
    case "cluster": what = "Groups of respondents who answer alike, with a profile of each."; break;
    case "factor": what = "The few underlying dimensions behind many related items."; break;
    case "reliability": what = "Whether the items measure one thing consistently (Cronbach's alpha)."; break;
    default: what = `${kindInfo(def.kind)?.description ?? kindInfo(def.kind)?.label ?? def.kind}.`;
  }
  const why = item?.reason ? ` ${item.reason.trim().replace(/[.]?$/, ".")}` : "";
  const h = item?.hypotheses.length ? ` Serves ${list(item.hypotheses)}.` : "";
  const obj = !why && !h && objective ? ` Part of: ${objective.trim().replace(/[.]?$/, ".")}` : "";
  return `${what}${why}${h}${obj}`;
}

const statusOfItem = (item: PlanItemView | undefined, saved: boolean): CatalogueStatus => {
  if (!item) return saved ? "ready" : "unknown";
  if (item.missing.length || item.issues.some((i) => i.level === "critical")) return "blocked";
  if (item.state === "invalid") return "blocked";
  if (item.state === "stale" || item.staleBecause) return "stale";
  return item.analysis ? "ready" : "planned";
};

/* ------------------------------------------------------------ the tree */

export function buildCatalogue(input: CatalogueInput): AnalysisCatalogue {
  const ctx = namingContext(input.def, input.dictionary);
  const objective = input.def.research?.objective?.trim() || null;
  const analyses = input.analyses ?? [];
  const charts = input.charts ?? [];
  const planItems = input.planItems ?? [];
  const findings = input.findings ?? [];
  const sections = new Map<CatalogueCategory, CatalogueEntry[]>(CATALOGUE_CATEGORIES.map((c) => [c.key, []]));
  const push = (e: CatalogueEntry) => sections.get(e.category)!.push(e);
  const sigFor = (analysisId: string | undefined, planned: string | undefined) => findings.filter((f) => f.significant && ((analysisId && f.analysis.id === analysisId) || (planned && f.analysis.planned === planned))).length;

  /* hypotheses */
  for (const h of input.hypotheses ?? []) {
    const v = h.verdict ?? null;
    const verdict: Verdict = v?.corrected?.verdict ?? v?.verdict ?? "untested";
    const items = h.items ?? [];
    const descr = v?.reason?.trim()
      ? v.reason.trim()
      : items.length ? `Tested by ${items.length} planned analys${items.length === 1 ? "is" : "es"}; not run yet.`
      : h.status === "unmeasured" ? "No question in the survey measures this yet." : h.status === "unlinked" ? "No construct is linked to this hypothesis yet." : "Nothing in the plan tests this yet.";
    const untestable = h.status === "unmeasured" ? "A construct of this hypothesis has no question that measures it." : h.status === "unlinked" ? "No construct is linked to this hypothesis, so no analysis can be planned for it." : !items.length ? "Nothing in the plan tests it." : null;
    push({
      key: `hypotheses:${h.label}`, category: "hypotheses", id: h.label, label: `${h.label} — ${stripMarkup(h.text).replace(/^(.{90}).+/, "$1…")}`,
      description: descr, hypotheses: [h.label], status: verdict === "untested" ? (items.length ? "planned" : "blocked") : "ready", verdict,
      findings: v?.findings.filter((f) => f.significant).length ?? 0,
      evidence: (v?.findings ?? []).map((f) => ({ id: f.id, headline: f.headline, evidence: evidenceLine(f), holds: f.significant && (f.evidence.adjusted ? f.evidence.adjusted.significant : true), analysisId: f.analysis.id ?? null, planned: f.analysis.planned ?? null })),
      untestable,
      technical: { kind: "hypothesis", name: h.text, variables: [], method: h.status },
    });
  }

  /* saved analyses, and planned items not yet saved */
  const itemByAnalysis = new Map(planItems.filter((i) => i.analysis).map((i) => [i.analysis!.id, i]));
  for (const row of analyses) {
    const item = itemByAnalysis.get(row.id);
    const { label, variables } = researchLabel(row.definition, ctx);
    const category = categoryOfKind(row.kind);
    push({
      key: `${category}:${row.id}`, category, id: row.id, label, description: describeAnalysis(row.definition, variables, item, objective),
      hypotheses: item?.hypotheses ?? [], status: statusOfItem(item, true), analysisId: row.id, planned: item?.id ?? null,
      findings: sigFor(row.id, item?.id), updatedAt: row.updated_at ?? null,
      technical: { kind: row.kind, method: item?.method ?? (row.definition.options?.test as string | undefined) ?? (row.definition.options?.model as string | undefined) ?? (row.definition.options?.method as string | undefined), name: row.name, variables, hash: item?.analysis?.hash ?? null, ...(item?.missing.length ? { missing: item.missing } : {}) },
    });
  }
  for (const item of planItems) {
    if (item.analysis) continue;
    const { label, variables } = researchLabel({ ...item.derived, name: item.title }, ctx);
    const category = categoryOfKind(item.kind);
    push({
      key: `${category}:plan:${item.id}`, category, id: item.id, label, description: describeAnalysis(item.derived, variables, item, objective),
      hypotheses: item.hypotheses, status: statusOfItem(item, false), analysisId: null, planned: item.id, findings: sigFor(undefined, item.id),
      technical: { kind: item.kind, method: item.method, name: item.title, variables, hash: item.hash, ...(item.missing.length ? { missing: item.missing } : {}) },
    });
  }

  /* charts */
  const analysisById = new Map(analyses.map((a) => [a.id, a]));
  for (const c of charts) {
    const a = analysisById.get(c.analysis_id);
    const named = a ? researchLabel(a.definition, ctx) : null;
    const chartType = (c.spec as ChartSpec).type;
    push({
      key: `charts:${c.id}`, category: "charts", id: c.id, label: !looksTechnical(c.name) && named && c.name !== a?.name ? c.name : (named?.label ?? c.name),
      description: `${chartWord(chartType)} of ${named?.label ?? "a deleted analysis"}.`,
      hypotheses: a ? itemByAnalysis.get(a.id)?.hypotheses ?? [] : [], status: a ? "ready" : "blocked", analysisId: c.analysis_id,
      technical: { kind: "chart", chartType, name: c.name, variables: named?.variables ?? [] },
    });
  }

  /* themes & insights */
  for (const t of input.qualThemes ?? []) {
    if (t.parentId || t.status === "rejected") continue;
    push({
      key: `themes:${t.id}`, category: "themes", id: t.id, label: t.name,
      description: t.description?.trim() || (t.status === "ai_suggested" ? "Suggested from the open ends; not yet reviewed." : "A theme from the qualitative coding."),
      hypotheses: [], status: t.status === "ai_suggested" ? "planned" : "ready",
      technical: { kind: "theme", method: t.status, variables: [] },
    });
  }
  (input.discoveries ?? []).forEach((d, i) => push({
    key: `themes:discovery:${i}`, category: "themes", id: `discovery:${i}`, label: d.headline, description: d.detail?.trim() || `A ${d.kind} the run found across the data, outside any planned analysis.`,
    hypotheses: [], status: "ready", technical: { kind: "discovery", method: d.kind, variables: [] },
  }));

  /* reports and dashboards */
  for (const o of input.outputs ?? []) {
    const isDash = o.kind === "dashboard";
    const parts = isDash ? ((o.definition as DashboardDefinition).widgets ?? []) : ((o.definition as ReportDefinition).blocks ?? []);
    const withAnalysis = parts.filter((p) => "analysisId" in p && p.analysisId).length;
    const planned = parts.filter((p) => p.id.startsWith("plan:") && p.id !== "plan:summary").length;
    const category: CatalogueCategory = isDash ? "dashboards" : "reports";
    push({
      key: `${category}:${o.id}`, category, id: o.id, label: o.name,
      description: `${isDash ? "Dashboard" : o.kind === "deck" ? "Deck" : "Report"} with ${parts.length} ${isDash ? "widget" : "block"}${parts.length === 1 ? "" : "s"}, ${withAnalysis} on analyses${planned ? `, ${planned} from the plan` : ""}${o.published_version ? ` · published v${o.published_version}` : " · not published"}.`,
      hypotheses: [], status: "ready", updatedAt: o.updated_at ?? null,
      technical: { kind: o.kind, name: o.name, variables: [], components: parts.length, planned_components: planned },
    });
  }

  const out: CatalogueSection[] = CATALOGUE_CATEGORIES.map((c) => ({ category: c.key, label: c.label, description: c.description, entries: sections.get(c.key)! }));
  const counts = Object.fromEntries(out.map((s) => [s.category, s.entries.length])) as Record<CatalogueCategory, number>;
  return { sections: out, all: out.flatMap((s) => s.entries), counts, objective };
}

function chartWord(t: ChartType | undefined): string {
  switch (t) {
    case undefined: return "Chart";
    case "coefficient_plot": case "forest": return "Driver plot";
    default: {
      const s = String(t);
      if (s.startsWith("bar_") || s.startsWith("column_") || s === "lollipop" || s === "dot_plot") return "Bar chart";
      if (s.startsWith("line") || s.startsWith("area") || s.endsWith("_trend")) return "Trend chart";
      if (s.startsWith("pie") || s.startsWith("donut")) return "Share chart";
      if (s.startsWith("scatter") || s === "bubble") return "Scatter plot";
      if (s.startsWith("heatmap") || s.startsWith("correlation")) return "Heatmap";
      return cap(s.replace(/_/g, " "));
    }
  }
}

/** search the catalogue by research label, technical name, code or variable name — the Explorer's filter box */
export function searchCatalogue(c: AnalysisCatalogue, q: string): CatalogueEntry[] {
  const t = q.trim().toLowerCase();
  if (!t) return c.all;
  const words = t.split(/\s+/);
  return c.all.filter((e) => {
    const hay = [e.label, e.description, e.technical.name ?? "", e.technical.kind ?? "", e.technical.method ?? "", ...e.hypotheses, ...e.technical.variables.flatMap((v) => [v.name, v.code ?? "", v.label, v.researchLabel])].join(" ").toLowerCase();
    return words.every((w) => hay.includes(w));
  });
}

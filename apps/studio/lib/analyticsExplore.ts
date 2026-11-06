import type { Condition, ConditionRule } from "@rescript/schema";
import type { AnalysisDefinition, AnalysisKind, ChartType, DatasetSpec, VariableMeta } from "@rescript/analytics";

/**
 * EXPLORE (Analytics upgrade M3) — the rules behind the interactive board, free of React so they are tested.
 *
 *   exploreDefinition   the variables a person picked → the analysis that fits them, with the reason in words:
 *                       one variable is described; a category by a category is a crosstab; a quantity by a
 *                       category is a comparison of means (the test that fits); quantities together are a
 *                       correlation; a third category layers the crosstab. Nothing is run that the variables
 *                       do not support.
 *   crossFilter         a category clicked in one chart → the condition the other panels are filtered by —
 *                       the same Condition the filter builder writes, so a saved filter and a click mean the same
 *   chartChoices        the chart types that fit a result's shape, for the switcher
 */

export type ExploreRole = "category" | "quantity" | "text" | "other";

export function exploreRole(v: VariableMeta): ExploreRole {
  switch (v.role) {
    case "categorical": case "multi": return "category";
    case "numeric": case "scale": return "quantity";
    case "text": return "text";
    default: return v.role === "date" ? "category" : "other";
  }
}

export interface ExploreChoice { definition: AnalysisDefinition; because: string; kind: AnalysisKind }

export function exploreDefinition(selected: readonly string[], vars: readonly VariableMeta[], dataset: DatasetSpec, opts: { filter?: Condition | null; name?: string } = {}): ExploreChoice | null {
  const picked = selected.map((n) => vars.find((v) => v.name === n)).filter((v): v is VariableMeta => !!v);
  if (!picked.length) return null;
  const label = (v: VariableMeta) => v.itemLabel ? `${v.label} — ${v.itemLabel}` : v.label;
  const cats = picked.filter((v) => exploreRole(v) === "category");
  const nums = picked.filter((v) => exploreRole(v) === "quantity");
  const texts = picked.filter((v) => exploreRole(v) === "text");
  const base = { dataset, ...(opts.filter ? { filter: opts.filter } : {}) };
  const named = (name: string, kind: AnalysisKind, variables: string[], extra: Partial<AnalysisDefinition> = {}): AnalysisDefinition => ({ name: opts.name ?? name, kind, variables, ...base, ...extra });

  if (picked.length === 1) {
    const v = picked[0];
    if (exploreRole(v) === "text") return { kind: "text", because: `${label(v)} is open text: its words, keywords and themes.`, definition: named(label(v), "text", [v.name]) };
    return { kind: "descriptive", because: exploreRole(v) === "quantity" ? `${label(v)} is a quantity: its distribution, mean and spread.` : `${label(v)} is a category: how the answers are shared out.`, definition: named(label(v), "descriptive", [v.name]) };
  }
  if (texts.length && picked.length === 2 && cats.length === 1) {
    return { kind: "text", because: `${label(texts[0])} by ${label(cats[0])}: what each group says.`, definition: named(`${label(texts[0])} by ${label(cats[0])}`, "text", [texts[0].name], { options: { by: cats[0].name } }) };
  }
  if (nums.length >= 2 && !cats.length) {
    return { kind: "correlation", because: `${nums.length === 2 ? `${label(nums[0])} and ${label(nums[1])} are` : `${nums.length} quantities are`} quantities: how strongly they move together.`, definition: named(nums.length === 2 ? `${label(nums[0])} and ${label(nums[1])}` : `Correlations among ${nums.map(label).join(", ")}`, "correlation", nums.map((v) => v.name)) };
  }
  if (nums.length >= 1 && cats.length >= 1) {
    const y = nums[0], g = cats[0];
    const groups = g.categories?.length ?? 0;
    const test = g.role === "multi" ? "t_independent" : groups > 2 ? "anova_one_way" : "t_independent";
    return { kind: "test", because: `${label(y)} is a quantity and ${label(g)} a category: its mean compared across the groups (${test === "anova_one_way" ? "one-way ANOVA" : "t-test"}).${nums.length > 1 || cats.length > 1 ? " Only the first quantity and the first category are used." : ""}`, definition: named(`${label(y)} by ${label(g)}`, "test", [y.name, g.name], { options: { test } }) };
  }
  if (cats.length >= 2) {
    const [r, c, l] = cats;
    return { kind: "crosstab", because: `${label(r)} by ${label(c)}${l ? `, within ${label(l)}` : ""}: both are categories, so a crosstab with column percentages and significance between columns.${cats.length > 3 ? " Only the first three are used." : ""}`,
      definition: named(`${label(r)} by ${label(c)}${l ? ` within ${label(l)}` : ""}`, "crosstab", [r.name, c.name, ...(l ? [l.name] : [])], { rows: [r.name], columns: [c.name], ...(l ? { layers: [l.name] } : {}), measure: "pct_col" }) };
  }
  return { kind: "descriptive", because: `${label(picked[0])}: described on its own — the other variables picked cannot be combined with it.`, definition: named(label(picked[0]), "descriptive", [picked[0].name]) };
}

/** the condition a clicked category means: `variable = code` (a multi: the option selected); null when the label is not a category of the variable */
export function crossFilter(v: VariableMeta, categoryLabel: string): ConditionRule | null {
  if (!v.questionId) return null;
  const cat = (v.categories ?? []).find((c) => c.label === categoryLabel || c.code === categoryLabel);
  if (!cat) return null;
  const numeric = (v.categories ?? []).every((c) => Number.isFinite(Number(c.code)));
  const value = numeric ? Number(cat.code) : cat.code;
  const source: ConditionRule["source"] = { kind: "question", ref: v.questionId, ...(v.rowCode ? { rowCode: v.rowCode } : {}) };
  return { type: "rule", source, operator: v.role === "multi" ? "selected" : "eq", value };
}

export interface CrossFilterState { variable: string; label: string; category: string; rule: ConditionRule }

/** the panels' filter: every active cross-filter, and the person's own filter, as one AND group — or null */
export function combinedFilter(own: Condition | null | undefined, cross: readonly CrossFilterState[]): Condition | null {
  const children: Condition[] = [...cross.map((c) => c.rule)];
  if (own && !(own.type === "group" && !own.children.length)) children.unshift(own);
  if (!children.length) return null;
  return children.length === 1 ? children[0] : { type: "group", op: "and", children };
}

/** the chart types the switcher offers for a result's shape, in a sensible order */
export function chartChoices(result: { chart: { categories?: string[]; series?: unknown[]; matrix?: unknown; points?: unknown[] }; recommendedCharts?: ChartType[] }, recommended: readonly { type: ChartType }[]): ChartType[] {
  const out: ChartType[] = [];
  const add = (...t: ChartType[]) => { for (const x of t) if (!out.includes(x)) out.push(x); };
  add(...recommended.map((r) => r.type));
  const c = result.chart;
  if (c.categories?.length && c.series?.length) add("bar_vertical", "bar_horizontal", (c.series.length > 1 ? "bar_grouped" : "donut"), "bar_stacked", "bar_stacked_100", "lollipop");
  if (c.matrix) add("heatmap", "bar_grouped", "bar_stacked_100");
  if (c.points?.length) add("scatter", "scatter_trendline");
  add(...(result.recommendedCharts ?? []));
  return out.slice(0, 8);
}

export const MAX_PICK = 4;

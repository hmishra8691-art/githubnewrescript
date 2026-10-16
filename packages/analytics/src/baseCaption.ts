import type { Condition, SurveyDefinition } from "@rescript/schema";
import { conditionSummary } from "@rescript/engine";
import type { AnalysisDefinition, AnalysisResult, DatasetSpec, WeightingSpec } from "./types.js";

/**
 * THE BASE CAPTION — one sentence under every result that says what the n
 * is a count OF (audit OR-03 / ANALYTICS-04, "the base of 20").
 *
 * A base can shrink for five reasons a reader cannot see in the number:
 * the environment (LIVE only), the status (completes only), the quality
 * rule (clean dataset), the analysis's own filter, and the question being
 * answered by a subset (display logic, a later version). Every screen and
 * export that prints a base prints it through this helper, so the scope is
 * always beside the number:
 *
 *   n = 20 · answered Q5 · 20 of 84 completes in scope (filter: Region = West; LIVE; clean dataset)
 *
 * Nothing here computes a number: it reads the result's `base` (what the
 * runner counted) and the definition's dataset spec (what the researcher
 * chose), and writes them down.
 */

export interface BaseCaptionInput {
  /** the result's base: total in the dataset, filtered by the analysis, n answered */
  base: AnalysisResult["base"];
  /** the variables the n is an answered count of (the result's `variablesUsed`) */
  variablesUsed?: string[];
  /** the analysis as run — its dataset spec, filter and weighting; a result's `provenance.definition` carries exactly this */
  definition?: Partial<Pick<AnalysisDefinition, "dataset" | "filter" | "filterIds" | "weighting" | "kind">> | null;
  /** the dataset spec when the definition does not carry one */
  spec?: DatasetSpec | null;
  /** the segment the figures on screen are for, when one is selected */
  segment?: { name: string; n: number } | null;
  /** variable name → label (question code, question text); defaults to the name */
  labelOf?: (variable: string) => string;
  /** the questionnaire, to write the filter in words; without it the filter is written from its rule */
  survey?: SurveyDefinition | null;
  /** the filter already in words (a saved filter's name) — wins over `definition.filter` */
  filterText?: string | null;
}

export interface BaseCaptionParts {
  /** "n = 20" or "n = 20 (weighted n = 18.4)" */
  n: string;
  /** "answered Q5", or null when the analysis is not about dataset variables */
  answered: string | null;
  /** "segment Females (n = 10)" when a segment is selected */
  segment: string | null;
  /** "20 of 84 completes in scope" / "84 completes in scope" */
  inScope: string;
  /** the scope in words: filter, environment, quality rule, statuses, date range, weighting */
  scope: string[];
}

const STATUS_WORDS: Record<string, string> = { complete: "complete", in_progress: "in progress", terminated: "terminated", quota_full: "quota full", screened: "screened out" };
const OPERATOR_WORDS: Record<string, string> = {
  eq: "=", neq: "≠", equals: "=", notEquals: "≠", gt: ">", gte: "≥", lt: "<", lte: "≤", in: "in", notIn: "not in", contains: "contains", notContains: "does not contain",
  selected: "selected", notSelected: "not selected", isEmpty: "is empty", isNotEmpty: "is not empty", answered: "answered", notAnswered: "not answered", between: "between",
};

/** the respondents the dataset spec admits, as a noun: "completes", "responses (complete, in progress)" */
export function statusWord(spec: Pick<DatasetSpec, "statuses"> | null | undefined): string {
  const statuses = spec?.statuses?.length ? spec.statuses : ["complete"];
  if (statuses.length === 1 && statuses[0] === "complete") return "completes";
  return `responses (${statuses.map((s) => STATUS_WORDS[s] ?? s).join(", ")})`;
}

/** the dataset spec in words, one phrase per rule that narrows it: environment, quality rule, date range */
export function scopeWords(spec: DatasetSpec | null | undefined): string[] {
  if (!spec) return [];
  const out: string[] = [];
  out.push(spec.environment === "ALL" ? "TEST + LIVE" : spec.environment);
  out.push(spec.dataset === "clean" ? "clean dataset" : spec.dataset === "custom" ? `quality: ${(spec.qualityClasses ?? []).join(", ") || "custom"}` : "all responses");
  if (spec.from || spec.to) out.push(spec.from && spec.to ? `from ${spec.from} to ${spec.to}` : spec.from ? `from ${spec.from}` : `to ${spec.to}`);
  return out;
}

/** the weighting in words, or null when the figures are unweighted */
export function weightingWords(w: WeightingSpec | null | undefined, labelOf: (v: string) => string = (v) => v): string | null {
  if (!w) return null;
  if (w.rim?.length) return `rim-weighted on ${w.rim.map((r) => labelOf(r.variable)).join(", ")}`;
  if (w.variable) return `weighted by ${labelOf(w.variable)}`;
  return null;
}

/** a condition written from its rule, for when the questionnaire is not at hand */
export function conditionWords(c: Condition | null | undefined, labelOf: (v: string) => string = (v) => v): string {
  if (!c) return "";
  if (c.type === "group") {
    const parts = c.children.map((ch) => conditionWords(ch, labelOf)).filter(Boolean);
    if (!parts.length) return "";
    if (c.op === "not") return parts.length === 1 ? `not ${parts[0]}` : `none of (${parts.join(" or ")})`;
    return parts.length === 1 ? parts[0] : `(${parts.join(c.op === "and" ? " and " : " or ")})`;
  }
  const ref = labelOf(String(c.source?.ref ?? ""));
  const op = OPERATOR_WORDS[c.operator] ?? c.operator;
  const value = c.value === undefined || c.value === null || c.value === "" ? "" : Array.isArray(c.value) ? c.value.map(String).join(", ") : String(c.value);
  const value2 = c.operator === "between" && c.value2 != null ? ` and ${String(c.value2)}` : "";
  return `${ref} ${op}${value ? ` ${value}` : ""}${value2}`.trim();
}

const fmt = (x: number) => (Number.isFinite(x) ? x.toLocaleString("en-US", { maximumFractionDigits: 1 }) : String(x));

export function baseCaptionParts(input: BaseCaptionInput): BaseCaptionParts {
  const { base } = input;
  const labelOf = input.labelOf ?? ((v: string) => v);
  const def = input.definition ?? null;
  const spec = def?.dataset ?? input.spec ?? null;
  const weighted = base.weightedN != null && Math.abs(base.weightedN - base.n) > 0.05;
  const n = `n = ${fmt(base.n)}${weighted ? ` (weighted n = ${fmt(base.weightedN)})` : ""}`;
  const vars = (input.variablesUsed ?? []).filter(Boolean);
  const answered = vars.length ? `answered ${vars.slice(0, 3).map(labelOf).join(", ")}${vars.length > 3 ? ` +${vars.length - 3} more` : ""}` : null;
  const segment = input.segment ? `segment ${input.segment.name} (n = ${fmt(input.segment.n)})` : null;
  const word = statusWord(spec);
  const inScope = base.filtered !== base.total ? `${fmt(base.filtered)} of ${fmt(base.total)} ${word} in scope` : `${fmt(base.total)} ${word} in scope`;
  const scope: string[] = [];
  const filterText = input.filterText ?? (def?.filter ? (input.survey ? conditionSummary(input.survey, def.filter) : "") || conditionWords(def.filter, labelOf) : "");
  if (filterText) scope.push(`filter: ${filterText}`);
  else if (def?.filterIds?.length) scope.push(`${def.filterIds.length === 1 ? "a saved filter" : `${def.filterIds.length} saved filters`} applied`);
  scope.push(...scopeWords(spec));
  const w = weightingWords(def?.weighting, labelOf);
  if (w) scope.push(w);
  return { n, answered, segment, inScope, scope };
}

/** the whole caption on one line */
export function baseCaption(input: BaseCaptionInput): string {
  const p = baseCaptionParts(input);
  const head = [p.n, p.answered, p.segment, p.inScope].filter(Boolean).join(" · ");
  return p.scope.length ? `${head} (${p.scope.join("; ")})` : head;
}

/* ------------------------------------------------------------ plan runs */

/**
 * What a plan run was computed on, recorded with the run (additive, inside
 * the run's `dataset` JSON) so a stored run can say its scope later without
 * the dataset being rebuilt.
 */
export interface RunScope {
  environment: DatasetSpec["environment"];
  dataset: DatasetSpec["dataset"];
  statuses: string[];
  qualityClasses?: string[];
  from?: string;
  to?: string;
  /** respondents the dataset spec admitted (status, environment, quality) */
  nInScope: number;
  /** respondents before those exclusions */
  nTotal: number;
  /** the distinct weightings the run's items used; empty when every item was unweighted */
  weightings: WeightingSpec[];
  /** the names of the run's items that carry their own filter — their bases are narrower than the run's */
  filteredItems: string[];
}

export function runScopeOf(ds: { cases: unknown[]; total: number; spec: DatasetSpec }, items: readonly { definition: Pick<AnalysisDefinition, "name" | "filter" | "filterIds" | "weighting"> }[]): RunScope {
  const seen = new Set<string>(); const weightings: WeightingSpec[] = [];
  for (const it of items) { const w = it.definition.weighting; if (!w) continue; const k = JSON.stringify(w); if (!seen.has(k)) { seen.add(k); weightings.push(w); } }
  return {
    environment: ds.spec.environment, dataset: ds.spec.dataset, statuses: ds.spec.statuses?.length ? [...ds.spec.statuses] : ["complete"],
    ...(ds.spec.qualityClasses?.length ? { qualityClasses: [...ds.spec.qualityClasses] } : {}), ...(ds.spec.from ? { from: ds.spec.from } : {}), ...(ds.spec.to ? { to: ds.spec.to } : {}),
    nInScope: ds.cases.length, nTotal: ds.total, weightings,
    filteredItems: items.filter((it) => it.definition.filter || it.definition.filterIds?.length).map((it) => it.definition.name),
  };
}

/** the run's base in one line: "n = 40 completes in scope (LIVE; clean dataset; 2 analyses carry their own filter)" */
export function runCaption(run: { n: number; environment: DatasetSpec["environment"] }, scope?: RunScope | null, labelOf: (v: string) => string = (v) => v): string {
  const spec: DatasetSpec = scope ? { environment: scope.environment, dataset: scope.dataset, statuses: scope.statuses, ...(scope.qualityClasses ? { qualityClasses: scope.qualityClasses } : {}), ...(scope.from ? { from: scope.from } : {}), ...(scope.to ? { to: scope.to } : {}) } : { environment: run.environment, dataset: "all" };
  const words = scope ? scopeWords(spec) : [run.environment === "ALL" ? "TEST + LIVE" : run.environment];
  if (scope) {
    for (const w of scope.weightings) { const t = weightingWords(w, labelOf); if (t) words.push(t); }
    if (scope.filteredItems.length) words.push(`${scope.filteredItems.length} ${scope.filteredItems.length === 1 ? "analysis carries" : "analyses carry"} ${scope.filteredItems.length === 1 ? "its" : "their"} own filter`);
  }
  const head = scope && scope.nTotal !== scope.nInScope ? `n = ${fmt(run.n)} of ${fmt(scope.nTotal)} ${statusWord(spec)} in scope` : `n = ${fmt(run.n)} ${statusWord(spec)} in scope`;
  return `${head} (${words.join("; ")})`;
}

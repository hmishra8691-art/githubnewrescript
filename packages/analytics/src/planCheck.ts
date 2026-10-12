import type { AnalysisDefinition } from "./types.js";
import type { VariableMeta } from "./dataset.js";
import type { PlannedAnalysis } from "./planBridge.js";
import { scaleOf } from "./questionChart.js";
import type { SurveyDefinition } from "@rescript/schema";
import { isNonQuestionVariable } from "@rescript/engine";

/**
 * ONE CHECK FOR EVERY ANALYSIS BEFORE IT IS KEPT — generated or hand-built.
 *
 * The plan generator and the workspace could both put an analysis in front of
 * the researcher that could not be computed (a variable that is not in the
 * survey, a mean of a text answer, a crosstab with nothing on one axis) or
 * that repeated another (a chi-square test beside the crosstab that already
 * carries the same chi-square). Those then ran, "failed" into a warning, and
 * showed as blank or wall-of-warning results. They are caught here instead,
 * with a reason the researcher can act on.
 */
export type IssueCode = "unknown_variable" | "no_variables" | "missing_axis" | "wrong_type" | "needs_groups" | "same_variable";
export interface PlanIssue { code: IssueCode; message: string; variables?: string[]; severity: "error" | "warning" }

const NUMERIC_KINDS = new Set(["regression", "correlation", "factor", "reliability", "cluster"]);

/** Names the analysis refers to that the dataset does not know. */
export function unknownVariables(def: Pick<AnalysisDefinition, "variables" | "rows" | "columns" | "segments">, known: { has(n: string): boolean }): string[] {
  const refs = [...(def.variables ?? []), ...(def.rows ?? []), ...(def.columns ?? [])].filter(Boolean);
  return [...new Set(refs.filter((v) => !known.has(v)))];
}

/** `extra` is either more known names, or a predicate for "is this name known" (see surveyKnownNames) */
export type KnownNames = Iterable<string> | ((name: string) => boolean);
const knownSet = (variables: readonly VariableMeta[], extra: KnownNames): { has(n: string): boolean } => {
  const base = new Set(variables.map((v) => v.name));
  if (typeof extra === "function") return { has: (n) => base.has(n) || extra(n) };
  for (const n of extra) base.add(n);
  return base;
};

export function validateAnalysis(def: AnalysisDefinition, variables: readonly VariableMeta[], extraNames: KnownNames = []): PlanIssue[] {
  const known = knownSet(variables, extraNames);
  const meta = new Map(variables.map((v) => [v.name, v]));
  const out: PlanIssue[] = [];
  const dead = unknownVariables(def, known);
  if (dead.length) out.push({ code: "unknown_variable", severity: "error", variables: dead, message: `${dead.join(", ")} ${dead.length === 1 ? "is" : "are"} not in this survey's data.` });
  if (def.kind === "crosstab") {
    if (!(def.rows?.length) || !(def.columns?.length)) out.push({ code: "missing_axis", severity: "error", message: "A crosstab needs at least one row variable and one column variable." });
    const same = (def.rows ?? []).filter((r) => (def.columns ?? []).includes(r));
    if (same.length) out.push({ code: "same_variable", severity: "error", variables: same, message: `${same.join(", ")} is tabulated against itself.` });
  } else if (def.kind !== "quality" && def.kind !== "weighting" && !(def.variables?.length)) {
    out.push({ code: "no_variables", severity: "error", message: "This analysis has no variables chosen." });
  }
  if (NUMERIC_KINDS.has(def.kind)) {
    const bad = (def.variables ?? []).filter((v) => { const s = scaleOf(meta.get(v)); return s === "text" || s === "nominal" && def.kind !== "regression" && def.kind !== "cluster"; });
    if (bad.length && !dead.length) out.push({ code: "wrong_type", severity: "error", variables: bad, message: `${def.kind} needs numeric or scale variables; ${bad.join(", ")} ${bad.length === 1 ? "is" : "are"} categorical or text.` });
  }
  if (def.kind === "descriptive" && (def.options?.statistic === "mean" || def.measure === "mean")) {
    const bad = (def.variables ?? []).filter((v) => { const s = scaleOf(meta.get(v)); return s === "text" || s === "nominal" || s === "multi"; });
    if (bad.length && !dead.length) out.push({ code: "wrong_type", severity: "error", variables: bad, message: `A mean needs a numeric or scale variable; ${bad.join(", ")} ${bad.length === 1 ? "is" : "are"} not.` });
  }
  if (def.kind === "test" && !dead.length && (def.variables?.length ?? 0) < 2) out.push({ code: "needs_groups", severity: "error", message: "A significance test compares an outcome across a grouping or a second variable — one variable is not enough." });
  if (def.kind === "test" && !dead.length && (def.variables?.length ?? 0) >= 2 && new Set(def.variables).size < 2) out.push({ code: "same_variable", severity: "error", variables: [...new Set(def.variables)], message: `${def.variables![0]} is tested against itself.` });
  return out;
}

/* ------------------------------------------------------------------ duplicates */

const sorted = (a?: readonly string[]) => [...(a ?? [])].sort().join("|");
const canon = (o: unknown): string => JSON.stringify(o, (_k, v) => (v && typeof v === "object" && !Array.isArray(v) ? Object.fromEntries(Object.keys(v).sort().map((k) => [k, (v as Record<string, unknown>)[k]])) : v));

/** What an analysis IS, independent of its name, folder and bookkeeping. Two with the same signature compute the same numbers. */
export function analysisSignature(def: AnalysisDefinition): string {
  const o = { ...(def.options ?? {}) } as Record<string, unknown>;
  /* presentation and bookkeeping — they change how the table looks or where it came from, not a number in it */
  for (const k of ["planned", "plannedHash", "requested", "hypotheses", "formatting", "title", "subtitle", "layout", "significance", "decimals", "sigLevel", "alpha"]) delete o[k];
  if (def.kind === "crosstab") return `crosstab:${sorted(def.rows)}>${sorted(def.columns)}:${def.measure ?? "pct_col"}:${canon(o)}:${canon(def.filter ?? null)}:${canon(def.dataset ?? null)}`;
  return `${def.kind}:${(def.variables ?? []).join("|")}:${canon(o)}:${canon(def.filter ?? null)}:${canon(def.dataset ?? null)}`;
}

/** the chi-square a crosstab already prints for its one row × one column pair — a separate test for the same pair repeats it */
export const crosstabCarriesChiSquare = (x: AnalysisDefinition, t: AnalysisDefinition): boolean =>
  x.kind === "crosstab" && t.kind === "test" && (t.options?.test === "chi_square" || t.options?.test === "auto")
  && (x.rows?.length === 1 && x.columns?.length === 1) && (t.variables?.length === 2)
  && ((x.rows![0] === t.variables[0] && x.columns![0] === t.variables[1]) || (x.rows![0] === t.variables[1] && x.columns![0] === t.variables[0]));

export interface DroppedPlanItem { item: PlannedAnalysis; reason: string; duplicateOf?: string }

/**
 * The planned items worth keeping: dead references and uncomputable items are
 * blocked (with the reason), exact repeats and tests a crosstab already
 * carries are dropped (naming what they repeat). Order is preserved.
 */
export function reviewPlanned(items: readonly PlannedAnalysis[], variables: readonly VariableMeta[], extraNames: KnownNames = []): { kept: PlannedAnalysis[]; blocked: (DroppedPlanItem & { issues: PlanIssue[] })[]; duplicates: DroppedPlanItem[] } {
  const extra = extraNames;
  const kept: PlannedAnalysis[] = []; const blocked: (DroppedPlanItem & { issues: PlanIssue[] })[] = []; const duplicates: DroppedPlanItem[] = [];
  const seen = new Map<string, PlannedAnalysis>();
  for (const it of items) {
    const issues = validateAnalysis(it.definition, variables, extra).filter((i) => i.severity === "error");
    if (issues.length) { blocked.push({ item: it, reason: issues.map((i) => i.message).join(" "), issues }); continue; }
    const sig = analysisSignature(it.definition);
    const same = seen.get(sig);
    if (same) { duplicates.push({ item: it, reason: "It computes exactly what another planned analysis already does.", duplicateOf: same.definition.name }); continue; }
    const carrier = kept.find((k) => crosstabCarriesChiSquare(k.definition, it.definition));
    if (carrier) { duplicates.push({ item: it, reason: "The crosstab for the same two variables already reports this chi-square test.", duplicateOf: carrier.definition.name }); continue; }
    /* a test planned BEFORE its crosstab: the crosstab wins and the test is removed from what was kept */
    const idx = kept.findIndex((k) => crosstabCarriesChiSquare(it.definition, k.definition));
    if (idx >= 0) { duplicates.push({ item: kept[idx], reason: "The crosstab for the same two variables already reports this chi-square test.", duplicateOf: it.definition.name }); kept.splice(idx, 1); }
    seen.set(sig, it); kept.push(it);
  }
  return { kept, blocked, duplicates };
}

/** an already-saved analysis (hand-built or earlier-planned) that a new planned item would repeat */
export function findExistingDuplicate(def: AnalysisDefinition, existing: readonly { id: string; name: string; definition: AnalysisDefinition }[]): { id: string; name: string } | null {
  const sig = analysisSignature(def);
  for (const e of existing) {
    if (analysisSignature(e.definition) === sig) return { id: e.id, name: e.name };
    if (crosstabCarriesChiSquare(e.definition, def) || crosstabCarriesChiSquare(def, e.definition)) return { id: e.id, name: e.name };
  }
  return null;
}

/** an analysis made by the plan generator, as opposed to one a person built or added */
export const isPlanned = (def: Pick<AnalysisDefinition, "options">): boolean => typeof def.options?.planned === "string" && def.options.planned.length > 0;

/**
 * Every name an analysis may legitimately read in this survey: the dataset's
 * variables, every question's variable name and code (design tasks — conjoint,
 * MaxDiff — are read through their question, not as a column), and the names
 * the plan computes itself (derived variables, segments, calculations, embedded data).
 */
export function surveyKnownNames(def: SurveyDefinition, variables: readonly VariableMeta[]): (name: string) => boolean {
  const out = new Set<string>(variables.map((v) => v.name));
  for (const q of def.questions) { if (q.variableName) out.add(q.variableName); if (q.code) out.add(q.code); }
  return (name) => out.has(name) || isNonQuestionVariable(def, name);
}

/**
 * The full review for "create the planned analyses": dead / uncomputable items
 * blocked, repeats collapsed, and anything the researcher already has — a
 * planned item saved earlier (by its planned id), or a hand-built analysis that
 * computes the same thing under any name — left alone. Pure, so the same
 * decision is made (and tested) wherever it is needed.
 */
export interface SavedAnalysisRef { id: string; name: string; definition: AnalysisDefinition }
export function reviewAgainstSaved(
  items: readonly PlannedAnalysis[], variables: readonly VariableMeta[], known: KnownNames, saved: readonly SavedAnalysisRef[],
): { toCreate: PlannedAnalysis[]; existingFor: Map<string, string>; blocked: { name: string; reason: string }[]; duplicates: { name: string; reason: string; duplicateOf?: string }[] } {
  const review = reviewPlanned(items, variables, known);
  const blocked = review.blocked.map((b) => ({ name: b.item.definition.name, reason: b.reason }));
  const duplicates = review.duplicates.map((d) => ({ name: d.item.definition.name, reason: d.reason, ...(d.duplicateOf ? { duplicateOf: d.duplicateOf } : {}) }));
  const byPlanned = new Map<string, string>();
  for (const r of saved) { const p = r.definition?.options?.planned; if (typeof p === "string" && p && !byPlanned.has(p)) byPlanned.set(p, r.id); }
  const toCreate: PlannedAnalysis[] = []; const existingFor = new Map<string, string>(byPlanned);
  for (const it of review.kept) {
    const planned = String(it.definition.options?.planned ?? "");
    if (planned && byPlanned.has(planned)) continue;   // already saved from this very plan item
    const mine = findExistingDuplicate(it.definition, saved);
    if (mine) { duplicates.push({ name: it.definition.name, reason: "You already have an analysis that computes this.", duplicateOf: mine.name }); if (planned) existingFor.set(planned, mine.id); continue; }
    toCreate.push(it);
  }
  return { toCreate, existingFor, blocked, duplicates };
}

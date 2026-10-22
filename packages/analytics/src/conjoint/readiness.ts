/**
 * ENTRY POINTS FOR THE ANALYSIS PLAN (F4 → F3, 2026-10-22).
 *
 * `conjointSuiteReadiness(ds, variable)` — what a conjoint question can be analysed with NOW, on
 * this data: each estimator (aggregate / HB / CVA least squares) with ready + the reason when not,
 * read from the definition (engine `conjointPlanReadiness`) and the answers (respondents, tasks).
 *
 * `conjointAnalysisDefinitions(def | ds, variable, spec)` — the AnalysisDefinitions a plan item runs:
 * kind `conjoint` (synchronous: aggregate logit / ACBC / menu item logits / CVA OLS, counts,
 * simulator) and kind `hb` (individual-level; a chunked job past one request). Pass `simulator` to
 * attach a scenario; saved scenarios on the design (simulate_conjoint) are read automatically.
 */
import type { SurveyDefinition } from "@rescript/schema";
import { conjointMethodOf, conjointPlanReadiness, type ConjointMethod } from "@rescript/engine";
import type { AnalysisDefinition, DatasetSpec } from "../types.js";
import type { Dataset } from "../dataset.js";
import { acbcRespondentSets } from "./acbc.js";
import { cvaData } from "./cva.js";
import { menuTasks } from "./menu.js";
import { cbcRespondentSets } from "../analyses/choice.js";
import type { SimulatorSpec } from "./simulatorTables.js";

export interface SuiteEstimatorReadiness { id: string; label: string; kind: "conjoint" | "hb"; options: Record<string, unknown>; ready: boolean; reason?: string }
export interface SuiteReadiness { variable: string; method: ConjointMethod | null; respondents: number; ready: boolean; issues: string[]; estimators: SuiteEstimatorReadiness[]; simulator: boolean }

const questionOf = (def: SurveyDefinition, variable: string) => def.questions.find((q) => q.variableName === variable || q.code === variable || q.id === variable || `${q.variableName}_TASKS` === variable);

/** data-aware readiness of every estimator for one conjoint question */
export function conjointSuiteReadiness(ds: Dataset, variable: string): SuiteReadiness {
  const q = questionOf(ds.def, variable);
  if (!q) return { variable, method: null, respondents: 0, ready: false, issues: [`There is no question “${variable}”.`], estimators: [], simulator: false };
  const plan = conjointPlanReadiness(ds.def, q);
  const issues = [...plan.issues];
  let respondents = 0, tasks = 0, p = 0;
  if (plan.method === "acbc") { const s = acbcRespondentSets(ds, q.id); respondents = s?.respondents.length ?? 0; tasks = s?.respondents.reduce((t, r) => t + r.sets.length, 0) ?? 0; p = s?.coding.p ?? 0; }
  else if (plan.method === "menu") { const m = menuTasks(ds, q.id); respondents = m?.respondents.length ?? 0; tasks = m?.respondents.reduce((t, r) => t + r.tasks.length, 0) ?? 0; p = 2 * (m?.items.filter((i) => !i.required).length ?? 0); }
  else if (plan.method === "cva") { const c = cvaData(ds, q.id); respondents = c?.respondents.length ?? 0; tasks = c?.respondents.reduce((t, r) => t + r.obs.length, 0) ?? 0; p = c ? c.attrs.reduce((t, a) => t + a.levels.length - 1, 0) + 1 : 0; }
  else if (plan.method === "cbc") { const s = cbcRespondentSets(ds, q.id); respondents = s?.respondents.length ?? 0; tasks = s?.respondents.reduce((t, r) => t + r.sets.length, 0) ?? 0; p = s?.coding.p ?? 0; }
  if (!respondents) issues.push("No answers recorded yet.");
  const estimators: SuiteEstimatorReadiness[] = plan.estimators.map((e) => {
    if (!e.available) return { id: e.id, label: e.label, kind: e.kind, options: e.options, ready: false, reason: e.reason };
    if (!respondents) return { id: e.id, label: e.label, kind: e.kind, options: e.options, ready: false, reason: "No answers yet." };
    if (e.kind === "hb" && respondents < 20) return { id: e.id, label: e.label, kind: e.kind, options: e.options, ready: false, reason: `Hierarchical Bayes needs at least 20 respondents (${respondents} so far).` };
    if (plan.method !== "cva" && tasks < p * 3) return { id: e.id, label: e.label, kind: e.kind, options: e.options, ready: false, reason: `${tasks} choices are too few for ${p} parameters.` };
    return { id: e.id, label: e.label, kind: e.kind, options: e.options, ready: true };
  });
  return { variable: q.variableName ?? variable, method: plan.method, respondents, ready: issues.length === 0 && estimators.some((e) => e.ready), issues, estimators, simulator: plan.simulator };
}

/** the analysis definitions a plan item for this conjoint question runs (aggregate first, then HB when the method has it) */
export function conjointAnalysisDefinitions(def: SurveyDefinition, variable: string, spec: { dataset?: DatasetSpec; simulator?: SimulatorSpec; hbOptions?: Record<string, unknown> } = {}): AnalysisDefinition[] {
  const q = questionOf(def, variable);
  if (!q) return [];
  const info = conjointMethodOf(def, q);
  if (!info) return [];
  const plan = conjointPlanReadiness(def, q);
  const dataset = spec.dataset ?? { environment: "LIVE", dataset: "all" };
  const v = q.variableName ?? variable;
  const label: Record<ConjointMethod, string> = { cbc: "Conjoint", acbc: "ACBC", menu: "Menu-based conjoint", cva: "Rating-based conjoint" };
  return plan.estimators.filter((e) => e.available).map((e) => ({
    name: `${label[info.method]} — ${e.label} (${q.code})`, kind: e.kind, dataset, variables: [v],
    options: { ...e.options, ...(e.kind === "hb" ? spec.hbOptions ?? {} : {}), ...(spec.simulator ? { simulator: spec.simulator } : {}) },
  }));
}

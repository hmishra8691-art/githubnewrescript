import type { DesignReference, Question, SurveyDefinition } from "@rescript/schema";
import { designRowsFor } from "./designVersion.js";

/**
 * THE CONJOINT SUITE — what the engine needs to know about each conjoint method (F4, 2026-10-22).
 *
 * One `conjoint_task` question type carries four methods, told apart by the DESIGN it points at
 * (the menu precedent): a `conjoint` design is CBC (optionally dual-response None, alternative-
 * specific / labelled), `menu` is menu-based, `cva` is rating-based; `acbc_task` is adaptive. The
 * runtime, validation, exports and the analysis all ask `conjointMethodOf` rather than re-reading
 * the config, so a method means the same thing everywhere.
 *
 * DUAL-RESPONSE NONE is stored IN the task answer object under `<task>_buy` ("yes" | "no"), beside
 * the forced choice `<task>`. Every reader that walks task keys looks up a design task first, so a
 * `_buy` key is invisible to code written before it (the CBC model, the stacked file, the HB data);
 * the readers that need it ask `dualKey` / `isDualKey`.
 */

export type ConjointMethod = "cbc" | "menu" | "acbc" | "cva";
export interface ConjointMethodInfo {
  method: ConjointMethod;
  design: DesignReference | undefined;
  /** CBC with a forced choice + "would you buy it?" */
  dualResponse: boolean;
  /** CBC with brand-specific attributes or labelled alternatives */
  alternativeSpecific: boolean;
  labelled: boolean;
  /** menu with mutually exclusive sections */
  exclusiveGroups: boolean;
  /** ACBC with a summed price */
  summedPrice: boolean;
  /** CVA: single profiles or pairs, and the rating scale */
  cva?: { mode: "single" | "paired"; min: number; max: number; minLabel?: string; maxLabel?: string };
}

export const DUAL_SUFFIX = "_buy";
export const dualKey = (task: string | number): string => `${task}${DUAL_SUFFIX}`;
export const isDualKey = (k: string): boolean => k.endsWith(DUAL_SUFFIX);
export const DEFAULT_DUAL_PROMPT = "Would you actually buy the option you chose?";

export function designOfQuestion(def: SurveyDefinition, q: Question): DesignReference | undefined {
  const ref = (q.settings as { designRef?: string } | undefined)?.designRef;
  return ref ? (def.designs ?? []).find((d) => d.id === ref) : undefined;
}

/** which conjoint method a question runs (null for any other question) */
export function conjointMethodOf(def: SurveyDefinition, q: Question): ConjointMethodInfo | null {
  if (q.type !== "conjoint_task" && q.type !== "acbc_task") return null;
  const design = designOfQuestion(def, q);
  const cfg = (design?.config ?? {}) as Record<string, unknown>;
  const base = { design, dualResponse: false, alternativeSpecific: false, labelled: false, exclusiveGroups: false, summedPrice: false };
  if (q.type === "acbc_task") return { ...base, method: "acbc", summedPrice: cfg.priceBase != null || (Array.isArray(cfg.priceIncrements) && cfg.priceIncrements.length > 0) };
  if (design?.kind === "menu") return { ...base, method: "menu", exclusiveGroups: Array.isArray(cfg.exclusiveGroups) && cfg.exclusiveGroups.some((l) => typeof l === "string" && l.trim()) };
  if (design?.kind === "cva") {
    const mode = cfg.mode === "paired" ? "paired" : "single";
    const min = Number.isFinite(Number(cfg.scaleMin)) && cfg.scaleMin !== null && cfg.scaleMin !== "" ? Number(cfg.scaleMin) : mode === "paired" ? 1 : 0;
    const max = Number.isFinite(Number(cfg.scaleMax)) && cfg.scaleMax !== null && cfg.scaleMax !== "" ? Number(cfg.scaleMax) : mode === "paired" ? 9 : 10;
    return { ...base, method: "cva", cva: { mode, min, max, ...(typeof cfg.minLabel === "string" && cfg.minLabel.trim() ? { minLabel: cfg.minLabel.trim() } : {}), ...(typeof cfg.maxLabel === "string" && cfg.maxLabel.trim() ? { maxLabel: cfg.maxLabel.trim() } : {}) } };
  }
  const alt = cfg.labelled === true || (Array.isArray(cfg.alternativeSpecific) && cfg.alternativeSpecific.some((l) => (typeof l === "string" && l.trim()) || (l && typeof l === "object")));
  return { ...base, method: "cbc", dualResponse: cfg.dualResponseNone === true, alternativeSpecific: alt, labelled: cfg.labelled === true };
}

/** the follow-up question of a dual-response design */
export function dualPrompt(design: DesignReference | undefined): string {
  const t = (design?.config as { dualResponsePrompt?: unknown } | undefined)?.dualResponsePrompt;
  return typeof t === "string" && t.trim() ? t.trim() : DEFAULT_DUAL_PROMPT;
}

export interface CvaTaskView { task: string; holdout: boolean; profiles: { alt: string; levels: Record<string, string> }[] }

/** the CVA tasks a respondent rates, in design order (their version, from the seed) */
export function cvaTasksFor(def: SurveyDefinition, q: Question, seed: number | string | null | undefined): CvaTaskView[] {
  const design = designOfQuestion(def, q);
  const all = (design?.file?.rows ?? []) as Record<string, unknown>[];
  if (!all.length) return [];
  const s = seed == null || (seed as unknown) === "" ? NaN : Number(seed);
  const rows = Number.isFinite(s) ? designRowsFor(q, all, s) : all.filter((r) => String(r.version ?? "1") === "1");
  const attrs = (design?.file?.columns ?? []).filter((c) => !["version", "task", "alt", "is_holdout"].includes(c));
  const tasks = new Map<string, CvaTaskView>();
  for (const r of rows) {
    const t = String(r.task);
    const view = tasks.get(t) ?? tasks.set(t, { task: t, holdout: Number(r.is_holdout) === 1, profiles: [] }).get(t)!;
    view.profiles.push({ alt: String(r.alt ?? 1), levels: Object.fromEntries(attrs.map((a) => [a, String(r[a] ?? "")])) });
  }
  for (const v of tasks.values()) v.profiles.sort((a, b) => Number(a.alt) - Number(b.alt));
  return [...tasks.values()].sort((a, b) => Number(a.task) - Number(b.task));
}

/**
 * PLAN READINESS (for the analysis plan, F3): what a conjoint question can be analysed with, read
 * from the definition alone (no data). Each estimator names the Data Analytics kind and options
 * that run it — `conjoint` (aggregate, synchronous), `hb` (individual-level, chunked job) — and
 * whether it is available for this method, with the reason when not.
 */
export interface ConjointEstimatorPlan { id: string; label: string; kind: "conjoint" | "hb"; options: Record<string, unknown>; available: boolean; reason?: string }
export interface ConjointPlanReadiness {
  question: string;
  method: ConjointMethod | null;
  ready: boolean;
  issues: string[];
  estimators: ConjointEstimatorPlan[];
  /** the simulator reads the estimator's utilities (share, revenue, WTP, demand, optimisation) */
  simulator: boolean;
}

export function conjointPlanReadiness(def: SurveyDefinition, q: Question): ConjointPlanReadiness {
  const info = conjointMethodOf(def, q);
  const out: ConjointPlanReadiness = { question: q.variableName ?? q.code, method: info?.method ?? null, ready: false, issues: [], estimators: [], simulator: false };
  if (!info) { out.issues.push(`${q.code} is not a conjoint question.`); return out; }
  if (!info.design) { out.issues.push(`${q.code} has no design — generate one in Design Generators (or with create_conjoint).`); return out; }
  if (info.method !== "acbc" && !(info.design.file?.rows?.length)) out.issues.push(`${q.code}'s design has no rows — generate it.`);
  const v = q.variableName ?? q.code;
  const E = (id: string, label: string, kind: "conjoint" | "hb", options: Record<string, unknown> = {}, available = true, reason?: string): ConjointEstimatorPlan => ({ id, label, kind, options, available, ...(reason ? { reason } : {}) });
  switch (info.method) {
    case "cbc":
      out.estimators.push(E("cbc_aggregate", info.dualResponse ? "Aggregate logit (dual-response None)" : "Aggregate logit", "conjoint"));
      out.estimators.push(E("cbc_hb", "Hierarchical Bayes (individual utilities)", "hb"));
      if (info.dualResponse) out.estimators.push(E("cbc_forced", "Aggregate logit, forced choice only (None not estimated)", "conjoint", { dualCoding: "forced" }));
      break;
    case "acbc":
      out.estimators.push(E("acbc_aggregate", "ACBC aggregate logit + counts (quick look)", "conjoint"));
      out.estimators.push(E("acbc_hb", "ACBC hierarchical Bayes (BYO + screening + tournament)", "hb"));
      break;
    case "menu":
      out.estimators.push(E("menu_aggregate", "Menu: per-item logits (own and cross price) + counts", "conjoint"));
      out.estimators.push(E("menu_hb", "Menu: hierarchical Bayes over the item choices", "hb"));
      break;
    case "cva":
      out.estimators.push(E("cva_ols", "Rating-based: per-respondent least squares", "conjoint"));
      out.estimators.push(E("cva_hb", "Hierarchical Bayes", "hb", {}, false, "CVA utilities are estimated per respondent by least squares (every respondent rates enough profiles); HB-MNL is a choice model."));
      break;
  }
  out.simulator = true;
  out.ready = out.issues.length === 0;
  void v;
  return out;
}

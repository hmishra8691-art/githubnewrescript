import type { AnalysisDefinition, AnalysisResult, DatasetSpec, ResultProvenance } from "./types.js";
import { canonicalJson, hash64, sortKeys } from "./canonical.js";
import { hashDefinition } from "./analyses/common.js";

/**
 * THE VERSION OF THE COMPUTATIONS. Bump it whenever a change could alter a number a result shows (a statistic, a base, a
 * significance rule): stored and cached results carry it, so one computed by an older engine is recomputed rather than
 * served as if it were current.
 *
 *   2026.10.1  Phase 0 of the audit — Holm-adjusted letters, weighted CIs, Type II ANOVA, answered bases, regression checks
 *   2026.10.2  Phase 3 — a result carries the one question-aware chart choice (advice) every surface reads; chart rules, small bases
 *   2026.10.3  Phase 7 — exact p for thin 2×2 tables, tie-corrected rank tests, adjusted "+/−" against the total, no means of nominal variables
 */
export const ANALYTICS_ENGINE_VERSION = "2026.10.3";

export interface InputsOf { dataVersion?: string | null; surveyVersion?: string | null }

/** the hash of everything that decides a result's numbers: equal inputs, equal hash */
export function inputHashOf(def: AnalysisDefinition, inputs: InputsOf = {}, engineVersion: string = ANALYTICS_ENGINE_VERSION): string {
  return hash64(canonicalJson({ d: hashDefinition(def), ds: def.dataset, data: inputs.dataVersion ?? null, sv: inputs.surveyVersion ?? null, e: engineVersion }));
}

/** the provenance record for a result just computed (or about to be asked for) */
export function provenanceOf(def: AnalysisDefinition, dataset: { dataVersion?: string; surveyVersion?: string; spec?: DatasetSpec }, result: Pick<AnalysisResult, "computedAt">, durationMs: number): ResultProvenance {
  const dataVersion = dataset.dataVersion ?? null, surveyVersion = dataset.surveyVersion ?? null;
  return {
    definition: sortKeys(def) as AnalysisDefinition, definitionHash: hashDefinition(def), dataset: def.dataset ?? dataset.spec as DatasetSpec,
    dataVersion, surveyVersion, engineVersion: ANALYTICS_ENGINE_VERSION, inputHash: inputHashOf(def, { dataVersion, surveyVersion }),
    computedAt: result.computedAt, durationMs: Math.max(0, Math.round(durationMs * 10) / 10),
  };
}

/** is a stored result still what this analysis would compute now? (same inputs, same engine) */
export const isCurrent = (stored: Pick<AnalysisResult, "provenance"> | null | undefined, def: AnalysisDefinition, inputs: InputsOf): boolean =>
  !!stored?.provenance && stored.provenance.engineVersion === ANALYTICS_ENGINE_VERSION && stored.provenance.inputHash === inputHashOf(def, inputs);

/** the first engine version whose numbers are the corrected ones (Phase 0): a result older than this, or one that records no version at all, may carry the old numbers */
export const NUMBERS_CORRECTED_IN = "2026.10.3";

const versionParts = (v: string) => v.split(".").map((x) => Number.parseInt(x, 10) || 0);
export function versionBefore(a: string, b: string): boolean {
  const x = versionParts(a), y = versionParts(b);
  for (let i = 0; i < Math.max(x.length, y.length); i++) { const d = (x[i] ?? 0) - (y[i] ?? 0); if (d) return d < 0; }
  return false;
}

export interface MethodFlag { count: number; total: number; recorded: number; text: string }

/**
 * Does a frozen set of results (a published report, a share) carry numbers an earlier version of the computations
 * produced? Old reports are flagged, never rewritten: the published numbers stay as published, and the reader is told.
 * null when every result was computed by the corrected engine.
 */
export function methodFlag(results: Record<string, Pick<AnalysisResult, "provenance"> | null | undefined>): MethodFlag | null {
  const all = Object.values(results).filter(Boolean) as Pick<AnalysisResult, "provenance">[];
  const old = all.filter((r) => !r.provenance || versionBefore(r.provenance.engineVersion, NUMBERS_CORRECTED_IN));
  if (!old.length) return null;
  const recorded = old.filter((r) => r.provenance).length;
  return {
    count: old.length, total: all.length, recorded,
    text: `${old.length === all.length ? "These numbers were" : `${old.length} of ${all.length} analyses were`} computed with an earlier method${recorded ? "" : " (the result records none)"}. Since then, significance letters allow for the number of comparisons, confidence intervals use the weights, bases count only the people who answered, small samples get exact or tie-corrected tests, and several charts have been corrected. Recompute and publish again to bring them up to date; this version is kept as it was published.`,
  };
}

import type { AnalysisDefinition, AnalysisResult, DatasetSpec, ResultProvenance } from "./types.js";
import { canonicalJson, hash64, sortKeys } from "./canonical.js";
import { hashDefinition } from "./analyses/common.js";

/**
 * THE VERSION OF THE COMPUTATIONS. Bump it whenever a change could alter a number a result shows (a statistic, a base, a
 * significance rule): stored and cached results carry it, so one computed by an older engine is recomputed rather than
 * served as if it were current.
 *
 *   2026.10.1  Phase 0 of the audit — Holm-adjusted letters, weighted CIs, Type II ANOVA, answered bases, regression checks
 */
export const ANALYTICS_ENGINE_VERSION = "2026.10.1";

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

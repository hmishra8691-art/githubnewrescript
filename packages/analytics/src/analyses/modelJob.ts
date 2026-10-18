/**
 * ONE STEP OF A CHUNKED MODEL RUN, as the Studio's job route calls it: the
 * definition's own filter is applied exactly as `runAnalysis` applies it, the
 * chains advance within the time budget, and a finished run gets the same
 * post-processing (chart advice, provenance) as any other result — so the
 * stored result is indistinguishable from a synchronous one and hashes to the
 * same input hash for the result cache.
 */
import type { AnalysisDefinition, AnalysisResult } from "../types.js";
import { filterDataset, type Dataset } from "../dataset.js";
import { finalizeResult } from "./index.js";
import { hbJobContinue, hbJobStart } from "./advanced.js";
import type { HbState } from "../models/hb.js";
import { nowMs } from "../models/spec.js";

export interface ModelJobStep {
  status: "running" | "done" | "refused";
  progress: { done: number; total: number; unit: string };
  /** serialisable chain state to store while running */
  state: HbState | null;
  result: AnalysisResult | null;
  projectedMs: number | null;
  dataFingerprint: string | null;
  seed: number | null;
}

export const CHUNKED_KINDS: ReadonlySet<string> = new Set(["hb"]);

export function modelJobStep(def: AnalysisDefinition, dataset: Dataset, state: HbState | null, budgetMs: number, now: () => number = nowMs): ModelJobStep {
  if (!CHUNKED_KINDS.has(def.kind)) throw new Error(`${def.kind} runs synchronously; only ${[...CHUNKED_KINDS].join(", ")} run as jobs`);
  const t0 = now();
  const ds = def.filter ? filterDataset(dataset, def.filter) : dataset;
  const step = state ? hbJobContinue(def, ds, state, budgetMs, now, dataset.cases.length) : hbJobStart(def, ds, budgetMs, now, dataset.cases.length);
  const result = step.result ? finalizeResult(def, dataset, step.result, t0) : null;
  return {
    status: step.status, progress: step.progress, state: step.status === "running" ? step.state ?? null : null, result,
    projectedMs: step.projectedMs ?? null, dataFingerprint: step.state?.fingerprint ?? state?.fingerprint ?? null, seed: step.state?.options.seed ?? state?.options.seed ?? null,
  };
}

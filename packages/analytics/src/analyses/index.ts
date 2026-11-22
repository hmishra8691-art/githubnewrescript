import { adviseAnalysis } from "../dataAdvice.js";
import { adviceChecks } from "../modelChecks.js";
import { provenanceOf } from "../provenance.js";
import { adviseChart } from "../questionChart.js";
import type { AnalysisDefinition, AnalysisResult } from "../types.js";
import { filterDataset, type Dataset } from "../dataset.js";
import { applyLayer, type LayerFilter, type LayerVariable } from "../analysisLayer.js";
import { allocation, crosstab, descriptive, ranking, topbox } from "./basics.js";
import { cluster, correlation, factor, quality, regression, reliability, segmentation, statisticalTest, weighting } from "./statistics.js";
import { brand, csat, gap, nps, pricing, text, trend, turf } from "./business.js";
import { conjoint, maxdiff } from "./choice.js";
import { hb, lca, sem } from "./advanced.js";
import { iat, sequentialMonadic, shelf } from "./experimental.js";
import { kano } from "./kano.js";

export type AnalysisRunner = (def: AnalysisDefinition, ds: Dataset, totalCases: number) => AnalysisResult;

export const RUNNERS: Record<AnalysisDefinition["kind"], AnalysisRunner> = {
  descriptive, topbox, crosstab, test: statisticalTest, correlation, regression, segmentation, cluster, factor, reliability, trend,
  nps, csat, turf, gap, pricing, brand, ranking, allocation, text, quality, weighting, conjoint, maxdiff, hb, lca, sem, sequential_monadic: sequentialMonadic, iat, shelf, kano,
};

/**
 * Run an analysis definition against a built dataset. The definition's own
 * `filter` is applied here (the dataset may already be narrowed by the caller's
 * dataset spec); segments are resolved by each runner.
 */
/*
 * THE ANALYSIS LAYER (analysisLayer.ts): the derived variables this analysis defines are computed from the raw answers
 * on a copy of the dataset, then its filters applied — nothing is written back, and every run recomputes.
 */
function prepareLayer(def: AnalysisDefinition, source: Dataset): { dataset: Dataset; layer: ReturnType<typeof applyLayer> | null; failed?: true } {
  /* a definition that cannot even be read is the runner's "not computable" result below, never an exception out of runAnalysis */
  try { return prepareLayerUnsafe(def, source); } catch (e) { console.error(`[analytics] layer for “${String(def?.name)}” failed:`, e); return { dataset: source, layer: null, failed: true }; }
}

function prepareLayerUnsafe(def: AnalysisDefinition, source: Dataset): { dataset: Dataset; layer: ReturnType<typeof applyLayer> | null } {
  const layerDefs = Array.isArray(def.options?.layer) ? (def.options!.layer as LayerVariable[]) : [];
  const layerFilters = Array.isArray(def.options?.layerFilter) ? (def.options!.layerFilter as LayerFilter[]) : [];
  if (!layerDefs.length && !layerFilters.length) return { dataset: source, layer: null };
  const layer = applyLayer(source, layerDefs, layerFilters);
  return { dataset: layer.dataset, layer };
}

function runAnalysisCore(def: AnalysisDefinition, source: Dataset, prepared = prepareLayer(def, source)): AnalysisResult {
  const runner = RUNNERS[def.kind];
  const { dataset, layer } = prepared;
  const ds = def.filter ? filterDataset(dataset, def.filter) : dataset;
  const withLayer = (r: AnalysisResult): AnalysisResult => !layer ? r : {
    ...r,
    layer: { reports: layer.reports, ...(layer.filtered ? { filtered: layer.filtered } : {}) },
    warnings: [...r.warnings, ...layer.problems.filter((p) => !r.warnings.includes(p))],
  };
  const stub = (warning: string, error: NonNullable<AnalysisResult["error"]>): AnalysisResult => ({
    kind: def.kind, name: def.name, base: { total: dataset.cases.length, filtered: ds.cases.length, n: ds.cases.length, weightedN: ds.cases.length, label: "All respondents" },
    tables: [], chart: {}, tests: [], insights: [], warnings: [warning], recommendedCharts: ["table"], computedAt: new Date().toISOString(), definitionHash: "", variablesUsed: def.variables ?? [], error,
  });
  const notComputable = () => withLayer(stub("This analysis could not be computed with the selected data. Check that the variables it uses exist in this survey and have answers, then run it again.", { code: "not_computable", message: "The analysis could not be computed with the selected data." }));
  if (prepared.failed) return notComputable();
  if (!runner) return withLayer(stub(`Unknown analysis kind “${def.kind}”.`, { code: "unknown_kind", message: `“${def.kind}” is not an analysis type this version can run.` }));
  try {
    const result = runner(def, ds, source.cases.length);
    /* a plan variable this analysis reads that could not be computed as planned: the dataset's own note, on the result that depends on it */
    const relevant = (dataset.warnings ?? []).filter((w) => def.variables.some((v) => v && mentionsVariable(w, v)) && !result.warnings.includes(w));
    return withLayer(relevant.length ? { ...result, warnings: [...result.warnings, ...relevant] } : result);
  } catch (e) {
    /*
     * The raw message ("Cannot read properties of undefined…", a weights-length
     * RangeError, a database string) is for the server log. What reaches the
     * screen, the findings and the stored run is a sentence the researcher can
     * act on, plus a stable code — and `error` set, so a caller can tell "this
     * could not be computed" from "this was computed and is empty".
     */
    console.error(`[analytics] ${def.kind} “${def.name}” failed:`, e);
    return notComputable();
  }
}

const clock = (): number => { const p = (globalThis as { performance?: { now(): number } }).performance; return p ? p.now() : Date.now(); };

/** Run one analysis. The result records what it was computed from and how long it took (audit S-14): `provenance`. */
export function runAnalysis(def: AnalysisDefinition, dataset: Dataset): AnalysisResult {
  const t0 = clock();
  const prepared = prepareLayer(def, dataset);
  return finalizeResult(def, prepared.dataset, runAnalysisCore(def, dataset, prepared), t0);
}

/**
 * What every result gets after its runner: the one chart choice and the provenance record. Exported for results
 * computed in steps (a chunked HB run finished in a later request), so they carry exactly what `runAnalysis` adds.
 */
export function finalizeResult(def: AnalysisDefinition, dataset: Dataset, core: AnalysisResult, t0: number = clock()): AnalysisResult {
  /*
   * ONE CHART CHOICE (audit C-5). The question-aware advice is made here, once, from the question's structure, and travels
   * with the result: the app's gallery, a report block with no saved chart, the deck, the story, the findings and the export
   * all read it, instead of each ranking the shape in its own way. The runner's own list is reordered to lead with it.
   */
  let result = core;
  if (!core.error) {
    try {
      const advice = adviseChart(def, core, [...dataset.byName.values()]);
      const ruledOut = new Set(advice.avoided.map((a) => a.type));
      result = { ...core, advice, recommendedCharts: [advice.type, ...core.recommendedCharts.filter((t) => t !== advice.type && !ruledOut.has(t))] };
    } catch { result = core; }
  }
  /* recording where a result came from must never be what stops a result: a definition that cannot be read for the record still gets its (failure) result */
  /* M5: tables and tests carry the data advice as assumption checks (a regression has already checked its own fit) */
  if (!result.error && !result.assumptions && ["crosstab", "test", "correlation"].includes(def.kind)) {
    try { const a = adviseAnalysis(def, dataset); result = { ...result, assumptions: adviceChecks(a) }; } catch { /* the advice must never be what stops a result */ }
  }
  try { return { ...result, provenance: provenanceOf(def, dataset, result, clock() - t0) }; } catch { return result; }
}

/** The result a report shows for an analysis that could not be computed: a sentence and a code, no tables, no chart — and every other block still renders. */
export function failedResult(name: string, kind: AnalysisDefinition["kind"], message = "This analysis could not be computed. Open it in the Analysis tab to see what is missing.", code: NonNullable<AnalysisResult["error"]>["code"] = "not_computable"): AnalysisResult {
  return { kind, name, base: { total: 0, filtered: 0, n: 0, weightedN: 0, label: "All respondents" }, tables: [], chart: {}, tests: [], insights: [], warnings: [message], recommendedCharts: ["table"], computedAt: new Date().toISOString(), definitionHash: "", variablesUsed: [], error: { code, message } };
}

/** a variable named as a whole word — "Q1" is not "Q10" */
export function mentionsVariable(text: string, variable: string): boolean {
  const esc = variable.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`(^|[^A-Za-z0-9_])${esc}($|[^A-Za-z0-9_])`).test(text);
}

export * from "./basics.js";
export * from "./statistics.js";
export * from "./business.js";
export * from "./choice.js";
export * from "./advanced.js";
export * from "./pricingModels.js";
export * from "./experimental.js";
export { hashDefinition } from "./common.js";

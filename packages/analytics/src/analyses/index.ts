import type { AnalysisDefinition, AnalysisResult } from "../types.js";
import { filterDataset, type Dataset } from "../dataset.js";
import { allocation, crosstab, descriptive, ranking, topbox } from "./basics.js";
import { cluster, correlation, factor, quality, regression, reliability, segmentation, statisticalTest, weighting } from "./statistics.js";
import { brand, csat, gap, nps, pricing, text, trend, turf } from "./business.js";
import { conjoint, maxdiff } from "./choice.js";

export type AnalysisRunner = (def: AnalysisDefinition, ds: Dataset, totalCases: number) => AnalysisResult;

export const RUNNERS: Record<AnalysisDefinition["kind"], AnalysisRunner> = {
  descriptive, topbox, crosstab, test: statisticalTest, correlation, regression, segmentation, cluster, factor, reliability, trend,
  nps, csat, turf, gap, pricing, brand, ranking, allocation, text, quality, weighting, conjoint, maxdiff,
};

/**
 * Run an analysis definition against a built dataset. The definition's own
 * `filter` is applied here (the dataset may already be narrowed by the caller's
 * dataset spec); segments are resolved by each runner.
 */
export function runAnalysis(def: AnalysisDefinition, dataset: Dataset): AnalysisResult {
  const runner = RUNNERS[def.kind];
  const ds = def.filter ? filterDataset(dataset, def.filter) : dataset;
  if (!runner) {
    return {
      kind: def.kind, name: def.name, base: { total: dataset.total, filtered: ds.cases.length, n: ds.cases.length, weightedN: ds.cases.length, label: "All respondents" },
      tables: [], chart: {}, tests: [], insights: [], warnings: [`Unknown analysis kind “${def.kind}”.`], recommendedCharts: ["table"], computedAt: new Date().toISOString(), definitionHash: "", variablesUsed: [],
    };
  }
  try {
    return runner(def, ds, dataset.cases.length);
  } catch (e) {
    return {
      kind: def.kind, name: def.name, base: { total: dataset.total, filtered: ds.cases.length, n: ds.cases.length, weightedN: ds.cases.length, label: "All respondents" },
      tables: [], chart: {}, tests: [], insights: [], warnings: [`The analysis could not be computed: ${(e as Error).message}`], recommendedCharts: ["table"], computedAt: new Date().toISOString(), definitionHash: "", variablesUsed: def.variables,
    };
  }
}

export * from "./basics.js";
export * from "./statistics.js";
export * from "./business.js";
export * from "./choice.js";
export { hashDefinition } from "./common.js";

/**
 * @rescript/import — the Intelligent import engine.
 *
 *   readSource(bytes, fileName)        detection + the right adapter → CanonicalSurvey   (server: zip, zlib, exceljs)
 *   mapCanonical(canonical, options)   CanonicalSurvey → SurveyDefinition, validated      (pure — also "@rescript/import/map")
 *   buildReport(…)                     the migration report and the audit lines
 *   analyzeImport(bytes, fileName, o)  all three
 */
export * from "./canonical.js";
export * from "./detect.js";
export * from "./sources.js";
export * from "./map.js";
export * from "./report.js";
export { parseXml } from "./xml.js";
export { extractPdfText } from "./pdf.js";
export { readZip } from "./zip.js";

import { readSource } from "./sources.js";
import { mapCanonical, type MapOptions, type MapResult, type ImportScope } from "./map.js";
import { buildReport, workload, type MigrationReport, type Workload } from "./report.js";
import type { CanonicalSurvey, Issue } from "./canonical.js";
import type { Detection } from "./detect.js";

export interface ImportAnalysis {
  detection: Detection;
  canonical: CanonicalSurvey | null;
  result: MapResult | null;
  report: MigrationReport | null;
  workload: Workload | null;
  issues: Issue[];
}

export async function analyzeImport(bytes: Uint8Array, fileName: string, opts: MapOptions & { scope?: ImportScope }): Promise<ImportAnalysis> {
  const read = await readSource(bytes, fileName);
  if (!read.canonical) return { detection: read.detection, canonical: null, result: null, report: null, workload: null, issues: read.issues };
  const result = mapCanonical(read.canonical, opts);
  return { detection: read.detection, canonical: read.canonical, result, report: buildReport(read.detection, read.canonical, result, opts.scope ?? "full"), workload: workload(read.canonical), issues: read.issues };
}

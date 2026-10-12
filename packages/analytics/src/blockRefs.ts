import type { ReportBlock, ReportDefinition, TemplateBlock } from "./types.js";

/**
 * THE one place that answers "which analyses does this report block read?".
 *
 * Before this existed the export, the compute step, the findings report and
 * the viewer each re-derived it with `"analysisIds" in block` followed by an
 * unguarded `.analysisIds.map/flatMap`. A built-in page template ships an
 * `insights` block ("Findings") with NO `analysisIds`; saved into a report it
 * crashed the PowerPoint export with
 * "Cannot read properties of undefined (reading 'flatMap')" while the viewer
 * (which happened to use `?? []`) rendered fine — so the preview worked and
 * the export failed.
 *
 * Rules:
 *  - a block with its own `analysisId` reads that one;
 *  - a `panel_grid` reads every panel's analysis;
 *  - `insights` / `executive_summary` read their `analysisIds`; when none are
 *    chosen (absent or empty) they summarise every analysis the rest of the
 *    report shows, which is what an unconfigured "Findings" block means.
 */
type AnyBlock = ReportBlock | TemplateBlock;

const own = (b: AnyBlock): string[] => {
  const x = b as { analysisId?: unknown; analysisIds?: unknown; panels?: unknown };
  const ids: string[] = [];
  if (typeof x.analysisId === "string" && x.analysisId) ids.push(x.analysisId);
  if (Array.isArray(x.analysisIds)) for (const id of x.analysisIds) if (typeof id === "string" && id) ids.push(id);
  if (b.type === "panel_grid" && Array.isArray(x.panels)) for (const p of x.panels as { analysisId?: string }[]) if (p && typeof p.analysisId === "string" && p.analysisId) ids.push(p.analysisId);
  return [...new Set(ids)];
};

/** Analyses a block names itself (no fallback). */
export function explicitAnalysisIds(block: AnyBlock): string[] { return own(block); }

/** Every analysis a report's data blocks read (what must be computed / snapshotted). */
export function reportAnalysisIds<R extends { blocks?: readonly AnyBlock[]; widgets?: readonly { analysisId?: string }[] }>(report: R): string[] {
  const ids = new Set<string>();
  for (const b of report.blocks ?? []) for (const id of own(b)) ids.add(id);
  for (const w of report.widgets ?? []) if (w?.analysisId) ids.add(w.analysisId);
  return [...ids];
}

/** The analyses an `insights` / `executive_summary` block summarises, with the "all of them" default. */
export function summaryAnalysisIds(block: AnyBlock, report: Pick<ReportDefinition, "blocks">): string[] {
  const chosen = own(block);
  if (chosen.length) return chosen;
  const all = new Set<string>();
  for (const b of report.blocks ?? []) if (b.type !== "insights" && b.type !== "executive_summary") for (const id of own(b)) all.add(id);
  return [...all];
}

/** A block list with the optional ids made explicit — what save/apply-template write so stored reports are never ragged. */
export function normalizeBlocks<T extends AnyBlock>(blocks: readonly T[]): T[] {
  return blocks.map((b) => (b.type === "insights" || b.type === "executive_summary") && !Array.isArray((b as { analysisIds?: unknown }).analysisIds) ? ({ ...b, analysisIds: [] } as T) : b);
}

/**
 * What a snapshot is about to freeze — checked BEFORE it is written, because a
 * published version is a record: a link sent to a client that shows "0
 * responses" cannot be fixed by recomputing, only by publishing again.
 *
 *  - `responses` is the LARGEST base any analysis in the report saw. (It used
 *    to be the base of whichever analysis the database happened to return
 *    first, so a report mixing datasets could announce 0.)
 *  - `missing` analyses are referenced by a block but were not computed
 *    (deleted since, or not in this survey).
 *  - `failed` analyses carry a structured error.
 *  - `empty` is true when analyses exist but not one of them saw a respondent.
 */
export interface SnapshotCheck { responses: number; missing: string[]; failed: string[]; empty: boolean; ok: boolean; problems: string[] }

export function checkSnapshot(
  definition: { blocks?: readonly AnyBlock[]; widgets?: readonly { analysisId?: string }[] },
  snapshot: Record<string, { name?: string; base?: { total?: number; n?: number }; error?: unknown } | undefined>,
): SnapshotCheck {
  const referenced = reportAnalysisIds(definition);
  const missing = referenced.filter((id) => !snapshot[id]);
  const present = referenced.filter((id) => snapshot[id]);
  const failed = present.filter((id) => !!snapshot[id]!.error);
  const responses = present.reduce((m, id) => Math.max(m, snapshot[id]!.base?.total ?? 0), 0);
  const empty = present.length > 0 && present.every((id) => (snapshot[id]!.base?.n ?? 0) === 0 && (snapshot[id]!.base?.total ?? 0) === 0);
  const problems: string[] = [];
  if (missing.length) problems.push(`${missing.length} analysis${missing.length === 1 ? " this report uses no longer exists" : "es this report uses no longer exist"} and would be blank.`);
  if (failed.length) problems.push(`${failed.length} analysis${failed.length === 1 ? " could not be computed" : "es could not be computed"}: ${failed.slice(0, 3).map((id) => snapshot[id]!.name ?? id).join(", ")}.`);
  if (empty) problems.push("Not one analysis in this report has a respondent in its selected data (environment, status or date range), so every chart and number would read 0.");
  return { responses, missing, failed, empty, ok: problems.length === 0, problems };
}

/** A report or dashboard definition as it is stored: ragged optional ids made explicit. Dashboards (widgets) pass through untouched. */
export function normalizeReportDefinition<D>(definition: D): D {
  const d = definition as unknown as { blocks?: unknown };
  if (!d || typeof d !== "object" || !Array.isArray(d.blocks)) return definition;
  return { ...(definition as object), blocks: normalizeBlocks(d.blocks as AnyBlock[]) } as D;
}

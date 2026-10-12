import type { SupabaseClient } from "@supabase/supabase-js";
import { definitionFor, normalizeReportDefinition, validateAskOp, type AskContext, type AskOp, type ChartSpec, type DatasetSpec, type ReportDefinition, type UndoRecord } from "@rescript/analytics";

/**
 * APPLYING AND UNDOING WHAT INTELLIGENT MODE PROPOSED — the writes.
 *
 * Kept apart from the proposal code so it depends on nothing but the database
 * client and the pure analytics package, which is what lets its tests run the
 * real statements against an in-memory database. Each item is validated again
 * against the context as it is NOW (the proposal may be minutes old and the
 * browser's copy of it is not trusted), executed on its own, and reports what
 * it did and how to reverse it.
 */
/* ------------------------------------------------------------------ apply / undo */

export interface AppliedItem { index: number; name: string; status: "done" | "blocked" | "failed"; message: string; undo?: UndoRecord; createdId?: string }

const now = () => new Date().toISOString();

export async function applyOps(db: SupabaseClient, surveyId: string, surveyVersion: string | null, userId: string | null, ops: readonly AskOp[], dataset: DatasetSpec, request: string, contextFor: (needResults: boolean) => Promise<AskContext>): Promise<AppliedItem[]> {
  const out: AppliedItem[] = [];
  /* one context for the whole batch, rebuilt after every write so a later item sees what an earlier one did (two items for the same cross-tab cannot both land) */
  for (let index = 0; index < ops.length; index++) {
    const op = ops[index];
    const name = op.name || op.op;
    const ctx = await contextFor(op.op === "set_chart");
    if (op.op === "build_report") { out.push({ index, name, status: "blocked", message: "A report is reviewed in the report builder before it is created — open it from this item." }); continue; }
    const v = validateAskOp(op, ctx);
    if (v.blocked.length) { out.push({ index, name, status: "blocked", message: v.blocked.join(" ") }); continue; }
    try {
      if (op.op === "add_crosstab" || op.op === "add_test" || op.op === "add_descriptive") {
        const def = definitionFor(op, dataset, request)!;
        const row = { survey_id: surveyId, name: op.name.slice(0, 160), kind: def.kind, definition: { ...def, name: op.name.slice(0, 160), surveyVersion: surveyVersion ?? undefined }, version: 1, folder: null, tags: [], created_by: userId, updated_by: userId };
        const { data, error } = await db.from("analytics_analyses").insert(row).select("id, definition").single();
        if (error || !data) { out.push({ index, name, status: "failed", message: error?.message ?? "The analysis could not be saved." }); continue; }
        await db.from("analytics_analysis_versions").insert({ analysis_id: data.id, survey_id: surveyId, version: 1, definition: data.definition, summary: "Created from a request", created_by: userId });
        out.push({ index, name, status: "done", message: "Created.", createdId: String(data.id), undo: { kind: "created_analysis", id: String(data.id) } });
      } else if (op.op === "remove_analysis") {
        const { data: charts } = await db.from("analytics_charts").select("id").eq("analysis_id", op.analysisId).is("deleted_at", null);
        const { error } = await db.from("analytics_analyses").update({ deleted_at: now(), updated_by: userId }).eq("id", op.analysisId).eq("survey_id", surveyId).is("deleted_at", null);
        if (error) { out.push({ index, name, status: "failed", message: error.message }); continue; }
        const chartIds = (charts ?? []).map((c) => String(c.id));
        if (chartIds.length) await db.from("analytics_charts").update({ deleted_at: now() }).eq("survey_id", surveyId).in("id", chartIds);
        out.push({ index, name, status: "done", message: "Removed (it can be restored with Undo).", undo: { kind: "removed_analysis", id: op.analysisId, chartIds } });
      } else if (op.op === "set_chart") {
        const { data: rep } = await db.from("analytics_reports").select("definition").eq("id", op.reportId).eq("survey_id", surveyId).is("deleted_at", null).maybeSingle();
        const def = rep?.definition as ReportDefinition | undefined;
        const block = def?.blocks?.find((b) => b.id === op.blockId);
        if (!def || !block || block.type !== "chart") { out.push({ index, name, status: "blocked", message: "That chart is no longer in the report." }); continue; }
        const before = block.chart as ChartSpec;
        const after: ChartSpec = { ...before, type: op.chart };
        const next = normalizeReportDefinition({ ...def, blocks: def.blocks!.map((b) => (b.id === op.blockId && b.type === "chart" ? { ...b, chart: after } : b)) } as never);
        const { error } = await db.from("analytics_reports").update({ definition: next, updated_by: userId }).eq("id", op.reportId).eq("survey_id", surveyId);
        if (error) { out.push({ index, name, status: "failed", message: error.message }); continue; }
        out.push({ index, name, status: "done", message: `Now ${op.chart.replace(/_/g, " ")}.`, undo: { kind: "chart_changed", reportId: op.reportId, blockId: op.blockId, before, after } });
      }
    } catch (e) { console.error("[analytics] ask apply failed:", e); out.push({ index, name, status: "failed", message: (e as Error)?.message ?? "It could not be applied." }); }
  }
  return out;
}

export interface Undone { name: string; status: "undone" | "skipped"; message: string }

export async function undoRecords(db: SupabaseClient, surveyId: string, userId: string | null, records: readonly UndoRecord[]): Promise<Undone[]> {
  const out: Undone[] = [];
  for (const r of records) {
    try {
      if (r.kind === "created_analysis") {
        const { error } = await db.from("analytics_analyses").update({ deleted_at: now(), updated_by: userId }).eq("id", r.id).eq("survey_id", surveyId).is("deleted_at", null);
        await db.from("analytics_charts").update({ deleted_at: now() }).eq("survey_id", surveyId).eq("analysis_id", r.id).is("deleted_at", null);
        out.push({ name: r.id, status: error ? "skipped" : "undone", message: error ? error.message : "Analysis removed again." });
      } else if (r.kind === "removed_analysis") {
        const { error } = await db.from("analytics_analyses").update({ deleted_at: null, updated_by: userId }).eq("id", r.id).eq("survey_id", surveyId);
        if (!error && r.chartIds.length) await db.from("analytics_charts").update({ deleted_at: null }).eq("survey_id", surveyId).in("id", r.chartIds);
        out.push({ name: r.id, status: error ? "skipped" : "undone", message: error ? error.message : "Analysis restored." });
      } else {
        const { data: rep } = await db.from("analytics_reports").select("definition").eq("id", r.reportId).eq("survey_id", surveyId).is("deleted_at", null).maybeSingle();
        const def = rep?.definition as ReportDefinition | undefined;
        const block = def?.blocks?.find((b) => b.id === r.blockId);
        if (!def || !block || block.type !== "chart") { out.push({ name: r.blockId, status: "skipped", message: "That chart is no longer in the report." }); continue; }
        /* someone changed this chart after the request did — their choice stands */
        if (block.chart?.type !== r.after.type) { out.push({ name: r.blockId, status: "skipped", message: "The chart was changed again since, so it was left as it is." }); continue; }
        const next = normalizeReportDefinition({ ...def, blocks: def.blocks!.map((b) => (b.id === r.blockId && b.type === "chart" ? { ...b, chart: r.before } : b)) } as never);
        const { error } = await db.from("analytics_reports").update({ definition: next, updated_by: userId }).eq("id", r.reportId).eq("survey_id", surveyId);
        out.push({ name: r.blockId, status: error ? "skipped" : "undone", message: error ? error.message : "Chart restored." });
      }
    } catch (e) { out.push({ name: "item", status: "skipped", message: (e as Error)?.message ?? "It could not be undone." }); }
  }
  return out;
}

export type { UndoRecord };

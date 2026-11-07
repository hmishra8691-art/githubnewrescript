import { NextRequest, NextResponse } from "next/server";
import { cleaningImpact, type ImpactRow } from "@rescript/quality";
import { supabaseAdmin } from "@/lib/admin";
import { isFailure, requireProject } from "@/lib/guard";
import { loadQualityDefinition, missingMigration } from "@/lib/qualityDef";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

/**
 * THE BEFORE-AND-AFTER CLEANING REPORT (roadmap 1.4, tracker 1.5).
 *
 *   GET ?environment=LIVE|TEST → cleaningImpact: completes before and after the responses a person marked REMOVE,
 *   why they were removed, quality and outcomes before and after, the answer shares cleaning moved, blank rates.
 *
 * Read-only (`responses.read`): it reads answers, assessments and review decisions; it changes nothing. Removed
 * responses are never deleted — the "before" column is the raw dataset.
 */
const PAGE = 1000;

export async function GET(req: NextRequest, { params }: { params: { id: string } }) {
  const gate = await requireProject(req, params.id, "responses.read");
  if (isFailure(gate)) return gate.response;
  const isTest = req.nextUrl.searchParams.get("environment") === "TEST";
  const db = supabaseAdmin();
  const loaded = await loadQualityDefinition(db, params.id);
  if ("error" in loaded) return NextResponse.json({ error: loaded.error }, { status: loaded.status });
  const rows: ImpactRow[] = [];
  let after: string | null = null;
  for (let page = 0; page < 200; page++) {
    let q = db.from("responses").select("id, session_id, status, answers, quality, review_status, review_reason").eq("survey_id", params.id).eq("is_test", isTest).is("deleted_at", null).eq("status", "complete");
    if (after) q = q.gt("id", after);
    const { data, error } = await q.order("id", { ascending: true }).limit(PAGE);
    if (error) return NextResponse.json({ error: missingMigration(error.message) ? "Quality columns are missing — apply migration 0005_response_quality.sql." : error.message }, { status: missingMigration(error.message) ? 503 : 500 });
    const chunk = (data ?? []) as { id: string; session_id: string; status: string; answers: Record<string, unknown> | null; quality: ImpactRow["quality"]; review_status: string | null; review_reason: string | null }[];
    for (const r of chunk) rows.push({ sessionId: r.session_id, status: r.status, answers: r.answers ?? {}, quality: r.quality, reviewStatus: r.review_status, reviewReason: r.review_reason });
    if (chunk.length < PAGE) break;
    after = chunk[chunk.length - 1]!.id;
  }
  return NextResponse.json({ impact: cleaningImpact(loaded.def, rows), environment: isTest ? "TEST" : "LIVE" }, { headers: { "cache-control": "no-store" } });
}

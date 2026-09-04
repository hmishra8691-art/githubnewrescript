import { NextRequest, NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/admin";
import { loadQualityDefinition, missingMigration } from "@/lib/qualityDef";
import { recomputeSurvey } from "@rescript/quality/server";

export const dynamic = "force-dynamic";

/**
 * Re-assess every finished response of a survey with the current quality
 * settings (the autosaved draft's, so the researcher sees a rule change
 * immediately) and final cluster ids. The live path assesses each response
 * as it completes; this is for settings changes, backfill and "preview rule
 * impact".
 */
export async function POST(req: NextRequest, { params }: { params: { id: string } }) {
  let body: any = {};
  try { body = await req.json(); } catch { /* optional */ }
  const include = body?.include === "test" ? "test" : body?.include === "all" ? "all" : "live";
  const db = supabaseAdmin();
  const loaded = await loadQualityDefinition(db, params.id, body?.source === "version" ? "version" : "draft");
  if (!("def" in loaded)) return NextResponse.json({ error: loaded.error }, { status: loaded.status });
  const started = Date.now();
  try {
    const results: Record<string, unknown> = {};
    for (const isTest of include === "all" ? [false, true] : [include === "test"]) {
      results[isTest ? "test" : "live"] = await recomputeSurvey(db, loaded.def, params.id, isTest);
    }
    console.info("[rescript:quality] recompute", { survey: params.id, include, ms: Date.now() - started, results });
    return NextResponse.json({ ok: true, source: loaded.source, enabled: loaded.def.quality.enabled, strictness: loaded.def.quality.strictness, results, ms: Date.now() - started });
  } catch (e) {
    const msg = (e as Error).message;
    if (missingMigration(msg)) return NextResponse.json({ error: "Quality columns are missing — apply migration 0005_response_quality.sql.", migration: "0005" }, { status: 503 });
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}

import { NextRequest, NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/admin";
import { loadQualityDefinition, missingMigration } from "@/lib/qualityDef";
import { recomputeSurvey } from "@rescript/quality/server";
import { enabledRuleIds, resolveConfig, summarizeConfig } from "@rescript/quality";
import { isFailure, requireEditRight, requireProject } from "@/lib/guard";

export const dynamic = "force-dynamic";

/**
 * Re-assess every finished response of a survey with the current quality
 * settings (the autosaved draft's, so the researcher sees a rule change
 * immediately) and final cluster ids. The live path assesses each response
 * as it completes; this is for settings changes, backfill and "preview rule
 * impact".
 *
 * The response says exactly which settings ran — source, revision and the
 * config fingerprint — so the caller can check them against what it saved.
 */
export async function POST(req: NextRequest, { params }: { params: { id: string } }) {
  const gate = await requireProject(req, params.id, "responses.manage");
  if (isFailure(gate)) return gate.response;

  let body: any = {};
  try { body = await req.json(); } catch { /* optional */ }
  const include = body?.include === "test" ? "test" : body?.include === "all" ? "all" : "live";
  const db = supabaseAdmin();
  const loaded = await loadQualityDefinition(db, params.id, body?.source === "version" ? "version" : "draft");
  if (!("def" in loaded)) return NextResponse.json({ error: loaded.error }, { status: loaded.status });
  const summary = summarizeConfig(loaded.def);
  const started = Date.now();
  // §3 — the configuration the engine receives, in the same shape the runtime logs
  console.info("[rescript:quality] recompute config", JSON.stringify({
    surveyId: params.id, include,
    definition: { source: loaded.source, versionId: loaded.versionId, version: loaded.version, revision: loaded.revision, savedAt: loaded.draftUpdatedAt },
    config: { hash: summary.configHash, enabled: summary.enabled, strictness: summary.strictness, profile: summary.profile, rulesOn: summary.rulesOn, rulesCustomised: summary.rulesCustomised, customRules: summary.customRules, telemetryOff: summary.telemetryOff, bands: summary.bands },
    enabledChecks: enabledRuleIds(resolveConfig(loaded.def)),
    at: new Date().toISOString(),
  }));
  try {
    const results: Record<string, unknown> = {};
    for (const isTest of include === "all" ? [false, true] : [include === "test"]) {
      results[isTest ? "test" : "live"] = await recomputeSurvey(db, loaded.def, params.id, isTest);
    }
    console.info("[rescript:quality] recompute done", JSON.stringify({ surveyId: params.id, include, configHash: summary.configHash, ms: Date.now() - started, results }));
    return NextResponse.json({
      ok: true,
      source: loaded.source, revision: loaded.revision, version: loaded.version, savedAt: loaded.draftUpdatedAt,
      enabled: summary.enabled, strictness: summary.strictness, configHash: summary.configHash, config: summary,
      results, ms: Date.now() - started,
    });
  } catch (e) {
    const msg = (e as Error).message;
    if (missingMigration(msg)) return NextResponse.json({ error: "Quality columns are missing — apply migration 0005_response_quality.sql.", migration: "0005" }, { status: 503 });
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}

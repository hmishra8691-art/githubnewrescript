import { NextRequest, NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/admin";
import { loadQualityDefinition, missingMigration } from "@/lib/qualityDef";
import { SurveyDefinition } from "@rescript/schema";
import { summarizeConfig, type QualityAssessment, type QualityConfigSummary } from "@rescript/quality";
import { isFailure, requireProject } from "@/lib/guard";

export const dynamic = "force-dynamic";

/**
 * The Quality dashboard's data: the settings in effect (and where they come
 * from), counts by classification, review decision and signal category, the
 * fraud-risk distribution, and one compact row per finished response. The
 * full assessment of one response comes from `./[sessionId]`.
 *
 * Every row carries the fingerprint of the settings it was assessed with, and
 * the payload carries the fingerprint of the settings saved now, so the
 * dashboard can say "N responses were scored under older settings" instead of
 * mixing them in silently.
 */
export interface QualityRow {
  sessionId: string;
  status: string;
  startedAt: string | null;
  completedAt: string | null;
  durationSec: number | null;
  assessed: boolean;
  /** fingerprint of the settings this assessment ran with (absent on older assessments) */
  configHash: string | null;
  computedAt: string | null;
  qualityScore: number | null;
  riskScore: number | null;
  classification: string | null;
  recommendation: string | null;
  categories: Record<string, number>;
  flags: { ruleId: string; category: string; severity: string; title: string }[];
  clusterId: string | null;
  clusterSize: number;
  reasons: string[];
  reviewStatus: string | null;
  reviewReason: string | null;
  reviewedAt: string | null;
  reviewedBy: string | null;
}

export interface QualityPayload {
  enabled: boolean;
  strictness: string | null;
  bands: QualityConfigSummary["bands"] | null;
  /** the settings the dashboard, recompute and test sessions use */
  config: QualityConfigSummary | null;
  source: "draft" | "version" | null;
  revision: number | null;
  /** when the settings source was last written */
  savedAt: string | null;
  version: string | null;
  /** what the LIVE link is running — its version and the quality settings in it */
  live: { version: string; versionId: string; config: QualityConfigSummary } | null;
  total: number;
  /** finished responses assessed with settings other than the current ones */
  staleAssessed: number;
  byClass: Record<string, number>;
  byReview: Record<string, number>;
  signals: Record<string, number>;
  histogram: number[];
  clusters: { id: string; size: number }[];
  rows: QualityRow[];
}

export async function GET(req: NextRequest, { params }: { params: { id: string } }) {
  const gate = await requireProject(req, params.id, "responses.read");
  if (isFailure(gate)) return gate.response;

  const db = supabaseAdmin();
  const include = req.nextUrl.searchParams.get("include") ?? "live";
  const isTest = include === "test";

  const loaded = await loadQualityDefinition(db, params.id);
  if (!("def" in loaded) && loaded.status === 422) return NextResponse.json({ error: loaded.error }, { status: 422 });
  const config = "def" in loaded ? summarizeConfig(loaded.def) : null;

  // what the live link actually runs — the published version, which may be
  // behind the saved settings until the programmer publishes
  let live: QualityPayload["live"] = null;
  const { data: dep } = await db.from("deployments").select("version_id, survey_versions(version, definition)").eq("survey_id", params.id).eq("mode", "live").eq("active", true).maybeSingle();
  if (dep?.version_id) {
    const ver = Array.isArray(dep.survey_versions) ? dep.survey_versions[0] : (dep.survey_versions as { version?: string; definition?: unknown } | null);
    const parsed = ver?.definition ? SurveyDefinition.safeParse(ver.definition) : null;
    if (parsed?.success) live = { version: String(ver?.version ?? "?"), versionId: dep.version_id as string, config: summarizeConfig(parsed.data) };
  }

  let q = db
    .from("responses")
    .select("session_id, status, started_at, completed_at, quality, quality_computed_at, review_status, review_reason, reviewed_at, reviewed_by, is_test")
    .eq("survey_id", params.id)
    .neq("status", "in_progress")
    .order("started_at", { ascending: false })
    .limit(20000);
  if (include !== "all") q = q.eq("is_test", isTest);
  const { data, error } = await q;
  if (error) {
    if (missingMigration(error.message)) return NextResponse.json({ error: "Quality columns are missing — apply migration 0005_response_quality.sql.", migration: "0005" }, { status: 503 });
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  const rows: QualityRow[] = (data ?? []).map((r: any) => {
    const a = r.quality as QualityAssessment | null;
    const started = r.started_at ? new Date(r.started_at).getTime() : null;
    const done = r.completed_at ? new Date(r.completed_at).getTime() : null;
    return {
      sessionId: r.session_id, status: r.status, startedAt: r.started_at, completedAt: r.completed_at,
      durationSec: a?.system?.SYSTEM_TOTAL_DURATION ?? (started && done ? Math.round((done - started) / 1000) : null),
      assessed: !!a,
      configHash: a?.configHash ?? null,
      computedAt: a?.computedAt ?? r.quality_computed_at ?? null,
      qualityScore: a?.qualityScore ?? null, riskScore: a?.riskScore ?? null,
      classification: a?.classification ?? null, recommendation: a?.recommendation ?? null,
      categories: a?.categories ?? {},
      flags: (a?.flags ?? []).map((f) => ({ ruleId: f.ruleId, category: f.category, severity: f.severity, title: f.title })),
      clusterId: a?.cluster?.clusterId ?? null, clusterSize: a?.cluster?.size ?? 1,
      reasons: a?.reasons ?? [],
      reviewStatus: r.review_status ?? null, reviewReason: r.review_reason ?? null, reviewedAt: r.reviewed_at ?? null, reviewedBy: r.reviewed_by ?? null,
    };
  });

  const byClass: Record<string, number> = { CLEAN: 0, REVIEW: 0, SUSPICIOUS: 0, HIGHLY_SUSPICIOUS: 0, CRITICAL: 0, UNSCORED: 0 };
  const byReview: Record<string, number> = { KEEP: 0, REMOVE: 0, REVIEW_LATER: 0, NONE: 0 };
  const signals: Record<string, number> = {};
  const histogram = new Array(10).fill(0);
  const clusters = new Map<string, number>();
  let staleAssessed = 0;
  for (const r of rows) {
    byClass[r.classification ?? "UNSCORED"] = (byClass[r.classification ?? "UNSCORED"] ?? 0) + 1;
    byReview[r.reviewStatus ?? "NONE"] = (byReview[r.reviewStatus ?? "NONE"] ?? 0) + 1;
    for (const c of new Set(r.flags.map((f) => f.category))) signals[c] = (signals[c] ?? 0) + 1;
    if (r.riskScore !== null) histogram[Math.min(9, Math.floor(r.riskScore / 10))]++;
    if (r.clusterId) clusters.set(r.clusterId, (clusters.get(r.clusterId) ?? 0) + 1);
    if (r.assessed && config && r.configHash !== config.configHash) staleAssessed++;
  }

  const payload: QualityPayload = {
    enabled: !!config?.enabled,
    strictness: config?.strictness ?? null,
    bands: config?.bands ?? null,
    config,
    source: "def" in loaded ? loaded.source : null,
    revision: "def" in loaded ? loaded.revision : null,
    savedAt: "def" in loaded ? loaded.draftUpdatedAt : null,
    version: "def" in loaded ? loaded.version : null,
    live,
    total: rows.length,
    staleAssessed,
    byClass, byReview, signals, histogram,
    clusters: [...clusters.entries()].map(([id, size]) => ({ id, size })).sort((a, b) => b.size - a.size),
    rows,
  };
  return NextResponse.json(payload, { headers: { "cache-control": "no-store" } });
}

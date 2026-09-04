import { NextRequest, NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/admin";
import { loadQualityDefinition, missingMigration } from "@/lib/qualityDef";
import { flattenVariables } from "@rescript/engine";
import { RESPONSE_COLUMNS, assessAndStore } from "@rescript/quality/server";
import { isFailure, requireProject } from "@/lib/guard";

export const dynamic = "force-dynamic";

/**
 * One respondent for the review screen: the full assessment (every flag with
 * its observed / expected / points / explanation), the flattened answers, the
 * telemetry summary and the decision history. PATCH records the researcher's
 * decision — KEEP / REMOVE / REVIEW_LATER / CLEAR — as data plus an audit row.
 * Nothing is ever deleted here.
 */
export async function GET(req: NextRequest, { params }: { params: { id: string; sessionId: string } }) {
  const gate = await requireProject(req, params.id, "responses.read");
  if (isFailure(gate)) return gate.response;

  const db = supabaseAdmin();
  const { data: row, error } = (await db.from("responses").select(RESPONSE_COLUMNS + ", survey_id, seed").eq("survey_id", params.id).eq("session_id", params.sessionId).maybeSingle()) as { data: any; error: { message: string } | null };
  if (error) {
    if (missingMigration(error.message)) return NextResponse.json({ error: "apply migration 0005", migration: "0005" }, { status: 503 });
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
  if (!row) return NextResponse.json({ error: "not found" }, { status: 404 });
  const loaded = await loadQualityDefinition(db, params.id);
  let vars: Record<string, unknown> = {};
  if ("def" in loaded) {
    vars = flattenVariables(loaded.def, {
      surveyId: params.id, surveyVersion: "", sessionId: row.session_id, seed: row.seed ?? 0, startedAt: row.started_at ?? "",
      status: row.status, answers: row.answers ?? {}, embedded: row.embedded ?? {}, calculated: row.calculated ?? {}, flags: row.flags ?? [], stepIndex: 0,
    } as any);
  }
  const { data: reviews } = await db.from("response_reviews").select("decision, reason, decided_by, decided_at").eq("response_id", row.id).order("decided_at", { ascending: false }).limit(50);
  const t = row.telemetry;
  return NextResponse.json({
    sessionId: row.session_id,
    status: row.status,
    isTest: row.is_test,
    startedAt: row.started_at,
    completedAt: row.completed_at,
    answers: row.answers ?? {},
    vars,
    quality: row.quality ?? null,
    review: { status: row.review_status ?? null, reason: row.review_reason ?? null, by: row.reviewed_by ?? null, at: row.reviewed_at ?? null },
    reviews: reviews ?? [],
    telemetry: t ? {
      pages: t.pages?.length ?? 0,
      focus: t.focus, clipboard: t.clipboard, navigation: { ...t.navigation, sequence: (t.navigation?.sequence ?? []).slice(0, 60) },
      interaction: t.interaction, device: t.device ?? null, disabled: t.disabled ?? [],
    } : null,
    hashes: { ip: row.ip_hash ? String(row.ip_hash).slice(0, 10) : null, device: row.device_hash ? String(row.device_hash).slice(0, 10) : null },
  });
}

const DECISIONS = ["KEEP", "REMOVE", "REVIEW_LATER", "CLEAR"] as const;

export async function PATCH(req: NextRequest, { params }: { params: { id: string; sessionId: string } }) {
  const gate = await requireProject(req, params.id, "responses.manage");
  if (isFailure(gate)) return gate.response;

  let body: any;
  try { body = await req.json(); } catch { return NextResponse.json({ error: "bad json" }, { status: 400 }); }
  const decision = String(body?.decision ?? "");
  if (!DECISIONS.includes(decision as any)) return NextResponse.json({ error: "decision must be KEEP, REMOVE, REVIEW_LATER or CLEAR" }, { status: 400 });
  const reason = typeof body?.reason === "string" ? body.reason.slice(0, 1000) : null;
  // the signed-in reviewer, not a literal: §25 needs the log to name a person
  const by = gate.user.fullName || gate.user.userCode;

  const db = supabaseAdmin();
  const { data: row } = await db.from("responses").select("id, quality").eq("survey_id", params.id).eq("session_id", params.sessionId).maybeSingle();
  if (!row) return NextResponse.json({ error: "not found" }, { status: 404 });

  const now = new Date().toISOString();
  const update = decision === "CLEAR"
    ? { review_status: null, review_reason: null, reviewed_by: null, reviewed_at: null }
    : { review_status: decision, review_reason: reason ?? (decision === "REMOVE" ? "HIGH_QUALITY_RISK" : null), reviewed_by: by, reviewed_at: now };
  const { error } = await db.from("responses").update(update).eq("id", row.id);
  if (error) {
    if (missingMigration(error.message)) return NextResponse.json({ error: "apply migration 0005", migration: "0005" }, { status: 503 });
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
  // the audit trail: every decision, including reversals
  await db.from("response_reviews").insert({
    response_id: row.id, survey_id: params.id, decision, reason, decided_by: by, decided_at: now,
    quality_snapshot: row.quality ? { qualityScore: row.quality.qualityScore, riskScore: row.quality.riskScore, classification: row.quality.classification, flags: (row.quality.flags ?? []).map((f: any) => f.ruleId) } : null,
  });
  console.info("[rescript:quality] review", { survey: params.id, session: params.sessionId.slice(0, 8), decision, by });
  return NextResponse.json({ ok: true, review: { status: update.review_status, reason: update.review_reason, by: update.reviewed_by, at: update.reviewed_at } });
}

/** Re-assess this one response against current peers and the current settings. */
export async function POST(req: NextRequest, { params }: { params: { id: string; sessionId: string } }) {
  const gate = await requireProject(req, params.id, "responses.manage");
  if (isFailure(gate)) return gate.response;

  const db = supabaseAdmin();
  const loaded = await loadQualityDefinition(db, params.id);
  if (!("def" in loaded)) return NextResponse.json({ error: loaded.error }, { status: loaded.status });
  const { data: row } = (await db.from("responses").select(RESPONSE_COLUMNS + ", survey_id").eq("survey_id", params.id).eq("session_id", params.sessionId).maybeSingle()) as { data: any };
  if (!row) return NextResponse.json({ error: "not found" }, { status: 404 });
  const a = await assessAndStore(db, loaded.def, row);
  return NextResponse.json({ ok: true, quality: a });
}

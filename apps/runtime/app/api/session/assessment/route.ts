import { NextRequest, NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/admin";
import { resolveRunDefinition } from "@rescript/quality/server";
import { resultForSession } from "@/lib/assessmentPayload";

export const dynamic = "force-dynamic";

/**
 * THE RESULTS OF A SUBMITTED PAPER, AGAIN (K4 2026-10-25, ported 2026-10-29 — docs/ASSESSMENTS-2026-10-29.md).
 *
 * The final save returns the report; this serves it when that response was lost (a retry that found the
 * session already finalised, a reload of the thank-you page). TOKEN-BOUND: the credential is the session's
 * unguessable 128-bit id (the save route's auth model) — a result is served only to the session that produced
 * it, and only once that session is COMPLETE (before submission nothing here; the key never leaves the
 * server). The stored `assessment_results` row (0076) is served when it was scored against the key the
 * server holds now; otherwise — or before 0076 is applied — the stored answers are re-scored,
 * deterministically, against the server's definition. The report sections follow the paper's settings
 * (`showResults: never` → null).
 */
export async function POST(req: NextRequest) {
  const noStore = { "cache-control": "no-store" };
  const body = (await req.json().catch(() => null)) as { sessionId?: unknown; build?: unknown } | null;
  const sessionId = typeof body?.sessionId === "string" ? body.sessionId : "";
  if (sessionId.length < 16 || sessionId.length > 200) return NextResponse.json({ error: "invalid session" }, { status: 400, headers: noStore });
  const db = supabaseAdmin();
  const { data: row } = await db.from("responses").select("id, survey_id, version_id, status, is_test, answers, deleted_at").eq("session_id", sessionId).maybeSingle();
  if (!row || row.deleted_at) return NextResponse.json({ error: "unknown session" }, { status: 404, headers: noStore });
  if (row.status !== "complete") return NextResponse.json({ error: "results are available after the paper is submitted" }, { status: 409, headers: noStore });
  const run = await resolveRunDefinition(db, row, body?.build as never);
  const { data: stored, error } = await db.from("assessment_results").select("result").eq("session_id", sessionId).maybeSingle();
  if (error && !/assessment_results/.test(error.message)) console.error("[rescript:assessment] reading the stored result failed (re-scoring)", { sessionId: sessionId.slice(0, 8), error: error.message });
  const out = resultForSession(run.def, (row.answers ?? {}) as Record<string, unknown>, error ? null : stored?.result);
  return NextResponse.json({ ok: true, assessment: out?.report ?? null, source: out?.source ?? null }, { headers: noStore });
}

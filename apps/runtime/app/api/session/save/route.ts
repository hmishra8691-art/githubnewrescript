import { NextRequest, NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/admin";
import { SurveyDefinition } from "@rescript/schema";
import { quotaIncrements, type ResponseState } from "@rescript/engine";

export const dynamic = "force-dynamic";

/**
 * Persist session progress. Auth model: the sessionId is an unguessable
 * 128-bit token created server-side; only status/answers of that session
 * can be written, and only while it is in progress.
 */
export async function POST(req: NextRequest) {
  let body: any;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "bad json" }, { status: 400 });
  }
  const { sessionId, status, stepIndex, answers, calculated, embedded, flags, completed } = body ?? {};
  if (typeof sessionId !== "string" || sessionId.length < 16)
    return NextResponse.json({ error: "invalid session" }, { status: 400 });

  const db = supabaseAdmin();
  const { data: existing } = await db
    .from("responses")
    .select("id, survey_id, version_id, status, respondent_id, is_test")
    .eq("session_id", sessionId)
    .maybeSingle();
  if (!existing) return NextResponse.json({ error: "unknown session" }, { status: 404 });
  if (existing.status !== "in_progress")
    return NextResponse.json({ ok: true, note: "session already finalized" });

  const validStatus = ["in_progress", "complete", "screened", "quota_full", "terminated"];
  const newStatus = validStatus.includes(status) ? status : "in_progress";

  const { error } = await db
    .from("responses")
    .update({
      status: newStatus,
      step_index: Number(stepIndex) || 0,
      answers: answers ?? {},
      calculated: calculated ?? {},
      embedded: embedded ?? {},
      flags: flags ?? [],
      completed_at: completed ? new Date().toISOString() : null,
    })
    .eq("session_id", sessionId);
  if (error) return NextResponse.json({ error: "save failed" }, { status: 500 });

  // Finalize: increment quota counts + respondent status (live sessions only)
  if (completed && newStatus !== "in_progress") {
    if (!existing.is_test) {
      const { data: ver } = await db
        .from("survey_versions")
        .select("definition")
        .eq("id", existing.version_id)
        .single();
      const parsed = ver ? SurveyDefinition.safeParse(ver.definition) : null;
      if (parsed?.success && newStatus === "complete") {
        const state = {
          answers: answers ?? {},
          calculated: calculated ?? {},
          embedded: embedded ?? {},
          flags: flags ?? [],
        } as unknown as ResponseState;
        const cells = quotaIncrements(parsed.data, state);
        if (cells.length) {
          await db.rpc("increment_quota_counts", {
            p_survey_id: existing.survey_id,
            p_cells: cells,
          });
        }
      }
    }
    if (existing.respondent_id) {
      await db.from("respondents").update({ status: newStatus }).eq("id", existing.respondent_id);
    }
  }
  return NextResponse.json({ ok: true });
}

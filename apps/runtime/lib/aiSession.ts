import "server-only";
import { NextResponse } from "next/server";
import { SurveyDefinition } from "@rescript/schema";
import { resolveRunDefinition } from "@rescript/quality/server";
import { supabaseAdmin } from "@/lib/admin";
import { aiConfigured, aiProviderName } from "@/lib/ai";

/**
 * WHO MAY ASK THE AI PROVIDER, AND FOR WHICH SURVEY — shared by every route
 * that spends provider calls (`/api/session/ai`, `/api/session/probe`).
 *
 * Authentication is the session: a live in-progress `responses` row, exactly
 * as `/api/session/listfill` requires. Unconfigured provider → 501 and the
 * caller carries on without the value; the respondent never sees this.
 *
 * ONE CARVE-OUT, AND WHY. A preview has no session, and a real provider must
 * never be reachable without one — that is a cost and abuse surface. But a
 * programmer needs to SEE the mechanism work before fielding, and the browser
 * suite needs to prove the whole path without a database. So a preview may
 * resolve against the FAKE provider only: `sessionId: "preview"` with the
 * definition in the body is accepted when `AI_API_URL=fake:`, and refused
 * with 403 otherwise. The fake provider is deterministic and free, so the
 * carve-out costs nothing and leaks nothing.
 */
export async function definitionForAiCall(body: any): Promise<{ def: SurveyDefinition } | { response: NextResponse }> {
  const sessionId = body?.sessionId;
  if (typeof sessionId !== "string" || (sessionId !== "preview" && sessionId.length < 16))
    return { response: NextResponse.json({ error: "invalid session" }, { status: 400 }) };
  if (!aiConfigured()) return { response: NextResponse.json({ error: "AI is not configured on this runtime" }, { status: 501 }) };

  if (sessionId === "preview") {
    if (aiProviderName() !== "fake") {
      return { response: NextResponse.json({ error: "a preview cannot use the AI provider; open a test link to see real results" }, { status: 403 }) };
    }
    const parsed = SurveyDefinition.safeParse(body?.definition);
    if (!parsed.success) return { response: NextResponse.json({ error: "preview needs the definition in the body" }, { status: 400 }) };
    return { def: parsed.data };
  }

  const db = supabaseAdmin();
  const { data: existing } = await db
    .from("responses")
    .select("id, survey_id, version_id, status, is_test, deleted_at")
    .eq("session_id", sessionId)
    .maybeSingle();
  if (!existing) return { response: NextResponse.json({ error: "unknown session" }, { status: 404 }) };
  if (existing.deleted_at) return { response: NextResponse.json({ error: "this response was deleted by the survey owner" }, { status: 410 }) };
  if (existing.status !== "in_progress") return { response: NextResponse.json({ error: "this session is already finalised" }, { status: 409 }) };

  const run = await resolveRunDefinition(db, existing as never, body?.build);
  if (!run.def) return { response: NextResponse.json({ error: "the survey definition for this session could not be read" }, { status: 500 }) };
  return { def: run.def };
}

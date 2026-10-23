import { NextRequest, NextResponse } from "next/server";
import { REALTIME_TOOLS, realtimeSessionInstructions } from "@rescript/engine";
import { aiInterviewDeps, errorResponse } from "@/lib/aiInterview/runtimeDeps";
import { interviewFor } from "@/lib/aiInterview/gate";
import { planFor } from "@/lib/aiInterview/service";
import { mintRealtimeSession, RealtimeError, realtimeRefusal } from "@/lib/aiInterview/realtime";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * REALTIME (LOW-LATENCY) AI INTERVIEW — ONE SESSION'S SECRET (G1 2026-10-22). POST { sessionToken } for an
 * interview in progress that the participant started in the realtime style → a short-lived client secret
 * (10 minutes) for ONE WebRTC session whose instructions (the guide), tools, voice, transcription language
 * and turn detection (never answering by itself) are fixed here. The installation's key never leaves the
 * server. 501 with the reason when no provider is configured or it cannot be gated (the page then falls
 * back to the hands-free conversation). Each turn then goes through /api/ai-interview/turn (`realtime`).
 */
export async function POST(req: NextRequest) {
  try {
    const body = await req.json().catch(() => ({}));
    const refused = realtimeRefusal();
    if (refused) return NextResponse.json({ error: refused, code: "realtime_unavailable" }, { status: 501 });
    const deps = aiInterviewDeps();
    const { session, study } = await interviewFor(deps, body?.sessionToken, { live: true });
    if (session.mode !== "voice" || session.state?.voice?.style !== "realtime") return NextResponse.json({ error: "this interview is not a realtime voice interview", code: "not_realtime" }, { status: 400 });
    const plan = planFor(study, session.language);
    const s = await mintRealtimeSession({ instructions: realtimeSessionInstructions(plan), tools: REALTIME_TOOLS, language: session.language });
    return NextResponse.json({ ok: true, ...s }, { headers: { "cache-control": "no-store" } });
  } catch (e) {
    if (e instanceof RealtimeError) return NextResponse.json({ error: e.message, code: "realtime_failed" }, { status: e.status, headers: { "cache-control": "no-store" } });
    return errorResponse(e);
  }
}

import { NextRequest, NextResponse } from "next/server";
import { synthesizeSpeech } from "@rescript/ai";
import { aiInterviewDeps, billingFor, errorResponse, meteredSpeech } from "@/lib/aiInterview/runtimeDeps";
import { interviewFor } from "@/lib/aiInterview/gate";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * VOICE MODE: THE MODERATOR'S TURN, SPOKEN. POST { sessionToken, seq } — only a moderator turn this
 * interview already said can be spoken (this is not a free text-to-speech service). Through the
 * configured text-to-speech (the same `synthesizeSpeech` as the Studio's AI voice), metered per
 * character as `qual_ai_interview_tts`. 204 when no voice is available: the page uses the browser's.
 */
export async function POST(req: NextRequest) {
  try {
    const body = await req.json().catch(() => ({}));
    const deps = aiInterviewDeps();
    const { session, study } = await interviewFor(deps, body?.sessionToken);
    if (session.mode === "text") return NextResponse.json({ error: "this interview is in text mode" }, { status: 400 });
    const turns = await deps.store.turns(session.id);
    const t = turns.find((x) => x.seq === Number(body?.seq) && x.speaker === "moderator");
    if (!t) return NextResponse.json({ error: "no such moderator turn" }, { status: 404 });
    const text = t.text.slice(0, 1500);
    const out = await meteredSpeech(billingFor(study, session), text.length, session.language, () => synthesizeSpeech(text, { language: session.language, format: "mp3" })).catch(() => null);
    if (!out) return new NextResponse(null, { status: 204 });
    return new NextResponse(Buffer.from(out.bytes), { status: 200, headers: { "content-type": out.mimeType, "cache-control": "no-store", "x-duration-ms": String(out.durationMs) } });
  } catch (e) { return errorResponse(e); }
}

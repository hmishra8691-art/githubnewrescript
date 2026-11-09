import { NextRequest, NextResponse } from "next/server";
import { aiInterviewDeps, errorResponse, isFakeProvider } from "@/lib/aiInterview/runtimeDeps";
import { listen } from "@/lib/aiInterview/service";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export const maxDuration = 30;

/**
 * POST { sessionToken, answer } — while the participant has paused mid-answer in a spoken interview: is the answer
 * finished, or are they still forming it? `{ state: complete | continuing | unclear }`. Nothing is written; the page
 * uses it only to shorten or lengthen its wait (lib/voice/turnHold.ts). The `script` test seam is honoured only on
 * the fake provider.
 */
export async function POST(req: NextRequest) {
  let body: { sessionToken?: unknown; answer?: unknown; script?: unknown };
  try { body = await req.json(); } catch { return NextResponse.json({ error: "bad json" }, { status: 400 }); }
  if (!isFakeProvider()) delete body.script;
  try {
    const out = await listen(aiInterviewDeps(), { sessionToken: String(body.sessionToken ?? ""), answer: body.answer, script: body.script });
    return NextResponse.json({ ok: true, ...out }, { headers: { "cache-control": "no-store" } });
  } catch (e) { return errorResponse(e); }
}

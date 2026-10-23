import { NextRequest, NextResponse } from "next/server";
import { aiInterviewDeps, errorResponse, isFakeProvider } from "@/lib/aiInterview/runtimeDeps";
import { turn, type TurnBody } from "@/lib/aiInterview/service";
import { ndjsonResponse, wantsNdjson } from "@/lib/aiInterview/ndjson";
import { speechSink } from "@/lib/aiInterview/speech";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export const maxDuration = 60;

/**
 * POST { sessionToken, afterSeq, input: { kind: answer | silence | stop, text?, meta? }, original?,
 * audioMediaId?, videoMediaId?, durationMs? } — one participant input → the moderator's next turn.
 * The engine decides (rules for safety, caps, conditional probes; the model, metered and streamed,
 * within the allowed intents; scripted fallback when the provider fails). `afterSeq` makes a resend
 * idempotent: the stored answer is replayed. With `Accept: application/x-ndjson` the moderator's words
 * stream as they are written (ndjson.ts). The `script` test seam is honoured only on the fake provider.
 */
export async function POST(req: NextRequest) {
  let body: TurnBody;
  try { body = await req.json(); } catch { return NextResponse.json({ error: "bad json" }, { status: 400 }); }
  if (!isFakeProvider()) delete body.script;
  /* G1: the hands-free conversation asks for the reply's speech in the stream (gated sentences + their audio) */
  const wantsSpeech = (body as { voice?: { speak?: unknown } }).voice?.speak === true;
  const run = async (onSay?: (t: string, replace?: boolean) => void, speech?: ReturnType<typeof speechSink>) => {
    try { const out = await turn(aiInterviewDeps(), body, { onSay, ...(speech ? { onSpeak: speech.sink } : {}) }); await speech?.done(); return { status: 200, body: { ok: true, ...out } }; }
    catch (e) { await speech?.done().catch(() => {}); const r = errorResponse(e); return { status: r.status, body: await r.json() }; }
  };
  if (wantsNdjson(req.headers.get("accept"))) return ndjsonResponse((emit) => run((delta, replace) => emit({ type: "text", delta, ...(replace ? { replace: true } : {}) }), wantsSpeech ? speechSink(emit, () => String((body as { language?: unknown }).language ?? "en")) : undefined));
  const r = await run();
  return NextResponse.json(r.body, { status: r.status, headers: { "cache-control": "no-store" } });
}

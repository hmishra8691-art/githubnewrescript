import { NextRequest, NextResponse } from "next/server";
import { aiInterviewDeps, errorResponse, isFakeProvider } from "@/lib/aiInterview/runtimeDeps";
import { turn, type TurnBody } from "@/lib/aiInterview/service";
import { ndjsonResponse, wantsNdjson } from "@/lib/aiInterview/ndjson";

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
  const run = async (onSay?: (t: string, replace?: boolean) => void) => {
    try { return { status: 200, body: { ok: true, ...(await turn(aiInterviewDeps(), body, { onSay })) } }; }
    catch (e) { const r = errorResponse(e); return { status: r.status, body: await r.json() }; }
  };
  if (wantsNdjson(req.headers.get("accept"))) return ndjsonResponse((emit) => run((delta, replace) => emit({ type: "text", delta, ...(replace ? { replace: true } : {}) })));
  const r = await run();
  return NextResponse.json(r.body, { status: r.status, headers: { "cache-control": "no-store" } });
}

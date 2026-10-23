import { NextRequest, NextResponse } from "next/server";
import { aiInterviewDeps, errorResponse, isFakeProvider } from "@/lib/aiInterview/runtimeDeps";
import { begin, type BeginBody } from "@/lib/aiInterview/service";
import { ndjsonResponse, wantsNdjson } from "@/lib/aiInterview/ndjson";
import { speechSink } from "@/lib/aiInterview/speech";
import { panelParams } from "@/lib/panels";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export const maxDuration = 60;

/**
 * POST { token, test?, consent: { agreed, recording }, screener, mode, language, pid? } — consent
 * (refused without it) → screener (a screened-out participant is recorded and thanked) → admission
 * under the quotas → the opening turn. Answers `{ kind: "started", sessionToken, interview }` (the
 * token is the participant's resume key; only its hash is stored), `screened_out` or `full`.
 * Streams the opening as NDJSON when asked (a translated opening is written by the model).
 */
export async function POST(req: NextRequest) {
  let body: BeginBody;
  try { body = await req.json(); } catch { return NextResponse.json({ error: "bad json" }, { status: 400 }); }
  if (!isFakeProvider()) delete body.script;
  /* G3: the link's URL parameters (a panel's id and kept values) — bounded here */
  body.params = panelParams((body as { params?: unknown }).params);
  /* G1: the hands-free conversation asks for the reply's speech in the stream (gated sentences + their audio) */
  const wantsSpeech = (body as { speak?: unknown }).speak === true;
  const run = async (onSay?: (t: string, replace?: boolean) => void, speech?: ReturnType<typeof speechSink>) => {
    try { const out = await begin(aiInterviewDeps(), body, { onSay, ...(speech ? { onSpeak: speech.sink } : {}) }); await speech?.done(); return { status: 200, body: { ok: true, ...out } }; }
    catch (e) { await speech?.done().catch(() => {}); const r = errorResponse(e); return { status: r.status, body: await r.json() }; }
  };
  if (wantsNdjson(req.headers.get("accept"))) return ndjsonResponse((emit) => run((delta, replace) => emit({ type: "text", delta, ...(replace ? { replace: true } : {}) }), wantsSpeech ? speechSink(emit, () => String((body as { language?: unknown }).language ?? "en")) : undefined));
  const r = await run();
  return NextResponse.json(r.body, { status: r.status, headers: { "cache-control": "no-store" } });
}

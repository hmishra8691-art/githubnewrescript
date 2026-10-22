import { NextRequest, NextResponse } from "next/server";
import { aiInterviewDeps, errorResponse, isFakeProvider } from "@/lib/aiInterview/runtimeDeps";
import { begin, type BeginBody } from "@/lib/aiInterview/service";
import { ndjsonResponse, wantsNdjson } from "@/lib/aiInterview/ndjson";

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
  const run = async (onSay?: (t: string, replace?: boolean) => void) => {
    try { return { status: 200, body: { ok: true, ...(await begin(aiInterviewDeps(), body, { onSay })) } }; }
    catch (e) { const r = errorResponse(e); return { status: r.status, body: await r.json() }; }
  };
  if (wantsNdjson(req.headers.get("accept"))) return ndjsonResponse((emit) => run((delta, replace) => emit({ type: "text", delta, ...(replace ? { replace: true } : {}) })));
  const r = await run();
  return NextResponse.json(r.body, { status: r.status, headers: { "cache-control": "no-store" } });
}

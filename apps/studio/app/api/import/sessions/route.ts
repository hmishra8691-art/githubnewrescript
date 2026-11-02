import { NextRequest, NextResponse } from "next/server";
import { callerFrom } from "@/lib/import/sessionAccess";
import { importSessionStore } from "@/lib/import/sessionsServer";
import { summarize } from "@/lib/import/sessions";
import { isFailure, requireProjectFor, requireUser } from "@/lib/guard";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * IMPORT HISTORY (I4): the organisation's import sessions, newest first — what file, when, by whom, what came
 * of it (analyzed / applied / rolled back / failed / discarded), the report digest, and whether the file is
 * still kept (90 days). `?surveyId=` narrows to one project (the caller must be able to read it);
 * `?surveyId=sandbox` lists the sandbox's own sessions. Never returns the stored file or the full model.
 */
export async function GET(req: NextRequest) {
  const authed = await requireUser(req);
  const surveyId = req.nextUrl.searchParams.get("surveyId") ?? "";
  const sandbox = surveyId === "sandbox";
  const caller = callerFrom(authed, sandbox);
  if ("response" in caller) return caller.response;
  if (surveyId && !sandbox) {
    if (!caller.user) return NextResponse.json({ error: "sign in" }, { status: 401 });
    const ctx = await requireProjectFor(caller.user, surveyId, "project.read");
    if (isFailure(ctx)) return ctx.response;
  }
  if (!sandbox && !caller.user) return NextResponse.json({ error: "sign in" }, { status: 401 });
  const limit = Math.min(200, Math.max(1, Number(req.nextUrl.searchParams.get("limit") ?? 50) || 50));
  try {
    const store = importSessionStore();
    const rows = await store.list({ customerId: caller.customerId, surveyId: surveyId && !sandbox ? surveyId : undefined, limit });
    return NextResponse.json({ sessions: rows.map(summarize), store: store.kind });
  } catch (e) {
    /* a database without migration 0080: the history is simply not available yet */
    return NextResponse.json({ sessions: [], unavailable: (e as Error).message });
  }
}

import { NextRequest, NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/admin";
import { mediaDbOrResponse } from "@/lib/mediaRoute";
import { freshUrl, MediaError, PLAYBACK_URL_SECONDS } from "@rescript/media";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/** What a researcher attached to the survey: shown to every respondent who has the survey. */
const STIMULUS_KINDS = new Set(["question_video", "question_audio", "localization_audio", "survey_asset"]);

/**
 * THE STABLE URL, ON THE RESPONDENT'S SIDE.
 *
 * The runtime serves two things through the same URL shape:
 *
 * - **Stimulus** — the researcher's question video, its audio, a recorded
 *   reading, an attached image or PDF. These are the survey's content, shown
 *   to everyone who holds the survey link, so they are served for any survey
 *   that is not deleted. The id is a UUID; there is nothing to enumerate.
 *
 * - **A respondent's own recording** — replayed on their screen after they
 *   record it. Served only to the session that made it: the runtime's
 *   sessions are identified by the secret `sessionId` the browser holds, so
 *   the renderer appends it as `?s=` and this route matches it against the
 *   row. Anybody else, including another respondent, gets 404 — not 403,
 *   because "that exists but is not yours" is itself a disclosure.
 *
 * A 302 to a fifteen-minute signed URL either way; no bytes pass through.
 */
export async function GET(req: NextRequest, { params }: { params: { path: string[] } }) {
  /* `/api/media/<id>` or `/api/media/<id>/<file name>` — the name is for the browser, the id is what is looked up */
  const id = params.path?.[0] ?? "";
  if (!/^[0-9a-f-]{36}$/i.test(id) || (params.path?.length ?? 0) > 2) {
    return NextResponse.json({ error: "no such recording" }, { status: 404 });
  }
  const handle = mediaDbOrResponse();
  if ("response" in handle) return handle.response;

  const { data: row } = await handle.db.from("media_objects")
    .select("id, survey_id, session_id, kind, status").eq("id", id).maybeSingle();
  if (!row || row.status !== "stored") return NextResponse.json({ error: "no such recording" }, { status: 404 });

  if (STIMULUS_KINDS.has(row.kind as string)) {
    const { data: survey } = await supabaseAdmin().from("surveys").select("id, status").eq("id", row.survey_id).maybeSingle();
    if (!survey) return NextResponse.json({ error: "no such recording" }, { status: 404 });
  } else {
    const s = req.nextUrl.searchParams.get("s") ?? "";
    if (!s || s.length < 16 || s !== row.session_id) {
      return NextResponse.json({ error: "no such recording" }, { status: 404 });
    }
  }

  try {
    const { url } = await freshUrl(handle.db, id, { seconds: PLAYBACK_URL_SECONDS });
    return NextResponse.redirect(url, {
      status: 302,
      headers: { "cache-control": "private, max-age=300", "x-robots-tag": "noindex, nofollow" },
    });
  } catch (e) {
    const status = e instanceof MediaError ? e.status : 500;
    return NextResponse.json({ error: (e as Error).message }, { status });
  }
}

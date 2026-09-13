import { NextRequest, NextResponse } from "next/server";
import { isFailure, requireEditRight } from "@/lib/guard";
import { mediaDbOrResponse } from "@/lib/mediaRoute";
import { removeMedia, purgeQuestionMedia, MediaError } from "@rescript/media";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * DELETE MEANS DELETE.
 *
 * The Studio's "Delete" on a question video used to clear
 * `settings.interviewVideo` and nothing else — it deleted the reference and
 * left a file of up to 200 MB in the bucket with no remaining pointer to it.
 * Re-recording did the same: the path is timestamped and `upsert` is false,
 * so every take a researcher ever recorded was still there, invisible and
 * uncountable.
 *
 * Two shapes, because there are two occasions:
 *
 *   `mediaIds` — replacing one recording with another. The new take is
 *     uploaded FIRST and the old one named explicitly, so a failure leaves
 *     the researcher with a video rather than with neither.
 *   `questionId` — the question itself is going. Every take it ever had goes
 *     with it, not just the one currently referenced.
 *
 * Best-effort by design: object storage cannot join a transaction, and a
 * storage hiccup must not stop a researcher deleting a question. What it
 * cannot do is go unrecorded, which is what the warnings are for.
 */
export async function POST(req: NextRequest, { params }: { params: { id: string } }) {
  const gate = await requireEditRight(req, params.id, "survey.edit");
  if (isFailure(gate)) return gate.response;

  let body: Record<string, unknown>;
  try { body = await req.json(); } catch { return NextResponse.json({ error: "expected a JSON body" }, { status: 400 }); }

  const handle = mediaDbOrResponse();
  if ("response" in handle) return handle.response;
  const db = handle.db;

  const questionId = typeof body.questionId === "string" ? body.questionId.trim() : "";
  const mediaIds = Array.isArray(body.mediaIds)
    ? body.mediaIds.filter((x): x is string => typeof x === "string" && !!x.trim())
    : [];
  if (!questionId && !mediaIds.length) {
    return NextResponse.json({ error: "give mediaIds or a questionId" }, { status: 400 });
  }

  try {
    if (questionId) {
      const report = await purgeQuestionMedia(db, params.id, questionId);
      return NextResponse.json({ ok: true, ...report });
    }
    /* only rows that belong to THIS survey, whatever ids the caller sent */
    const { data: rows } = await db
      .from("media_objects").select("id, bucket, path, survey_id").in("id", mediaIds);
    const mine = (rows ?? []).filter((r: { survey_id: string }) => r.survey_id === params.id);
    const report = await removeMedia(db, mine);
    return NextResponse.json({ ok: true, ...report });
  } catch (e) {
    if (e instanceof MediaError) return NextResponse.json({ error: e.message }, { status: e.status });
    return NextResponse.json({ error: (e as Error).message }, { status: 500 });
  }
}

import { NextRequest, NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/admin";
import { isFailure, requireEditRight } from "@/lib/guard";
import { getMeter, projectContext, recordUsage } from "@/lib/metering";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * SURVEY VIDEO STORAGE — the researcher's recorded questions.
 *
 * Sibling of the audio route, and separate from it for one reason worth
 * stating: video is an order of magnitude larger. A minute of 720p webm is
 * 8–15 MB against a few hundred kilobytes for the same minute of speech, so
 * sharing the audio route's 20 MB ceiling would refuse ordinary two-minute
 * questions, and raising the audio route's ceiling to suit video would let a
 * runaway TTS job write 200 MB objects. Two limits, two buckets, one rule
 * each.
 *
 * Multipart: `file`, `questionId`. The object lands in the private
 * `rescript-video` bucket at `<surveyId>/<questionId>/<timestamp>-<name>` and
 * the response carries a long-lived signed URL plus the metadata the question
 * stores on `settings.interviewVideo` — duration, size, format, when it was
 * recorded.
 *
 * `survey.edit` on the project: recording the question IS writing the
 * question. Nothing about the bucket is public.
 *
 * The sandbox has no survey row, so the Studio keeps sandbox recordings as
 * object URLs and never calls this — the same carve-out the audio route has.
 */
const BUCKET = "rescript-video";
/** 200 MB: roughly fifteen minutes at a sane recording bitrate. */
const MAX_BYTES = 200 * 1024 * 1024;
const SIGNED_SECONDS = 60 * 60 * 24 * 365 * 5;

const EXT: Array<[RegExp, string]> = [
  [/webm/, "webm"], [/mp4|m4v/, "mp4"], [/quicktime|mov/, "mov"], [/ogg/, "ogv"],
];

export async function POST(req: NextRequest, { params }: { params: { id: string } }) {
  const gate = await requireEditRight(req, params.id, "survey.edit");
  if (isFailure(gate)) return gate.response;

  let form: FormData;
  try { form = await req.formData(); } catch { return NextResponse.json({ error: "expected multipart form data" }, { status: 400 }); }

  const file = form.get("file");
  const questionId = String(form.get("questionId") ?? "").replace(/[^A-Za-z0-9_-]/g, "").slice(0, 80);
  const durationSeconds = Number(form.get("durationSeconds") ?? 0);
  const width = Number(form.get("width") ?? 0);
  const height = Number(form.get("height") ?? 0);
  const source = String(form.get("source") ?? "uploaded") === "recorded" ? "recorded" : "uploaded";

  if (!(file instanceof File)) return NextResponse.json({ error: "file missing" }, { status: 400 });
  if (!questionId) return NextResponse.json({ error: "questionId required" }, { status: 400 });
  if (file.size > MAX_BYTES) {
    return NextResponse.json({ error: `the recording is ${(file.size / 1024 / 1024).toFixed(0)} MB — the limit is ${MAX_BYTES / 1024 / 1024} MB. Try a shorter clip or a lower quality setting.` }, { status: 413 });
  }
  /* video only, and said as a sentence: a researcher who picked the wrong
     file needs to know which file they picked, not a status code */
  if (!/^video\//.test(file.type || "")) {
    return NextResponse.json({ error: `“${file.name || "That file"}” is ${file.type || "an unknown type"} — please choose a video file.` }, { status: 415 });
  }

  let db;
  try { db = supabaseAdmin(); } catch (e) { return NextResponse.json({ error: (e as Error).message }, { status: 501 }); }

  const { data: buckets } = await db.storage.listBuckets();
  if (!buckets?.some((b) => b.name === BUCKET)) {
    const { error } = await db.storage.createBucket(BUCKET, { public: false, fileSizeLimit: MAX_BYTES });
    if (error && !/already exists/i.test(error.message)) {
      return NextResponse.json({ error: `could not create bucket: ${error.message}` }, { status: 500 });
    }
  }

  const ext = EXT.find(([re]) => re.test(file.type))?.[1] ?? "webm";
  const safeName = (file.name || `question.${ext}`).replace(/[^A-Za-z0-9._-]/g, "_").slice(0, 80);
  const path = `${params.id}/${questionId}/${Date.now()}-${safeName}`;
  const bytes = Buffer.from(await file.arrayBuffer());
  const up = await db.storage.from(BUCKET).upload(path, bytes, { contentType: file.type, upsert: false });
  if (up.error) return NextResponse.json({ error: up.error.message }, { status: 500 });
  const signed = await db.storage.from(BUCKET).createSignedUrl(path, SIGNED_SECONDS);
  if (signed.error) return NextResponse.json({ error: signed.error.message }, { status: 500 });

  void recordUsage(getMeter(), projectContext(gate), {
    eventType: "FILE_UPLOAD",
    quantity: Math.max(0.001, file.size / (1024 * 1024)),
    metadata: { kind: "interview_video", contentType: file.type, bytes: file.size, questionId },
  });

  /* exactly the shape `settings.interviewVideo` expects, so the caller
     stores what it is given rather than assembling a second version of it */
  return NextResponse.json({
    ok: true,
    video: {
      url: signed.data.signedUrl,
      path,
      mimeType: file.type,
      bytes: file.size,
      durationSeconds: Number.isFinite(durationSeconds) && durationSeconds > 0 ? Math.round(durationSeconds * 10) / 10 : undefined,
      width: Number.isFinite(width) && width > 0 ? Math.round(width) : undefined,
      height: Number.isFinite(height) && height > 0 ? Math.round(height) : undefined,
      recordedAt: new Date().toISOString(),
      source,
      status: "ready",
      fileName: safeName,
    },
  });
}

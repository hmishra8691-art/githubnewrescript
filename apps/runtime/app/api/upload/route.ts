import { NextRequest, NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/admin";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * Respondent uploads (file / photo / signature / audio variants).
 *
 * Multipart form: `file`, plus `sessionId` and `questionId` for the path. The
 * object lands in the private `rescript-uploads` bucket at
 * `<sessionId>/<questionId>/<timestamp>-<safe name>` and the answer stores a
 * signed URL (one year) with the name, size and type — so exports carry a
 * usable link and nothing about the bucket is public.
 *
 * Preview mode never calls this: the renderers keep a data URL locally.
 */
const BUCKET = "rescript-uploads";
const MAX_BYTES = 25 * 1024 * 1024;

export async function POST(req: NextRequest) {
  let form: FormData;
  try {
    form = await req.formData();
  } catch {
    return NextResponse.json({ error: "expected multipart form data" }, { status: 400 });
  }
  const file = form.get("file");
  const sessionId = String(form.get("sessionId") ?? "").replace(/[^A-Za-z0-9_-]/g, "");
  const questionId = String(form.get("questionId") ?? "").replace(/[^A-Za-z0-9_-]/g, "");
  if (!(file instanceof File)) return NextResponse.json({ error: "file missing" }, { status: 400 });
  if (!sessionId || !questionId) return NextResponse.json({ error: "sessionId and questionId required" }, { status: 400 });
  if (file.size > MAX_BYTES) return NextResponse.json({ error: `file exceeds ${MAX_BYTES / 1024 / 1024} MB` }, { status: 413 });

  let db;
  try {
    db = supabaseAdmin();
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 501 });
  }

  // idempotent bucket creation — the first upload on a fresh project makes it
  const { data: buckets } = await db.storage.listBuckets();
  if (!buckets?.some((b) => b.name === BUCKET)) {
    const { error } = await db.storage.createBucket(BUCKET, { public: false, fileSizeLimit: MAX_BYTES });
    if (error && !/already exists/i.test(error.message)) {
      return NextResponse.json({ error: `could not create bucket: ${error.message}` }, { status: 500 });
    }
  }

  const safeName = (file.name || "upload").replace(/[^A-Za-z0-9._-]/g, "_").slice(0, 80);
  const path = `${sessionId}/${questionId}/${Date.now()}-${safeName}`;
  const bytes = Buffer.from(await file.arrayBuffer());
  const up = await db.storage.from(BUCKET).upload(path, bytes, { contentType: file.type || "application/octet-stream", upsert: false });
  if (up.error) return NextResponse.json({ error: up.error.message }, { status: 500 });

  const signed = await db.storage.from(BUCKET).createSignedUrl(path, 60 * 60 * 24 * 365);
  if (signed.error) return NextResponse.json({ error: signed.error.message }, { status: 500 });

  return NextResponse.json({
    url: signed.data.signedUrl,
    path,
    name: file.name,
    size: file.size,
    type: file.type,
  });
}

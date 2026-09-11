import { NextRequest, NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/admin";
import { isFailure, requireEditRight, requireProject } from "@/lib/guard";
import { getMeter, projectContext, recordUsage } from "@/lib/metering";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * SURVEY AUDIO STORAGE — the recordings and generated audio of the
 * localization layer.
 *
 * Multipart form: `file`, `elementKey`, `language`, `kind` (human | ai). The
 * object lands in the private `rescript-audio` bucket at
 * `<surveyId>/<language>/<elementKey>/<timestamp>-<name>` and the response
 * carries a long-lived signed URL the definition stores on the AudioAsset.
 * Writing needs `survey.edit` on the survey's project: attaching a voice to a
 * question is authorship. Nothing about the bucket is public.
 *
 * The sandbox has no survey row; the Studio keeps its audio as data URLs in
 * the definition instead and never calls this.
 */
const BUCKET = "rescript-audio";
const MAX_BYTES = 20 * 1024 * 1024;
const SIGNED_SECONDS = 60 * 60 * 24 * 365 * 5;

export async function POST(req: NextRequest, { params }: { params: { id: string } }) {
  const gate = await requireEditRight(req, params.id, "survey.edit");
  if (isFailure(gate)) return gate.response;

  let form: FormData;
  try { form = await req.formData(); } catch { return NextResponse.json({ error: "expected multipart form data" }, { status: 400 }); }
  const file = form.get("file");
  const elementKey = String(form.get("elementKey") ?? "").replace(/[^A-Za-z0-9_:.-]/g, "_").slice(0, 120);
  const language = String(form.get("language") ?? "").replace(/[^A-Za-z0-9-]/g, "").slice(0, 20);
  const kind = String(form.get("kind") ?? "human") === "ai" ? "ai" : "human";
  if (!(file instanceof File)) return NextResponse.json({ error: "file missing" }, { status: 400 });
  if (!elementKey || !language) return NextResponse.json({ error: "elementKey and language required" }, { status: 400 });
  if (file.size > MAX_BYTES) return NextResponse.json({ error: `file exceeds ${MAX_BYTES / 1024 / 1024} MB` }, { status: 413 });
  if (!/^audio\//.test(file.type || "")) return NextResponse.json({ error: "only audio files are accepted" }, { status: 415 });

  let db;
  try { db = supabaseAdmin(); } catch (e) { return NextResponse.json({ error: (e as Error).message }, { status: 501 }); }
  const { data: buckets } = await db.storage.listBuckets();
  if (!buckets?.some((b) => b.name === BUCKET)) {
    const { error } = await db.storage.createBucket(BUCKET, { public: false, fileSizeLimit: MAX_BYTES });
    if (error && !/already exists/i.test(error.message)) return NextResponse.json({ error: `could not create bucket: ${error.message}` }, { status: 500 });
  }
  const ext = /wav/.test(file.type) ? "wav" : /webm/.test(file.type) ? "webm" : /ogg/.test(file.type) ? "ogg" : "mp3";
  const safeName = (file.name || `${kind}.${ext}`).replace(/[^A-Za-z0-9._-]/g, "_").slice(0, 80);
  const path = `${params.id}/${language}/${elementKey.replace(/:/g, "_")}/${Date.now()}-${safeName}`;
  const bytes = Buffer.from(await file.arrayBuffer());
  const up = await db.storage.from(BUCKET).upload(path, bytes, { contentType: file.type, upsert: false });
  if (up.error) return NextResponse.json({ error: up.error.message }, { status: 500 });
  const signed = await db.storage.from(BUCKET).createSignedUrl(path, SIGNED_SECONDS);
  if (signed.error) return NextResponse.json({ error: signed.error.message }, { status: 500 });
  // METERING: a stored recording is FILE_UPLOAD in MB on the project's wallet
  void recordUsage(getMeter(), projectContext(gate), { eventType: "FILE_UPLOAD", quantity: Math.max(0.001, file.size / (1024 * 1024)), metadata: { kind: "audio", contentType: file.type, bytes: file.size } });
  return NextResponse.json({ ok: true, url: signed.data.signedUrl, path, bytes: file.size, mimeType: file.type, fileName: safeName });
}

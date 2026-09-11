import { NextRequest, NextResponse } from "next/server";
import { synthesizeSpeech } from "@rescript/ai";
import { requireAiCaller } from "@/lib/aiGate";

export const dynamic = "force-dynamic";

/**
 * GENERATE AI AUDIO FOR ONE TRANSLATED STRING.
 *
 * Body: { text, language, voiceId?, gender?, speed?, style?, format? }
 * → { ok, dataUrl, mimeType, durationMs } — the audio as a data URL for the
 * programmer to PREVIEW. Nothing is stored: the Studio uploads it to the
 * survey's audio storage only when the programmer approves and attaches it,
 * and the asset is then marked AI-generated. Keys never leave the server.
 */
export async function POST(req: NextRequest) {
  const gate = await requireAiCaller(req);
  if (!gate.ok) return gate.response;
  let body: any;
  try { body = await req.json(); } catch { return NextResponse.json({ error: "bad json" }, { status: 400 }); }
  const text = typeof body?.text === "string" ? body.text : "";
  const language = typeof body?.language === "string" ? body.language : "en";
  if (!text.trim()) return NextResponse.json({ error: "text is required" }, { status: 400 });
  const out = await synthesizeSpeech(text, {
    language,
    voiceId: typeof body?.voiceId === "string" && body.voiceId ? body.voiceId : undefined,
    gender: typeof body?.gender === "string" ? body.gender : undefined,
    speed: typeof body?.speed === "number" ? body.speed : undefined,
    style: typeof body?.style === "string" ? body.style : undefined,
    format: body?.format === "wav" ? "wav" : "mp3",
  });
  if (!out) return NextResponse.json({ ok: true, dataUrl: null });
  const b64 = Buffer.from(out.bytes).toString("base64");
  return NextResponse.json({ ok: true, dataUrl: `data:${out.mimeType};base64,${b64}`, mimeType: out.mimeType, durationMs: out.durationMs });
}

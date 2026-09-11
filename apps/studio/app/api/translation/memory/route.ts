import { NextRequest, NextResponse } from "next/server";
import { rememberApproved } from "@rescript/ai";
import { requireTranslationCaller } from "@/lib/translationGate";
import { cachesFor } from "@/lib/translationCache";

export const dynamic = "force-dynamic";

/**
 * TRANSLATION MEMORY — an approved human wording, remembered for the customer
 * so the same sentence in the next survey gets it without a provider call
 * and never a machine result in its place.
 *
 *   POST { sourceText, sourceLanguage, targetLanguage, translatedText }
 */
export async function POST(req: NextRequest) {
  const gate = await requireTranslationCaller(req);
  if (!gate.ok) return gate.response;
  let body: any;
  try { body = await req.json(); } catch { return NextResponse.json({ error: "bad json" }, { status: 400 }); }
  const s = (k: string, max: number) => (typeof body?.[k] === "string" ? String(body[k]).slice(0, max) : "");
  const entry = { sourceText: s("sourceText", 8000), sourceLanguage: s("sourceLanguage", 12), targetLanguage: s("targetLanguage", 12), translatedText: s("translatedText", 8000) };
  if (!entry.sourceText.trim() || !entry.targetLanguage || !entry.translatedText.trim()) return NextResponse.json({ error: "sourceText, targetLanguage and translatedText are required" }, { status: 400 });
  await rememberApproved(entry, cachesFor(gate.user?.customerId ?? null));
  return NextResponse.json({ ok: true });
}

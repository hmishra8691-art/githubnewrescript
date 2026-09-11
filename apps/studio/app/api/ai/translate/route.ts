import { NextRequest, NextResponse } from "next/server";
import { translateBatch } from "@rescript/ai";
import { requireAiCaller } from "@/lib/aiGate";

export const dynamic = "force-dynamic";

/**
 * TRANSLATE A BATCH OF SURVEY STRINGS.
 *
 * Body: { items: [{ key, text, kind? }], sourceLanguage, targetLanguage,
 * locale?, glossary?: [{ source, target }], notes?, context? }
 * → { ok, translations: { key → text } } — only the strings that came back
 * with their placeholders and HTML intact; the client records each as an
 * "ai" translation for the programmer to review. Nothing is stored here.
 * Batches are capped at 80 strings; the client chunks a survey and reports
 * progress per language.
 */
export async function POST(req: NextRequest) {
  const gate = await requireAiCaller(req);
  if (!gate.ok) return gate.response;
  let body: any;
  try { body = await req.json(); } catch { return NextResponse.json({ error: "bad json" }, { status: 400 }); }
  const items = Array.isArray(body?.items) ? body.items.filter((i: any) => i && typeof i.key === "string" && typeof i.text === "string").slice(0, 80) : [];
  const sourceLanguage = typeof body?.sourceLanguage === "string" ? body.sourceLanguage : "en";
  const targetLanguage = typeof body?.targetLanguage === "string" ? body.targetLanguage.trim() : "";
  if (!items.length || !targetLanguage) return NextResponse.json({ error: "items and targetLanguage are required" }, { status: 400 });
  try {
    const translations = await translateBatch(items, {
      sourceLanguage, targetLanguage,
      locale: typeof body?.locale === "string" ? body.locale : undefined,
      glossary: Array.isArray(body?.glossary) ? body.glossary.filter((g: any) => g && typeof g.source === "string" && typeof g.target === "string") : undefined,
      notes: typeof body?.notes === "string" ? body.notes : undefined,
      context: typeof body?.context === "string" ? body.context : undefined,
    });
    return NextResponse.json({ ok: true, translations });
  } catch (e) {
    console.warn("[rescript:ai] translate failed", JSON.stringify({ error: (e as Error).message }));
    return NextResponse.json({ ok: true, translations: {} });
  }
}

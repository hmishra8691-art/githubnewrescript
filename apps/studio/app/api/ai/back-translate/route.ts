import { NextRequest, NextResponse } from "next/server";
import { reviewBackTranslation, translateWithCache } from "@rescript/ai";
import { requireTranslationSession } from "@/lib/translationGate";
import { cachesFor } from "@/lib/translationCache";
import { billingProjectFor, meteredTranslation, refusalResponse } from "@/lib/metering";

export const dynamic = "force-dynamic";

/**
 * BACK-TRANSLATION CHECK (audit 2026-11-17, P2-09).
 *
 *     Body   { surveyId, items: [{ key, source, translation, kind? }], sourceLanguage, targetLanguage, glossary? }
 *     Reply  { ok, provider, review: BackReview, back: { key → back-translation }, missing: [keys], error? }
 *
 * Each TRANSLATION goes back into the source language through the same provider gate, metering and refusals as
 * /api/ai/translate, with the cache off (a cached answer would not be a second reading), and the back-translation is
 * compared with the source by `reviewBackTranslation` — numbers, negation, scale polarity, intensity, placeholders,
 * glossary, content drift. A string the provider could not back-translate is listed in `missing` and is not scored.
 * Nothing is written here: the Studio stores the check in the survey's localization.
 */
export async function POST(req: NextRequest) {
  const session = await requireTranslationSession(req);
  if (!session.ok) return session.response;
  let body: any;
  try { body = await req.json(); } catch { return NextResponse.json({ error: "bad json" }, { status: 400 }); }
  const gate = await session.resolve(body?.surveyId);
  if (!gate.ok) return gate.response;
  const items = (Array.isArray(body?.items) ? body.items : [])
    .filter((i: any) => i && typeof i.key === "string" && typeof i.source === "string" && typeof i.translation === "string" && i.translation.trim() && i.translation.length <= 8000 && i.source.length <= 8000)
    .slice(0, 100) as { key: string; source: string; translation: string; kind?: string }[];
  const sourceLanguage = typeof body?.sourceLanguage === "string" ? body.sourceLanguage.slice(0, 12) : "en";
  const targetLanguage = typeof body?.targetLanguage === "string" ? body.targetLanguage.trim().slice(0, 12) : "";
  if (!items.length || !targetLanguage) return NextResponse.json({ error: "items and targetLanguage are required" }, { status: 400 });
  const glossary = Array.isArray(body?.glossary) ? body.glossary.filter((g: any) => g && typeof g.source === "string" && typeof g.target === "string").slice(0, 500) : undefined;

  const billing = await billingProjectFor(gate.user, body?.surveyId);
  if ("response" in billing) return billing.response;
  const characters = items.reduce((n, i) => n + i.translation.length, 0);
  /* the reverse direction: the translation is the text, the survey's source language the target */
  const metered = await meteredTranslation(billing.meter, billing.ctx, { characters, providerId: (gate.platform ?? gate.adapter).id, operation: `back-translate:${targetLanguage}->${sourceLanguage}` }, () => translateWithCache(
    items.map((i) => ({ key: i.key, text: i.translation, ...(i.kind ? { kind: i.kind } : {}) })),
    { sourceLanguage: targetLanguage, targetLanguage: sourceLanguage, useCache: false, caches: cachesFor(gate.user?.customerId ?? null), adapter: gate.adapter, context: "back-translation for a quality check: translate literally, keep the meaning exactly" },
  ));
  if (!metered.ok) return refusalResponse(metered);
  const result = metered.value;
  const back = result.translations;
  const done = items.filter((i) => typeof back[i.key] === "string");
  const review = reviewBackTranslation(done.map((i) => ({ key: i.key, source: i.source, translation: i.translation, back: back[i.key] })), { language: targetLanguage, glossary });
  const missing = items.filter((i) => typeof back[i.key] !== "string").map((i) => i.key);
  return NextResponse.json({ ok: !result.error, provider: result.provider, review, back, missing, error: result.error }, { status: result.error && !done.length ? (result.error.code === "rate_limit" || result.error.code === "quota" ? 429 : 503) : 200 });
}

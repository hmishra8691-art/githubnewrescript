import { NextRequest, NextResponse } from "next/server";
import { translateWithCache } from "@rescript/ai";
import { requireTranslationCaller } from "@/lib/translationGate";
import { cachesFor } from "@/lib/translationCache";

export const dynamic = "force-dynamic";

/**
 * TRANSLATE A BATCH OF SURVEY STRINGS — the Translation Manager's front door.
 *
 *     Body   { items: [{ key, text, kind? }], sourceLanguage, targetLanguage,
 *              locale?, glossary?: [{ source, target }], notes?, context?, useCache? }
 *     Reply  { ok, provider, translations: { key → text }, cached: [keys],
 *              error?: { code, message, retryable } }
 *
 * The cache (memory, then the customer's database rows) answers first; the
 * configured adapter — Google Cloud Translation, or the AI model — gets the
 * rest; results are cached. Only the caller's element KEYS and TEXT travel:
 * ids, codes and logic stay in the Studio. A string whose placeholders or
 * HTML came back damaged is absent from `translations` rather than stored
 * broken. Provider failures arrive as `error` beside whatever the cache had,
 * with a plain message and a `retryable` flag — never a raw provider body,
 * never a credential. Nothing is persisted here except the cache: the client
 * records each translation into the survey's `localization` as "ai".
 */
export async function POST(req: NextRequest) {
  const gate = await requireTranslationCaller(req);
  if (!gate.ok) return gate.response;
  let body: any;
  try { body = await req.json(); } catch { return NextResponse.json({ error: "bad json" }, { status: 400 }); }
  const items = Array.isArray(body?.items) ? body.items.filter((i: any) => i && typeof i.key === "string" && typeof i.text === "string" && i.text.length <= 8000).slice(0, 100) : [];
  const sourceLanguage = typeof body?.sourceLanguage === "string" ? body.sourceLanguage.slice(0, 12) : "en";
  const targetLanguage = typeof body?.targetLanguage === "string" ? body.targetLanguage.trim().slice(0, 12) : "";
  if (!items.length || !targetLanguage) return NextResponse.json({ error: "items and targetLanguage are required" }, { status: 400 });
  const result = await translateWithCache(items, {
    sourceLanguage, targetLanguage,
    locale: typeof body?.locale === "string" ? body.locale.slice(0, 20) : undefined,
    glossary: Array.isArray(body?.glossary) ? body.glossary.filter((g: any) => g && typeof g.source === "string" && typeof g.target === "string").slice(0, 500) : undefined,
    notes: typeof body?.notes === "string" ? body.notes.slice(0, 1000) : undefined,
    context: typeof body?.context === "string" ? body.context.slice(0, 300) : undefined,
    useCache: body?.useCache !== false,
    caches: cachesFor(gate.user?.customerId ?? null),
    adapter: gate.adapter,
  });
  const status = result.error ? (result.error.code === "auth" ? 502 : result.error.code === "rate_limit" || result.error.code === "quota" ? 429 : result.error.code === "unsupported_language" || result.error.code === "invalid" ? 422 : 503) : 200;
  return NextResponse.json({ ok: !result.error, provider: result.provider, translations: result.translations, cached: result.cached, error: result.error }, { status: result.error && !Object.keys(result.translations).length ? status : 200 });
}

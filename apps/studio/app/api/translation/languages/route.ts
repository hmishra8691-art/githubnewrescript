import { NextRequest, NextResponse } from "next/server";
import { LANGUAGE_LIBRARY } from "@rescript/schema";
import { googleLanguageCode } from "@rescript/ai";
import { requireTranslationCaller } from "@/lib/translationGate";

export const dynamic = "force-dynamic";

/**
 * THE LANGUAGES THE PROVIDER SUPPORTS, merged with the platform's library.
 * Every library language carries `supported` (the provider can translate
 * into it) and any provider-only languages are appended with the provider's
 * name for them — so the picker offers Google's full list, not a hard-coded
 * subset, while regional variants and directions still come from the library.
 */
export async function GET(req: NextRequest) {
  const gate = await requireTranslationCaller(req, req.nextUrl.searchParams.get("surveyId"));
  if (!gate.ok) return gate.response;
  /* asked of the provider that will translate — with the user's own key when that is whose it is (the list is free to ask) — and spelled the way that provider spells it */
  let providerList: { code: string; name?: string }[] | null = null;
  const keys = new Map<string, string>();
  try {
    await gate.scoped(async () => {
      providerList = await gate.adapter.supportedLanguages();
      for (const l of LANGUAGE_LIBRARY) keys.set(l.code, (gate.adapter.languageKey ? gate.adapter.languageKey(l.code) : googleLanguageCode(l.code)).toLowerCase());
    });
  } catch { providerList = null; }
  const keyOf = (code: string) => keys.get(code) ?? googleLanguageCode(code).toLowerCase();
  const supported = providerList ? new Set((providerList as { code: string }[]).map((l) => l.code.toLowerCase())) : null;
  const library = LANGUAGE_LIBRARY.map((l) => ({ code: l.code, name: l.name, nativeName: l.nativeName, direction: l.direction, locales: l.locales, supported: supported ? supported.has(keyOf(l.code)) || supported.has(l.code.toLowerCase()) : true, source: "library" as const }));
  const known = new Set(library.map((l) => keyOf(l.code)));
  const extra = ((providerList ?? []) as { code: string; name?: string }[]).filter((l) => !known.has(l.code.toLowerCase()) && !library.some((x) => x.code === l.code.toLowerCase())).map((l) => ({ code: l.code, name: l.name ?? l.code, nativeName: l.name ?? l.code, direction: "ltr" as const, locales: [], supported: true, source: "provider" as const }));
  return NextResponse.json({ provider: gate.adapter.id, via: gate.via, languages: [...library, ...extra] });
}

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
  const gate = await requireTranslationCaller(req);
  if (!gate.ok) return gate.response;
  let providerList: { code: string; name?: string }[] | null = null;
  try { providerList = await gate.adapter.supportedLanguages(); } catch { providerList = null; }
  const supported = providerList ? new Set(providerList.map((l) => l.code.toLowerCase())) : null;
  const library = LANGUAGE_LIBRARY.map((l) => ({ code: l.code, name: l.name, nativeName: l.nativeName, direction: l.direction, locales: l.locales, supported: supported ? supported.has(googleLanguageCode(l.code).toLowerCase()) || supported.has(l.code.toLowerCase()) : true, source: "library" as const }));
  const known = new Set(library.map((l) => googleLanguageCode(l.code).toLowerCase()));
  const extra = (providerList ?? []).filter((l) => !known.has(l.code.toLowerCase()) && !library.some((x) => x.code === l.code.toLowerCase())).map((l) => ({ code: l.code, name: l.name ?? l.code, nativeName: l.name ?? l.code, direction: "ltr" as const, locales: [], supported: true, source: "provider" as const }));
  return NextResponse.json({ provider: gate.adapter.id, languages: [...library, ...extra] });
}

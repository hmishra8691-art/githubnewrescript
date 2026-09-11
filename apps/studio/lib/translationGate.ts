import { NextRequest, NextResponse } from "next/server";
import { translationAdapter, type TranslationAdapter } from "@rescript/ai";
import { isFailure, requireUser, type AuthedUser } from "@/lib/guard";

/**
 * WHO MAY SPEND THE TRANSLATION PROVIDER — the translate, languages, status
 * and memory routes.
 *
 * A signed-in Studio user, always; their customer scopes the cache. No
 * provider → 501 with a plain message and the UI says so. The one carve-out
 * mirrors the AI routes': the FAKE provider (free, deterministic) may be
 * called from the sandbox without a session, so the browser suites and a
 * local developer can see the whole path work. Credentials never leave the
 * server; the adapter is the only thing that reads them.
 */
export async function requireTranslationCaller(req: NextRequest): Promise<{ ok: true; adapter: TranslationAdapter; user: AuthedUser | null } | { ok: false; response: NextResponse }> {
  const adapter = translationAdapter();
  if (!adapter) return { ok: false, response: NextResponse.json({ error: "No translation provider is configured on this Studio. Set GOOGLE_TRANSLATE_API_KEY (or AI_API_URL) on the server.", code: "unconfigured" }, { status: 501 }) };
  if (adapter.id === "fake") {
    const user = await requireUser(req);
    return { ok: true, adapter, user: isFailure(user) ? null : user };
  }
  const user = await requireUser(req);
  if (isFailure(user)) return { ok: false, response: user.response };
  return { ok: true, adapter, user };
}

import { NextRequest, NextResponse } from "next/server";
import { scopedTranslationAdapter, translationAdapter, type TranslationAdapter } from "@rescript/ai";
import { isFailure, requireUser, type AuthedUser } from "@/lib/guard";
import { connectionFor, inResolution } from "@/lib/byok/connect";
import { connectionRefusalStatus } from "@/lib/meterRun";
import type { Resolution } from "@/lib/byok/resolve";

/**
 * WHO MAY SPEND WHICH TRANSLATION PROVIDER — the translate, languages, status
 * and memory routes.
 *
 * A signed-in Studio user, always; their customer scopes the cache. WHOSE
 * provider is decided here, once, by the same resolver every model call uses:
 * the project's choice, else the acting user's own translation setting (a
 * Google / DeepL / Azure key of theirs, or their AI model), else the platform's.
 * A user-managed choice that cannot be honoured is a refusal in words — never the
 * platform's provider and its cost. No provider at all → 501 with a plain
 * message that also names the way out (add your own in Settings).
 *
 * The one carve-out mirrors the AI routes': the FAKE provider (free,
 * deterministic) may be called from the sandbox without a session, so the
 * browser suites and a local developer can see the whole path work. Credentials
 * never leave the server; the adapters are the only things that read them.
 */
export type TranslationCaller =
  | {
      ok: true;
      /** whose provider runs this: the user's own connection, or the platform's */
      via: "platform" | "user";
      /** what to hand `translateWithCache` — the platform's adapter, or the scoped one that reads the user's connection when it runs */
      adapter: TranslationAdapter;
      /** the PLATFORM's own adapter (reserved against on the platform path, and for a backstop the user allowed); null when it has none */
      platform: TranslationAdapter | null;
      user: AuthedUser | null;
      resolution: Resolution;
      /** run `fn` in the user's connection (a languages request is made with their key); untouched on the platform */
      scoped<T>(fn: () => Promise<T>): Promise<T>;
    }
  | { ok: false; response: NextResponse };

const NO_PROVIDER = "No translation provider is available. Add your own translation service in Settings → AI & Integrations → AI Provider Configuration, or ask your administrator to set GOOGLE_TRANSLATE_API_KEY (or AI_API_URL) on the server.";

/**
 * STEP ONE — WHO IS ASKING. The guard, and nothing else: a signed-in Studio
 * user (or, for the FAKE provider only, the sandbox). Run before the request
 * body is read, so an unauthenticated caller learns nothing and costs nothing.
 * Step two — whose provider, for which project — is `resolve`.
 */
export async function requireTranslationSession(req: NextRequest): Promise<{ ok: true; user: AuthedUser | null; resolve(surveyId?: unknown): Promise<TranslationCaller> } | { ok: false; response: NextResponse }> {
  const platform = translationAdapter();
  const authed = await requireUser(req);
  const user = isFailure(authed) ? null : authed;
  if (!user) {
    /* the fake provider needs no session; anything that spends does */
    if (platform?.id === "fake") return { ok: true, user: null, resolve: async () => ({ ok: true, via: "platform", adapter: platform, platform, user: null, resolution: { kind: "platform", reason: "default" }, scoped: (fn) => fn() }) };
    if (!platform) return { ok: false, response: NextResponse.json({ error: NO_PROVIDER, code: "unconfigured" }, { status: 501 }) };
    return { ok: false, response: (authed as { response: NextResponse }).response };
  }
  return {
    ok: true, user,
    async resolve(surveyId) {
      const id = typeof surveyId === "string" && surveyId.trim() ? surveyId.trim() : null;
      const resolution = await connectionFor({ userId: user.userId, customerId: user.customerId, surveyId: id, operation: "translate" });
      if (resolution.kind === "refused") return { ok: false, response: NextResponse.json({ error: resolution.message, code: "ai_connection", why: resolution.code, source: resolution.source }, { status: connectionRefusalStatus(resolution.code) }) };
      if (resolution.kind === "user") return { ok: true, via: "user", adapter: scopedTranslationAdapter, platform, user, resolution, scoped: (fn) => inResolution(resolution, fn) };
      if (!platform) return { ok: false, response: NextResponse.json({ error: NO_PROVIDER, code: "unconfigured" }, { status: 501 }) };
      return { ok: true, via: "platform", adapter: platform, platform, user, resolution, scoped: (fn) => fn() };
    },
  };
}

/** both steps at once, for a route whose project is not in a body */
export async function requireTranslationCaller(req: NextRequest, surveyId?: unknown): Promise<TranslationCaller> {
  const session = await requireTranslationSession(req);
  if (!session.ok) return session;
  return session.resolve(surveyId);
}

/**
 * The translation memory needs no provider at all — only a customer to keep the
 * approved wording for — so it must not be refused because the installation has
 * none (a user on their own key has no use for the platform's).
 */
export async function requireTranslationUser(req: NextRequest): Promise<{ ok: true; user: AuthedUser | null } | { ok: false; response: NextResponse }> {
  const authed = await requireUser(req);
  if (!isFailure(authed)) return { ok: true, user: authed };
  if (translationAdapter()?.id === "fake") return { ok: true, user: null };
  return { ok: false, response: authed.response };
}

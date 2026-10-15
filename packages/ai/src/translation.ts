import { LANGUAGE_LIBRARY } from "@rescript/schema";
import { collectUsage, reportUsage } from "./usage.js";
import { currentAiScope, type TranslateTarget } from "./connection.js";
import { translateBatch as llmTranslateBatch, fakeTranslate, aiConfigured, aiProviderName, placeholdersMatch, tagsBalanced, type TranslateItem, type TranslateOptions } from "./index.js";
import {
  FALLBACKABLE, FRIENDLY, protectPlaceholders, restorePlaceholders, TranslationProviderError,
  type SupportedLanguage, type TranslationAdapter, type TranslationAdapterId, type TranslationErrorCode,
} from "./translationCore.js";
import { AZURE_V3, DEEPL, GOOGLE_V2, PROTOCOLS, runService, serviceLanguages, type ServiceProtocol } from "./translateServices.js";

export * from "./translationCore.js";

/**
 * THE TRANSLATION ADAPTER — one interface, several providers, no provider
 * knowledge anywhere else.
 *
 *     Studio (Translation tab)
 *           ↓  /api/ai/translate   (signed-in user; the key never leaves the server)
 *     TranslationManager ── cache (memory + database) ──┐
 *           ↓                                           │
 *     TranslationAdapter                                │
 *        ├── GoogleTranslationAdapter   Cloud Translation v2 (primary)
 *        ├── LlmTranslationAdapter      the OpenAI-compatible chat provider (AI_API_URL)
 *        └── fake                       deterministic, for tests and local work
 *           ↓
 *     Translation Storage ← the survey's `localization` object, by element key
 *
 * Two invariants hold for EVERY provider, enforced here rather than trusted:
 * piping tokens, `{parameters}` and `${variables}` survive verbatim (they are
 * lifted out before the call and restored after; a result that lost one is
 * dropped), and HTML stays balanced. Internal ids never reach a provider at
 * all — callers send text, keyed by element key, and get text back.
 *
 * Errors are mapped to a small vocabulary with a plain-English message and a
 * `retryable` flag; raw provider bodies and credentials are never returned.
 */

/* ------------------------------------------------------------- google */

const GOOGLE_ENDPOINT = "https://translation.googleapis.com/language/translate/v2";

export function googleConfigured(): boolean {
  return !!(process.env.GOOGLE_TRANSLATE_API_KEY ?? "").trim();
}

/** the installation's own Cloud Translation key and address — read when used, and an unset key is the `unconfigured` failure */
function platformGoogleTarget(): TranslateTarget {
  const key = (process.env.GOOGLE_TRANSLATE_API_KEY ?? "").trim();
  if (!key) throw new TranslationProviderError("unconfigured", FRIENDLY.unconfigured, false);
  const base = (process.env.GOOGLE_TRANSLATE_ENDPOINT ?? "").trim().replace(/\/+$/, "") || GOOGLE_ENDPOINT;
  return { provider: "platform", base, key, model: "v2", platform: true, protocol: "google-v2" };
}

export const googleTranslationAdapter: TranslationAdapter = {
  id: "google",
  name: "Google Cloud Translation",
  configured: googleConfigured,
  languageKey: GOOGLE_V2.languageKey,
  async supportedLanguages() {
    if (!googleConfigured()) return null;
    return serviceLanguages(GOOGLE_V2, platformGoogleTarget(), false);
  },
  async translate(items, opts) {
    const r = await runService(GOOGLE_V2, platformGoogleTarget, items, opts);
    if (r.failure) { r.failure.partial = r.out; throw r.failure; }
    return r.out;
  },
};

/* ----------------------------------------------------------------- llm */

/** the chat model reads this many strings per request (`translateBatch` stops there) */
const LLM_BATCH = 80;

export const llmTranslationAdapter: TranslationAdapter = {
  id: "llm",
  name: "AI language model (OpenAI-compatible)",
  configured: () => aiConfigured() && aiProviderName() !== "fake",
  async supportedLanguages() { return null; },
  async translate(items, opts) {
    // the model is told about placeholders; the same lift-out/restore guards it anyway
    const clean = items.filter((i) => i.text?.trim());
    const out: Record<string, string> = {};
    for (let at = 0; at < clean.length; at += LLM_BATCH) {
      const protectedItems = clean.slice(at, at + LLM_BATCH).map((it) => ({ it, ...protectPlaceholders(it.text) }));
      let res: Record<string, string>;
      try { res = await llmTranslateBatch(protectedItems.map((p) => ({ ...p.it, text: p.text })), opts); }
      catch (e) { if (Object.keys(out).length && e instanceof Error) (e as Error & { partial?: Record<string, string> }).partial = out; throw e; }
      for (const p of protectedItems) {
        const t = res[p.it.key];
        if (!t) continue;
        const restored = restorePlaceholders(t, p.tokens);
        if (!restored.complete || !placeholdersMatch(p.it.text, restored.text) || !tagsBalanced(restored.text)) continue;
        out[p.it.key] = restored.text.trim();
      }
    }
    return out;
  },
};

export const fakeTranslationAdapter: TranslationAdapter = {
  id: "fake",
  name: "Fake provider (deterministic, for tests)",
  configured: () => aiProviderName() === "fake" || (process.env.TRANSLATION_PROVIDER ?? "").trim() === "fake",
  async supportedLanguages() { return LANGUAGE_LIBRARY.map((l) => ({ code: l.code, name: l.name })); },
  async translate(items, opts) {
    const out: Record<string, string> = {};
    let chars = 0;
    for (const it of items) if (it.text?.trim()) { out[it.key] = fakeTranslate(it.text, opts); chars += it.text.length; }
    if (chars) reportUsage({ kind: "translate", provider: "fake", model: "fake-translate", characters: chars, requests: 1, estimated: true });
    return out;
  },
};

/* ----------------------------------------------------- the user's own */

/** the installation's own translation provider, offered as a last resort the user explicitly allowed (null when it has none) */
export function platformTranslateTarget(): TranslateTarget | null {
  return translationAdapter() ? { provider: "platform", base: "", key: "", model: "platform", platform: true, label: "the platform's translation" } : null;
}

/** the cache identity of a service: the same provider's output is the same whoever's key made it, so Google is Google; no key or user is in it */
const CACHE_ID: Record<string, TranslationAdapterId> = { "google-translate": "google", deepl: "deepl", "deepl-free": "deepl", "azure-translator": "azure" };

const protocolOf = (t: TranslateTarget): ServiceProtocol | null => (t.protocol ? PROTOCOLS[t.protocol] : null);

/**
 * THE ADAPTER FOR A USER'S OWN CONNECTION. It has no state of its own: it reads
 * the connection of the call it is running in (`withAiScope`), which the
 * Studio's one billing door set from the acting user's saved settings.
 *
 *   - a translation SERVICE scope (their Google / DeepL / Azure key): try their
 *     primary; on a failure another provider can cure (auth, quota, rate limit,
 *     outage, a language this one lacks), try the fallbacks THEY listed in order,
 *     and the platform's own provider only if they allowed it. A request the
 *     provider found malformed is not forwarded. What was translated before a
 *     failure is kept and only the rest is offered on.
 *   - a CHAT scope (their AI model, set under "Other AI features"): the language
 *     model translates, through that connection's own chat fallbacks.
 *
 * Outside either scope it is not a provider at all (`configured()` is false) —
 * it never falls back to the installation's key by itself.
 */
export const scopedTranslationAdapter: TranslationAdapter = {
  get id(): TranslationAdapterId {
    const t = currentAiScope()?.translate;
    return t ? CACHE_ID[t.provider] ?? "llm-own" : "llm-own";
  },
  get name() {
    const s = currentAiScope();
    return s?.translate ? (s.translate.label?.split(" · ")[0] ?? "Your translation provider") : "Your AI model";
  },
  configured: () => { const s = currentAiScope(); return !!s?.translate || (!!s?.chat && s.chat.source !== "platform"); },
  languageKey(code) {
    const t = currentAiScope()?.translate;
    const p = t && protocolOf(t);
    return p ? p.languageKey(code) : GOOGLE_V2.languageKey(code);
  },
  async supportedLanguages() {
    const t = currentAiScope()?.translate;
    const p = t && protocolOf(t);
    return t && p ? serviceLanguages(p, t, true) : null;
  },
  async translate(items, opts) {
    const scope = currentAiScope();
    if (!scope?.translate) {
      if (scope?.chat && scope.chat.source !== "platform") return llmTranslationAdapter.translate(items, opts);
      throw new TranslationProviderError("unconfigured", "Your translation provider is not set up — check Settings → AI & Integrations → AI Provider Configuration.", false);
    }
    const primary = scope.translate;
    const hops: TranslateTarget[] = [primary, ...primary.fallbacks];
    let remaining = items.filter((i) => i.text?.trim());
    const out: Record<string, string> = {};
    let first: TranslationProviderError | null = null;
    for (let i = 0; i < hops.length && remaining.length; i++) {
      const hop = hops[i];
      const run = hop.platform ? await platformHop(remaining, opts) : await runUserHop(hop, remaining, opts, scope.translate.source, i > 0);
      Object.assign(out, run.out);
      if (!run.failure) return out;
      first ??= run.failure;
      remaining = run.undone.filter((x) => !(x.key in out));
      if (!FALLBACKABLE.has(run.failure.code)) break;
    }
    if (!first) return out;
    if (hops.length > 1 && FALLBACKABLE.has(first.code)) first.message += ` The fallback provider${hops.length > 2 ? "s" : ""} you listed did not complete it either.`;
    first.partial = out;
    throw first;
  },
};

async function runUserHop(hop: TranslateTarget, items: TranslateItem[], opts: TranslateOptions, source: "user" | "project" | "platform", usedFallback: boolean) {
  const p = protocolOf(hop);
  if (!p) return { out: {}, failure: new TranslationProviderError("invalid", "This translation provider is not set up correctly — check Settings → AI & Integrations → AI Provider Configuration.", false), undone: items };
  return runService(p, () => hop, items, opts, { source, providerId: hop.provider, usedFallback }, true);
}

/**
 * The platform's own provider as a listed backstop. What it spends is the
 * platform's, so every usage it reports is marked as the platform's and as a
 * fallback — the billing door then settles the hold it reserved up front for
 * exactly that, and nothing else.
 */
async function platformHop(items: TranslateItem[], opts: TranslateOptions) {
  const adapter = translationAdapter();
  if (!adapter) return { out: {} as Record<string, string>, failure: new TranslationProviderError("unconfigured", FRIENDLY.unconfigured, false), undone: items };
  const { value, usage } = await collectUsage(async () => {
    try { return { out: await adapter.translate(items, opts) } as { out: Record<string, string>; err?: undefined }; }
    catch (e) { return { out: ((e as { partial?: Record<string, string> }).partial ?? {}), err: e } as { out: Record<string, string>; err: unknown }; }
  });
  for (const u of usage) reportUsage({ ...u, source: "platform", providerId: "platform", usedFallback: true });
  if (!value.err) return { out: value.out, undone: [] as TranslateItem[] };
  const failure = value.err instanceof TranslationProviderError ? value.err : new TranslationProviderError("unavailable", FRIENDLY.unavailable, true);
  return { out: value.out, failure, undone: items.filter((i) => !(i.key in value.out)) };
}

/* ---------------------------------------------------------- selection */

/**
 * WHICH PROVIDER. `TRANSLATION_PROVIDER` (google | ai | fake) when set;
 * otherwise Google when its key is present, else the AI model when
 * configured, else the fake provider when the AI URL is `fake:`. Null means
 * translation is off and the Studio says so.
 */
export function translationAdapter(): TranslationAdapter | null {
  const pick = (process.env.TRANSLATION_PROVIDER ?? "").trim().toLowerCase();
  if (pick === "google") return googleConfigured() ? googleTranslationAdapter : null;
  if (pick === "ai" || pick === "llm") return llmTranslationAdapter.configured() ? llmTranslationAdapter : null;
  if (pick === "fake") return fakeTranslationAdapter;
  if (googleConfigured()) return googleTranslationAdapter;
  if (llmTranslationAdapter.configured()) return llmTranslationAdapter;
  if (fakeTranslationAdapter.configured()) return fakeTranslationAdapter;
  return null;
}

/* --------------------------------------------------------------- cache */

/** The cache key: what was said, from which language, into which, by whom. Approved human edits are stored under the same key so they win next time. */
export function cacheKey(sourceText: string, sourceLanguage: string, targetLanguage: string, provider: string): string {
  return `${sourceHash(sourceText)}|${sourceLanguage.toLowerCase()}|${targetLanguage.toLowerCase()}|${provider}`;
}
export function sourceHash(s: string): string {
  const t = s.replace(/\s+/g, " ").trim();
  let h1 = 2166136261, h2 = 5381;
  for (let i = 0; i < t.length; i++) { const c = t.charCodeAt(i); h1 ^= c; h1 = Math.imul(h1, 16777619); h2 = (Math.imul(h2, 33) ^ c) >>> 0; }
  return `${(h1 >>> 0).toString(36)}${h2.toString(36)}`;
}

export interface CacheEntry { key: string; sourceText: string; sourceLanguage: string; targetLanguage: string; provider: string; translatedText: string; approved?: boolean }

export interface TranslationCache {
  get(keys: string[]): Promise<Record<string, CacheEntry>>;
  set(entries: CacheEntry[]): Promise<void>;
}

/** In-process LRU — always present, bounded; the database cache sits in front of it on servers that have one. */
export class MemoryTranslationCache implements TranslationCache {
  private map = new Map<string, CacheEntry>();
  constructor(private max = 5000) {}
  async get(keys: string[]) {
    const out: Record<string, CacheEntry> = {};
    for (const k of keys) { const v = this.map.get(k); if (v) { this.map.delete(k); this.map.set(k, v); out[k] = v; } }
    return out;
  }
  async set(entries: CacheEntry[]) {
    for (const e of entries) {
      const prev = this.map.get(e.key);
      if (prev?.approved && !e.approved) continue; // an approved wording is never displaced by a machine result
      this.map.delete(e.key); this.map.set(e.key, e);
      if (this.map.size > this.max) this.map.delete(this.map.keys().next().value as string);
    }
  }
  get size() { return this.map.size; }
}

export const memoryCache = new MemoryTranslationCache();

/* -------------------------------------------------------------- manager */

export interface TranslateResult {
  translations: Record<string, string>;
  /** keys answered from the cache */
  cached: string[];
  provider: string;
  error?: { code: TranslationErrorCode; message: string; retryable: boolean };
}

/**
 * THE TRANSLATION MANAGER — cache first, provider for the rest, cache the
 * rest. A provider failure after some strings were cached still returns
 * those, with the error beside them, so the Studio can show what it has and
 * offer Retry for what it has not.
 */
export async function translateWithCache(items: TranslateItem[], opts: TranslateOptions & { useCache?: boolean; caches?: TranslationCache[]; adapter?: TranslationAdapter | null }): Promise<TranslateResult> {
  const adapter = opts.adapter === undefined ? translationAdapter() : opts.adapter;
  const caches = opts.caches ?? [memoryCache];
  const providerId = adapter?.id ?? "none";
  const useCache = opts.useCache !== false;
  const clean = items.filter((i) => i.text?.trim());
  const translations: Record<string, string> = {};
  const cachedKeys: string[] = [];
  let pending = clean;
  if (useCache && clean.length) {
    const byKey = new Map(clean.map((i) => [i.key, cacheKey(i.text, opts.sourceLanguage, opts.targetLanguage, providerId)]));
    for (const c of caches) {
      if (!pending.length) break;
      const hits = await c.get(pending.map((i) => byKey.get(i.key)!)).catch(() => ({} as Record<string, CacheEntry>));
      const still: TranslateItem[] = [];
      for (const i of pending) { const h = hits[byKey.get(i.key)!]; if (h && placeholdersMatch(i.text, h.translatedText)) { translations[i.key] = h.translatedText; cachedKeys.push(i.key); } else still.push(i); }
      pending = still;
    }
  }
  if (!pending.length) return { translations, cached: cachedKeys, provider: providerId };
  if (!adapter) return { translations, cached: cachedKeys, provider: providerId, error: { code: "unconfigured", message: FRIENDLY.unconfigured, retryable: false } };
  try {
    const fresh = await adapter.translate(pending, opts);
    Object.assign(translations, fresh);
    if (useCache) {
      const entries: CacheEntry[] = pending.filter((i) => fresh[i.key]).map((i) => ({ key: cacheKey(i.text, opts.sourceLanguage, opts.targetLanguage, providerId), sourceText: i.text, sourceLanguage: opts.sourceLanguage, targetLanguage: opts.targetLanguage, provider: providerId, translatedText: fresh[i.key] }));
      for (const c of caches) await c.set(entries).catch(() => {});
    }
    return { translations, cached: cachedKeys, provider: providerId };
  } catch (e) {
    const err = e instanceof TranslationProviderError ? e : new TranslationProviderError("unavailable", FRIENDLY.unavailable, true);
    /* what the provider translated (and billed) before it failed is kept, and remembered, instead of thrown away */
    const partial = (e as { partial?: Record<string, string> }).partial;
    if (partial && Object.keys(partial).length) {
      Object.assign(translations, partial);
      if (useCache) {
        const entries: CacheEntry[] = pending.filter((i) => partial[i.key]).map((i) => ({ key: cacheKey(i.text, opts.sourceLanguage, opts.targetLanguage, providerId), sourceText: i.text, sourceLanguage: opts.sourceLanguage, targetLanguage: opts.targetLanguage, provider: providerId, translatedText: partial[i.key] }));
        for (const c of caches) await c.set(entries).catch(() => {});
      }
    }
    return { translations, cached: cachedKeys, provider: providerId, error: err.toJSON() };
  }
}

/** Remember an approved human wording so the next survey that says the same thing gets it without a provider call. */
export async function rememberApproved(entry: Omit<CacheEntry, "key" | "provider"> & { provider?: string }, caches: TranslationCache[] = [memoryCache]): Promise<void> {
  const providers = entry.provider ? [entry.provider] : ["google", "llm", "fake", "none", "deepl", "azure", "llm-own"];
  const entries = providers.map((p) => ({ ...entry, provider: p, approved: true, key: cacheKey(entry.sourceText, entry.sourceLanguage, entry.targetLanguage, p) }));
  for (const c of caches) await c.set(entries).catch(() => {});
}

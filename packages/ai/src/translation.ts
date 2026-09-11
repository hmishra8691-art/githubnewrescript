import { LANGUAGE_LIBRARY } from "@rescript/schema";
import { reportUsage } from "./usage.js";
import { translateBatch as llmTranslateBatch, fakeTranslate, aiConfigured, aiProviderName, placeholdersMatch, tagsBalanced, type TranslateItem, type TranslateOptions } from "./index.js";

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

export type TranslationErrorCode = "auth" | "quota" | "rate_limit" | "unsupported_language" | "invalid" | "network" | "timeout" | "unavailable" | "unconfigured";

export class TranslationProviderError extends Error {
  constructor(public code: TranslationErrorCode, message: string, public retryable: boolean, public status?: number) { super(message); }
  toJSON() { return { code: this.code, message: this.message, retryable: this.retryable }; }
}

export const FRIENDLY: Record<TranslationErrorCode, string> = {
  auth: "The translation provider rejected the credentials. Check the API key configured on the server.",
  quota: "The translation provider's quota is used up for now. Try again later or raise the quota in the provider console.",
  rate_limit: "The translation provider is rate-limiting requests. The remaining strings will be retried more slowly.",
  unsupported_language: "The translation provider does not support this language pair.",
  invalid: "The provider refused the request — usually a string too long or an unsupported format.",
  network: "The translation provider could not be reached.",
  timeout: "The translation provider took too long to answer.",
  unavailable: "The translation provider is temporarily unavailable.",
  unconfigured: "No translation provider is configured on this server.",
};

export interface SupportedLanguage { code: string; name?: string }

export interface TranslationAdapter {
  readonly id: "google" | "llm" | "fake";
  readonly name: string;
  configured(): boolean;
  /** the provider's own list, or null when it has none to offer */
  supportedLanguages(): Promise<SupportedLanguage[] | null>;
  /** translate the given strings; keys map to translations; strings the provider could not handle are absent */
  translate(items: TranslateItem[], opts: TranslateOptions): Promise<Record<string, string>>;
}

/* --------------------------------------------------------- placeholders */

/**
 * LIFT OUT what must never be translated — `{{Q1}}`, `{answer}`, `${brand}`,
 * `[[…]]` — and put it back afterwards. The marker is a `translate="no"`
 * span with a language-neutral token, which Google's HTML mode leaves alone
 * and which survives a machine that ignores the attribute; `restore` finds
 * the tokens even if a provider moved or spaced them, and reports when one
 * went missing so the caller can drop that string rather than store a
 * broken one.
 */
export const PROTECT_RE = /\{\{[^}]+\}\}|\$\{[^}]+\}|\{\w+\}|\[\[[^\]]+\]\]/g;

export function protectPlaceholders(text: string): { text: string; tokens: string[] } {
  const tokens: string[] = [];
  const out = text.replace(PROTECT_RE, (m) => { tokens.push(m); return `<span translate="no" class="notranslate">RSV${tokens.length - 1}RSV</span>`; });
  return { text: out, tokens };
}

export function restorePlaceholders(translated: string, tokens: string[]): { text: string; complete: boolean } {
  let seen = 0;
  let out = translated.replace(/<span[^>]*>\s*RSV\s*(\d+)\s*RSV\s*<\/span>|RSV\s*(\d+)\s*RSV/gi, (_, a, b) => { seen++; const i = Number(a ?? b); return tokens[i] ?? ""; });
  out = out.replace(/\s+([,.;:!?])/g, "$1");
  return { text: out, complete: seen === tokens.length && tokens.every((t) => out.includes(t)) };
}

const HTML_ENTITIES: Record<string, string> = { "&#39;": "'", "&quot;": '"', "&amp;": "&", "&lt;": "<", "&gt;": ">", "&#34;": '"', "&nbsp;": " " };
/** HTML mode returns entities; a source that had no markup wants plain characters back. */
export function unescapeIfPlain(source: string, translated: string): string {
  if (/<[a-zA-Z][^>]*>/.test(source)) return translated;
  return translated.replace(/&#39;|&quot;|&amp;|&lt;|&gt;|&#34;|&nbsp;/g, (m) => HTML_ENTITIES[m] ?? m);
}

/* ------------------------------------------------------------- google */

/** Our language code + locale → what Google expects (zh needs its script variant; everything else the base code). */
export function googleLanguageCode(code: string, locale?: string): string {
  const base = code.toLowerCase().split(/[-_]/)[0];
  if (base === "zh") {
    const tag = (locale ?? code).toLowerCase();
    return /tw|hk|hant/.test(tag) ? "zh-TW" : "zh-CN";
  }
  if (base === "fil" || base === "tl") return "tl";
  if (base === "nb" || base === "nn") return "no";
  if (base === "he") return "iw";
  return base;
}

const GOOGLE_ENDPOINT = "https://translation.googleapis.com/language/translate/v2";
const GOOGLE_BATCH = 100;
const GOOGLE_TIMEOUT_MS = 20_000;

export function googleConfigured(): boolean {
  return !!(process.env.GOOGLE_TRANSLATE_API_KEY ?? "").trim();
}

function mapGoogleError(status: number, body: unknown): TranslationProviderError {
  const msg = String((body as { error?: { message?: string; status?: string } } | null)?.error?.message ?? "");
  const reason = String((body as { error?: { status?: string; errors?: { reason?: string }[] } } | null)?.error?.errors?.[0]?.reason ?? (body as { error?: { status?: string } } | null)?.error?.status ?? "");
  if (status === 401 || status === 403) {
    if (/quota|limit|exceeded|billing/i.test(msg + reason) && !/key|credential|permission|api not enabled|forbidden/i.test(msg)) return new TranslationProviderError("quota", FRIENDLY.quota, true, status);
    return new TranslationProviderError("auth", FRIENDLY.auth, false, status);
  }
  if (status === 429) return new TranslationProviderError(/quota/i.test(msg + reason) && !/rate|per minute|per user/i.test(msg) ? "quota" : "rate_limit", /quota/i.test(msg + reason) && !/rate|per minute|per user/i.test(msg) ? FRIENDLY.quota : FRIENDLY.rate_limit, true, status);
  if (status === 400) {
    if (/language|target|source/i.test(msg) && /invalid|unsupported|not supported/i.test(msg)) return new TranslationProviderError("unsupported_language", FRIENDLY.unsupported_language, false, status);
    return new TranslationProviderError("invalid", FRIENDLY.invalid, false, status);
  }
  if (status >= 500) return new TranslationProviderError("unavailable", FRIENDLY.unavailable, true, status);
  return new TranslationProviderError("invalid", FRIENDLY.invalid, false, status);
}

async function googleFetch(path: string, init: RequestInit, timeoutMs = GOOGLE_TIMEOUT_MS): Promise<unknown> {
  const key = (process.env.GOOGLE_TRANSLATE_API_KEY ?? "").trim();
  if (!key) throw new TranslationProviderError("unconfigured", FRIENDLY.unconfigured, false);
  const endpoint = (process.env.GOOGLE_TRANSLATE_ENDPOINT ?? "").trim().replace(/\/+$/, "") || GOOGLE_ENDPOINT;
  const url = `${endpoint}${path}${path.includes("?") ? "&" : "?"}key=${encodeURIComponent(key)}`;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const r = await fetch(url, { ...init, signal: ctrl.signal, cache: "no-store" });
    const body = await r.json().catch(() => null);
    if (!r.ok) throw mapGoogleError(r.status, body);
    return body;
  } catch (e) {
    if (e instanceof TranslationProviderError) throw e;
    if ((e as Error).name === "AbortError") throw new TranslationProviderError("timeout", FRIENDLY.timeout, true);
    throw new TranslationProviderError("network", FRIENDLY.network, true);
  } finally { clearTimeout(timer); }
}

let googleLanguagesCache: { at: number; list: SupportedLanguage[] } | null = null;

export const googleTranslationAdapter: TranslationAdapter = {
  id: "google",
  name: "Google Cloud Translation",
  configured: googleConfigured,
  async supportedLanguages() {
    if (!googleConfigured()) return null;
    if (googleLanguagesCache && Date.now() - googleLanguagesCache.at < 24 * 3600 * 1000) return googleLanguagesCache.list;
    const body = await googleFetch("/languages?target=en", { method: "GET" }) as { data?: { languages?: { language: string; name?: string }[] } };
    const list = (body?.data?.languages ?? []).map((l) => ({ code: l.language, name: l.name }));
    googleLanguagesCache = { at: Date.now(), list };
    return list;
  },
  async translate(items, opts) {
    const clean = items.filter((i) => i.text?.trim());
    if (!clean.length) return {};
    const source = googleLanguageCode(opts.sourceLanguage);
    const target = googleLanguageCode(opts.targetLanguage, opts.locale);
    if (source === target) return Object.fromEntries(clean.map((i) => [i.key, i.text]));
    const out: Record<string, string> = {};
    for (let i = 0; i < clean.length; i += GOOGLE_BATCH) {
      const chunk = clean.slice(i, i + GOOGLE_BATCH);
      const protectedItems = chunk.map((it) => ({ it, ...protectPlaceholders(applyDoNotTranslate(it.text, opts)) }));
      const q = protectedItems.map((p) => p.text);
      const body = await googleFetch("", {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ q, source, target, format: "html" }),
      }) as { data?: { translations?: { translatedText: string }[] } };
      // Google bills every character of `q` — the protected text, wrappers included — per request
      reportUsage({ kind: "translate", provider: "google", model: "v2", characters: q.reduce((n, t) => n + t.length, 0), requests: 1, estimated: false });
      const results = body?.data?.translations ?? [];
      protectedItems.forEach((p, k) => {
        const raw = results[k]?.translatedText;
        if (typeof raw !== "string" || !raw.trim()) return;
        const restored = restorePlaceholders(stripDoNotTranslate(raw), p.tokens);
        const text = unescapeIfPlain(p.it.text, restored.text).trim();
        if (!restored.complete || !placeholdersMatch(p.it.text, text) || !tagsBalanced(text)) { console.warn("[rescript:translate] google result dropped — placeholders or HTML changed", JSON.stringify({ key: p.it.key })); return; }
        out[p.it.key] = applyGlossaryTargets(text, opts);
      });
    }
    return out;
  },
};

/** Glossary terms that must not be translated are wrapped so the provider leaves them; preferred wordings are enforced afterwards. */
function applyDoNotTranslate(text: string, opts: TranslateOptions): string {
  let out = text;
  for (const g of opts.glossary ?? []) {
    if (!g.source.trim() || g.source !== g.target) continue;
    const re = new RegExp(`(^|[^\\p{L}\\p{N}_])(${g.source.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")})(?=$|[^\\p{L}\\p{N}_])`, "giu");
    out = out.replace(re, (_, pre, term) => `${pre}<span translate="no" class="notranslate rs-dnt">${term}</span>`);
  }
  return out;
}
function stripDoNotTranslate(text: string): string {
  return text.replace(/<span[^>]*rs-dnt[^>]*>([\s\S]*?)<\/span>/gi, "$1");
}
function applyGlossaryTargets(text: string, opts: TranslateOptions): string {
  let out = text;
  for (const g of opts.glossary ?? []) {
    if (!g.source.trim() || g.source === g.target || !g.target.trim()) continue;
    const re = new RegExp(`(^|[^\\p{L}\\p{N}_])${g.source.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?=$|[^\\p{L}\\p{N}_])`, "giu");
    out = out.replace(re, (_, pre) => `${pre}${g.target}`);
  }
  return out;
}

/* ----------------------------------------------------------------- llm */

export const llmTranslationAdapter: TranslationAdapter = {
  id: "llm",
  name: "AI language model (OpenAI-compatible)",
  configured: () => aiConfigured() && aiProviderName() !== "fake",
  async supportedLanguages() { return null; },
  async translate(items, opts) {
    // the model is told about placeholders; the same lift-out/restore guards it anyway
    const protectedItems = items.map((it) => ({ it, ...protectPlaceholders(it.text) }));
    const res = await llmTranslateBatch(protectedItems.map((p) => ({ ...p.it, text: p.text })), opts);
    const out: Record<string, string> = {};
    for (const p of protectedItems) {
      const t = res[p.it.key];
      if (!t) continue;
      const restored = restorePlaceholders(t, p.tokens);
      if (!restored.complete || !placeholdersMatch(p.it.text, restored.text) || !tagsBalanced(restored.text)) continue;
      out[p.it.key] = restored.text.trim();
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
    return { translations, cached: cachedKeys, provider: providerId, error: err.toJSON() };
  }
}

/** Remember an approved human wording so the next survey that says the same thing gets it without a provider call. */
export async function rememberApproved(entry: Omit<CacheEntry, "key" | "provider"> & { provider?: string }, caches: TranslationCache[] = [memoryCache]): Promise<void> {
  const providers = entry.provider ? [entry.provider] : ["google", "llm", "fake", "none"];
  const entries = providers.map((p) => ({ ...entry, provider: p, approved: true, key: cacheKey(entry.sourceText, entry.sourceLanguage, entry.targetLanguage, p) }));
  for (const c of caches) await c.set(entries).catch(() => {});
}

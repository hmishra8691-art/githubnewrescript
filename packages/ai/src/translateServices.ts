import { createHash } from "node:crypto";
import { currentAiScope, identityOf, type ConnectionSource, type TranslateTarget } from "./connection.js";
import { guardedFetch } from "./netguard.js";
import { placeholdersMatch, tagsBalanced, type TranslateItem, type TranslateOptions } from "./index.js";
import { reportUsage } from "./usage.js";
import {
  applyDoNotTranslate, applyGlossaryTargets, FRIENDLY, googleLanguageCode, ownFailure, protectPlaceholders, restorePlaceholders, RETRYABLE, stripDoNotTranslate, TranslationProviderError, unescapeIfPlain,
  type Marker, type SupportedLanguage, type TranslationErrorCode,
} from "./translationCore.js";

/**
 * THE TRANSLATION SERVICES' WIRE PROTOCOLS — Google Cloud Translation v2, DeepL,
 * Azure Translator v3 — behind one driver.
 *
 * A protocol knows only its own shape: how the request is built, how the answer
 * is read, how a failure is classified, how a language is spelled. Everything
 * that must be true of EVERY provider is done once, here, by the driver, not
 * trusted to each: placeholders and `${variables}` are lifted out before the
 * call and verified after (a string that lost one is dropped, never stored
 * broken); HTML stays balanced; glossary terms that must not change are
 * wrapped; what was translated before a failure is returned beside the failure
 * (it was paid for); the usage the provider will bill is reported.
 *
 * The same driver serves the installation's Google key and a user's own key of
 * any of the three — only the target (address, key, headers) differs, and a
 * user's target is only ever reached through the endpoint guard.
 */

export type ServiceProtocolId = "google-v2" | "deepl" | "azure-v3";

interface Codes { source: string; target: string }
interface Req { url: string; init: RequestInit }

export interface ServiceProtocol {
  id: ServiceProtocolId;
  /** what the provider calls itself in a message */
  label: string;
  /** how usage is reported (and, on the platform's own path, priced) */
  usage: { provider: string; model: string; exact: boolean };
  marker: Marker;
  maxItems: number;
  maxChars: number;
  authHint?: string;
  codes(opts: TranslateOptions): Codes;
  /** is the pair a no-op? */
  same(c: Codes): boolean;
  request(t: TranslateTarget, texts: string[], c: Codes): Req;
  parse(body: unknown): (string | undefined)[] | null;
  classify(status: number, body: unknown): TranslationErrorCode;
  languages(t: TranslateTarget): Req;
  parseLanguages(body: unknown): SupportedLanguage[];
  /** how a library code is spelled in `parseLanguages` output */
  languageKey(code: string): string;
}

const J = { "content-type": "application/json" };
const str = (v: unknown) => String(v ?? "");

/* ------------------------------------------------------------- google */

function classifyGoogle(status: number, body: unknown): TranslationErrorCode {
  const e = (body as { error?: { message?: string; status?: string; errors?: { reason?: string }[] } } | null)?.error;
  const msg = str(e?.message);
  const reason = str(e?.errors?.[0]?.reason ?? e?.status);
  if (status === 401 || status === 403) return /quota|limit|exceeded|billing/i.test(msg + reason) && !/key|credential|permission|api not enabled|forbidden/i.test(msg) ? "quota" : "auth";
  if (status === 429) return /quota/i.test(msg + reason) && !/rate|per minute|per user/i.test(msg) ? "quota" : "rate_limit";
  if (status === 400) return /language|target|source/i.test(msg) && /invalid|unsupported|not supported/i.test(msg) ? "unsupported_language" : /API key not valid|API_KEY_INVALID/i.test(msg + reason) ? "auth" : "invalid";
  if (status >= 500) return "unavailable";
  return "invalid";
}

export const GOOGLE_V2: ServiceProtocol = {
  id: "google-v2", label: "Google Cloud Translation", usage: { provider: "google", model: "v2", exact: true }, marker: "span", maxItems: 100, maxChars: 28_000,
  authHint: " Also check that the Cloud Translation API is enabled for the key's project.",
  codes: (o) => ({ source: googleLanguageCode(o.sourceLanguage), target: googleLanguageCode(o.targetLanguage, o.locale) }),
  same: (c) => c.source === c.target,
  request(t, texts, c) {
    /* the installation's own key keeps its documented place in the query; a user's key never goes into a URL */
    const body = JSON.stringify({ q: texts, source: c.source, target: c.target, format: "html" });
    if (t.platform) return { url: `${t.base}?key=${encodeURIComponent(t.key)}`, init: { method: "POST", headers: J, body } };
    return { url: t.base, init: { method: "POST", headers: { ...J, ...(t.headers ?? {}), "x-goog-api-key": t.key }, body } };
  },
  parse: (b) => (b as { data?: { translations?: { translatedText?: string }[] } } | null)?.data?.translations?.map((x) => x?.translatedText) ?? null,
  classify: classifyGoogle,
  languages(t) {
    if (t.platform) return { url: `${t.base}/languages?target=en&key=${encodeURIComponent(t.key)}`, init: { method: "GET" } };
    return { url: `${t.base}/languages?target=en`, init: { method: "GET", headers: { ...(t.headers ?? {}), "x-goog-api-key": t.key } } };
  },
  parseLanguages: (b) => ((b as { data?: { languages?: { language: string; name?: string }[] } } | null)?.data?.languages ?? []).map((l) => ({ code: l.language, name: l.name })),
  languageKey: (code) => googleLanguageCode(code).toLowerCase(),
};

/* -------------------------------------------------------------- deepl */

const deeplBase = (code: string) => code.toLowerCase().split(/[-_]/)[0];
function deeplTarget(code: string, locale?: string): string {
  const base = deeplBase(code);
  const tag = (locale ?? code).toLowerCase().replace("_", "-");
  if (base === "en") return /(^|-)(gb|au|nz|ie|za|in)$/.test(tag) ? "EN-GB" : "EN-US";
  if (base === "pt") return tag === "pt-pt" ? "PT-PT" : "PT-BR";
  if (base === "zh") return /tw|hk|hant/.test(tag) ? "ZH-HANT" : "ZH";
  if (base === "no" || base === "nn" || base === "nb") return "NB";
  return base.toUpperCase();
}
function deeplSource(code: string): string {
  const base = deeplBase(code);
  return base === "no" || base === "nn" ? "NB" : base.toUpperCase();
}

export const DEEPL: ServiceProtocol = {
  id: "deepl", label: "DeepL", usage: { provider: "deepl", model: "v2", exact: false }, marker: "x", maxItems: 50, maxChars: 100_000,
  authHint: " (A key ending in :fx is a DeepL API Free key — choose DeepL API Free for those, DeepL API Pro otherwise.)",
  codes: (o) => ({ source: deeplSource(o.sourceLanguage), target: deeplTarget(o.targetLanguage, o.locale) }),
  same: (c) => c.source.toLowerCase() === c.target.toLowerCase().split("-")[0] && !/^zh-/i.test(c.target),
  request: (t, texts, c) => ({ url: `${t.base}/translate`, init: { method: "POST", headers: { ...J, ...(t.headers ?? {}), authorization: `DeepL-Auth-Key ${t.key}` }, body: JSON.stringify({ text: texts, source_lang: c.source, target_lang: c.target, tag_handling: "html", ignore_tags: ["x"] }) } }),
  parse: (b) => (b as { translations?: { text?: string }[] } | null)?.translations?.map((x) => x?.text) ?? null,
  classify(status, body) {
    const msg = str((body as { message?: string; detail?: string } | null)?.message ?? (body as { detail?: string } | null)?.detail);
    if (status === 401 || status === 403) return "auth";
    if (status === 456) return "quota";
    if (status === 429 || status === 529) return "rate_limit";
    if (status === 400) return /target_lang|source_lang|language/i.test(msg) ? "unsupported_language" : "invalid";
    if (status >= 500) return "unavailable";
    return "invalid";
  },
  languages: (t) => ({ url: `${t.base}/languages?type=target`, init: { method: "GET", headers: { ...(t.headers ?? {}), authorization: `DeepL-Auth-Key ${t.key}` } } }),
  parseLanguages(b) {
    /* EN-GB and EN-US are one language to the picker; the regional spelling is chosen from the survey's locale */
    const seen = new Map<string, SupportedLanguage>();
    for (const l of (Array.isArray(b) ? b : []) as { language?: string; name?: string }[]) {
      if (!l?.language) continue;
      const code = deeplBase(l.language);
      if (!seen.has(code)) seen.set(code, { code, name: str(l.name).replace(/\s*\(.*\)\s*$/, "") || undefined });
    }
    return [...seen.values()];
  },
  languageKey: (code) => { const b = deeplBase(code); return b === "no" || b === "nn" ? "nb" : b; },
};

/* -------------------------------------------------------------- azure */

function azureCode(code: string, locale?: string): string {
  const base = code.toLowerCase().split(/[-_]/)[0];
  const tag = (locale ?? code).toLowerCase().replace("_", "-");
  if (base === "zh") return /tw|hk|hant/.test(tag) ? "zh-Hant" : "zh-Hans";
  if (base === "pt") return tag === "pt-pt" ? "pt-pt" : "pt";
  if (base === "no" || base === "nn") return "nb";
  if (base === "tl") return "fil";
  if (base === "iw") return "he";
  return base;
}

export const AZURE_V3: ServiceProtocol = {
  id: "azure-v3", label: "Microsoft Azure Translator", usage: { provider: "microsoft", model: "3.0", exact: true }, marker: "span", maxItems: 100, maxChars: 40_000,
  authHint: " Check the key belongs to a Translator resource and that the region matches it.",
  codes: (o) => ({ source: azureCode(o.sourceLanguage), target: azureCode(o.targetLanguage, o.locale) }),
  same: (c) => c.source.toLowerCase() === c.target.toLowerCase(),
  request: (t, texts, c) => ({
    url: `${t.base}/translate?api-version=3.0&from=${encodeURIComponent(c.source)}&to=${encodeURIComponent(c.target)}&textType=html`,
    init: { method: "POST", headers: { ...J, ...(t.headers ?? {}), "ocp-apim-subscription-key": t.key }, body: JSON.stringify(texts.map((Text) => ({ Text }))) },
  }),
  parse: (b) => (Array.isArray(b) ? (b as { translations?: { text?: string }[] }[]).map((x) => x?.translations?.[0]?.text) : null),
  classify(status, body) {
    const e = (body as { error?: { code?: number | string; message?: string } } | null)?.error;
    const msg = str(e?.message), code = Number(e?.code);
    if (status === 401) return "auth";
    if (status === 403) return /quota|exceed|call volume|limit/i.test(msg) || code === 403001 ? "quota" : "auth";
    if (status === 429) return "rate_limit";
    if (status === 408) return "timeout";
    if (status === 400) return code === 400035 || code === 400036 || code === 400038 || /language/i.test(msg) ? "unsupported_language" : "invalid";
    if (status >= 500) return "unavailable";
    return "invalid";
  },
  languages: (t) => ({ url: `${t.base}/languages?api-version=3.0&scope=translation`, init: { method: "GET" } }),
  parseLanguages(b) {
    const seen = new Map<string, SupportedLanguage>();
    for (const [code, v] of Object.entries(((b as { translation?: Record<string, { name?: string }> } | null)?.translation) ?? {})) {
      const k = /^zh-han[st]$/i.test(code) ? "zh" : code.toLowerCase();
      if (!seen.has(k)) seen.set(k, { code: k, name: v?.name });
    }
    return [...seen.values()];
  },
  languageKey(code) { const c = azureCode(code).toLowerCase(); return c.startsWith("zh-") ? "zh" : c; },
};

export const PROTOCOLS: Record<ServiceProtocolId, ServiceProtocol> = { "google-v2": GOOGLE_V2, deepl: DEEPL, "azure-v3": AZURE_V3 };

/* ------------------------------------------------------------- driver */

const TIMEOUT_MS = 20_000;

export interface HopContext { source?: ConnectionSource; providerId?: string; usedFallback?: boolean }
export interface ServiceRun { out: Record<string, string>; failure?: TranslationProviderError; /** the strings still to translate when the run stopped */ undone: TranslateItem[] }

function failure(p: ServiceProtocol, t: TranslateTarget, own: boolean, code: TranslationErrorCode, status?: number): TranslationProviderError {
  return new TranslationProviderError(code, own ? ownFailure(code, t.label?.split(" · ")[0] ?? p.label, status, code === "auth" ? p.authHint : "") : FRIENDLY[code], RETRYABLE[code], status);
}

/** one HTTP exchange with the service, the failure classified and worded */
async function exchange(p: ServiceProtocol, t: TranslateTarget, own: boolean, req: Req): Promise<unknown> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  try {
    /* the installation's own provider keeps the platform `fetch`; anything a user supplied goes through the endpoint guard (pinned address, https, no redirects) */
    const r = t.platform
      ? await fetch(req.url, { ...req.init, signal: ctrl.signal, cache: "no-store" })
      : await guardedFetch(req.url, { ...req.init, signal: ctrl.signal }, { allowPrivate: currentAiScope()?.allowPrivate, maxResponseBytes: 8 * 1024 * 1024 });
    const text = await r.text();
    let body: unknown = null;
    try { body = JSON.parse(text); } catch { /* not JSON */ }
    if (!r.ok) throw failure(p, t, own, p.classify(r.status, body), r.status);
    return body;
  } catch (e) {
    if (e instanceof TranslationProviderError) throw e;
    if ((e as Error).name === "AbortError") throw failure(p, t, own, "timeout");
    throw failure(p, t, own, "network");
  } finally { clearTimeout(timer); }
}

/**
 * Translate `items` with one service. Returns what was translated, and — if a
 * request failed — the failure and the strings not yet done, so the caller can
 * keep the first and offer the rest to a fallback.
 */
export async function runService(p: ServiceProtocol, getTarget: () => TranslateTarget, items: TranslateItem[], opts: TranslateOptions, ctx: HopContext = {}, own = false): Promise<ServiceRun> {
  const clean = items.filter((i) => i.text?.trim());
  if (!clean.length) return { out: {}, undone: [] };
  const codes = p.codes(opts);
  if (p.same(codes)) return { out: Object.fromEntries(clean.map((i) => [i.key, i.text])), undone: [] };
  const t = getTarget();
  const out: Record<string, string> = {};
  let at = 0;
  while (at < clean.length) {
    /* a batch is bounded by the service's own limits, by count and by characters */
    const batch: { it: TranslateItem; text: string; tokens: string[] }[] = [];
    let chars = 0;
    while (at + batch.length < clean.length && batch.length < p.maxItems) {
      const it = clean[at + batch.length];
      const prot = protectPlaceholders(applyDoNotTranslate(it.text, opts, p.marker), p.marker);
      if (batch.length && chars + prot.text.length > p.maxChars) break;
      batch.push({ it, ...prot }); chars += prot.text.length;
    }
    let results: (string | undefined)[] | null;
    try {
      const body = await exchange(p, t, own, p.request(t, batch.map((b) => b.text), codes));
      results = p.parse(body);
    } catch (e) {
      return { out, failure: e as TranslationProviderError, undone: clean.slice(at) };
    }
    /* the provider bills every character it was sent — the protected text, wrappers included — per request */
    reportUsage({ kind: "translate", provider: p.usage.provider, model: p.usage.model, characters: chars, requests: 1, estimated: !p.usage.exact, ...(ctx.source ? { source: ctx.source, providerId: ctx.providerId ?? t.provider, usedFallback: !!ctx.usedFallback } : {}) });
    batch.forEach((b, k) => {
      const raw = results?.[k];
      if (typeof raw !== "string" || !raw.trim()) return;
      const restored = restorePlaceholders(stripDoNotTranslate(raw), b.tokens);
      const text = unescapeIfPlain(b.it.text, restored.text).trim();
      if (!restored.complete || !placeholdersMatch(b.it.text, text) || !tagsBalanced(text)) { console.warn("[rescript:translate] result dropped — placeholders or HTML changed", JSON.stringify({ provider: p.id, key: b.it.key })); return; }
      out[b.it.key] = applyGlossaryTargets(text, opts);
    });
    at += batch.length;
  }
  return { out, undone: [] };
}

const languageCache = new Map<string, { at: number; list: SupportedLanguage[] }>();

/** the service's own list of languages (free to ask), kept a day per connection */
export async function serviceLanguages(p: ServiceProtocol, t: TranslateTarget, own: boolean): Promise<SupportedLanguage[]> {
  const k = createHash("sha256").update(`${p.id}\0${identityOf(t)}`).digest("hex").slice(0, 24);
  const hit = languageCache.get(k);
  if (hit && Date.now() - hit.at < 24 * 3600 * 1000) return hit.list;
  const list = p.parseLanguages(await exchange(p, t, own, p.languages(t)));
  languageCache.set(k, { at: Date.now(), list });
  if (languageCache.size > 200) languageCache.delete(languageCache.keys().next().value as string);
  return list;
}

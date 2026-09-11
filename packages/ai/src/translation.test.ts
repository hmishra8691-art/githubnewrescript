import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import {
  protectPlaceholders, restorePlaceholders, unescapeIfPlain, googleLanguageCode, googleTranslationAdapter, translateWithCache,
  MemoryTranslationCache, cacheKey, rememberApproved, translationAdapter, fakeTranslationAdapter, TranslationProviderError,
} from "./translation.js";

/**
 * THE GOOGLE ADAPTER — with the network replaced. What these hold: the key
 * is only ever in the URL of a server-side call; placeholders and HTML go
 * out protected and come back intact or the string is dropped; every
 * failure class maps to a plain message with the right retryable flag; the
 * cache answers before the provider and an approved wording beats a machine
 * result.
 */

const realFetch = globalThis.fetch;
const envBackup = { ...process.env };
let calls: { url: string; body: unknown }[] = [];
function mockGoogle(handler: (url: string, body: unknown) => { status: number; json: unknown }) {
  calls = [];
  globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
    const u = String(url);
    const body = init?.body ? JSON.parse(String(init.body)) : null;
    calls.push({ url: u, body });
    const r = handler(u, body);
    return new Response(JSON.stringify(r.json), { status: r.status, headers: { "content-type": "application/json" } });
  }) as typeof fetch;
}
beforeEach(() => { process.env.GOOGLE_TRANSLATE_API_KEY = "test-key-123"; delete process.env.TRANSLATION_PROVIDER; delete process.env.AI_API_URL; });
afterEach(() => { globalThis.fetch = realFetch; for (const k of Object.keys(process.env)) if (!(k in envBackup)) delete process.env[k]; Object.assign(process.env, envBackup); });

test("placeholders are lifted out and restored exactly — piping, parameters, ${variables}; a lost token is reported", () => {
  const src = "Hello ${first_name}, why {{Q1}} about <b>{brand}</b>? [[loop.item]]";
  const p = protectPlaceholders(src);
  assert.deepEqual(p.tokens, ["${first_name}", "{{Q1}}", "{brand}", "[[loop.item]]"]);
  assert.ok(!/\{\{|\$\{/.test(p.text), "nothing dynamic reaches the provider");
  assert.match(p.text, /<span translate="no" class="notranslate">RSV0RSV<\/span>/);
  // the provider translated around the markers and re-spaced one of them
  const back = restorePlaceholders('Hola <span translate="no" class="notranslate">RSV0RSV</span>, ¿por qué <span class="notranslate" translate="no"> RSV1RSV </span> sobre <b>RSV2RSV</b>? RSV3RSV', p.tokens);
  assert.equal(back.text, "Hola ${first_name}, ¿por qué {{Q1}} sobre <b>{brand}</b>? [[loop.item]]");
  assert.equal(back.complete, true);
  const lost = restorePlaceholders("Hola, ¿por qué RSV1RSV?", p.tokens);
  assert.equal(lost.complete, false, "a missing token is detected, not silently accepted");
  assert.equal(unescapeIfPlain("It's fine", "Está &quot;bien&quot; &amp; c&#39;est"), 'Está "bien" & c\'est');
  assert.equal(unescapeIfPlain("<b>x</b>", "<b>y</b> &amp;"), "<b>y</b> &amp;", "a source with markup keeps entities — the browser renders them");
});

test("language codes: zh by script, Filipino, Norwegian, Hebrew as Google spells them; regional tags collapse to the base", () => {
  assert.equal(googleLanguageCode("zh", "zh-TW"), "zh-TW");
  assert.equal(googleLanguageCode("zh", "zh-CN"), "zh-CN");
  assert.equal(googleLanguageCode("zh"), "zh-CN");
  assert.equal(googleLanguageCode("es", "es-MX"), "es");
  assert.equal(googleLanguageCode("fil"), "tl");
  assert.equal(googleLanguageCode("nb"), "no");
  assert.equal(googleLanguageCode("he"), "iw");
  assert.equal(googleLanguageCode("hi-IN"), "hi");
});

test("GOOGLE: the key travels only in the server-side URL; html mode; markers back; do-not-translate glossary terms wrapped; a broken result is dropped", async () => {
  mockGoogle((url, body) => {
    assert.match(url, /translation\.googleapis\.com\/language\/translate\/v2\?key=test-key-123$/);
    const b = body as { q: string[]; source: string; target: string; format: string };
    assert.equal(b.source, "en"); assert.equal(b.target, "hi"); assert.equal(b.format, "html");
    return { status: 200, json: { data: { translations: b.q.map((q: string, i: number) => ({
      translatedText: i === 2
        ? "टूटा हुआ" // the provider lost the marker
        : q.replace("How was your visit to", "आपकी यात्रा कैसी रही").replace("Great", "बहुत अच्छा").replace("Why do you say", "आप क्यों कहते हैं"),
    })) } } };
  });
  const out = await googleTranslationAdapter.translate(
    [{ key: "a", text: "How was your visit to <b>Miures</b>?" }, { key: "b", text: "Great" }, { key: "c", text: "Why do you say {{Q1}}?" }, { key: "d", text: "Why do you say {{Q1}}?" }],
    { sourceLanguage: "en", targetLanguage: "hi", glossary: [{ source: "Miures", target: "Miures" }] },
  );
  assert.equal(out.a, "आपकी यात्रा कैसी रही <b>Miures</b>?", "the brand stayed; the wrapper the adapter added was removed");
  assert.equal(out.b, "बहुत अच्छा");
  assert.equal(out.c, undefined, "the string whose placeholder vanished is not stored");
  assert.equal(out.d, "आप क्यों कहते हैं {{Q1}}?");
  const sent = (calls[0].body as { q: string[] }).q;
  assert.match(sent[0], /<span translate="no" class="notranslate rs-dnt">Miures<\/span>/, "a do-not-translate term is wrapped for the provider");
  assert.match(sent[2], /RSV0RSV/, "the piping token never reaches the provider as text");
  assert.equal(calls.length, 1, "one request for the batch");
});

test("GOOGLE errors map to plain messages: 403 → auth (not retryable), 429 → rate limit (retryable), 400 bad language → unsupported, 503 → unavailable, network → network", async () => {
  const cases: [number, unknown, string, boolean][] = [
    [403, { error: { message: "API key not valid. Please pass a valid API key.", status: "PERMISSION_DENIED" } }, "auth", false],
    [429, { error: { message: "Quota exceeded for quota metric 'v2 and v3 general model characters' and limit 'per minute per user'", status: "RESOURCE_EXHAUSTED" } }, "rate_limit", true],
    [429, { error: { message: "Quota exceeded for quota metric ... per day", status: "RESOURCE_EXHAUSTED" } }, "quota", true],
    [400, { error: { message: "Invalid Value: target language is not supported", status: "INVALID_ARGUMENT" } }, "unsupported_language", false],
    [400, { error: { message: "Request payload size exceeds the limit" } }, "invalid", false],
    [503, { error: { message: "backend error" } }, "unavailable", true],
  ];
  for (const [status, json, code, retryable] of cases) {
    mockGoogle(() => ({ status, json }));
    const err = await googleTranslationAdapter.translate([{ key: "a", text: "Yes" }], { sourceLanguage: "en", targetLanguage: "xx" }).catch((e) => e);
    assert.ok(err instanceof TranslationProviderError, `${status} throws a TranslationProviderError`);
    assert.equal(err.code, code, `${status}: ${err.message}`);
    assert.equal(err.retryable, retryable);
    assert.ok(!/test-key/.test(err.message), "the key never appears in a message");
  }
  globalThis.fetch = (async () => { throw new TypeError("fetch failed"); }) as typeof fetch;
  const net = await googleTranslationAdapter.translate([{ key: "a", text: "Yes" }], { sourceLanguage: "en", targetLanguage: "hi" }).catch((e) => e);
  assert.equal(net.code, "network");
  delete process.env.GOOGLE_TRANSLATE_API_KEY;
  const unc = await googleTranslationAdapter.translate([{ key: "a", text: "Yes" }], { sourceLanguage: "en", targetLanguage: "hi" }).catch((e) => e);
  assert.equal(unc.code, "unconfigured");
});

test("CACHE: the second request for the same text is answered without the provider; an approved wording beats the machine; a provider failure still returns what the cache had", async () => {
  let providerCalls = 0;
  mockGoogle((_, body) => { providerCalls++; const b = body as { q: string[] }; return { status: 200, json: { data: { translations: b.q.map((q) => ({ translatedText: `[hi] ${q}` })) } } }; });
  const cache = new MemoryTranslationCache();
  const opts = { sourceLanguage: "en", targetLanguage: "hi", caches: [cache], adapter: googleTranslationAdapter };
  const r1 = await translateWithCache([{ key: "q:q1:opt:1", text: "Great" }, { key: "q:q2:opt:1", text: "Great" }], opts);
  assert.equal(providerCalls, 1);
  assert.deepEqual(r1.translations, { "q:q1:opt:1": "[hi] Great", "q:q2:opt:1": "[hi] Great" });
  const r2 = await translateWithCache([{ key: "q:q9:opt:1", text: "Great" }, { key: "q:q9:opt:2", text: "Fine" }], opts);
  assert.equal(providerCalls, 2, "only the new string went to the provider");
  assert.deepEqual(r2.cached, ["q:q9:opt:1"]);
  assert.equal(r2.translations["q:q9:opt:2"], "[hi] Fine");
  await rememberApproved({ sourceText: "Great", sourceLanguage: "en", targetLanguage: "hi", translatedText: "बहुत अच्छा" }, [cache]);
  const r3 = await translateWithCache([{ key: "k", text: "Great" }], opts);
  assert.equal(r3.translations.k, "बहुत अच्छा", "the approved human wording is what comes back now");
  assert.equal(providerCalls, 2);
  // a machine result cannot displace it
  await cache.set([{ key: cacheKey("Great", "en", "hi", "google"), sourceText: "Great", sourceLanguage: "en", targetLanguage: "hi", provider: "google", translatedText: "[hi] Great" }]);
  assert.equal((await translateWithCache([{ key: "k", text: "Great" }], opts)).translations.k, "बहुत अच्छा");
  // the provider fails: cached strings still come back, with the error beside them
  mockGoogle(() => ({ status: 503, json: { error: { message: "down" } } }));
  const r4 = await translateWithCache([{ key: "k", text: "Great" }, { key: "n", text: "Never seen" }], opts);
  assert.equal(r4.translations.k, "बहुत अच्छा");
  assert.equal(r4.translations.n, undefined);
  assert.equal(r4.error?.code, "unavailable");
  assert.equal(r4.error?.retryable, true);
  const off = await translateWithCache([{ key: "k", text: "Great" }, { key: "n", text: "Never seen" }], { ...opts, useCache: false });
  assert.equal(off.cached.length, 0, "cache off → nothing answered from it");
});

test("SELECTION: TRANSLATION_PROVIDER wins; else Google when its key exists; else the AI model; else fake; else none", () => {
  assert.equal(translationAdapter()?.id, "google");
  process.env.TRANSLATION_PROVIDER = "fake";
  assert.equal(translationAdapter()?.id, "fake");
  process.env.TRANSLATION_PROVIDER = "ai";
  assert.equal(translationAdapter(), null, "AI asked for but not configured → off, never a silent fallback");
  delete process.env.TRANSLATION_PROVIDER;
  delete process.env.GOOGLE_TRANSLATE_API_KEY;
  process.env.AI_API_URL = "fake:";
  assert.equal(translationAdapter()?.id, "fake");
  process.env.AI_API_URL = "https://api.example.com/v1";
  assert.equal(translationAdapter()?.id, "llm");
  delete process.env.AI_API_URL;
  assert.equal(translationAdapter(), null);
  assert.equal(fakeTranslationAdapter.id, "fake");
});

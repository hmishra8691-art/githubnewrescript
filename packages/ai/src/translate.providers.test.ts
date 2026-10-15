import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import {
  scopedTranslationAdapter, translateWithCache, MemoryTranslationCache, platformTranslateTarget, TranslationProviderError, withAiScope, collectUsage, aiIdentity, aiFetch,
  providerById, publicCatalog, sameKeyFamily, validateConnection, headersFor, FALLBACKABLE,
  type TranslateScope, type TranslateTarget, type ChatScope,
} from "./index.js";

/**
 * USER-OWNED TRANSLATION: a user's own Google / DeepL / Azure key (or their AI
 * model) for one translation request — their address and key, never the
 * installation's; the same placeholder and glossary guarantees as the platform's
 * provider; failing over only to the fallbacks they listed; the platform's own
 * provider only if they allowed it, and then marked as the platform's.
 *
 * Everything runs against real local HTTP servers that speak each service's
 * documented request/response shape. No live account was used.
 */
type Seen = { method: string; url: string; headers: http.IncomingHttpHeaders; json: any; raw: string };
async function mock(handler: (s: Seen, res: http.ServerResponse) => void) {
  const log: Seen[] = [];
  const srv = http.createServer((q, r) => {
    const chunks: Buffer[] = [];
    q.on("data", (c) => chunks.push(c));
    q.on("end", () => {
      const raw = Buffer.concat(chunks).toString("utf8");
      let j: unknown = null; try { j = raw ? JSON.parse(raw) : null; } catch { /* not json */ }
      const seen: Seen = { method: q.method ?? "", url: q.url ?? "", headers: q.headers, json: j, raw };
      log.push(seen); handler(seen, r);
    });
  });
  await new Promise<void>((r) => srv.listen(0, "127.0.0.1", r));
  const port = (srv.address() as { port: number }).port;
  return { log, origin: `http://127.0.0.1:${port}`, close: () => new Promise<void>((r) => { srv.closeAllConnections?.(); srv.close(() => r()); }) };
}
const send = (status: number, body: unknown) => (_s: Seen, r: http.ServerResponse) => { r.writeHead(status, { "content-type": "application/json" }); r.end(JSON.stringify(body)); };

/** a stand-in translator: prefix every text, keep markers and tags as they are */
const tr = (prefix: string) => (t: string) => `${prefix} ${t.replace(/Great/g, "Super")}`;
const googleOk = (prefix = "[g]") => (s: Seen, r: http.ServerResponse) => send(200, { data: { translations: (s.json.q as string[]).map((q) => ({ translatedText: tr(prefix)(q) })) } })(s, r);
const deeplOk = (prefix = "[d]") => (s: Seen, r: http.ServerResponse) => send(200, { translations: (s.json.text as string[]).map((q) => ({ detected_source_language: "EN", text: tr(prefix)(q) })) })(s, r);
const azureOk = (prefix = "[a]") => (s: Seen, r: http.ServerResponse) => send(200, (s.json as { Text: string }[]).map((x) => ({ translations: [{ text: tr(prefix)(x.Text), to: "de" }] })))(s, r);

const GOOGLE = (base: string, over: Partial<TranslateTarget> = {}): TranslateTarget => ({ provider: "google-translate", base: `${base}/language/translate/v2`, key: "USER-GKEY", model: "v2", protocol: "google-v2", label: "Google Cloud Translation", ...over });
const DEEPL = (base: string, over: Partial<TranslateTarget> = {}): TranslateTarget => ({ provider: "deepl", base: `${base}/v2`, key: "USER-DEEPL:fx", model: "v2", protocol: "deepl", label: "DeepL API Pro", ...over });
const AZURE = (base: string, over: Partial<TranslateTarget> = {}): TranslateTarget => ({ provider: "azure-translator", base, key: "USER-AZKEY", model: "3.0", protocol: "azure-v3", headers: { "ocp-apim-subscription-region": "westeurope" }, label: "Microsoft Azure Translator", ...over });
const scope = (primary: TranslateTarget, fallbacks: TranslateTarget[] = [], source: "user" | "project" = "user"): TranslateScope => ({ ...primary, source, fallbacks });
const run = <T,>(s: TranslateScope, fn: () => Promise<T>, allowPrivate = true) => collectUsage(() => withAiScope({ translate: s, allowPrivate }, fn));
const opts = { sourceLanguage: "en", targetLanguage: "de" };
const items = [{ key: "a", text: "How was your visit to <b>{brand}</b>?" }, { key: "b", text: "Great" }, { key: "c", text: "Why do you say {{Q1}}?" }];

async function withEnv(extra: Record<string, string>, fn: () => Promise<void>) {
  const KEYS = ["GOOGLE_TRANSLATE_API_KEY", "GOOGLE_TRANSLATE_ENDPOINT", "TRANSLATION_PROVIDER", "AI_API_URL", "AI_API_KEY"];
  const saved = Object.fromEntries(KEYS.map((k) => [k, process.env[k]]));
  try { for (const k of KEYS) delete process.env[k]; Object.assign(process.env, extra); await fn(); }
  finally { for (const k of KEYS) { delete process.env[k]; if (saved[k] !== undefined) process.env[k] = saved[k]!; } }
}

test("registry: translation providers exist only with their protocol; kinds are enforced; keys are shared only within a vendor family", () => {
  assert.deepEqual(publicCatalog("translate").map((p) => p.id), ["google-translate", "deepl", "deepl-free", "azure-translator", "llm"]);
  assert.ok(sameKeyFamily("deepl", "deepl-free") && sameKeyFamily("google-stt", "google-translate") && sameKeyFamily("google-translate", "google-stt"));
  assert.ok(!sameKeyFamily("google-gemini", "google-translate"), "an AI Studio (Gemini) key is not a Cloud Translation key");
  assert.ok(!sameKeyFamily("deepl", "azure-translator") && !sameKeyFamily("openai", "deepl") && !sameKeyFamily("azure-translator", "google-translate"));
  assert.ok(!validateConnection("chat", { provider: "deepl", model: "v2" }).ok && !validateConnection("translate", { provider: "openai", model: "gpt-4.1" }).ok, "kind is enforced both ways");
  /* a service has no model to choose and no address to aim: both are the registry's, whatever was sent */
  const v = validateConnection("translate", { provider: "deepl", base: "https://evil.example.com/v2", model: "anything; rm -rf", extra: {} });
  assert.ok(v.ok); if (v.ok) { assert.equal(v.config.base, "https://api.deepl.com/v2"); assert.equal(v.config.model, "v2"); }
  const az = validateConnection("translate", { provider: "azure-translator", extra: { region: "westeurope" } });
  assert.ok(az.ok); if (az.ok) assert.deepEqual(headersFor(providerById("azure-translator")!, az.config.extra), { "ocp-apim-subscription-region": "westeurope" });
  assert.ok(!validateConnection("translate", { provider: "azure-translator", extra: { region: "west europe!" } }).ok, "a region has a shape");
  const llm = validateConnection("translate", { provider: "llm" });
  assert.ok(llm.ok); if (llm.ok) assert.equal(llm.config.base, "", "My AI model has no address of its own");
});

test("GOOGLE (own key): the key travels in a header, never in the URL; their address; placeholders protected; usage attributed to them", async () => {
  const mine = await mock(googleOk()); const platform = await mock(googleOk("[PLATFORM]"));
  try {
    await withEnv({ GOOGLE_TRANSLATE_API_KEY: "PLATFORM-GKEY", GOOGLE_TRANSLATE_ENDPOINT: `${platform.origin}/language/translate/v2` }, async () => {
      const { value, usage } = await run(scope(GOOGLE(mine.origin)), () => scopedTranslationAdapter.translate(items, opts));
      assert.equal(value.a, "[g] How was your visit to <b>{brand}</b>?");
      assert.equal(value.b, "[g] Super");
      assert.equal(value.c, "[g] Why do you say {{Q1}}?");
      assert.equal(platform.log.length, 0, "the installation's key and endpoint were never reached");
      const seen = mine.log[0];
      assert.equal(seen.url, "/language/translate/v2", "no key in the URL"); assert.equal(seen.headers["x-goog-api-key"], "USER-GKEY");
      assert.ok(!seen.raw.includes("PLATFORM") && !seen.url.includes("KEY"));
      assert.equal(seen.json.format, "html"); assert.equal(seen.json.target, "de");
      assert.ok(!/\{\{|\{brand\}/.test(seen.json.q.join(" ")), "no placeholder reaches the provider as text");
      assert.equal(usage.length, 1);
      assert.deepEqual({ k: usage[0].kind, s: usage[0].source, p: usage[0].providerId, f: usage[0].usedFallback, prov: usage[0].provider }, { k: "translate", s: "user", p: "google-translate", f: false, prov: "google" });
      assert.ok((usage[0].characters ?? 0) > 20);
    });
  } finally { await mine.close(); await platform.close(); }
});

test("DEEPL: Authorization header, upper-case language codes with regional variants, html tag handling with <x> markers ignored; glossary and placeholders hold", async () => {
  const s = await mock(deeplOk());
  try {
    const { value } = await run(scope(DEEPL(s.origin)), () => scopedTranslationAdapter.translate(
      [...items, { key: "d", text: "Welcome to Miures" }], { sourceLanguage: "en", targetLanguage: "pt", locale: "pt-BR", glossary: [{ source: "Miures", target: "Miures" }] }));
    const seen = s.log[0];
    assert.equal(seen.url, "/v2/translate"); assert.equal(seen.headers.authorization, "DeepL-Auth-Key USER-DEEPL:fx");
    assert.equal(seen.json.source_lang, "EN"); assert.equal(seen.json.target_lang, "PT-BR");
    assert.equal(seen.json.tag_handling, "html"); assert.deepEqual(seen.json.ignore_tags, ["x"]);
    assert.match(seen.json.text[2], /<x>RSV0RSV<\/x>/, "the piping token is lifted out behind an ignored tag");
    assert.match(seen.json.text[3], /<x class="rs-dnt">Miures<\/x>/, "a do-not-translate term is wrapped");
    assert.equal(value.c, "[d] Why do you say {{Q1}}?");
    assert.equal(value.d, "[d] Welcome to Miures", "the wrapper the Studio added is gone");
    assert.equal(value.a, "[d] How was your visit to <b>{brand}</b>?");
    /* regional spelling follows the survey's locale */
    await run(scope(DEEPL(s.origin)), () => scopedTranslationAdapter.translate([{ key: "a", text: "Colour" }], { sourceLanguage: "en-US", targetLanguage: "en", locale: "en-GB" }).catch(() => ({})));
    await run(scope(DEEPL(s.origin)), () => scopedTranslationAdapter.translate([{ key: "a", text: "Hello" }], { sourceLanguage: "en", targetLanguage: "zh", locale: "zh-TW" }));
    assert.equal(s.log.at(-1)!.json.target_lang, "ZH-HANT");
  } finally { await s.close(); }
});

test("AZURE: subscription key and region headers, v3 request shape, textType html; a global resource sends no region", async () => {
  const s = await mock((q, r) => (q.url.startsWith("/translate") ? azureOk()(q, r) : send(404, {})(q, r)));
  try {
    const { value } = await run(scope(AZURE(s.origin)), () => scopedTranslationAdapter.translate(items, { sourceLanguage: "en", targetLanguage: "zh", locale: "zh-TW" }));
    const seen = s.log[0];
    assert.equal(seen.method, "POST");
    assert.equal(seen.url, "/translate?api-version=3.0&from=en&to=zh-Hant&textType=html");
    assert.equal(seen.headers["ocp-apim-subscription-key"], "USER-AZKEY"); assert.equal(seen.headers["ocp-apim-subscription-region"], "westeurope");
    assert.deepEqual(Object.keys(seen.json[0]), ["Text"]);
    assert.equal(value.c, "[a] Why do you say {{Q1}}?");
    await run(scope(AZURE(s.origin, { headers: {} })), () => scopedTranslationAdapter.translate([{ key: "a", text: "Yes" }], opts));
    assert.equal(s.log.at(-1)!.headers["ocp-apim-subscription-region"], undefined);
  } finally { await s.close(); }
});

test("EVERY provider holds the same line: a string whose placeholder or markup came back damaged is dropped, never stored", async () => {
  const lossy = (kind: "google" | "deepl" | "azure") => (q: Seen, r: http.ServerResponse) => {
    const mangle = (t: string) => (/RSV0RSV/.test(t) ? "Zerstört ohne Marker" : `ok ${t}`);
    if (kind === "google") send(200, { data: { translations: q.json.q.map((t: string) => ({ translatedText: mangle(t) })) } })(q, r);
    else if (kind === "deepl") send(200, { translations: q.json.text.map((t: string) => ({ text: mangle(t) })) })(q, r);
    else send(200, q.json.map((x: { Text: string }) => ({ translations: [{ text: mangle(x.Text) }] })))(q, r);
  };
  for (const [kind, mk] of [["google", GOOGLE], ["deepl", DEEPL], ["azure", AZURE]] as const) {
    const s = await mock(lossy(kind));
    try {
      const { value } = await run(scope(mk(s.origin)), () => scopedTranslationAdapter.translate(items, opts));
      assert.equal(value.c, undefined, `${kind}: the string that lost {{Q1}} is absent`);
      assert.equal(value.a, undefined, `${kind}: so is the one that lost {brand}`);
      assert.match(value.b, /^ok /, `${kind}: a clean string is kept`);
    } finally { await s.close(); }
  }
});

test("failures are told as the user's own — what to fix and where — and never carry the key or the server's wording", async () => {
  const cases: [string, (b: string) => TranslateTarget, number, unknown, string, boolean][] = [
    ["deepl", DEEPL, 403, { message: "Authorization failure" }, "auth", false],
    ["deepl", DEEPL, 456, { message: "Quota exceeded" }, "quota", true],
    ["deepl", DEEPL, 429, {}, "rate_limit", true],
    ["deepl", DEEPL, 400, { message: "Value for 'target_lang' not supported." }, "unsupported_language", false],
    ["deepl", DEEPL, 400, { message: "Invalid request" }, "invalid", false],
    ["azure", AZURE, 401, { error: { code: 401000, message: "The request is not authorized because credentials are missing or invalid." } }, "auth", false],
    ["azure", AZURE, 403, { error: { code: 403001, message: "The operation is not allowed because the subscription has exceeded its free quota." } }, "quota", true],
    ["azure", AZURE, 429, { error: { code: 429001, message: "The server rejected the request because the client has exceeded request limits." } }, "rate_limit", true],
    ["azure", AZURE, 400, { error: { code: 400036, message: "The target language is not valid." } }, "unsupported_language", false],
    ["azure", AZURE, 503, { error: { code: 503000, message: "Service is temporarily unavailable." } }, "unavailable", true],
    ["google", GOOGLE, 400, { error: { message: "API key not valid. Please pass a valid API key.", status: "INVALID_ARGUMENT" } }, "auth", false],
    ["google", GOOGLE, 403, { error: { message: "Cloud Translation API has not been used in project 1 before or it is disabled. api not enabled", status: "PERMISSION_DENIED" } }, "auth", false],
  ];
  for (const [name, mk, status, body, code, retryable] of cases) {
    const s = await mock(send(status, body));
    try {
      const err = await run(scope(mk(s.origin)), () => scopedTranslationAdapter.translate(items, opts)).catch((e) => e);
      assert.ok(err instanceof TranslationProviderError, `${name} ${status}`);
      assert.equal(err.code, code, `${name} ${status}: ${err.message}`); assert.equal(err.retryable, retryable);
      assert.ok(!/USER-|PLATFORM/.test(err.message), "no key in a message");
      assert.ok(!/server|administrator/i.test(err.message), `${name} ${status}: the failure is theirs to fix, not the server's: ${err.message}`);
      if (code === "auth") assert.match(err.message, /Settings → AI & Integrations/);
    } finally { await s.close(); }
  }
  /* the free/pro mismatch is a classic: the message says which to choose */
  const s = await mock(send(403, {}));
  try { const e = await run(scope(DEEPL(s.origin)), () => scopedTranslationAdapter.translate(items, opts)).catch((x) => x); assert.match(e.message, /:fx/); } finally { await s.close(); }
});

test("FALLBACKS: only the providers the user listed, in order, only for a failure another provider can cure — and what was done before is kept", async () => {
  const bad = await mock(send(456, { message: "Quota exceeded" })); const second = await mock(azureOk()); const third = await mock(googleOk()); const platform = await mock(googleOk("[PLATFORM]"));
  try {
    await withEnv({ GOOGLE_TRANSLATE_API_KEY: "PLATFORM-GKEY", GOOGLE_TRANSLATE_ENDPOINT: `${platform.origin}/language/translate/v2` }, async () => {
      /* quota on the primary → the first listed fallback answers; the second is not touched */
      let r = await run(scope(DEEPL(bad.origin), [AZURE(second.origin), GOOGLE(third.origin)]), () => scopedTranslationAdapter.translate(items, opts));
      assert.equal(r.value.b, "[a] Super");
      assert.equal(third.log.length, 0, "a later fallback is not called when an earlier one succeeded");
      assert.deepEqual(r.usage.map((u) => [u.providerId, u.usedFallback]), [["azure-translator", true]], "usage names the provider that served it, as a fallback");
      /* a request the provider found malformed is not forwarded */
      const malformed = await mock(send(400, { message: "Invalid request" }));
      try {
        const e = await run(scope(DEEPL(malformed.origin), [AZURE(second.origin)]), () => scopedTranslationAdapter.translate(items, opts)).catch((x) => x);
        assert.equal(e.code, "invalid"); assert.equal(second.log.length, 1, "no new request reached the fallback");
      } finally { await malformed.close(); }
      /* the platform's key is not a fallback unless the user listed it, however broken everything else is */
      const dead = await mock(send(456, {}));
      try {
        const e = await run(scope(DEEPL(bad.origin), [DEEPL(dead.origin)]), () => scopedTranslationAdapter.translate(items, opts)).catch((x) => x);
        assert.equal(e.code, "quota"); assert.match(e.message, /fallback/); assert.equal(platform.log.length, 0, "the platform was never asked");
        /* listed → the platform answers, and its usage is marked as the platform's (the billing door settles a hold for exactly that) */
        r = await run(scope(DEEPL(bad.origin), [platformTranslateTarget()!]), () => scopedTranslationAdapter.translate(items, opts));
        assert.equal(r.value.b, "[PLATFORM] Super");
        assert.deepEqual(r.usage.map((u) => [u.source, u.providerId, u.usedFallback]), [["platform", "platform", true]]);
      } finally { await dead.close(); }
    });
  } finally { await bad.close(); await second.close(); await third.close(); await platform.close(); }
  assert.ok(FALLBACKABLE.has("quota") && FALLBACKABLE.has("unsupported_language") && !FALLBACKABLE.has("invalid"));
});

test("a long batch is split to the service's limit; if a later request fails, the earlier ones are kept (they were paid for) and only the rest is offered on", async () => {
  let n = 0;
  const s = await mock((q, r) => (++n === 2 ? send(429, {})(q, r) : deeplOk()(q, r)));
  const fb = await mock(googleOk());
  try {
    const many = Array.from({ length: 60 }, (_, i) => ({ key: `k${i}`, text: `Text ${i}` }));
    const e = await run(scope(DEEPL(s.origin)), () => scopedTranslationAdapter.translate(many, opts)).catch((x) => x);
    assert.equal(s.log[0].json.text.length, 50, "DeepL takes 50 strings per request");
    assert.equal(e.code, "rate_limit"); assert.equal(Object.keys(e.partial).length, 50, "the first request's translations are kept");
    /* through the manager: they are cached, returned beside the error, and not asked for again */
    n = 0;
    const cache = new MemoryTranslationCache();
    const res = await run(scope(DEEPL(s.origin)), () => translateWithCache(many, { ...opts, caches: [cache], adapter: scopedTranslationAdapter }));
    assert.equal(Object.keys(res.value.translations).length, 50); assert.equal(res.value.error?.code, "rate_limit"); assert.equal(res.value.provider, "deepl");
    /* with a fallback listed, only the 10 left go to it */
    n = 0; fb.log.length = 0;
    const ok = await run(scope(DEEPL(s.origin), [GOOGLE(fb.origin)]), () => scopedTranslationAdapter.translate(many, opts));
    assert.equal(Object.keys(ok.value).length, 60); assert.equal(fb.log[0].json.q.length, 10);
  } finally { await s.close(); await fb.close(); }
});

test("a language this provider lacks is a failure a fallback may cure — and costs nothing on the first", async () => {
  const no = await mock(send(400, { message: "Value for 'target_lang' not supported." })); const yes = await mock(googleOk());
  try {
    const { value, usage } = await run(scope(DEEPL(no.origin), [GOOGLE(yes.origin)]), () => scopedTranslationAdapter.translate(items, { sourceLanguage: "en", targetLanguage: "sw" }));
    assert.equal(value.b, "[g] Super");
    assert.deepEqual(usage.map((u) => u.providerId), ["google-translate"], "the refused request billed nothing");
  } finally { await no.close(); await yes.close(); }
});

test("a user's translation never reaches a private address (the endpoint guard), and a user's usage is never mistaken for the platform's", async () => {
  const s = await mock((q, r) => (q.method === "GET" ? send(200, {})(q, r) : googleOk()(q, r)));
  try {
    const e = await run(scope(GOOGLE(s.origin)), () => scopedTranslationAdapter.translate(items, opts), false).catch((x) => x);
    assert.equal(e.code, "network"); assert.equal(s.log.length, 0, "a loopback address is refused before any request");
    /* identity: the connection is named by a hash that differs per key and per source, and contains no secret */
    const a = await withAiScope({ translate: scope(GOOGLE(s.origin)) }, async () => aiIdentity("translate"));
    const b = await withAiScope({ translate: scope(GOOGLE(s.origin, { key: "OTHER-KEY" })) }, async () => aiIdentity("translate"));
    const c = await withAiScope({ translate: scope(GOOGLE(s.origin), [], "project") }, async () => aiIdentity("translate"));
    assert.ok(a !== b && a !== c && !/KEY/.test(a));
    assert.equal(aiIdentity("translate"), "platform");
    await withAiScope({ translate: scope(GOOGLE(s.origin)), allowPrivate: true }, async () => { const r = await aiFetch("translate", `${s.origin}/x`, { method: "GET" }); assert.equal(r.status, 200); });
  } finally { await s.close(); }
});

test("the adapter is only ever the user's: outside a connection it is not a provider, and its cache identity is the service's", async () => {
  assert.equal(scopedTranslationAdapter.configured(), false);
  const e = await scopedTranslationAdapter.translate(items, opts).catch((x) => x);
  assert.equal(e.code, "unconfigured", "no scope → no silent use of the installation's key");
  const s = await mock(googleOk());
  try {
    await run(scope(DEEPL(s.origin)), async () => { assert.equal(scopedTranslationAdapter.id, "deepl"); assert.equal(scopedTranslationAdapter.configured(), true); });
    await run(scope(AZURE(s.origin)), async () => assert.equal(scopedTranslationAdapter.id, "azure"));
    await run(scope(GOOGLE(s.origin)), async () => assert.equal(scopedTranslationAdapter.id, "google"));
  } finally { await s.close(); }
});

test("languages: each service's own list, free to ask, normalised to what the picker compares (regional variants fold into the base language)", async () => {
  const s = await mock((q, r) => {
    if (q.url.startsWith("/v2/languages")) return send(200, [{ language: "EN-GB", name: "English (British)" }, { language: "EN-US", name: "English (American)" }, { language: "ZH-HANS", name: "Chinese (simplified)" }, { language: "DE", name: "German" }])(q, r);
    if (q.url.startsWith("/languages")) return send(200, { translation: { en: { name: "English" }, "zh-Hans": { name: "Chinese Simplified" }, "zh-Hant": { name: "Chinese Traditional" }, de: { name: "German" } } })(q, r);
    return send(200, { data: { languages: [{ language: "en", name: "English" }, { language: "zh-CN" }, { language: "de" }] } })(q, r);
  });
  try {
    const d = await run(scope(DEEPL(s.origin)), async () => ({ list: await scopedTranslationAdapter.supportedLanguages(), key: scopedTranslationAdapter.languageKey!("en-GB") }));
    assert.deepEqual(d.value.list!.map((l) => l.code), ["en", "zh", "de"]); assert.equal(d.value.list![0].name, "English"); assert.equal(d.value.key, "en");
    assert.equal(s.log[0].headers.authorization, "DeepL-Auth-Key USER-DEEPL:fx");
    const a = await run(scope(AZURE(s.origin)), async () => ({ list: await scopedTranslationAdapter.supportedLanguages(), zh: scopedTranslationAdapter.languageKey!("zh") }));
    assert.deepEqual(a.value.list!.map((l) => l.code), ["en", "zh", "de"]); assert.equal(a.value.zh, "zh");
    assert.equal(s.log.at(-1)!.headers["ocp-apim-subscription-key"], undefined, "Azure's list needs no key, so none is sent");
    const g = await run(scope(GOOGLE(s.origin)), async () => ({ list: await scopedTranslationAdapter.supportedLanguages(), zh: scopedTranslationAdapter.languageKey!("zh") }));
    assert.equal(g.value.zh, "zh-cn"); assert.equal(g.value.list!.length, 3);
  } finally { await s.close(); }
});

test("MY AI MODEL: the language model translates through the user's chat connection — their address and key, placeholders protected, usage theirs", async () => {
  const chat = await mock((q, r) => {
    const user = q.json.messages.at(-1).content as string;
    const strings = JSON.parse(user.slice(user.indexOf("Strings (JSON):\n") + 15)) as { key: string; text: string }[];
    send(200, { choices: [{ message: { content: JSON.stringify({ translations: Object.fromEntries(strings.map((x) => [x.key, `[llm] ${x.text}`])) }) }, finish_reason: "stop" }], usage: { prompt_tokens: 120, completion_tokens: 40 } })(q, r);
  });
  try {
    await withEnv({ AI_API_URL: "http://127.0.0.1:1/v1", AI_API_KEY: "PLATFORM-AI-KEY" }, async () => {
      const chatScope: ChatScope = { source: "user", provider: "openai-compatible", base: `${chat.origin}/v1`, key: "USER-CHAT-KEY", model: "my-model", fallbacks: [] };
      const { value, usage } = await collectUsage(() => withAiScope({ chat: chatScope, allowPrivate: true }, async () => ({ out: await scopedTranslationAdapter.translate(items, opts), id: scopedTranslationAdapter.id })));
      assert.equal(value.id, "llm-own");
      assert.equal(value.out.c, "[llm] Why do you say {{Q1}}?");
      assert.equal(chat.log[0].headers.authorization, "Bearer USER-CHAT-KEY");
      assert.ok(!chat.log[0].raw.includes("{{Q1}}"), "the piping token was lifted out before the model saw the text");
      assert.ok(usage.length >= 1 && usage.every((u) => u.source !== "platform" && u.kind === "chat"), `chat usage, the user's: ${JSON.stringify(usage)}`);
    });
  } finally { await chat.close(); }
});

test("the installation's translation provider offered as a backstop exists only when it has one", async () => {
  await withEnv({}, async () => assert.equal(platformTranslateTarget(), null));
  await withEnv({ GOOGLE_TRANSLATE_API_KEY: "k" }, async () => { const t = platformTranslateTarget(); assert.ok(t && t.platform && t.key === "", "a marker only — it carries no key"); });
});

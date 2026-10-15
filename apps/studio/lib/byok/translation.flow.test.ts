import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { randomBytes } from "node:crypto";
import { Meter, MemoryMeterStore, type MeterContext } from "@rescript/billing";
import { cacheKey, MemoryTranslationCache, providerById, scopedTranslationAdapter, translateWithCache, translationAdapter } from "@rescript/ai";
import { MemoryAiStore } from "./store.ts";
import { resolveConnection } from "./resolve.ts";
import { saveSetting } from "./service.ts";
import { featureOf, needsOf } from "./features.ts";
import { meteredCore, type RunDeps } from "../meterRun.ts";
import { setAiSettingsLoader } from "../aiPolicy.ts";

/**
 * THE WHOLE TRANSLATION PATH, nothing stubbed but the providers' network end:
 * the saved setting → the resolver → the metering door → the adapter → a real
 * HTTP provider speaking that service's protocol; then the cache, the wallet and
 * the usage record.
 *
 * A translation service's address is fixed by the registry (a user cannot aim it
 * anywhere), so these tests point the registry entry itself at a local server for
 * their duration — the same seam a production deployment uses for a regional endpoint.
 */
const ALICE = "aaaaaaaa-0000-0000-0000-000000000001", BOB = "bbbbbbbb-0000-0000-0000-000000000002";
const DEEPL_KEY = "ALICE-DEEPL-KEY-0123456789:fx";
type Seen = { url: string; auth?: string; body: any };
async function server(handler: (s: Seen, r: http.ServerResponse) => void) {
  const log: Seen[] = [];
  const s = http.createServer((q, r) => { const c: Buffer[] = []; q.on("data", (x) => c.push(x)); q.on("end", () => { let body: unknown = null; try { body = JSON.parse(Buffer.concat(c).toString()); } catch { /* none */ } const seen = { url: q.url ?? "", auth: (q.headers.authorization ?? q.headers["x-goog-api-key"]) as string | undefined, body }; log.push(seen); handler(seen, r); }); });
  await new Promise<void>((r) => s.listen(0, "127.0.0.1", r));
  return { log, origin: `http://127.0.0.1:${(s.address() as { port: number }).port}`, close: () => new Promise<void>((r) => { s.closeAllConnections?.(); s.close(() => r()); }) };
}
const reply = (status: number, body: unknown) => (_s: Seen, r: http.ServerResponse) => { r.writeHead(status, { "content-type": "application/json" }); r.end(JSON.stringify(body)); };
const deeplOk = (s: Seen, r: http.ServerResponse) => reply(200, { translations: s.body.text.map((t: string) => ({ text: `[deepl] ${t}` })) })(s, r);
const googleOk = (s: Seen, r: http.ServerResponse) => reply(200, { data: { translations: s.body.q.map((t: string) => ({ translatedText: `[google] ${t}` })) } })(s, r);
const ctxOf = (userId: string): MeterContext => ({ customerId: "c1", surveyId: "s1", userId, environment: "LIVE" });
const items = [{ key: "a", text: "How was your visit to {brand}?" }, { key: "b", text: "Great" }];
const opts = { sourceLanguage: "en", targetLanguage: "de" };
const OP = "translate:en->de";

function door(store: MemoryAiStore, env: Record<string, string | undefined>): RunDeps {
  return { allowPrivate: () => true, connectionFor: async (ask) => resolveConnection({ userId: ask.userId!, feature: featureOf(ask.operation), store, env, project: ask.source ? { mode: ask.source } : null, need: needsOf(ask.operation) }) };
}

/** what the route does: resolve whose provider, hand the right adapter to the manager, run it under the one door */
async function translate(deps: RunDeps, meter: Meter, userId: string, cache = new MemoryTranslationCache()) {
  const res = await deps.connectionFor({ userId, customerId: "c1", surveyId: "s1", operation: OP });
  const platform = translationAdapter();
  const adapter = res.kind === "platform" ? platform! : scopedTranslationAdapter;
  const chars = items.reduce((n, i) => n + i.text.length, 0);
  const out = await meteredCore(deps, meter, ctxOf(userId), {
    operation: OP, kind: "translate", platformIsLlm: platform?.id === "llm",
    reserve: () => ({ eventType: "TRANSLATION_CHARACTER", provider: "google", service: "translate", model: "v2", quantity: Math.ceil(chars * 1.25), metadata: { operation: OP } }),
  }, () => translateWithCache(items, { ...opts, caches: [cache], adapter }));
  return { out, cache };
}

function pointAt(provider: string, origin: string) { const def = providerById(provider)!; const was = def.base; def.base = `${origin}/v2`; return () => { def.base = was; }; }

const ENV_KEYS = ["AI_CREDENTIAL_KEY", "AI_BYOK_ALLOW_PRIVATE_ENDPOINTS", "GOOGLE_TRANSLATE_API_KEY", "GOOGLE_TRANSLATE_ENDPOINT", "AI_API_URL", "AI_API_KEY", "TRANSLATION_PROVIDER"];
async function withEnv(extra: Record<string, string>, fn: (env: Record<string, string>) => Promise<void>) {
  const saved = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
  const env = { AI_CREDENTIAL_KEY: randomBytes(32).toString("hex"), AI_BYOK_ALLOW_PRIVATE_ENDPOINTS: "1", ...extra };
  try { for (const k of ENV_KEYS) delete process.env[k]; Object.assign(process.env, env); await fn(env); }
  finally { for (const k of ENV_KEYS) { delete process.env[k]; if (saved[k] !== undefined) process.env[k] = saved[k]!; } }
}
setAiSettingsLoader(async () => ({ mode: "cloud", disabled: [] }));

test("Alice's own DeepL key translates for her at zero charge and Bob, with none, is the platform's Google customer — at the same moment, each cached under their own provider", async () => {
  const mine = await server(deeplOk), platform = await server(googleOk);
  const restore = pointAt("deepl", mine.origin);
  try {
    await withEnv({ GOOGLE_TRANSLATE_API_KEY: "PLATFORM-GKEY", GOOGLE_TRANSLATE_ENDPOINT: `${platform.origin}/language/translate/v2` }, async (env) => {
      const store = new MemoryAiStore();
      const saved = await saveSetting(ALICE, { feature: "translation", mode: "user", config: { provider: "deepl" }, apiKey: DEEPL_KEY }, { store, env });
      assert.ok(saved.ok, JSON.stringify(saved));
      const ms = new MemoryMeterStore(); const meter = new Meter(ms, { seedBalance: 10, cacheMs: 0 });
      const deps = door(store, env);
      const [a, b] = await Promise.all([translate(deps, meter, ALICE), translate(deps, meter, BOB)]);
      assert.ok(a.out.ok && b.out.ok);
      const av = (a.out as { value: { translations: Record<string, string>; provider: string } }).value, bv = (b.out as { value: { translations: Record<string, string>; provider: string } }).value;
      assert.equal(av.translations.b, "[deepl] Great"); assert.equal(av.provider, "deepl");
      assert.equal(bv.translations.b, "[google] Great"); assert.equal(bv.provider, "google");
      assert.equal(av.translations.a, "[deepl] How was your visit to {brand}?", "the placeholder survived the round trip");
      assert.deepEqual(mine.log.map((l) => [l.url, l.auth]), [["/v2/translate", `DeepL-Auth-Key ${DEEPL_KEY}`]], "Alice's provider got Alice's key and only her request");
      assert.equal(platform.log.length, 1, "the platform served Bob alone");
      assert.ok(String(platform.log[0].auth).startsWith("PLATFORM-GKEY") || platform.log[0].url.includes("PLATFORM-GKEY"), "with the platform's key");
      /* money */
      const alice = ms.usage.filter((e) => e.userId === ALICE), bob = ms.usage.filter((e) => e.userId === BOB);
      assert.equal(alice.length, 1); assert.equal(alice[0].eventType, "AI_REQUEST_BYOK"); assert.equal(alice[0].customerCharge, 0); assert.equal(alice[0].unit, "character");
      assert.equal(alice[0].provider, "deepl"); assert.ok(Number(alice[0].quantity) > 20);
      assert.equal(bob.length, 1); assert.equal(bob[0].eventType, "TRANSLATION_CHARACTER"); assert.ok(bob[0].customerCharge >= 0);
      assert.equal(JSON.stringify(ms.usage).includes(DEEPL_KEY), false, "no key in any record");
      assert.equal(ms.ledger.filter((l) => l.kind === "debit").length <= 1, true, "only Bob's call touched the wallet");
      /* the cache: Alice's output is filed under DeepL, Bob's under Google — one is never served as the other */
      assert.equal(Object.keys(await a.cache.get([cacheKey("Great", "en", "de", "deepl")])).length, 1, "Alice's translation is filed under DeepL");
      assert.equal(Object.keys(await b.cache.get([cacheKey("Great", "en", "de", "google")])).length, 1, "Bob's under Google");
      assert.equal(Object.keys(await a.cache.get([cacheKey("Great", "en", "de", "google")])).length, 0, "and neither is served as the other");
      const again = await translate(deps, meter, ALICE, a.cache);
      assert.deepEqual((again.out as { value: { cached: string[] } }).value.cached.sort(), ["a", "b"], "Alice's repeat is answered from her cache, and costs nothing");
      assert.equal(mine.log.length, 1);
    });
  } finally { restore(); await mine.close(); await platform.close(); }
});

test("Alice's DeepL is out of quota: with no backstop she is told in HER words and the platform's Google is never called; with the backstop allowed it answers, billed as the platform's", async () => {
  const mine = await server(reply(456, { message: "Quota exceeded" })), platform = await server(googleOk);
  const restore = pointAt("deepl", mine.origin);
  try {
    await withEnv({ GOOGLE_TRANSLATE_API_KEY: "PLATFORM-GKEY", GOOGLE_TRANSLATE_ENDPOINT: `${platform.origin}/language/translate/v2` }, async (env) => {
      const store = new MemoryAiStore();
      const cfg = { feature: "translation", mode: "user", config: { provider: "deepl" }, apiKey: DEEPL_KEY };
      assert.ok((await saveSetting(ALICE, cfg, { store, env })).ok);
      const ms = new MemoryMeterStore(); const meter = new Meter(ms, { seedBalance: 10, cacheMs: 0 });
      const deps = door(store, env);

      const a = await translate(deps, meter, ALICE);
      assert.ok(a.out.ok); const av = (a.out as { value: { error?: { code: string; message: string }; translations: object } }).value;
      assert.equal(av.error?.code, "quota"); assert.match(av.error!.message, /Your translation provider \(DeepL API Pro\)/); assert.doesNotMatch(av.error!.message, /server|administrator/i);
      assert.equal(platform.log.length, 0, "no silent platform spend");
      assert.equal(ms.usage.length, 0, "a failed call is neither billed nor recorded");
      assert.equal([...ms.reservations.values()].filter((r) => r.status === "held").length, 0);

      assert.ok((await saveSetting(ALICE, { ...cfg, apiKey: undefined, allowPlatformFallback: true }, { store, env })).ok);
      const b = await translate(deps, meter, ALICE);
      assert.ok(b.out.ok && b.out.event); assert.equal((b.out as { value: { translations: Record<string, string> } }).value.translations.b, "[google] Great");
      assert.equal(platform.log.length, 1);
      assert.equal(b.out.event!.eventType, "TRANSLATION_CHARACTER"); assert.equal(b.out.event!.metadata.source, "platform_fallback");
      assert.equal(ms.usage.filter((e) => e.eventType === "AI_REQUEST_BYOK").length, 0, "the platform's characters are not recorded as the user's own");
    });
  } finally { restore(); await mine.close(); await platform.close(); }
});

test("MY AI MODEL: translation by the chat connection saved under Other AI features — their key, tokens recorded free; if that setting is not their own provider the answer is a refusal, never the platform's model", async () => {
  const chat = await server((s, r) => {
    const user = s.body.messages.at(-1).content as string;
    const strings = JSON.parse(user.slice(user.indexOf("Strings (JSON):\n") + 15)) as { key: string; text: string }[];
    reply(200, { choices: [{ message: { content: JSON.stringify({ translations: Object.fromEntries(strings.map((x) => [x.key, `[mine] ${x.text}`])) }) }, finish_reason: "stop" }], usage: { prompt_tokens: 200, completion_tokens: 60 } })(s, r);
  });
  try {
    await withEnv({ GOOGLE_TRANSLATE_API_KEY: "PLATFORM-GKEY" }, async (env) => {
      const store = new MemoryAiStore();
      /* before the chat setting exists, "My AI model" cannot even be saved */
      const early = await saveSetting(ALICE, { feature: "translation", mode: "user", config: { provider: "llm" } }, { store, env });
      assert.equal(early.ok, false); assert.equal((early as { code: string }).code, "chat_required");
      assert.ok((await saveSetting(ALICE, { feature: "additional", mode: "user", config: { provider: "openai-compatible", base: `${chat.origin}/v1`, model: "my-model" }, apiKey: "sk-ALICE-CHAT-KEY-0123456789" }, { store, env })).ok);
      const ok = await saveSetting(ALICE, { feature: "translation", mode: "user", config: { provider: "llm" } }, { store, env });
      assert.ok(ok.ok, JSON.stringify(ok));
      const ms = new MemoryMeterStore(); const meter = new Meter(ms, { seedBalance: 10, cacheMs: 0 });
      const deps = door(store, env);
      const a = await translate(deps, meter, ALICE);
      assert.ok(a.out.ok); const av = (a.out as { value: { translations: Record<string, string>; provider: string } }).value;
      assert.equal(av.translations.b, "[mine] Great"); assert.equal(av.provider, "llm-own");
      assert.equal(chat.log[0].auth, "Bearer sk-ALICE-CHAT-KEY-0123456789");
      assert.ok(!JSON.stringify(chat.log[0].body).includes("{brand}"), "the placeholder never reached the model as text");
      const rows = ms.usage.filter((e) => e.userId === ALICE);
      assert.ok(rows.length >= 1 && rows.every((e) => e.eventType === "AI_REQUEST_BYOK" && e.customerCharge === 0), "recorded free, as the user's own chat call");
      assert.equal(ms.ledger.filter((l) => l.kind === "debit").length, 0);

      /* they move Other AI features back to the platform: translation by "My AI model" is now refused in words — the platform's model is not substituted */
      assert.ok((await saveSetting(ALICE, { feature: "additional", mode: "platform" }, { store, env })).ok);
      const before = chat.log.length;
      const r = await translate(deps, meter, ALICE);
      assert.equal(r.out.ok, false); assert.equal((r.out as { reason: string; code: string }).reason, "ai_connection"); assert.equal((r.out as { code: string }).code, "no_connection");
      assert.match((r.out as { message: string }).message, /Other AI features/);
      assert.equal(chat.log.length, before);
    });
  } finally { await chat.close(); }
});

test("the project's AI switch: a translation SERVICE still runs in an Internal project (it is not a language model); translation by an AI model does not", async () => {
  const mine = await server(deeplOk), chat = await server(reply(200, { choices: [{ message: { content: "{}" } }] }));
  const restore = pointAt("deepl", mine.origin);
  try {
    await withEnv({}, async (env) => {
      setAiSettingsLoader(async () => ({ mode: "internal", disabled: [] }));
      const store = new MemoryAiStore();
      assert.ok((await saveSetting(ALICE, { feature: "translation", mode: "user", config: { provider: "deepl" }, apiKey: DEEPL_KEY }, { store, env })).ok);
      const ms = new MemoryMeterStore(); const meter = new Meter(ms, { seedBalance: 10, cacheMs: 0 });
      const deps = door(store, env);
      const svc = await translate(deps, meter, ALICE);
      assert.ok(svc.out.ok, "a project running Internal still translates with a translation service");
      assert.equal(mine.log.length, 1);
      /* now Alice chooses her AI model: the language model is what translates, so the switch applies */
      assert.ok((await saveSetting(ALICE, { feature: "additional", mode: "user", config: { provider: "openai-compatible", base: `${chat.origin}/v1`, model: "m" }, apiKey: "sk-ALICE-CHAT-KEY-0123456789" }, { store, env })).ok);
      assert.ok((await saveSetting(ALICE, { feature: "translation", mode: "user", config: { provider: "llm" } }, { store, env })).ok);
      const llm = await translate(deps, meter, ALICE);
      assert.equal(llm.out.ok, false); assert.equal((llm.out as { reason: string }).reason, "ai_off");
      assert.equal(chat.log.length, 0, "no model call was made in an Internal project");
    });
  } finally { setAiSettingsLoader(async () => ({ mode: "cloud", disabled: [] })); restore(); await mine.close(); await chat.close(); }
});

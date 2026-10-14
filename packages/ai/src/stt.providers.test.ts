import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { transcribe, withAiScope, collectUsage, aiIdentity, platformSttTarget, sttUnavailableReason, providerById, publicCatalog, sameKeyFamily, validateConnection, discoverModels, type SttScope, type SttTarget } from "./index.js";

/**
 * USER-OWNED SPEECH-TO-TEXT: a user's provider for one transcription — their
 * address, key, model and headers; never the installation's; failing over only
 * to the fallbacks they listed; Google through its own adapter.
 */
const KEYS = ["AI_API_URL", "AI_API_KEY", "AI_STT_API_URL", "AI_STT_API_KEY", "AI_STT_MODEL", "AI_WORKSPACE_ID", "AI_API_HEADERS"];
type Seen = { url: string; auth?: string; gkey?: string; org?: string; ws?: string; ctype?: string; body: string };
async function mock(handler: (seen: Seen, res: http.ServerResponse) => void) {
  const log: Seen[] = [];
  const s = http.createServer((q, r) => { const chunks: Buffer[] = []; q.on("data", (c) => chunks.push(c)); q.on("end", () => { const seen: Seen = { url: q.url ?? "", auth: q.headers.authorization, gkey: q.headers["x-goog-api-key"] as string, org: q.headers["openai-organization"] as string, ws: q.headers["anthropic-workspace-id"] as string, ctype: q.headers["content-type"], body: Buffer.concat(chunks).toString("latin1") }; log.push(seen); handler(seen, r); }); });
  await new Promise<void>((r) => s.listen(0, "127.0.0.1", r));
  const port = (s.address() as { port: number }).port;
  return { log, base: `http://127.0.0.1:${port}/v1`, close: () => new Promise<void>((r) => { s.closeAllConnections?.(); s.close(() => r()); }) };
}
const json = (status: number, body: unknown) => (_s: Seen, r: http.ServerResponse) => { r.writeHead(status, { "content-type": "application/json" }); r.end(JSON.stringify(body)); };
const whisper = (text = "hello from whisper", extra: Record<string, unknown> = {}) => json(200, { text, language: "en", duration: 12.4, ...extra });
const field = (body: string, name: string) => body.match(new RegExp(`name="${name.replace(/[[\]]/g, "\\$&")}"\\r\\n\\r\\n([^\\r]*)`))?.[1];

async function withEnv(extra: Record<string, string>, fn: () => Promise<void>) {
  const saved = Object.fromEntries(KEYS.map((k) => [k, process.env[k]]));
  try { for (const k of KEYS) delete process.env[k]; Object.assign(process.env, extra); await fn(); }
  finally { for (const k of KEYS) { delete process.env[k]; if (saved[k] !== undefined) process.env[k] = saved[k]!; } }
}
const WEBM = new Uint8Array([0x1a, 0x45, 0xdf, 0xa3, ...new Array(2000).fill(7)]);
const WAV = new Uint8Array([...Buffer.from("RIFF"), 0, 0, 0, 0, ...Buffer.from("WAVE"), ...new Array(2000).fill(1)]);
const MP4 = new Uint8Array([0, 0, 0, 24, ...Buffer.from("ftypmp42"), ...new Array(2000).fill(3)]);
const scope = (base: string, over: Partial<SttScope> = {}): SttScope => ({ source: "user", provider: "openai-compatible-stt", base, key: "USER-STT-KEY", model: "whisper-1", fallbacks: [], ...over });
const target = (base: string, over: Partial<SttTarget> = {}): SttTarget => ({ provider: "groq-stt", base, key: "FALLBACK-KEY", model: "whisper-large-v3", ...over });
const run = <T,>(s: SttScope, fn: () => Promise<T>) => collectUsage(() => withAiScope({ allowPrivate: true, stt: s }, fn));
const opts = { durationSeconds: 12, mimeType: "audio/webm", fileName: "a.webm" };

test("registry: speech providers exist only with their adapter; a key is shared within a vendor family and never across vendors", () => {
  assert.deepEqual(publicCatalog("stt").map((p) => p.id), ["openai-stt", "groq-stt", "openai-compatible-stt", "google-stt"]);
  assert.ok(sameKeyFamily("openai", "openai-stt") && sameKeyFamily("openai-stt", "openai") && sameKeyFamily("groq", "groq-stt") && sameKeyFamily("openai-compatible", "openai-compatible-stt"));
  assert.ok(!sameKeyFamily("openai", "groq-stt") && !sameKeyFamily("google-gemini", "google-stt") && !sameKeyFamily("anthropic", "openai-stt") && !sameKeyFamily("openai", "nope"));
  assert.equal(providerById("google-stt")!.limits?.maxSeconds, 60);
  /* kind is enforced both ways */
  assert.ok(!validateConnection("stt", { provider: "openai", model: "whisper-1" }).ok, "a chat provider is not a speech provider");
  assert.ok(!validateConnection("chat", { provider: "openai-stt", model: "whisper-1" }).ok, "and a speech provider is not a chat provider");
  const a = validateConnection("stt", { provider: "openai-stt", base: "https://evil.example.com/v1", model: "whisper-1", language: "pt-BR" });
  assert.ok(a.ok); if (a.ok) { assert.equal(a.config.base, "https://api.openai.com/v1"); assert.equal(a.config.language, "pt-BR"); }
  const bad = validateConnection("stt", { provider: "openai-stt", model: "whisper-1", language: "english please" });
  assert.ok(!bad.ok); if (!bad.ok) assert.ok(bad.errors.language);
  assert.ok(!validateConnection("stt", { provider: "openai-compatible-stt", base: "http://127.0.0.1:9/v1", model: "w" }).ok, "a custom speech address passes the endpoint guard like any other");
  /* the language hint is a speech setting only */
  const c = validateConnection("chat", { provider: "openai", model: "gpt-4.1", language: "en" });
  assert.ok(c.ok); if (c.ok) assert.equal(c.config.language, undefined);
});

test("registry: a speech provider's model list offers only what can transcribe", async () => {
  const s = await mock(json(200, { data: [{ id: "gpt-4.1" }, { id: "whisper-1" }, { id: "gpt-4o-transcribe" }, { id: "text-embedding-3-small" }, { id: "tts-1" }] }));
  try {
    const r = await discoverModels(providerById("openai-stt")!, s.base, "k", {}, { allowPrivate: true });
    assert.ok(r.ok); assert.deepEqual(r.models.map((m) => m.id).sort(), ["gpt-4o-transcribe", "whisper-1"]);
    assert.equal((await discoverModels(providerById("google-stt")!, s.base, "k", {}, { allowPrivate: true })).reason, "unsupported", "Google lists no models: the suggestions are shown");
  } finally { await s.close(); }
});

test("a user's transcription goes to THEIR address with THEIR key, model, language and headers — never the installation's", async () => {
  const platform = await mock(whisper("platform text")); const mine = await mock(whisper("my text"));
  try {
    await withEnv({ AI_API_URL: platform.base, AI_API_KEY: "PLATFORM-KEY", AI_STT_API_KEY: "PLATFORM-STT", AI_WORKSPACE_ID: "wrk_PLATFORM", AI_API_HEADERS: '{"OpenAI-Organization":"org_PLATFORM"}' }, async () => {
      const { value, usage } = await run(scope(mine.base, { provider: "openai-stt", model: "whisper-1", language: "fr", headers: { "openai-organization": "org_USER" } }), () => transcribe(WEBM, opts));
      assert.ok(value.ok); if (value.ok) { assert.equal(value.value.text, "my text"); assert.equal(value.value.provider, "openai-stt"); }
      assert.equal(platform.log.length, 0, "the installation's provider was never reached");
      const seen = mine.log[0];
      assert.equal(seen.url, "/v1/audio/transcriptions"); assert.equal(seen.auth, "Bearer USER-STT-KEY"); assert.equal(seen.org, "org_USER");
      assert.equal(field(seen.body, "model"), "whisper-1"); assert.equal(field(seen.body, "language"), "fr", "the saved language is the default hint");
      assert.ok(!seen.body.includes("PLATFORM"), "no platform key, workspace or header in the user's request");
      assert.equal(usage.length, 1);
      assert.deepEqual([usage[0].kind, usage[0].source, usage[0].providerId, usage[0].usedFallback ?? false, usage[0].seconds], ["stt", "user", "openai-stt", false, 12]);
      /* a per-call language beats the saved one */
      await run(scope(mine.base, { language: "fr" }), () => transcribe(WEBM, { ...opts, language: "de-AT" }));
      assert.equal(field(mine.log[1].body, "language"), "de");
    });
  } finally { await platform.close(); await mine.close(); }
});

test("the GPT-4o transcribe models take json only: timings are not requested, and the transcript says it has none", async () => {
  const s = await mock(whisper("plain"));
  try {
    await withEnv({}, async () => {
      const a = await run(scope(s.base, { model: "gpt-4o-transcribe" }), () => transcribe(WEBM, { ...opts, segments: true, diarize: true }));
      assert.equal(field(s.log[0].body, "response_format"), "json"); assert.equal(field(s.log[0].body, "timestamp_granularities[]"), undefined); assert.equal(field(s.log[0].body, "diarize"), undefined);
      assert.ok(a.value.ok); if (a.value.ok) { assert.equal(a.value.value.segments, undefined); assert.equal(a.value.value.diarized, false); }
      await run(scope(s.base, { model: "whisper-1" }), () => transcribe(WEBM, { ...opts, segments: true }));
      assert.equal(field(s.log[1].body, "response_format"), "verbose_json"); assert.equal(field(s.log[1].body, "timestamp_granularities[]"), "segment");
    });
  } finally { await s.close(); }
});

test("FALLBACKS: only a failure another provider can cure moves on, only to the user's listed fallbacks, in order — the installation's key is never reached unless listed", async () => {
  const platform = await mock(whisper("platform text")); const primary = await mock(json(429, { error: { message: "slow down" } })); const fb1 = await mock(whisper("second"));
  const bad = await mock(json(400, { error: { message: "unsupported audio" } })); const never = await mock(whisper("unreached"));
  try {
    await withEnv({ AI_API_URL: platform.base, AI_API_KEY: "PLATFORM-KEY", AI_STT_API_URL: platform.base, AI_STT_API_KEY: "PLATFORM-STT" }, async () => {
      /* a rate-limited primary → the user's listed fallback answers, and the usage says so */
      const a = await run(scope(primary.base, { fallbacks: [target(fb1.base)] }), () => transcribe(WEBM, opts));
      assert.ok(a.value.ok); if (a.value.ok) { assert.equal(a.value.value.text, "second"); assert.equal(a.value.value.provider, "groq-stt"); }
      assert.deepEqual([a.usage[0].providerId, a.usage[0].usedFallback, a.usage[0].source], ["groq-stt", true, "user"]);
      assert.equal(fb1.log[0].auth, "Bearer FALLBACK-KEY");
      /* a request the first provider found malformed would fail there too: not forwarded */
      const b = await run(scope(bad.base, { fallbacks: [target(never.base)] }), () => transcribe(WEBM, opts));
      assert.ok(!b.value.ok); assert.equal(never.log.length, 0); assert.equal(b.usage.length, 0, "a failed call reports no usage");
      /* a failing primary with NO fallbacks never reaches the installation's provider */
      const c = await run(scope(primary.base), () => transcribe(WEBM, opts));
      assert.ok(!c.value.ok); assert.equal(platform.log.length, 0, "no silent platform spend");
      if (!c.value.ok) { assert.equal(c.value.status, 429); assert.match(c.value.reason, /Your speech-to-text provider is rate-limiting/); }
      /* the platform answers ONLY when the user listed it, and the usage is marked as the platform's */
      const d = await run(scope(primary.base, { fallbacks: [platformSttTarget()!] }), () => transcribe(WEBM, opts));
      assert.ok(d.value.ok); assert.equal(platform.log.length, 1); assert.equal(platform.log[0].auth, "Bearer PLATFORM-STT");
      assert.deepEqual([d.usage[0].source, d.usage[0].usedFallback], ["platform", true]);
      /* every provider failing says so */
      const e = await run(scope(primary.base, { fallbacks: [target(primary.base)] }), () => transcribe(WEBM, opts));
      assert.ok(!e.value.ok); if (!e.value.ok) assert.match(e.value.reason, /fallback providers also failed/);
    });
  } finally { for (const m of [platform, primary, fb1, bad, never]) await m.close(); }
});

test("a user's own failure says whose it is and where to fix it; a provider's bad key is not the installation's", async () => {
  const s = await mock(json(401, { error: { message: "Incorrect API key provided" } }));
  try {
    await withEnv({}, async () => {
      const r = await run(scope(s.base), () => transcribe(WEBM, opts));
      assert.ok(!r.value.ok); if (!r.value.ok) { assert.match(r.value.reason, /Your speech-to-text provider rejected the API key/); assert.match(r.value.reason, /Settings → AI & Integrations/); assert.ok(!/AI_API_KEY/.test(r.value.reason)); assert.ok(!r.value.reason.includes("USER-STT-KEY")); }
      /* outside a scope the platform's wording is unchanged */
      process.env.AI_API_URL = s.base; process.env.AI_API_KEY = "K";
      const o = await transcribe(WEBM, opts);
      assert.ok(!o.ok); if (!o.ok) assert.match(o.reason, /rejected this installation's credentials/);
    });
  } finally { await s.close(); }
});

test("a vendor with no speech endpoint is refused before the round trip — for a user's endpoint too", async () => {
  await withEnv({}, async () => {
    const r = await run(scope("https://api.anthropic.com/v1"), () => transcribe(WEBM, opts));
    assert.ok(!r.value.ok); if (!r.value.ok) assert.match(r.value.reason, /Anthropic's API has no speech-to-text endpoint/);
  });
  assert.equal(platformSttTarget({ AI_API_URL: "https://api.anthropic.com/v1" }), null, "and it is not offered as a platform backstop");
  assert.equal(platformSttTarget({ AI_API_URL: "fake:" }), null); assert.equal(platformSttTarget({}), null);
  const t = platformSttTarget({ AI_API_URL: "https://chat.example/v1", AI_API_KEY: "A", AI_STT_API_URL: "https://stt.example/v1", AI_STT_MODEL: "whisper-large" })!;
  assert.deepEqual([t.base, t.key, t.model, t.platform], ["https://stt.example/v1", "A", "whisper-large", true]);
  assert.ok(sttUnavailableReason() !== undefined);
});

test("GOOGLE: its own request, its own header, its own limits", async () => {
  const g = await mock(json(200, { results: [{ alternatives: [{ transcript: "hello world", words: [{ startTime: "0.4s", endTime: "0.9s" }] }], resultEndTime: "1.8s", languageCode: "en-us" }, { alternatives: [{ transcript: "second part" }], resultEndTime: "3.5s" }], totalBilledTime: "15s" }));
  const fb = await mock(whisper("from the fallback"));
  try {
    await withEnv({ AI_API_URL: "https://chat.example/v1", AI_API_KEY: "PLATFORM" }, async () => {
      const gs = (over: Partial<SttScope> = {}) => scope(g.base, { provider: "google-stt", protocol: "google-stt", model: "latest_short", limits: { maxSeconds: 60, maxBytes: 10 * 1024 * 1024 }, ...over });
      const a = await run(gs(), () => transcribe(WEBM, { ...opts, language: "pt", segments: true }));
      assert.ok(a.value.ok); if (a.value.ok) {
        assert.equal(a.value.value.text, "hello world second part"); assert.equal(a.value.value.provider, "google-stt");
        assert.deepEqual(a.value.value.segments, [{ start: 0.4, end: 1.8, text: "hello world" }, { start: 1.8, end: 3.5, text: "second part" }]);
      }
      const seen = g.log[0];
      assert.equal(seen.url, "/v1/speech:recognize"); assert.equal(seen.gkey, "USER-STT-KEY"); assert.equal(seen.auth, undefined, "Google gets its key in its header, not a bearer token");
      const req = JSON.parse(seen.body);
      assert.deepEqual([req.config.encoding, req.config.languageCode, req.config.model, req.config.enableWordTimeOffsets], ["WEBM_OPUS", "pt-BR", "latest_short", true]);
      assert.equal(Buffer.from(req.audio.content, "base64").length, WEBM.length);
      assert.deepEqual([a.usage[0].seconds, a.usage[0].estimated, a.usage[0].providerId, a.usage[0].source], [15, false, "google-stt", "user"], "the billed time Google reports is what is recorded");
      /* WAV: the header names the format, so no encoding is sent; the default language is en-US */
      await run(gs(), () => transcribe(WAV, { ...opts, mimeType: "audio/wav" }));
      const wreq = JSON.parse(g.log[1].body); assert.equal(wreq.config.encoding, undefined); assert.equal(wreq.config.languageCode, "en-US"); assert.equal(wreq.config.enableWordTimeOffsets, undefined);
      /* a recording it cannot read, or one that is too long, is refused BEFORE the call — and a listed fallback can take it */
      const n = g.log.length;
      const b = await run(gs({ fallbacks: [target(fb.base)] }), () => transcribe(MP4, { ...opts, mimeType: "audio/mp4" }));
      assert.equal(g.log.length, n, "no request was made to Google"); assert.ok(b.value.ok); if (b.value.ok) assert.equal(b.value.value.text, "from the fallback");
      const long = await run(gs(), () => transcribe(WEBM, { ...opts, durationSeconds: 300 }));
      assert.equal(g.log.length, n); assert.ok(!long.value.ok); if (!long.value.ok) { assert.match(long.value.reason, /up to 60 seconds; this one is about 300/); assert.match(long.value.reason, /allow the platform as a backstop/); }
    });
  } finally { await g.close(); await fb.close(); }
});

test("GOOGLE: a bad key is an auth failure (Google says 400), a disabled API says how to enable it, silence is not a provider failure", async () => {
  const bad = await mock(json(400, { error: { code: 400, message: "API key not valid. Please pass a valid API key.", status: "INVALID_ARGUMENT" } }));
  const off = await mock(json(403, { error: { code: 403, message: "Cloud Speech-to-Text API has not been used in project 123 before or it is disabled.", status: "PERMISSION_DENIED" } }));
  const quiet = await mock(json(200, {}));
  const next = await mock(whisper("rescued"));
  try {
    await withEnv({}, async () => {
      const gs = (base: string, over: Partial<SttScope> = {}) => scope(base, { provider: "google-stt", protocol: "google-stt", model: "latest_short", ...over });
      const a = await run(gs(bad.base), () => transcribe(WEBM, opts));
      assert.ok(!a.value.ok); if (!a.value.ok) { assert.equal(a.value.status, 401); assert.match(a.value.reason, /rejected the API key/); }
      const b = await run(gs(off.base), () => transcribe(WEBM, opts));
      assert.ok(!b.value.ok); if (!b.value.ok) assert.match(b.value.reason, /Enable the Cloud Speech-to-Text API/);
      /* an auth failure is one a fallback can cure; silence is not */
      const c = await run(gs(bad.base, { fallbacks: [target(next.base)] }), () => transcribe(WEBM, opts));
      assert.ok(c.value.ok);
      const d = await run(gs(quiet.base, { fallbacks: [target(next.base)] }), () => transcribe(WEBM, opts));
      assert.ok(!d.value.ok); if (!d.value.ok) assert.match(d.value.reason, /heard no speech/); assert.equal(next.log.length, 1, "the fallback was not asked about a silent recording");
    });
  } finally { for (const m of [bad, off, quiet, next]) await m.close(); }
});

test("the endpoint guard holds for speech: a private address is refused unless the operator allowed it, and the reason is not a fallback", async () => {
  await withEnv({}, async () => {
    const r = await collectUsage(() => withAiScope({ stt: scope("http://127.0.0.1:9/v1") }, () => transcribe(WEBM, opts)));
    assert.ok(!r.value.ok); if (!r.value.ok) assert.match(r.value.reason, /address this Studio will not call/);
    assert.equal(r.usage.length, 0);
  });
});

test("two users' speech connections have different identities (so no cache or in-flight share crosses them)", async () => {
  const a = await withAiScope({ stt: scope("https://x.example/v1", { key: "KEY-A" }) }, async () => aiIdentity("stt"));
  const b = await withAiScope({ stt: scope("https://x.example/v1", { key: "KEY-B" }) }, async () => aiIdentity("stt"));
  assert.notEqual(a, b); assert.ok(!a.includes("KEY-A"));
  assert.equal(aiIdentity("stt"), "platform");
});

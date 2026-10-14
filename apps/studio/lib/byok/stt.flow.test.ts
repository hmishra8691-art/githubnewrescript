import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { randomBytes } from "node:crypto";
import { Meter, MemoryMeterStore, type MeterContext } from "@rescript/billing";
import { transcribe } from "@rescript/ai";
import { MemoryAiStore } from "./store.ts";
import { resolveConnection } from "./resolve.ts";
import { saveSetting } from "./service.ts";
import { featureOf, needsOf } from "./features.ts";
import { meteredCore, type RunDeps } from "../meterRun.ts";
import { setAiSettingsLoader } from "../aiPolicy.ts";

/**
 * THE WHOLE SPEECH PATH, nothing stubbed but the provider's network end:
 * the saved setting → the resolver → the metering door → `transcribe` →
 * a real HTTP provider; then the wallet and the usage record.
 */
const ALICE = "aaaaaaaa-0000-0000-0000-000000000001", BOB = "bbbbbbbb-0000-0000-0000-000000000002";
const KEY = "sk-stt-ALICESPEECHKEY1234567890";
type Seen = { url: string; auth?: string };
async function provider(status: number, body: unknown) {
  const log: Seen[] = [];
  const s = http.createServer((q, r) => { q.resume(); q.on("end", () => { log.push({ url: q.url ?? "", auth: q.headers.authorization }); r.writeHead(status, { "content-type": "application/json" }); r.end(JSON.stringify(body)); }); });
  await new Promise<void>((r) => s.listen(0, "127.0.0.1", r));
  return { log, base: `http://127.0.0.1:${(s.address() as { port: number }).port}/v1`, close: () => new Promise<void>((r) => { s.closeAllConnections?.(); s.close(() => r()); }) };
}
const heard = { text: "hello there", language: "en", duration: 12.4 };
const ctxOf = (userId: string): MeterContext => ({ customerId: "c1", surveyId: "s1", userId, environment: "LIVE" });
setAiSettingsLoader(async () => ({ mode: "internal", disabled: [] })); // transcription is not a language model: an internal project still transcribes

function door(store: MemoryAiStore, env: Record<string, string | undefined>): RunDeps {
  return { allowPrivate: () => true, connectionFor: async (ask) => resolveConnection({ userId: ask.userId!, feature: featureOf(ask.operation), store, env, project: ask.source ? { mode: ask.source } : null, need: needsOf(ask.operation) }) };
}
const run = (deps: RunDeps, meter: Meter, userId: string) => meteredCore(deps, meter, ctxOf(userId), {
  operation: "intelligent_voice", kind: "stt", tolerateMeterOutage: true,
  reserve: () => ({ eventType: "SPEECH_TO_TEXT_MINUTE", provider: "openai-compatible", service: "stt", model: "whisper-1", quantity: 0.2, metadata: { operation: "intelligent_voice", seconds: 12 } }),
}, () => transcribe(new Uint8Array(4000).fill(5), { durationSeconds: 12, mimeType: "audio/webm", fileName: "a.webm" }));

test("Alice's own speech provider transcribes with HER key and costs the wallet nothing; Bob, with no setting, is the platform's customer — at the same moment", async () => {
  const mine = await provider(200, heard), platform = await provider(200, { ...heard, text: "platform heard" });
  try {
    const env = { AI_CREDENTIAL_KEY: randomBytes(32).toString("hex"), AI_BYOK_ALLOW_PRIVATE_ENDPOINTS: "1", AI_STT_API_URL: platform.base, AI_STT_API_KEY: "PLATFORM-STT-KEY" };
    for (const [k, v] of Object.entries(env)) process.env[k] = v;
    const store = new MemoryAiStore();
    const saved = await saveSetting(ALICE, { feature: "stt", mode: "user", config: { provider: "openai-compatible-stt", base: mine.base, model: "whisper-1" }, apiKey: KEY }, { store, env });
    assert.ok(saved.ok, JSON.stringify(saved));
    const ms = new MemoryMeterStore(); const meter = new Meter(ms, { seedBalance: 10, cacheMs: 0 });
    const deps = door(store, env);
    const [a, b] = await Promise.all([run(deps, meter, ALICE), run(deps, meter, BOB)]);
    assert.ok(a.ok && b.ok);
    assert.equal((a.value as { ok: boolean; value: { text: string } }).value.text, "hello there");
    assert.equal((b.value as { ok: boolean; value: { text: string } }).value.text, "platform heard");
    assert.deepEqual(mine.log.map((l) => [l.url, l.auth]), [["/v1/audio/transcriptions", `Bearer ${KEY}`]], "Alice's provider got Alice's key and only her request");
    assert.deepEqual(platform.log.map((l) => [l.url, l.auth]), [["/v1/audio/transcriptions", "Bearer PLATFORM-STT-KEY"]], "the platform served Bob alone");
    /* money: Alice's minutes are recorded and free; Bob's are the platform's and charged */
    const byAlice = ms.usage.filter((e) => e.userId === ALICE), byBob = ms.usage.filter((e) => e.userId === BOB);
    assert.equal(byAlice.length, 1); assert.equal(byAlice[0].eventType, "AI_REQUEST_BYOK"); assert.equal(byAlice[0].customerCharge, 0); assert.equal(byAlice[0].unit, "minute");
    assert.equal(byAlice[0].provider, "openai-compatible-stt"); assert.equal(Math.round(Number(byAlice[0].quantity) * 60), 12);
    assert.equal(byBob.length, 1); assert.equal(byBob[0].eventType, "SPEECH_TO_TEXT_MINUTE");
    assert.equal(JSON.stringify(ms.usage).includes(KEY), false, "no key in any record");
  } finally { await mine.close(); await platform.close(); for (const k of ["AI_CREDENTIAL_KEY", "AI_BYOK_ALLOW_PRIVATE_ENDPOINTS", "AI_STT_API_URL", "AI_STT_API_KEY"]) delete process.env[k]; }
});

test("Alice's provider is down: with no backstop the transcription fails in HER words and the platform's provider is never called; with the backstop allowed it answers, is billed as the platform's, and the user's failed call costs nothing", async () => {
  const down = await provider(503, { error: { message: "overloaded" } }), platform = await provider(200, { ...heard, text: "platform rescued" });
  try {
    const env = { AI_CREDENTIAL_KEY: randomBytes(32).toString("hex"), AI_BYOK_ALLOW_PRIVATE_ENDPOINTS: "1", AI_STT_API_URL: platform.base, AI_STT_API_KEY: "PLATFORM-STT-KEY" };
    for (const [k, v] of Object.entries(env)) process.env[k] = v;
    const store = new MemoryAiStore();
    const cfg = { feature: "stt", mode: "user", config: { provider: "openai-compatible-stt", base: down.base, model: "whisper-1" }, apiKey: KEY };
    assert.ok((await saveSetting(ALICE, cfg, { store, env })).ok);
    const ms = new MemoryMeterStore(); const meter = new Meter(ms, { seedBalance: 10, cacheMs: 0 });
    const deps = door(store, env);

    const a = await run(deps, meter, ALICE);
    assert.ok(a.ok); const av = a.value as { ok: boolean; reason?: string };
    assert.equal(av.ok, false); assert.match(String(av.reason), /Your speech-to-text provider/);
    assert.equal(platform.log.length, 0, "no silent platform spend");
    assert.equal(ms.usage.length, 0, "a failed call is neither billed nor recorded");
    assert.equal([...ms.reservations.values()].filter((r) => r.status === "held").length, 0);

    assert.ok((await saveSetting(ALICE, { ...cfg, apiKey: undefined, allowPlatformFallback: true }, { store, env })).ok);
    const b = await run(deps, meter, ALICE);
    assert.ok(b.ok && b.event); assert.equal((b.value as { value: { text: string } }).value.text, "platform rescued");
    assert.equal(platform.log.length, 1); assert.equal(platform.log[0].auth, "Bearer PLATFORM-STT-KEY");
    assert.equal(b.event!.eventType, "SPEECH_TO_TEXT_MINUTE"); assert.equal(b.event!.metadata.source, "platform_fallback"); assert.ok(b.event!.customerCharge >= 0);
    assert.equal(ms.usage.filter((e) => e.eventType === "AI_REQUEST_BYOK").length, 0, "the platform's minutes are not recorded as the user's own");
  } finally { await down.close(); await platform.close(); for (const k of ["AI_CREDENTIAL_KEY", "AI_BYOK_ALLOW_PRIVATE_ENDPOINTS", "AI_STT_API_URL", "AI_STT_API_KEY"]) delete process.env[k]; }
});

test("a project that chose the user's provider, for a user who set none up: refused in words, nothing reserved, no provider reached", async () => {
  const platform = await provider(200, heard);
  try {
    const env = { AI_CREDENTIAL_KEY: randomBytes(32).toString("hex"), AI_STT_API_URL: platform.base };
    for (const [k, v] of Object.entries(env)) process.env[k] = v;
    setAiSettingsLoader(async () => ({ mode: "cloud", disabled: [], source: "user" }));
    const ms = new MemoryMeterStore(); const meter = new Meter(ms, { seedBalance: 10, cacheMs: 0 });
    const r = await run(door(new MemoryAiStore(), env), meter, BOB);
    assert.equal(r.ok, false); assert.equal((r as { reason: string; code: string }).reason, "ai_connection"); assert.equal((r as { code: string }).code, "no_connection");
    assert.match((r as { message: string }).message, /speech-to-text/);
    assert.equal(platform.log.length, 0); assert.equal(ms.usage.length, 0); assert.equal(ms.reservations.size, 0);
  } finally { setAiSettingsLoader(async () => ({ mode: "internal", disabled: [] })); await platform.close(); for (const k of ["AI_CREDENTIAL_KEY", "AI_STT_API_URL"]) delete process.env[k]; }
});

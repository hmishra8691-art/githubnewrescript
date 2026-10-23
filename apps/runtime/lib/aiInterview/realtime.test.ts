import { test } from "node:test";
import assert from "node:assert/strict";
import { mintRealtimeSession, mintRequest, realtimeConfig, realtimeRefusal, RealtimeError } from "./realtime.ts";

/*
 * THE REALTIME PROVIDER (G1 2026-10-22), against a fake: refused (and why) without configuration or with a
 * protocol that cannot be gated; the minting request carries the gate (no automatic responses), the
 * transcription in the participant's language, the tools and the instructions, and the key only in the
 * server's Authorization header; GA and beta answers are read; provider errors are mapped.
 */

const ENV = { AI_REALTIME_API_URL: "https://realtime.example.test/v1/", AI_REALTIME_API_KEY: "sk-test-REALTIME", AI_REALTIME_MODEL: "gpt-realtime" };

test("configuration and refusals", () => {
  assert.match(realtimeRefusal({})!, /No realtime voice provider is configured/);
  assert.equal(realtimeRefusal(ENV), null);
  assert.match(realtimeRefusal({ ...ENV, AI_REALTIME_PROTOCOL: "acme" })!, /cannot be gated|only the OpenAI Realtime protocol/);
  assert.match(realtimeRefusal({ ...ENV, AI_REALTIME_API_URL: "http://insecure.test" })!, /https/);
  assert.deepEqual(realtimeConfig(ENV), { base: "https://realtime.example.test/v1", key: "sk-test-REALTIME", model: "gpt-realtime", voice: "marin", transcribeModel: "gpt-4o-mini-transcribe", protocol: "openai" });
});

test("the minting request: the gate, the language, the tools, the instructions; the key only in the header", () => {
  const { url, init } = mintRequest(realtimeConfig(ENV)!, { instructions: "THE GUIDE…", tools: [{ type: "function", name: "probe" }], language: "hi" });
  assert.equal(url, "https://realtime.example.test/v1/realtime/client_secrets");
  assert.equal(init.headers.authorization, "Bearer sk-test-REALTIME");
  const body = JSON.parse(init.body);
  assert.equal(body.session.type, "realtime"); assert.equal(body.session.model, "gpt-realtime"); assert.equal(body.session.instructions, "THE GUIDE…");
  assert.equal(body.session.audio.input.turn_detection.create_response, false, "the provider never answers on its own");
  assert.equal(body.session.audio.input.turn_detection.interrupt_response, true);
  assert.deepEqual(body.session.audio.input.transcription, { model: "gpt-4o-mini-transcribe", language: "hi" });
  assert.equal(body.session.tools[0].name, "probe");
  assert.equal(body.expires_after.seconds, 600);
  assert.ok(!init.body.includes("sk-test-REALTIME"), "the key is not in the body");
});

test("minting against a fake provider: GA and beta answers; errors mapped; nothing minted when not configured", async () => {
  const calls: { url: string; init: RequestInit }[] = [];
  const fake = (answer: unknown, status = 200) => (async (url: string, init: RequestInit) => { calls.push({ url, init }); return new Response(JSON.stringify(answer), { status, headers: { "content-type": "application/json" } }); }) as unknown as typeof fetch;
  const ga = await mintRealtimeSession({ instructions: "x", tools: [], language: "en" }, { env: ENV, fetchImpl: fake({ value: "ek_GA", expires_at: 1790000000 }) });
  assert.deepEqual(ga, { clientSecret: "ek_GA", expiresAt: 1790000000, callUrl: "https://realtime.example.test/v1/realtime/calls", model: "gpt-realtime", voice: "marin" });
  const beta = await mintRealtimeSession({ instructions: "x", tools: [], language: "en" }, { env: ENV, fetchImpl: fake({ client_secret: { value: "ek_BETA", expires_at: 1 } }) });
  assert.equal(beta.clientSecret, "ek_BETA");
  await assert.rejects(mintRealtimeSession({ instructions: "x", tools: [], language: "en" }, { env: ENV, fetchImpl: fake({ error: "bad key" }, 401) }), (e: RealtimeError) => e.status === 502 && /refused the key/.test(e.message) && !e.message.includes("sk-test"));
  await assert.rejects(mintRealtimeSession({ instructions: "x", tools: [], language: "en" }, { env: ENV, fetchImpl: fake({}) }), /no session secret/);
  const n = calls.length;
  await assert.rejects(mintRealtimeSession({ instructions: "x", tools: [], language: "en" }, { env: {}, fetchImpl: fake({}) }), (e: RealtimeError) => e.status === 501);
  assert.equal(calls.length, n, "no request without configuration");
});

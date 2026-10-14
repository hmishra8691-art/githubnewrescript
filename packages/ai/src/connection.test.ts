import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import {
  completeJson, transcribe, withAiScope, aiIdentity, aiConfigured, aiProviderName, aiModelName, aiEmbeddingsModelName, collectUsage, resetProviderState, setProviderLogger,
  isProviderError, sttConfigured, type ProviderError, type ChatScope,
} from "./index.js";

/**
 * THE CONNECTION SCOPE: a user's provider for one request — their address,
 * key, model and headers; never the installation's; never another user's.
 */
const KEYS = ["AI_API_URL", "AI_API_KEY", "AI_MODEL", "AI_MODEL_SMALL", "AI_WORKSPACE_ID", "AI_API_HEADERS", "AI_FALLBACK_API_URL", "AI_FALLBACK_API_KEY", "AI_FALLBACK_MODEL", "AI_STT_API_URL", "AI_STT_API_KEY", "AI_STT_MODEL", "AI_EMBEDDINGS_MODEL"];
type Seen = { url: string; auth?: string; ws?: string; org?: string; model?: string; body: string; host?: string };
async function mock(handler: (seen: Seen, res: http.ServerResponse) => void) {
  const log: Seen[] = [];
  const s = http.createServer((q, r) => { let b = ""; q.on("data", (c) => (b += c)); q.on("end", () => { const seen: Seen = { url: q.url ?? "", auth: q.headers.authorization, ws: q.headers["anthropic-workspace-id"] as string, org: q.headers["openai-organization"] as string, body: b, host: q.headers.host, model: (() => { try { return JSON.parse(b).model; } catch { return undefined; } })() }; log.push(seen); handler(seen, r); }); });
  await new Promise<void>((r) => s.listen(0, "127.0.0.1", r));
  const port = (s.address() as { port: number }).port;
  return { log, base: `http://127.0.0.1:${port}/v1`, close: () => new Promise<void>((r) => { s.closeAllConnections?.(); s.close(() => r()); }) };
}
const ok = (content = '{"a":1}') => (_s: Seen, r: http.ServerResponse) => { r.writeHead(200, { "content-type": "application/json" }); r.end(JSON.stringify({ choices: [{ message: { content }, finish_reason: "stop" }], usage: { prompt_tokens: 5, completion_tokens: 3 } })); };
const fail = (status: number, body = "{}") => (_s: Seen, r: http.ServerResponse) => { r.writeHead(status, { "content-type": "application/json" }); r.end(body); };

async function withEnv(extra: Record<string, string>, fn: () => Promise<void>) {
  const saved = Object.fromEntries(KEYS.map((k) => [k, process.env[k]]));
  resetProviderState(); setProviderLogger(() => {});
  try { for (const k of KEYS) delete process.env[k]; Object.assign(process.env, extra); await fn(); }
  finally { setProviderLogger(null); resetProviderState(); for (const k of KEYS) { delete process.env[k]; if (saved[k] !== undefined) process.env[k] = saved[k]!; } }
}
const chat = (base: string, over: Partial<ChatScope> = {}): ChatScope => ({ source: "user", provider: "openai-compatible", base, key: "USER-KEY-1", model: "user-model", fallbacks: [], ...over });
const fast = { retryDelayMs: 5, retries: 0 };

test("inside a user's connection the call goes to THEIR address with THEIR key, model and headers — and none of the installation's", async () => {
  const platform = await mock(ok('{"from":"platform"}')); const mine = await mock(ok('{"from":"user"}'));
  try {
    await withEnv({ AI_API_URL: platform.base, AI_API_KEY: "PLATFORM-KEY", AI_MODEL: "platform-model", AI_WORKSPACE_ID: "wrk_PLATFORM", AI_API_HEADERS: '{"OpenAI-Organization":"org_PLATFORM"}' }, async () => {
      const outside = await completeJson("s", "u", 50, fast);
      assert.deepEqual(outside, { from: "platform" });
      assert.deepEqual([platform.log[0].auth, platform.log[0].ws, platform.log[0].org, platform.log[0].model], ["Bearer PLATFORM-KEY", "wrk_PLATFORM", "org_PLATFORM", "platform-model"], "unchanged outside a scope");
      const inside = await withAiScope({ allowPrivate: true, chat: chat(mine.base, { headers: { "openai-organization": "org_USER" } }) }, () => completeJson("s", "u", 50, fast));
      assert.deepEqual(inside, { from: "user" });
      assert.equal(platform.log.length, 1, "the platform provider was not reached");
      assert.deepEqual([mine.log[0].auth, mine.log[0].org, mine.log[0].model, mine.log[0].ws], ["Bearer USER-KEY-1", "org_USER", "user-model", undefined]);
      assert.equal(JSON.stringify(mine.log).includes("PLATFORM"), false, "nothing of the installation reached the user's provider");
    });
  } finally { await platform.close(); await mine.close(); }
});

test("a user's provider that fails does NOT fall through to the installation's key or the operator's fallback", async () => {
  const platform = await mock(ok('{"from":"platform"}')); const opFallback = await mock(ok('{"from":"operator-fallback"}')); const mine = await mock(fail(401, '{"error":"bad key"}'));
  try {
    await withEnv({ AI_API_URL: platform.base, AI_API_KEY: "PLATFORM-KEY", AI_MODEL: "pm", AI_FALLBACK_API_URL: opFallback.base, AI_FALLBACK_API_KEY: "OP-KEY", AI_FALLBACK_MODEL: "om" }, async () => {
      const e = await withAiScope({ allowPrivate: true, chat: chat(mine.base) }, () => completeJson("s", "u", 50, fast)).catch((x) => x) as ProviderError;
      assert.ok(isProviderError(e)); assert.equal(e.kind, "auth");
      assert.equal(platform.log.length + opFallback.log.length, 0, "no platform spend after a user's provider failed");
    });
  } finally { await platform.close(); await opFallback.close(); await mine.close(); }
});

test("the user's listed fallbacks are tried in order; a platform fallback only because the user listed it, with the platform's key and headers — and the usage says who answered", async () => {
  const platform = await mock(ok('{"from":"platform"}')); const second = await mock(fail(429, "slow down")); const mine = await mock(fail(429, '{"error":"rate limit"}'));
  try {
    await withEnv({ AI_API_URL: platform.base, AI_API_KEY: "PLATFORM-KEY", AI_MODEL: "pm", AI_WORKSPACE_ID: "wrk_P" }, async () => {
      const scope = chat(mine.base, { fallbacks: [{ provider: "openai-compatible", base: second.base, key: "USER-KEY-2", model: "second" }, { provider: "platform", base: platform.base, key: "PLATFORM-KEY", model: "pm", platform: true }] });
      const { value, usage } = await collectUsage(() => withAiScope({ allowPrivate: true, chat: scope }, () => completeJson("s", "u", 50, fast)));
      assert.deepEqual(value, { from: "platform" });
      assert.deepEqual([mine.log.length, second.log.length, platform.log.length], [1, 1, 1]);
      assert.equal(second.log[0].auth, "Bearer USER-KEY-2"); assert.equal(platform.log[0].auth, "Bearer PLATFORM-KEY"); assert.equal(platform.log[0].ws, "wrk_P");
      assert.equal(JSON.stringify(second.log).includes("PLATFORM"), false); assert.equal(JSON.stringify(platform.log).includes("USER-KEY"), false, "a user's key never reaches the platform provider");
      assert.equal(usage[0].source, "platform"); assert.equal(usage[0].usedFallback, true);
      const { usage: u2 } = await collectUsage(() => withAiScope({ allowPrivate: true, chat: chat(platform.base) }, () => completeJson("s", "u", 50, fast)));
      assert.equal(u2[0].source, "user"); assert.equal(u2[0].providerId, "openai-compatible");
    });
  } finally { await platform.close(); await second.close(); await mine.close(); }
});

test("two users' requests in flight at once never swap keys, models or answers", async () => {
  const srv = await mock((seen, r) => setTimeout(() => ok(JSON.stringify({ key: seen.auth, model: seen.model }))(seen, r), Math.random() * 20));
  try {
    await withEnv({}, async () => {
      const run = (n: number) => withAiScope({ allowPrivate: true, chat: chat(srv.base, { key: `KEY-${n}`, model: `model-${n}` }) }, async () => { await new Promise((r) => setTimeout(r, Math.random() * 10)); return completeJson("s", `u${n}`, 50, fast); });
      const out = await Promise.all(Array.from({ length: 30 }, (_, n) => run(n)));
      out.forEach((o, n) => assert.deepEqual(o, { key: `Bearer KEY-${n}`, model: `model-${n}` }, `request ${n}`));
    });
  } finally { await srv.close(); }
});

test("the identity of a connection names provider, address, model and a HASH of the key — never the key — and differs with each", async () => {
  await withEnv({}, async () => {
    assert.equal(aiIdentity(), "platform");
    const id = (c: Partial<ChatScope>) => withAiScope({ chat: chat("https://api.example.com/v1", c) }, async () => aiIdentity());
    const a = await id({}), b = await id({ key: "USER-KEY-2" }), c = await id({ model: "other" }), d = await id({ base: "https://api.other.com/v1" });
    assert.equal(new Set([a, b, c, d]).size, 4);
    for (const x of [a, b, c, d]) { assert.equal(x.includes("USER-KEY"), false); assert.match(x, /^chat:user:[0-9a-f]{16}$/); }
    assert.equal(await id({}), a, "stable");
  });
});

test("the scope decides configuration questions: configured, provider, model tiers, embeddings — and the environment's embeddings model is not the user's", async () => {
  await withEnv({ AI_API_URL: "https://platform.example.com/v1", AI_API_KEY: "k", AI_MODEL: "pm", AI_EMBEDDINGS_MODEL: "platform-embed" }, async () => {
    assert.deepEqual([aiConfigured(), aiProviderName(), aiModelName(), aiEmbeddingsModelName()], [true, "openai-compatible", "pm", "platform-embed"]);
    await withAiScope({ chat: chat("https://u.example.com/v1", { modelSmall: "user-small" }) }, async () => {
      assert.deepEqual([aiModelName(), aiModelName("small"), aiEmbeddingsModelName()], ["user-model", "user-small", null]);
    });
  });
  await withEnv({}, async () => {
    assert.equal(aiConfigured(), false);
    await withAiScope({ chat: chat("https://u.example.com/v1") }, async () => assert.equal(aiConfigured(), true));
  });
});

test("a user's address goes through the endpoint guard: a private address is refused, once, and the refusal is not retried", async () => {
  const internal = await mock(ok('{"secret":"internal"}'));
  try {
    await withEnv({}, async () => {
      for (const base of ["https://169.254.169.254/v1", "https://127.0.0.1/v1", "https://[::1]/v1", "http://api.example.com/v1"]) {
        const e = await withAiScope({ chat: chat(base) }, () => completeJson("s", "u", 50, { retryDelayMs: 5, retries: 3 })).catch((x) => x) as ProviderError;
        assert.ok(isProviderError(e), base); assert.equal(e.kind, "bad_request", base); assert.equal(e.retryable, false); assert.equal(e.attempts, 1);
      }
      /* the operator's own network, said in the SERVER's scope (never by a user): the same call is allowed */
      assert.deepEqual(await withAiScope({ allowPrivate: true, chat: chat(internal.base) }, () => completeJson("s", "u", 50, fast)), { secret: "internal" });
      /* …and without it, the internal server is refused though the user typed its address */
      const before = internal.log.length;
      await withAiScope({ chat: chat(internal.base) }, () => completeJson("s", "u", 50, fast)).catch(() => {});
      assert.equal(internal.log.length, before);
    });
  } finally { await internal.close(); }
});

test("speech-to-text in a user's scope uses THEIR address, key and model — and not the chat provider's headers or the installation's key", async () => {
  const srv = await mock((s, r) => { r.writeHead(200, { "content-type": "application/json" }); r.end(JSON.stringify({ text: "hello there", language: "en", duration: 2 })); });
  try {
    await withEnv({ AI_API_URL: "https://platform.example.com/v1", AI_API_KEY: "PLATFORM-KEY", AI_WORKSPACE_ID: "wrk_P", AI_STT_MODEL: "platform-stt" }, async () => {
      const out = await withAiScope({ allowPrivate: true, stt: { source: "user", provider: "openai", base: srv.base, key: "STT-KEY", model: "user-stt", headers: { "openai-project": "proj_1" }, fallbacks: [] } }, async () => { assert.equal(sttConfigured(), true); return transcribe(new Uint8Array(4000).fill(1), { mimeType: "audio/webm" }); });
      assert.equal(out.ok, true);
      assert.equal(srv.log[0].url, "/v1/audio/transcriptions"); assert.equal(srv.log[0].auth, "Bearer STT-KEY");
      assert.match(srv.log[0].body, /name="model"\r\n\r\nuser-stt/); assert.equal(srv.log[0].ws, undefined); assert.equal(srv.log[0].body.includes("PLATFORM"), false);
    });
  } finally { await srv.close(); }
});

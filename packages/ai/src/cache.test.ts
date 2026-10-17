import test from "node:test";
import assert from "node:assert/strict";
import { anthropicNative, anthropicRequest, chatUsageFrom, collectUsage, completeJson, promptCacheEnabled, resetNativeRefusals, resetOutputCeilings, resetProviderState, setProviderLogger, sumUsage } from "./index.js";

/**
 * PROVIDER PROMPT CACHING (AI cost audit, 2026-10-17).
 *
 * The stable prefix of a request (the system prompt, the guides) is cached by
 * the provider; a read of it is billed at the provider's cached rate. These
 * tests hold the wire contract (what is sent to Anthropic natively and to an
 * OpenAI-style API), the usage read back (cached and written tokens, per
 * provider), and the metering contract (a retried HTTP attempt or a failed
 * call reports nothing; continuations report per call and sum to one total).
 */
const KEYS = ["AI_API_URL", "AI_API_KEY", "AI_MODEL", "AI_MODEL_SMALL", "AI_WORKSPACE_ID", "AI_API_HEADERS", "AI_PROMPT_CACHE", "AI_FALLBACK_API_URL", "AI_FALLBACK_API_KEY", "AI_FALLBACK_MODEL"];
async function withEnv(env: Record<string, string>, fn: () => Promise<void>) {
  const saved = Object.fromEntries(KEYS.map((k) => [k, process.env[k]]));
  try { for (const k of KEYS) delete process.env[k]; Object.assign(process.env, env); await fn(); }
  finally { for (const k of KEYS) { delete process.env[k]; if (saved[k] !== undefined) process.env[k] = saved[k]; } }
}
type Sent = { url: string; headers: Record<string, string>; body: Record<string, unknown> };
async function withFetch(reply: (s: Sent, n: number) => Response, fn: (sent: Sent[]) => Promise<void>) {
  const sent: Sent[] = [];
  const real = globalThis.fetch;
  globalThis.fetch = (async (url: string, init: { body: string; headers: Record<string, string> }) => {
    const s = { url: String(url), headers: init.headers, body: JSON.parse(init.body) };
    sent.push(s);
    return reply(s, sent.length);
  }) as never;
  resetProviderState(); resetNativeRefusals(); resetOutputCeilings();
  setProviderLogger(() => {});
  try { await fn(sent); } finally { globalThis.fetch = real; setProviderLogger(null); resetNativeRefusals(); }
}
const native = (text: string, usage: Record<string, number>, stop = "end_turn") =>
  new Response(JSON.stringify({ id: "msg_1", type: "message", role: "assistant", model: "claude-sonnet-4-6", content: [{ type: "text", text }], stop_reason: stop, usage }), { status: 200 });
const openai = (content: string, usage: Record<string, unknown>, finish = "stop") =>
  new Response(JSON.stringify({ choices: [{ message: { content }, finish_reason: finish }], usage, model: "gpt-4o-mini" }), { status: 200 });

const SYSTEM = "S".repeat(50);
const GUIDE = "G".repeat(30);

test("chatUsageFrom reads cached and written input per provider shape — all input counted once", () => {
  /* OpenAI: prompt_tokens INCLUDES the cached part */
  assert.deepEqual(chatUsageFrom({ prompt_tokens: 12000, completion_tokens: 900, prompt_tokens_details: { cached_tokens: 8000 } }), { inputTokens: 12000, outputTokens: 900, cachedInputTokens: 8000, cacheWriteTokens: 0 });
  /* Anthropic Messages: input_tokens EXCLUDES what was read from or written to the cache */
  assert.deepEqual(chatUsageFrom({ input_tokens: 4000, output_tokens: 2215, cache_read_input_tokens: 8000, cache_creation_input_tokens: 362 }), { inputTokens: 12362, outputTokens: 2215, cachedInputTokens: 8000, cacheWriteTokens: 362 });
  /* DeepSeek-style hit count */
  assert.equal(chatUsageFrom({ prompt_tokens: 100, completion_tokens: 1, prompt_cache_hit_tokens: 64 }).cachedInputTokens, 64);
  /* a gateway that reports both on the OpenAI shape (OpenRouter → Anthropic) */
  assert.deepEqual(chatUsageFrom({ prompt_tokens: 100, completion_tokens: 1, prompt_tokens_details: { cached_tokens: 60, cache_write_tokens: 30 } }), { inputTokens: 100, outputTokens: 1, cachedInputTokens: 60, cacheWriteTokens: 30 });
  /* nonsense is clamped to the input it is part of; nothing reported is undefined, not zero */
  assert.deepEqual(chatUsageFrom({ prompt_tokens: 10, completion_tokens: 1, prompt_tokens_details: { cached_tokens: 50, cache_write_tokens: 9 } }), { inputTokens: 10, outputTokens: 1, cachedInputTokens: 10, cacheWriteTokens: 0 });
  assert.deepEqual(chatUsageFrom(null), { inputTokens: undefined, outputTokens: undefined, cachedInputTokens: 0, cacheWriteTokens: 0 });
  assert.deepEqual(chatUsageFrom({ prompt_tokens: 7, completion_tokens: 2 }), { inputTokens: 7, outputTokens: 2, cachedInputTokens: 0, cacheWriteTokens: 0 }, "no cache fields: nothing cached");
});

test("anthropicRequest: each system block is a cache breakpoint (the last four), empties are dropped, no response_format", () => {
  const b = anthropicRequest("claude-sonnet-4-6", 32000, [SYSTEM, "", GUIDE], [{ role: "user", content: "outline + request" }]);
  assert.deepEqual(b.system, [
    { type: "text", text: SYSTEM, cache_control: { type: "ephemeral" } },
    { type: "text", text: GUIDE, cache_control: { type: "ephemeral" } },
  ]);
  assert.deepEqual(b.messages, [{ role: "user", content: "outline + request" }], "the variable part is not cached");
  assert.equal(b.max_tokens, 32000); assert.equal(b.temperature, 0); assert.equal("response_format" in b, false);
  const five = anthropicRequest("m", 10, ["a", "b", "c", "d", "e"], [{ role: "user", content: "u" }]);
  assert.deepEqual((five.system as { cache_control?: unknown }[]).map((x) => !!x.cache_control), [false, true, true, true, true], "at most four breakpoints");
  const off = anthropicRequest("m", 10, [SYSTEM], [{ role: "user", content: "u" }, { role: "assistant", content: "" }, { role: "user", content: "go on" }], false);
  assert.equal((off.system as { cache_control?: unknown }[])[0].cache_control, undefined, "cache=false: no markers");
  assert.equal((off.messages as { content: string }[])[1].content, "(empty)", "the API refuses an empty text block");
  assert.equal("system" in anthropicRequest("m", 10, [""], [{ role: "user", content: "u" }]), false, "no system at all when there is none");
});

test("AI_PROMPT_CACHE and the host decide the native path", () => {
  assert.equal(promptCacheEnabled({}), true, "on by default");
  for (const v of ["off", "0", "false", "NO"]) assert.equal(promptCacheEnabled({ AI_PROMPT_CACHE: v }), false, v);
  assert.equal(anthropicNative("https://api.anthropic.com/v1", {}), true);
  assert.equal(anthropicNative("https://api.anthropic.com/v1", { AI_PROMPT_CACHE: "off" }), false);
  assert.equal(anthropicNative("https://api.openai.com/v1", {}), false);
  assert.equal(anthropicNative("https://notanthropic.com.example/v1", {}), false, "the host, not a substring");
});

test("Anthropic is called natively: /messages, x-api-key, version, workspace — cached system blocks — and the cache tokens reach the usage", async () => {
  await withEnv({ AI_API_URL: "https://api.anthropic.com/v1", AI_API_KEY: "sk-ant-test", AI_MODEL: "claude-sonnet-4-6", AI_WORKSPACE_ID: "wrkspc_01ABC" }, () =>
    withFetch(() => native('{"ok":true}', { input_tokens: 4000, output_tokens: 2215, cache_read_input_tokens: 8000, cache_creation_input_tokens: 362 }), async (sent) => {
      const { value, usage } = await collectUsage(() => completeJson([SYSTEM, GUIDE], "variable", 32000, { schema: { name: "x", schema: { type: "object" } } }));
      assert.deepEqual(value, { ok: true });
      assert.equal(sent.length, 1);
      assert.equal(sent[0].url, "https://api.anthropic.com/v1/messages");
      assert.equal(sent[0].headers["x-api-key"], "sk-ant-test");
      assert.equal(sent[0].headers["anthropic-version"], "2023-06-01");
      assert.equal(sent[0].headers["anthropic-workspace-id"], "wrkspc_01ABC");
      assert.equal(sent[0].headers.authorization, undefined, "the key is not also sent as a bearer token");
      assert.equal("response_format" in sent[0].body, false);
      assert.deepEqual((sent[0].body.system as { text: string; cache_control?: unknown }[]).map((b) => [b.text.length, !!b.cache_control]), [[50, true], [30, true]]);
      assert.deepEqual(sent[0].body.messages, [{ role: "user", content: "variable" }]);
      assert.equal(usage.length, 1);
      assert.deepEqual({ in: usage[0].inputTokens, cached: usage[0].cachedInputTokens, written: usage[0].cacheWriteTokens, out: usage[0].outputTokens, est: usage[0].estimated }, { in: 12362, cached: 8000, written: 362, out: 2215, est: false });
    }));
});

test("a native answer cut off at max_tokens is continued, each continuation re-sends the cached prefix, and the parts sum to ONE total", async () => {
  await withEnv({ AI_API_URL: "https://api.anthropic.com/v1", AI_API_KEY: "k", AI_MODEL: "claude-sonnet-4-6" }, () =>
    withFetch((_s, n) => (n === 1 ? native('{"a":', { input_tokens: 500, output_tokens: 100, cache_creation_input_tokens: 9000 }, "max_tokens") : native("1}", { input_tokens: 620, output_tokens: 5, cache_read_input_tokens: 9000 })), async (sent) => {
      const { value, usage } = await collectUsage(() => completeJson([SYSTEM, GUIDE], "u", 100));
      assert.deepEqual(value, { a: 1 });
      assert.equal(sent.length, 2);
      assert.deepEqual(sent[1].body.system, sent[0].body.system, "the same prefix: the continuation reads it from the cache");
      assert.deepEqual((sent[1].body.messages as { role: string }[]).map((m) => m.role), ["user", "assistant", "user"]);
      const t = sumUsage(usage);
      assert.deepEqual({ requests: t.requests, in: t.inputTokens, cached: t.cachedInputTokens, written: t.cacheWriteTokens, out: t.outputTokens }, { requests: 2, in: 9500 + 9620, cached: 9000, written: 9000, out: 105 });
    }));
});

test("a native request refused for its shape is sent once more through the OpenAI-compatible endpoint, and that base stays there", async () => {
  await withEnv({ AI_API_URL: "https://api.anthropic.com/v1", AI_API_KEY: "k", AI_MODEL: "claude-x" }, () =>
    withFetch((s) => (s.url.endsWith("/messages")
      ? new Response('{"type":"error","error":{"type":"invalid_request_error","message":"system: Extra inputs are not permitted"}}', { status: 400 })
      : openai('{"ok":1}', { prompt_tokens: 10, completion_tokens: 2 })), async (sent) => {
      const { value, usage } = await collectUsage(() => completeJson([SYSTEM, GUIDE], "u", 50));
      assert.deepEqual(value, { ok: 1 });
      assert.deepEqual(sent.map((s) => s.url.split("/").pop()), ["messages", "completions"]);
      assert.deepEqual(sent[1].body.messages, [{ role: "system", content: `${SYSTEM}\n\n${GUIDE}` }, { role: "user", content: "u" }], "the blocks joined: the same text as one string");
      assert.equal(usage.length, 1, "the refused attempt consumed nothing and reports nothing");
      await completeJson([SYSTEM], "u", 50);
      assert.equal(sent[2].url.split("/").pop(), "completions", "remembered");
    }));
});

test("a refusal about the account or the size is NOT retried on the other endpoint", async () => {
  await withEnv({ AI_API_URL: "https://api.anthropic.com/v1", AI_API_KEY: "k", AI_MODEL: "claude-x" }, () =>
    withFetch(() => new Response('{"type":"error","error":{"type":"invalid_request_error","message":"Your credit balance is too low to access the Anthropic API."}}', { status: 400 }), async (sent) => {
      await assert.rejects(completeJson([SYSTEM], "u", 50), /quota or credit/);
      assert.equal(sent.length, 1);
    }));
  await withEnv({ AI_API_URL: "https://api.anthropic.com/v1", AI_API_KEY: "k", AI_MODEL: "claude-x" }, () =>
    withFetch(() => new Response('{"type":"error","error":{"type":"invalid_request_error","message":"prompt is too long: 210000 tokens > 200000 maximum"}}', { status: 400 }), async (sent) => {
      await assert.rejects(completeJson([SYSTEM], "u", 50), (e: { contextTooLong?: boolean }) => e.contextTooLong === true);
      assert.equal(sent.length, 1);
    }));
});

test("caching is opt-in per call: a plain-string system prompt is sent exactly as before; blocks or promptCache:true go native", async () => {
  await withEnv({ AI_API_URL: "https://api.anthropic.com/v1", AI_API_KEY: "k", AI_MODEL: "claude-x" }, () =>
    withFetch((s) => (s.url.endsWith("/messages") ? native('{"ok":1}', { input_tokens: 5, output_tokens: 2 }) : openai('{"ok":1}', { prompt_tokens: 10, completion_tokens: 2 })), async (sent) => {
      await completeJson(SYSTEM, "u", 50);
      await completeJson(SYSTEM, "u", 50, { promptCache: true });
      await completeJson([SYSTEM, GUIDE], "u", 50, { promptCache: false });
      assert.deepEqual(sent.map((s) => s.url.split("/").pop()), ["completions", "messages", "completions"]);
      assert.equal(sent[0].headers.authorization, "Bearer k", "the old request, untouched");
      assert.deepEqual(sent[1].body.system, [{ type: "text", text: SYSTEM, cache_control: { type: "ephemeral" } }]);
    }));
});

test("AI_PROMPT_CACHE=off: Anthropic through the OpenAI-compatible endpoint, as before", async () => {
  await withEnv({ AI_API_URL: "https://api.anthropic.com/v1", AI_API_KEY: "k", AI_MODEL: "claude-x", AI_PROMPT_CACHE: "off" }, () =>
    withFetch(() => openai('{"ok":1}', { prompt_tokens: 10, completion_tokens: 2 }), async (sent) => {
      await completeJson([SYSTEM, GUIDE], "u", 50);
      assert.equal(sent[0].url, "https://api.anthropic.com/v1/chat/completions");
      assert.equal(sent[0].headers.authorization, "Bearer k");
    }));
});

test("OpenAI-style: the stable blocks lead one system message, and cached_tokens reaches the usage", async () => {
  await withEnv({ AI_API_URL: "https://api.openai.example/v1", AI_API_KEY: "k", AI_MODEL: "gpt-4o-mini" }, () =>
    withFetch(() => openai('{"ok":1}', { prompt_tokens: 12000, completion_tokens: 900, prompt_tokens_details: { cached_tokens: 8064 } }), async (sent) => {
      const { usage } = await collectUsage(() => completeJson([SYSTEM, GUIDE], "variable", 50));
      assert.deepEqual((sent[0].body.messages as { role: string; content: string }[])[0], { role: "system", content: `${SYSTEM}\n\n${GUIDE}` });
      assert.deepEqual([usage[0].inputTokens, usage[0].cachedInputTokens, usage[0].cacheWriteTokens], [12000, 8064, undefined]);
    }));
});

test("a retried HTTP attempt is not reported: a call that recovers after two 500s reports ONE usage; a call that fails reports NONE", async () => {
  await withEnv({ AI_API_URL: "https://retry.example/v1", AI_API_KEY: "k", AI_MODEL: "m" }, () =>
    withFetch((_s, n) => (n <= 2 ? new Response("upstream error", { status: 500 }) : openai('{"ok":1}', { prompt_tokens: 100, completion_tokens: 3 })), async (sent) => {
      const { value, usage } = await collectUsage(() => completeJson("s", "u", 50, { retryDelayMs: 0 }));
      assert.deepEqual(value, { ok: 1 });
      assert.equal(sent.length, 3);
      assert.equal(usage.length, 1);
      assert.equal(sumUsage(usage).inputTokens, 100);
    }));
  await withEnv({ AI_API_URL: "https://down.example/v1", AI_API_KEY: "k", AI_MODEL: "m" }, () =>
    withFetch(() => new Response("upstream error", { status: 500 }), async (sent) => {
      const { usage } = await collectUsage(async () => { await assert.rejects(completeJson("s", "u", 50, { retries: 2, retryDelayMs: 0 }), /unavailable \(500\)/); return null; });
      assert.equal(sent.length, 3, "three attempts");
      assert.equal(usage.length, 0, "a failed call reports nothing to bill");
    }));
});

test("the fake provider takes the blocks too", async () => {
  await withEnv({ AI_API_URL: "fake:" }, async () => {
    const { value, usage } = await collectUsage(() => completeJson([SYSTEM, GUIDE], "u", 50));
    assert.deepEqual(value, {});
    assert.equal(usage[0].provider, "fake");
    assert.ok((usage[0].inputTokens ?? 0) > Math.ceil((SYSTEM.length + GUIDE.length) / 4));
  });
});

import test from "node:test";
import assert from "node:assert/strict";
import { SseDecoder, JsonTextExtractor, readAnthropicSse, readChatSse, fakeStreamText, streamError } from "./stream.js";
import { collectUsage, completeJson, isProviderError, resetNativeRefusals, resetOutputCeilings, resetProviderState, resetStreamRefusals, setProviderLogger } from "./index.js";

/**
 * STREAMED REPLIES (2026-10-18): the SSE readers, the partial-JSON text
 * extractor, the fake provider's stream, and `completeJson` streaming end to
 * end against a stubbed fetch — the text arrives in pieces, the parsed result
 * and the usage report (cache read / write tokens) are what the whole-response
 * path reports, failures inside a stream are ProviderErrors.
 */

const enc = new TextEncoder();
/** a byte stream of these pieces, each its own chunk (split anywhere, even inside a UTF-8 character) */
function bytes(pieces: (string | Uint8Array)[]): ReadableStream<Uint8Array> {
  return new ReadableStream({ start(c) { for (const p of pieces) c.enqueue(typeof p === "string" ? enc.encode(p) : p); c.close(); } });
}
/** split a string into chunks of n bytes (UTF-8), so characters are cut in half */
function byteChunks(s: string, n: number): Uint8Array[] {
  const b = enc.encode(s); const out: Uint8Array[] = [];
  for (let i = 0; i < b.length; i += n) out.push(b.slice(i, i + n));
  return out;
}
const sse = (events: { event?: string; data: unknown }[]) => events.map((e) => `${e.event ? `event: ${e.event}\n` : ""}data: ${typeof e.data === "string" ? e.data : JSON.stringify(e.data)}\n\n`).join("");

test("SseDecoder: LF, CRLF and CR line ends, lines split across chunks, multi-line data, comments, a last event without its blank line", () => {
  const d = new SseDecoder();
  const got = [...d.push("event: a\r"), ...d.push("\ndata: 1\r\n\r\n: comment\n"), ...d.push("data: x\ndata: y\n"), ...d.push("\nevent: b\rdata:2\r\r"), ...d.push("data: tail")];
  got.push(...d.end());
  assert.deepEqual(got, [{ event: "a", data: "1" }, { event: "message", data: "x\ny" }, { event: "b", data: "2" }, { event: "message", data: "tail" }]);
});

const ANTHROPIC_EVENTS = (text: string[], stop = "end_turn") => sse([
  { event: "message_start", data: { type: "message_start", message: { id: "msg_1", model: "claude-sonnet-4-6", usage: { input_tokens: 4000, cache_read_input_tokens: 8000, cache_creation_input_tokens: 362, output_tokens: 1 } } } },
  { event: "content_block_start", data: { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } } },
  { event: "ping", data: { type: "ping" } },
  ...text.map((t) => ({ event: "content_block_delta", data: { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: t } } })),
  { event: "content_block_stop", data: { type: "content_block_stop", index: 0 } },
  { event: "message_delta", data: { type: "message_delta", delta: { stop_reason: stop }, usage: { output_tokens: 2215 } } },
  { event: "message_stop", data: { type: "message_stop" } },
]);

test("readAnthropicSse: text deltas in order, the stop reason, the merged usage (input and cache counts from message_start, output from message_delta)", async () => {
  const deltas: string[] = [];
  const r = await readAnthropicSse(bytes(byteChunks(ANTHROPIC_EVENTS(['{"reply":"नमस्ते', ' 😀"}']), 7)), (d) => deltas.push(d));
  assert.equal(r.content, '{"reply":"नमस्ते 😀"}', "UTF-8 split across chunks is decoded whole");
  assert.deepEqual(deltas, ['{"reply":"नमस्ते', ' 😀"}']);
  assert.equal(r.complete, true); assert.equal(r.finish, "end_turn"); assert.equal(r.model, "claude-sonnet-4-6");
  assert.deepEqual(r.usage, { input_tokens: 4000, cache_read_input_tokens: 8000, cache_creation_input_tokens: 362, output_tokens: 2215 });
  const cut = await readAnthropicSse(bytes([ANTHROPIC_EVENTS(["{"], "max_tokens")]));
  assert.equal(cut.finish, "length", "max_tokens reads as length, as in a whole response");
});

test("readAnthropicSse: an error event and a stream cut off before message_stop", async () => {
  const err = await readAnthropicSse(bytes([sse([{ event: "message_start", data: { type: "message_start", message: { usage: { input_tokens: 5 } } } }, { event: "error", data: { type: "error", error: { type: "overloaded_error", message: "Overloaded" } } }])]));
  assert.deepEqual(err.error, { type: "overloaded_error", message: "Overloaded" });
  const pe = streamError(err.error, "api.anthropic.com");
  assert.equal(pe.kind, "overloaded"); assert.equal(pe.retryable, true);
  const cut = await readAnthropicSse(bytes([ANTHROPIC_EVENTS(['{"reply":"hal']).split("event: message_delta")[0]]));
  assert.equal(cut.complete, false); assert.equal(cut.content, '{"reply":"hal');
});

const CHAT_EVENTS = (text: string[], usage: Record<string, unknown> | null = { prompt_tokens: 12000, completion_tokens: 900, prompt_tokens_details: { cached_tokens: 8000 } }, done = true) => sse([
  { data: { id: "c1", model: "gpt-4o-mini", choices: [{ index: 0, delta: { role: "assistant", content: "" } }] } },
  ...text.map((t) => ({ data: { id: "c1", model: "gpt-4o-mini", choices: [{ index: 0, delta: { content: t }, finish_reason: null }] } })),
  { data: { id: "c1", model: "gpt-4o-mini", choices: [{ index: 0, delta: {}, finish_reason: "stop" }] } },
  ...(usage ? [{ data: { id: "c1", model: "gpt-4o-mini", choices: [], usage } }] : []),
  ...(done ? [{ data: "[DONE]" }] : []),
]);

test("readChatSse: deltas, the finish reason, the usage chunk (cached tokens), [DONE]; an error line; a stream without a finish", async () => {
  const deltas: string[] = [];
  const r = await readChatSse(bytes(byteChunks(CHAT_EVENTS(['{"a":', '1}']), 5)), (d) => deltas.push(d));
  assert.equal(r.content, '{"a":1}'); assert.deepEqual(deltas, ['{"a":', "1}"]);
  assert.equal(r.finish, "stop"); assert.equal(r.complete, true); assert.equal(r.model, "gpt-4o-mini");
  assert.deepEqual(r.usage, { prompt_tokens: 12000, completion_tokens: 900, prompt_tokens_details: { cached_tokens: 8000 } });
  const er = await readChatSse(bytes([sse([{ data: { error: { message: "Rate limit reached", type: "rate_limit_error" } } }])]));
  assert.equal(streamError(er.error).kind, "rate_limited");
  const cut = await readChatSse(bytes([sse([{ data: { choices: [{ delta: { content: '{"re' } }] } }])]));
  assert.equal(cut.complete, false);
});

test("JsonTextExtractor: the reply field only, decoded as it arrives — escapes, \\u escapes and surrogate pairs split across chunks, Devanagari, nested objects ignored", () => {
  const json = JSON.stringify({ kind: "proposal", actions: [{ op: "x", reply: "NOT THIS" }], reply: 'Line one\nशब्द "quoted" \\ 😀 done', memory: "m" }).replace("😀", "\\ud83d\\ude00");
  for (const n of [1, 2, 3, 5, 7, 1000]) {
    const pieces: string[] = [];
    const x = new JsonTextExtractor(["reply"], (d) => pieces.push(d));
    for (let i = 0; i < json.length; i += n) x.push(json.slice(i, i + n));
    assert.equal(x.text, 'Line one\nशब्द "quoted" \\ 😀 done', `chunk ${n}`);
    assert.ok(pieces.every((p) => !/[\ud800-\udbff]$/.test(p)), "never ends a delta on half a surrogate pair");
  }
  /* a raw (unescaped) emoji split between chunks */
  const raw = '{"reply":"a😀b"}';
  const x = new JsonTextExtractor(["reply"], () => {});
  for (const ch of raw.split("")) x.push(ch);
  assert.equal(x.text, "a😀b");
});

test("JsonTextExtractor: prose or a code fence before the object, a plan's summary, nothing past the object, nonsense yields nothing", () => {
  const got: [string, string][] = [];
  const x = new JsonTextExtractor(["summary", "reply"], (d, f) => got.push([d, f]));
  x.push('Here you go:\n```json\n{"kind":"plan","items":[{"title":"A","summary":"no"}],"summary":"Build the scr');
  x.push('eener first","questions":[]}\n```\n{"summary":"ignored"}');
  assert.equal(x.text, "Build the screener first");
  assert.ok(got.every(([, f]) => f === "summary"));
  const y = new JsonTextExtractor(["reply"], () => {});
  y.push("I cannot answer that in JSON. \\u00 }{ \"");
  assert.equal(y.text, "");
  const z = new JsonTextExtractor(["reply"], () => {});
  z.push('{"reply" : "a\\');
  z.push('u00e9\\');
  z.push('nb"}');
  assert.equal(z.text, "aé\nb", "an escape split at every point");
});

test("fakeStreamText: chunks, a pause, a failure part-way as a ProviderError", async () => {
  const pieces: string[] = [];
  const t0 = Date.now();
  assert.equal(await fakeStreamText({ text: "abcdefghij", chunkChars: 3, delayMs: 10 }, (d) => pieces.push(d)), "abcdefghij");
  assert.deepEqual(pieces, ["abc", "def", "ghi", "j"]);
  assert.ok(Date.now() - t0 >= 35);
  const got: string[] = [];
  await assert.rejects(fakeStreamText({ text: "abcdefghij", chunkChars: 4, failAfterChars: 6 }, (d) => got.push(d)), (e) => isProviderError(e) && e.kind === "network" && e.retryable);
  assert.deepEqual(got, ["abcd", "ef"]);
});

/* ------------------------------------------------------------ completeJson, streamed, against a stubbed fetch */

const KEYS = ["AI_API_URL", "AI_API_KEY", "AI_MODEL", "AI_PROMPT_CACHE", "AI_FALLBACK_API_URL", "AI_FALLBACK_API_KEY", "AI_FALLBACK_MODEL"];
async function withEnv(env: Record<string, string>, fn: () => Promise<void>) {
  const saved = Object.fromEntries(KEYS.map((k) => [k, process.env[k]]));
  try { for (const k of KEYS) delete process.env[k]; Object.assign(process.env, env); await fn(); }
  finally { for (const k of KEYS) { delete process.env[k]; if (saved[k] !== undefined) process.env[k] = saved[k]; } }
}
type Sent = { url: string; body: Record<string, unknown> };
async function withFetch(reply: (s: Sent, n: number) => Response, fn: (sent: Sent[]) => Promise<void>) {
  const sent: Sent[] = [];
  const real = globalThis.fetch;
  globalThis.fetch = (async (url: string, init: { body: string }) => { const s = { url: String(url), body: JSON.parse(init.body) }; sent.push(s); return reply(s, sent.length); }) as never;
  resetProviderState(); resetNativeRefusals(); resetOutputCeilings(); resetStreamRefusals();
  setProviderLogger(() => {});
  try { await fn(sent); } finally { globalThis.fetch = real; setProviderLogger(null); resetStreamRefusals(); }
}
const stream = (body: string) => new Response(bytes(byteChunks(body, 11)), { status: 200, headers: { "content-type": "text/event-stream; charset=utf-8" } });
const REPLY = { kind: "answer", reply: "Here is the plan — नमस्ते", actions: [] };

test("completeJson streams from Anthropic natively: stream flag + cache_control kept, deltas, the parsed object, the same usage report (cache read/write) as a whole response", async () => {
  await withEnv({ AI_API_URL: "https://api.anthropic.com/v1", AI_API_KEY: "k", AI_MODEL: "claude-sonnet-4-6" }, async () => {
    const text = JSON.stringify(REPLY);
    await withFetch(() => stream(ANTHROPIC_EVENTS([text.slice(0, 20), text.slice(20)])), async (sent) => {
      const deltas: string[] = [];
      const { value, usage } = await collectUsage(() => completeJson(["SYSTEM", "GUIDE"], "u", 500, { onText: (d) => deltas.push(d) }));
      assert.deepEqual(value, REPLY);
      assert.equal(deltas.join(""), text);
      assert.equal(sent[0].url, "https://api.anthropic.com/v1/messages");
      assert.equal(sent[0].body.stream, true);
      assert.deepEqual((sent[0].body.system as { cache_control?: unknown }[]).map((b) => b.cache_control), [{ type: "ephemeral" }, { type: "ephemeral" }], "prompt caching preserved");
      assert.equal(usage.length, 1);
      assert.equal(usage[0].inputTokens, 12362); assert.equal(usage[0].outputTokens, 2215);
      assert.equal(usage[0].cachedInputTokens, 8000); assert.equal(usage[0].cacheWriteTokens, 362);
      assert.equal(usage[0].estimated, false); assert.equal(usage[0].model, "claude-sonnet-4-6");
    });
    /* without onText: exactly the old request (no stream flag) */
    await withFetch(() => new Response(JSON.stringify({ content: [{ type: "text", text }], stop_reason: "end_turn", usage: { input_tokens: 1, output_tokens: 1 } }), { status: 200 }), async (sent) => {
      assert.deepEqual(await completeJson(["SYSTEM"], "u", 500), REPLY);
      assert.equal("stream" in sent[0].body, false);
    });
  });
});

test("completeJson streams from an OpenAI-compatible API: stream + include_usage, cached tokens reported; a continuation streams too", async () => {
  await withEnv({ AI_API_URL: "https://api.openai.com/v1", AI_API_KEY: "k", AI_MODEL: "gpt-4o-mini" }, async () => {
    const text = JSON.stringify(REPLY);
    const half = Math.floor(text.length / 2);
    await withFetch((_s, n) => {
      if (n === 1) return stream(sse([{ data: { choices: [{ delta: { content: text.slice(0, half) } }] } }, { data: { choices: [{ delta: {}, finish_reason: "length" }] } }, { data: { choices: [], usage: { prompt_tokens: 100, completion_tokens: 10, prompt_tokens_details: { cached_tokens: 64 } } } }, { data: "[DONE]" }]));
      return stream(CHAT_EVENTS([text.slice(half)], { prompt_tokens: 120, completion_tokens: 12, prompt_tokens_details: { cached_tokens: 64 } }));
    }, async (sent) => {
      const deltas: string[] = [];
      const { value, usage } = await collectUsage(() => completeJson(["SYSTEM"], "u", 500, { onText: (d) => deltas.push(d) }));
      assert.deepEqual(value, REPLY);
      assert.equal(deltas.join(""), text, "both calls' text, in order");
      assert.equal(sent.length, 2);
      assert.equal(sent[0].body.stream, true);
      assert.deepEqual(sent[0].body.stream_options, { include_usage: true });
      assert.deepEqual(usage.map((u) => [u.inputTokens, u.outputTokens, u.cachedInputTokens]), [[100, 10, 64], [120, 12, 64]]);
    });
  });
});

test("completeJson: a provider that refuses streaming is asked again whole (and remembered); one that ignores the flag answers whole; an in-stream error and a cut-off stream fail as ProviderErrors with no usage", async () => {
  await withEnv({ AI_API_URL: "https://gw.example/v1", AI_API_KEY: "k", AI_MODEL: "m" }, async () => {
    const text = JSON.stringify(REPLY);
    const whole = () => new Response(JSON.stringify({ choices: [{ message: { content: text }, finish_reason: "stop" }], usage: { prompt_tokens: 5, completion_tokens: 2 } }), { status: 200 });
    await withFetch((s) => (s.body.stream ? new Response(JSON.stringify({ error: { message: "Unrecognized request argument supplied: stream_options" } }), { status: 400 }) : whole()), async (sent) => {
      const deltas: string[] = [];
      assert.deepEqual(await completeJson(["S"], "u", 100, { onText: (d) => deltas.push(d) }), REPLY);
      assert.equal(deltas.join(""), text, "the whole answer is still handed over");
      assert.deepEqual(sent.map((x) => !!x.body.stream), [true, false]);
      await completeJson(["S"], "u", 100, { onText: () => {} });
      assert.equal(sent.at(-1)!.body.stream, undefined, "not asked to stream again");
    });
    await withFetch(() => whole(), async () => {
      const deltas: string[] = [];
      assert.deepEqual(await completeJson(["S"], "u", 100, { onText: (d) => deltas.push(d) }), REPLY);
      assert.equal(deltas.join(""), text);
    });
    await withFetch(() => stream(sse([{ data: { choices: [{ delta: { content: '{"reply":"x' } }] } }, { data: { error: { type: "server_error", message: "boom" } } }])), async () => {
      const { usage } = await collectUsage(() => assert.rejects(completeJson(["S"], "u", 100, { onText: () => {} }), (e) => isProviderError(e) && e.kind === "server"));
      assert.equal(usage.length, 0, "a failed call reports nothing");
    });
    await withFetch(() => stream(sse([{ data: { choices: [{ delta: { content: '{"reply":"x' } }] } }])), async () => {
      await assert.rejects(completeJson(["S"], "u", 100, { onText: () => {} }), (e) => isProviderError(e) && e.kind === "network" && e.retryable);
    });
  });
});

test("completeJson with the fake provider streams only when scripted, and returns the scripted object", async () => {
  await withEnv({ AI_API_URL: "fake:" }, async () => {
    assert.deepEqual(await completeJson("s", "u", 10, { onText: () => assert.fail("no stream unless scripted") }), {});
    const deltas: string[] = [];
    assert.deepEqual(await completeJson("s", "u", 10, { onText: (d) => deltas.push(d), fakeStream: { text: JSON.stringify(REPLY), chunkChars: 8 } }), REPLY);
    assert.equal(deltas.join(""), JSON.stringify(REPLY)); assert.ok(deltas.length > 3);
    assert.deepEqual(await completeJson("s", "u", 10, { fakeStream: { delayMs: 5 } }), {}, "a pause alone: the empty object, as before");
  });
});

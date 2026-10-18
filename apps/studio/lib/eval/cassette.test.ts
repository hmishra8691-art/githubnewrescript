import { test } from "node:test";
import assert from "node:assert/strict";
import { completeJson, collectUsage, resetNativeRefusals, resetProviderState, setProviderLogger } from "@rescript/ai";
import { CassettePlayer, CassetteRecorder, normalizeAnswer, synthesize, type CassetteExchange } from "./cassette.ts";

/* cassettes: record a provider's answers normalised, replay them in whatever shape the request asks for — whole or streamed, chat or Messages */
const X: CassetteExchange = { path: "chat", status: 200, content: "{\"kind\":\"answer\",\"reply\":\"ok\",\"actions\":[]}", finish: "stop", usage: { prompt_tokens: 9000, completion_tokens: 40, prompt_tokens_details: { cached_tokens: 4096 } }, model: "gpt-x", latencyMs: 1200 };

test("normalise and synthesise round-trip: chat JSON, chat SSE, Messages JSON, Messages SSE", async () => {
  for (const path of ["chat", "messages"] as const) for (const stream of [false, true]) {
    const usage = path === "messages" ? { input_tokens: 500, cache_read_input_tokens: 8000, cache_creation_input_tokens: 0, output_tokens: 40 } : X.usage;
    const res = synthesize({ ...X, path, usage }, { path, stream });
    const back = await normalizeAnswer(path, res.status, res.headers.get("content-type") ?? "", await res.text());
    assert.equal(back.content, X.content, `${path} ${stream ? "SSE" : "JSON"}`);
    assert.equal(back.finish === "end_turn" ? "stop" : back.finish, "stop");
    if (path === "messages") assert.equal((back.usage as { cache_read_input_tokens?: number }).cache_read_input_tokens, 8000);
    else assert.deepEqual(back.usage, X.usage);
  }
  const cut = synthesize({ ...X, path: "messages", finish: "length" }, { path: "messages", stream: false });
  assert.equal((await cut.json()).stop_reason, "max_tokens", "a cut-off answer replays as cut off");
  const err = synthesize({ ...X, status: 429, errorBody: "{\"error\":\"rate\"}" }, { path: "chat", stream: false });
  assert.equal(err.status, 429);
});

test("record → replay through the real provider client: same reply, same usage (cache read included), no network on replay", async () => {
  const saved = { url: process.env.AI_API_URL, key: process.env.AI_API_KEY, model: process.env.AI_MODEL };
  const real = globalThis.fetch;
  process.env.AI_API_URL = "https://provider.example/v1"; process.env.AI_API_KEY = "k-test"; process.env.AI_MODEL = "gpt-x";
  resetProviderState(); resetNativeRefusals(); setProviderLogger(() => {});
  try {
    const rec = new CassetteRecorder({ base: "https://provider.example/v1", model: "gpt-x" });
    globalThis.fetch = rec.wrap((async () => new Response(JSON.stringify({ choices: [{ message: { content: X.content }, finish_reason: "stop" }], usage: X.usage, model: "gpt-x" }), { status: 200, headers: { "content-type": "application/json" } })) as typeof fetch);
    rec.begin("case-1", 0);
    const live = await collectUsage(() => completeJson("system", "user", 200, { timeoutMs: 5000 }));
    rec.end(1500);
    assert.equal(rec.cassette.cases["case-1"].turns[0].exchanges.length, 1);
    assert.equal(JSON.stringify(rec.cassette).includes("k-test"), false, "the key is never recorded");
    const player = new CassettePlayer(JSON.parse(JSON.stringify(rec.cassette)));
    globalThis.fetch = player.wrap((async () => { throw new Error("network on replay"); }) as typeof fetch);
    player.begin("case-1", 0);
    const replay = await collectUsage(() => completeJson("system", "user", 200, { timeoutMs: 5000 }));
    assert.deepEqual(replay.value, live.value);
    assert.equal(replay.usage[0].cachedInputTokens, 4096); assert.equal(replay.usage[0].inputTokens, 9000);
    assert.equal(player.turnLatency("case-1", 0), 1500);
    /* a request with no recorded answer fails, it is not invented */
    player.begin("case-1", 0);
    await completeJson("system", "user", 200, { timeoutMs: 5000 });
    await assert.rejects(() => completeJson("system", "user", 200, { timeoutMs: 5000, retries: 0 }));
    assert.ok(player.misses.length >= 1);
  } finally {
    globalThis.fetch = real; setProviderLogger(null);
    for (const [k, v] of [["AI_API_URL", saved.url], ["AI_API_KEY", saved.key], ["AI_MODEL", saved.model]] as const) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  }
});

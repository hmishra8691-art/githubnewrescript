import test from "node:test";
import assert from "node:assert/strict";
import { acceptsJsonMode, classify, completeJson } from "./index.js";

/**
 * "response_format.type: Input should be 'json_schema'" — Anthropic's
 * OpenAI-compatible endpoint refuses `response_format: json_object` with a
 * 400. JSON mode is not sent to Anthropic; any other provider that refuses it
 * is asked again without it, once, and the reply is read either way.
 */
const KEYS = ["AI_API_URL", "AI_API_KEY", "AI_MODEL", "AI_WORKSPACE_ID", "AI_API_HEADERS"];
async function withEnv(env: Record<string, string>, fn: () => Promise<void>) {
  const saved = Object.fromEntries(KEYS.map((k) => [k, process.env[k]]));
  try { for (const k of KEYS) delete process.env[k]; Object.assign(process.env, env); await fn(); }
  finally { for (const k of KEYS) { delete process.env[k]; if (saved[k] !== undefined) process.env[k] = saved[k]; } }
}
type Sent = { url: string; body: Record<string, unknown> };
async function withFetch(reply: (b: Record<string, unknown>, n: number) => Response, fn: (sent: Sent[]) => Promise<void>) {
  const sent: Sent[] = [];
  const real = globalThis.fetch;
  globalThis.fetch = (async (url: string, init: { body: string }) => {
    const body = JSON.parse(init.body);
    sent.push({ url, body });
    return reply(body, sent.length);
  }) as never;
  try { await fn(sent); } finally { globalThis.fetch = real; }
}
const ok = (content: string) => new Response(JSON.stringify({ choices: [{ message: { content } }], usage: { prompt_tokens: 1, completion_tokens: 1 } }), { status: 200 });

test("Anthropic is never sent response_format, and a reply wrapped in prose is still read", async () => {
  assert.equal(acceptsJsonMode("https://api.anthropic.com/v1"), false);
  assert.equal(acceptsJsonMode("https://api.openai.com/v1"), true);
  assert.equal(acceptsJsonMode("https://notanthropic.com.example/v1"), true, "the host, not a substring");
  await withEnv({ AI_API_URL: "https://api.anthropic.com/v1", AI_API_KEY: "k", AI_MODEL: "claude-x" }, () =>
    withFetch(() => ok('Here is the plan:\n{"ok": true, "n": 2}'), async (sent) => {
      assert.deepEqual(await completeJson("s", "u", 10), { ok: true, n: 2 });
      assert.equal(sent.length, 1);
      assert.equal("response_format" in sent[0].body, false);
      assert.equal(sent[0].body.model, "claude-x");
      assert.deepEqual((sent[0].body.messages as unknown[]).length, 2, "everything else is unchanged");
    }));
});

test("a provider that refuses json mode is asked once more without it, and not sent it again", async () => {
  const refuse = () => new Response('{"error":{"message":"response_format.type: Input should be \'json_schema\'"}}', { status: 400 });
  await withEnv({ AI_API_URL: "https://gateway.example/v1", AI_API_KEY: "k" }, () =>
    withFetch((b) => ("response_format" in b ? refuse() : ok('{"label":"Price"}')), async (sent) => {
      assert.deepEqual(await completeJson("s", "u", 10), { label: "Price" });
      assert.deepEqual(sent.map((x) => "response_format" in x.body), [true, false]);
      assert.equal(await classify("too expensive", ["Price", "Taste"]), "Price", "the other request path too");
      assert.deepEqual(sent.map((x) => "response_format" in x.body), [true, false, false], "remembered: no second refusal");
    }));
});

test("other refusals are reported, not retried", async () => {
  await withEnv({ AI_API_URL: "https://other.example/v1", AI_API_KEY: "k" }, () =>
    withFetch(() => new Response('{"error":{"message":"model not found"}}', { status: 400 }), async (sent) => {
      await assert.rejects(completeJson("s", "u", 10), /refused the request \(400\).*model not found/);
      assert.equal(sent.length, 1);
    }));
  await withEnv({ AI_API_URL: "https://down.example/v1", AI_API_KEY: "k" }, () =>
    withFetch(() => new Response("upstream error while applying response_format", { status: 500 }), async (sent) => {
      await assert.rejects(completeJson("s", "u", 10), /\(500\)/);
      assert.equal(sent.length, 1, "an outage is not a json-mode refusal");
    }));
  await withEnv({ AI_API_URL: "https://openai.example/v1", AI_API_KEY: "k" }, () =>
    withFetch(() => ok('{"ok":1}'), async (sent) => {
      await completeJson("s", "u", 10);
      assert.deepEqual(sent[0].body.response_format, { type: "json_object" }, "providers that have json mode keep it");
    }));
});

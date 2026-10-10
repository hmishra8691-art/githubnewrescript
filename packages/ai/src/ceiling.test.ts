import test from "node:test";
import assert from "node:assert/strict";
import { completeJson, outputCeilingFrom, resetOutputCeilings } from "./index.js";

/**
 * THE OUTPUT LIMIT IS THE PROVIDER'S (Research Engine audit, Phase 7).
 * The Studio asks for as much output as an answer needs; a provider that
 * refuses the number names its ceiling, and the call is sent again at that
 * ceiling — once, remembered for the next call — instead of failing.
 */
const KEYS = ["AI_API_URL", "AI_API_KEY", "AI_MODEL", "AI_MODEL_SMALL", "AI_WORKSPACE_ID", "AI_API_HEADERS"];
async function withEnv(env: Record<string, string>, fn: () => Promise<void>) {
  const saved = Object.fromEntries(KEYS.map((k) => [k, process.env[k]]));
  try { for (const k of KEYS) delete process.env[k]; Object.assign(process.env, env); await fn(); }
  finally { for (const k of KEYS) { delete process.env[k]; if (saved[k] !== undefined) process.env[k] = saved[k]; } }
}
const ok = (content: string) => new Response(JSON.stringify({ choices: [{ message: { content }, finish_reason: "stop" }], usage: { prompt_tokens: 1, completion_tokens: 1 } }), { status: 200 });

test("outputCeilingFrom reads the ceiling a refusal names, below what was asked", () => {
  assert.equal(outputCeilingFrom("max_tokens is too large: 32000. This model supports at most 16384 completion tokens, whereas you provided 32000.", 32000), 16384);
  assert.equal(outputCeilingFrom("max_tokens: 32000 > 8192, which is the maximum allowed number of output tokens for claude-x", 32000), 8192);
  assert.equal(outputCeilingFrom("Invalid request: max_completion_tokens must be at most 4096", 32000), 4096);
  assert.equal(outputCeilingFrom("model not found", 32000), null, "not about the limit");
  assert.equal(outputCeilingFrom("max_tokens must be a positive integer", 32000), null, "no smaller number");
  assert.equal(outputCeilingFrom("max_tokens: 100 > 8192", 100), null, "nothing below what was asked");
});

test("completeJson lowers max_tokens to the provider's ceiling once and remembers it", async () => {
  resetOutputCeilings();
  const sent: number[] = [];
  const real = globalThis.fetch;
  globalThis.fetch = (async (_url: string, init: { body: string }) => {
    const b = JSON.parse(init.body);
    sent.push(b.max_tokens);
    if (b.max_tokens > 16384) return new Response(JSON.stringify({ error: { message: `max_tokens is too large: ${b.max_tokens}. This model supports at most 16384 completion tokens, whereas you provided ${b.max_tokens}.` } }), { status: 400 });
    return ok("{\"a\":1}");
  }) as never;
  try {
    await withEnv({ AI_API_URL: "https://ceiling.test/v1", AI_API_KEY: "k", AI_MODEL: "m" }, async () => {
      assert.deepEqual(await completeJson("s", "u", 32000), { a: 1 });
      assert.deepEqual(await completeJson("s", "u", 32000), { a: 1 });
      assert.deepEqual(await completeJson("s", "u", 500), { a: 1 }, "a smaller ask is sent as asked");
    });
    assert.deepEqual(sent, [32000, 16384, 16384, 500]);
  } finally { globalThis.fetch = real; resetOutputCeilings(); }
});

test("a refusal that is not about the limit is still a refusal", async () => {
  resetOutputCeilings();
  const real = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = (async () => { calls++; return new Response(JSON.stringify({ error: { message: "model not found" } }), { status: 404 }); }) as never;
  try {
    await withEnv({ AI_API_URL: "https://ceiling2.test/v1", AI_API_KEY: "k", AI_MODEL: "m" }, async () => {
      await assert.rejects(() => completeJson("s", "u", 32000), /refused the request \(404\) .*model not found/);
    });
    assert.equal(calls, 1);
  } finally { globalThis.fetch = real; }
});

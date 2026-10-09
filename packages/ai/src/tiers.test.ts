import test from "node:test";
import assert from "node:assert/strict";
import { aiModelName, completeJson } from "./index.js";

/**
 * MODEL TIERS (Research Engine audit, Phase 6). A short structuring call
 * goes to the small model (AI_MODEL_SMALL) when one is configured; drafting
 * goes to the large one (AI_MODEL). Without a small model configured, the
 * small tier is the large model — never nothing.
 */
const KEYS = ["AI_API_URL", "AI_API_KEY", "AI_MODEL", "AI_MODEL_SMALL", "AI_WORKSPACE_ID", "AI_API_HEADERS"];
async function withEnv(env: Record<string, string>, fn: () => Promise<void>) {
  const saved = Object.fromEntries(KEYS.map((k) => [k, process.env[k]]));
  try { for (const k of KEYS) delete process.env[k]; Object.assign(process.env, env); await fn(); }
  finally { for (const k of KEYS) { delete process.env[k]; if (saved[k] !== undefined) process.env[k] = saved[k]; } }
}

test("aiModelName by tier: the small model when configured, else the large one; the default when neither", async () => {
  await withEnv({ AI_MODEL: "big-model", AI_MODEL_SMALL: "tiny-model" }, async () => {
    assert.equal(aiModelName(), "big-model");
    assert.equal(aiModelName("large"), "big-model");
    assert.equal(aiModelName("small"), "tiny-model");
  });
  await withEnv({ AI_MODEL: "big-model" }, async () => {
    assert.equal(aiModelName("small"), "big-model");
  });
  await withEnv({ AI_MODEL_SMALL: "  " }, async () => {
    assert.equal(aiModelName("small"), "gpt-4o-mini");
    assert.equal(aiModelName("large"), "gpt-4o-mini");
  });
});

test("completeJson sends the tier's model", async () => {
  const sent: Record<string, unknown>[] = [];
  const real = globalThis.fetch;
  globalThis.fetch = (async (_url: string, init: { body: string }) => {
    sent.push(JSON.parse(init.body));
    return new Response(JSON.stringify({ choices: [{ message: { content: "{\"a\":1}" }, finish_reason: "stop" }], usage: { prompt_tokens: 1, completion_tokens: 1 } }), { status: 200 });
  }) as never;
  try {
    await withEnv({ AI_API_URL: "https://example.test/v1", AI_API_KEY: "k", AI_MODEL: "big-model", AI_MODEL_SMALL: "tiny-model" }, async () => {
      assert.deepEqual(await completeJson("s", "u", 50, { tier: "small" }), { a: 1 });
      assert.deepEqual(await completeJson("s", "u", 50), { a: 1 });
      assert.deepEqual(await completeJson("s", "u", 50, { tier: "large" }), { a: 1 });
    });
    assert.deepEqual(sent.map((b) => b.model), ["tiny-model", "big-model", "big-model"]);
  } finally { globalThis.fetch = real; }
});

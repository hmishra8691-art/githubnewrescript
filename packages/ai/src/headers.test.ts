import test from "node:test";
import assert from "node:assert/strict";
import { aiExtraHeaders, completeJson } from "./index.js";

/**
 * "This API key is not scoped to a workspace, so this request must include
 * the anthropic-workspace-id header" — a real refusal from an installation
 * pointed at Anthropic's OpenAI-compatible API with an organisation-level
 * key. AI_WORKSPACE_ID names the workspace on every request; AI_API_HEADERS
 * carries anything else a provider needs.
 */
const KEYS = ["AI_API_URL", "AI_API_KEY", "AI_MODEL", "AI_WORKSPACE_ID", "AI_API_HEADERS"];
async function withEnv(env: Record<string, string>, fn: () => Promise<void> | void) {
  const saved = Object.fromEntries(KEYS.map((k) => [k, process.env[k]]));
  try {
    for (const k of KEYS) delete process.env[k];
    Object.assign(process.env, env);
    await fn();
  } finally {
    for (const k of KEYS) { delete process.env[k]; if (saved[k] !== undefined) process.env[k] = saved[k]; }
  }
}

test("AI_WORKSPACE_ID becomes the anthropic-workspace-id header; AI_API_HEADERS adds others, safely", async () => {
  await withEnv({}, () => assert.deepEqual(aiExtraHeaders(), {}, "nothing configured, nothing sent"));
  await withEnv({ AI_WORKSPACE_ID: " wrkspc_01ABC " }, () => assert.deepEqual(aiExtraHeaders(), { "anthropic-workspace-id": "wrkspc_01ABC" }));
  await withEnv({ AI_API_HEADERS: '{"OpenAI-Organization":"org_1","Authorization":"Bearer stolen","content-type":"text/plain","bad header":"x","n":2}' }, () =>
    assert.deepEqual(aiExtraHeaders(), { "openai-organization": "org_1", n: "2" }, "the key and the body type cannot be overridden; invalid names are dropped"));
  await withEnv({ AI_API_HEADERS: "{not json" }, () => assert.deepEqual(aiExtraHeaders(), {}, "invalid JSON is ignored, not half-sent"));
});

test("every model request carries them, next to the key", async () => {
  const seen: Record<string, string>[] = [];
  const real = globalThis.fetch;
  globalThis.fetch = (async (_url: string, init: { headers: Record<string, string> }) => {
    seen.push(init.headers);
    return new Response(JSON.stringify({ choices: [{ message: { content: '{"ok":true}' } }], usage: { prompt_tokens: 1, completion_tokens: 1 } }), { status: 200, headers: { "content-type": "application/json" } });
  }) as never;
  try {
    await withEnv({ AI_API_URL: "https://api.anthropic.com/v1", AI_API_KEY: "sk-test", AI_MODEL: "claude-x", AI_WORKSPACE_ID: "wrkspc_01ABC" }, async () => {
      assert.deepEqual(await completeJson("s", "u", 10), { ok: true });
    });
  } finally { globalThis.fetch = real; }
  assert.equal(seen[0]["anthropic-workspace-id"], "wrkspc_01ABC");
  assert.equal(seen[0].authorization, "Bearer sk-test");
  assert.equal(seen[0]["content-type"], "application/json");
});

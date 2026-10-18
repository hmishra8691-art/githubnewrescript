import test from "node:test";
import assert from "node:assert/strict";
import { collectUsage, completeJson, resetNativeRefusals, resetOutputCeilings, resetProviderState, setProviderLogger, sumUsage, type AiUsage } from "./index.js";

/*
 * §3 MEASUREMENT (2026-10-18): each provider request reports its latency with its usage, totals sum it,
 * and a THIRD system block (the copilot's research context) is a cache breakpoint like the first two.
 */

const KEYS = ["AI_API_URL", "AI_API_KEY", "AI_MODEL", "AI_PROMPT_CACHE", "AI_FALLBACK_API_URL"];
async function withEnv(env: Record<string, string>, fn: () => Promise<void>) {
  const saved = Object.fromEntries(KEYS.map((k) => [k, process.env[k]]));
  try { for (const k of KEYS) delete process.env[k]; Object.assign(process.env, env); await fn(); }
  finally { for (const k of KEYS) { delete process.env[k]; if (saved[k] !== undefined) process.env[k] = saved[k]; } }
}
async function withFetch(reply: () => Response, fn: (bodies: Record<string, unknown>[]) => Promise<void>) {
  const bodies: Record<string, unknown>[] = [];
  const real = globalThis.fetch;
  globalThis.fetch = (async (_url: string, init: { body: string }) => { bodies.push(JSON.parse(init.body)); await new Promise((r) => setTimeout(r, 15)); return reply(); }) as never;
  resetProviderState(); resetNativeRefusals(); resetOutputCeilings(); setProviderLogger(() => {});
  try { await fn(bodies); } finally { globalThis.fetch = real; setProviderLogger(null); resetNativeRefusals(); }
}

test("a request reports its latency; three system blocks are three cache breakpoints; totals sum latency", async () => {
  await withEnv({ AI_API_URL: "https://api.anthropic.com/v1", AI_API_KEY: "k", AI_MODEL: "claude-sonnet-4-6" }, () =>
    withFetch(() => new Response(JSON.stringify({ type: "message", model: "claude-sonnet-4-6", content: [{ type: "text", text: '{"ok":true}' }], stop_reason: "end_turn", usage: { input_tokens: 100, output_tokens: 5, cache_read_input_tokens: 900 } }), { status: 200 }), async (bodies) => {
      const { usage } = await collectUsage(() => completeJson(["SYSTEM".repeat(10), "GUIDES".repeat(10), "RESEARCH CONTEXT v1".repeat(5)], "variable", 1000));
      assert.equal((bodies[0].system as { cache_control?: unknown }[]).filter((b) => b.cache_control).length, 3);
      assert.equal(usage.length, 1);
      assert.equal(typeof usage[0].latencyMs, "number");
      assert.ok(usage[0].latencyMs! >= 10, `latency ${usage[0].latencyMs}`);
      assert.equal(usage[0].cachedInputTokens, 900);
    }));
  const list: AiUsage[] = [{ kind: "chat", provider: "x", model: "m", inputTokens: 1, outputTokens: 1, requests: 1, estimated: false, latencyMs: 120 }, { kind: "chat", provider: "x", model: "m", inputTokens: 1, outputTokens: 1, requests: 1, estimated: false, latencyMs: 80 }, { kind: "chat", provider: "x", model: "m", requests: 1, estimated: true }];
  assert.equal(sumUsage(list).latencyMs, 200);
});

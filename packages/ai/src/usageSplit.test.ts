import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { chatUsageUnits, classify, collectUsage, ocrImage, resetNativeRefusals, resetProviderState, setProviderLogger, type AiUsage } from "./index.js";

/**
 * THE CACHE SPLIT ON EVERY AI PATH (2026-10-18). The copilot's `completeJson`
 * read the provider's cached / written input since the cost audit; the
 * respondent-side helpers (`classify`, `sentiment`, probes, rephrasing — all
 * through `complete`) and OCR did not, so a provider that caches a long prefix
 * by itself (OpenAI) was billed for those tokens at the full input rate and the
 * usage event said nothing was cached. And the runtime's and Interviews' meters
 * each kept their own copy of the token fields without the split. One function
 * now builds those fields for every producer.
 */
const KEYS = ["AI_API_URL", "AI_API_KEY", "AI_MODEL", "AI_VISION_MODEL", "AI_FALLBACK_API_URL"];
async function withProvider(usage: Record<string, unknown>, content: string, fn: () => Promise<void>) {
  const saved = Object.fromEntries(KEYS.map((k) => [k, process.env[k]]));
  const real = globalThis.fetch;
  for (const k of KEYS) delete process.env[k];
  Object.assign(process.env, { AI_API_URL: "https://api.openai.example/v1", AI_API_KEY: "test-key", AI_MODEL: "gpt-4o-mini" });
  globalThis.fetch = (async () => new Response(JSON.stringify({ choices: [{ message: { content }, finish_reason: "stop" }], usage, model: "gpt-4o-mini" }), { status: 200 })) as never;
  resetProviderState(); resetNativeRefusals(); setProviderLogger(() => {});
  try { await fn(); } finally {
    globalThis.fetch = real; setProviderLogger(null);
    for (const k of KEYS) { delete process.env[k]; if (saved[k] !== undefined) process.env[k] = saved[k]; }
  }
}

test("chatUsageUnits: all input, the cached and written parts, omitted when zero; non-chat reports ignored", () => {
  const u = (o: Partial<AiUsage>): AiUsage => ({ kind: "chat", provider: "openai-compatible", model: "m", requests: 1, estimated: false, ...o });
  assert.deepEqual(chatUsageUnits([u({ inputTokens: 1000, outputTokens: 50, cachedInputTokens: 600 }), u({ inputTokens: 1200, outputTokens: 70, cacheWriteTokens: 300 })]),
    { inputUnits: 2200, outputUnits: 120, quantity: 2320, cacheReadUnits: 600, cacheWriteUnits: 300 });
  assert.deepEqual(chatUsageUnits([u({ inputTokens: 10, outputTokens: 2 })]), { inputUnits: 10, outputUnits: 2, quantity: 12 }, "nothing cached: no cache fields");
  assert.deepEqual(chatUsageUnits([u({ kind: "tts", characters: 99 }), u({ inputTokens: 5, outputTokens: 1 })]), { inputUnits: 5, outputUnits: 1, quantity: 6 });
});

test("classify (the `complete` path) reports what an OpenAI-style provider read from its cache", async () => {
  await withProvider({ prompt_tokens: 2400, completion_tokens: 6, prompt_tokens_details: { cached_tokens: 1536 } }, "{\"label\":\"Price\"}", async () => {
    const { value, usage } = await collectUsage(() => classify("too expensive for me", ["Price", "Quality"]));
    assert.equal(value, "Price");
    assert.equal(usage.length, 1);
    assert.equal(usage[0].inputTokens, 2400); assert.equal(usage[0].cachedInputTokens, 1536); assert.equal(usage[0].estimated, false);
  });
});

test("OCR reports the cache split too", async () => {
  await withProvider({ prompt_tokens: 3000, completion_tokens: 40, prompt_tokens_details: { cached_tokens: 1024 } }, "page text", async () => {
    const { value, usage } = await collectUsage(() => ocrImage(new Uint8Array([1, 2, 3]), "image/png"));
    assert.equal(value, "page text");
    assert.equal(usage[0].cachedInputTokens, 1024);
  });
});

/* every application meter that turns chat usage into a usage spec goes through chatUsageUnits — a copy that drops the split cannot come back */
function repoRoot(): string {
  let d = dirname(fileURLToPath(import.meta.url));
  for (let i = 0; i < 8; i++) { if (existsSync(join(d, "packages")) && existsSync(join(d, "apps"))) return d; d = dirname(d); }
  throw new Error("repository root not found");
}
test("the Studio, runtime and Interviews meters build their token fields with chatUsageUnits", () => {
  const root = repoRoot();
  for (const f of ["apps/studio/lib/meterRun.ts", "apps/runtime/lib/metering.ts", "apps/interviews/lib/metering.ts"]) {
    const src = readFileSync(join(root, f), "utf8");
    assert.match(src, /\.\.\.chatUsageUnits\(/, `${f} uses chatUsageUnits`);
    assert.doesNotMatch(src, /inputUnits:\s*(?:t|total)\.inputTokens/, `${f} has no hand-made copy of the token fields`);
  }
});

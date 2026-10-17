import test from "node:test";
import assert from "node:assert/strict";
import { Meter, MemoryMeterStore, type MeterContext } from "@rescript/billing";
import { reportUsage, type AiUsage } from "@rescript/ai";
import { meteredCore, usageToSpec, type RunDeps } from "./meterRun.ts";
import { setAiSettingsLoader } from "./aiPolicy.ts";
import type { Resolution } from "./byok/resolve.ts";

/**
 * THE STUDIO'S METERING OF A CACHED CALL (AI cost audit, 2026-10-17): the
 * cached and written input the provider reported reach the meter, the parts of
 * one logical call are ONE charge, a call that fails or consumed nothing is
 * released, and the record says how many tokens of each kind were billed.
 */
setAiSettingsLoader(async () => ({ mode: "cloud" as const, disabled: [] as string[] }));
const ctx = (): MeterContext => ({ customerId: "c1", surveyId: "s1", userId: "u1", environment: "LIVE" });
const reserve = () => ({ eventType: "AI_REQUEST", provider: "openai-compatible", service: "chat", model: "claude-sonnet-4-6", inputUnits: 3500, outputUnits: 3500, metadata: { operation: "copilot_ux" } });
const opts = { operation: "copilot_ux", kind: "chat" as const, reserve };
const platform: RunDeps = { connectionFor: async () => ({ kind: "platform", reason: "default" }) as Resolution, allowPrivate: () => false };
const mk = (balance = 10) => { const store = new MemoryMeterStore(); return { store, meter: new Meter(store, { seedBalance: balance, cacheMs: 0 }) }; };
const chat = (u: Partial<AiUsage>): AiUsage => ({ kind: "chat", provider: "openai-compatible", model: "claude-sonnet-4-6", requests: 1, estimated: false, ...u });

test("usageToSpec carries the cached and written input, summed over the call — and nothing when there was none", () => {
  const s = usageToSpec([chat({ inputTokens: 9500, outputTokens: 100, cacheWriteTokens: 9000 }), chat({ inputTokens: 9620, outputTokens: 5, cachedInputTokens: 9000 })], { kind: "chat" });
  assert.deepEqual([s.inputUnits, s.outputUnits, s.cacheReadUnits, s.cacheWriteUnits, s.metadata?.requests], [19120, 105, 9000, 9000, 2]);
  const plain = usageToSpec([chat({ inputTokens: 100, outputTokens: 5 })], { kind: "chat" });
  assert.equal("cacheReadUnits" in plain, false); assert.equal("cacheWriteUnits" in plain, false);
});

test("a call and its continuation settle as ONE event, priced with the cache rates, cheaper than the same tokens uncached", async () => {
  const run = async (cached: boolean) => {
    const { meter, store } = mk();
    const r = await meteredCore(platform, meter, ctx(), opts, async () => {
      reportUsage(chat({ inputTokens: 12362, outputTokens: 2000, ...(cached ? { cachedInputTokens: 8000, cacheWriteTokens: 362 } : {}) }));
      reportUsage(chat({ inputTokens: 14400, outputTokens: 215, ...(cached ? { cachedInputTokens: 8362 } : {}) }));
      return "ok";
    });
    assert.ok(r.ok && r.event);
    assert.equal(store.usage.length, 1, "one logical call, one charge");
    assert.equal([...store.reservations.values()].length, 1);
    return r.event!;
  };
  const cached = await run(true), plain = await run(false);
  assert.equal(cached.inputUnits, 26762); assert.equal(cached.outputUnits, 2215);
  assert.deepEqual(cached.metadata.tokens, { input: 26762, cachedInput: 16362, cacheWrite: 362, uncachedInput: 10038, output: 2215 });
  assert.equal(cached.metadata.requests, 2);
  assert.equal(cached.metadata.operation, "copilot_ux");
  assert.ok(cached.customerCharge < plain.customerCharge * 0.75, `${cached.customerCharge} vs ${plain.customerCharge}`);
  assert.equal(cached.marginPct, plain.marginPct, "the same margin model");
});

test("a call that fails is released, even after part of it reported usage; a call that consumed nothing is released too", async () => {
  const { meter, store } = mk();
  await assert.rejects(meteredCore(platform, meter, ctx(), opts, async () => { reportUsage(chat({ inputTokens: 9000, outputTokens: 4000 })); throw new Error("timeout on the continuation"); }), /timeout/);
  const w = (await meter.walletFor(ctx(), true))!;
  assert.equal(w.balance, 10); assert.equal(w.reserved, 0); assert.equal(store.usage.length, 0);
  /* a request that shared another's in-flight call, or an answer from the cache, reports nothing: no charge */
  const r = await meteredCore(platform, meter, ctx(), opts, async () => "shared");
  assert.ok(r.ok && r.event === null);
  assert.equal(store.usage.length, 0);
  assert.equal([...store.reservations.values()].every((x) => x.status === "released"), true);
});

test("on the user's own provider the cache tokens are recorded for attribution at zero charge", async () => {
  const { meter, store } = mk(0);
  const user: RunDeps = { connectionFor: async () => ({ kind: "user", source: "user", scopeKind: "chat", scope: { source: "user", provider: "anthropic", base: "https://api.anthropic.com/v1", key: "sk-ant-USERKEYUSERKEY", model: "claude-sonnet-4-6", fallbacks: [] }, credentialId: "c", settingUpdatedAt: "", skippedFallbacks: [] }) as Resolution, allowPrivate: () => false };
  const r = await meteredCore(user, meter, ctx(), opts, async () => { reportUsage(chat({ inputTokens: 12000, outputTokens: 500, cachedInputTokens: 8000, source: "user", providerId: "anthropic" })); return 1; });
  assert.ok(r.ok);
  assert.equal(store.usage[0].customerCharge, 0);
  assert.equal((store.usage[0].metadata.tokens as { cachedInput: number }).cachedInput, 8000);
});

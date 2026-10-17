import { test } from "node:test";
import assert from "node:assert/strict";
import { publicEvent } from "./billingView.ts";

/** AI cost audit 2026-10-17: a member sees what a call was priced from — input, the part read from the provider's cache, output — and never a cost field */
test("publicEvent carries the cached input tokens from the event's metadata, and no cost", () => {
  const base = { id: "e1", createdAt: "2026-10-17T00:00:00Z", eventType: "AI_REQUEST", category: "AI", environment: "LIVE", provider: "openai-compatible", model: "claude-sonnet-4-6", quantity: 1, unit: "request", inputUnits: 12362, outputUnits: 2215, customerCharge: 0.1185, providerCost: 0.05, adjustsEventId: null, surveyId: "s1" };
  const withCache = publicEvent({ ...base, metadata: { operation: "copilot_ux", tokens: { input: 12362, cachedInput: 7162, cacheWrite: 0, uncachedInput: 5200, output: 2215 } } } as never);
  assert.equal(withCache.cachedInputUnits, 7162);
  assert.equal(withCache.operation, "copilot_ux");
  assert.equal("providerCost" in withCache, false);
  const old = publicEvent({ ...base, metadata: { operation: "copilot_ux" } } as never);
  assert.equal(old.cachedInputUnits, null, "events from before the change show no cached part");
});

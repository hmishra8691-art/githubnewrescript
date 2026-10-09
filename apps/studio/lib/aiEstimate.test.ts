import { test } from "node:test";
import assert from "node:assert/strict";
import { aiSpec, meterModel } from "./aiEstimate.ts";

/*
 * MODEL TIERS IN THE METER (Research Engine audit, Phase 6): a small-tier
 * estimate is priced at the small model, a large-tier (or untiered) one at
 * the large model — the same spec the reservation uses, so the cost preview
 * and the wallet agree. Under cost simulation the fake provider's own
 * "fake" model becomes the configured one, but a real model name is kept.
 */
const KEYS = ["AI_API_URL", "AI_MODEL", "AI_MODEL_SMALL", "BILLING_SIMULATE_FAKE_COSTS"];
function withEnv(env: Record<string, string>, fn: () => void) {
  const saved = Object.fromEntries(KEYS.map((k) => [k, process.env[k]]));
  try { for (const k of KEYS) delete process.env[k]; Object.assign(process.env, env); fn(); }
  finally { for (const k of KEYS) { delete process.env[k]; if (saved[k] !== undefined) process.env[k] = saved[k]; } }
}

test("the estimate's model follows the tier", () => {
  withEnv({ AI_API_URL: "https://api.example/v1", AI_MODEL: "big-model", AI_MODEL_SMALL: "tiny-model" }, () => {
    const small = aiSpec("AI_REQUEST", { estimateText: "x".repeat(400), maxTokens: 300, operation: "workflow_structure", tier: "small" });
    const large = aiSpec("AI_REQUEST", { estimateText: "x".repeat(400), maxTokens: 300, operation: "workflow_hypotheses", tier: "large" });
    const none = aiSpec("AI_REQUEST", { estimateText: "x".repeat(400), maxTokens: 300, operation: "copilot_turn" });
    assert.equal(small.model, "tiny-model");
    assert.equal(large.model, "big-model");
    assert.equal(none.model, "big-model");
    assert.equal(small.provider, "openai-compatible");
    assert.equal(small.service, "chat");
    assert.equal(small.outputUnits, 300);
    assert.ok((small.inputUnits ?? 0) > 120);
    assert.deepEqual(small.metadata, { operation: "workflow_structure" });
    // two requests double both sides
    const twice = aiSpec("AI_REQUEST", { estimateText: "x".repeat(400), maxTokens: 300, operation: "o", requests: 2, tier: "small" });
    assert.equal(twice.outputUnits, 600);
    assert.equal(twice.inputUnits, (small.inputUnits ?? 0) * 2);
  });
  // no small model configured: the small tier is the large model
  withEnv({ AI_API_URL: "https://api.example/v1", AI_MODEL: "big-model" }, () => {
    assert.equal(aiSpec("AI_REQUEST", { estimateText: "x", maxTokens: 10, operation: "o", tier: "small" }).model, "big-model");
  });
});

test("the fake provider: priced as fake unless simulation is on, and then at the tier's model — a 'fake' report at the configured one", () => {
  withEnv({ AI_API_URL: "fake:", AI_MODEL: "big-model", AI_MODEL_SMALL: "tiny-model" }, () => {
    const s = aiSpec("AI_REQUEST", { estimateText: "x", maxTokens: 10, operation: "o", tier: "small" });
    assert.equal(s.provider, "fake");
    assert.equal(s.model, "tiny-model");
  });
  withEnv({ AI_API_URL: "fake:", AI_MODEL: "big-model", AI_MODEL_SMALL: "tiny-model", BILLING_SIMULATE_FAKE_COSTS: "1" }, () => {
    const s = aiSpec("AI_REQUEST", { estimateText: "x", maxTokens: 10, operation: "o", tier: "small" });
    assert.equal(s.provider, "openai-compatible");
    assert.equal(s.model, "tiny-model", "the tier's model survives simulation");
    assert.equal(aiSpec("AI_REQUEST", { estimateText: "x", maxTokens: 10, operation: "o" }).model, "big-model");
    assert.equal(meterModel("fake", "fake", "chat"), "big-model", "a fake report is priced at the configured model");
    assert.equal(meterModel("fake", null, "chat"), "big-model");
    assert.equal(meterModel("openai-compatible", "other", "chat"), "other");
  });
});

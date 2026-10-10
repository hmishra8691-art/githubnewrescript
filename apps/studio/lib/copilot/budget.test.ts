import { test } from "node:test";
import assert from "node:assert/strict";
import { DEFAULT_MAX_OUTPUT_TOKENS, maxOutputTokens, outputBudget } from "./budget.ts";

/*
 * THE OUTPUT BUDGET (Research Engine audit, Phase 7): Intelligent mode asks
 * the provider for the ceiling, reserves the expected size, continues a
 * cut-off answer, and waits as long as the provider is given.
 */
test("the ceiling: AI_MAX_OUTPUT_TOKENS, else 32 000; never below 8 000; a bad value is the default", () => {
  assert.equal(maxOutputTokens({}), DEFAULT_MAX_OUTPUT_TOKENS);
  assert.equal(DEFAULT_MAX_OUTPUT_TOKENS, 32_000);
  assert.equal(maxOutputTokens({ AI_MAX_OUTPUT_TOKENS: "64000" }), 64_000);
  assert.equal(maxOutputTokens({ AI_MAX_OUTPUT_TOKENS: "100" }), 8_000);
  assert.equal(maxOutputTokens({ AI_MAX_OUTPUT_TOKENS: "lots" }), DEFAULT_MAX_OUTPUT_TOKENS);
  assert.equal(maxOutputTokens({ AI_MAX_OUTPUT_TOKENS: "0" }), DEFAULT_MAX_OUTPUT_TOKENS);
  assert.equal(maxOutputTokens({ AI_MAX_OUTPUT_TOKENS: "99999999" }), 1_000_000);
});

test("every kind asks for the ceiling, reserves its expected size, continues eight times, and generation waits the full five minutes", () => {
  const kinds = ["edit", "review", "ux", "generate", "plan", "item", "repair", "coverage", "narrative", "summary"] as const;
  for (const k of kinds) {
    const b = outputBudget(k, {});
    assert.equal(b.maxTokens, 32_000, k);
    assert.ok(b.expectedTokens >= 1200 && b.expectedTokens <= 8000, `${k}: expected ${b.expectedTokens}`);
    assert.ok(b.expectedTokens < b.maxTokens, k);
    assert.equal(b.continuations, 8, k);
    assert.ok(b.timeoutMs >= 120_000 && b.timeoutMs <= 300_000, k);
  }
  assert.equal(outputBudget("generate", {}).expectedTokens, 8000);
  assert.equal(outputBudget("edit", {}).expectedTokens, 2500);
  assert.equal(outputBudget("narrative", {}).expectedTokens, 1200);
  assert.equal(outputBudget("generate", {}).timeoutMs, 300_000);
  assert.equal(outputBudget("item", {}).timeoutMs, 300_000);
  assert.equal(outputBudget("edit", {}).timeoutMs, 180_000);
  // a ceiling set below the expected size never cuts the expected size
  assert.equal(outputBudget("generate", { AI_MAX_OUTPUT_TOKENS: "8000" }).maxTokens, 8000);
  assert.equal(outputBudget("generate", { AI_MAX_OUTPUT_TOKENS: "8000" }).expectedTokens, 8000);
});

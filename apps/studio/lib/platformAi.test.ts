import { test } from "node:test";
import assert from "node:assert/strict";
import { aiPresence, aiConfigWarning } from "./aiConfig.ts";

/* Phase 1: the platform page says whether a language model is configured, and warns when it is not. */
test("no AI_API_URL: not configured, and the warning names what Intelligent Mode loses", () => {
  const p = aiPresence({});
  assert.deepEqual(p, { ai: false, aiFake: false, aiModel: false });
  const w = aiConfigWarning(p, "production");
  assert.match(w ?? "", /No language model is configured \(AI_API_URL, AI_API_KEY, AI_MODEL\)/);
  assert.match(w ?? "", /engine-only/);
});

test("a real provider with a model is sound; without AI_MODEL the default's risk is named", () => {
  const ok = aiPresence({ AI_API_URL: "https://api.anthropic.com/v1", AI_API_KEY: "k", AI_MODEL: "claude-x" });
  assert.deepEqual(ok, { ai: true, aiFake: false, aiModel: true });
  assert.equal(aiConfigWarning(ok, "production"), null);
  const noModel = aiPresence({ AI_API_URL: "https://api.anthropic.com/v1", AI_API_KEY: "k" });
  assert.match(aiConfigWarning(noModel, "development") ?? "", /AI_MODEL is not set.*gpt-4o-mini/);
  assert.equal(aiPresence({ AI_API_URL: "https://api.anthropic.com/v1", AI_MODEL: "  " }).aiModel, false, "a blank AI_MODEL is unset");
});

test("the fake provider in production is a warning; elsewhere it is not", () => {
  const p = aiPresence({ AI_API_URL: "fake:" });
  assert.equal(p.aiFake, true);
  assert.match(aiConfigWarning(p, "production") ?? "", /FAKE provider in production/);
  assert.equal(aiConfigWarning(p, "development"), null);
  assert.equal(aiPresence({ AI_API_URL: "  " }).ai, false, "blank is unset");
});

import test from "node:test";
import assert from "node:assert/strict";
import { sttBase, sttConfigured, sttProviderName, sttUnavailableReason } from "./index.js";

/**
 * Speech-to-text is a separate provider, and usually a different vendor.
 *
 * This suite exists because of one real misconfiguration: an installation
 * pointed at Anthropic, whose API is OpenAI-compatible for chat and has no
 * transcription endpoint at all. Everything looked correctly configured and
 * every transcription 404'd.
 */
function withEnv(env: Record<string, string | undefined>, fn: () => void) {
  const keys = ["AI_API_URL", "AI_API_KEY", "AI_STT_API_URL", "AI_STT_API_KEY"];
  const saved = Object.fromEntries(keys.map((k) => [k, process.env[k]]));
  try {
    for (const k of keys) delete process.env[k];
    for (const [k, v] of Object.entries(env)) if (v !== undefined) process.env[k] = v;
    fn();
  } finally {
    for (const k of keys) { delete process.env[k]; if (saved[k] !== undefined) process.env[k] = saved[k]; }
  }
}

test("speech-to-text falls back to the main provider when it has none of its own", () => {
  withEnv({ AI_API_URL: "https://api.openai.com/v1" }, () => {
    assert.equal(sttBase(), "https://api.openai.com/v1");
    assert.equal(sttConfigured(), true);
    assert.equal(sttProviderName(), "openai-compatible");
    assert.equal(sttUnavailableReason(), null);
  });
});

test("and is overridden when it has one", () => {
  withEnv({ AI_API_URL: "https://api.anthropic.com/v1", AI_STT_API_URL: "https://api.groq.com/openai/v1" }, () => {
    assert.equal(sttBase(), "https://api.groq.com/openai/v1");
    assert.equal(sttConfigured(), true);
    assert.equal(sttUnavailableReason(), null);
  });
});

test("Anthropic for chat means NO transcription, said before the round trip", () => {
  withEnv({ AI_API_URL: "https://api.anthropic.com/v1" }, () => {
    assert.equal(sttConfigured(), false, "chat works there; transcription cannot");
    const why = sttUnavailableReason()!;
    assert.match(why, /Anthropic/);
    assert.match(why, /no speech-to-text endpoint/);
    assert.match(why, /AI_STT_API_URL/, "and names the setting that fixes it");
    /* the fix must not read as "turn off your AI provider" */
    assert.match(why, /leave AI_API_URL as it is/);
  });
});

test("nothing configured is said as nothing configured", () => {
  withEnv({}, () => {
    assert.equal(sttBase(), "");
    assert.equal(sttConfigured(), false);
    assert.equal(sttProviderName(), null);
    assert.match(sttUnavailableReason()!, /AI_STT_API_URL and AI_API_URL are both unset/);
  });
});

test("the fake provider is still the fake provider", () => {
  withEnv({ AI_API_URL: "fake:" }, () => {
    assert.equal(sttProviderName(), "fake");
    assert.equal(sttConfigured(), true);
    assert.equal(sttUnavailableReason(), null);
  });
});

test("a trailing slash does not make a different provider", () => {
  withEnv({ AI_STT_API_URL: "https://api.openai.com/v1///" }, () => {
    assert.equal(sttBase(), "https://api.openai.com/v1");
  });
});

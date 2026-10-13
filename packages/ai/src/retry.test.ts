import test from "node:test";
import assert from "node:assert/strict";
import { completeJson } from "./index.js";

/**
 * ONE RETRY, WITH BACK-OFF (Data Analytics audit A-5): a 429, a 5xx or a
 * dropped connection is retried once; the request's own faults and the
 * caller's timeout are not.
 */
const KEYS = ["AI_API_URL", "AI_API_KEY", "AI_MODEL", "AI_MODEL_SMALL", "AI_WORKSPACE_ID", "AI_API_HEADERS"];
async function withEnv(fn: () => Promise<void>) {
  const saved = Object.fromEntries(KEYS.map((k) => [k, process.env[k]]));
  const real = globalThis.fetch;
  try { for (const k of KEYS) delete process.env[k]; Object.assign(process.env, { AI_API_URL: "https://retry.test/v1", AI_API_KEY: "k", AI_MODEL: "m" }); await fn(); }
  finally { globalThis.fetch = real; for (const k of KEYS) { delete process.env[k]; if (saved[k] !== undefined) process.env[k] = saved[k]; } }
}
const ok = () => new Response(JSON.stringify({ choices: [{ message: { content: "{\"a\":1}" }, finish_reason: "stop" }], usage: { prompt_tokens: 1, completion_tokens: 1 } }), { status: 200 });
const script = (steps: (Response | Error)[]) => { let n = 0; globalThis.fetch = (async () => { const s = steps[Math.min(n++, steps.length - 1)]; if (s instanceof Error) throw s; return s.clone(); }) as never; return () => n; };

test("a 503 then a good answer is one call that succeeds, made twice", async () => {
  await withEnv(async () => {
    const calls = script([new Response("busy", { status: 503 }), ok()]);
    assert.deepEqual(await completeJson("s", "u", 100, { retryDelayMs: 1 }), { a: 1 });
    assert.equal(calls(), 2);
  });
});

test("a 429 is retried, honouring Retry-After when it is short", async () => {
  await withEnv(async () => {
    const t0 = Date.now();
    const calls = script([new Response("slow down", { status: 429, headers: { "retry-after": "1" } }), ok()]);
    assert.deepEqual(await completeJson("s", "u", 100, { retryDelayMs: 1 }), { a: 1 });
    assert.equal(calls(), 2);
    assert.ok(Date.now() - t0 >= 900, "waited the provider's second");
  });
});

test("a dropped connection is retried once", async () => {
  await withEnv(async () => {
    const calls = script([new TypeError("fetch failed"), ok()]);
    assert.deepEqual(await completeJson("s", "u", 100, { retryDelayMs: 1 }), { a: 1 });
    assert.equal(calls(), 2);
  });
});

test("a request the provider refuses (400, 401, 404) is not retried", async () => {
  for (const status of [400, 401, 404]) {
    await withEnv(async () => {
      const calls = script([new Response("no", { status })]);
      await assert.rejects(() => completeJson("s", "u", 100, { retryDelayMs: 1 }), new RegExp(`refused the request \\(${status}\\)`));
      assert.equal(calls(), 1, String(status));
    });
  }
});

test("still failing after the retry: the cause is named, after exactly two calls", async () => {
  await withEnv(async () => {
    let calls = script([new Response("busy", { status: 503 })]);
    await assert.rejects(() => completeJson("s", "u", 100, { retryDelayMs: 1 }), /unavailable \(503\)/);
    assert.equal(calls(), 2);
    calls = script([new Response("limit", { status: 429 })]);
    await assert.rejects(() => completeJson("s", "u", 100, { retryDelayMs: 1 }), /rate-limiting requests \(429\)/);
    assert.equal(calls(), 2);
    calls = script([new TypeError("fetch failed")]);
    await assert.rejects(() => completeJson("s", "u", 100, { retryDelayMs: 1 }), /could not reach the analysis provider/);
    assert.equal(calls(), 2);
  });
});

test("retries: 0 turns it off", async () => {
  await withEnv(async () => {
    const calls = script([new Response("busy", { status: 503 }), ok()]);
    await assert.rejects(() => completeJson("s", "u", 100, { retries: 0 }), /503/);
    assert.equal(calls(), 1);
  });
});

test("the caller's timeout is final: an abort is not retried and says how long it waited", async () => {
  await withEnv(async () => {
    let n = 0;
    globalThis.fetch = ((_u: string, init: { signal: AbortSignal }) => { n++; return new Promise((_res, rej) => init.signal.addEventListener("abort", () => rej(Object.assign(new Error("aborted"), { name: "AbortError" })))); }) as never;
    await assert.rejects(() => completeJson("s", "u", 100, { timeoutMs: 50, retryDelayMs: 1 }), /did not answer within/);
    assert.equal(n, 1);
  });
});

test("the wait never outlasts the time budget: a long Retry-After on a short timeout ends as a timeout", async () => {
  await withEnv(async () => {
    const calls = script([new Response("limit", { status: 429, headers: { "retry-after": "4" } }), ok()]);
    const t0 = Date.now();
    await assert.rejects(() => completeJson("s", "u", 100, { timeoutMs: 100 }), /did not answer within|aborted/);
    assert.ok(Date.now() - t0 < 1500);
    assert.equal(calls(), 1);
  });
});

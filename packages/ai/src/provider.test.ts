import test from "node:test";
import assert from "node:assert/strict";
import {
  completeJson, resetProviderState, setProviderLogger, setProviderRandom, isProviderError, providerHealth, recentProviderEvents,
  retryAfterFrom, parseDurationMs, classifyResponse, backoffMs, capacityNotice, fallbackProvider, resetFallbackWarning, type ProviderError,
} from "./index.js";

/**
 * THE AI REQUEST MANAGER: classification, Retry-After, jittered bounded
 * retries inside a deadline, a lane's shared cool-down and concurrency,
 * the configured fallback, and a log with no secrets in it.
 */
const KEYS = ["AI_API_URL", "AI_API_KEY", "AI_MODEL", "AI_MODEL_SMALL", "AI_WORKSPACE_ID", "AI_API_HEADERS", "AI_MAX_CONCURRENCY", "AI_FALLBACK_API_URL", "AI_FALLBACK_API_KEY", "AI_FALLBACK_MODEL", "AI_FALLBACK_MODEL_SMALL"];
async function withEnv(extra: Record<string, string>, fn: () => Promise<void>) {
  const saved = Object.fromEntries(KEYS.map((k) => [k, process.env[k]]));
  const real = globalThis.fetch;
  resetProviderState(); resetFallbackWarning(); setProviderLogger(() => {}); setProviderRandom(null);
  try { for (const k of KEYS) delete process.env[k]; Object.assign(process.env, { AI_API_URL: "https://primary.test/v1", AI_API_KEY: "sk-primary-secret", AI_MODEL: "m1" }, extra); await fn(); }
  finally { globalThis.fetch = real; setProviderLogger(null); setProviderRandom(null); resetProviderState(); for (const k of KEYS) { delete process.env[k]; if (saved[k] !== undefined) process.env[k] = saved[k]; } }
}
const reply = (content = "{\"a\":1}") => new Response(JSON.stringify({ choices: [{ message: { content }, finish_reason: "stop" }], usage: { prompt_tokens: 5, completion_tokens: 3 } }), { status: 200 });
const status = (n: number, body = "", headers: Record<string, string> = {}) => new Response(body, { status: n, headers });
type Handler = (url: string, init: { signal: AbortSignal; body: string; headers: Record<string, string> }, n: number) => Response | Error | Promise<Response | Error>;
function serve(h: Handler) {
  const log: { url: string; model: string; at: number }[] = [];
  globalThis.fetch = (async (url: string, init: { signal: AbortSignal; body: string; headers: Record<string, string> }) => {
    const n = log.length;
    log.push({ url, model: JSON.parse(init.body).model, at: Date.now() });
    const r = await h(url, init, n);
    if (r instanceof Error) throw r;
    return r.clone();
  }) as never;
  return log;
}
const fast = { retryDelayMs: 5 };

test("Retry-After in every form providers use: seconds, a date, milliseconds, reset hints", () => {
  const h = (o: Record<string, string>) => new Headers(o);
  assert.equal(retryAfterFrom(h({ "retry-after": "7" })), 7000);
  assert.equal(retryAfterFrom(h({ "retry-after-ms": "250" })), 250);
  const now = Date.parse("2026-10-14T10:00:00Z");
  assert.equal(retryAfterFrom(h({ "retry-after": "Wed, 14 Oct 2026 10:00:09 GMT" }), now), 9000);
  assert.equal(retryAfterFrom(h({ "anthropic-ratelimit-requests-reset": "2026-10-14T10:00:12Z", "anthropic-ratelimit-tokens-reset": "2026-10-14T10:00:40Z" }), now), 12000);
  assert.equal(retryAfterFrom(h({ "x-ratelimit-reset-requests": "1s", "x-ratelimit-reset-tokens": "6m0s" })), 1000);
  assert.equal(retryAfterFrom(h({})), null);
  assert.equal(parseDurationMs("1h2m3.5s"), 3723500);
  assert.equal(parseDurationMs("20ms"), 20);
});

test("classification: a 429 about credit is not a rate limit; a 403 about a rate limit is not a permission", () => {
  const k = (s: number, body = "", hdr: Record<string, string> = {}) => classifyResponse(s, new Headers(hdr), body).kind;
  assert.equal(k(429, "Rate limit reached for requests"), "rate_limited");
  assert.equal(k(429, '{"error":{"code":"insufficient_quota","message":"You exceeded your current quota, please check your plan and billing details"}}'), "quota_exhausted");
  assert.equal(k(429, "Your credit balance is too low to access the API"), "quota_exhausted");
  assert.equal(k(403, "Too many requests, slow down"), "rate_limited");
  assert.equal(k(403, "Request not allowed for this workspace"), "forbidden");
  assert.equal(k(403, "forbidden", { "retry-after": "3" }), "rate_limited");
  assert.equal(k(401, "invalid x-api-key"), "auth");
  assert.equal(k(404, "model not found"), "not_found");
  assert.equal(k(400, "bad"), "bad_request");
  assert.equal(k(529, "Overloaded"), "overloaded");
  assert.equal(k(503, "service unavailable"), "server");
  assert.equal(k(503, "The server is overloaded"), "overloaded");
  assert.equal(k(502, ""), "server");
  const e = classifyResponse(429, new Headers({ "retry-after": "2" }), "slow");
  assert.equal(e.retryable, true); assert.equal(e.retryAfterMs, 2000);
  for (const kind of ["auth", "forbidden", "not_found", "bad_request", "quota_exhausted"]) assert.equal(classifyResponse({ auth: 401, forbidden: 403, not_found: 404, bad_request: 400, quota_exhausted: 402 }[kind]!, new Headers(), "x").retryable, false, kind);
});

test("backoff: exponential windows with jitter, capped, never zero", () => {
  setProviderRandom(() => 0);
  assert.equal(backoffMs(0, { delayMs: 800 }), 400);
  assert.equal(backoffMs(1, { delayMs: 800 }), 800);
  assert.equal(backoffMs(2, { delayMs: 800 }), 1600);
  setProviderRandom(() => 1);
  assert.equal(backoffMs(2, { delayMs: 800 }), 3200);
  assert.equal(backoffMs(20, { delayMs: 800, maxWaitMs: 30_000 }), 30_000);
  setProviderRandom(null);
  const xs = new Set(Array.from({ length: 30 }, () => backoffMs(3, { delayMs: 800 })));
  assert.ok(xs.size > 5, "jittered");
});

test("[1,2,6] success, a 429 then recovery honouring Retry-After, consecutive 429s then recovery", async () => {
  await withEnv({}, async () => {
    let log = serve(() => reply());
    assert.deepEqual(await completeJson("s", "u", 100, fast), { a: 1 });
    assert.equal(log.length, 1);
    resetProviderState();
    log = serve((_u, _i, n) => n === 0 ? status(429, "rate limit", { "retry-after": "1" }) : reply());
    const t0 = Date.now();
    assert.deepEqual(await completeJson("s", "u", 100, fast), { a: 1 });
    assert.equal(log.length, 2);
    assert.ok(Date.now() - t0 >= 950, "waited what the provider said");
    resetProviderState();
    log = serve((_u, _i, n) => n < 3 ? status(429, "rate limit", { "retry-after-ms": "20" }) : reply());
    assert.deepEqual(await completeJson("s", "u", 100, fast), { a: 1 });
    assert.equal(log.length, 4);
  });
});

test("[5] a timeout is a timeout, not a refusal, and is not retried", async () => {
  await withEnv({}, async () => {
    const log = serve((_u, init) => new Promise<Response>((_r, rej) => init.signal.addEventListener("abort", () => rej(Object.assign(new Error("x"), { name: "AbortError" })))) as never);
    const err = await completeJson("s", "u", 100, { timeoutMs: 1100, ...fast }).catch((e) => e) as ProviderError;
    assert.ok(isProviderError(err)); assert.equal(err.kind, "timeout"); assert.match(err.message, /did not answer within 1 seconds/);
    assert.equal(log.length, 1);
  });
});

test("[6] 500 and 503 are retried and recover; a persistent 503 ends as `server`, after the bounded attempts", async () => {
  await withEnv({}, async () => {
    let log = serve((_u, _i, n) => n === 0 ? status(500, "boom") : n === 1 ? status(503, "busy") : reply());
    assert.deepEqual(await completeJson("s", "u", 100, fast), { a: 1 });
    assert.equal(log.length, 3);
    resetProviderState();
    log = serve(() => status(503, "down"));
    const err = await completeJson("s", "u", 100, fast).catch((e) => e) as ProviderError;
    assert.equal(err.kind, "server"); assert.equal(err.status, 503); assert.equal(err.retryable, true);
    assert.equal(log.length, 4, "one try and three retries — bounded");
  });
});

test("[7] 401: classified, not retried, and not asked again while the key is known bad", async () => {
  await withEnv({}, async () => {
    const log = serve(() => status(401, '{"error":{"message":"invalid x-api-key"}}'));
    const err = await completeJson("s", "u", 100, fast).catch((e) => e) as ProviderError;
    assert.equal(err.kind, "auth"); assert.equal(err.retryable, false); assert.equal(log.length, 1);
    const again = await completeJson("s", "u", 100, fast).catch((e) => e) as ProviderError;
    assert.equal(again.kind, "auth"); assert.equal(log.length, 1, "the provider was not asked to refuse a second time");
    assert.equal(providerHealth()[0].state, "blocked");
    process.env.AI_API_KEY = "sk-rotated";   // a new key is a new lane
    serve(() => reply());
    assert.deepEqual(await completeJson("s", "u", 100, fast), { a: 1 });
  });
});

test("[8] 403: a refused permission is not retried; a 403 that is a rate limit is", async () => {
  await withEnv({}, async () => {
    let log = serve(() => status(403, "this workspace may not use this model"));
    const err = await completeJson("s", "u", 100, fast).catch((e) => e) as ProviderError;
    assert.equal(err.kind, "forbidden"); assert.equal(log.length, 1);
    resetProviderState();
    log = serve((_u, _i, n) => n === 0 ? status(403, "Too many requests", { "retry-after-ms": "10" }) : reply());
    assert.deepEqual(await completeJson("s", "u", 100, fast), { a: 1 });
    assert.equal(log.length, 2);
  });
});

test("a spent quota is not retried and not hammered", async () => {
  await withEnv({}, async () => {
    const log = serve(() => status(429, '{"error":{"code":"insufficient_quota","message":"You exceeded your current quota"}}'));
    const err = await completeJson("s", "u", 100, fast).catch((e) => e) as ProviderError;
    assert.equal(err.kind, "quota_exhausted"); assert.equal(log.length, 1);
    await completeJson("s", "u", 100, fast).catch(() => {});
    assert.equal(log.length, 1);
  });
});

test("a wait that does not fit the deadline ends the call at once with how long to come back — the work can be saved", async () => {
  await withEnv({}, async () => {
    const log = serve(() => status(429, "rate limit", { "retry-after": "40" }));
    const t0 = Date.now();
    const err = await completeJson("s", "u", 100, { deadline: Date.now() + 5000, ...fast }).catch((e) => e) as ProviderError;
    assert.equal(err.kind, "rate_limited"); assert.equal(err.retryAfterMs, 40_000); assert.equal(err.exhausted, true);
    assert.ok(Date.now() - t0 < 1000); assert.equal(log.length, 1);
  });
});

test("[13] concurrent researchers: the lane caps concurrency, a 429 cools it for everyone, and the queue drains", async () => {
  await withEnv({ AI_MAX_CONCURRENCY: "2" }, async () => {
    let active = 0, peak = 0;
    const log = serve(async (_u, _i, n) => {
      active++; peak = Math.max(peak, active);
      await new Promise((r) => setTimeout(r, 30));
      active--;
      return n === 0 ? status(429, "rate limit", { "retry-after-ms": "150" }) : reply();
    });
    const t0 = Date.now();
    const out = await Promise.all(Array.from({ length: 8 }, () => completeJson("s", "u", 100, { timeoutMs: 20_000, ...fast })));
    assert.equal(out.length, 8); assert.ok(out.every((v) => (v as { a: number }).a === 1));
    assert.ok(peak <= 2, `peak concurrency ${peak}`);
    assert.equal(log.length, 9, "eight answers and the one 429 — nobody else hit the cooled provider");
    const inCooldown = log.slice(1).filter((l) => l.at - t0 > 80 && l.at - t0 < 140);
    assert.equal(inCooldown.length, 0, "nobody else reached the cooled provider while it was cooling");
    assert.equal(providerHealth()[0].lastError?.kind, "rate_limited");
  });
});

test("a 429 halves the lane's concurrency; successes widen it again", async () => {
  await withEnv({ AI_MAX_CONCURRENCY: "4" }, async () => {
    serve((_u, _i, n) => n === 0 ? status(429, "rate limit", { "retry-after-ms": "5" }) : reply());
    await completeJson("s", "u", 100, fast);
    assert.equal(providerHealth()[0].limit, 2);
    assert.equal(providerHealth()[0].state, "degraded");
    for (let i = 0; i < 16; i++) await completeJson("s", "u", 100, fast);
    assert.equal(providerHealth()[0].limit, 4);
    assert.equal(providerHealth()[0].state, "ok");
  });
});

test("[14] a fallback provider answers when the first is rate-limited past our patience — only because the operator configured it", async () => {
  await withEnv({ AI_FALLBACK_API_URL: "https://backup.test/v1", AI_FALLBACK_API_KEY: "sk-backup", AI_FALLBACK_MODEL: "backup-model" }, async () => {
    const log = serve((url) => url.startsWith("https://primary.test") ? status(429, "rate limit") : reply("{\"from\":\"backup\"}"));
    assert.deepEqual(await completeJson("s", "u", 100, { retries: 1, ...fast }), { from: "backup" });
    assert.deepEqual(log.map((l) => `${new URL(l.url).host}:${l.model}`), ["primary.test:m1", "primary.test:m1", "backup.test:backup-model"]);
  });
  await withEnv({ AI_FALLBACK_API_URL: "https://backup.test/v1", AI_FALLBACK_API_KEY: "sk-backup", AI_FALLBACK_MODEL: "backup-model" }, async () => {
    serve((url) => url.startsWith("https://primary.test") ? status(401, "bad key") : reply("{\"from\":\"backup\"}"));
    assert.deepEqual(await completeJson("s", "u", 100, fast), { from: "backup" }, "a refused key is also cured by a second provider");
  });
  await withEnv({ AI_FALLBACK_API_URL: "https://backup.test/v1", AI_FALLBACK_API_KEY: "sk-backup", AI_FALLBACK_MODEL: "backup-model" }, async () => {
    const log = serve(() => status(400, "bad request"));
    await assert.rejects(() => completeJson("s", "u", 100, fast), /refused the request \(400\)/);
    assert.equal(log.length, 1, "a request the provider finds malformed is not forwarded to another");
  });
});

test("[15] no fallback configured, or it is not usable: the failure stands and says it is temporary", async () => {
  await withEnv({}, async () => {
    serve(() => status(429, "rate limit"));
    const err = await completeJson("s", "u", 100, { retries: 1, ...fast }).catch((e) => e) as ProviderError;
    assert.equal(err.kind, "rate_limited"); assert.equal(err.retryable, true);
  });
  await withEnv({ AI_FALLBACK_API_URL: "http://plain.example/v1", AI_FALLBACK_API_KEY: "k", AI_FALLBACK_MODEL: "m" }, async () => {
    assert.equal(fallbackProvider(), null, "plain http to a remote host is not a fallback");
  });
  await withEnv({ AI_FALLBACK_API_URL: "https://backup.test/v1" }, async () => {
    assert.equal(fallbackProvider(), null, "a half-configured fallback is not used");
  });
  await withEnv({ AI_FALLBACK_API_URL: "https://backup.test/v1", AI_FALLBACK_API_KEY: "sk-backup", AI_FALLBACK_MODEL: "backup-model" }, async () => {
    const log = serve(() => status(503, "down"));
    const err = await completeJson("s", "u", 100, { retries: 0, ...fast }).catch((e) => e) as ProviderError;
    assert.equal(err.kind, "server"); assert.match(err.detail, /fallback provider also failed/);
    assert.equal(log.length, 2);
  });
});

test("a dropped connection is retried and recovers; a persistent one ends as `network`", async () => {
  await withEnv({}, async () => {
    serve((_u, _i, n) => n < 2 ? new TypeError("fetch failed") : reply());
    assert.deepEqual(await completeJson("s", "u", 100, fast), { a: 1 });
    resetProviderState();
    serve(() => new TypeError("fetch failed"));
    const err = await completeJson("s", "u", 100, fast).catch((e) => e) as ProviderError;
    assert.equal(err.kind, "network");
  });
});

test("the log names what happened — and carries no key, no prompt", async () => {
  await withEnv({}, async () => {
    const lines: string[] = [];
    setProviderLogger((event, fields) => lines.push(JSON.stringify({ event, ...fields })));
    serve((_u, _i, n) => n === 0 ? status(429, "rate limit", { "retry-after-ms": "10" }) : reply());
    await completeJson("SYSTEM PROMPT SECRET", "USER PROMPT SECRET", 100, { operation: "copilot_plan", ...fast });
    const all = lines.join("\n");
    assert.match(all, /"event":"retry"/); assert.match(all, /"event":"recovered"/); assert.match(all, /copilot_plan/);
    assert.doesNotMatch(all, /sk-primary-secret|PROMPT SECRET/);
    assert.ok(recentProviderEvents().length >= 2);
  });
});

test("onEvent tells a caller about each retry, so a screen can say what is happening", async () => {
  await withEnv({}, async () => {
    serve((_u, _i, n) => n === 0 ? status(429, "rate limit", { "retry-after-ms": "10" }) : reply());
    const seen: string[] = [];
    await completeJson("s", "u", 100, { ...fast, onEvent: (e) => seen.push(e.type) });
    assert.deepEqual(seen, ["retry", "recovered"]);
  });
});

test("a prompt that outgrew the model's context window is told apart — a shorter prompt can succeed, a retry of the same cannot", async () => {
  const e = classifyResponse(400, new Headers(), '{"error":{"message":"prompt is too long: 215000 tokens > 200000 maximum"}}');
  assert.equal(e.kind, "bad_request"); assert.equal(e.contextTooLong, true); assert.equal(e.retryable, false);
  assert.equal(classifyResponse(400, new Headers(), "bad json").contextTooLong, false);
  assert.equal(classifyResponse(413, new Headers(), "Request Entity Too Large").contextTooLong, true);
  await withEnv({}, async () => {
    serve(() => status(400, "This model's maximum context length is 128000 tokens"));
    const err = await completeJson("s", "u", 100, fast).catch((x) => x) as ProviderError;
    assert.equal(err.contextTooLong, true);
  });
});

test("the researcher is told about tokens only when the provider's allowance is nearly spent", async () => {
  await withEnv({}, async () => {
    const roomy = () => new Response(reply().body, { status: 200, headers: { "anthropic-ratelimit-tokens-remaining": "800000", "anthropic-ratelimit-tokens-limit": "1000000" } });
    serve(() => roomy());
    await completeJson("s", "u", 100, fast);
    assert.equal(capacityNotice(), null, "plenty left: no notice");
    resetProviderState();
    serve(() => new Response(reply().body, { status: 200, headers: { "anthropic-ratelimit-tokens-remaining": "20000", "anthropic-ratelimit-tokens-limit": "1000000" } }));
    await completeJson("s", "u", 100, fast);
    assert.match(capacityNotice() ?? "", /nearly used up/);
    assert.equal(capacityNotice(Date.now() + 10 * 60_000), null, "a stale reading says nothing");
  });
});

/* ---------------------------------------------- "THE AI SERVICE COULD NOT PROCESS THIS REQUEST" */

const ANTHROPIC_CREDIT = '{"type":"error","error":{"type":"invalid_request_error","message":"Your credit balance is too low to access the Anthropic API. Please go to Plans & Billing to upgrade or purchase credits."}}';

test("a 400 that says, in words, the account is out of credit / disabled / has no such model is not a malformed request", () => {
  const k = (s: number, body: string) => classifyResponse(s, new Headers(), body);
  /* Anthropic reports a spent balance as HTTP 400 invalid_request_error — the exact body below */
  assert.equal(k(400, ANTHROPIC_CREDIT).kind, "quota_exhausted");
  assert.equal(k(400, ANTHROPIC_CREDIT).retryable, false);
  assert.equal(k(400, '{"error":{"message":"This organization has been disabled."}}').kind, "forbidden");
  assert.equal(k(400, '{"error":{"code":"billing_hard_limit_reached","message":"Billing hard limit has been reached"}}').kind, "quota_exhausted");
  assert.equal(k(400, "The model `gpt-9` does not exist or you do not have access to it").kind, "not_found");
  assert.equal(k(402, "").kind, "quota_exhausted");
  /* what stays a refusal of the request: a malformed field, an unsupported parameter, and a prompt that is too long */
  assert.equal(k(400, "messages.0.content: Input should be a valid string").kind, "bad_request");
  assert.equal(k(400, "Unsupported parameter: 'temperature' is not supported with this model").kind, "bad_request");
  assert.equal(k(400, "response_format.type: Input should be 'json_schema'").kind, "bad_request");
  assert.equal(k(400, "model does not support response_format json_schema").kind, "bad_request");
  const long = k(400, "prompt is too long: 250000 tokens > 200000 maximum");
  assert.equal(long.kind, "bad_request"); assert.equal(long.contextTooLong, true);
});

test("redact: keys, bearer tokens, key headers and credentials in an address never reach a log or a screen", async () => {
  const { redact } = await import("./index.js");
  const said = redact('invalid x-api-key: sk-ant-api03-ABCDEF1234567890 sent as Bearer abcdefghijklmnop1234 to https://user:pass@host.test/v1 "api_key": "supersecretvalue1" authorization=Basic dXNlcjpwYXNzd29yZA==');
  for (const leak of ["ABCDEF1234567890", "abcdefghijklmnop1234", "user:pass", "supersecretvalue1", "dXNlcjpwYXNzd29yZA"]) assert.equal(said.includes(leak), false, leak);
  assert.match(redact("Your credit balance is too low"), /credit balance is too low/);
  assert.equal(redact("x".repeat(900), 300).length, 300);
});

test("a credit-balance 400 from the provider ends as `quota_exhausted` — one request, no retry, not asked again, and what it said is logged", async () => {
  await withEnv({}, async () => {
    const lines: { event: string; fields: Record<string, unknown> }[] = [];
    setProviderLogger((event, fields) => lines.push({ event, fields }));
    const log = serve(() => status(400, ANTHROPIC_CREDIT));
    const e = await completeJson("sys", "user", 100, { ...fast, schema: { name: "s", schema: { type: "object" } } }).catch((x) => x) as ProviderError;
    assert.ok(isProviderError(e)); assert.equal(e.kind, "quota_exhausted"); assert.equal(e.status, 400);
    assert.match(e.detail, /credit balance is too low/);
    assert.equal(log.length, 1, "the credit refusal is not the schema's fault: no second shape is tried, no retry");
    const again = await completeJson("sys", "user", 100, fast).catch((x) => x) as ProviderError;
    assert.equal(again.kind, "quota_exhausted"); assert.equal(log.length, 1, "the lane remembers a spent account for a moment");
    const refused = lines.find((l) => l.event === "refused");
    assert.ok(refused, "the refusal is logged"); assert.match(String(refused!.fields.said), /credit balance/); assert.equal(JSON.stringify(lines).includes("sk-primary-secret"), false);
  });
});

test("a request the provider refuses as malformed is LOGGED with what it said (it never was), and ends as `bad_request`", async () => {
  await withEnv({}, async () => {
    const lines: { event: string; fields: Record<string, unknown> }[] = [];
    setProviderLogger((event, fields) => lines.push({ event, fields }));
    serve(() => status(400, '{"error":{"message":"messages.1.content: Input should be a valid string"}}'));
    const e = await completeJson("sys", "user", 100, fast).catch((x) => x) as ProviderError;
    assert.equal(e.kind, "bad_request");
    const refused = lines.find((l) => l.event === "refused" && l.fields.kind === "bad_request");
    assert.ok(refused); assert.match(String(refused!.fields.said), /Input should be a valid string/); assert.equal(refused!.fields.status, 400);
  });
});

test("probeProvider: names the refused request — credit, key, schema, ceiling — and costs a few tokens", async () => {
  const { probeProvider } = await import("./index.js");
  await withEnv({}, async () => {
    serve(() => status(400, ANTHROPIC_CREDIT));
    const r = await probeProvider({ maxTokens: 32000 });
    assert.equal(r.plain?.ok, false); assert.equal(r.plain?.kind, "quota_exhausted"); assert.match(r.verdict, /out of credit/i); assert.equal(r.schema, undefined, "nothing further is asked of an account that cannot answer");
  });
  await withEnv({}, async () => {
    serve((_u, init) => { const b = JSON.parse(init.body); return b.response_format?.type === "json_schema" ? status(400, "response_format.json_schema: additionalProperties must be false") : reply('{"ok":true}'); });
    const r = await probeProvider({ maxTokens: 32000 });
    assert.equal(r.plain?.ok, true); assert.equal(r.schema?.ok, true, "a provider that refuses a schema is asked again without one, as the copilot does"); assert.match(r.verdict, /accepted every kind/);
  });
  await withEnv({}, async () => {
    serve(() => status(401, "invalid x-api-key"));
    const r = await probeProvider(); assert.equal(r.plain?.kind, "auth"); assert.match(r.verdict, /key/);
  });
  await withEnv({ AI_API_URL: "" }, async () => { assert.equal((await probeProvider()).configured, false); });
});

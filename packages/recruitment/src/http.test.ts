import test from "node:test";
import assert from "node:assert/strict";
import {
  vendorFetch, mayRetry, parseRetryAfter, backoffMs, breakerStatus, resetBreakers,
  BREAKER_THRESHOLD, BREAKER_COOLDOWN_MS, type CallRecord,
} from "./http.js";
import { AdapterError } from "./adapter.js";

/** A fetch that answers from a script, and counts what it was asked. */
function scripted(responses: Array<{ status: number; body?: unknown; headers?: Record<string, string> } | "throw">) {
  const calls: Array<{ method: string; body: unknown }> = [];
  let i = 0;
  const impl = (async (_url: string, init?: RequestInit) => {
    calls.push({ method: init?.method ?? "GET", body: init?.body ?? null });
    const r = responses[Math.min(i++, responses.length - 1)];
    if (r === "throw") throw Object.assign(new Error("socket hang up"), { name: "FetchError" });
    const text = typeof r.body === "string" ? r.body : JSON.stringify(r.body ?? {});
    return new Response(text, {
      status: r.status,
      headers: { "content-type": "application/json", ...(r.headers ?? {}) },
    });
  }) as unknown as typeof fetch;
  return { impl, calls };
}

const fast = { random: () => 0 };   // no jitter wait in tests

test.beforeEach(() => resetBreakers());

test("a read is retried and eventually succeeds", async () => {
  const { impl, calls } = scripted([{ status: 503 }, { status: 503 }, { status: 200, body: { ok: 1 } }]);
  const res = await vendorFetch("v1", "feasibility", { url: "https://api.example.test/feasibility", retry: "safe" },
    { fetchImpl: impl, ...fast });
  assert.equal(res.status, 200);
  assert.equal(res.attempts, 3);
  assert.equal(calls.length, 3);
});

test("an order with no idempotency key is NEVER retried — the one bug that buys sample twice", async () => {
  const { impl, calls } = scripted(["throw", { status: 200, body: { id: "o1" } }]);
  await assert.rejects(
    () => vendorFetch("v1", "createOrder",
      { url: "https://api.example.test/orders", method: "POST", body: { n: 100 }, retry: "never" },
      { fetchImpl: impl, ...fast }),
    (e: unknown) => e instanceof AdapterError,
  );
  assert.equal(calls.length, 1, "exactly one attempt reached the vendor");
});

test("…and the error says the order's state is UNKNOWN, not that it failed", async () => {
  const { impl } = scripted(["throw"]);
  await assert.rejects(
    () => vendorFetch("v1", "createOrder",
      { url: "https://api.example.test/orders", method: "POST", body: {}, retry: "never" },
      { fetchImpl: impl, ...fast }),
    (e: unknown) => /may or may not have been accepted/.test((e as Error).message),
  );
});

test("an order WITH an idempotency key may be retried, because the key makes it safe", async () => {
  const { impl, calls } = scripted(["throw", { status: 200, body: { id: "o1" } }]);
  const res = await vendorFetch("v1", "createOrder",
    { url: "https://api.example.test/orders", method: "POST", body: {}, retry: "idempotent" },
    { fetchImpl: impl, ...fast });
  assert.equal(res.ok, true);
  assert.equal(calls.length, 2);
});

test("a caller marking a write as 'safe' is refused rather than obeyed", () => {
  assert.equal(mayRetry("safe", 503, "POST"), false, "the policy is wrong; do not honour it");
  assert.equal(mayRetry("safe", 503, "GET"), true);
  assert.equal(mayRetry("idempotent", 503, "POST"), true);
  assert.equal(mayRetry("never", 503, "GET"), false);
});

test("a 4xx is not retried — repeating our own bad request wastes the vendor's rate limit", async () => {
  const { impl, calls } = scripted([{ status: 400, body: { error: "bad audience" } }]);
  await assert.rejects(() => vendorFetch("v1", "feasibility",
    { url: "https://api.example.test/f", retry: "safe" }, { fetchImpl: impl, ...fast }));
  assert.equal(calls.length, 1);
});

test("Retry-After is obeyed, in both forms, and an absurd one is ignored", () => {
  const now = Date.parse("2026-11-03T12:00:00Z");
  assert.equal(parseRetryAfter("30", now), 30_000);
  assert.equal(parseRetryAfter("Tue, 03 Nov 2026 12:00:45 GMT", now), 45_000);
  assert.equal(parseRetryAfter("7200", now), null, "two hours is not a retry, it is an outage");
  assert.equal(parseRetryAfter("not a number", now), null);
  assert.equal(parseRetryAfter(null, now), null);
});

test("backoff is jittered, never a fixed ladder", () => {
  // full jitter: the wait is somewhere in [0, ceiling), not the ceiling itself
  assert.equal(backoffMs(1, () => 0), 0);
  assert.equal(backoffMs(1, () => 0.999), 999);
  assert.equal(backoffMs(3, () => 0), 0);
  assert.ok(backoffMs(3, () => 0.5) < 4000 && backoffMs(3, () => 0.5) >= 2000);
  assert.ok(backoffMs(20, () => 0.99) <= 30_000, "the ceiling is capped");
});

test("the breaker opens after repeated vendor failures and then refuses without calling out", async () => {
  const { impl, calls } = scripted([{ status: 500 }]);
  for (let i = 0; i < BREAKER_THRESHOLD; i++) {
    await assert.rejects(() => vendorFetch("v-break", "feasibility",
      { url: "https://api.example.test/f", retry: "safe", maxAttempts: 1 }, { fetchImpl: impl, ...fast }));
  }
  const before = calls.length;
  const status = await breakerStatus("v-break");
  assert.equal(status.open, true);

  await assert.rejects(
    () => vendorFetch("v-break", "feasibility", { url: "https://api.example.test/f" }, { fetchImpl: impl, ...fast }),
    (e: unknown) => /calls to it are paused/.test((e as Error).message),
  );
  assert.equal(calls.length, before, "the refused call never touched the network");
});

test("a 400 does NOT trip the breaker — our bug must not take a working vendor offline", async () => {
  const { impl } = scripted([{ status: 400 }]);
  for (let i = 0; i < BREAKER_THRESHOLD + 2; i++) {
    await assert.rejects(() => vendorFetch("v-ours", "feasibility",
      { url: "https://api.example.test/f", retry: "safe", maxAttempts: 1 }, { fetchImpl: impl, ...fast }));
  }
  assert.equal((await breakerStatus("v-ours")).open, false);
});

test("the breaker half-opens after the cooldown", async () => {
  const { impl } = scripted([{ status: 500 }]);
  let clock = 1_000_000;
  const opts = { fetchImpl: impl, now: () => clock, ...fast };
  for (let i = 0; i < BREAKER_THRESHOLD; i++) {
    await assert.rejects(() => vendorFetch("v-cool", "f",
      { url: "https://api.example.test/f", retry: "safe", maxAttempts: 1 }, opts));
  }
  assert.equal((await breakerStatus("v-cool", opts)).open, true);
  clock += BREAKER_COOLDOWN_MS + 1;
  const after = await breakerStatus("v-cool", opts);
  assert.equal(after.open, false);
  assert.equal(after.halfOpen, true);
});

test("a success closes the breaker rather than leaving the count to decay", async () => {
  const { impl } = scripted([{ status: 500 }, { status: 500 }, { status: 200, body: {} }]);
  const opts = { fetchImpl: impl, ...fast };
  for (let i = 0; i < 2; i++) {
    await assert.rejects(() => vendorFetch("v-heal", "f",
      { url: "https://api.example.test/f", retry: "safe", maxAttempts: 1 }, opts));
  }
  await vendorFetch("v-heal", "f", { url: "https://api.example.test/f", retry: "safe" }, opts);
  assert.equal((await breakerStatus("v-heal", opts)).failures, 0);
});

test("every call is recorded, and the record carries no query string", async () => {
  const rows: CallRecord[] = [];
  const { impl } = scripted([{ status: 200, body: {} }]);
  await vendorFetch("v1", "orderStatus",
    { url: "https://api.example.test/orders/o1/status?participant=p_1234&token=secret", retry: "safe" },
    { fetchImpl: impl, record: (r) => { rows.push(r); }, ...fast });
  assert.equal(rows.length, 1);
  assert.equal(rows[0].path, "/orders/o1/status");
  assert.ok(!JSON.stringify(rows[0]).includes("secret"), "a logged row must not carry a token");
  assert.ok(!JSON.stringify(rows[0]).includes("p_1234"), "nor a participant id");
});

test("a failure is recorded too, with the attempt count", async () => {
  const rows: CallRecord[] = [];
  const { impl } = scripted([{ status: 503 }]);
  await assert.rejects(() => vendorFetch("v1", "f",
    { url: "https://api.example.test/f", retry: "safe", maxAttempts: 2 },
    { fetchImpl: impl, record: (r) => { rows.push(r); }, ...fast }));
  assert.equal(rows[0].ok, false);
  assert.equal(rows[0].attempts, 2);
  assert.equal(rows[0].status, 503);
});

test("the caller's abort wins over our retry schedule", async () => {
  const ac = new AbortController();
  ac.abort();
  const { impl, calls } = scripted([{ status: 200, body: {} }]);
  await assert.rejects(
    () => vendorFetch("v1", "f", { url: "https://api.example.test/f", signal: ac.signal }, { fetchImpl: impl, ...fast }),
    (e: unknown) => /caller went away/.test((e as Error).message),
  );
  assert.equal(calls.length, 0);
});

test("a durable state store is used when given, so the breaker survives a cold process", async () => {
  const store = new Map<string, { failures: number; openedAt: number | null }>();
  const state = {
    get: async (k: string) => store.get(k) ?? null,
    set: async (k: string, v: { failures: number; openedAt: number | null }) => { store.set(k, v); },
  };
  const { impl } = scripted([{ status: 500 }]);
  for (let i = 0; i < BREAKER_THRESHOLD; i++) {
    await assert.rejects(() => vendorFetch("v-durable", "f",
      { url: "https://api.example.test/f", retry: "safe", maxAttempts: 1 }, { fetchImpl: impl, state, ...fast }));
  }
  resetBreakers();   // the in-process map is wiped, as a cold lambda would
  assert.equal((await breakerStatus("v-durable", { state })).open, true, "the store remembers what memory forgot");
});

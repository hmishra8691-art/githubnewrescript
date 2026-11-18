import { test } from "node:test";
import assert from "node:assert/strict";
import { SlidingWindowLimiter, readLimits, DEFAULT_LIMITS } from "./rateLimit.ts";

test("limits read from the environment: defaults, overrides, off", () => {
  assert.deepEqual(readLimits({}), DEFAULT_LIMITS);
  assert.deepEqual(readLimits({ RUNTIME_RATE_LIMIT: "start=10, save=50" }), { start: 10, save: 50, entry: DEFAULT_LIMITS.entry });
  assert.deepEqual(readLimits({ RUNTIME_RATE_LIMIT: "start=abc,bogus=3" }), DEFAULT_LIMITS, "nonsense keeps the defaults");
  assert.equal(readLimits({ RUNTIME_RATE_LIMIT: "off" }), null);
});

test("a flood from one address is refused with a retry time; other addresses and routes are untouched; the window slides", () => {
  let now = 1_000_000;
  const l = new SlidingWindowLimiter({ start: 3, save: 5, entry: 3 }, () => now);
  for (let i = 0; i < 3; i++) assert.equal(l.check("start", "1.1.1.1").ok, true);
  const r = l.check("start", "1.1.1.1");
  assert.equal(r.ok, false);
  assert.ok(!r.ok && r.retryAfter >= 1 && r.retryAfter <= 60);
  assert.equal(l.check("start", "2.2.2.2").ok, true, "another connection");
  assert.equal(l.check("save", "1.1.1.1").ok, true, "another route");
  now += 61_000;
  assert.equal(l.check("start", "1.1.1.1").ok, true, "a minute later the window has moved on");
});

test("memory stays bounded however many addresses arrive", () => {
  const l = new SlidingWindowLimiter({ start: 1, save: 1, entry: 1 });
  for (let i = 0; i < 25_000; i++) l.check("start", `10.0.${i >> 8}.${i & 255}-${i}`);
  assert.ok(l.size <= 20_000);
});

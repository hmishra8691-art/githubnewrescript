import { test } from "node:test";
import assert from "node:assert/strict";
import { KeyRateLimiter, bearerKey, cleanScopes, decodeCursor, encodeCursor, hashApiKey, newApiKey } from "./apiKeysCore.ts";

test("keys: 160 random bits, shown once, stored as a hash; only a well-formed bearer key is read", () => {
  const a = newApiKey(), b = newApiKey();
  assert.match(a.key, /^rsk_[a-z2-7]{32}$/);
  assert.notEqual(a.key, b.key);
  assert.equal(a.hash, hashApiKey(a.key));
  assert.ok(!a.hash.includes(a.key.slice(4, 12)) && a.prefix === a.key.slice(0, 10));
  assert.equal(bearerKey(`Bearer ${a.key}`), a.key);
  assert.equal(bearerKey(`bearer   ${a.key} `), a.key);
  assert.equal(bearerKey(a.key), null, "the scheme is required");
  assert.equal(bearerKey("Bearer rsk_short"), null);
  assert.equal(bearerKey("Bearer eyJhbGciOi.x.y"), null, "a session token is not an API key");
});

test("scopes: only the known ones, at least one", () => {
  assert.deepEqual(cleanScopes(["responses:read", "surveys:read", "responses:read"]), ["responses:read", "surveys:read"]);
  assert.equal(cleanScopes([]), null);
  assert.equal(cleanScopes(["responses:write"]), null);
  assert.equal(cleanScopes("surveys:read"), null);
});

test("rate limit: per key, per minute, sliding; a busy key does not slow another", () => {
  const rl = new KeyRateLimiter(3);
  const t = 1_000_000;
  for (let i = 0; i < 3; i++) assert.equal(rl.take("k1", t + i), null);
  const wait = rl.take("k1", t + 10);
  assert.ok(wait && wait >= 59 && wait <= 60, String(wait));
  assert.equal(rl.take("k2", t + 10), null);
  assert.equal(rl.take("k1", t + 60_001), null, "the window slides");
});

test("cursors round-trip and refuse anything else", () => {
  const c = encodeCursor("2026-11-18T10:00:00.000Z", "8f14e45f-ceea-467a-9b36-0d1f3c1e2a11");
  assert.deepEqual(decodeCursor(c), { startedAt: "2026-11-18T10:00:00.000Z", id: "8f14e45f-ceea-467a-9b36-0d1f3c1e2a11" });
  assert.equal(decodeCursor("not-a-cursor"), null);
  assert.equal(decodeCursor(Buffer.from(JSON.stringify(["x", "1; drop table"])).toString("base64url")), null);
});

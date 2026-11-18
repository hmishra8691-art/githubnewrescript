import { test } from "node:test";
import assert from "node:assert/strict";
import { challengeConfig, challengeRequired, verifyChallenge } from "./botChallenge.ts";
import { buildRuntimeCsp, connectSources } from "./csp.ts";

const cfg = { siteKey: "site", secret: "sec" };
const reply = (status: number, body: unknown) => async (_url: string, init: { body: string }) => { (reply as any).last = init.body; return { ok: status < 400, status, json: async () => body }; };

test("off without both keys; required only for live, new, open-link starts of a study that asked for it", () => {
  assert.equal(challengeConfig({}), null);
  assert.equal(challengeConfig({ TURNSTILE_SITE_KEY: "a" }), null);
  assert.deepEqual(challengeConfig({ TURNSTILE_SITE_KEY: " a ", TURNSTILE_SECRET_KEY: "b" }), { siteKey: "a", secret: "b" });
  const base = { enabled: true, isTest: false, resuming: false, accessMode: "open", config: cfg };
  assert.equal(challengeRequired(base), true);
  assert.equal(challengeRequired({ ...base, enabled: undefined }), false, "the study did not switch it on");
  assert.equal(challengeRequired({ ...base, config: null }), false, "no keys on this runtime: never locks a study out");
  assert.equal(challengeRequired({ ...base, isTest: true }), false);
  assert.equal(challengeRequired({ ...base, resuming: true }), false);
  assert.equal(challengeRequired({ ...base, accessMode: "unique_links" }), false);
});

test("verify: a good token passes, a bad one is refused with Cloudflare's reason, no token never calls out", async () => {
  assert.deepEqual(await verifyChallenge("tok", "1.2.3.4", cfg, reply(200, { success: true }) as never), { ok: true });
  assert.match((reply as any).last, /secret=sec&response=tok&remoteip=1.2.3.4/);
  assert.deepEqual(await verifyChallenge("tok", null, cfg, reply(200, { success: false, "error-codes": ["timeout-or-duplicate"] }) as never), { ok: false, reason: "timeout-or-duplicate" });
  let called = false;
  assert.deepEqual(await verifyChallenge("", null, cfg, (async () => { called = true; return null; }) as never), { ok: false, reason: "missing" });
  assert.equal(called, false);
});

test("verify fails open, and says so, when Cloudflare is down or our own secret is wrong", async () => {
  const down = await verifyChallenge("tok", null, cfg, (async () => { throw new Error("ECONNRESET"); }) as never);
  assert.equal(down.ok, true); assert.match((down as { unverified: string }).unverified, /unreachable \(ECONNRESET\)/);
  const http = await verifyChallenge("tok", null, cfg, reply(503, {}) as never);
  assert.equal(http.ok, true); assert.match((http as { unverified: string }).unverified, /HTTP 503/);
  const ours = await verifyChallenge("tok", null, cfg, reply(200, { success: false, "error-codes": ["invalid-input-secret"] }) as never);
  assert.equal(ours.ok, true); assert.match((ours as { unverified: string }).unverified, /TURNSTILE_SECRET_KEY was refused/);
  const slow = await verifyChallenge("tok", null, cfg, ((_u: string, init: { signal: AbortSignal }) => new Promise((_, rej) => init.signal.addEventListener("abort", () => rej(Object.assign(new Error("x"), { name: "AbortError" }))))) as never, 20);
  assert.match((slow as { unverified: string }).unverified, /timeout/);
});

test("CSP: Cloudflare's challenge origin is allowed only when the keys are set", () => {
  assert.ok(!connectSources({}).includes("https://challenges.cloudflare.com"));
  const env = { TURNSTILE_SITE_KEY: "a", TURNSTILE_SECRET_KEY: "b" };
  assert.ok(connectSources(env).includes("https://challenges.cloudflare.com"));
  assert.match(buildRuntimeCsp(env).reportOnly!, /script-src 'self' https:\/\/challenges\.cloudflare\.com/);
});

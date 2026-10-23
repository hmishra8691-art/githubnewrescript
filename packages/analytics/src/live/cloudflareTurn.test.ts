import { test } from "node:test";
import assert from "node:assert/strict";
import { cloudflareTurnConfig, iceServersFor, readCloudflareIce, turnStatus, TURN_WARNING } from "./credentials.js";

/* CLOUDFLARE TURN (2026-10-23): credentials minted per person through Cloudflare's API, never static; port 53 dropped;
 * a failure falls back to the other settings with a warning; the token never leaves the server. */

const ENV = { CLOUDFLARE_TURN_KEY_ID: "30b49f03451ffc8d43d2c0ce284704f1", CLOUDFLARE_TURN_API_TOKEN: "test-token-not-real" };
const ANSWER = {
  iceServers: [{
    urls: ["stun:stun.cloudflare.com:3478", "stun:stun.cloudflare.com:53", "turn:turn.cloudflare.com:3478?transport=udp", "turn:turn.cloudflare.com:53?transport=udp", "turn:turn.cloudflare.com:3478?transport=tcp", "turns:turn.cloudflare.com:5349?transport=tcp", "turn:turn.cloudflare.com:80?transport=tcp", "turns:turn.cloudflare.com:443?transport=tcp"],
    username: "u-123", credential: "c-456",
  }],
};

test("configured only with both the key id and the API token; it wins over the other TURN settings", () => {
  assert.equal(cloudflareTurnConfig({}), null);
  assert.equal(cloudflareTurnConfig({ CLOUDFLARE_TURN_KEY_ID: ENV.CLOUDFLARE_TURN_KEY_ID }), null);
  assert.equal(cloudflareTurnConfig({ ...ENV, CLOUDFLARE_TURN_KEY_ID: "bad id/../x" }), null, "a key id that is not an id is refused");
  assert.equal(cloudflareTurnConfig(ENV)!.ttl, 21600);
  assert.equal(cloudflareTurnConfig({ ...ENV, WEBRTC_TURN_TTL_SECONDS: "86400" })!.ttl, 86400);
  assert.equal(turnStatus({ ...ENV, WEBRTC_TURN_URLS: "turn:x.org:3478", WEBRTC_TURN_SECRET: "s" }).mode, "cloudflare");
});

test("the answer is read in both shapes, port 53 dropped", () => {
  const s = readCloudflareIce(ANSWER);
  assert.equal(s.length, 1);
  assert.ok(!s[0].urls.some((u) => /:53\b/.test(u)), s[0].urls.join(" "));
  assert.equal(s[0].urls.length, 6);
  assert.equal(s[0].username, "u-123");
  const old = readCloudflareIce({ iceServers: { urls: "turn:turn.cloudflare.com:3478", username: "a", credential: "b" } });
  assert.deepEqual(old, [{ urls: ["turn:turn.cloudflare.com:3478"], username: "a", credential: "b" }]);
  assert.deepEqual(readCloudflareIce({ iceServers: [{ urls: ["https://evil.example/x"] }] }), [], "only stun:/turn: addresses");
  assert.deepEqual(readCloudflareIce(null), []);
});

test("minting: the documented request — POST, bearer token, {ttl}, the key's generate-ice-servers path", async () => {
  let seen: { url: string; init: RequestInit } | null = null;
  const fetchImpl = (async (url: string, init: RequestInit) => { seen = { url, init }; return new Response(JSON.stringify(ANSWER), { status: 201, headers: { "content-type": "application/json" } }); }) as unknown as typeof fetch;
  const now = Date.UTC(2026, 9, 23, 12, 0);
  const c = await iceServersFor(ENV, { identity: "m1", now, fetchImpl });
  assert.equal(seen!.url, "https://rtc.live.cloudflare.com/v1/turn/keys/30b49f03451ffc8d43d2c0ce284704f1/credentials/generate-ice-servers");
  assert.equal(seen!.init.method, "POST");
  assert.equal((seen!.init.headers as Record<string, string>).authorization, "Bearer test-token-not-real");
  assert.deepEqual(JSON.parse(String(seen!.init.body)), { ttl: 21600 });
  assert.equal(c.turn, "cloudflare");
  assert.equal(c.warning, undefined);
  assert.equal(c.expiresAt, new Date(now + 21600 * 1000).toISOString());
  assert.ok(!JSON.stringify(c).includes("test-token-not-real"), "the API token never reaches the browser");
});

test("Cloudflare failing (401, no credentials, network) falls back to the other settings, with a warning", async () => {
  const fail401 = (async () => new Response("{}", { status: 401 })) as unknown as typeof fetch;
  const a = await iceServersFor(ENV, { identity: "m1", fetchImpl: fail401 });
  assert.equal(a.turn, "none");
  assert.match(a.warning!, /Cloudflare TURN credentials could not be minted \(Cloudflare TURN answered 401\)/);
  assert.ok(a.warning!.includes(TURN_WARNING));
  assert.ok(a.iceServers.some((s) => s.urls.some((u) => u.startsWith("stun:"))), "STUN still offered");
  const noCreds = (async () => new Response(JSON.stringify({ iceServers: [{ urls: ["stun:stun.cloudflare.com:3478"] }] }), { status: 201 })) as unknown as typeof fetch;
  const b = await iceServersFor({ ...ENV, WEBRTC_TURN_URLS: "turn:backup.example.org:3478", WEBRTC_TURN_USERNAME: "u", WEBRTC_TURN_CREDENTIAL: "p" }, { identity: "m1", fetchImpl: noCreds });
  assert.equal(b.turn, "static", "a configured backup TURN server is used");
  assert.match(b.warning!, /without relay credentials/);
  const offline = (async () => { throw new TypeError("fetch failed"); }) as unknown as typeof fetch;
  const c = await iceServersFor(ENV, { identity: "m1", fetchImpl: offline });
  assert.equal(c.turn, "none");
});

test("without Cloudflare the earlier behaviour is unchanged", async () => {
  const c = await iceServersFor({ WEBRTC_TURN_URLS: "turn:x.org:3478", WEBRTC_TURN_USERNAME: "u", WEBRTC_TURN_CREDENTIAL: "p" }, { identity: "m1", fetchImpl: (async () => { throw new Error("must not be called"); }) as unknown as typeof fetch });
  assert.equal(c.turn, "static");
});

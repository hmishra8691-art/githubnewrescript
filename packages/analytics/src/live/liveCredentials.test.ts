import { test } from "node:test";
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { iceServers, turnRestCredential, turnStatus, livekitToken, livekitConfig, verifyHs256, signHs256, inviteToken, linkSecret, sha256Hex, TURN_WARNING } from "./credentials.js";

/* LIVE-SESSION CREDENTIALS (2026-10-22, G2): TURN REST credentials (checked against an independent openssl
 * vector), static TURN, STUN defaults, the honest warning without TURN, the LiveKit JWT's shape and signature,
 * derived invitation links. */

test("TURN REST credential: username = expiry:identity, credential = base64(HMAC-SHA1(secret, username)) — the coturn scheme", () => {
  /* echo -n "1793000000:m-abc" | openssl dgst -sha1 -hmac "turn-shared-secret" -binary | base64 */
  assert.deepEqual(turnRestCredential("turn-shared-secret", "m-abc", 1793000000), { username: "1793000000:m-abc", credential: "amcgzUgU/L6IH8OYBn6ij5/jagU=" });
  assert.equal(turnRestCredential("s", "a b/c;d", 1).username, "1:abcd", "the identity is reduced to safe characters");
  const now = Date.UTC(2026, 9, 27, 12, 0);
  const c = iceServers({ WEBRTC_TURN_URLS: "turn:turn.example.org:3478?transport=udp, turns:turn.example.org:5349", WEBRTC_TURN_SECRET: "turn-shared-secret", WEBRTC_TURN_TTL_SECONDS: "3600" }, { identity: "m-abc", now });
  assert.equal(c.turn, "rest");
  assert.deepEqual(c.iceServers[0], { urls: ["stun:stun.l.google.com:19302"] });
  const t = c.iceServers[1];
  assert.deepEqual(t.urls, ["turn:turn.example.org:3478?transport=udp", "turns:turn.example.org:5349"]);
  assert.equal(t.username, `${now / 1000 + 3600}:m-abc`);
  assert.equal(t.credential, createHmac("sha1", "turn-shared-secret").update(t.username!).digest("base64"));
  assert.equal(c.expiresAt, new Date(now + 3600_000).toISOString());
  assert.equal(c.warning, undefined);
});

test("static TURN, STUN overrides, and the honest warning when there is no TURN", () => {
  const s = iceServers({ WEBRTC_TURN_URLS: "turn:t.example.org:3478", WEBRTC_TURN_USERNAME: "u", WEBRTC_TURN_CREDENTIAL: "p", WEBRTC_STUN_URLS: "stun:s.example.org:3478" }, { identity: "x" });
  assert.equal(s.turn, "static");
  assert.deepEqual(s.iceServers, [{ urls: ["stun:s.example.org:3478"] }, { urls: ["turn:t.example.org:3478"], username: "u", credential: "p" }]);
  const none = iceServers({}, { identity: "x" });
  assert.equal(none.turn, "none"); assert.equal(none.warning, TURN_WARNING);
  assert.match(TURN_WARNING, /corporate firewalls or on some mobile networks will not be able to connect/);
  assert.deepEqual(iceServers({ WEBRTC_STUN_URLS: "none" }, { identity: "x" }).iceServers, []);
  assert.equal(turnStatus({ WEBRTC_TURN_URLS: "turn:t:1" }).mode, "none", "URLs without credentials are not a relay");
  assert.equal(turnStatus({ WEBRTC_TURN_URLS: "http://not-turn" }).urls, 0);
});

test("LiveKit access token: an HS256 JWT with iss = API key, sub = identity, a video grant; verifiable, tamper-evident, expiring", () => {
  assert.equal(livekitConfig({ LIVEKIT_URL: "wss://lk.example.org", LIVEKIT_API_KEY: "k" }), null);
  const cfg = livekitConfig({ LIVEKIT_URL: "wss://lk.example.org", LIVEKIT_API_KEY: "APIkey123", LIVEKIT_API_SECRET: "lk-secret-0123456789" })!;
  assert.equal(cfg.clientUrl, null);
  const now = Date.UTC(2026, 9, 27, 12, 0);
  const jwt = livekitToken(cfg, { identity: "member-1", name: "P1", room: "room-9", canPublish: true, ttlSeconds: 7200, now });
  const [h, p, sig] = jwt.split(".");
  assert.equal(h, "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9");
  assert.equal(sig, createHmac("sha256", "lk-secret-0123456789").update(`${h}.${p}`).digest("base64url"));
  const payload = JSON.parse(Buffer.from(p, "base64url").toString());
  assert.deepEqual(payload, { iss: "APIkey123", sub: "member-1", jti: "member-1", nbf: now / 1000, exp: now / 1000 + 7200, name: "P1", video: { room: "room-9", roomJoin: true, canPublish: true, canSubscribe: true, canPublishData: true, hidden: false } });
  assert.deepEqual(verifyHs256(jwt, "lk-secret-0123456789", now / 1000 + 10), payload);
  assert.equal(verifyHs256(jwt, "wrong", now / 1000), null);
  assert.equal(verifyHs256(`${h}.${Buffer.from(JSON.stringify({ ...payload, video: { ...payload.video, canPublish: true, hidden: true } })).toString("base64url")}.${sig}`, "lk-secret-0123456789", now / 1000), null, "tampered");
  assert.equal(verifyHs256(jwt, "lk-secret-0123456789", now / 1000 + 7201), null, "expired");
  const observer = JSON.parse(Buffer.from(livekitToken(cfg, { identity: "o", name: "Observer 1", room: "room-9", canPublish: false, hidden: true, now }).split(".")[1], "base64url").toString());
  assert.deepEqual([observer.video.canPublish, observer.video.hidden], [false, true]);
  assert.equal(verifyHs256(signHs256({ a: 1 }, "s").replace(/^[^.]+/, Buffer.from(JSON.stringify({ alg: "none" })).toString("base64url")), "s"), null, "alg none is refused");
});

test("invitation links are derived (shown again later), hashed in the database, and change with the link version", () => {
  const t1 = inviteToken("secret-0123456789abcdef", "inv-1", 1);
  assert.match(t1, /^[A-Za-z0-9_-]{43}$/);
  assert.equal(inviteToken("secret-0123456789abcdef", "inv-1", 1), t1);
  assert.notEqual(inviteToken("secret-0123456789abcdef", "inv-1", 2), t1);
  assert.notEqual(inviteToken("secret-0123456789abcdef", "inv-2", 1), t1);
  assert.equal(sha256Hex(t1).length, 64);
  assert.equal(linkSecret({ LIVE_LINK_SECRET: "short" }), null);
  assert.equal(linkSecret({ LIVE_LINK_SECRET: "a-long-enough-secret" }), "a-long-enough-secret");
  const derived = linkSecret({ SUPABASE_SERVICE_ROLE_KEY: "svc" })!;
  assert.match(derived, /^[0-9a-f]{64}$/); assert.ok(!derived.includes("svc"));
});

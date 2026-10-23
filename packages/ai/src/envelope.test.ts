import test from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { sealEnvelope, openEnvelope, envelopeStatus, deriveKey, maskSecretUrl, EnvelopeError } from "./envelope.js";

const K1 = randomBytes(32).toString("hex"), K2 = randomBytes(32).toString("base64");
const URL1 = "https://hooks.slack.com/services/T000/B000/abcdefghijklmnopqrstuvwx";

test("seal → open round trip; the blob holds no plaintext; AAD binds the row", () => {
  const env = { INTEGRATIONS_SECRET_KEY: K1 };
  const { sealed, keyId } = sealEnvelope(URL1, "notify-channel|org1|ch1", env);
  assert.match(keyId, /^[0-9a-f]{12}$/);
  assert.ok(!sealed.includes("hooks.slack.com") && !sealed.includes("abcdefgh"));
  assert.equal(openEnvelope(sealed, "notify-channel|org1|ch1", env), URL1);
  assert.throws(() => openEnvelope(sealed, "notify-channel|org2|ch1", env), (e: unknown) => e instanceof EnvelopeError && e.code === "cannot_open", "another row's AAD fails");
  const t = JSON.parse(sealed); t.c = Buffer.from(Buffer.from(t.c, "base64").map((b, i) => (i === 0 ? b ^ 1 : b))).toString("base64");
  assert.throws(() => openEnvelope(JSON.stringify(t), "notify-channel|org1|ch1", env), /could not be opened/, "tampering fails");
});

test("no key: nothing sealed, honestly; a bad key is named; rotation keeps old blobs readable", () => {
  assert.throws(() => sealEnvelope("x", "a", {}), (e: unknown) => e instanceof EnvelopeError && e.code === "not_configured");
  assert.equal(envelopeStatus({}).ready, false);
  assert.match(envelopeStatus({ INTEGRATIONS_SECRET_KEY: "short" }).reason ?? "", /32 random bytes/);
  const old = sealEnvelope("s3cret", "panel|s|cint", { INTEGRATIONS_SECRET_KEY: K1 });
  assert.equal(openEnvelope(old.sealed, "panel|s|cint", { INTEGRATIONS_SECRET_KEY: K2, INTEGRATIONS_SECRET_KEY_PREVIOUS: K1 }), "s3cret");
  assert.throws(() => openEnvelope(old.sealed, "panel|s|cint", { INTEGRATIONS_SECRET_KEY: K2 }), /not available/);
  const sandbox = randomBytes(32);
  assert.equal(openEnvelope(sealEnvelope("x", "a", {}, sandbox).sealed, "a", {}, sandbox), "x", "a sandbox key stands in only when passed");
});

test("derived keys are per purpose and need the master key; masking shows host and four characters", () => {
  const a = deriveKey("notify-ingest", { INTEGRATIONS_SECRET_KEY: K1 })!, b = deriveKey("other", { INTEGRATIONS_SECRET_KEY: K1 })!;
  assert.equal(a.length, 32); assert.notDeepEqual(a, b);
  assert.equal(deriveKey("notify-ingest", {}), null);
  assert.equal(maskSecretUrl(URL1), "hooks.slack.com/…/••••uvwx");
  assert.doesNotMatch(maskSecretUrl(URL1), /T000|B000|abcdefgh/);
});

test("signed requests: a receiver verifies t=…,v1=…; a changed body, another key or an old timestamp fail", async () => {
  const { signedHeader, verifySignedHeader } = await import("./envelope.js");
  const body = JSON.stringify({ type: "ai_interview.distress", id: "e1" });
  const now = Date.UTC(2026, 9, 22, 10, 0, 0);
  const h = signedHeader("whsec_test", body, now);
  assert.match(h, /^t=1792663200,v1=[0-9a-f]{64}$/);
  /* the receiver's side, as a webhook consumer would write it: HMAC-SHA256(secret, `${t}.${rawBody}`) */
  const { createHmac } = await import("node:crypto");
  assert.equal(h.split("v1=")[1], createHmac("sha256", "whsec_test").update(`1792663200.${body}`).digest("hex"));
  assert.ok(verifySignedHeader("whsec_test", h, body, now + 60_000));
  assert.ok(!verifySignedHeader("whsec_test", h, body.replace("e1", "e2"), now));
  assert.ok(!verifySignedHeader("other", h, body, now));
  assert.ok(!verifySignedHeader("whsec_test", h, body, now + 301_000), "older than five minutes: a replay");
  assert.ok(!verifySignedHeader("whsec_test", "garbage", body, now));
});

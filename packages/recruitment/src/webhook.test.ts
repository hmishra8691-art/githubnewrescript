import test from "node:test";
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { verifyWebhook, webhookIdempotencyKey, normaliseEvent, WEBHOOK_WINDOW_MS } from "./webhook.js";

const SECRET = "whsec_test_secret";
const NOW = 1_793_000_000_000;
const ts = String(Math.floor(NOW / 1000));

const sign = (timestamp: string, body: string, secret = SECRET) =>
  createHmac("sha256", secret).update(`${timestamp}${body}`).digest("base64");

const deliver = (over: Partial<{ body: string; timestamp: string; signature: string; eventId: string | null; secret: string | null; now: number; vendor: string }> = {}) => {
  const body = over.body ?? '{"event_type":"submission.status.change","resource":{"study_id":"stu_1","participant_id":"p1","status":"APPROVED"}}';
  const timestamp = over.timestamp ?? ts;
  const eventId = over.eventId === undefined ? "evt_abc123" : over.eventId;
  return verifyWebhook({
    vendor: over.vendor ?? "prolific",
    rawBody: body,
    headers: {
      "x-prolific-request-signature": over.signature ?? sign(timestamp, body),
      "x-prolific-request-timestamp": timestamp,
      ...(eventId ? { "x-event-id": eventId } : {}),
    },
    secret: over.secret === undefined ? SECRET : over.secret,
    now: over.now ?? NOW,
  });
};

test("a correctly signed, fresh, identified event verifies", () => {
  const v = deliver();
  assert.equal(v.verdict, "verified");
  assert.equal(v.actionable, true);
  assert.equal(v.eventId, "evt_abc123");
});

test("a tampered body fails — the signature covers the bytes, not the shape", () => {
  const good = '{"amount":100}';
  const timestamp = ts;
  const v = verifyWebhook({
    vendor: "prolific", rawBody: '{"amount":100000}',
    headers: {
      "x-prolific-request-signature": sign(timestamp, good),
      "x-prolific-request-timestamp": timestamp, "x-event-id": "e1",
    },
    secret: SECRET, now: NOW,
  });
  assert.equal(v.verdict, "bad_signature");
  assert.equal(v.actionable, false);
});

test("a re-serialised body fails, which is why the route must read the RAW bytes", () => {
  // same JSON, different spacing — exactly what JSON.parse + JSON.stringify would produce
  const asSent = '{"a": 1, "b": 2}';
  const reSerialised = '{"a":1,"b":2}';
  const v = verifyWebhook({
    vendor: "prolific", rawBody: reSerialised,
    headers: {
      "x-prolific-request-signature": sign(ts, asSent),
      "x-prolific-request-timestamp": ts, "x-event-id": "e1",
    },
    secret: SECRET, now: NOW,
  });
  assert.equal(v.verdict, "bad_signature", "parsing before verifying silently breaks genuine events");
});

test("a captured request replayed later is refused, though its signature is still perfect", () => {
  const old = String(Math.floor((NOW - WEBHOOK_WINDOW_MS - 1000) / 1000));
  const v = deliver({ timestamp: old });
  assert.equal(v.verdict, "stale");
  assert.match(v.reason!, /seconds old/);
});

test("a timestamp in the future is refused too — that is how a replay is given a long life", () => {
  const future = String(Math.floor((NOW + WEBHOOK_WINDOW_MS + 60_000) / 1000));
  const v = deliver({ timestamp: future });
  assert.equal(v.verdict, "stale");
  assert.match(v.reason!, /in the future/);
});

test("ordinary clock drift inside the window is accepted in both directions", () => {
  assert.equal(deliver({ timestamp: String(Math.floor((NOW - 60_000) / 1000)) }).verdict, "verified");
  assert.equal(deliver({ timestamp: String(Math.floor((NOW + 60_000) / 1000)) }).verdict, "verified");
});

test("no configured secret REFUSES rather than accepting unsigned events", () => {
  const v = deliver({ secret: null });
  assert.equal(v.verdict, "no_secret");
  assert.equal(v.actionable, false);
  assert.match(v.reason!, /cannot be verified/);
});

test("a signed event with no event id is quarantined — nothing to de-duplicate on", () => {
  const v = deliver({ eventId: null });
  assert.equal(v.verdict, "malformed");
  assert.equal(v.actionable, false);
  assert.match(v.reason!, /cannot be de-duplicated/);
});

test("an unknown vendor is refused, never guessed at", () => {
  const v = deliver({ vendor: "some-new-panel" });
  assert.equal(v.actionable, false);
  assert.match(v.reason!, /No signing scheme is known/);
});

test("EVERY failure is reported with a reason — nothing is dropped silently", () => {
  for (const v of [
    deliver({ secret: null }), deliver({ signature: "wrong" }), deliver({ eventId: null }),
    deliver({ vendor: "nope" }), deliver({ timestamp: "not-a-number" }),
  ]) {
    assert.equal(v.actionable, false);
    assert.ok(v.reason && v.reason.length > 10, `a verdict needs a usable reason, got: ${v.reason}`);
  }
});

test("the idempotency key is scoped by vendor so two vendors cannot collide", () => {
  assert.equal(webhookIdempotencyKey("prolific", "evt_1"), "webhook:prolific:evt_1");
  assert.notEqual(webhookIdempotencyKey("prolific", "1"), webhookIdempotencyKey("cint", "1"));
});

test("normalising reads the few fields needed and invents nothing", () => {
  const e = normaliseEvent("prolific", {
    event_type: "submission.status.change",
    resource: { study_id: "stu_7", participant_id: "p9", status: "APPROVED" },
  });
  assert.deepEqual(e, { kind: "submission", vendorOrderRef: "stu_7", participantId: "p9", status: "APPROVED" });

  assert.deepEqual(normaliseEvent("prolific", { nonsense: true }),
    { kind: "unknown", vendorOrderRef: null, participantId: null, status: null });
  assert.equal(normaliseEvent("unknown-vendor", { study_id: "x" }).vendorOrderRef, null);
  assert.equal(normaliseEvent("prolific", null).kind, "unknown");
});

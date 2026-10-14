import { test } from "node:test";
import assert from "node:assert/strict";
import { describeFailure, failureFromError, failureFromReplyError, failureFromTransport, isTurnFailure } from "./failure.ts";

/* Phase 1: every failure of the model path has a code, a cause and a next step. */
test("every code has a title, a cause and at least one next step", () => {
  for (const code of ["not_configured", "wallet", "timeout", "provider", "capacity", "auth", "forbidden", "quota", "not_found", "interrupted", "network", "truncated", "unparseable", "empty", "unusable", "engine_unparsed", "internal_mode"] as const) {
    const f = describeFailure(code, "x");
    assert.equal(f.code, code);
    assert.ok(f.title.length > 8 && f.title === f.title.toUpperCase(), code);
    assert.ok(f.message.length > 20, code);
    assert.ok(f.next.length >= 1, code);
    assert.ok(isTurnFailure(f));
  }
  assert.ok(!isTurnFailure({ code: "nope", message: "", next: [] }));
  assert.ok(!isTurnFailure(null));
  /* Phase 6: internal mode is a cause of its own — not "no model configured" — and says where the switch is */
  const internal = describeFailure("internal_mode");
  assert.match(internal.title, /^INTERNAL MODE/);
  assert.match(internal.message, /nothing is sent to a language model/);
  assert.match(internal.next[0], /Workflow tab/);
});

test("a provider exception is read into the right code — and the card never quotes a status or a provider's words", () => {
  assert.equal(failureFromError("the analysis provider did not answer within 90 seconds").code, "timeout");
  assert.match(failureFromError("the analysis provider did not answer within 90 seconds").message, /90 seconds/);
  assert.equal(failureFromError("the analysis provider refused the request (404) model not found").code, "not_found");
  assert.equal(failureFromError("the analysis provider refused the request (401) invalid x-api-key").code, "auth");
  assert.equal(failureFromError("the analysis provider refused the request (403) nope").code, "forbidden");
  assert.equal(failureFromError("the analysis provider refused the request (400) bad").code, "provider");
  assert.equal(failureFromError("the analysis provider is rate-limiting requests (429) slow down").code, "capacity");
  assert.equal(failureFromError("the analysis provider is unavailable (503) x").code, "capacity");
  assert.equal(failureFromError("fetch failed").code, "network");
  assert.equal(failureFromError("getaddrinfo ENOTFOUND api.example").code, "network");
  assert.equal(failureFromError("something odd").code, "provider");
  for (const m of ["refused the request (401) sk-secret-body", "is rate-limiting requests (429) raw body", "refused the request (403) raw", "is unavailable (503) raw"]) {
    const f = failureFromError(`the analysis provider ${m}`);
    const text = JSON.stringify(f);
    assert.doesNotMatch(text, /\b(401|403|429|503)\b|raw body|sk-secret|\braw\b/, m);
  }
});

test("a structured ProviderError is read by its kind, with how long to wait", () => {
  const cap = failureFromError({ kind: "rate_limited", retryAfterMs: 12000, message: "x", status: 429 });
  assert.equal(cap.code, "capacity"); assert.equal(cap.retryable, true); assert.equal(cap.retryAfterMs, 12000);
  assert.match(cap.message, /Your work has been saved/);
  for (const [kind, code] of [["quota_exhausted", "quota"], ["auth", "auth"], ["forbidden", "forbidden"], ["not_found", "not_found"], ["overloaded", "capacity"], ["server", "capacity"], ["network", "network"], ["timeout", "timeout"], ["busy", "capacity"], ["bad_request", "provider"]] as const) {
    assert.equal(failureFromError({ kind, message: "" }).code, code, kind);
  }
  assert.equal(failureFromError({ kind: "auth", message: "" }).retryable, undefined, "a bad key is not retried by itself");
  assert.match(failureFromError({ kind: "auth", message: "" }).admin ?? "", /AI_API_KEY/);
  assert.match(failureFromError({ kind: "quota_exhausted", message: "" }).message, /nothing was charged to your wallet/);
});

test("a response that is not the JSON the server always sends is a temporary failure with the work safe, not a refusal", () => {
  assert.equal(failureFromTransport(504).code, "timeout");
  assert.equal(failureFromTransport(502).code, "capacity");
  assert.equal(failureFromTransport(0).code, "network");
  for (const st of [0, 502, 503, 504]) assert.doesNotMatch(failureFromTransport(st).title + failureFromTransport(st).message, /refused/i);
});

test("a reply error names the budget or quotes the prose", () => {
  const t = failureFromReplyError("truncated", { maxTokens: 8000, continuations: 2 });
  assert.equal(t.code, "truncated");
  assert.match(t.message, /8000 tokens, continued 2×/);
  assert.match(t.next.join(" "), /one block/i);
  const u = failureFromReplyError("unparseable", { sample: "Sure, I  would\nadd three questions" });
  assert.equal(u.code, "unparseable");
  assert.match(u.next.join(" "), /Sure, I would add three questions/);
  assert.equal(failureFromReplyError("empty").code, "empty");
});

test("not configured says what the engine reads and how to configure a model", () => {
  const f = describeFailure("not_configured");
  assert.match(f.message, /name their objects/);
  assert.match(f.next.join(" "), /AI_API_URL/);
  assert.match(f.next.join(" "), /Terminate if Q1 < 25/);
});

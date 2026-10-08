import { test } from "node:test";
import assert from "node:assert/strict";
import { describeFailure, failureFromError, failureFromReplyError, isTurnFailure } from "./failure.ts";

/* Phase 1: every failure of the model path has a code, a cause and a next step. */
test("every code has a title, a cause and at least one next step", () => {
  for (const code of ["not_configured", "wallet", "timeout", "provider", "network", "truncated", "unparseable", "empty", "unusable", "engine_unparsed"] as const) {
    const f = describeFailure(code, "x");
    assert.equal(f.code, code);
    assert.ok(f.title.length > 8 && f.title === f.title.toUpperCase(), code);
    assert.ok(f.message.length > 20, code);
    assert.ok(f.next.length >= 1, code);
    assert.ok(isTurnFailure(f));
  }
  assert.ok(!isTurnFailure({ code: "nope", message: "", next: [] }));
  assert.ok(!isTurnFailure(null));
});

test("a provider exception is read into the right code", () => {
  assert.equal(failureFromError("the analysis provider did not answer within 90 seconds").code, "timeout");
  assert.match(failureFromError("the analysis provider did not answer within 90 seconds").message, /90 seconds/);
  const refused = failureFromError("the analysis provider refused the request (404) model not found");
  assert.equal(refused.code, "provider");
  assert.match(refused.message, /404 model not found/);
  assert.equal(failureFromError("fetch failed").code, "network");
  assert.equal(failureFromError("getaddrinfo ENOTFOUND api.example").code, "network");
  assert.equal(failureFromError("something odd").code, "provider");
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

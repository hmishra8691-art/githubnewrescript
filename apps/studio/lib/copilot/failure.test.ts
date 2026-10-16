import { test } from "node:test";
import assert from "node:assert/strict";
import { describeFailure, failureFromError, failureFromException, failureFromRefusal, failureFromReplyError, failureFromTransport, isTurnFailure } from "./failure.ts";

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
  assert.equal(failureFromTransport(0).code, "unreachable", "the page never reached the Studio: the server, not the AI service");
  assert.equal(failureFromTransport(413).code, "too_long");
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

test("the provider card tells an administrator where the reason is — the connection check and the log's `said` field", () => {
  const f = failureFromError("something the provider refused");
  assert.equal(f.code, "provider");
  assert.match(f.admin ?? "", /AI connection/);
  assert.match(f.admin ?? "", /said/);
  /* and a provider's credit-balance 400 is no longer read as a malformed request */
  const q = failureFromError({ kind: "quota_exhausted", status: 400, message: "x" });
  assert.equal(q.code, "quota");
});

/* AI-04: the Studio's own refusals are said as what they are, with a retry — never "the AI service could not process this" */
test("a route refusal without a failure object is a researcher-readable sentence, not a provider failure", () => {
  const signedOut = failureFromRefusal(401, { error: "Not signed in.", code: "no_session" })!;
  assert.equal(signedOut.code, "signed_out");
  assert.match(signedOut.message, /^You're signed out — sign in and send again\./);
  assert.equal(failureFromRefusal(401, { error: "Your session is no longer valid.", code: "unknown_session" })!.code, "signed_out");
  assert.equal(failureFromRefusal(401, null)!.code, "signed_out");

  const key = failureFromRefusal(401, { error: "The AI provider rejected the API key." })!;
  assert.equal(key.code, "auth");
  assert.match(key.message, /^The AI provider refused the key — check Settings → AI/);

  const tooLong = failureFromRefusal(400, { error: "the request is too long" })!;
  assert.equal(tooLong.code, "too_long");
  assert.match(tooLong.message, /^That request was too long for the model — shorten it or split it\./);
  assert.equal(failureFromRefusal(413, null)!.code, "too_long");

  const nothing = failureFromRefusal(400, { error: "say what you want" })!;
  assert.equal(nothing.code, "bad_request");
  assert.match(nothing.message, /type what you want changed/);
  const unreadable = failureFromRefusal(400, { error: "send the survey as it is open in the editor (definition)" })!;
  assert.equal(unreadable.code, "bad_request");
  assert.match(unreadable.message, /could not read what this page sent/);

  assert.match(failureFromRefusal(423, { error: "This project has been locked by its owner and cannot be changed." })!.message, /locked by its owner/);
  assert.match(failureFromRefusal(403, { error: "x", code: "account_disabled" })!.message, /account has been disabled/);
  assert.match(failureFromRefusal(404, { error: "Unknown project." })!.message, /could not be found/);
  assert.equal(failureFromRefusal(402, { error: "balance" })!.code, "wallet");
  assert.equal(failureFromRefusal(500, { error: "boom" }), null, "a status it does not know is the caller's");
  assert.equal(failureFromRefusal(200, null), null);

  for (const f of [signedOut, key, tooLong, nothing, unreadable, failureFromRefusal(423, { error: "x" })!, failureFromRefusal(404, null)!]) {
    assert.ok(isTurnFailure(f));
    assert.doesNotMatch(f.title + f.message + f.next.join(" "), /could not process this request|\b(40[0-9]|423)\b|Not signed in|\[object|undefined/i, f.code);
    assert.ok(f.next.length >= 1);
  }
  /* the card shows them with Resume (see CopilotCard KEEPS_WORK): they must all be codes the card knows */
  for (const c of ["signed_out", "bad_request", "too_long", "unreachable", "refused", "unexpected"] as const) assert.ok(isTurnFailure(describeFailure(c)), c);
});

test("a provider's context-length refusal reads as too long; an exception in the page never shows raw JavaScript", () => {
  assert.equal(failureFromError({ kind: "bad_request", message: "the analysis provider refused the request (400) prompt is too long: 215000 tokens > 200000 maximum" }).code, "too_long");
  assert.equal(failureFromError("the analysis provider refused the request (400) This model's maximum context length is 128000 tokens").code, "too_long");
  assert.equal(failureFromError("the analysis provider refused the request (400) bad").code, "provider", "other 400s are unchanged");

  const net = failureFromException(new TypeError("Failed to fetch"));
  assert.equal(net.code, "unreachable");
  assert.match(net.message, /^Could not reach the server — check your connection and try again\./);
  assert.equal(net.retryable, true);
  assert.equal(failureFromException(new TypeError("NetworkError when attempting to fetch resource.")).code, "unreachable");
  assert.equal(failureFromException(new DOMException("The operation was aborted.", "AbortError")).code, "timeout");
  const raw = failureFromException(new TypeError("Cannot read properties of undefined (reading 'actions')"));
  assert.equal(raw.code, "unexpected");
  assert.doesNotMatch(JSON.stringify({ t: raw.title, m: raw.message, n: raw.next }), /Cannot read|undefined|TypeError|actions/);
  assert.match(raw.message, /^Something went wrong in the Studio before the AI could answer\./);
  assert.equal(failureFromException("weird").code, "unexpected");
  assert.equal(failureFromException(undefined).code, "unexpected");
});

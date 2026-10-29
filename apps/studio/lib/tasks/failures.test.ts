import { test } from "node:test";
import assert from "node:assert/strict";
import { ProviderError, AiReplyError } from "@rescript/ai";
import { callKey, classifyAiError, classifyRefusal, backoffMs, resultForFailure, stepFailureKindOf } from "./failures.ts";

/* FAILURE CLASSIFICATION (durable tasks, 2026-10-25): every provider / reply / meter failure has a kind and a recovery */

test("provider errors → failure kinds, Retry-After kept", () => {
  const k = (kind: ConstructorParameters<typeof ProviderError>[0]["kind"], extra = {}) => classifyAiError(new ProviderError({ kind, detail: "x", host: "h", ...extra }));
  assert.deepEqual([k("rate_limited", { retryAfterMs: 7000 }).kind, k("rate_limited", { retryAfterMs: 7000 }).retryAfterMs], ["rate_limit", 7000]);
  assert.equal(k("busy").kind, "rate_limit");
  assert.equal(k("overloaded").kind, "provider_outage");
  assert.equal(k("server").kind, "provider_outage");
  assert.equal(k("network").kind, "network");
  assert.equal(k("timeout").kind, "network");
  assert.equal(k("auth").kind, "auth");
  assert.match(k("auth").message, /Resume/);
  assert.equal(k("forbidden").kind, "auth");
  assert.equal(k("quota_exhausted").kind, "config");
  assert.equal(k("not_found").kind, "config");
  assert.equal(k("bad_request", { contextTooLong: true }).kind, "context_limit");
  assert.equal(classifyAiError(new AiReplyError("truncated", "cut")).kind, "output_limit");
  assert.equal(classifyAiError(new AiReplyError("unparseable", "words")).kind, "invalid_output");
  assert.equal(classifyAiError(Object.assign(new Error("aborted"), { name: "AbortError" })).kind, "cancelled");
});

test("meter / policy refusals → budget, config, auth with an actionable message", () => {
  assert.equal(classifyRefusal({ reason: "insufficient_balance", message: "Wallet empty." }).kind, "budget");
  assert.match(classifyRefusal({ reason: "insufficient_balance", message: "Wallet empty." }).message, /kept.*Resume/);
  assert.equal(classifyRefusal({ reason: "project_limit" }).kind, "budget");
  assert.equal(classifyRefusal({ reason: "ai_off" }).kind, "config");
  assert.equal(classifyRefusal({ reason: "ai_connection" }).kind, "auth");
});

test("recovery per class: transient → retry (Retry-After), limits → not retried as-is, auth/config/budget → blocked", () => {
  assert.deepEqual(resultForFailure({ kind: "rate_limit", message: "m", retryAfterMs: 5000 }), { status: "retry", reason: "rate_limit: m", retryAfterMs: 5000 });
  assert.equal(resultForFailure({ kind: "network", message: "m" }).status, "retry");
  assert.equal(resultForFailure({ kind: "invalid_output", message: "m" }).status, "retry");
  assert.equal(resultForFailure({ kind: "output_limit", message: "m" }).status, "failed");
  for (const [k, needs] of [["auth", "auth"], ["config", "config"], ["budget", "budget"]] as const) assert.deepEqual(resultForFailure({ kind: k, message: "m" }), { status: "blocked", reason: "m", needs });
  /* jitter stays within [0.5, 1.5] × the exponential, capped; Retry-After wins */
  for (let a = 1; a <= 6; a++) { const lo = backoffMs(a, undefined, 0), hi = backoffMs(a, undefined, 1); assert.ok(lo <= hi && lo >= Math.min(60_000, 2000 * 2 ** (a - 1)) * 0.5 && hi <= 90_000); }
  assert.equal(backoffMs(1, 45_000, 0.5), 45_000);
});

test("call keys: attempt-independent, content-sensitive", () => {
  const c = { purpose: "gen.batch", prompt: "write Q1-Q10", maxTokens: 4000 };
  assert.equal(callKey("b1", c), callKey("b1", { ...c }));
  assert.notEqual(callKey("b1", c), callKey("b2", c));
  assert.notEqual(callKey("b1", c), callKey("b1", { ...c, prompt: "write Q11-Q20" }));
  assert.equal(callKey("b1", { ...c, guides: ["quota", "analysis"] }), callKey("b1", { ...c, guides: ["analysis", "quota"] }));
});

test("the contract's twelve kinds land on the runner's seven, once", () => {
  assert.equal(stepFailureKindOf("rate_limit"), "rate_limited");
  assert.equal(stepFailureKindOf("output_limit"), "context_limit");
  assert.equal(stepFailureKindOf("context_limit"), "context_limit");
  assert.equal(stepFailureKindOf("auth"), "auth");
  assert.equal(stepFailureKindOf("budget"), "config");
  assert.equal(stepFailureKindOf("invalid_output"), "invalid_output");
  for (const k of ["network", "provider_outage", "cancelled", "unknown"] as const) assert.equal(stepFailureKindOf(k), "transient", k);
});

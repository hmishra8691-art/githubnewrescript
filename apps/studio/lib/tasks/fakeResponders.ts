/**
 * FAKE-PROVIDER RESPONDERS for the durable task engine (K2, 2026-10-25) — a TEST SEAM.
 *
 * Under `AI_API_URL=fake:` there is no model. A 300-question generation makes ~20 model calls, which a browser
 * suite cannot script one by one in a request body. A step-handler family can therefore register a deterministic
 * stand-in for its own purposes here (`gen.*` for generation, …); the engine's `ctx.ai` consults `fakeResponse(call)`
 * ONLY when the fake provider is configured, before its own scripted fallback. With a real provider this registry
 * is never read. Responders must be pure functions of the call (no I/O).
 *
 * A responder may also return `{ fail: FailureKind }` to simulate a provider failure for that call (tests use
 * this to prove split-on-output_limit and repair paths end to end).
 */
import type { FailureKind } from "./types.ts";

export type FakeAiCall = { purpose: string; system?: string; prompt: string; schema?: unknown; maxTokens: number; tier?: "small" | "standard" | "strong"; guides?: string[] };
export type FakeAiAnswer = { value: unknown } | { fail: FailureKind; message?: string; retryAfterMs?: number };
export type FakeResponder = (call: FakeAiCall) => FakeAiAnswer | undefined;

const G = globalThis as unknown as { __rescriptFakeResponders?: Map<string, FakeResponder> };
const reg = (G.__rescriptFakeResponders ??= new Map());

/** register a responder for every purpose starting with `prefix` (idempotent by prefix; last wins) */
export function registerFakeResponder(prefix: string, fn: FakeResponder): void {
  if (!prefix || typeof fn !== "function") throw new Error("registerFakeResponder: prefix and function required");
  reg.set(prefix, fn);
}

/** the registered stand-in answer for this call, or undefined when no responder claims it (longest prefix wins) */
export function fakeResponse(call: FakeAiCall): FakeAiAnswer | undefined {
  const prefixes = [...reg.keys()].filter((p) => call.purpose.startsWith(p)).sort((a, b) => b.length - a.length);
  for (const p of prefixes) {
    try {
      const r = reg.get(p)!(call);
      if (r) return r;
    } catch (e) {
      return { fail: "invalid_output", message: `fake responder ${p} threw: ${(e as Error)?.message ?? e}` };
    }
  }
  return undefined;
}

/** test seam: clear responders */
export function __resetFakeResponders(): void { reg.clear(); }

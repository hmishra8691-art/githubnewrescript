/**
 * WHAT ONE ATTEMPT OF A STEP USED, and the meter-less model door the unit tests use (2026-10-29). Pure: no
 * server-only import, so a family's handler tests run under `node --test`.
 */
import type { StepUsage } from "@rescript/engine";
import { fakeResponse } from "./fakeResponders.ts";
import type { AiFn } from "./types.ts";

/** what one attempt's calls used, summed as they return — committed on the step row by the runner */
export interface AttemptUsage { tokensIn: number; tokensOut: number; tokensCached: number; charge: number; calls: number; failedCalls: number; model?: string }
export const zeroAttemptUsage = (): AttemptUsage => ({ tokensIn: 0, tokensOut: 0, tokensCached: 0, charge: 0, calls: 0, failedCalls: 0 });

/** the row's usage from an attempt's — nothing when no call was made */
export function stepUsageOf(u: AttemptUsage): StepUsage | undefined {
  if (!u.calls) return undefined;
  return { tokensIn: u.tokensIn, tokensOut: u.tokensOut, tokensCached: u.tokensCached, charge: u.charge, ...(u.model ? { model: u.model } : {}) };
}

/** the attempt-independent key an idempotent settle is made under */
export const attemptIdempotencyKey = (stepKey: string, attempt: number, callKey: string): string => `task:${stepKey}:a${attempt}:${callKey.slice(-16)}`;

/**
 * A model door with NO meter, for unit tests of a family's handlers and for the in-process task runner
 * (`testing.ts`): the registered fake responders answer, and a call nobody claims is `invalid_output`. Never used
 * by a route.
 */
export function fakeTaskAi(usage: AttemptUsage = zeroAttemptUsage(), opts: { charge?: number } = {}): AiFn {
  return async (call) => {
    usage.calls++;
    const fr = fakeResponse({ purpose: call.purpose, ...(call.system ? { system: call.system } : {}), prompt: call.prompt, ...(call.schema ? { schema: call.schema } : {}), maxTokens: call.maxTokens, ...(call.tier ? { tier: call.tier } : {}), ...(call.guides ? { guides: call.guides } : {}) });
    if (!fr) { usage.failedCalls++; return { ok: false, kind: "invalid_output", message: `no fake responder claims ${call.purpose}` }; }
    if ("fail" in fr) { usage.failedCalls++; return { ok: false, kind: fr.fail, message: fr.message ?? `scripted ${fr.fail}`, ...(fr.retryAfterMs ? { retryAfterMs: fr.retryAfterMs } : {}) }; }
    const charge = opts.charge ?? 0.01;
    usage.tokensIn += 100; usage.tokensOut += 50; usage.charge += charge; usage.model = "fake";
    return { ok: true, value: fr.value, usage: { inputTokens: 100, outputTokens: 50, cacheRead: 0, cacheWrite: 0, usd: 0, model: "fake", billable: true, charge } };
  };
}

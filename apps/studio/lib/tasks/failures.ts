/**
 * FAILURE CLASSIFICATION FOR TASK STEPS (2026-10-29, ported from K1) — pure, unit-tested (failures.test.ts).
 *
 * What a provider / reply / meter failure means to a handler (`FailureKind`), the default `StepResult` for one,
 * the backoff the runner's `retry` honours, the attempt-independent key of one model call of one step, and the
 * mapping from the handler contract's kinds onto the base runner's `StepFailureKind` (packages/engine execPlan.ts).
 */
import { createHash } from "node:crypto";
import { isAiReplyError, isProviderError } from "@rescript/ai";
import type { StepFailureKind } from "@rescript/engine";
import type { AiCall, FailureKind, StepResult } from "./types.ts";

/** what a thrown provider / reply error is, in the handler contract's words */
export function classifyAiError(e: unknown): { kind: FailureKind; message: string; retryAfterMs?: number } {
  if (isProviderError(e)) {
    const ra = e.retryAfterMs != null && Number.isFinite(e.retryAfterMs) ? { retryAfterMs: e.retryAfterMs } : {};
    switch (e.kind) {
      case "rate_limited": case "busy": return { kind: "rate_limit", message: "The AI provider is rate-limiting requests right now.", ...ra };
      case "overloaded": case "server": return { kind: "provider_outage", message: "The AI provider is overloaded or reported an error on its side.", ...ra };
      case "network": case "timeout": return { kind: "network", message: e.kind === "timeout" ? "The AI provider did not answer in time." : "The AI provider could not be reached.", ...ra };
      case "auth": case "forbidden": return { kind: "auth", message: "The AI provider refused the key. Check the AI connection (Settings → AI connection, or the project's AI source) and Resume." };
      case "quota_exhausted": return { kind: "config", message: "The AI provider's account is out of credit or at its spending limit. Add credit with the provider, then Resume." };
      case "not_found": return { kind: "config", message: "The AI provider does not know the configured model (AI_MODEL / AI_MODEL_SMALL). Fix the model name, then Resume." };
      case "bad_request": return e.contextTooLong ? { kind: "context_limit", message: "The request is longer than the model's context window." } : { kind: "invalid_output", message: "The AI provider refused the request as malformed." };
      default: return { kind: "unknown", message: e.message.slice(0, 300), ...ra };
    }
  }
  if (isAiReplyError(e)) return e.code === "truncated" ? { kind: "output_limit", message: "The answer was longer than the model's output limit." } : { kind: "invalid_output", message: e.code === "empty" ? "The model answered with nothing." : "The model answered in words, not in the structured form asked for." };
  const name = (e as { name?: string })?.name;
  if (name === "AbortError") return { kind: "cancelled", message: "The step was stopped (cancelled or out of time)." };
  return { kind: "unknown", message: String((e as Error)?.message ?? e).slice(0, 300) };
}

/** a meter / policy refusal (the wallet, the project's AI switch, the AI connection) */
export function classifyRefusal(r: { reason?: string; message?: string }): { kind: FailureKind; message: string } {
  if (r.reason === "ai_off") return { kind: "config", message: `${r.message ?? "AI is switched off for this project."} Switch the project to Cloud, then Resume.` };
  if (r.reason === "ai_connection") return { kind: "auth", message: `${r.message ?? "The AI connection was refused."} Fix the AI connection, then Resume.` };
  return { kind: "budget", message: `${r.message ?? "The wallet refused this call."} Everything built so far is kept — top up (or raise the project's limit), then Resume.` };
}

/** the default response to a failed model call — what a handler returns when it has nothing better to do */
export function resultForFailure(f: { kind: FailureKind; message: string; retryAfterMs?: number }): StepResult {
  switch (f.kind) {
    case "network": case "rate_limit": case "provider_outage": case "unknown": case "invalid_output":
      return { status: "retry", reason: `${f.kind}: ${f.message}`, ...(f.retryAfterMs ? { retryAfterMs: f.retryAfterMs } : {}) };
    case "auth": return { status: "blocked", reason: f.message, needs: "auth" };
    case "config": return { status: "blocked", reason: f.message, needs: "config" };
    case "budget": return { status: "blocked", reason: f.message, needs: "budget" };
    case "cancelled": return { status: "failed", reason: "cancelled", permanent: false };
    case "context_limit": case "output_limit": case "validation":
      return { status: "failed", reason: `${f.kind}: ${f.message}`, permanent: false };
  }
}

/** exponential backoff with full jitter, never shorter than the provider's Retry-After (the runner's `waitBeforeRetry` is the one actually used; this is the contract's reference) */
export function backoffMs(attempt: number, retryAfterMs: number | undefined, rand: number, cfg: { backoffBaseMs: number; backoffCapMs: number } = { backoffBaseMs: 2_000, backoffCapMs: 60_000 }): number {
  const exp = Math.min(cfg.backoffCapMs, cfg.backoffBaseMs * 2 ** Math.max(0, attempt - 1));
  const jittered = Math.round(exp * (0.5 + Math.min(1, Math.max(0, rand))));
  return Math.max(jittered, Math.min(10 * 60_000, Math.max(0, retryAfterMs ?? 0)));
}

/** a deterministic key of one call of one step (attempt-independent: a re-run asks the same and gets the same key) */
export function callKey(stepId: string, call: AiCall): string {
  const schemaName = call.schema && typeof call.schema === "object" ? (call.schema as { name?: unknown }).name ?? createHash("sha256").update(JSON.stringify(call.schema)).digest("hex").slice(0, 12) : "";
  return `${stepId}:${createHash("sha256").update(JSON.stringify([call.purpose, call.system ?? "", call.prompt, schemaName, call.tier ?? "", call.maxTokens, [...(call.guides ?? [])].sort()])).digest("hex").slice(0, 40)}`;
}

/**
 * THE HANDLER CONTRACT'S KINDS ON THE BASE RUNNER'S ROW. The runner stores one of seven `StepFailureKind`s
 * (execPlan.ts) and acts on them — transient / rate_limited retry with backoff, context_limit halves and splits,
 * auth / config / permanent stop the step and preserve the task. A handler's twelve kinds map onto them here, once.
 */
export function stepFailureKindOf(kind: FailureKind): StepFailureKind {
  switch (kind) {
    case "rate_limit": return "rate_limited";
    case "context_limit": case "output_limit": return "context_limit";
    case "invalid_output": case "validation": return "invalid_output";
    case "auth": return "auth";
    case "config": case "budget": return "config";
    case "network": case "provider_outage": case "cancelled": case "unknown": default: return "transient";
  }
}

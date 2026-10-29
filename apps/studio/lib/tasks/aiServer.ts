import "server-only";
/**
 * `ctx.ai` — THE ONE DOOR A TASK STEP USES TO REACH A MODEL (2026-10-29, ported from K1 onto the base's metering).
 *
 * Built on the existing metered call path and nothing else: `meteredAi` (the project's AI switch, whose connection
 * — BYOK or the platform's — the wallet's reservation settled with the provider-reported usage) around
 * `completeJson` (structured output, continuation of a cut-off answer, prompt caching of the system blocks). On top:
 *
 *   - the METER AND CONTEXT ARE THE CALLER'S, never this module's: the page-driven slice hands in the request's own
 *     `billingProjectFor` meter, context and one-time consent; the cron hands in what `backgroundContextFor`
 *     established (platform key only, authority re-checked, wallet + ceiling). A handler never sees either;
 *   - an IDEMPOTENCY KEY per call of a step attempt on the usage event (`task:<step key>:a<attempt>:<call key>`),
 *     so a duplicated settle charges once; the call key is attempt-independent, so a re-run of an interrupted
 *     attempt carries the same key and `UsageEvent.idempotencyKey` moves no money twice;
 *   - FAILURE CLASSIFICATION (`FailureKind`): network, rate_limit (with Retry-After), provider_outage,
 *     context_limit, output_limit, auth, invalid_output, config, budget, cancelled — the handler acts on the kind;
 *   - the USAGE of every call summed on the attempt, so the runner commits it on the step row (`StepUsage`);
 *   - the model TIER (small → AI_MODEL_SMALL; standard/strong → AI_MODEL) and the guides as cached blocks.
 *
 * TEST SEAM (fake provider only): the registered fake responders (fakeResponders.ts). With a real provider the
 * registry is never read.
 */
import { aiProviderName, completeJson } from "@rescript/ai";
import type { ExecStep, ExecTask } from "@rescript/engine";
import type { Meter, MeterContext } from "@rescript/billing";
import { meteredAi } from "@/lib/metering";
import { COPILOT_SYSTEM_PROMPT } from "@/lib/copilot/prompt";
import { GUIDE_TEXT, type GuideId } from "@/lib/copilot/guideSelect";
import { callKey, classifyAiError, classifyRefusal } from "./failures.ts";
import { fakeResponse } from "./fakeResponders.ts";
import type { AttemptUsage } from "./attempt.ts";
import type { AiAnswer, AiCall, AiCallUsage, AiFn, FailureKind } from "./types.ts";

/** whose meter this slice runs under — the request's own, or the background's */
export interface TaskAiScope { meter: Meter; ctx: MeterContext; consent?: "once" }

export interface MakeAiArgs {
  task: Pick<ExecTask, "id" | "surveyId">;
  /** the step (null: the planner's own call) */
  step: Pick<ExecStep, "stepId" | "kind" | "idempotencyKey" | "modelTier"> | null;
  attempt: number;
  /** absolute ms: the call may not run past this */
  deadline: number;
  signal: AbortSignal;
  usage: AttemptUsage;
}

/** the metered model for one attempt of one step (or for the planner) */
export function makeTaskAi(scope: TaskAiScope, a: MakeAiArgs): AiFn {
  const fake = aiProviderName() === "fake";
  const stepId = a.step?.stepId ?? "__plan";
  return async (call: AiCall): Promise<AiAnswer> => {
    const t0 = Date.now();
    a.usage.calls++;
    const fail = (kind: FailureKind, message: string, retryAfterMs?: number): AiAnswer => {
      a.usage.failedCalls++;
      return { ok: false, kind, message, ...(retryAfterMs ? { retryAfterMs } : {}) };
    };
    if (a.signal.aborted) return fail("cancelled", "The step was stopped.");
    const left = a.deadline - Date.now();
    if (left < 1500) return fail("network", "No time left in this slice for the call — it runs in the next one.");

    /* TEST SEAM: the fake provider's stand-in for this family (a scripted failure needs no meter) */
    const fr = fake ? fakeResponse({ purpose: call.purpose, ...(call.system ? { system: call.system } : {}), prompt: call.prompt, ...(call.schema ? { schema: call.schema } : {}), maxTokens: call.maxTokens, ...(call.tier ? { tier: call.tier } : {}), ...(call.guides ? { guides: call.guides } : {}) }) : undefined;
    if (fr && "fail" in fr) return fail(fr.fail, fr.message ?? `scripted ${fr.fail}`, fr.retryAfterMs);

    const guides = (call.guides ?? []).filter((g): g is GuideId => g in GUIDE_TEXT);
    const system = [call.system ?? COPILOT_SYSTEM_PROMPT, ...(guides.length ? [guides.map((g) => GUIDE_TEXT[g]).join("\n\n")] : [])];
    const tier = (call.tier ?? a.step?.modelTier) === "small" ? "small" as const : "large" as const;
    const key = callKey(stepId, call);
    const idem = `task:${a.step?.idempotencyKey ?? `${a.task.id}:__plan`}:a${a.attempt}:${key.slice(-16)}`;
    const operation = `copilot_task_${(a.step?.kind ?? "plan").replace(/[^\w.]/g, "_").slice(0, 60)}`;
    let m: Awaited<ReturnType<typeof meteredAi<unknown>>>;
    try {
      m = await meteredAi(scope.meter, scope.ctx, "AI_REQUEST", {
        ...(scope.consent ? { consent: scope.consent } : {}),
        estimateText: system.join("\n\n") + call.prompt, maxTokens: Math.min(call.maxTokens, 16_000), operation, tier, idempotencyKey: idem,
        meta: () => ({ workflowId: a.task.id, taskId: a.task.id, stepId, attempt: a.attempt, purpose: call.purpose.slice(0, 80), latencyMs: Date.now() - t0 }),
      }, () => completeJson(system, call.prompt, call.maxTokens, { timeoutMs: Math.min(300_000, left - 500), deadline: a.deadline - 250, ...(call.schema ? { schema: call.schema as never } : {}), tier, continuations: 3, retries: 1, operation }));
    } catch (e) {
      const f = classifyAiError(e);
      return fail(f.kind, f.message, f.retryAfterMs);
    }
    if (!m.ok) { const f = classifyRefusal(m as { reason?: string; message?: string }); return fail(f.kind, f.message); }
    const ev = m.event;
    const md = (ev?.metadata ?? {}) as { tokens?: { cachedInput?: number; cacheWrite?: number } };
    const u: AiCallUsage = { inputTokens: ev?.inputUnits ?? 0, outputTokens: ev?.outputUnits ?? 0, cacheRead: Number(md.tokens?.cachedInput ?? 0), cacheWrite: Number(md.tokens?.cacheWrite ?? 0), usd: Number(ev?.providerCost ?? 0), model: String(ev?.model ?? ""), billable: !!ev, charge: Number(ev?.customerCharge ?? 0) };
    a.usage.tokensIn += u.inputTokens; a.usage.tokensOut += u.outputTokens; a.usage.tokensCached += u.cacheRead; a.usage.charge += u.charge ?? 0;
    if (u.model) a.usage.model = u.model;
    /* TEST SEAM: what the fake "model" answered — the registered responder's value, else the fake's own {} */
    const value: unknown = fr && "value" in fr ? fr.value : m.value;
    if (value == null) return fail("invalid_output", "The model returned nothing usable.");
    return { ok: true, value, usage: u };
  };
}

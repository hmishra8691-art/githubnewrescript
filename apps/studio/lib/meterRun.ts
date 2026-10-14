import type { Meter, MeterContext, MeterRefusal, UsageEvent, UsageSpec } from "@rescript/billing";
import { collectUsage, sumUsage, withAiScope, type AiUsage, type ChatScope } from "@rescript/ai";
import { meterModel, meterProvider } from "./aiEstimate.ts";
import { aiAllowed, aiRefusal, type AiRefusal, type AiSource } from "./aiPolicy.ts";
import type { Resolution } from "./byok/resolve.ts";

/**
 * THE METERING CORE, apart from the framework.
 *
 * `metering.ts` is the Studio's service (Next responses, the guard, the
 * database). The rule it applies to every model call — project switch, whose
 * AI, then money — lives here, with nothing but the billing meter and an
 * injected `connectionFor`, so it is tested against the real meter without a
 * server.
 */

/** what the core needs from the Studio: whose AI an operation uses, and whether the operator allowed private endpoints */
export interface RunDeps {
  connectionFor(ask: { userId: string | null | undefined; customerId: string | null | undefined; surveyId: string | null | undefined; operation: string; source?: AiSource; sourceKnown?: boolean }): Promise<Resolution>;
  allowPrivate(): boolean;
}

/** Turn collected provider reports into the usage the meter settles. */
export function usageToSpec(usage: AiUsage[], fallback: { kind: "chat" | "tts" | "stt" | "translate" }): Partial<UsageSpec> {
  const t = sumUsage(usage);
  const provider = t.provider ?? "fake";
  const kind = usage[0]?.kind ?? fallback.kind;
  /*
   * Speech-to-text is priced PER AUDIO MINUTE, not per token. Without this
   * branch an stt report fell through to the chat one and was billed as
   * tokens it does not have — quantity zero, so a transcription cost
   * nothing and the rate row `ai.stt.*` was never reached.
   */
  if (kind === "stt") return { provider: meterProvider(provider, "stt"), service: "stt", model: meterModel(provider, t.model, "stt"), quantity: (t.seconds ?? 0) / 60, metadata: { requests: t.requests, estimated: t.estimated, actualProvider: provider, seconds: t.seconds ?? 0 } };
  if (kind === "translate") return { provider: meterProvider(provider, "translate"), service: "translate", model: meterModel(provider, t.model, "translate"), quantity: t.characters, metadata: { requests: t.requests, estimated: t.estimated, actualProvider: provider } };
  if (kind === "tts") return { provider: meterProvider(provider, "tts"), service: "tts", model: meterModel(provider, t.model, "tts"), quantity: t.characters, metadata: { requests: t.requests, estimated: t.estimated, actualProvider: provider } };
  return { provider: meterProvider(provider, "chat"), service: "chat", model: meterModel(provider, t.model, "chat"), inputUnits: t.inputTokens, outputUnits: t.outputTokens, quantity: t.inputTokens + t.outputTokens, metadata: { requests: t.requests, estimated: t.estimated, actualProvider: provider } };
}

/**
 * The user chose their own AI provider and it cannot be used (no key, the key
 * cannot be opened, the workspace forbids it, the provider lacks what this
 * needs). Said in words — and NEVER answered by quietly using the platform's AI
 * instead, which would spend money the person did not agree to.
 */
export interface ConnectionRefusal { ok: false; reason: "ai_connection"; code: string; message: string; source: "user" | "project" }

/**
 * The user chose their own AI provider and it cannot be used (no key, the key
 * cannot be opened, the workspace forbids it, the provider lacks what this
 * needs). Said in words — and NEVER answered by quietly using the platform's AI
 * instead, which would spend money the person did not agree to.
 */
export interface ConnectionRefusal { ok: false; reason: "ai_connection"; code: string; message: string; source: "user" | "project" }

export type Metered<T> = { ok: true; value: T; event: UsageEvent | null } | MeterRefusal | AiRefusal | ConnectionRefusal;


/**
 * THE ONE DOOR FOR A MODEL CALL — project switch, then WHOSE AI, then money.
 *
 *   1. the project's AI switch (internal / feature off) — before anything else
 *   2. whose AI: project's choice → the acting user's → the platform's
 *      (`connectionFor`). A user-managed choice that cannot be honoured is a
 *      refusal, not the platform.
 *   3. the platform's AI → reserve a hold, run, settle with what the provider
 *      reported (unchanged).
 *   4. the user's own AI → NO wallet: the model is paid to the user's own
 *      provider. The call runs inside the user's connection scope (their key,
 *      their model, no platform headers, no operator fallback) and is recorded
 *      at a customer charge of zero with the provider and tokens, for
 *      attribution. If the user ALLOWED the platform as a backstop, a hold is
 *      reserved first (when the wallet cannot fund it, the backstop is simply
 *      not offered for this call); only usage the platform actually served is
 *      settled against it, and the rest of the hold is returned.
 */
export async function meteredCore<T>(
  deps: RunDeps, meter: Meter, ctx: MeterContext,
  o: { operation: string; once?: boolean; kind: "chat" | "tts"; reserve: () => UsageSpec },
  fn: () => Promise<T>,
): Promise<Metered<T>> {
  /* the project's AI switch (audit A-2) — asked before anything is reserved, so an off project makes no provider call and holds no balance */
  const decision = await aiAllowed(ctx.surveyId, o.operation, { once: o.once });
  if (!decision.allowed) return aiRefusal(decision);
  const conn = await deps.connectionFor({ userId: ctx.userId, customerId: ctx.customerId, surveyId: ctx.surveyId, operation: o.operation, source: decision.source, sourceKnown: true });
  if (conn.kind === "refused") return { ok: false, reason: "ai_connection", code: conn.code, message: conn.message, source: conn.source };

  if (conn.kind === "platform") {
    const hold = await meter.reserve(ctx, o.reserve());
    if (!hold.ok) return hold;
    try {
      const { value, usage } = await collectUsage(fn);
      if (!usage.length) { await meter.release(hold); return { ok: true, value, event: null }; }
      const spec = usageToSpec(usage, { kind: o.kind });
      const event = await meter.settle(hold, { ...spec, metadata: { operation: o.operation, ...spec.metadata } });
      return { ok: true, value, event };
    } catch (e) {
      await meter.release(hold).catch(() => {});
      throw e;
    }
  }

  /* the user's own provider */
  let scope: ChatScope = conn.scope;
  let hold: Awaited<ReturnType<Meter["reserve"]>> | null = null;
  if (scope.fallbacks.some((f) => f.platform)) {
    const h = await meter.reserve(ctx, o.reserve());
    if (h.ok) hold = h;
    else scope = { ...scope, fallbacks: scope.fallbacks.filter((f) => !f.platform) };
  }
  const holdOk = hold && hold.ok ? hold : null;
  try {
    const { value, usage } = await collectUsage(() => withAiScope({ chat: scope, allowPrivate: deps.allowPrivate() }, fn));
    /* inside a user's scope a report is the user's unless it says the platform served it */
    const platformUsage = usage.filter((u) => u.source === "platform");
    const userUsage = usage.filter((u) => u.source !== "platform");
    let event: UsageEvent | null = null;
    if (holdOk) {
      if (platformUsage.length) { const spec = usageToSpec(platformUsage, { kind: o.kind }); event = await meter.settle(holdOk, { ...spec, metadata: { operation: o.operation, source: "platform_fallback", ...spec.metadata } }); }
      else await meter.release(holdOk).catch(() => {});
    }
    for (const group of groupByConnection(userUsage)) {
      const spec = usageToSpec(group.usage, { kind: o.kind });
      const rec = await recordByok(meter, ctx, { ...spec, eventType: "AI_REQUEST_BYOK", provider: group.provider ?? scope.provider, unit: o.kind === "tts" ? "character" : undefined, metadata: { operation: o.operation, byok: true, source: conn.source, providerId: group.provider ?? scope.provider, usedFallback: group.usedFallback, ...spec.metadata } });
      event ??= rec;
    }
    return { ok: true, value, event };
  } catch (e) {
    if (holdOk) await meter.release(holdOk).catch(() => {});
    throw e;
  }
}

/** one usage record per provider the user's call actually reached (their primary, or a fallback of theirs) */
function groupByConnection(usage: AiUsage[]): { provider: string | undefined; usedFallback: boolean; usage: AiUsage[] }[] {
  const m = new Map<string, { provider: string | undefined; usedFallback: boolean; usage: AiUsage[] }>();
  for (const u of usage) {
    const k = `${u.providerId ?? ""}|${u.model ?? ""}|${u.usedFallback ? 1 : 0}`;
    const g = m.get(k) ?? { provider: u.providerId, usedFallback: !!u.usedFallback, usage: [] };
    g.usage.push(u); m.set(k, g);
  }
  return [...m.values()];
}

/** a call on the user's own key: recorded for attribution at zero charge; a lost row never fails the user's work */
async function recordByok(meter: Meter, ctx: MeterContext, spec: UsageSpec): Promise<UsageEvent | null> {
  try { return await meter.recordUnbilled(ctx, spec); }
  catch (e) { console.warn("[rescript:billing] own-provider usage not recorded", JSON.stringify({ error: (e as Error).message })); return null; }
}


import "server-only";
import { Meter, MemoryMeterStore, SupabaseMeterStore, estimateTokens, type MeterContext, type UsageEvent, type UsageSpec, type Environment } from "@rescript/billing";
import { aiModelName, collectUsage, sumUsage, type AiUsage } from "@rescript/ai";
import { supabaseAdmin } from "@/lib/admin";

/**
 * THE RUNTIME'S METERING SERVICE.
 *
 * The runtime spends on a respondent's behalf: AI variables and probes
 * during an interview, a geocode lookup, a file upload, and the interview
 * itself when it completes. Every one of those is a usage event on the
 * project's wallet, in the environment of the session — TEST or LIVE — so
 * test activity is always separately identifiable and priced by policy.
 *
 * THE INTERVIEW IS NEVER LOST TO THE METER. A refusal (empty wallet,
 * read-only project) means the value stays unset and the interview carries
 * on, exactly as an unconfigured provider does; a completed response is
 * recorded as usage even when it cannot be charged (marked `unbilled`) so
 * the administrator can see it — the answers are the data, the meter is
 * accounting.
 */

const dbConfigured = () => !!process.env.SUPABASE_URL && !!process.env.SUPABASE_SERVICE_ROLE_KEY;
declare global {
  // eslint-disable-next-line no-var
  var __rescriptRuntimeMeter: Meter | undefined;
}

export function getMeter(): Meter {
  if (!globalThis.__rescriptRuntimeMeter) {
    globalThis.__rescriptRuntimeMeter = dbConfigured()
      ? new Meter(new SupabaseMeterStore(supabaseAdmin()))
      : new Meter(new MemoryMeterStore(), { seedBalance: Number(process.env.BILLING_SANDBOX_CREDITS ?? "100") || 100, cacheMs: 0 });
  }
  return globalThis.__rescriptRuntimeMeter;
}

export interface SessionBilling { customerId: string; surveyId: string; environment: Environment; sessionId: string }

export function contextOf(b: SessionBilling): MeterContext {
  return { customerId: b.customerId, surveyId: b.surveyId, userId: null, environment: b.environment };
}

function simulateFake(): boolean { return process.env.BILLING_SIMULATE_FAKE_COSTS === "1"; }
export function meterProvider(provider: string, kind: "chat" | "translate" | "tts"): string {
  if (provider !== "fake") return provider;
  return simulateFake() ? (kind === "translate" ? "google" : "openai-compatible") : "fake";
}
function meterModel(provider: string, model: string | null): string | null {
  if (provider !== "fake" || !simulateFake()) return model;
  return aiModelName();
}

function usageToSpec(usage: AiUsage[]): Partial<UsageSpec> {
  const t = sumUsage(usage);
  const provider = t.provider ?? "fake";
  return { provider: meterProvider(provider, "chat"), service: "chat", model: meterModel(provider, t.model), inputUnits: t.inputTokens, outputUnits: t.outputTokens, quantity: t.inputTokens + t.outputTokens, metadata: { requests: t.requests, estimated: t.estimated, actualProvider: provider } };
}

/**
 * Run AI work for a session under the meter. Returns the value, or `null`
 * (with the reason logged) when the wallet refuses — the caller treats that
 * exactly like an unavailable provider.
 */
export async function meteredSessionAi<T>(billing: SessionBilling | null, est: { estimateText: string; maxTokens: number; requests?: number; operation: string }, fn: () => Promise<T>): Promise<{ value: T; event: UsageEvent | null } | { refused: string }> {
  if (!billing) { const value = await fn(); return { value, event: null }; }   // preview: nothing to bill
  const meter = getMeter();
  const providerName = process.env.AI_API_URL === "fake:" ? "fake" : "openai-compatible";
  const reqs = est.requests ?? 1;
  let hold;
  try {
    hold = await meter.reserve(contextOf(billing), {
      eventType: "AI_REQUEST", provider: meterProvider(providerName, "chat"), service: "chat", model: meterModel(providerName, aiModelName()),
      inputUnits: (estimateTokens(est.estimateText) + 120) * reqs, outputUnits: est.maxTokens * reqs, metadata: { operation: est.operation, sessionId: billing.sessionId.slice(0, 8) },
    });
  } catch (e) {
    console.warn("[rescript:billing] meter unavailable — running unmetered", JSON.stringify({ error: (e as Error).message }));
    const value = await fn(); return { value, event: null };
  }
  if (!hold.ok) {
    console.info("[rescript:billing] refused", JSON.stringify({ surveyId: billing.surveyId, reason: hold.reason, operation: est.operation }));
    return { refused: hold.message };
  }
  try {
    const { value, usage } = await collectUsage(fn);
    if (!usage.length) { await meter.release(hold); return { value, event: null }; }
    const spec = usageToSpec(usage);
    const event = await meter.settle(hold, { ...spec, metadata: { operation: est.operation, sessionId: billing.sessionId.slice(0, 8), ...spec.metadata } });
    return { value, event };
  } catch (e) {
    await meter.release(hold).catch(() => {});
    throw e;
  }
}

/**
 * A completed interview (or another event known when it happens). Recorded
 * even when it cannot be charged, marked so; never throws.
 */
export async function recordSessionUsage(billing: SessionBilling, spec: UsageSpec): Promise<UsageEvent | null> {
  const meter = getMeter();
  try {
    const r = await meter.record(contextOf(billing), spec);
    if (r.ok) return r.event;
    // could not be charged: keep the record, at no charge, flagged for the administrator
    const priced = await meter.price(spec, billing.environment);
    const { event } = await meter.store.record({
      customerId: billing.customerId, surveyId: billing.surveyId, userId: null, walletId: r.wallet?.id ?? null,
      eventType: spec.eventType, category: priced.category, environment: billing.environment, provider: spec.provider ?? null, service: spec.service ?? null, model: spec.model ?? null,
      quantity: priced.quantity, unit: priced.unit, inputUnits: spec.inputUnits ?? null, outputUnits: spec.outputUnits ?? null,
      providerCost: priced.breakdown.providerCost, infraCost: priced.breakdown.infraCost, paymentFee: 0, taxReserve: 0, customerCharge: 0, grossProfit: -priced.breakdown.actualCost, netProfit: -priced.breakdown.actualCost, marginPct: 0,
      reservationId: null, adjustsEventId: null, metadata: { ...(spec.metadata ?? {}), unbilled: true, unbilledReason: r.reason, wouldHaveCharged: priced.breakdown.customerCharge },
    }, (await meter.config()).readOnlyThreshold);
    return event;
  } catch (e) {
    console.warn("[rescript:billing] usage not recorded", JSON.stringify({ eventType: spec.eventType, error: (e as Error).message }));
    return null;
  }
}

/** May this project take a new interview in this environment? */
export async function sessionAllowed(customerId: string, surveyId: string, environment: Environment): Promise<{ allowed: boolean; message: string }> {
  try {
    const meter = getMeter();
    const cfg = await meter.config();
    if (!cfg.lockRespondentsWhenReadOnly) return { allowed: true, message: "" };
    if (environment === "TEST" && cfg.testUsagePolicy === "free") return { allowed: true, message: "" };
    const c = await meter.check({ customerId, surveyId });
    return { allowed: c.allowed, message: c.message };
  } catch (e) {
    console.warn("[rescript:billing] wallet check unavailable — allowing", JSON.stringify({ error: (e as Error).message }));
    return { allowed: true, message: "" };
  }
}

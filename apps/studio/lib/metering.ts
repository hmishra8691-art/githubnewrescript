import { NextResponse } from "next/server";
import {
  Meter, MemoryMeterStore, SupabaseMeterStore, estimateTokens,
  type MeterContext, type MeterRefusal, type UsageSpec, type UsageEvent, type Environment,
} from "@rescript/billing";
import { aiModelName, collectUsage, sumUsage, type AiUsage } from "@rescript/ai";
import { supabaseAdmin } from "@/lib/admin";
import { isFailure, requireProjectFor, type AuthedUser, type ProjectContext } from "@/lib/guard";
import type { Capability } from "@rescript/access";

/**
 * THE STUDIO'S METERING SERVICE — the one door every billable Studio feature
 * walks through. No route prices anything; it names the event, hands over
 * the work, and the meter estimates, reserves, runs, records and settles.
 *
 *   const m = meterContextFor(user, surveyId);
 *   const r = await meteredAi(m, "AI_REQUEST", { estimateText, maxTokens }, () => rephraseForSpeech(...));
 *   if (!r.ok) return refusalResponse(r);
 *
 * STORE. With Supabase configured, the database store (migration 0023) —
 * the balance arithmetic is atomic in SQL. Without it, and for the
 * `/sandbox` fixture, an in-memory store that lives for the process, seeded
 * with a starting balance so the Usage tab has something to show; nothing
 * about the sandbox is billed to anyone.
 *
 * FAKE PROVIDERS cost nothing, and are priced at nothing — unless
 * `BILLING_SIMULATE_FAKE_COSTS=1`, when their usage is priced as the real
 * provider's would be, so a developer and the browser suites can watch a
 * wallet drain. Never set in production.
 */

const SANDBOX_CUSTOMER = "sandbox";
const dbConfigured = () => !!process.env.SUPABASE_URL && !!process.env.SUPABASE_SERVICE_ROLE_KEY;

declare global {
  // eslint-disable-next-line no-var
  var __rescriptMeter: Meter | undefined;
  // eslint-disable-next-line no-var
  var __rescriptSandboxMeter: Meter | undefined;
}

/** The meter for real projects (database) — or the memory one when there is no database. */
export function getMeter(): Meter {
  if (!dbConfigured()) return getSandboxMeter();
  if (!globalThis.__rescriptMeter) globalThis.__rescriptMeter = new Meter(new SupabaseMeterStore(supabaseAdmin()));
  return globalThis.__rescriptMeter;
}

/** The meter for the `/sandbox` fixture: in memory, one per process, seeded. */
export function getSandboxMeter(): Meter {
  if (!globalThis.__rescriptSandboxMeter) {
    const seed = Number(process.env.BILLING_SANDBOX_CREDITS ?? "100");
    globalThis.__rescriptSandboxMeter = new Meter(new MemoryMeterStore(), { seedBalance: Number.isFinite(seed) ? seed : 100, cacheMs: 0 });
  }
  return globalThis.__rescriptSandboxMeter;
}

export function isSandboxProject(surveyId: string | null | undefined): boolean {
  return !surveyId || surveyId === "sandbox";
}

export function meterFor(surveyId: string | null | undefined): Meter {
  return isSandboxProject(surveyId) ? getSandboxMeter() : getMeter();
}

/** The billing context of a Studio operation: the project's customer, the project, the person, LIVE (studio work is real spend). */
export function meterContextFor(user: AuthedUser | null, surveyId: string | null | undefined, environment: Environment = "LIVE"): MeterContext {
  if (isSandboxProject(surveyId) || !user) return { customerId: SANDBOX_CUSTOMER, surveyId: "sandbox", userId: user?.userId ?? null, environment };
  return { customerId: user.customerId ?? SANDBOX_CUSTOMER, surveyId: surveyId!, userId: user.userId, environment };
}

/** The billing context of a guarded project route. */
export function projectContext(gate: ProjectContext, environment: Environment = "LIVE"): MeterContext {
  return { customerId: gate.survey.customer_id ?? gate.user.customerId ?? SANDBOX_CUSTOMER, surveyId: gate.survey.id, userId: gate.user.userId, environment };
}

/**
 * The project a Studio provider call bills. The body names it (`surveyId`);
 * the caller must hold `capability` on it — a signed-in user may not spend
 * a project they cannot edit. The sandbox project is accepted without a
 * session; nothing about it reaches a database.
 */
export async function billingProjectFor(user: AuthedUser | null, surveyId: unknown, capability: Capability = "survey.edit"): Promise<{ ctx: MeterContext; meter: Meter } | { response: NextResponse }> {
  const id = typeof surveyId === "string" && surveyId.trim() ? surveyId.trim() : null;
  if (isSandboxProject(id)) return { ctx: meterContextFor(user, "sandbox"), meter: getSandboxMeter() };
  if (!user) return { response: NextResponse.json({ error: "sign in to use this project" }, { status: 401 }) };
  const gate = await requireProjectFor(user, id!, capability);
  if (isFailure(gate)) return { response: gate.response };
  return { ctx: projectContext(gate), meter: getMeter() };
}

/** Provider ids as the cost registry knows them; the fake provider is priced as the real one only when simulation is on. */
export function meterProvider(provider: string, kind: "chat" | "tts" | "stt" | "translate"): string {
  if (provider !== "fake") return provider;
  if (process.env.BILLING_SIMULATE_FAKE_COSTS !== "1") return "fake";
  return kind === "translate" ? "google" : "openai-compatible";
}
export function meterModel(provider: string, model: string | null, kind: "chat" | "tts" | "stt" | "translate"): string | null {
  if (provider !== "fake" || process.env.BILLING_SIMULATE_FAKE_COSTS !== "1") return model;
  return kind === "translate" ? "v2" : kind === "chat" ? aiModelName() : (process.env.AI_TTS_MODEL ?? "").trim() || "tts-1";
}

/** Turn collected provider reports into the usage the meter settles. */
export function usageToSpec(usage: AiUsage[], fallback: { kind: "chat" | "tts" | "translate" }): Partial<UsageSpec> {
  const t = sumUsage(usage);
  const provider = t.provider ?? "fake";
  const kind = usage[0]?.kind ?? fallback.kind;
  if (kind === "translate") return { provider: meterProvider(provider, "translate"), service: "translate", model: meterModel(provider, t.model, "translate"), quantity: t.characters, metadata: { requests: t.requests, estimated: t.estimated, actualProvider: provider } };
  if (kind === "tts") return { provider: meterProvider(provider, "tts"), service: "tts", model: meterModel(provider, t.model, "tts"), quantity: t.characters, metadata: { requests: t.requests, estimated: t.estimated, actualProvider: provider } };
  return { provider: meterProvider(provider, "chat"), service: "chat", model: meterModel(provider, t.model, "chat"), inputUnits: t.inputTokens, outputUnits: t.outputTokens, quantity: t.inputTokens + t.outputTokens, metadata: { requests: t.requests, estimated: t.estimated, actualProvider: provider } };
}

export type Metered<T> = { ok: true; value: T; event: UsageEvent | null } | MeterRefusal;

/**
 * Run an AI call under the meter: reserve from the prompt size and the
 * output ceiling, settle with what the provider actually reported.
 */
export async function meteredAi<T>(meter: Meter, ctx: MeterContext, eventType: string, est: { estimateText: string; maxTokens: number; requests?: number; operation: string }, fn: () => Promise<T>): Promise<Metered<T>> {
  const providerName = process.env.AI_API_URL === "fake:" ? "fake" : "openai-compatible";
  const reqs = est.requests ?? 1;
  const hold = await meter.reserve(ctx, {
    eventType, provider: meterProvider(providerName, "chat"), service: "chat", model: meterModel(providerName, aiModelName(), "chat"),
    inputUnits: (estimateTokens(est.estimateText) + 120) * reqs, outputUnits: est.maxTokens * reqs,
    metadata: { operation: est.operation },
  });
  if (!hold.ok) return hold;
  try {
    const { value, usage } = await collectUsage(fn);
    if (!usage.length) { await meter.release(hold); return { ok: true, value, event: null }; }
    const event = await meter.settle(hold, { ...usageToSpec(usage, { kind: "chat" }), metadata: { operation: est.operation, ...usageToSpec(usage, { kind: "chat" }).metadata } });
    return { ok: true, value, event };
  } catch (e) {
    await meter.release(hold).catch(() => {});
    throw e;
  }
}

/** Run a translation batch under the meter: reserve from the characters about to be sent, settle with what the adapter reported. */
export async function meteredTranslation<T>(meter: Meter, ctx: MeterContext, est: { characters: number; providerId: string; operation: string }, fn: () => Promise<T>): Promise<Metered<T>> {
  const prov = est.providerId === "llm" ? "openai-compatible" : est.providerId;
  const isChat = prov === "openai-compatible";
  const hold = await meter.reserve(ctx, isChat
    ? { eventType: "AI_REQUEST", provider: "openai-compatible", service: "chat", model: aiModelName(), inputUnits: estimateTokens("x".repeat(est.characters)) + 300, outputUnits: Math.max(200, estimateTokens("x".repeat(est.characters)) * 2), metadata: { operation: est.operation } }
    : { eventType: "TRANSLATION_CHARACTER", provider: meterProvider(prov, "translate"), service: "translate", model: meterModel(prov, prov === "google" ? "v2" : null, "translate"), quantity: Math.ceil(est.characters * 1.25), metadata: { operation: est.operation } });
  if (!hold.ok) return hold;
  try {
    const { value, usage } = await collectUsage(fn);
    if (!usage.length) { await meter.release(hold); return { ok: true, value, event: null }; }
    const kind = usage[0].kind === "chat" ? "chat" : "translate";
    const spec = usageToSpec(usage, { kind });
    const event = await meter.settle(hold, { ...spec, eventType: kind === "chat" ? "AI_REQUEST" : "TRANSLATION_CHARACTER", metadata: { operation: est.operation, ...spec.metadata } });
    return { ok: true, value, event };
  } catch (e) {
    await meter.release(hold).catch(() => {});
    throw e;
  }
}

/** The HTTP shape of a refusal: 402 when the balance is short, 423 when the project is read-only or suspended. */
export function refusalResponse(r: MeterRefusal): NextResponse {
  const status = r.reason === "insufficient_balance" ? 402 : r.reason === "read_only" || r.reason === "suspended" ? 423 : 503;
  return NextResponse.json({ error: r.message, code: `wallet_${r.reason}`, wallet: r.wallet ? { balance: r.wallet.balance, state: r.wallet.state, currency: r.wallet.currency } : null, estimate: r.estimate ? { customerCharge: r.estimate.customerCharge } : null }, { status });
}

/**
 * Non-metered billable actions (exports, report generation) still respect
 * READ_ONLY unless the configuration lets them through.
 */
export async function assertNotReadOnly(meter: Meter, ctx: Pick<MeterContext, "customerId" | "surveyId">, kind: "export" | "other"): Promise<NextResponse | null> {
  const cfg = await meter.config();
  if (kind === "export" && cfg.allowExportsWhenReadOnly) return null;
  const c = await meter.check(ctx).catch(() => ({ allowed: true, message: "" }));
  if (c.allowed) return null;
  return NextResponse.json({ error: c.message, code: "wallet_read_only" }, { status: 423 });
}

/** Record an event that is known when it happens (an export, an upload). Never throws — a lost usage row must not fail the user's action. */
export async function recordUsage(meter: Meter, ctx: MeterContext, spec: UsageSpec): Promise<UsageEvent | null> {
  try {
    const r = await meter.record(ctx, spec);
    return r.ok ? r.event : null;
  } catch (e) {
    console.warn("[rescript:billing] usage not recorded", JSON.stringify({ eventType: spec.eventType, error: (e as Error).message }));
    return null;
  }
}

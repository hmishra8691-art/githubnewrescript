import { NextResponse } from "next/server";
import {
  Meter, MemoryMeterStore, SupabaseMeterStore, estimateTokens,
  type MeterContext, type MeterRefusal, type UsageSpec, type UsageEvent, type Environment,
} from "@rescript/billing";
import { aiModelName } from "@rescript/ai";
import { aiSpec, meterModel, meterProvider, type AiEstimate } from "./aiEstimate";
import type { AiRefusal } from "./aiPolicy";
import { connectionFor } from "./byok/connect";
import { allowPrivateFrom } from "./byok/resolve";
import { connectionRefusalStatus, meteredCore, usageToSpec, type ConnectionRefusal, type Metered, type RunDeps } from "./meterRun";
export { usageToSpec, type ConnectionRefusal, type Metered };
export { aiSpec, meterModel, meterProvider, type AiEstimate };
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

export const SANDBOX_CUSTOMER = "sandbox";
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

/**
 * THE BILLING CONTEXT OF A STUDIO OPERATION.
 *
 * `environment` IS REQUIRED, AND THAT IS A BUG FIX, NOT A STYLE CHOICE.
 *
 * It used to default to `"LIVE"`, and not one caller in the whole Studio ever
 * passed it — which is not an oversight anybody could have noticed, because
 * the Studio has no response row to read `is_test` from and so had nothing to
 * pass. The result is in the production ledger: speech-to-text charged as
 * LIVE for clips with `session_id = null`, i.e. a researcher trying the
 * recorder in the editor; LIVE `FILE_UPLOAD` rows for the same takes; and
 * `EXPORT_GENERATION` rows whose own metadata says `include: "test"` sitting
 * beside `environment: "LIVE"` in the same row.
 *
 * A default is the wrong shape for this question. Every call site knows
 * something — the dataset it is exporting, the respondent list it is mailing,
 * the response a recording belongs to — and the one place that genuinely knows
 * nothing (a researcher's own take, with no respondent behind it) should say
 * TEST, because that is the side that cannot overcharge anybody. Making it an
 * argument is what forces each of them to answer.
 *
 * Authoring work — rephrasing a question, translating a questionnaire, a
 * stimulus video — is LIVE and passes LIVE explicitly. It is real spend by a
 * paying customer on building their study, and there is no respondent
 * environment to inherit.
 */
export function meterContextFor(user: AuthedUser | null, surveyId: string | null | undefined, environment: Environment): MeterContext {
  if (isSandboxProject(surveyId) || !user) return { customerId: SANDBOX_CUSTOMER, surveyId: "sandbox", userId: user?.userId ?? null, environment };
  return { customerId: user.customerId ?? SANDBOX_CUSTOMER, surveyId: surveyId!, userId: user.userId, environment };
}

/** The billing context of a guarded project route. See `meterContextFor`. */
export function projectContext(gate: ProjectContext, environment: Environment): MeterContext {
  return { customerId: gate.survey.customer_id ?? gate.user.customerId ?? SANDBOX_CUSTOMER, surveyId: gate.survey.id, userId: gate.user.userId, environment };
}

/**
 * For a LOOKUP rather than a charge — reading a wallet, rendering the usage
 * view. Nothing is billed, so there is no environment to state, and inventing
 * one to satisfy a type is how the default above came to exist in the first
 * place.
 */
export function projectLookup(gate: ProjectContext): Pick<MeterContext, "customerId" | "surveyId" | "userId"> {
  return { customerId: gate.survey.customer_id ?? gate.user.customerId ?? SANDBOX_CUSTOMER, surveyId: gate.survey.id, userId: gate.user.userId };
}

/**
 * The environment a stored recording belongs to.
 *
 * A recording carries its own answer: the response it was captured in. One
 * that belongs to no response at all was made by a researcher in the editor
 * — a take, a trial of the recorder — and is TEST. Transcribing a clip from a
 * pilot interview must not bill as production, which is exactly what the
 * default did.
 */
export async function mediaEnvironment(mediaId: string): Promise<Environment> {
  try {
    const db = supabaseAdmin();
    const { data: media } = await db.from("media_objects").select("response_id").eq("id", mediaId).maybeSingle();
    const responseId = (media as { response_id?: string | null } | null)?.response_id;
    if (!responseId) return "TEST";
    const { data: resp } = await db.from("responses").select("is_test").eq("id", responseId).maybeSingle();
    /* an unreadable row is TEST: the safe side of a question about money */
    return (resp as { is_test?: boolean } | null)?.is_test === false ? "LIVE" : "TEST";
  } catch {
    return "TEST";
  }
}

/**
 * The project a Studio provider call bills. The body names it (`surveyId`);
 * the caller must hold `capability` on it — a signed-in user may not spend
 * a project they cannot edit. The sandbox project is accepted without a
 * session; nothing about it reaches a database.
 *
 * LIVE, and stated rather than defaulted: this is the door for AI authoring —
 * rephrasing, translating, speech — which is real spend on building the
 * study and has no respondent environment to inherit.
 */
export async function billingProjectFor(user: AuthedUser | null, surveyId: unknown, capability: Capability = "survey.edit"): Promise<{ ctx: MeterContext; meter: Meter } | { response: NextResponse }> {
  const id = typeof surveyId === "string" && surveyId.trim() ? surveyId.trim() : null;
  /*
   * A MISSING `surveyId` IS NOT THE SANDBOX.
   *
   * This asked `isSandboxProject(id)`, and that function answers TRUE for
   * null — it was written for "which meter does this page use", where no
   * project genuinely means the fixture. Here it meant that OMITTING the field
   * routed the reservation to the process-local in-memory meter seeded with
   * 100 credits, while the real provider was called with the installation's
   * key: no wallet debited, no project permission checked (`requireProjectFor`
   * is on the other branch), and a frozen or empty wallet never refusing. Any
   * signed-in account — a viewer who may edit nothing — could translate and
   * synthesise indefinitely on the operator's spend.
   *
   * The sandbox is now what it claims to be: the literal `sandbox` project, or
   * the unauthenticated carve-out that `requireAiCaller` only allows against
   * the FAKE provider (free and deterministic, so there is nothing to spend).
   * A signed-in caller that names no project is asked to name one.
   */
  if (!user) return { ctx: meterContextFor(null, "sandbox", "LIVE"), meter: getSandboxMeter() };
  if (id === "sandbox") return { ctx: meterContextFor(user, "sandbox", "LIVE"), meter: getSandboxMeter() };
  if (!id) {
    return { response: NextResponse.json({ error: "Name the project this is billed to (surveyId).", code: "survey_required" }, { status: 400 }) };
  }
  const gate = await requireProjectFor(user, id, capability);
  if (isFailure(gate)) return { response: gate.response };
  return { ctx: projectContext(gate, "LIVE"), meter: getMeter() };
}

/** Provider ids as the cost registry knows them; the fake provider is priced as the real one only when simulation is on. */

/**
 * Run an AI call under the meter: reserve from the prompt size and the
 * output ceiling, settle with what the provider actually reported.
 */
/**
 * What an AI call WOULD cost, priced exactly as `meteredAi` would reserve it —
 * for the "estimated cost" a person sees before choosing to run it (the
 * import brief §33). Touches no wallet.
 */
const runDeps: RunDeps = { connectionFor, allowPrivate: () => allowPrivateFrom() };

export async function estimateAi(meter: Meter, ctx: MeterContext, eventType: string, est: AiEstimate): Promise<number> {
  try {
    /* on the user's own provider the platform charges nothing for the model — the estimate says so (the provider bills the user directly) */
    const conn = await connectionFor({ userId: ctx.userId, customerId: ctx.customerId, surveyId: ctx.surveyId, operation: est.operation });
    if (conn.kind === "user" && !conn.scope.fallbacks.some((f) => f.platform)) return 0; return (await meter.estimate(ctx, aiSpec(eventType, est))).customerCharge; } catch { return 0; }
}

export async function meteredAi<T>(meter: Meter, ctx: MeterContext, eventType: string, est: AiEstimate, fn: () => Promise<T>): Promise<Metered<T>> {
  return meteredCore(runDeps, meter, ctx, { operation: est.operation, once: est.consent === "once", kind: "chat", reserve: () => aiSpec(eventType, est) }, fn);
}

/** Run a text-to-speech call under the meter: priced per character, on the user's own provider when they chose one that can speak. */
export async function meteredTts<T>(meter: Meter, ctx: MeterContext, o: { operation: string; characters: number; language?: string }, fn: () => Promise<T>): Promise<Metered<T>> {
  const providerName = process.env.AI_API_URL === "fake:" ? "fake" : "openai-compatible";
  return meteredCore(runDeps, meter, ctx, {
    operation: o.operation, kind: "tts",
    reserve: () => ({ eventType: "TEXT_TO_SPEECH_CHARACTER", provider: meterProvider(providerName, "tts"), service: "tts", model: meterModel(providerName, (process.env.AI_TTS_MODEL ?? "").trim() || "tts-1", "tts"), quantity: o.characters, metadata: { operation: o.operation, ...(o.language ? { language: o.language } : {}) } }),
  }, fn);
}

/**
 * Run a speech-to-text call under the meter: reserve from the clip's length,
 * settle with what the provider reported. Shared by the media pipeline's
 * `projectStt` and the Intelligent mode's voice route, so a minute of
 * researcher speech is charged exactly as a minute of respondent speech.
 *
 * It walks the same door as every other model call (`meteredCore`): the project's
 * feature switch, then WHOSE provider — the project's choice, else the acting
 * user's own speech provider, else the platform — then money. On the user's own
 * provider there is no wallet (they pay their provider); the minutes are
 * recorded at zero charge for attribution. A meter that cannot be reached runs a
 * platform call unmetered and says so in the log — a recording must not be lost
 * to a billing outage.
 */
export async function meteredSttCall<T>(meter: Meter, ctx: MeterContext, operation: string, seconds: number, fn: () => Promise<T>): Promise<Metered<T>> {
  const providerName = process.env.AI_API_URL === "fake:" || process.env.AI_STT_API_URL === "fake:" ? "fake" : "openai-compatible";
  const minutes = Math.max(0.05, seconds / 60);
  return meteredCore(runDeps, meter, ctx, {
    operation, kind: "stt", tolerateMeterOutage: true,
    reserve: () => ({
      eventType: "SPEECH_TO_TEXT_MINUTE",
      provider: meterProvider(providerName, "stt"),
      service: "stt",
      model: meterModel(providerName, (process.env.AI_STT_MODEL ?? "").trim() || "whisper-1", "stt"),
      quantity: minutes,
      metadata: { operation, seconds },
    }),
  }, fn);
}

/** the same, in the shape the media pipeline takes: a value, or the sentence that says why it was not run */
export async function meteredStt<T>(meter: Meter, ctx: MeterContext, operation: string, seconds: number, fn: () => Promise<T>): Promise<{ value: T } | { refused: string }> {
  const m = await meteredSttCall(meter, ctx, operation, seconds, fn);
  return m.ok ? { value: m.value } : { refused: m.message };
}

/**
 * Run a translation batch under the meter. It walks the same door as every other
 * model call (`meteredCore`): the project's switch, then WHOSE provider — the
 * project's choice, else the acting user's own translation service (or AI
 * model), else the platform's — then money.
 *
 * On the platform's provider: reserve from the characters about to be sent,
 * settle with what the adapter reported (a language model is priced as a chat
 * call, a translation service per character). On the user's own: no wallet — the
 * characters are recorded at zero charge for attribution; their provider bills
 * them. `est.providerId` is the PLATFORM's adapter for the call, reserved only
 * on the platform path and for a backstop the user allowed.
 */
export async function meteredTranslation<T>(meter: Meter, ctx: MeterContext, est: { characters: number; providerId: string; operation: string }, fn: () => Promise<T>): Promise<Metered<T>> {
  const prov = est.providerId === "llm" ? "openai-compatible" : est.providerId;
  const isChat = prov === "openai-compatible";
  return meteredCore(runDeps, meter, ctx, {
    operation: est.operation, kind: "translate", platformIsLlm: isChat,
    reserve: () => (isChat
      ? { eventType: "AI_REQUEST", provider: "openai-compatible", service: "chat", model: aiModelName(), inputUnits: estimateTokens("x".repeat(est.characters)) + 300, outputUnits: Math.max(200, estimateTokens("x".repeat(est.characters)) * 2), metadata: { operation: est.operation } }
      : { eventType: "TRANSLATION_CHARACTER", provider: meterProvider(prov, "translate"), service: "translate", model: meterModel(prov, prov === "google" ? "v2" : null, "translate"), quantity: Math.ceil(est.characters * 1.25), metadata: { operation: est.operation } }),
  }, fn);
}

/** The HTTP shape of a refusal: 402 when the balance is short, 423 when the project is read-only or suspended. */
export function refusalResponse(r: MeterRefusal | AiRefusal | ConnectionRefusal): NextResponse {
  if (r.reason === "ai_off") return NextResponse.json({ error: r.message, code: "ai_disabled", why: (r as AiRefusal).why }, { status: 403 });
  if (r.reason === "ai_connection") return NextResponse.json({ error: r.message, code: "ai_connection", why: r.code, source: r.source }, { status: connectionRefusalStatus(r.code) });
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

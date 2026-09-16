import "server-only";
import {
  Meter, MemoryMeterStore, SupabaseMeterStore,
  type Environment, type MeterContext, type UsageSpec,
} from "@rescript/billing";
import { aiModelName, collectUsage, sumUsage, type AiUsage } from "@rescript/ai";
import { supabaseAdmin } from "./admin";

/**
 * WHAT AN INTERVIEW COSTS, CHARGED TO THE RIGHT WALLET.
 *
 * Until now `@rescript/billing` was a dependency of this app that no file
 * imported: interviews recorded, stored and — once there is a runner —
 * transcribed, all for free. Transcription is the first thing here that hands
 * money to somebody else, so it is the first thing metered.
 *
 * ## The subject is the interview PROJECT
 *
 * `0031_billing_subject.sql` generalised `project_spending` from a survey id
 * to a `(subject_kind, subject_id)` pair precisely so this could exist. The
 * wallet resolves through `rescript_billing_subject_wallet_for`, which for an
 * interview project reads its `owner_id` and funds from that person's wallet,
 * falling back to the workspace. There is no per-interview-project wallet, and
 * adding one would recreate the pooling problem 0025 swept away.
 *
 * ## A refusal does not lose the recording
 *
 * The same rule the runtime follows: an empty wallet means the transcript is
 * not produced, and the recording is untouched and still there. What must
 * never happen is the reverse — paying a provider and then failing to record
 * that we did, which is how a month's transcription goes unbilled.
 */

const dbConfigured = () => !!process.env.SUPABASE_URL && !!process.env.SUPABASE_SERVICE_ROLE_KEY;

declare global {
  // eslint-disable-next-line no-var
  var __rescriptInterviewsMeter: Meter | undefined;
}

export function getMeter(): Meter {
  if (!globalThis.__rescriptInterviewsMeter) {
    globalThis.__rescriptInterviewsMeter = dbConfigured()
      ? new Meter(new SupabaseMeterStore(supabaseAdmin()))
      : new Meter(new MemoryMeterStore(), {
          seedBalance: Number(process.env.BILLING_SANDBOX_CREDITS ?? "100") || 100,
          cacheMs: 0,
        });
  }
  return globalThis.__rescriptInterviewsMeter;
}

export interface InterviewBilling {
  customerId: string;
  /** the interview PROJECT — the billing subject, not the sitting */
  projectId: string;
  environment: Environment;
}

export function contextOf(b: InterviewBilling): MeterContext {
  return {
    customerId: b.customerId,
    surveyId: b.projectId,
    /* the whole point of 0031 */
    subjectKind: "interview",
    userId: null,
    environment: b.environment,
  };
}

const simulateFake = () => process.env.BILLING_SIMULATE_FAKE_COSTS === "1";

function sttProviderLabel(provider: string): string {
  if (provider !== "fake") return provider;
  return simulateFake() ? "openai-compatible" : "fake";
}
function sttModelLabel(provider: string, model: string | null): string | null {
  if (provider !== "fake" || !simulateFake()) return model;
  return (process.env.AI_STT_MODEL ?? "").trim() || "whisper-1";
}

/**
 * Turn what the provider reported into what the meter settles.
 *
 * Branching on `kind` is not optional. Both the Studio and the runtime carry a
 * comment about this because both were bitten by it: an stt report priced
 * through a chat branch settles at zero, because it has audio seconds and the
 * chat branch is looking for tokens. A cost that silently rounds to nothing is
 * worse than one that errors.
 */
function usageToSpec(usage: AiUsage[]): Partial<UsageSpec> {
  const stt = usage.filter((u) => u.kind === "stt");
  if (!stt.length) return {};
  const total = sumUsage(stt);
  const seconds = Number(total.seconds ?? 0);
  const provider = sttProviderLabel(String(stt[0].provider ?? "openai-compatible"));
  return {
    provider,
    service: "stt",
    model: sttModelLabel(String(stt[0].provider ?? ""), String(stt[0].model ?? "")) ?? undefined,
    /* the rate is per audio MINUTE; a floor stops a two-second clip rounding to free */
    quantity: Math.max(0.05, seconds / 60),
    unit: "minute",
    metadata: { seconds, requests: total.requests ?? stt.length },
  };
}

export interface MeteredOutcome<T> {
  value?: T;
  refused?: string;
  /** what was actually settled, so the transcript row can record what we paid for */
  billedSeconds?: number;
}

/**
 * Run a transcription with a hold on the wallet, and settle what it really cost.
 *
 * `idempotencyKey` is what makes a retried job safe. `usage_events` has a
 * unique partial index on it since 0031, and `rescript_billing_insert_usage`
 * returns the EXISTING row on a collision — so a job that transcribes, settles,
 * and is then retried because the database write failed afterwards does not
 * charge twice. Without it, retrying is the normal case for a queue and
 * double-charging would be the normal outcome.
 */
export async function meteredTranscription<T>(
  billing: InterviewBilling,
  args: { seconds: number; operation: string; idempotencyKey: string },
  fn: () => Promise<T>,
): Promise<MeteredOutcome<T>> {
  const meter = getMeter();
  const ctx = contextOf(billing);
  const minutes = Math.max(0.05, args.seconds / 60);

  let hold;
  try {
    hold = await meter.reserve(ctx, {
      eventType: "SPEECH_TO_TEXT_MINUTE",
      provider: sttProviderLabel(process.env.AI_STT_API_URL ? "openai-compatible" : "fake"),
      service: "stt",
      model: (process.env.AI_STT_MODEL ?? "").trim() || "whisper-1",
      quantity: minutes,
      unit: "minute",
      metadata: { operation: args.operation, seconds: args.seconds },
    });
  } catch (e) {
    /*
     * The meter being unreachable must not stop the work. A transcription that
     * happened and was not billed is recoverable from the provider's own
     * invoice; a queue that stalls because billing had a bad minute is not.
     */
    console.warn("[rescript:billing] meter unavailable — transcribing unmetered",
      JSON.stringify({ error: (e as Error).message }));
    return { value: await fn() };
  }

  if (!hold.ok) return { refused: hold.message };

  try {
    const { value, usage } = await collectUsage(fn);
    if (!usage.length) {
      /* nothing was actually spent — a cached or fake result */
      await meter.release(hold);
      return { value };
    }
    const spec = usageToSpec(usage);
    await meter.settle(hold, {
      ...spec,
      eventType: "SPEECH_TO_TEXT_MINUTE",
      idempotencyKey: args.idempotencyKey,
      metadata: { operation: args.operation, ...(spec.metadata ?? {}) },
    });
    const billedSeconds = Number((spec.metadata as { seconds?: number } | undefined)?.seconds ?? args.seconds);
    return { value, billedSeconds };
  } catch (e) {
    /* the hold is released so an error does not leave money reserved for ever */
    await meter.release(hold).catch(() => {});
    throw e;
  }
}

/**
 * The same, for one analysis run.
 *
 * `AI_REQUEST` rather than a new event type: the registry already prices a
 * model call from its input and output tokens, and an interview analysis is
 * one. A separate type would only be needed if the dashboard should break
 * interview analysis out from every other AI call, which nobody has asked for.
 *
 * Priced per token rather than per minute, so it settles through the chat
 * branch — and `usageToSpec` above deliberately ignores chat usage, because
 * mixing the two in one function is how an stt report gets priced as tokens.
 * This one has its own.
 */
function chatToSpec(usage: AiUsage[]): Partial<UsageSpec> {
  const chat = usage.filter((u) => u.kind === "chat");
  if (!chat.length) return {};
  const total = sumUsage(chat);
  return {
    provider: process.env.AI_API_URL === "fake:" ? "fake" : "openai-compatible",
    service: "chat",
    model: String(chat[0].model ?? aiModelName()),
    inputUnits: Number(total.inputTokens ?? 0),
    outputUnits: Number(total.outputTokens ?? 0),
    quantity: Number(total.inputTokens ?? 0) + Number(total.outputTokens ?? 0),
    unit: "token",
    metadata: { requests: total.requests ?? chat.length },
  };
}

export async function meteredAnalysis<T>(
  billing: InterviewBilling,
  args: { estimatedTokens: number; operation: string; idempotencyKey: string },
  fn: () => Promise<T>,
): Promise<MeteredOutcome<T>> {
  const meter = getMeter();
  const ctx = contextOf(billing);

  let hold;
  try {
    hold = await meter.reserve(ctx, {
      eventType: "AI_REQUEST",
      provider: process.env.AI_API_URL === "fake:" ? "fake" : "openai-compatible",
      service: "chat",
      model: aiModelName(),
      /*
       * The reservation is an ESTIMATE from the prompt size; the settle
       * replaces it with what the provider actually counted. Reserving nothing
       * and settling the truth would let an analysis run on an empty wallet.
       */
      quantity: Math.max(1, args.estimatedTokens),
      unit: "token",
      metadata: { operation: args.operation },
    });
  } catch (e) {
    console.warn("[rescript:billing] meter unavailable — analysing unmetered",
      JSON.stringify({ error: (e as Error).message }));
    return { value: await fn() };
  }

  if (!hold.ok) return { refused: hold.message };

  try {
    const { value, usage } = await collectUsage(fn);
    if (!usage.length) { await meter.release(hold); return { value }; }
    const spec = chatToSpec(usage);
    await meter.settle(hold, {
      ...spec,
      eventType: "AI_REQUEST",
      idempotencyKey: args.idempotencyKey,
      metadata: { operation: args.operation, ...(spec.metadata ?? {}) },
    });
    return { value };
  } catch (e) {
    await meter.release(hold).catch(() => {});
    throw e;
  }
}

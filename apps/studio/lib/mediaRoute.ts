import "server-only";
import { NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/admin";
import { getMeter, projectContext, meterProvider, meterModel, usageToSpec } from "@/lib/metering";
import type { Environment } from "@rescript/billing";
import { collectUsage } from "@rescript/ai";
import type { ProjectContext } from "@/lib/guard";
import type { MediaDb, MeteredRun } from "@rescript/media";
import { buildMediaStores } from "@rescript/media/server";

/**
 * The Studio's half of the media pipeline: a database handle and a wallet.
 *
 * Everything about WHAT to do with a recording lives in `@rescript/media`,
 * which is deliberately free of Next, of `server-only` and of the Supabase
 * client so that the policy is testable without any of them. These two
 * functions are the injection points, and they are the only things that
 * differ between the Studio (a researcher's question, charged to the project)
 * and the runtime (a respondent's answer, charged to the session).
 */
export function mediaDb(): MediaDb {
  /*
   * The database handle, with the stores beside it: Cloudflare R2 for
   * everything new when it is configured, Supabase Storage for the objects
   * stored before the switch (and for everything, until it is). See
   * `@rescript/media/server` — this is the only line that knows.
   */
  const admin = supabaseAdmin();
  return {
    from: (t: string) => admin.from(t),
    rpc: (fn: string, args: Record<string, unknown>) => admin.rpc(fn as never, args as never),
    stores: buildMediaStores(admin.storage as never),
  } as unknown as MediaDb;
}

export function mediaDbOrResponse(): { db: MediaDb } | { response: NextResponse } {
  try {
    return { db: mediaDb() };
  } catch (e) {
    return { response: NextResponse.json({ error: (e as Error).message }, { status: 501 }) };
  }
}

/**
 * A speech-to-text hold against the project's wallet.
 *
 * Same reservation shape as the runtime's `meteredSessionStt` — minutes of
 * audio, held before the call and corrected on settle — because it is the
 * same event type and must price identically wherever it is spent. A refusal
 * is returned rather than thrown: an empty wallet leaves the recording stored
 * and the transcript retryable, and is never allowed to look like a broken
 * pipeline.
 *
 * `environment` is the clip's, resolved by the caller from the response it
 * belongs to. This is the path that actually charged for test work: two rows
 * in the production ledger say LIVE for clips with no session at all — a
 * researcher trying the recorder — because the context builder defaulted to
 * LIVE and nobody could pass anything else.
 */
export function projectStt(gate: ProjectContext, operation: string, environment: Environment): MeteredRun {
  return async <T>(seconds: number, fn: () => Promise<T>): Promise<{ value: T } | { refused: string }> => {
    const meter = getMeter();
    const ctx = projectContext(gate, environment);
    const providerName = process.env.AI_API_URL === "fake:" ? "fake" : "openai-compatible";
    const minutes = Math.max(0.05, seconds / 60);
    let hold;
    try {
      hold = await meter.reserve(ctx, {
        eventType: "SPEECH_TO_TEXT_MINUTE",
        provider: meterProvider(providerName, "stt"),
        service: "stt",
        model: meterModel(providerName, (process.env.AI_STT_MODEL ?? "").trim() || "whisper-1", "stt"),
        quantity: minutes,
        metadata: { operation, seconds },
      });
    } catch (e) {
      console.warn("[rescript:billing] meter unavailable — running unmetered", JSON.stringify({ error: (e as Error).message }));
      return { value: await fn() };
    }
    if (!hold.ok) return { refused: hold.message };
    try {
      const { value, usage } = await collectUsage(fn);
      if (!usage.length) { await meter.release(hold); return { value }; }
      const spec = usageToSpec(usage, { kind: "stt" });
      await meter.settle(hold, { ...spec, eventType: "SPEECH_TO_TEXT_MINUTE", metadata: { operation, ...spec.metadata } });
      return { value };
    } catch (e) {
      await meter.release(hold).catch(() => {});
      throw e;
    }
  };
}

import "server-only";
import { NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/admin";
import { getMeter, projectContext, meteredStt } from "@/lib/metering";
import type { Environment } from "@rescript/billing";
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
  return <T>(seconds: number, fn: () => Promise<T>) => meteredStt(getMeter(), projectContext(gate, environment), operation, seconds, fn);
}

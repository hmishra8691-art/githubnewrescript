import "server-only";
import { NextResponse } from "next/server";
import type { customerDb } from "@/lib/db";
import { meteredSessionStt, type SessionBilling } from "@/lib/metering";
import type { MediaDb, MeteredRun } from "@rescript/media";
import { buildMediaStores } from "@rescript/media/server";

/**
 * The runtime's half of the media pipeline: a database handle and the
 * session's wallet.
 *
 * Mirrors `apps/studio/lib/mediaRoute.ts`. The pipeline itself —
 * reserve a row, hand out a signed URL, confirm, queue, claim, transcribe —
 * lives in `@rescript/media` and is the same code for both; only the billing
 * context differs, because a researcher's question is charged to the project
 * and a respondent's answer to the session.
 */
type Db = ReturnType<typeof customerDb>;

/** the media pipeline on ONE client's database — the caller says which (surveyDb / sessionDb / keyDb, lib/db.ts) */
export function mediaDb(admin: Db): MediaDb {
  /* the stores beside the handle — see `apps/studio/lib/mediaRoute.ts` and `@rescript/media/server` */
  return {
    from: (t: string) => admin.from(t),
    rpc: (fn: string, args: Record<string, unknown>) => admin.rpc(fn as never, args as never),
    stores: buildMediaStores(admin.storage as never),
  } as unknown as MediaDb;
}

export async function mediaDbOrResponse(open: () => Promise<Db>): Promise<{ db: MediaDb } | { response: NextResponse }> {
  try {
    return { db: mediaDb(await open()) };
  } catch (e) {
    return { response: NextResponse.json({ error: (e as Error).message }, { status: 501 }) };
  }
}

/** A speech-to-text hold against the session's project, as it always was. */
export function sessionStt(billing: SessionBilling | null, operation: string): MeteredRun {
  return async <T>(seconds: number, fn: () => Promise<T>): Promise<{ value: T } | { refused: string }> => {
    const out = await meteredSessionStt(billing, { seconds, operation }, fn);
    if ("refused" in out) return { refused: out.refused };
    return { value: out.value };
  };
}

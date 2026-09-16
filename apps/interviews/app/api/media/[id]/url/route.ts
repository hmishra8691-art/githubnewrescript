import { NextRequest, NextResponse } from "next/server";
import { isFailure } from "@/lib/auth";
import { playbackUrl, requireMedia } from "@/lib/recordings";

export const dynamic = "force-dynamic";

/**
 * A SHORT-LIVED URL THAT PLAYS ONE RECORDING.
 *
 * Until this route existed, nothing in this product could be watched.
 * `createSignedDownloadUrl` had been written and tested since Phase 1 and had
 * no caller: recordings went into R2 and stayed there, reachable only by
 * somebody with the account credentials.
 *
 * The capability is `media.read`, which a `viewer` deliberately does NOT have
 * (`lib/auth.ts`): following a hiring project's progress and watching
 * somebody's interview are different permissions, and the difference is the
 * whole distance between a dashboard a team can see and a privacy incident.
 *
 * The URL is minted per request and never cached. A cached signed URL outlives
 * the permission check that produced it, which is the same bug as a stale
 * link — the thing §18 asks to be impossible.
 */
export async function GET(req: NextRequest, { params }: { params: { id: string } }) {
  const ctx = await requireMedia(req, params.id, "media.read");
  if (isFailure(ctx)) return ctx.response;

  const out = await playbackUrl(ctx);
  if (!out.ok) return out.response;

  return NextResponse.json(
    {
      ok: true,
      url: out.url,
      expiresIn: out.expiresIn,
      mimeType: ctx.media.mime_type,
      durationSeconds: ctx.media.duration_seconds,
      kind: ctx.media.kind,
    },
    /*
     * `no-store` matters more than usual. A signed URL in a shared cache is a
     * signed URL handed to whoever asks next.
     */
    { headers: { "cache-control": "no-store" } },
  );
}

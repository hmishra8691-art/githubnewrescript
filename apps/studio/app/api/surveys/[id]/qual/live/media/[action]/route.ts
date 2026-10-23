import { NextRequest } from "next/server";
import { MediaError } from "@rescript/media";
import { chunkAction } from "@rescript/analytics/live";
import { isFailure, requireProjectFor, requireUser } from "@/lib/guard";
import { mediaDbOrResponse } from "@/lib/mediaRoute";
import { qualGuardCapability } from "@/lib/qual/qualAccess";
import { json, refuse } from "@/lib/qual/qualStore";
import { isSandbox, liveDeps, mediaChunkOps, sandboxBlobKey, sandboxChunkOps, sandboxReady, storeFor, writeSandboxBlob } from "@/lib/live/liveServer";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * A LIVE SESSION'S RECORDED CHUNKS — THE STUDIO'S MEMBERS (2026-10-22, G2): the moderator's own audio (and video,
 * when the session records video), uploaded by the console as each chunk ends. The same three steps as every
 * recording (`ticket` → PUT to a signed URL of the private `rescript-qual` bucket → `confirm`, verified by the
 * store; `parts` resumes), gated by `chunkAction` (in the session, recorded, live or just ended). Body: the
 * uploader's fields plus { token: <member token>, track, seq, startMs, durationMs }.
 *
 * THE SANDBOX (fake provider, no storage) keeps chunks in a temp folder: `ticket` hands out an address on this
 * route (`PUT …/media/blob?m=&k=`, the key an HMAC of the chunk id) — also for the respondent app's participants,
 * which it forwards here (`via: "runtime"`).
 */
export async function POST(req: NextRequest, { params }: { params: { id: string; action: string } }) {
  const authed = await requireUser(req);
  const body = (await req.json().catch(() => null)) as Record<string, unknown> | null;
  if (!body) return isFailure(authed) ? authed.response : json({ error: "expected a JSON body" }, 400);
  if (!["ticket", "parts", "confirm"].includes(params.action)) return json({ error: "ticket, parts or confirm" }, 404);
  try {
    if (isSandbox(params.id)) {
      if (!sandboxReady()) return isFailure(authed) ? authed.response : json({ error: "the sandbox runs live sessions only against the fake provider" }, 403);
      const viaRuntime = body.via === "runtime";
      const r = await chunkAction(storeFor(params.id), params.action, body, liveDeps, sandboxChunkOps(`/api/surveys/sandbox/qual/live/media/blob`), { allowRoles: viaRuntime ? ["participant"] : ["moderator"], surveyId: "sandbox" });
      return json(r.body, r.status);
    }
    if (isFailure(authed)) return authed.response;
    const gate = await requireProjectFor(authed, params.id, qualGuardCapability("read"));
    if (isFailure(gate)) return gate.response;
    const refused = refuse(gate, "read");
    if (refused) return refused;
    const handle = mediaDbOrResponse();
    if ("response" in handle) return handle.response;
    /* only the moderator records from the Studio (observers are never recorded; participants upload from the respondent app) */
    const r = await chunkAction(storeFor(params.id), params.action, body, liveDeps, mediaChunkOps(handle.db, authed.userId), { allowRoles: ["moderator"], surveyId: params.id });
    return json(r.body, r.status);
  } catch (e) {
    if (e instanceof MediaError) return json({ error: e.message }, e.status);
    const status = (e as { status?: number }).status;
    return json({ error: (e as Error).message }, typeof status === "number" ? status : 500);
  }
}

/** the sandbox's chunk bytes (PUT …/media/blob?m=&k=) — fake provider only; a key mints only for an issued chunk */
export async function PUT(req: NextRequest, { params }: { params: { id: string; action: string } }) {
  const authed = await requireUser(req);
  if (!isSandbox(params.id) || params.action !== "blob") return isFailure(authed) ? authed.response : json({ error: "not here" }, 404);
  if (!sandboxReady()) return isFailure(authed) ? authed.response : json({ error: "the sandbox runs live sessions only against the fake provider" }, 403);
  const m = req.nextUrl.searchParams.get("m") ?? "";
  const k = req.nextUrl.searchParams.get("k") ?? "";
  if (!/^sbx-[0-9a-f]{24}$/.test(m) || k !== sandboxBlobKey(m)) return json({ error: "this upload address is not valid" }, 403);
  const bytes = new Uint8Array(await req.arrayBuffer());
  if (!bytes.length || bytes.length > 25 * 1024 * 1024) return json({ error: "a chunk is between 1 byte and 25 MB" }, 413);
  writeSandboxBlob(m, bytes);
  return new Response(null, { status: 200, headers: { etag: `"${m}"` } });
}

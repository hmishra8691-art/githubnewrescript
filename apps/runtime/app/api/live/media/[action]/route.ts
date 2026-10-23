import { NextRequest } from "next/server";
import { MediaError } from "@rescript/media";
import { chunkAction } from "@rescript/analytics/live";
import { mediaDbOrResponse } from "@/lib/mediaRoute";
import { forward, hasDatabase, liveDeps, liveStore, mediaChunkOps, reply, sandboxForwarding, studioSandbox } from "@/lib/live";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * A PARTICIPANT'S RECORDED CHUNKS (2026-10-22, G2) — with their consent, each participant's browser records their
 * OWN microphone (and camera, when the session records video) in standalone chunks and uploads each as it ends:
 * `ticket` → PUT to a signed URL of the private `rescript-qual` bucket → `confirm` (verified by the store);
 * `parts` resumes. Gated by `chunkAction` (in the session, agreed to the recording, live or just ended). The body is
 * the uploader's fields plus { token: <member token>, track, seq, startMs, durationMs }.
 *
 * Without a database (the Studio's sandbox, fake provider only) the steps are forwarded to the Studio and the PUT
 * address is this app's own `PUT /api/live/media/blob`, which passes the bytes on.
 */
export async function POST(req: NextRequest, { params }: { params: { action: string } }) {
  const body = (await req.json().catch(() => ({}))) as Record<string, unknown>;
  if (!["ticket", "parts", "confirm"].includes(params.action)) return reply({ error: "ticket, parts or confirm" }, 404);
  if (!hasDatabase()) {
    if (!sandboxForwarding()) return reply({ error: "Recordings need a database and storage." }, 503);
    const r = await forward(`/media/${params.action}`, body);
    const data = (await r.json()) as Record<string, unknown>;
    /* the participant's browser PUTs to this app, which passes the bytes to the Studio's sandbox */
    if (typeof data.uploadUrl === "string") data.uploadUrl = data.uploadUrl.replace(/^\/api\/surveys\/sandbox\/qual\/live\/media\/blob/, "/api/live/media/blob");
    return reply(data, r.status);
  }
  try {
    const handle = mediaDbOrResponse();
    if ("response" in handle) return handle.response;
    const r = await chunkAction(liveStore(), params.action, body, liveDeps, mediaChunkOps(handle.db), { allowRoles: ["participant"] });
    return reply(r.body, r.status);
  } catch (e) {
    if (e instanceof MediaError) return reply({ error: e.message }, e.status);
    console.warn("[rescript:live] chunk request failed", JSON.stringify({ action: params.action, error: (e as Error).message }));
    return reply({ error: "The recording chunk could not be saved — it will be retried." }, 500);
  }
}

/** sandbox only: the chunk's bytes, passed on to the Studio's sandbox (which checks the address's key) */
export async function PUT(req: NextRequest, { params }: { params: { action: string } }) {
  if (params.action !== "blob" || hasDatabase() || !sandboxForwarding()) return reply({ error: "not here" }, 404);
  const qs = req.nextUrl.search;
  try {
    const r = await fetch(`${studioSandbox()}/api/surveys/sandbox/qual/live/media/blob${qs}`, { method: "PUT", body: new Uint8Array(await req.arrayBuffer()), cache: "no-store", signal: AbortSignal.timeout(60_000) });
    return new Response(r.ok ? null : await r.text(), { status: r.status, headers: { ...(r.headers.get("etag") ? { etag: r.headers.get("etag")! } : {}) } });
  } catch { return reply({ error: "the sandbox did not answer" }, 503); }
}

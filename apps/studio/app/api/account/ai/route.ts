import { NextRequest, NextResponse } from "next/server";
import { audit, isFailure, requireUser } from "@/lib/guard";
import { byokDeps, readJson, storeSafe } from "@/lib/byok/server";
import { overview, saveSetting } from "@/lib/byok/service";

export const dynamic = "force-dynamic";

/**
 * MY AI PROVIDERS — Settings → AI & Integrations → AI Provider Configuration.
 *
 * GET   what the screen shows: the catalog, my saved keys (masked), and, per
 *       feature, who provides the AI and with what configuration.
 * PUT   set one feature to the platform's AI, or to my own provider (with a
 *       new key, or one already saved), with its fallbacks.
 *
 * Whose rows these are is never a request field: the user id comes from the
 * session, and the store cannot return anyone else's credential. A key is
 * accepted here and never returned — not on save, not on read, not in an
 * error; the screen sees a mask.
 */
export async function GET(req: NextRequest) {
  const user = await requireUser(req);
  if (isFailure(user)) return user.response;
  return storeSafe(async () => {
    const body = await overview(user.userId, await byokDeps(user));
    return NextResponse.json(body, { headers: { "cache-control": "no-store" } });
  });
}

export async function PUT(req: NextRequest) {
  const user = await requireUser(req);
  if (isFailure(user)) return user.response;
  return storeSafe(async () => {
  const body = await readJson(req);
  if (!body) return NextResponse.json({ error: "Send the settings as JSON." }, { status: 400 });
  const r = await saveSetting(user.userId, body as never, await byokDeps(user));
  if (!r.ok) return NextResponse.json({ error: r.message, code: r.code, ...(r.errors ? { problems: r.errors } : {}) }, { status: r.status, headers: { "cache-control": "no-store" } });
  if (r.credentialSaved) await audit({ action: "user.ai_credential_saved", userId: user.userId, sessionId: user.sessionId, customerId: user.customerId, entity: "ai_credential", detail: { provider: r.provider, feature: r.feature } });
  await audit({ action: "user.ai_connection_changed", userId: user.userId, sessionId: user.sessionId, customerId: user.customerId, entity: "ai_feature", entityId: user.userId, detail: { feature: r.feature, mode: r.mode, provider: r.provider ?? null, model: r.model ?? null } });
  return NextResponse.json({ ok: true, ...(await overview(user.userId, await byokDeps(user))) }, { headers: { "cache-control": "no-store" } });
  });
}

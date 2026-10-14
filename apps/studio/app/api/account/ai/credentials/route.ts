import { NextRequest, NextResponse } from "next/server";
import { audit, isFailure, requireUser } from "@/lib/guard";
import { byokDeps, readJson } from "@/lib/byok/server";
import { saveCredential } from "@/lib/byok/service";

export const dynamic = "force-dynamic";

/** Save (or replace the secret of) one of MY API keys — used for fallback providers; the main connection saves its key through PUT /api/account/ai. */
export async function POST(req: NextRequest) {
  const user = await requireUser(req);
  if (isFailure(user)) return user.response;
  const body = await readJson(req);
  if (!body) return NextResponse.json({ error: "Send the key as JSON." }, { status: 400 });
  const r = await saveCredential(user.userId, { provider: String(body.provider ?? ""), apiKey: body.apiKey, label: body.label, credentialId: typeof body.credentialId === "string" ? body.credentialId : null }, await byokDeps(user));
  if (!r.ok) return NextResponse.json({ error: r.message, code: r.code, ...(r.errors ? { problems: r.errors } : {}) }, { status: r.status, headers: { "cache-control": "no-store" } });
  await audit({ action: "user.ai_credential_saved", userId: user.userId, sessionId: user.sessionId, customerId: user.customerId, entity: "ai_credential", entityId: r.credential.id, detail: { provider: r.credential.provider, created: r.created } });
  return NextResponse.json({ ok: true, credential: r.credential }, { headers: { "cache-control": "no-store" } });
}

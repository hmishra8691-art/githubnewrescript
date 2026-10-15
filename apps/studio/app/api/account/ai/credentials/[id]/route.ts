import { NextRequest, NextResponse } from "next/server";
import { audit, isFailure, requireUser } from "@/lib/guard";
import { byokDeps, storeSafe } from "@/lib/byok/server";
import { overview, removeCredential } from "@/lib/byok/service";

export const dynamic = "force-dynamic";

/** Remove one of MY saved API keys. Features that used it return to the platform's AI, explicitly. */
export async function DELETE(req: NextRequest, { params }: { params: { id: string } }) {
  const user = await requireUser(req);
  if (isFailure(user)) return user.response;
  return storeSafe(async () => {
  const deps = await byokDeps(user);
  const r = await removeCredential(user.userId, params.id, deps);
  if (!r.ok) return NextResponse.json({ error: r.message, code: r.code }, { status: r.status, headers: { "cache-control": "no-store" } });
  await audit({ action: "user.ai_credential_removed", userId: user.userId, sessionId: user.sessionId, customerId: user.customerId, entity: "ai_credential", entityId: params.id, detail: { provider: r.provider } });
  return NextResponse.json({ ok: true, ...(await overview(user.userId, deps)) }, { headers: { "cache-control": "no-store" } });
  });
}

import { NextRequest, NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/admin";
import { audit, isFailure, requireAdmin } from "@/lib/guard";
import { readJson } from "@/lib/byok/server";

export const dynamic = "force-dynamic";

/**
 * USER-MANAGED AI, PER WORKSPACE (platform administrator).
 *
 *   GET   every workspace with whether its members may use their own AI provider
 *   PATCH { customerId, allowed } turn it off (or back on) for one workspace
 *
 * A workspace's projects hold the organisation's survey content; sending it to a
 * member's personal provider is the organisation's decision. Off, members of the
 * workspace cannot save a user-managed setting and a saved one is refused at use
 * with a sentence — their AI is never silently moved to the platform's, and
 * nothing is deleted: turning it back on restores what they had. The switch is
 * read by the account API and by the resolver (`workspaceAllowsByok`).
 */
export async function GET(req: NextRequest) {
  const admin = await requireAdmin(req);
  if (isFailure(admin)) return admin.response;
  const { data, error } = await supabaseAdmin().from("customers").select("id, name, slug, ai_byok_allowed").order("name").limit(500);
  if (error) {
    const missing = /ai_byok_allowed|column .* does not exist|schema cache/i.test(error.message);
    return NextResponse.json({ error: missing ? "User-managed AI is not enabled on this installation yet (migration 0054)." : "Workspaces could not be read.", code: missing ? "byok_unavailable" : "read_failed" }, { status: missing ? 501 : 500 });
  }
  return NextResponse.json({ ok: true, workspaces: (data ?? []).map((c: { id: string; name: string; slug: string; ai_byok_allowed: boolean | null }) => ({ id: c.id, name: c.name, slug: c.slug, allowed: c.ai_byok_allowed !== false })) }, { headers: { "cache-control": "no-store" } });
}

export async function PATCH(req: NextRequest) {
  const admin = await requireAdmin(req);
  if (isFailure(admin)) return admin.response;
  const body = await readJson(req);
  const customerId = typeof body?.customerId === "string" ? body.customerId : "";
  if (!/^[0-9a-f-]{36}$/i.test(customerId) || typeof body?.allowed !== "boolean") return NextResponse.json({ error: "Send { customerId, allowed } with allowed true or false." }, { status: 400 });
  const { data, error } = await supabaseAdmin().from("customers").update({ ai_byok_allowed: body.allowed }).eq("id", customerId).select("id, name, ai_byok_allowed").maybeSingle();
  if (error) return NextResponse.json({ error: "The setting could not be saved." }, { status: 500 });
  if (!data) return NextResponse.json({ error: "That workspace was not found." }, { status: 404 });
  await audit({ action: "workspace.ai_byok_policy_changed", userId: admin.userId, sessionId: admin.sessionId, customerId: customerId, entity: "customer", entityId: customerId, detail: { allowed: body.allowed, workspace: data.name } });
  return NextResponse.json({ ok: true, workspace: { id: data.id, name: data.name, allowed: data.ai_byok_allowed !== false } }, { headers: { "cache-control": "no-store" } });
}

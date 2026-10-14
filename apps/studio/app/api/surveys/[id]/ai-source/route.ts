import { NextRequest, NextResponse } from "next/server";
import { audit, isFailure, requireProject } from "@/lib/guard";
import { supabaseAdmin } from "@/lib/admin";
import { aiSettingsOf } from "@/lib/aiPolicy";
import { connectionFor } from "@/lib/byok/connect";
import { viewOfResolution } from "@/lib/byok/resolve";

export const dynamic = "force-dynamic";

/**
 * WHOSE AI THIS PROJECT USES — the project's own choice, made when it is
 * created and changeable by its owner.
 *
 *   "platform"  everyone on the project uses the platform's AI (billed to the
 *               project's wallet as before), whatever they set up personally
 *   "user"      everyone uses THEIR OWN provider: each person's calls go to
 *               the provider and key in their own Settings, never to anyone
 *               else's. A member with none set up is told so, and the call is
 *               not made
 *   (absent)    each person's own setting decides; with none, the platform
 *
 * GET tells anyone who can read the project the project's choice and what it
 * means for THEM right now (who would provide the AI, or why it could not be
 * used) — no key, no header. PUT is the owner's: it decides who pays.
 */
export async function GET(req: NextRequest, { params }: { params: { id: string } }) {
  const gate = await requireProject(req, params.id, "project.read");
  if (isFailure(gate)) return gate.response;
  const { data } = await supabaseAdmin().from("surveys").select("settings").eq("id", params.id).maybeSingle();
  const source = aiSettingsOf((data as { settings?: unknown } | null)?.settings).source ?? null;
  const you = viewOfResolution(await connectionFor({ userId: gate.user.userId, customerId: gate.survey.customer_id ?? gate.user.customerId, surveyId: params.id, operation: "copilot_turn", source: source ?? undefined, sourceKnown: true }));
  return NextResponse.json({ source, canChange: gate.role === "owner" || gate.viaAdmin, youWouldUse: you }, { headers: { "cache-control": "no-store" } });
}

export async function PUT(req: NextRequest, { params }: { params: { id: string } }) {
  /* "billing.set_budget" is the owner-only decision about what the project's money is for; who provides the AI is the same decision */
  const gate = await requireProject(req, params.id, "billing.set_budget");
  if (isFailure(gate)) return gate.response;
  const body = await req.json().catch(() => null) as { source?: unknown } | null;
  const next = body?.source === "platform" || body?.source === "user" ? body.source : body?.source === null ? null : undefined;
  if (next === undefined) return NextResponse.json({ error: "Choose \"platform\", \"user\", or null to follow each person's own setting." }, { status: 422 });
  const db = supabaseAdmin();
  const { data, error } = await db.from("surveys").select("settings").eq("id", params.id).maybeSingle();
  if (error) return NextResponse.json({ error: "The project's settings could not be read." }, { status: 500 });
  const settings = (data?.settings && typeof data.settings === "object" ? data.settings : {}) as Record<string, unknown>;
  const ai = (settings.ai && typeof settings.ai === "object" ? settings.ai : {}) as Record<string, unknown>;
  const { source: _old, ...rest } = ai;
  /* merged server-side: the AI settings are one key of a bag other panels write */
  const up = await db.from("surveys").update({ settings: { ...settings, ai: next ? { ...rest, source: next } : rest } }).eq("id", params.id);
  if (up.error) return NextResponse.json({ error: "The setting could not be saved." }, { status: 500 });
  await audit({ action: "project.ai_source_changed", userId: gate.user.userId, sessionId: gate.user.sessionId, surveyId: params.id, customerId: gate.user.customerId, detail: { source: next } });
  return NextResponse.json({ ok: true, source: next }, { headers: { "cache-control": "no-store" } });
}

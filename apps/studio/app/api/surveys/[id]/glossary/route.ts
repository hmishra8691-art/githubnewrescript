import { NextRequest, NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/admin";
import { GlossaryEntry } from "@rescript/schema";
import { isFailure, requireEditRight, requireProject } from "@/lib/guard";

export const dynamic = "force-dynamic";

/**
 * THE WORKSPACE GLOSSARY — preferred translations shared by every survey of
 * the organisation. Stored in the workspace's `themes` table under a reserved
 * name (it is workspace-wide branding of a kind: how the client's terms are
 * written in every language), so no migration is needed and the same access
 * gate applies: reading needs `project.read`, writing `survey.edit`.
 *
 *   GET                 → { entries: GlossaryEntry[] }
 *   PUT { entries }     → replace the workspace glossary
 */
const NAME = "__glossary__";

export async function GET(req: NextRequest, { params }: { params: { id: string } }) {
  const gate = await requireProject(req, params.id, "project.read");
  if (isFailure(gate)) return gate.response;
  const db = supabaseAdmin();
  const { data, error } = await db.from("themes").select("branding").eq("customer_id", gate.user.customerId).eq("name", NAME).maybeSingle();
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  const entries = Array.isArray((data?.branding as { glossary?: unknown } | null)?.glossary) ? ((data!.branding as { glossary: unknown[] }).glossary.map((g) => GlossaryEntry.safeParse(g)).filter((r) => r.success).map((r) => (r as { data: GlossaryEntry }).data)) : [];
  return NextResponse.json({ entries });
}

export async function PUT(req: NextRequest, { params }: { params: { id: string } }) {
  const gate = await requireEditRight(req, params.id, "survey.edit");
  if (isFailure(gate)) return gate.response;
  let body: any;
  try { body = await req.json(); } catch { return NextResponse.json({ error: "bad json" }, { status: 400 }); }
  const entries = (Array.isArray(body?.entries) ? body.entries : []).map((g: unknown) => GlossaryEntry.safeParse(g)).filter((r: { success: boolean }) => r.success).map((r: { data: GlossaryEntry }) => ({ ...r.data, scope: "org" }));
  const db = supabaseAdmin();
  const { data: existing } = await db.from("themes").select("id").eq("customer_id", gate.user.customerId).eq("name", NAME).maybeSingle();
  const row = { customer_id: gate.user.customerId, name: NAME, branding: { glossary: entries } };
  const res = existing ? await db.from("themes").update(row).eq("id", existing.id) : await db.from("themes").insert(row);
  if (res.error) return NextResponse.json({ error: res.error.message }, { status: 500 });
  return NextResponse.json({ ok: true, count: entries.length });
}

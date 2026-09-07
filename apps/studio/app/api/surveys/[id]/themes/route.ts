import { NextRequest, NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/admin";
import { Branding } from "@rescript/schema";
import { audit, isFailure, requireProject } from "@/lib/guard";

export const dynamic = "force-dynamic";

/**
 * REUSABLE SURVEY THEMES.
 *
 * `public.themes` has existed since the first migration — a per-customer
 * table of named branding — and `Branding.themeId` has existed in the schema
 * alongside it. Neither had a route, a loader or a UI: the only working
 * reusable themes in the platform were the ANALYTICS ones, so a client's
 * survey look had to be re-entered by hand on every study, and drifted.
 *
 * Themes are workspace-wide on purpose. A house style belongs to the client,
 * not to one survey, which is why the table is keyed on `customer_id` and why
 * this route is mounted under a survey only to reuse its access gate: reading
 * needs `project.read` on some project of the workspace, and writing needs
 * `survey.edit`, because saving a theme is the same act of authorship as
 * changing the survey's own branding.
 *
 *   GET                       → { themes: [{ id, name, branding, createdAt }] }
 *   POST { name, branding }   → save the current look under a name
 *   DELETE ?themeId=…         → remove one
 */

export async function GET(req: NextRequest, { params }: { params: { id: string } }) {
  const gate = await requireProject(req, params.id, "project.read");
  if (isFailure(gate)) return gate.response;

  const db = supabaseAdmin();
  const { data, error } = await db
    .from("themes")
    .select("id, name, branding, created_at")
    .eq("customer_id", gate.user.customerId)
    .order("name", { ascending: true });
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  return NextResponse.json({
    themes: (data ?? []).map((t) => ({
      id: t.id, name: t.name, branding: t.branding, createdAt: t.created_at,
    })),
  });
}

export async function POST(req: NextRequest, { params }: { params: { id: string } }) {
  const gate = await requireProject(req, params.id, "survey.edit");
  if (isFailure(gate)) return gate.response;

  let body: any;
  try { body = await req.json(); } catch { return NextResponse.json({ error: "bad json" }, { status: 400 }); }

  const name = String(body?.name ?? "").trim();
  if (!name) return NextResponse.json({ error: "a theme needs a name" }, { status: 400 });
  if (name.length > 80) return NextResponse.json({ error: "that name is too long" }, { status: 400 });

  /*
   * Parsed against the real Branding schema before it is stored. A theme is
   * applied to future surveys by writing it straight into their definition,
   * so a theme that does not parse would be a definition that does not parse
   * — discovered much later, by somebody else.
   */
  const parsed = Branding.safeParse(body?.branding);
  if (!parsed.success) {
    return NextResponse.json({
      error: "that branding is not valid, so it cannot be saved as a theme",
      issues: parsed.error.issues.slice(0, 5).map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`),
    }, { status: 422 });
  }

  const db = supabaseAdmin();
  /* a name is a handle: saving over one replaces it rather than making a twin */
  const { data: existing } = await db
    .from("themes").select("id").eq("customer_id", gate.user.customerId).eq("name", name).maybeSingle();

  const row = { customer_id: gate.user.customerId, name, branding: parsed.data };
  const { data, error } = existing
    ? await db.from("themes").update(row).eq("id", existing.id).select("id, name, created_at").single()
    : await db.from("themes").insert(row).select("id, name, created_at").single();
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  await audit({
    action: "survey.modified", userId: gate.user.userId, sessionId: gate.user.sessionId,
    surveyId: params.id, customerId: gate.user.customerId,
    entity: "theme", entityId: data.id,
    detail: { summary: `${existing ? "updated" : "saved"} the workspace theme “${name}”` },
  });

  return NextResponse.json({ ok: true, theme: { id: data.id, name: data.name, createdAt: data.created_at }, replaced: !!existing });
}

export async function DELETE(req: NextRequest, { params }: { params: { id: string } }) {
  const gate = await requireProject(req, params.id, "survey.edit");
  if (isFailure(gate)) return gate.response;

  const themeId = req.nextUrl.searchParams.get("themeId");
  if (!themeId) return NextResponse.json({ error: "themeId is required" }, { status: 400 });

  const db = supabaseAdmin();
  /* scoped to the workspace, so one customer can never delete another's */
  const { error } = await db.from("themes").delete()
    .eq("id", themeId).eq("customer_id", gate.user.customerId);
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ ok: true });
}

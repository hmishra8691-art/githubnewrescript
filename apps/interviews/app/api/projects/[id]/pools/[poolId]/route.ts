import { NextRequest, NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/admin";
import { isFailure, requireProject } from "@/lib/auth";
import { drawOf, forgetPool, setRandomize } from "@/lib/pools";

export const dynamic = "force-dynamic";

export async function PATCH(req: NextRequest, { params }: { params: { id: string; poolId: string } }) {
  const gate = await requireProject(req, params.id, "questions.edit");
  if (isFailure(gate)) return gate.response;
  const body = await req.json().catch(() => ({}));
  const db = supabaseAdmin();

  const patch: Record<string, unknown> = { updated_at: new Date().toISOString() };
  if (Object.hasOwn(body ?? {}, "name")) {
    const name = String(body.name ?? "").trim().slice(0, 120);
    if (!name) return NextResponse.json({ error: "A pool needs a name." }, { status: 400 });
    patch.name = name;
  }
  if (Object.hasOwn(body ?? {}, "description")) patch.description = String(body.description ?? "").slice(0, 2000);
  if (Object.hasOwn(body ?? {}, "draw")) patch.draw = drawOf(body.draw);

  const { data, error } = await db.from("interview_pools").update(patch)
    .eq("id", params.poolId).eq("project_id", params.id)
    .select("id, code, name, description, draw, position").maybeSingle();
  if (error) return NextResponse.json({ error: "That pool could not be saved." }, { status: 503 });
  if (!data) return NextResponse.json({ error: "No such pool." }, { status: 404 });

  if (Object.hasOwn(body ?? {}, "randomize")) await setRandomize(params.id, params.poolId, body.randomize === true);
  return NextResponse.json({ ok: true, pool: data });
}

/**
 * Remove a pool. Its questions are not removed — they become loose questions,
 * shown in positional order — because a pool is a way of drawing questions,
 * not a place questions live. Deleting the grouping must not delete the work.
 */
export async function DELETE(req: NextRequest, { params }: { params: { id: string; poolId: string } }) {
  const gate = await requireProject(req, params.id, "questions.edit");
  if (isFailure(gate)) return gate.response;
  const db = supabaseAdmin();
  await db.from("interview_questions").update({ pool_id: null }).eq("pool_id", params.poolId).eq("project_id", params.id);
  const { error } = await db.from("interview_pools").delete().eq("id", params.poolId).eq("project_id", params.id);
  if (error) return NextResponse.json({ error: "That pool could not be removed." }, { status: 503 });
  await forgetPool(params.id, params.poolId);
  return NextResponse.json({ ok: true });
}

import { NextRequest, NextResponse } from "next/server";
import { checkRequirement, normaliseCode, weightOf } from "@rescript/interviews";
import { supabaseAdmin } from "@/lib/admin";
import { isFailure, requireProject } from "@/lib/auth";

export const dynamic = "force-dynamic";

/**
 * Change or remove one requirement.
 *
 * Every read is scoped by `project_id` as well as by id — the id alone is a
 * uuid somebody could hold from another workspace, and a route that trusts it
 * is a route that edits somebody else's rubric.
 */
export async function PATCH(
  req: NextRequest,
  { params }: { params: { id: string; requirementId: string } },
) {
  const gate = await requireProject(req, params.id, "requirements.edit");
  if (isFailure(gate)) return gate.response;

  const body = await req.json().catch(() => ({}));
  const db = supabaseAdmin();

  const { data: all } = await db.from("interview_requirements")
    .select("id, code").eq("project_id", params.id);
  const mine = (all ?? []).find((r) => r.id === params.requirementId);
  if (!mine) return NextResponse.json({ error: "No such requirement." }, { status: 404 });

  const check = checkRequirement(
    { title: body?.title ?? mine.code, ...body },
    (all ?? []).filter((r) => r.id !== params.requirementId).map((r) => r.code as string),
  );
  if (!check.ok) return NextResponse.json({ error: check.errors[0], errors: check.errors }, { status: 400 });

  const patch: Record<string, unknown> = { updated_at: new Date().toISOString() };
  if (Object.hasOwn(body ?? {}, "title")) patch.title = String(body.title ?? "").trim().slice(0, 200);
  if (Object.hasOwn(body ?? {}, "description")) patch.description = String(body.description ?? "").slice(0, 4000);
  if (Object.hasOwn(body ?? {}, "criteria")) patch.criteria = String(body.criteria ?? "").slice(0, 4000);
  if (Object.hasOwn(body ?? {}, "weight")) patch.weight = weightOf(body.weight);
  if (Object.hasOwn(body ?? {}, "code")) {
    const code = normaliseCode(body.code);
    if (code) patch.code = code;
  }

  const { data, error } = await db.from("interview_requirements")
    .update(patch)
    .eq("id", params.requirementId)
    .eq("project_id", params.id)
    .select("id, code, title, description, criteria, weight, position")
    .maybeSingle();

  if (error) return NextResponse.json({ error: "That requirement could not be saved." }, { status: 503 });
  return NextResponse.json({ ok: true, requirement: data, warnings: check.warnings });
}

export async function DELETE(
  req: NextRequest,
  { params }: { params: { id: string; requirementId: string } },
) {
  const gate = await requireProject(req, params.id, "requirements.edit");
  if (isFailure(gate)) return gate.response;

  const db = supabaseAdmin();

  /*
   * EVIDENCE ALREADY WRITTEN AGAINST IT IS WHAT STOPS A DELETE.
   *
   * `interview_evidence.requirement_id` references this row, so deleting one a
   * completed interview was assessed against would either cascade away that
   * interview's findings or fail on the constraint. Both are wrong: the
   * finding is a record of what was concluded about a person at a point in
   * time, and a rubric change months later must not rewrite it.
   *
   * So a requirement that has been used is refused, with the count, and the
   * interviewer is told what to do instead — set its weight to zero, which
   * means "assess it but do not let it move the score" and leaves the history
   * intact.
   */
  const { count } = await db.from("interview_evidence")
    .select("id", { count: "exact", head: true })
    .eq("requirement_id", params.requirementId);

  if (count && count > 0) {
    return NextResponse.json({
      error:
        `This requirement has already been used to assess ${count} answer${count === 1 ? "" : "s"}, ` +
        "so removing it would rewrite what was concluded about people who have already interviewed. " +
        "Set its weight to zero instead — it stays on the record and stops affecting scores.",
      code: "requirement_in_use",
      used: count,
    }, { status: 409 });
  }

  const { error } = await db.from("interview_requirements")
    .delete()
    .eq("id", params.requirementId)
    .eq("project_id", params.id);

  if (error) return NextResponse.json({ error: "That requirement could not be removed." }, { status: 503 });
  return NextResponse.json({ ok: true });
}

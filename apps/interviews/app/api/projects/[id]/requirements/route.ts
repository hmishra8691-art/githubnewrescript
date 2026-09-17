import { NextRequest, NextResponse } from "next/server";
import { checkRequirement, nextCode, normaliseCode, weightOf } from "@rescript/interviews";
import { supabaseAdmin } from "@/lib/admin";
import { isFailure, requireProject } from "@/lib/auth";

export const dynamic = "force-dynamic";

/**
 * THE THINGS AN ANSWER IS ASSESSED AGAINST.
 *
 * `interview_requirements` has been read by the analysis prompt since 0030 and
 * written by nothing. There was no POST, no PUT, no UI, and the
 * `requirements.edit` capability was declared in the role map and checked by
 * no route. Every analysis this product has ever run was therefore handed an
 * empty requirement list, which is why the evidence table was always empty and
 * the narrative always thin: the model was asked to find evidence for nothing
 * in particular.
 *
 * This is the input to the entire evaluation pipeline. Nothing downstream —
 * verdicts, coverage, gaps, scoring, the recruiter report — can produce
 * anything at all until a project has some.
 *
 * ## Why `criteria` is the field that matters
 *
 * `title` names the requirement; `criteria` is the only part the model is
 * shown as *what meeting it looks like*. A requirement with a title and no
 * criteria leaves the model inferring the standard, and an inferred standard
 * applied to a person is precisely the failure this product is most obliged to
 * avoid. Saving one anyway is allowed — a draft is worth keeping — but it
 * warns, every time.
 */
export async function GET(req: NextRequest, { params }: { params: { id: string } }) {
  const gate = await requireProject(req, params.id, "project.read");
  if (isFailure(gate)) return gate.response;

  const { data } = await supabaseAdmin()
    .from("interview_requirements")
    .select("id, code, title, description, criteria, weight, position")
    .eq("project_id", params.id)
    .order("position");

  return NextResponse.json(
    { ok: true, requirements: data ?? [], role: gate.role },
    { headers: { "cache-control": "no-store" } },
  );
}

export async function POST(req: NextRequest, { params }: { params: { id: string } }) {
  const gate = await requireProject(req, params.id, "requirements.edit");
  if (isFailure(gate)) return gate.response;

  const body = await req.json().catch(() => ({}));
  const db = supabaseAdmin();

  const { data: existing } = await db.from("interview_requirements")
    .select("code, position").eq("project_id", params.id);

  const check = checkRequirement(body, (existing ?? []).map((r) => r.code as string));
  if (!check.ok) return NextResponse.json({ error: check.errors[0], errors: check.errors }, { status: 400 });

  const wanted = normaliseCode(body?.code);
  const taken = (existing ?? []).map((r) => r.code as string);
  const code = wanted && !taken.some((c) => normaliseCode(c) === wanted)
    ? wanted
    : nextCode(taken, "R");

  const { data, error } = await db.from("interview_requirements").insert({
    project_id: params.id,
    code,
    title: String(body?.title ?? "").trim().slice(0, 200),
    description: String(body?.description ?? "").slice(0, 4000),
    criteria: String(body?.criteria ?? "").slice(0, 4000),
    weight: weightOf(body?.weight),
    position: Math.max(0, ...(existing ?? []).map((r) => Number(r.position) || 0)) + 1,
  }).select("id, code, title, description, criteria, weight, position").maybeSingle();

  if (error) return NextResponse.json({ error: "That requirement could not be added." }, { status: 503 });
  return NextResponse.json({ ok: true, requirement: data, warnings: check.warnings }, { status: 201 });
}

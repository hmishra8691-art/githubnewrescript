import { NextRequest, NextResponse } from "next/server";
import { analysisReadiness, checkProject, isProjectStatus } from "@rescript/interviews";
import { supabaseAdmin } from "@/lib/admin";
import { isFailure, requireProject } from "@/lib/auth";
import { setRandomizePools } from "@/lib/pools";

export const dynamic = "force-dynamic";

/**
 * ONE PROJECT: READ IT, CHANGE IT.
 *
 * There was no route here at all. A project was created with a name and then
 * frozen: `instructions`, `consent_text`, `description`, `status` and
 * `retention_days` were all columns the runtime reads and nothing could write
 * after the insert. Opening a project to candidates, closing it, correcting a
 * typo in what they are asked to consent to — none of it was possible without
 * a hand-written UPDATE against production.
 *
 * ## A patch says what it means to change
 *
 * Every field is optional and `undefined` means "leave it alone", which is not
 * the same as `null` or `""`. That distinction is load-bearing for consent
 * text: a form that posts every field on every save would let a rendering bug
 * in one panel blank the paragraph a candidate legally agreed to.
 */
export async function GET(req: NextRequest, { params }: { params: { id: string } }) {
  const gate = await requireProject(req, params.id, "project.read");
  if (isFailure(gate)) return gate.response;
  const db = supabaseAdmin();

  const [{ data: project }, { data: questions }, { data: requirements }] = await Promise.all([
    db.from("interview_projects")
      .select("id, code, name, description, status, instructions, consent_text, retention_days, retention_scope, max_recording_seconds, created_at, updated_at")
      .eq("id", params.id)
      .is("deleted_at", null)
      .maybeSingle(),
    db.from("interview_questions").select("id").eq("project_id", params.id).is("archived_at", null),
    db.from("interview_requirements").select("criteria").eq("project_id", params.id),
  ]);
  if (!project) return NextResponse.json({ error: "No such project." }, { status: 404 });

  return NextResponse.json({
    ok: true,
    project,
    role: gate.role,
    /*
     * Said here rather than discovered at the end of a job run. An interview
     * with no requirements records and transcribes perfectly well and cannot
     * be evaluated at all, and the person who needs to know that is the one
     * looking at the builder now — not the reviewer wondering, a fortnight
     * later, why every analysis is empty.
     */
    readiness: analysisReadiness({
      requirements: requirements ?? [],
      questions: questions ?? [],
    }),
  }, { headers: { "cache-control": "no-store" } });
}

export async function PATCH(req: NextRequest, { params }: { params: { id: string } }) {
  const gate = await requireProject(req, params.id, "project.edit");
  if (isFailure(gate)) return gate.response;

  const body = await req.json().catch(() => ({}));

  /*
   * Only the keys the caller actually sent are considered, so a partial form
   * cannot blank a field it does not render. `Object.hasOwn` rather than a
   * truthiness test, because "" and 0 are things somebody may legitimately
   * mean — an empty description is a real edit.
   */
  const draft = {
    ...(Object.hasOwn(body ?? {}, "name") ? { name: body.name } : {}),
    ...(Object.hasOwn(body ?? {}, "description") ? { description: body.description } : {}),
    ...(Object.hasOwn(body ?? {}, "instructions") ? { instructions: body.instructions } : {}),
    ...(Object.hasOwn(body ?? {}, "consentText") ? { consentText: body.consentText } : {}),
    ...(Object.hasOwn(body ?? {}, "status") ? { status: body.status } : {}),
    ...(Object.hasOwn(body ?? {}, "retentionDays") ? { retentionDays: body.retentionDays } : {}),
  };

  const check = checkProject(draft);
  if (!check.ok) return NextResponse.json({ error: check.errors[0], errors: check.errors }, { status: 400 });

  const patch: Record<string, unknown> = { updated_at: new Date().toISOString() };
  if (draft.name !== undefined) patch.name = String(draft.name).trim().slice(0, 200);
  if (draft.description !== undefined) patch.description = String(draft.description ?? "").slice(0, 4000);
  if (draft.instructions !== undefined) patch.instructions = String(draft.instructions ?? "").slice(0, 8000);
  if (draft.consentText !== undefined) patch.consent_text = String(draft.consentText).trim().slice(0, 8000);
  if (draft.status !== undefined && isProjectStatus(draft.status)) patch.status = draft.status;
  if (draft.retentionDays !== undefined && draft.retentionDays !== null) {
    patch.retention_days = Math.trunc(Number(draft.retentionDays));
  }

  const db = supabaseAdmin();
  const { data, error } = await db.from("interview_projects")
    .update(patch)
    .eq("id", params.id)
    .is("deleted_at", null)
    .select("id, code, name, description, status, instructions, consent_text, retention_days")
    .maybeSingle();

  if (error) return NextResponse.json({ error: "Those changes could not be saved." }, { status: 503 });
  if (!data) return NextResponse.json({ error: "No such project." }, { status: 404 });

  /* the order of the pools themselves — separate write, same column as the per-pool flags */
  if (Object.hasOwn(body ?? {}, "randomizePools")) await setRandomizePools(params.id, body.randomizePools === true);

  /*
   * Changing the consent text does NOT reach back into interviews already
   * taken. Each sitting snapshots what it showed (`consent_text_snapshot`), so
   * what a candidate agreed to is what they were shown, permanently. Editing
   * the project changes what the NEXT candidate sees — which is the only
   * honest thing an edit can mean here, and is worth saying to whoever pressed
   * save.
   */
  return NextResponse.json({
    ok: true,
    project: data,
    warnings: [
      ...check.warnings,
      ...(draft.consentText !== undefined
        ? ["Interviews already taken keep the consent text they were shown. This applies to new invitations."]
        : []),
    ],
  });
}

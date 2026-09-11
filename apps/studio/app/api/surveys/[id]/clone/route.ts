import { NextRequest, NextResponse } from "next/server";
import { SurveyDefinition } from "@rescript/schema";
import { cloneSurveyDefinition, slugForCode } from "@rescript/engine";
import { supabaseAdmin } from "@/lib/admin";
import { audit, isFailure, requireProject } from "@/lib/guard";

export const dynamic = "force-dynamic";

/**
 * CLONE A PROJECT.
 *
 *   POST /api/surveys/:id/clone { title?, code? } → { id, code, title, counts }
 *
 * WHAT IS COPIED: the programming, and only the programming — questions,
 * options, matrix rows and columns, logic of every kind, quotas,
 * randomization, variables, calculations, list fills, loops, masking,
 * carry-forward, validation, quality checks, translations, AI settings,
 * branding and survey settings. `cloneSurveyDefinition` does the copy and
 * gives every entity a new id; see that file for why references are rewritten
 * by id rather than by enumerating the places they appear.
 *
 * WHAT IS NOT: responses, respondents, deployments, test runs, comments, the
 * activity log, collaborators and the wallet. A copy of a study is not a copy
 * of its fieldwork. The new project starts with NO WALLET AT ALL, which is a
 * zero balance until somebody puts credits in — duplicating a balance would
 * be creating credits, and credits are only ever created by an administrator
 * assigning them.
 *
 * WHO: `project.clone` — the roles that build surveys. A reviewer can read
 * every question in this project and still not put a second project in the
 * workspace's list.
 *
 * THE REFUSAL THAT MATTERS: if the clone still contains ANY of the original's
 * ids, nothing is written. That would be a project whose logic silently reads
 * another project's questions, and it is better to fail loudly here than to
 * hand someone a survey that is wrong in a way they cannot see.
 */
export async function POST(req: NextRequest, { params }: { params: { id: string } }) {
  const gate = await requireProject(req, params.id, "project.clone");
  if (isFailure(gate)) return gate.response;
  const { user, survey } = gate;
  if (!user.customerId) {
    return NextResponse.json({ error: "Your account is not attached to a workspace yet." }, { status: 409 });
  }

  const body = await req.json().catch(() => ({}));
  const db = supabaseAdmin();

  /* The source: the working draft when there is one, else the current
     version — the same precedence the Studio itself opens with, so a clone
     copies what the programmer last saw rather than the last published cut. */
  const { data: src } = await db
    .from("surveys")
    .select("id, code, title, customer_id, draft_definition, current_version_id")
    .eq("id", params.id)
    .single();
  if (!src) return NextResponse.json({ error: "not found" }, { status: 404 });

  let definition: unknown = src.draft_definition ?? null;
  if (!definition && src.current_version_id) {
    const { data: ver } = await db.from("survey_versions").select("definition").eq("id", src.current_version_id).single();
    definition = ver?.definition ?? null;
  }
  if (!definition) return NextResponse.json({ error: "This project has nothing to copy yet." }, { status: 400 });

  const parsed = SurveyDefinition.safeParse(definition);
  if (!parsed.success) {
    return NextResponse.json({ error: "This project's definition could not be read, so it cannot be copied." }, { status: 422 });
  }

  const title = String(body?.title ?? `${src.title} — Copy`).slice(0, 200).trim() || `${src.title} — Copy`;
  const wanted = String(body?.code ?? `${src.code}_COPY`).slice(0, 60).trim().toUpperCase().replace(/\s+/g, "_");

  /*
   * A project code is unique per workspace, and "Copy" is exactly the name
   * everyone reaches for twice. Rather than answer 409 and make the person
   * invent a name, the second copy is _COPY2 — but only up to a point, after
   * which the collision is real and they are told.
   */
  let code = wanted;
  for (let attempt = 2; attempt <= 30; attempt += 1) {
    const { data: clash } = await db.from("surveys").select("id").eq("customer_id", user.customerId).eq("code", code).maybeSingle();
    if (!clash) break;
    code = `${wanted.replace(/\d+$/, "")}${attempt}`.slice(0, 60);
    if (attempt === 30) return NextResponse.json({ error: `Too many projects are already called ${wanted}. Give the copy a code of its own.` }, { status: 409 });
  }

  /* the row first: the clone needs the new project's id inside its own definition */
  const { data: created, error: insErr } = await db
    .from("surveys")
    .insert({ customer_id: user.customerId, code, title, owner_id: user.userId, created_by: user.userId })
    .select("id")
    .single();
  if (insErr || !created) {
    const dup = /duplicate key|unique/i.test(insErr?.message ?? "");
    return NextResponse.json({ error: dup ? `A project with the code “${code}” already exists.` : insErr?.message ?? "could not create the copy" }, { status: dup ? 409 : 500 });
  }

  const result = cloneSurveyDefinition(parsed.data, {
    surveyId: created.id,
    code,
    title,
    studySlug: slugForCode(code),
  });

  if (result.stowaways.length) {
    /* Nothing may be saved: this copy would point back at the original. */
    await db.from("surveys").delete().eq("id", created.id);
    return NextResponse.json({
      error: "The copy could not be made cleanly — some of the original project's identifiers would have been shared with it. Nothing was created.",
      code: "clone_incomplete",
      stowaways: result.stowaways.slice(0, 20),
    }, { status: 500 });
  }

  const { data: ver, error: verErr } = await db
    .from("survey_versions")
    .insert({ survey_id: created.id, version: "1.0", definition: result.def, label: `Cloned from ${src.code}`, created_by: user.userId })
    .select("id")
    .single();
  if (verErr || !ver) {
    await db.from("surveys").delete().eq("id", created.id);
    return NextResponse.json({ error: verErr?.message ?? "could not save the copy" }, { status: 500 });
  }
  await db.from("surveys").update({ current_version_id: ver.id }).eq("id", created.id);

  /* Two records: one on the original saying it was copied, one on the copy
     saying how it began. Either alone is still a true sentence. */
  await audit({
    action: "project.cloned", userId: user.userId, sessionId: user.sessionId, customerId: user.customerId,
    surveyId: params.id, entity: "survey", entityId: params.id,
    detail: { newProjectId: created.id, newCode: code, newTitle: title, entities: result.counts, referencesRewritten: result.rewritten },
  });
  await audit({
    action: "project.created", userId: user.userId, sessionId: user.sessionId, customerId: user.customerId,
    surveyId: created.id, entity: "survey", entityId: created.id,
    detail: { code, title, clonedFrom: params.id, clonedFromCode: src.code, clonedFromTitle: src.title },
  });

  return NextResponse.json({
    ok: true,
    id: created.id,
    code,
    title,
    counts: result.counts,
    /* said plainly, because it is the part people are right to worry about */
    responsesCopied: false,
    walletBalance: 0,
  });
}

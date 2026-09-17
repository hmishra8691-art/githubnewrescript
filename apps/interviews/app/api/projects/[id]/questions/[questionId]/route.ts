import { NextRequest, NextResponse } from "next/server";
import { checkQuestion, isQuestionCategory, isQuestionKind, normaliseCode } from "@rescript/interviews";
import { supabaseAdmin } from "@/lib/admin";
import { isFailure, requireProject } from "@/lib/auth";

export const dynamic = "force-dynamic";

/**
 * Change or retire one question.
 *
 * Questions could be added and nothing else — no edit, no removal, not even a
 * way to fix a typo. Every per-question setting the schema has carried since
 * 0030 (`guidance`, `min_seconds`, `max_seconds`, `max_retries`,
 * `think_seconds`, `kind`, `category`) was accepted by the POST route, honoured
 * by the runtime, and never sent by the form, which hardcoded a three-minute
 * limit and no retries for every question in every project.
 */
export async function PATCH(
  req: NextRequest,
  { params }: { params: { id: string; questionId: string } },
) {
  const gate = await requireProject(req, params.id, "questions.edit");
  if (isFailure(gate)) return gate.response;

  const body = await req.json().catch(() => ({}));
  const db = supabaseAdmin();

  const { data: all } = await db.from("interview_questions")
    .select("id, code, prompt, kind, min_seconds, max_seconds")
    .eq("project_id", params.id)
    .is("archived_at", null);
  const mine = (all ?? []).find((q) => q.id === params.questionId);
  if (!mine) return NextResponse.json({ error: "No such question." }, { status: 404 });

  /*
   * Validated against the row as it WOULD BE, not against the patch alone.
   * Raising a minimum above an unchanged maximum is the obvious way to build
   * an unanswerable question, and a check that only sees the field being
   * changed cannot catch it.
   */
  const merged = {
    code: Object.hasOwn(body ?? {}, "code") ? body.code : mine.code,
    prompt: Object.hasOwn(body ?? {}, "prompt") ? body.prompt : mine.prompt,
    kind: Object.hasOwn(body ?? {}, "kind") ? body.kind : mine.kind,
    minSeconds: Object.hasOwn(body ?? {}, "minSeconds") ? body.minSeconds : mine.min_seconds,
    maxSeconds: Object.hasOwn(body ?? {}, "maxSeconds") ? body.maxSeconds : mine.max_seconds,
    maxRetries: body?.maxRetries,
    thinkSeconds: body?.thinkSeconds,
    category: body?.category,
  };
  const check = checkQuestion(
    merged,
    (all ?? []).filter((q) => q.id !== params.questionId).map((q) => q.code as string),
  );
  if (!check.ok) return NextResponse.json({ error: check.errors[0], errors: check.errors }, { status: 400 });

  const patch: Record<string, unknown> = { updated_at: new Date().toISOString() };
  if (Object.hasOwn(body ?? {}, "prompt")) patch.prompt = String(body.prompt ?? "").trim().slice(0, 4000);
  if (Object.hasOwn(body ?? {}, "guidance")) patch.guidance = String(body.guidance ?? "").slice(0, 2000);
  if (Object.hasOwn(body ?? {}, "required")) patch.required = body.required !== false;
  if (Object.hasOwn(body ?? {}, "kind") && isQuestionKind(body.kind)) patch.kind = body.kind;
  if (Object.hasOwn(body ?? {}, "category") && isQuestionCategory(body.category)) patch.category = body.category;
  if (Object.hasOwn(body ?? {}, "minSeconds")) patch.min_seconds = posIntOrNull(body.minSeconds);
  if (Object.hasOwn(body ?? {}, "maxSeconds")) patch.max_seconds = posIntOrNull(body.maxSeconds) ?? 180;
  if (Object.hasOwn(body ?? {}, "maxRetries")) patch.max_retries = clamp(body.maxRetries, 0, 10);
  if (Object.hasOwn(body ?? {}, "thinkSeconds")) patch.think_seconds = clamp(body.thinkSeconds, 0, 600);
  if (Object.hasOwn(body ?? {}, "poolId")) patch.pool_id = body.poolId || null;
  if (Object.hasOwn(body ?? {}, "code")) {
    const code = normaliseCode(body.code);
    if (code) patch.code = code;
  }

  const { data, error } = await db.from("interview_questions")
    .update(patch)
    .eq("id", params.questionId)
    .eq("project_id", params.id)
    .select("*")
    .maybeSingle();

  if (error) return NextResponse.json({ error: "That question could not be saved." }, { status: 503 });
  return NextResponse.json({ ok: true, question: data, warnings: check.warnings });
}

/**
 * Retire a question. Archived, never deleted.
 *
 * `archived_at` already exists and every read in the product filters on it, so
 * this is the removal the schema was designed for. A hard delete is not
 * available and should not be: `interview_responses.question_id` and
 * `interview_media.question_id` point here, so deleting the row would either
 * orphan a recording somebody gave or cascade it away. An answer already given
 * to a question is a fact about a person's afternoon; retiring the question
 * cannot be allowed to erase it.
 *
 * Archiving hides it from new sittings. Interviews in progress keep the
 * sequence they were drawn — it is frozen in `question_sequence` at invitation
 * — so nobody halfway through loses a question under them.
 */
export async function DELETE(
  req: NextRequest,
  { params }: { params: { id: string; questionId: string } },
) {
  const gate = await requireProject(req, params.id, "questions.edit");
  if (isFailure(gate)) return gate.response;

  const db = supabaseAdmin();
  const { data, error } = await db.from("interview_questions")
    .update({ archived_at: new Date().toISOString() })
    .eq("id", params.questionId)
    .eq("project_id", params.id)
    .is("archived_at", null)
    .select("id, code")
    .maybeSingle();

  if (error) return NextResponse.json({ error: "That question could not be removed." }, { status: 503 });
  if (!data) return NextResponse.json({ error: "No such question." }, { status: 404 });

  return NextResponse.json({
    ok: true,
    archived: data.code,
    note: "Interviews already under way keep the questions they were given. This applies to new invitations.",
  });
}

const posIntOrNull = (v: unknown): number | null => {
  const n = Number(v);
  return Number.isInteger(n) && n > 0 ? n : null;
};

const clamp = (v: unknown, lo: number, hi: number): number => {
  const n = Number(v);
  if (!Number.isFinite(n)) return lo;
  return Math.min(hi, Math.max(lo, Math.trunc(n)));
};

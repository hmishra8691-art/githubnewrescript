import { NextRequest, NextResponse } from "next/server";
import {
  analysisReadiness, checkQuestion, isQuestionCategory, isQuestionKind, nextCode,
  normaliseCode, positionsFor,
} from "@rescript/interviews";
import { supabaseAdmin } from "@/lib/admin";
import { isFailure, requireProject } from "@/lib/auth";

export const dynamic = "force-dynamic";

export async function GET(req: NextRequest, { params }: { params: { id: string } }) {
  const gate = await requireProject(req, params.id, "project.read");
  if (isFailure(gate)) return gate.response;
  const db = supabaseAdmin();

  const [{ data: pools }, { data: questions }, { data: requirements }] = await Promise.all([
    db.from("interview_pools").select("*").eq("project_id", params.id).order("position"),
    db.from("interview_questions").select("*").eq("project_id", params.id).is("archived_at", null).order("position"),
    db.from("interview_requirements").select("*").eq("project_id", params.id).order("position"),
  ]);
  return NextResponse.json({
    ok: true, pools: pools ?? [], questions: questions ?? [], requirements: requirements ?? [],
    role: gate.role,
    readiness: analysisReadiness({ requirements: requirements ?? [], questions: questions ?? [] }),
  }, { headers: { "cache-control": "no-store" } });
}

/**
 * Add a question.
 *
 * A code is generated when none is given, because a code is what an export
 * column and an audit record are keyed by and a question without one is a
 * question nobody can refer to later. It is unique within the project, which
 * is what makes `Q3` mean one thing in a report.
 */
export async function POST(req: NextRequest, { params }: { params: { id: string } }) {
  const gate = await requireProject(req, params.id, "questions.edit");
  if (isFailure(gate)) return gate.response;

  const body = await req.json().catch(() => ({}));

  const db = supabaseAdmin();
  const { data: existing } = await db.from("interview_questions")
    .select("code, position").eq("project_id", params.id).is("archived_at", null);

  /*
   * One check, shared with the PATCH route and with the builder's own
   * client-side pass. The rules that make a question unanswerable — a minimum
   * above the maximum, a limit past the platform ceiling — are not the sort
   * of thing to state twice.
   */
  const taken = (existing ?? []).map((q) => q.code as string);
  const check = checkQuestion(body, taken);
  if (!check.ok) return NextResponse.json({ error: check.errors[0], errors: check.errors }, { status: 400 });

  const prompt = String(body?.prompt ?? "").trim();
  const wanted = normaliseCode(body?.code);
  const code = wanted && !taken.some((c) => normaliseCode(c) === wanted) ? wanted : nextCode(taken, "Q");
  const position = Number.isInteger(body?.position)
    ? body.position
    : Math.max(0, ...(existing ?? []).map((q) => Number(q.position) || 0)) + 1;

  const { data, error } = await db.from("interview_questions").insert({
    project_id: params.id,
    pool_id: body?.poolId ?? null,
    code,
    category: isQuestionCategory(body?.category) ? body.category : "custom",
    kind: isQuestionKind(body?.kind) ? body.kind : "video",
    prompt: prompt.slice(0, 4000),
    guidance: String(body?.guidance ?? "").slice(0, 2000),
    required: body?.required !== false,
    min_seconds: intOrNull(body?.minSeconds),
    max_seconds: intOrNull(body?.maxSeconds) ?? 180,
    max_retries: Math.max(0, Number(body?.maxRetries) || 0),
    think_seconds: Math.max(0, Number(body?.thinkSeconds) || 0),
    position,
  }).select("*").single();
  if (error) return NextResponse.json({ error: "We could not add that question." }, { status: 503 });
  return NextResponse.json({ ok: true, question: data, warnings: check.warnings }, { status: 201 });
}

/**
 * Reorder the whole list in one request.
 *
 * The order is sent whole rather than as a sequence of swaps, because moving
 * one question changes the position of everything after it and expressing that
 * as pairwise swaps is how two rows end up sharing a position. `positionsFor`
 * also protects the case that actually happens with two people in one project:
 * a drag sent against a stale list names three of the four questions that now
 * exist, and the one it does not mention keeps its relative order and follows,
 * rather than being dropped by omission.
 */
export async function PUT(req: NextRequest, { params }: { params: { id: string } }) {
  const gate = await requireProject(req, params.id, "questions.edit");
  if (isFailure(gate)) return gate.response;

  const body = await req.json().catch(() => ({}));
  const ordered = Array.isArray(body?.order) ? body.order.filter((x: unknown) => typeof x === "string") : [];
  if (!ordered.length) return NextResponse.json({ error: "Send the questions in the order you want them." }, { status: 400 });

  const db = supabaseAdmin();
  const { data: all } = await db.from("interview_questions")
    .select("id, position").eq("project_id", params.id).is("archived_at", null);

  const positions = positionsFor(ordered, (all ?? []).map((q) => ({
    id: q.id as string, position: Number(q.position) || 0,
  })));

  /*
   * Sequential, not parallel. These are updates to one small table scoped by
   * one project id; firing them at once buys nothing and makes a partial
   * failure harder to reason about. A failure part-way leaves a prefix
   * renumbered and the next reorder fixes it — positions are derived from the
   * list, never accumulated.
   */
  for (const p of positions) {
    const { error } = await db.from("interview_questions")
      .update({ position: p.position })
      .eq("id", p.id)
      .eq("project_id", params.id);
    if (error) return NextResponse.json({ error: "That order could not be saved." }, { status: 503 });
  }

  return NextResponse.json({ ok: true, order: positions });
}

const intOrNull = (v: unknown): number | null => {
  const n = Number(v);
  return Number.isInteger(n) && n > 0 ? n : null;
};

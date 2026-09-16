import { NextRequest, NextResponse } from "next/server";
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
  });
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
  const prompt = String(body?.prompt ?? "").trim();
  if (!prompt) return NextResponse.json({ error: "A question needs something to ask." }, { status: 400 });

  const db = supabaseAdmin();
  const { data: existing } = await db.from("interview_questions")
    .select("code, position").eq("project_id", params.id);
  const codes = new Set((existing ?? []).map((q) => q.code));
  let code = String(body?.code ?? "").trim().toUpperCase().replace(/[^A-Z0-9_]/g, "");
  if (!code || codes.has(code)) {
    let n = (existing ?? []).length + 1;
    while (codes.has(`Q${n}`)) n++;
    code = `Q${n}`;
  }
  const position = Number.isInteger(body?.position)
    ? body.position
    : Math.max(0, ...(existing ?? []).map((q) => q.position)) + 1;

  const { data, error } = await db.from("interview_questions").insert({
    project_id: params.id,
    pool_id: body?.poolId ?? null,
    code,
    category: String(body?.category ?? "custom").slice(0, 40),
    kind: ["video", "audio", "text"].includes(body?.kind) ? body.kind : "video",
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
  return NextResponse.json({ ok: true, question: data }, { status: 201 });
}

const intOrNull = (v: unknown): number | null => {
  const n = Number(v);
  return Number.isInteger(n) && n > 0 ? n : null;
};

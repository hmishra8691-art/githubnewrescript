import { NextRequest, NextResponse } from "next/server";
import { nextCode, normaliseCode } from "@rescript/interviews";
import { supabaseAdmin } from "@/lib/admin";
import { isFailure, requireProject } from "@/lib/auth";
import { readSelection } from "@/lib/candidate";
import { drawOf, setRandomize } from "@/lib/pools";

export const dynamic = "force-dynamic";

/**
 * POOLS — THE THING THAT MAKES RANDOMIZATION REACHABLE.
 *
 * `interview_pools` has existed since 0030 and `drawSequence` has drawn from
 * pools since Phase 1: pick N of M, shuffle within a pool, shuffle the pools
 * themselves, all seeded and recorded once so the draw can be explained later.
 * None of it could be reached, because no route created a pool and the one
 * call to `drawSequence` omitted the randomize flags. A project with no pools
 * is a fixed list, so every project was a fixed list.
 *
 * ## Two homes for the configuration, and why
 *
 * `draw` lives on the pool row — it is a fact about the pool. `randomize` and
 * `randomizePools` live in `interview_projects.selection`, the jsonb column
 * 0030 created for "the draw configuration" and nothing ever read. That split
 * is the schema's, not this route's; `readSelection` in `lib/candidate.ts`
 * reads it back, with the pool row's `draw` as the fallback.
 *
 * A pool with `draw: null` takes every question in it — a fixed block that can
 * still be shuffled. The brief's "Q1 fixed, Q2–Q6 pick 3, Q7 fixed" is three
 * pools: one of one, one of five drawing three, one of one.
 */
export async function GET(req: NextRequest, { params }: { params: { id: string } }) {
  const gate = await requireProject(req, params.id, "project.read");
  if (isFailure(gate)) return gate.response;
  const db = supabaseAdmin();
  const [{ data: pools }, { data: project }] = await Promise.all([
    db.from("interview_pools").select("id, code, name, description, draw, position").eq("project_id", params.id).order("position"),
    db.from("interview_projects").select("selection").eq("id", params.id).maybeSingle(),
  ]);
  const selection = readSelection(project?.selection);
  return NextResponse.json({
    ok: true,
    randomizePools: selection.randomizePools,
    pools: (pools ?? []).map((p) => ({
      ...p, randomize: selection.pools.find((x) => x.id === p.id)?.randomize ?? false,
    })),
  }, { headers: { "cache-control": "no-store" } });
}

export async function POST(req: NextRequest, { params }: { params: { id: string } }) {
  const gate = await requireProject(req, params.id, "questions.edit");
  if (isFailure(gate)) return gate.response;
  const body = await req.json().catch(() => ({}));
  const name = String(body?.name ?? "").trim().slice(0, 120);
  if (!name) return NextResponse.json({ error: "A pool needs a name." }, { status: 400 });

  const db = supabaseAdmin();
  const { data: existing } = await db.from("interview_pools").select("code, position").eq("project_id", params.id);
  const taken = (existing ?? []).map((p) => p.code as string);
  const wanted = normaliseCode(body?.code);
  const code = wanted && !taken.includes(wanted) ? wanted : nextCode(taken, "POOL");

  const { data, error } = await db.from("interview_pools").insert({
    project_id: params.id, code, name,
    description: String(body?.description ?? "").slice(0, 2000),
    draw: drawOf(body?.draw),
    position: Math.max(0, ...(existing ?? []).map((p) => Number(p.position) || 0)) + 1,
  }).select("id, code, name, description, draw, position").maybeSingle();
  if (error || !data) return NextResponse.json({ error: "That pool could not be created." }, { status: 503 });

  if (body?.randomize !== undefined) await setRandomize(params.id, data.id, body.randomize === true);
  return NextResponse.json({ ok: true, pool: { ...data, randomize: body?.randomize === true } }, { status: 201 });
}

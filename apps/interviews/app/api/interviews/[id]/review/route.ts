import { NextRequest, NextResponse } from "next/server";
import { isVerdict } from "@rescript/interviews";
import { supabaseAdmin } from "@/lib/admin";
import { isFailure, requireProject } from "@/lib/auth";

export const dynamic = "force-dynamic";

/**
 * A PERSON'S ASSESSMENT, KEPT APART FROM THE MACHINE'S.
 *
 * `interview_reviews` has been a table nothing writes to since 0030, and its
 * separation from `interview_analysis` is the point rather than an accident:
 * the AI's output is a signal and a person's assessment is a decision. One row
 * holding both invites a product that shows them as one thing, and then nobody
 * can tell which of them said "advance".
 *
 * A review can DISAGREE with the analysis, and the disagreement is itself
 * worth keeping — it is how somebody notices, six months later, that the model
 * has been consistently harsh about one requirement.
 *
 * ## One review per reviewer, not one per interview
 *
 * `unique (interview_id, reviewer_id)`, so two people reviewing the same
 * interview produce two reviews rather than overwriting each other. That is
 * the normal case in hiring, and a schema that flattened it would silently
 * lose the second opinion — which is usually the interesting one.
 */

const RECOMMENDATIONS = ["advance", "hold", "decline"] as const;

export async function GET(req: NextRequest, { params }: { params: { id: string } }) {
  const db = supabaseAdmin();
  const { data: interview } = await db
    .from("interviews").select("project_id").eq("id", params.id).maybeSingle();
  if (!interview) return NextResponse.json({ error: "No such interview." }, { status: 404 });

  const ctx = await requireProject(req, interview.project_id, "analysis.read");
  if (isFailure(ctx)) return ctx.response;

  const { data } = await db
    .from("interview_reviews")
    .select("id, reviewer_id, status, assessments, notes, recommendation, completed_at, updated_at")
    .eq("interview_id", params.id);

  return NextResponse.json(
    { ok: true, reviews: data ?? [], mine: (data ?? []).find((r) => r.reviewer_id === ctx.user.userId) ?? null },
    { headers: { "cache-control": "no-store" } },
  );
}

export async function PUT(req: NextRequest, { params }: { params: { id: string } }) {
  const db = supabaseAdmin();
  const { data: interview } = await db
    .from("interviews").select("id, project_id, status").eq("id", params.id).maybeSingle();
  if (!interview) return NextResponse.json({ error: "No such interview." }, { status: 404 });

  const ctx = await requireProject(req, interview.project_id, "review.write");
  if (isFailure(ctx)) return ctx.response;

  const body = await req.json().catch(() => ({}));

  /*
   * Assessments are per requirement and use the SAME three verdicts the
   * analysis uses, so a reviewer agreeing or disagreeing is directly
   * comparable. A separate human vocabulary would make the comparison a
   * translation, and a translation is where the meaning goes.
   */
  const raw = (body?.assessments ?? {}) as Record<string, unknown>;
  const assessments: Record<string, string> = {};
  for (const [requirementId, verdict] of Object.entries(raw)) {
    if (isVerdict(verdict)) assessments[requirementId] = verdict;
  }

  const recommendation = RECOMMENDATIONS.includes(body?.recommendation)
    ? (body.recommendation as string)
    : null;
  const notes = String(body?.notes ?? "").slice(0, 10_000);
  const complete = body?.status === "complete";

  if (complete && !recommendation) {
    /*
     * Finishing a review without saying what you think is the one thing this
     * route refuses. A completed review with no recommendation is a row that
     * looks decided and is not, and somebody downstream will read it as one.
     */
    return NextResponse.json(
      { error: "Choose advance, hold or decline before marking the review complete." },
      { status: 400 },
    );
  }

  const { data, error } = await db.from("interview_reviews").upsert({
    interview_id: params.id,
    project_id: interview.project_id,
    reviewer_id: ctx.user.userId,
    status: complete ? "complete" : "in_progress",
    assessments,
    notes,
    recommendation,
    completed_at: complete ? new Date().toISOString() : null,
  }, { onConflict: "interview_id,reviewer_id" })
    .select("id, status, assessments, notes, recommendation, completed_at")
    .maybeSingle();

  if (error) {
    return NextResponse.json({ error: "That review could not be saved." }, { status: 503 });
  }

  return NextResponse.json({ ok: true, review: data });
}

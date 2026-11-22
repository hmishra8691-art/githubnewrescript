import { NextRequest, NextResponse } from "next/server";
import { reviewerAgreement, type ReviewRecord } from "@rescript/quality";
import { isFailure, requireProject } from "@/lib/guard";

export const dynamic = "force-dynamic";

/**
 * THE REVIEW CONSOLE'S AGREEMENT FIGURE (F11, 2026-11-29).
 *
 * GET → { agreement, reviews } — Cohen's κ between two different reviewers' latest keep/remove on the same
 * response, from this survey's decision log (response_reviews, which names the signed-in reviewer). The queue and
 * the per-rule verdicts are computed in the panel from the rows it already loads; only this needs the log.
 */
export async function GET(req: NextRequest, { params }: { params: { id: string } }) {
  const gate = await requireProject(req, params.id, "responses.read");
  if (isFailure(gate)) return gate.response;
  const { data, error } = await gate.db.from("response_reviews")
    .select("response_id, decision, decided_by, decided_at")
    .eq("survey_id", params.id).in("decision", ["KEEP", "REMOVE"])
    .order("decided_at", { ascending: false }).limit(20_000);
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  const reviews: ReviewRecord[] = (data ?? []).map((r) => {
    const x = r as { response_id: string; decision: string; decided_by: string | null; decided_at: string };
    return { responseId: String(x.response_id), decision: x.decision, decidedBy: x.decided_by, decidedAt: x.decided_at };
  });
  return NextResponse.json({ agreement: reviewerAgreement(reviews), reviews: reviews.length, truncated: reviews.length >= 20_000 }, { headers: { "cache-control": "no-store" } });
}

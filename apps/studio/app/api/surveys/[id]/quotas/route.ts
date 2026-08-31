import { NextRequest, NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/admin";

export const dynamic = "force-dynamic";

/** Live quota counts for the dashboard. */
export async function GET(_req: NextRequest, { params }: { params: { id: string } }) {
  const db = supabaseAdmin();
  const { data } = await db
    .from("quota_counts")
    .select("quota_id, cell_id, count")
    .eq("survey_id", params.id);
  const counts: Record<string, Record<string, number>> = {};
  for (const r of data ?? []) {
    counts[r.quota_id] = counts[r.quota_id] ?? {};
    counts[r.quota_id][r.cell_id] = r.count;
  }
  return NextResponse.json({ counts });
}
